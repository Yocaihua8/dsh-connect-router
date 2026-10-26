import type { StreamFinish } from "../shared/types.js";

export type WireEvent =
  | { type: "text" | "reasoning"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | { type: "usage"; input?: number; output?: number }
  | { type: "finish"; result: StreamFinish };
export interface ToolContract {
  name: string;
  validate: (value: unknown) => boolean;
}
const MAX_FRAME = 1024 * 1024;

/** SSE framing keeps decoder state across byte splits, CRLF splits and EOF tails. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let carry = "",
    data: string[] = [],
    frameSize = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const result = await reader.read();
      signal.throwIfAborted();
      carry += result.done
        ? decoder.decode()
        : decoder.decode(result.value, { stream: true });
      if (carry.length > MAX_FRAME) throw new Error("FRAME_TOO_LARGE");
      while (true) {
        const end = carry.search(/[\r\n]/u);
        if (
          end < 0 ||
          (!result.done && carry[end] === "\r" && end === carry.length - 1)
        )
          break;
        const line = carry.slice(0, end);
        carry = carry.slice(
          end + (carry[end] === "\r" && carry[end + 1] === "\n" ? 2 : 1),
        );
        if (line === "") {
          if (data.length) yield data.join("\n");
          data = [];
          frameSize = 0;
        } else if (line.startsWith("data:")) {
          const value = line.slice(5).replace(/^ /u, "");
          frameSize += value.length;
          if (frameSize > MAX_FRAME) throw new Error("FRAME_TOO_LARGE");
          data.push(value);
        }
      }
      if (result.done) {
        if (carry.startsWith("data:"))
          data.push(carry.slice(5).replace(/^ /u, ""));
        if (data.length) yield data.join("\n");
        return;
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
const object = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const numeric = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

/** One upstream attempt; no synthetic success, retries, tool execution or hidden continuation. */
export async function* parseChatStream(
  body: ReadableStream<Uint8Array>,
  contracts: readonly ToolContract[],
  signal: AbortSignal,
): AsyncGenerator<WireEvent> {
  const tools = new Map<number, { id: string; name: string; args: string }>();
  let reason: string | undefined,
    done = false;
  try {
    for await (const frame of readSse(body, signal)) {
      if (frame.trim() === "[DONE]") {
        done = true;
        break;
      }
      const packet: unknown = JSON.parse(frame);
      if (!object(packet)) throw new Error("INVALID_PACKET");
      if (packet.error) {
        yield {
          type: "finish",
          result: { state: "refused", tools: 0, code: "UPSTREAM_REJECTED" },
        };
        return;
      }
      if (object(packet.usage))
        yield {
          type: "usage",
          input: numeric(packet.usage.prompt_tokens),
          output: numeric(packet.usage.completion_tokens),
        };
      if (!Array.isArray(packet.choices)) continue;
      if (packet.choices.length > 1)
        throw new Error("MULTIPLE_CHOICES_UNSUPPORTED");
      const choice = packet.choices[0];
      if (!object(choice)) continue;
      const delta = object(choice.delta) ? choice.delta : {};
      if (
        (delta.content !== undefined &&
          delta.content !== null &&
          typeof delta.content !== "string") ||
        delta.audio !== undefined ||
        delta.images !== undefined
      )
        throw new Error("INVALID_UNSUPPORTED_NATIVE_OUTPUT");
      if (
        reason &&
        (delta.content || delta.reasoning_content || delta.tool_calls)
      )
        throw new Error("DELTA_AFTER_FINISH");
      if (typeof delta.content === "string" && delta.content)
        yield { type: "text", text: delta.content };
      if (
        typeof delta.reasoning_content === "string" &&
        delta.reasoning_content
      )
        yield { type: "reasoning", text: delta.reasoning_content };
      if (Array.isArray(delta.tool_calls))
        for (const call of delta.tool_calls) {
          if (
            !object(call) ||
            !Number.isSafeInteger(call.index) ||
            call.index < 0 ||
            call.index > 128
          )
            throw new Error("INVALID_TOOL_INDEX");
          const acc = tools.get(call.index) ?? { id: "", name: "", args: "" };
          if (call.id !== undefined) {
            if (typeof call.id !== "string" || (acc.id && acc.id !== call.id))
              throw new Error("INVALID_TOOL_ID");
            acc.id = call.id;
          }
          if (object(call.function)) {
            if (typeof call.function.name === "string")
              acc.name += call.function.name;
            if (typeof call.function.arguments === "string")
              acc.args += call.function.arguments;
          }
          if (
            acc.args.length > MAX_FRAME ||
            acc.name.length > 256 ||
            acc.id.length > 256
          )
            throw new Error("TOOL_TOO_LARGE");
          tools.set(call.index, acc);
        }
      if (choice.finish_reason != null) {
        if (
          typeof choice.finish_reason !== "string" ||
          (reason && reason !== choice.finish_reason)
        )
          throw new Error("INVALID_FINISH");
        reason = choice.finish_reason;
      }
    }
    signal.throwIfAborted();
    if (reason === "length") {
      yield { type: "finish", result: { state: "length", tools: 0 } };
      return;
    }
    if (reason === "content_filter") {
      yield { type: "finish", result: { state: "refused", tools: 0 } };
      return;
    }
    if (!done || !reason) {
      yield {
        type: "finish",
        result: {
          state: "disconnected",
          tools: 0,
          code: "MISSING_COMPLETION_EVIDENCE",
        },
      };
      return;
    }
    if (
      !["stop", "tool_calls"].includes(reason) ||
      tools.size > 0 !== (reason === "tool_calls")
    )
      throw new Error("INVALID_FINISH");
    const ready: Extract<WireEvent, { type: "tool" }>[] = [],
      ids = new Set<string>();
    // Validate the entire batch before releasing any tool call to the host.
    for (const t of tools.values()) {
      const contract = contracts.find((c) => c.name === t.name);
      const args: unknown = JSON.parse(t.args);
      if (
        !contract ||
        !t.id ||
        ids.has(t.id) ||
        !object(args) ||
        !contract.validate(args)
      )
        throw new Error("INVALID_TOOL_ARGUMENTS");
      ids.add(t.id);
      ready.push({ type: "tool", id: t.id, name: t.name, arguments: args });
    }
    for (const tool of ready) yield tool;
    yield {
      type: "finish",
      result: { state: "complete", tools: ready.length },
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    const state = signal.aborted
      ? signal.reason?.name === "TimeoutError"
        ? "timeout"
        : "cancelled"
      : [
            "FORBIDDEN",
            "RATE_LIMIT",
            "INVALID_CREDENTIAL",
            "UPSTREAM_RETRY_STOPPED",
          ].includes(String(code))
        ? "refused"
        : code === "OUTPUT_TRUNCATED" || code === "output_truncated"
          ? "length"
          : error instanceof SyntaxError ||
              error instanceof TypeError ||
              (error instanceof Error &&
                /^(INVALID_|FRAME_|TOOL_|DELTA_|MULTIPLE_)/u.test(
                  error.message,
                ))
            ? "invalid"
            : "disconnected";
    yield {
      type: "finish",
      result: {
        state,
        tools: 0,
        code: signal.aborted
          ? signal.reason?.name === "TimeoutError"
            ? "ROUTER_TIMEOUT"
            : "ABORTED"
          : state === "refused"
            ? "UPSTREAM_REJECTED"
            : "INCOMPLETE_STREAM",
      },
    };
  }
}
