// OpenAI chat-completions <-> OpenCode envelope bridge.
//
// OpenCode 1.18.30 cannot accept client-supplied tool definitions (`tools` is
// only `{[name]: boolean}` built-in switches), cannot replay an assistant tool
// call or a tool result into a conversation, and has no `tool_choice`. So one
// turn is encoded as:
//
//   - ONE `user` text part holding the whole messages array as JSON,
//   - the tool schemas declared inside the `system` prompt,
//   - the envelope contract written in that prompt: answer
//     `{"content": string, "calls": [{name, arguments}]}`,
//   - the requested tool choice expressed in the prompt too, because the API
//     has no `tool_choice`.
//
// No `format` field is sent. OpenCode treats `format.type === "json_schema"` as
// an instruction to call ITS OWN StructuredOutput tool — a tool the isolated
// instance denies — and appends a system instruction to that effect, which
// fights the contract above. `retryCount: 0` and the tolerated
// `StructuredOutputError` meant the schema never validated anything anyway, so
// the contract is enforced here on decode instead.
//
// This module owns encoding and decoding only. The HTTP turn/session lifecycle
// lives in lib/bridge.js and the loopback server in lib/shim.js.

import { randomUUID } from "node:crypto";

/** Image mime types accepted as data URLs, with the filename extension used. */
const IMAGE_MIMES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

