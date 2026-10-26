// Orchestration between one OpenAI chat-completions turn and one OpenCode turn.
//
// This layer owns exactly three concerns the protocol module cannot:
//   1. the OpenCode session lifecycle for one turn,
//   2. reading the server event bus while the blocking POST runs,
//   3. folding those two streams into the deltas the protocol layer encodes.
//
// Translation itself — request shaping, envelope decoding, response/SSE framing
// — belongs to lib/protocol.js and is not duplicated here.
//
// OpenCode cannot run a turn the way an LLM API does: its message endpoint is
// blocking and it executes tools itself, so one DSH turn costs one OpenCode
// session. DSH sends the WHOLE history on every request, so the session is
// created per turn and deleted afterwards; reusing one would append each turn
// onto the previous and grow without bound.

import {
  prepareOpenAiRequest,
  BridgeError,
  decodeEnvelope,
  completion,
  streamChunks,
  partialEnvelopeContent,
} from "./protocol.js";

const SESSION_TITLE = "dsh-connect-router";

/** Counts only; never put a prompt, model answer, or credential in diagnostics. */
function turnSummary(attempt, response, error) {
  const parts = response?.parts ?? [];
  const kinds = {};
  for (const part of parts) {
    const type = ["text", "reasoning", "tool", "file", "step-start", "step-finish"].includes(part.type) ? part.type : "other";
    kinds[type] = (kinds[type] ?? 0) + 1;
  }
  const finish = response?.info?.finish;
  const structured = response?.info?.structured;
  return JSON.stringify({
    attempt,
    finish: ["stop", "length", "tool-calls", "error", "unknown"].includes(finish) ? finish : "unknown",
    parts: kinds,
    structured: structured == null ? "absent" : Array.isArray(structured) ? "array" : typeof structured,
    textLength: envelopeTextOf(response?.info, parts).length,
    code: error?.name === "AbortError" ? "ABORTED" : error?.code ?? (error ? "upstream_failure" : "ok"),
  });
}

/** Fold the single completed request's usage. */
function addTokens(total, tokens = {}) {
  const numeric = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
  for (const key of ["input", "output", "reasoning"]) total[key] += numeric(tokens[key]);
  for (const key of ["read", "write"]) total.cache[key] += numeric(tokens.cache?.[key]);
}

/** Fold an OpenCode message failure into an Error DSH can surface verbatim. */
function messageFailure(info) {
  const failure = info?.error;
  if (!failure) return undefined;
  const data = failure.data ?? {};
  const status = typeof data.statusCode === "number" ? data.statusCode : 502;
  const error = new Error(data.message ?? failure.name ?? "model request failed");
  error.status = status;
  error.code =
    status === 429
      ? "RATE_LIMIT"
      : status === 403
        ? "FORBIDDEN"
        : status === 401
          ? "INVALID_CREDENTIAL"
          : "MODEL_ERROR";
  return error;
}

/** The exact OpenCode payload for one prepared request. */
function payloadOf(prepared) {
  return {
    model: { providerID: prepared.model.providerID, modelID: prepared.model.id },
    ...(prepared.variant === undefined ? {} : { variant: prepared.variant }),
    ...(prepared.system === undefined ? {} : { system: prepared.system }),
    parts: prepared.parts,
  };
}

/**
 * Text of a completed turn, before envelope decoding.
 *
 * Exported for the unit test that pins the `structured: null` case: OpenCode
 * reports that shape — not an object — when a turn completes without a
 * structured answer, so mistaking it for one would hand the decoder the text
 * "null" instead of the envelope.
 *
 * @param info - the completed turn's `info` object.
 * @param parts - the completed turn's parts.
 * @returns the envelope text to decode.
 */
