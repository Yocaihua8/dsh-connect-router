import {
  LlmAdapter,
  ToolCallId,
  ReasoningEffortId,
  projectToolUpdates,
  resolveRetryPolicy,
} from "@deepseek-ai/dsh-llm";
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  StreamChunk,
  ContentBlock,
} from "@deepseek-ai/dsh-llm";
import { z } from "zod";
import type { RouterModel, StreamFinish } from "../shared/types.js";
import type { ToolContract, WireEvent } from "./stream.js";
import type { ImageBlock } from "@deepseek-ai/dsh-llm";
import { createHash } from "node:crypto";
import { CONTINUE_PROMPT } from "../shared/types.js";
export interface CallIdentity {
  purpose?: "compaction" | "session-title";
  sessionId?: string;
  turnId?: string;
  continuation?: boolean;
}
export interface SourceCall {
  run(
    body: Record<string, unknown>,
    tools: readonly ToolContract[],
    signal: AbortSignal,
    identity?: CallIdentity,
  ): AsyncIterable<WireEvent>;
}
export interface RouterSource {
  models(): readonly RouterModel[];
  prepare(model: string, signal?: AbortSignal): Promise<SourceCall>;
}
export const ROUTES = {
  workbuddy: "connect-router-workbuddy",
  opencode: "connect-router-opencode",
} as const;
export class RouterAdapter extends LlmAdapter {
  constructor(
    private readonly source: RouterSource,
    private readonly route: string,
    private readonly budget: (model?: string) => number | undefined,
    private readonly onFinish: (
      options: GenerateOptions,
      result: StreamFinish,
    ) => void,
    private readonly imageData?: (
      image: ImageBlock,
      signal: AbortSignal,
    ) => Promise<string>,
  ) {
    super();
  }
  override providerInfo(provider: string) {
    return {
      id: provider,
      name:
        provider === ROUTES.workbuddy
          ? "Connect Router · WorkBuddy"
          : "Connect Router · OpenCode",
    };
  }
  override providerRetryPolicy() {
    return resolveRetryPolicy(
      { mode: "normal", maxRetries: 0 },
      "connect-router",
    );
  }
  private metadata(provider: string, id: string): LlmResolvedModelInfo {
    const m = this.source.models().find((m) => m.id === id);
    if (!m) throw new Error("MODEL_NOT_ENABLED");
    const budget = this.budget(id),
      window =
        m.contextWindow === undefined
          ? budget
          : budget === undefined
            ? m.contextWindow
            : Math.min(m.contextWindow, budget);
    return {
      provider,
      id,
      name: m.name,
      description:
        m.cost === "free"
          ? "免费"
          : m.cost === "credits"
            ? "消耗额度"
            : m.cost === "paid"
              ? "付费"
              : "费用未知",
      inputModalities:
        m.images && this.imageData ? ["text", "image"] : ["text"],
      ...(m.reasoning && m.reasoningEfforts?.length
        ? {
            reasoning: {
              efforts: m.reasoningEfforts.map((id) => ({
                id: ReasoningEffortId(id),
                name: id,
              })),
            },
          }
        : {}),
      ...(window ? { context: { contextWindow: window } } : {}),
      ...(m.maxOutput && (!window || m.maxOutput < window)
        ? { defaultMaxTokens: m.maxOutput }
        : {}),
    };
  }
  override async listModels(provider: string) {
    return this.source.models().map((m) => this.metadata(provider, m.id));
  }
  override async resolveModel(
    provider: string,
    id: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    return this.metadata(provider, id);
  }
  override async prepareCall(
    provider: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    if (provider !== this.route) throw new Error("INVALID_PROVIDER");
    const model = this.metadata(provider, id),
      call = await this.source.prepare(id, signal);
    const capabilities = structuredClone(
      this.source.models().find((m) => m.id === id)!,
    );
    return {
      model,
      stream: (options) => this.dispatch(options, call, capabilities),
    };
  }
  override async *stream(
    options: GenerateOptions,
  ): AsyncGenerator<StreamChunk> {
    const prepared = await this.prepareCall(
      options.provider,
      options.model,
      options.signal,
    );
    yield* prepared.stream(options);
  }
  private async *dispatch(
    options: GenerateOptions,
    call: SourceCall,
    model: RouterModel,
  ): AsyncGenerator<StreamChunk> {
    const signal = options.signal ?? new AbortController().signal;
    const projection = projectToolUpdates(
      options.messages,
      options.tools,
      undefined,
      options.toolHistory,
    );
    const activeTools = model.tools ? (projection.tools ?? []) : [];
    const tools: ToolContract[] = activeTools.map((t) => {
      const schema = z.fromJSONSchema(t.parameters);
      return {
        name: t.name,
        validate: (value) => schema.safeParse(value).success,
      };
    });
    const images = new Map<ImageBlock, string>();
    for (const message of projection.messages)
      for (const block of message.content)
        if (block.type === "image") {
          if (!model.images || !this.imageData)
            throw new Error("IMAGES_NOT_SUPPORTED");
          images.set(block, await this.imageData(block, signal));
        }
    const body = requestBody(
      {
        ...options,
        messages: [...projection.messages],
        tools: activeTools.length ? [...activeTools] : undefined,
        reasoningEffort:
          !model.reasoning && model.reasoningCanDisable
            ? ("off" as GenerateOptions["reasoningEffort"])
            : options.reasoningEffort,
      },
      images,
    );
    const lastUser = [...options.messages]
      .reverse()
      .find((m) => m.role === "user");
    const identity: CallIdentity = {
      purpose: options.purpose,
      sessionId: options.sessionId,
      continuation: lastUser?.content.some(
        (b) => b.type === "text" && b.text === CONTINUE_PROMPT,
      ),
      turnId:
        lastUser && "id" in lastUser && lastUser.id
          ? String(lastUser.id)
          : lastUser
            ? createHash("sha256")
                .update(
                  JSON.stringify([
                    options.messages.filter((m) => m.role === "user").length,
                    lastUser,
                  ]),
                )
                .digest("hex")
            : undefined,
    };
    let index = 0;
    const blocks = new Map<
      "text" | "reasoning",
      { index: number; text: string }
    >();
    const close = (): StreamChunk[] =>
      [...blocks].map(([type, b]) => ({
        type: "block-end",
        index: b.index,
        block: { type, text: b.text },
      }));
    let final: StreamFinish | undefined;
    try {
      for await (const event of call.run(body, tools, signal, identity)) {
        if (event.type === "text" || event.type === "reasoning") {
          let block = blocks.get(event.type);
          if (!block) {
            block = { index: index++, text: "" };
            blocks.set(event.type, block);
            yield {
              type: "block-start",
              index: block.index,
              blockType: event.type,
            };
          }
          block.text += event.text;
          yield {
            type: event.type === "text" ? "text-delta" : "reasoning-delta",
            index: block.index,
            text: event.text,
          };
        } else if (event.type === "tool") {
          const id = ToolCallId(event.id),
            argumentsText = JSON.stringify(event.arguments);
          const n = index++;
          yield { type: "block-start", index: n, blockType: "tool-call" };
          yield {
            type: "tool-call-delta",
            index: n,
            id,
            name: event.name,
            argumentsDelta: argumentsText,
          };
          yield {
            type: "block-end",
            index: n,
            block: {
              type: "tool-call",
              id,
              name: event.name,
              arguments: argumentsText,
            },
          };
        } else if (event.type === "usage") {
          // DSH requires both counts; omit incomplete snapshots rather than inventing zero.
          if (event.input !== undefined && event.output !== undefined)
            yield {
              type: "usage",
              usage: {
                inputTokens: event.input,
                outputTokens: event.output,
                totalTokens: event.input + event.output,
              },
            };
        } else if (event.type === "finish") {
          final = event.result;
          break;
        }
      }
    } catch (error) {
      final = {
        state: signal.aborted ? "cancelled" : "disconnected",
        tools: 0,
        code:
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : "UPSTREAM_FAILED",
      };
    }
    yield* close();
    final ??= {
      state: "disconnected",
      tools: 0,
      code: "MISSING_COMPLETION_EVIDENCE",
    };
    this.onFinish(options, final);
    yield {
      type: "finish",
      reason:
        final.state === "complete"
          ? { kind: final.tools ? "tool-calls" : "stop" }
          : final.state === "length"
            ? { kind: "max-tokens" }
            : final.state === "cancelled"
              ? {
                  kind: "aborted",
                  failure: {
                    code: "ABORTED",
                    message: "已取消生成，已有内容保留。",
                  },
                }
              : {
                  kind: "error",
                  failure: {
                    code:
                      final.code === "CONTEXT_OVERFLOW"
                        ? "CONTEXT_WINDOW_EXCEEDED"
                        : (final.code ?? "ROUTER_INCOMPLETE"),
                    message:
                      final.code === "UPSTREAM_CHANNEL_REJECT"
                        ? "WorkBuddy 拒绝当前调用通道；请查看连接与恢复中的诊断记录。"
                        : final.code === "CONTEXT_OVERFLOW"
                          ? "上游报告上下文超限；请查看原生压缩记录。"
                        : final.state === "refused"
                        ? "上游拒绝请求，请检查免费额度或来源限制。"
                        : final.state === "timeout"
                          ? "上游请求超时，已有内容保留。"
                          : "回答未完整结束，已有内容保留，请点击继续生成。",
                  },
                },
    };
  }
}
/** Does not trim, reorder, summarize, perturb or silently drop supported history. */
export function requestBody(
  options: GenerateOptions,
  images = new Map<ImageBlock, string>(),
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (options.system !== undefined)
    messages.push({ role: "system", content: options.system });
  for (const message of options.messages) {
    const text: string[] = [],
      parts: Record<string, unknown>[] = [],
      reasoning: string[] = [],
      calls: Record<string, unknown>[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        text.push(block.text);
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        const url = images.get(block);
        if (!url || !/^data:image\/(png|jpeg|webp|gif);base64,/u.test(url))
          throw new Error("IMAGE_BYTES_REQUIRED");
        parts.push({ type: "image_url", image_url: { url } });
      } else if (block.type === "reasoning") reasoning.push(block.text);
      else if (block.type === "tool-call")
        calls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: block.arguments },
        });
      else throw new Error("CONTENT_NOT_SUPPORTED");
    }
    const row: Record<string, unknown> = {
      role: message.role,
      content: parts.some((p) => p.type === "image_url")
        ? parts
        : text.join("\n"),
    };
    if (reasoning.length) row.reasoning_content = reasoning.join("\n");
    if (calls.length) row.tool_calls = calls;
    if (message.role === "tool") row.tool_call_id = message.toolCallId;
    messages.push(row);
  }
  return {
    model: options.model,
    messages,
    stream: true,
    ...(options.tools?.length
      ? {
          tools: options.tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
        }
      : {}),
    ...(options.maxTokens === undefined
      ? {}
      : { max_tokens: options.maxTokens }),
    ...(options.temperature === undefined
      ? {}
      : { temperature: options.temperature }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
    ...(options.reasoningEffort === undefined
      ? {}
      : { reasoning_effort: options.reasoningEffort }),
  };
}