/** One failed bridge operation, carrying an HTTP-like status and a stable code. */
export class BridgeError extends Error {
  /**
   * @param message - human-readable cause; surfaced to the client verbatim.
   * @param status - HTTP status the shim should use.
   * @param code - stable machine code (`model_not_found`, `calls_required`, ...).
   */
  constructor(message, status = 502, code = "bridge_error") {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** First non-empty string among the candidates. */
function firstString(...values) {
  for (const value of values) if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------
// Catalog matching + capability probes
//
// The catalog entry shape is owned by lib/catalog.js; these probes read the
// documented fields first and then a few plausible aliases, defaulting to
// "capable" when nothing says otherwise so a sparse catalog does not silently
// disable a working feature.
// ---------------------------------------------------------------------------

function modelList(models) {
  if (typeof models === "function") models = models();
  if (Array.isArray(models)) return models;
  if (models && Array.isArray(models.models)) return models.models;
  return [];
}

function booleanField(source, names) {
  if (!isPlainObject(source)) return undefined;
  for (const name of names) if (typeof source[name] === "boolean") return source[name];
  return undefined;
}

function supportsTools(entry) {
  const direct = booleanField(entry, ["toolCapable", "tools", "toolCall", "toolCalls", "supportsTools", "functionCalling"]);
  if (direct !== undefined) return direct;
  const nested = booleanField(entry?.capabilities, ["tools", "toolCall", "toolCalls", "functionCalling"]);
  if (nested !== undefined) return nested;
  return true;
}

function supportsImages(entry) {
  const direct = booleanField(entry, ["inputImage", "imageInput", "supportsImages", "images", "attachments"]);
  if (direct !== undefined) return direct;
  const nested = booleanField(entry?.capabilities, ["image", "images", "vision"]);
  if (nested !== undefined) return nested;
  const modalities = entry?.modalities?.input ?? entry?.inputModalities;
  if (Array.isArray(modalities)) return modalities.includes("image");
  return true;
}

/** Find the catalog entry the request names. */
function resolveModel(models, requested) {
  if (typeof requested !== "string" || requested.trim().length === 0) {
    throw new BridgeError("`model` is required", 400, "model_required");
  }
  const wanted = requested.trim();
  const list = modelList(models);
  const exact = list.find(
    (entry) => entry && (entry.id === wanted || entry.modelID === wanted || entry.name === wanted),
  );
  if (exact) return exact;
  const composite = list.find((entry) => {
    if (!entry || typeof entry.id !== "string") return false;
    const id = entry.modelID ?? entry.id;
    const provider = entry.providerID;
    if (typeof provider === "string" && (wanted === `${provider}/${entry.id}` || wanted === `${provider}/${id}`)) {
      return true;
    }
    return wanted === `opencode-link/${entry.id}` || wanted === `opencode-link-direct/${entry.id}`;
  });
  if (composite) return composite;
  throw new BridgeError(`unknown model "${wanted}"`, 404, "model_not_found");
}

/**
 * The order OpenCode's variants escalate in.
 *
 * Used to pick the default level and to reject a level that would silently do
 * nothing; it mirrors lib/adapter.js's list because the two halves cannot share
 * a module (this one is server-only).
 */
const VARIANT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** The highest variant a model advertises, or undefined. */
function highestVariant(variants) {
  let best;
  for (const variant of variants) {
    if (!VARIANT_ORDER.includes(variant)) continue;
    if (best === undefined || VARIANT_ORDER.indexOf(variant) > VARIANT_ORDER.indexOf(best)) best = variant;
  }
  return best;
}

/**
 * Pick the reasoning variant for one turn.
 *
 * An explicit request wins and is validated against the advertised variants.
 * With no request, the model's OWN highest level is used: thinking should be on
 * and at its ceiling unless the caller turns it down, and DSH does not send an
 * effort unless its model metadata advertised one.
 *
 * A model that advertises no variants ignores the whole thing rather than
 * failing a turn.
 *
 * @param body - the raw request body.
 * @param entry - the resolved catalog entry.
 * @returns the variant to send, or undefined.
 */
function resolveVariant(body, entry) {
  const variants = isPlainObject(entry?.variants) ? Object.keys(entry.variants) : [];
  const requested = firstString(body?.variant, body?.reasoning_effort, body?.reasoning?.effort);
  if (variants.length === 0) return undefined;
  if (requested === undefined) return highestVariant(variants);
  if (variants.includes(requested)) return requested;
  throw new BridgeError(
    `unsupported reasoning effort "${requested}" for model "${entry?.id ?? "unknown"}" (expected one of: ${variants.join(", ")})`,
    400,
    "invalid_variant",
  );
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Read the `tools` array into the normalized `{name, description, parameters}` shape. */
function readTools(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BridgeError("`tools` must be an array", 400, "invalid_tools");
  const tools = [];
  const seen = new Set();
  for (const item of raw) {
    if (!isPlainObject(item)) throw new BridgeError("each tool must be an object", 400, "invalid_tools");
    const fn = isPlainObject(item.function) ? item.function : item;
    const kind = item.type ?? fn.type;
    if (kind !== undefined && kind !== "function") {
      throw new BridgeError(`unsupported tool type "${String(kind)}" (only functions are supported)`, 400, "invalid_tools");
    }
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (name.length === 0) throw new BridgeError("each tool needs a function.name", 400, "invalid_tools");
    if (seen.has(name)) throw new BridgeError(`duplicate tool name "${name}"`, 400, "invalid_tools");
    seen.add(name);
    tools.push({
      name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: isPlainObject(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
    });
  }
  return tools;
}

/** Read `tool_choice` into `{mode, name}`. */
function readToolChoice(value, tools) {
  const declared = tools.length > 0;
  if (value === undefined || value === null || value === "auto") return { mode: "auto" };
  if (value === "none") return { mode: "none" };
  if (value === "required" || value === "any") {
    if (!declared) throw new BridgeError('`tool_choice` is "required" but no tools were declared', 400, "tools_required");
    return { mode: "required" };
  }
  if (isPlainObject(value)) {
    const name = firstString(value.function?.name, value.name, value.tool?.name);
    if (name !== undefined) {
      if (!declared) throw new BridgeError("`tool_choice` names a tool but no tools were declared", 400, "tools_required");
      if (!tools.some((tool) => tool.name === name)) {
        throw new BridgeError(`\`tool_choice\` names unknown tool "${name}"`, 400, "unknown_tool_choice");
      }
      return { mode: "named", name };
    }
  }
  throw new BridgeError("unsupported `tool_choice` value", 400, "invalid_tool_choice");
}

/** Parse one OpenAI image part into `{mime, url}`; throw on anything unsupported. */
function imageOf(part) {
  if (!isPlainObject(part)) return undefined;
  if (part.type !== "image_url" && part.type !== "image" && part.type !== "input_image") return undefined;

  let url = part.image_url?.url ?? part.image_url ?? part.url ?? part.image;
  if (typeof url !== "string" || url.length === 0) {
    // pi-ai style `{type:"image", mimeType, data}`.
    const mime = firstString(part.mimeType, part.mime, part.image_url?.mime);
    const data = firstString(part.data, part.base64);
    if (mime === undefined || data === undefined) {
      throw new BridgeError("image part has no usable url", 400, "invalid_image");
    }
    url = `data:${mime};base64,${data}`;
  }

  if (!url.startsWith("data:")) {
    throw new BridgeError("only data: image URLs are supported (got a remote URL)", 400, "image_url_unsupported");
  }
  const comma = url.indexOf(",");
  if (comma < 0) throw new BridgeError("malformed image data URL", 400, "invalid_image");
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  const [mime, encoding] = meta.split(";");
  if (!IMAGE_MIMES.has(mime)) {
    throw new BridgeError(
      `unsupported image mime "${mime}" (expected image/png, image/jpeg, image/webp or image/gif)`,
      400,
      "image_mime_unsupported",
    );
  }
  if (encoding !== "base64") throw new BridgeError("image data URL must be base64-encoded", 400, "image_mime_unsupported");
  if (payload.length === 0 || !/^[A-Za-z0-9+/=\r\n]+$/.test(payload)) {
    throw new BridgeError("image data URL has an invalid base64 payload", 400, "invalid_image");
  }
  return { mime, url };
}

/**
 * Replace every image content part with an inline text marker and collect the
 * OpenCode `file` parts. The marker keeps the image's position in the serialized
 * history; the base64 never enters the prompt.
 */
function extractImages(messages, imageCapable) {
  const files = [];
  let index = 0;
  const rewritten = messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const content = message.content.map((part) => {
      const image = imageOf(part);
      if (image === undefined) return part;
      if (!imageCapable) {
        throw new BridgeError(
          "this model does not accept image input; remove the attached image",
          400,
          "image_unsupported",
        );
      }
      index += 1;
      const filename = `image-${index}.${IMAGE_MIMES.get(image.mime)}`;
      files.push({ type: "file", mime: image.mime, url: image.url, filename });
      return { type: "image", note: `[Attached image: ${filename}]` };
    });
    return { ...message, content };
  });
  return { messages: rewritten, files };
}

/** Flatten a system/developer content value to plain text. */
function flattenText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (isPlainObject(part) && typeof part.text === "string") return part.text;
        if (isPlainObject(part) && typeof part.note === "string") return part.note;
        return "";
      })
      .join("\n");
  }
  return "";
}