export function envelopeTextOf(info, parts) {
  // `structured` is `null` — not absent — whenever the turn produced no
  // structured value. Stringifying that null would hand the decoder the text
  // "null", so only a real object counts as the answer.
  if (info?.structured !== undefined && info?.structured !== null) return JSON.stringify(info.structured);
  return (parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Drive one turn and yield its deltas, then the completed message.
 *
 * The delta event carries `field: "text"` for BOTH text and reasoning parts, so
 * the part type must be tracked from `message.part.updated` before a delta can
 * be attributed. Getting that wrong splices reasoning into the visible answer —
 * this is the one piece of OpenCode's wire format that is a correctness trap
 * rather than a shape.
 *
 * Yields `{ type: "text" | "reasoning", text }` while streaming, then one
 * `{ type: "end", info, parts }`.
 */
async function* runTurn({ backend, sessionId, prepared, signal, log }) {
  const partTypes = new Map();
  const queue = [];
  let ended = false;
  let wake;

  const requestAbort = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, requestAbort.signal]) : requestAbort.signal;
  const eventsAbort = new AbortController();
  const eventSignal = AbortSignal.any([requestSignal, eventsAbort.signal]);
  let eventError;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const events = (async () => {
    try {
      for await (const event of backend.events(eventSignal, readyResolve)) {
        if ((event?.properties?.sessionID ?? event?.properties?.part?.sessionID) !== sessionId) continue;
        queue.push(event);
        wake?.();
      }
    } catch (error) {
      if (!eventSignal.aborted) eventError = error;
      readyReject(error);
    } finally {
      eventError ??= new BridgeError("OpenCode event connection ended", 502, "EVENT_STREAM_ENDED");
      readyReject(eventError);
      ended = true;
      wake?.();
    }
  })();

  let completed;
  let sendError;
  let sending;
  try {
    // Subscribe before sending so immediate provider refusals/retries are observed.
    await ready;
    requestSignal.throwIfAborted();
    if (eventError) throw eventError;
    sending = backend
    .sendMessage(sessionId, payloadOf(prepared), requestSignal)
    .then(
      (value) => {
        completed = value;
      },
      (error) => {
        sendError = error;
      },
    )
    .finally(() => {
      ended = true;
      wake?.();
    });

    let idle = false;
    while (!idle) {
      requestSignal.throwIfAborted();
      while (queue.length > 0) {
        const event = queue.shift();
        const properties = event?.properties ?? {};
        if (event?.type === "message.part.updated") {
          const part = properties.part;
          if (part?.id) partTypes.set(part.id, part.type);
          continue;
        }
        if (event?.type === "message.part.delta") {
          if (properties.field !== "text" || typeof properties.delta !== "string") continue;
          const kind = partTypes.get(properties.partID);
          if (kind === "reasoning") yield { type: "reasoning", text: properties.delta };
          else if (kind === "text") yield { type: "text", text: properties.delta };
          continue;
        }
        if (event?.type === "session.error" && properties.error) {
          const failure = messageFailure({ error: properties.error });
          if (failure) throw failure;
        }
        if (event?.type === "session.status" && properties.status?.type === "retry") {
          // Router stops the upstream wait instead of concealing a provider retry.
          throw new BridgeError("OpenCode upstream requested a retry; request stopped", 429, "UPSTREAM_RETRY_STOPPED");
        }
        if (event?.type === "session.idle") {
          idle = true;
          break;
        }
      }
      // Either the event source or the blocking POST can end first.
      // Deltas can still be queued behind that: events whose
      // `session.idle` was consumed by this same drain, or a server that
      // answers before the bus has caught up. Draining first is what makes the
      // loop lossless — breaking on `ended` alone dropped every event still in
      // the queue.
      if (queue.length > 0) continue;
      if (eventError && !completed) throw eventError;
      if (idle || ended) break;
      // Woken by the next event; the timer only stops a silent server from
      // hanging a turn forever.
      await new Promise((resolve) => {
        wake = resolve;
        setTimeout(resolve, 250).unref?.();
      });
    }

    await sending;
    if (sendError) throw sendError;
    const failure = messageFailure(completed?.info);
    if (failure) throw failure;
    yield { type: "end", info: completed?.info, parts: completed?.parts };
  } finally {
    // Never leave a session behind: an abandoned one keeps its history on disk.
    requestAbort.abort();
    eventsAbort.abort();
    events.catch(() => {});
    await backend.abortSession(sessionId).catch(() => {});
    await backend.deleteSession(sessionId).catch((error) => log?.("session cleanup failed", error));
  }
}