/** The system-prompt section that declares the tools and the envelope contract. */
function bridgeInstructions({ tools, choice, parallel, attachments, chatOnly }) {
  const lines = [];
  lines.push(
    "You are answering a request relayed by the DeepSeek Harness bridge. The user message is the entire conversation so far, serialized as a JSON array with roles \"user\", \"assistant\" and \"tool\". Continue that conversation.",
  );
  if (chatOnly) {
    lines.push("Reply with the next assistant message as plain markdown text. Do not wrap the answer in JSON.");
    if (attachments > 0) lines.push("Attached images appear as file parts; their positions are marked inline.");
    return lines.join("\n");
  }
  lines.push(
    'Reply with EXACTLY ONE JSON object and nothing else: no markdown code fences, no prose before or after. Shape: {"content": string, "calls": [{"name": string, "arguments": object}]}',
  );
  lines.push('- "content" (required, string) is the answer shown to the user, as markdown.');
  lines.push('- "calls" (required, array) lists tool calls for the harness to execute; use [] when no tool is needed.');
  lines.push(
    "- Never execute a tool yourself and never invent tool output: the harness runs the call, appends the result as a \"tool\" message, and asks you again.",
    "- OpenCode native tools (including read) are NOT the harness tools. Do not invoke them. Request harness tools ONLY through the calls array, using the exact names and argument schemas declared below; do not substitute native argument names.",
    "- The harness conversation supplies the user's working directory and tool results. OpenCode's own working directory and native tool permissions do not describe the harness workspace.",
  );
  if (tools.length > 0) {
    lines.push("Tools available (name, description, JSON Schema for arguments):");
    lines.push(
      JSON.stringify(
        tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      ),
    );
  } else {
    lines.push('No tools are available: always return "calls": [].');
  }
  if (choice.mode === "none") lines.push('Tool use is disabled for this turn: "calls" MUST be [].');
  else if (choice.mode === "required") lines.push('You MUST call at least one tool: "calls" must not be empty.');
  else if (choice.mode === "named") lines.push(`You MUST call the tool "${choice.name}" and no other tool.`);
  if (!parallel) lines.push("Call at most ONE tool in this reply.");
  if (attachments > 0) {
    lines.push("Attached images appear as file parts; their positions are marked inline as [Attached image: <name>].");
  }
  return lines.join("\n");
}

/**
 * Encode one OpenAI chat-completions request for OpenCode.
 *
 * No `format` is sent. OpenCode reacts to `format.type === "json_schema"` by
 * appending its own system instruction — "IMPORTANT: The user has requested
 * structured output. You MUST use the StructuredOutput tool … Do NOT respond
 * with plain text" — and by registering a `StructuredOutput` tool. That tool is
 * unreachable here (the isolated instance denies StructuredOutput), and
 * `retryCount: 0` plus the ignored `StructuredOutputError` mean the schema never
 * validated anything anyway. The instruction only contradicted this module's
 * own envelope contract, which the decoder enforces. Conflicting instructions
 * can produce reasoning without a usable answer; that alone does not establish
 * that the model exhausted its output budget.
 *
 * @param body - the raw parsed `/v1/chat/completions` body.
 * @param models - catalog entries (or a function returning them).
 * @returns `{ model, variant, system, parts, meta, chatOnly }`, where `meta` is
 *   opaque to callers and must be handed back to `decodeEnvelope`.
 * @throws BridgeError when the request cannot be represented.
 */
export function prepareOpenAiRequest(body, models) {
  if (!isPlainObject(body)) throw new BridgeError("request body must be a JSON object", 400, "invalid_request");

  const model = resolveModel(models, body.model);
  const variant = resolveVariant(body, model);
  const toolCapable = supportsTools(model);
  const imageCapable = supportsImages(model);

  const declaredTools = readTools(body.tools);
  if (declaredTools.length > 0 && !toolCapable) {
    throw new BridgeError(
      `model "${model.id}" has no tool support, so ${declaredTools.length} tool definition(s) cannot be offered`,
      400,
      "tools_unsupported",
    );
  }
  const choice = readToolChoice(body.tool_choice, declaredTools);
  const parallel = body.parallel_tool_calls !== false;

  const rawMessages = body.messages;
  if (!Array.isArray(rawMessages)) throw new BridgeError("`messages` must be an array", 400, "invalid_messages");
  const messages = rawMessages.filter(isPlainObject);
  if (messages.length === 0) throw new BridgeError("`messages` must contain at least one message", 400, "messages_required");

  const extracted = extractImages(messages, imageCapable);
  const history = extracted.messages.filter(
    (message) => message.role !== "system" && message.role !== "developer",
  );
  if (history.length === 0) {
    throw new BridgeError("`messages` contains no user or assistant turn", 400, "messages_required");
  }

  const userSystem = extracted.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => flattenText(message.content))
    .filter((text) => text.trim().length > 0)
    .join("\n\n");

  // The whole conversation is one JSON document inside ONE user text part.
  // Tool calls and tool results ride along as conversation data: OpenCode has
  // no API to replay them as protocol messages.
  const historyText = JSON.stringify(history);
  const parts = [{ type: "text", text: historyText }, ...extracted.files];

  const chatOnly = declaredTools.length === 0 || !toolCapable;
  const instructions = bridgeInstructions({
    tools: declaredTools,
    choice,
    parallel,
    attachments: extracted.files.length,
    chatOnly,
  });
  const system = [userSystem, instructions].filter((section) => section.length > 0).join("\n\n");

  return {
    model,
    variant,
    system,
    parts,
    chatOnly,
    meta: {
      chatOnly,
      modelId: model.id,
      // `undefined` means "do not validate names"; `[]` means "nothing allowed".
      tools: declaredTools.map((tool) => tool.name),
      toolChoice: choice.mode,
      choiceName: choice.name,
      parallelToolCalls: parallel,
      maxCalls: !parallel ? 1 : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** Read only the root content string from a partial envelope; never expose tool arguments. */
export function partialEnvelopeContent(raw) {
  const text = raw.replace(/^\s*```(?:json)?[ \t]*\r?\n?/i, '');
  let depth = 0, key = '', expectingKey = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' || ch === '[') { depth++; if (depth === 1 && ch === '{') expectingKey = true; continue; }
    if (ch === '}' || ch === ']') { depth--; continue; }
    if (depth === 1 && ch === ',') { expectingKey = true; key = ''; continue; }
    if (ch !== '"') continue;
    const start = i; let closed = false;
    for (i++; i < text.length; i++) {
      if (text[i] === '\\') { i++; continue; }
      if (text[i] === '"') { closed = true; break; }
    }
    if (depth === 1 && !expectingKey && key === 'content') {
      let value = text.slice(start, closed ? i + 1 : text.length);
      if (!closed) {
        // Remove only an unfinished escape at the tail before parsing the safe prefix.
        const tail = value.match(/(\\+)u[0-9a-f]{0,3}$/i);
        if (tail && tail[1].length % 2 === 1) value = value.slice(0, value.length - tail[0].length) + tail[1].slice(0, -1);
        const slashes = value.match(/\\+$/)?.[0].length || 0;
        if (slashes % 2) value = value.slice(0, -1);
        value += '"';
      }
      try { const decoded = JSON.parse(value); return decoded.replace(/[\uD800-\uDBFF]$/, ''); } catch { return ''; }
    }
    if (!closed) return '';
    if (depth === 1 && expectingKey) { try { key = JSON.parse(text.slice(start, i + 1)); } catch { return ''; } expectingKey = false; }
  }
  return '';
}

/** Retry the same turn with a format correction, preserving every capability. */
export function repairEnvelopeRequest(prepared) {
  return {
    ...prepared,
    system: `${prepared.system}\n\n` +
      "FORMAT CORRECTION: the previous attempt did not produce a usable bridge envelope. " +
      "All tools and tool-choice requirements above STILL APPLY. Continue the original conversation. " +
      'Return exactly one JSON object {"content": string, "calls": [{"name": string, "arguments": object}]}. ' +
      "Put user-facing prose in content and harness tool requests in calls. " +
      "Do not execute OpenCode native tools or claim that an action has already been performed. " +
      "Do not output prose outside the object or replace a needed tool request with instructions for the user.",
  };
}

/** Remove one markdown fence if the model disobeyed the "no fences" rule. */
function stripFence(text) {
  const match = /^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(text);
  return match ? match[1].trim() : text;
}

/** Tolerant content normalization: absent becomes "". */
function normalizeContent(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (isPlainObject(part) && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return String(value);
}

/** Normalize the envelope's `calls` value into `[{name, arguments}]`. */
function normalizeCalls(raw) {
  let value = raw;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return [];
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new BridgeError('"calls" was a string but not valid JSON', 502, "invalid_json");
    }
    if (isPlainObject(value) && Array.isArray(value.calls)) value = value.calls;
  }
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BridgeError('"calls" must be an array', 502, "invalid_envelope");

  return value.map((call, index) => {
    if (!isPlainObject(call)) throw new BridgeError(`tool call ${index} is not an object`, 502, "invalid_envelope");
    const fn = isPlainObject(call.function) ? call.function : call;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (name.length === 0) throw new BridgeError(`tool call ${index} has no name`, 502, "invalid_envelope");

    let args = fn.arguments;
    if (args === undefined || args === null) {
      args = {};
    } else if (typeof args === "string") {
      const trimmed = args.trim();
      if (trimmed.length === 0) {
        args = {};
      } else {
        try {
          args = JSON.parse(trimmed);
        } catch {
          throw new BridgeError(`arguments for tool "${name}" are not valid JSON`, 502, "invalid_arguments");
        }
      }
    }
    if (!isPlainObject(args)) {
      throw new BridgeError(`arguments for tool "${name}" must be a JSON object`, 502, "invalid_arguments");
    }
    return { name, arguments: args };
  });
}

/** Generate the OpenAI tool-call id: `call_<uuid>` with the dashes stripped. */
function toolCallId() {
  return `call_${randomUUID().replace(/-/g, "")}`;
}

/** Apply the strict post-decode checks and build the assistant message. */
function finalizeEnvelope(content, calls, meta) {
  // A wholly empty answer is recoverable even when a tool was required.
  if (content.trim().length === 0 && calls.length === 0) throw degenerateCompletion();
  const choice = meta?.toolChoice ?? "auto";

  if (choice === "none" && calls.length > 0) {
    throw new BridgeError('the model called a tool although tool_choice was "none"', 502, "calls_not_allowed");
  }

  const allowed =
    choice === "none"
      ? []
      : choice === "named"
        ? typeof meta?.choiceName === "string"
          ? [meta.choiceName]
          : []
        : Array.isArray(meta?.tools)
          ? meta.tools
          : undefined;
  if (Array.isArray(allowed)) {
    for (const call of calls) {
      if (!allowed.includes(call.name)) {
        throw new BridgeError(`the model called unknown tool "${call.name}"`, 502, "unknown_tool");
      }
    }
  }

  if ((choice === "required" || choice === "named") && calls.length === 0) {
    throw new BridgeError("the model was required to call a tool but called none", 502, "calls_required");
  }

  const maxCalls =
    typeof meta?.maxCalls === "number"
      ? meta.maxCalls
      : meta?.parallelToolCalls === false
        ? 1
        : Number.POSITIVE_INFINITY;
  if (calls.length > maxCalls) {
    throw new BridgeError(
      `the model returned ${calls.length} tool calls but at most ${maxCalls} allowed`,
      502,
      "too_many_calls",
    );
  }

  const message = { role: "assistant", content };
  if (calls.length > 0) {
    message.tool_calls = calls.map((call) => ({
      id: toolCallId(),
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  }
  return message;
}

/**
 * One degenerate completion: the turn finished carrying neither text nor a tool
 * call. It must not be reported as a normal `stop` — the harness would end the
 * step with nothing to show and nothing to act on. Tool requests consume this
 * code in the bridge's one-shot repair; chat-only requests leave it to DSH's
 * existing empty-response policy.
 */
function degenerateCompletion() {
  return new BridgeError("the model returned a completed response with no content", 502, "EMPTY_RESPONSE");
}

/** Report shape only: model output can contain private conversation data. */
function noEnvelope() {
  return new BridgeError(
    "the model returned text that could not be decoded as a bridge envelope",
    502,
    "ENVELOPE_FORMAT_INVALID",
  );
}

/**
 * Decode the model's answer into an OpenAI assistant message.
 *
 * Tolerant first (missing fields, `tool_calls` alias, `calls` as a JSON string,
 * fenced or prose-decorated JSON), then strict against the contract encoded in
 * `meta`.
 *
 * Empty/undecodable answers are distinct from valid JSON that violates the
 * tool contract. Only the former qualify for the bridge's format repair.
 *
 * @param text - the envelope string (`info.structured` stringified, or the
 *   concatenated text parts).
 * @param meta - the opaque object returned by `prepareOpenAiRequest`.
 * @param options - `{ finish }`; the upstream turn's stop reason (`"length"`
 *   becomes `output_truncated`, which no amount of decoding can recover).
 * @returns `{ role: "assistant", content, tool_calls? }`.
 * @throws BridgeError with a stable emptiness, format, or contract error code.
 */
export function decodeEnvelope(text, meta = {}, options = {}) {
  const finish = options?.finish ?? meta?.finish;
  if (finish === "length") {
    throw new BridgeError("the model stopped because it hit its output limit", 502, "output_truncated");
  }

  if (meta?.chatOnly) {
    const content = typeof text === "string" ? text : String(text ?? "");
    // A chat-only turn has no envelope to validate, so the empty-response check
    // is the only thing standing between "the model produced nothing" and a
    // completed turn with a blank answer.
    if (content.trim().length === 0) throw degenerateCompletion();
    return { role: "assistant", content };
  }

  let cleaned = typeof text === "string" ? text.trim() : "";
  if (cleaned.length === 0) return finalizeEnvelope("", [], meta);

  let parsed;
  const attempt = (candidate) => {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      return { ok: false };
    }
  };
  cleaned = stripFence(cleaned);
  let result = attempt(cleaned);
  if (!result.ok) {
    // A model that wrapped the object in prose: try the outermost braces.
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) result = attempt(cleaned.slice(start, end + 1));
  }
  if (!result.ok) throw noEnvelope();
  parsed = result.value;

  if (Array.isArray(parsed)) parsed = { content: "", calls: parsed };
  if (typeof parsed === "string") parsed = { content: parsed };
  if (!isPlainObject(parsed)) throw noEnvelope();
  if (parsed.finish === "length") {
    throw new BridgeError("the model stopped because it hit its output limit", 502, "output_truncated");
  }

  const content = normalizeContent(parsed.content);
  const rawCalls =
    parsed.calls !== undefined ? parsed.calls : parsed.tool_calls !== undefined ? parsed.tool_calls : parsed.toolCalls;
  const calls = normalizeCalls(rawCalls);
  return finalizeEnvelope(content, calls, meta);
}

// ---------------------------------------------------------------------------
// OpenAI response objects
// ---------------------------------------------------------------------------

/**
 * Token accounting.
 *
 * OpenCode reports `{ input, output, reasoning, cache: { read, write } }`; the
 * OpenAI shape folds cache reads/writes into `prompt_tokens` and reasoning into
 * `completion_tokens`.
 */
function usageOf(tokens) {
  const input = numberOrZero(tokens?.input);
  const output = numberOrZero(tokens?.output);
  const reasoning = numberOrZero(tokens?.reasoning);
  const cached = numberOrZero(tokens?.cache?.read) + numberOrZero(tokens?.cache?.write);
  const prompt = input + cached;
  const completionTokens = output + reasoning;
  return {
    prompt_tokens: prompt,
    completion_tokens: completionTokens,
    total_tokens: prompt + completionTokens,
    prompt_tokens_details: { cached_tokens: numberOrZero(tokens?.cache?.read) },
    completion_tokens_details: { reasoning_tokens: reasoning },
  };
}

function newCompletionId() {
  return `chatcmpl-${randomUUID().replace(/-/g, "")}`;
}

/**
 * Build one OpenAI `chat.completion` object.
 *
 * @param modelId - the model id the client asked for.
 * @param message - the decoded assistant message (an explicit `finish_reason`
 *   field, if present, is honored and removed from the message).
 * @param tokens - OpenCode `info.tokens`.
 */
export function completion(modelId, message, tokens = {}) {
  const source = isPlainObject(message) ? message : { role: "assistant", content: String(message ?? "") };
  const { finish_reason: explicitFinish, ...rest } = source;
  const normalized = {
    role: "assistant",
    content: normalizeContent(rest.content),
  };
  if (Array.isArray(rest.tool_calls) && rest.tool_calls.length > 0) normalized.tool_calls = rest.tool_calls;
  return {
    id: newCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: normalized,
        finish_reason:
          explicitFinish ?? (normalized.tool_calls !== undefined ? "tool_calls" : "stop"),
        logprobs: null,
      },
    ],
    usage: usageOf(tokens),
  };
}

/** Adapt an array/iterable/async-iterable to an async iterator. */
function toAsyncIterator(value) {
  if (value && typeof value[Symbol.asyncIterator] === "function") return value[Symbol.asyncIterator]();
  if (value && typeof value[Symbol.iterator] === "function") {
    const iterator = value[Symbol.iterator]();
    // `for await` needs a SYNC iterator it can await, so this must be
    // async-iterable rather than an object whose `next` happens to return a
    // promise.
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => Promise.resolve(iterator.next()),
      throw: (error) => Promise.resolve(iterator.throw?.(error)),
      return: () => Promise.resolve(iterator.return?.()),
    };
  }
  throw new BridgeError("expected an iterable of stream steps", 502, "invalid_stream");
}

/**
 * Convert turn steps into OpenAI `chat.completion.chunk` objects.
 *
 * Streaming cannot reveal tool calls until the turn completes, so the final
 * tool_calls delta is emitted last. The caller appends `[DONE]`.
 *
 * @param modelId - the model id the client asked for.
 * @param deltas - iterable of `{ type: "text" | "reasoning", text }` steps.
 * @param final - `{ message, tokens }` for the completed turn.
 * @param options - `{ id, created, includeUsage }`.
 */
export async function* streamChunks(modelId, deltas, final, options = {}) {
  const id = options.id ?? newCompletionId();
  const created = options.created ?? Math.floor(Date.now() / 1000);
  const frame = (delta, finishReason = null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  yield frame({ role: "assistant", content: "" });

  for await (const step of toAsyncIterator(deltas)) {
    if (!step) continue;
    if (step.type === "reasoning") {
      if (typeof step.text === "string" && step.text.length > 0) yield frame({ reasoning_content: step.text });
    } else if (typeof step.text === "string" && step.text.length > 0) {
      yield frame({ content: step.text });
    }
  }

  const message = final?.message ?? {};
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (calls.length > 0) {
    yield frame({ tool_calls: calls.map((call, index) => ({ index, ...call })) });
  }
  yield frame({}, calls.length > 0 ? "tool_calls" : "stop");

  if (options.includeUsage === true) {
    yield {
      id,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [],
      usage: usageOf(final?.tokens ?? {}),
    };
  }
}