/** Exactly one provider request and one final assistant response. */
export function createBridge({ backend, catalog, log = () => {} }) {
  async function withSession(signal, run) {
    signal?.throwIfAborted();
    const session = await backend.createSession(SESSION_TITLE, signal);
    try {
      signal?.throwIfAborted();
      return await run(session.id);
    } finally {
      await backend.abortSession(session.id).catch(() => {});
      await backend.deleteSession(session.id).catch(() => {});
    }
  }

  async function* attempts(prepared, signal, streaming, final) {
    const request = prepared;
    for (let attempt = 1; attempt <= 1; attempt += 1) {
      signal?.throwIfAborted();
      let response;
      let failure;
      let streamedText = "";
      let envelopeBuffer = "";
      try {
        if (streaming) {
          const session = await backend.createSession(SESSION_TITLE, signal);
          for await (const step of runTurn({ backend, sessionId: session.id, prepared: request, signal, log })) {
            signal?.throwIfAborted();
            if (step.type === "end") response = step;
            else if (step.type === "reasoning") yield step;
            else if (request.chatOnly) { streamedText += step.text; yield step; }
            else {
              envelopeBuffer += step.text;
              if (envelopeBuffer.length > 4 * 1024 * 1024) throw new BridgeError('Envelope too large', 502, 'ENVELOPE_LIMIT');
              const content = partialEnvelopeContent(envelopeBuffer);
              if (content.startsWith(streamedText) && content.length > streamedText.length) {
                yield { type: 'text', text: content.slice(streamedText.length) }; streamedText = content;
              }
            }
          }
        } else {
          response = await withSession(signal, (id) => backend.sendMessage(id, payloadOf(request), signal));
        }
        signal?.throwIfAborted();
        const upstreamFailure = messageFailure(response?.info);
        if (upstreamFailure) throw upstreamFailure;
        const finish = response?.info?.finish;
        if (!['stop','tool-calls'].includes(finish)) {
          // Preserve plain text already streamed; never decode/release incomplete tools.
          throw new BridgeError('OpenCode did not confirm a complete response', 502, finish === 'length' ? 'OUTPUT_TRUNCATED' : 'MISSING_COMPLETION_EVIDENCE');
        }
        addTokens(final.tokens, response?.info?.tokens);
        const message = decodeEnvelope(envelopeTextOf(response?.info, response?.parts), request.meta, { finish: response?.info?.finish });
        final.message = message;
        // No envelope bytes were emitted. A plain-text stream may need the
        // final suffix if the event bus ended before delivering the last delta.
        if (!message.content.startsWith(streamedText)) throw new BridgeError('Content changed during streaming', 502, 'CONTENT_MISMATCH');
        const text = message.content.slice(streamedText.length);
        if (streaming && text.length > 0) yield { type: "text", text };
        return;
      } catch (error) {
        failure = error;
        signal?.throwIfAborted();
        throw error; // Router: no hidden second provider request.
      } finally {
        log?.("bridge turn " + turnSummary(attempt, response, failure));
      }
    }
  }

  const resultState = () => ({ tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
  return {
    async complete(body, signal) {
      const prepared = prepareOpenAiRequest(body, catalog.current());
      const final = resultState();
      for await (const _step of attempts(prepared, signal, false, final)) { /* non-streaming */ }
      const result = completion(prepared.model.id, final.message, final.tokens);
      result.model = body.model ?? prepared.model.id;
      return result;
    },

    async *stream(body, signal) {
      const prepared = prepareOpenAiRequest(body, catalog.current());
      const final = resultState();
      // A single request: no hidden repair or continuation.
      yield* streamChunks(body.model ?? prepared.model.id, attempts(prepared, signal, true, final), final, {
        includeUsage: body.stream_options?.include_usage === true,
      });
    },
  };
}
