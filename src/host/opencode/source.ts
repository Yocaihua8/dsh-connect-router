import { findRuntime, startBackend } from "./vendor/runtime.js";
import { normalizeCatalog } from "./vendor/catalog.js";
import { createBridge } from "./vendor/bridge.js";
import { opencodeModels } from "../catalog.js";
import { parseChatStream, type WireEvent } from "../stream.js";
import type { RouterModel } from "../../shared/types.js";
import type { RouterSource, SourceCall } from "../adapter.js";

export class OpenCodeSource implements RouterSource {
  private catalog: RouterModel[] = [];
  private selected: string[] = [];
  private raw: any[] = [];
  private runtime: Awaited<ReturnType<typeof startBackend>> | undefined;
  private starting: Promise<void> | undefined;
  constructor(
    private readonly directory: string,
    private readonly service:
      | "anonymous"
      | "opencode"
      | "opencode-go" = "anonymous",
    private readonly auth: () => Promise<
      Record<string, { type: string; key: string }>
    > = async () => ({}),
  ) {}
  models() {
    return this.catalog.filter((m) => this.selected.includes(m.id));
  }
  select(ids: readonly string[]) {
    this.selected = [...ids];
  }
  private async start() {
    if (this.runtime) return;
    this.starting ??= (async () => {
      const binary = await findRuntime();
      if (!binary) throw new Error("OPENCODE_NOT_INSTALLED");
      this.runtime = await startBackend(
        binary,
        this.directory,
        () => {},
        await this.auth(),
      );
    })().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
  }
  async refresh(signal: AbortSignal) {
    signal.throwIfAborted();
    await this.start();
    signal.throwIfAborted();
    const response = await this.runtime!.backend.providers();
    signal.throwIfAborted();
    this.catalog = opencodeModels(response)
      .filter(
        (m) =>
          m.service ===
          (this.service === "anonymous" ? "opencode" : this.service),
      )
      .map((m) =>
        this.service === "anonymous" && m.cost !== "free"
          ? { ...m, unavailable: "AUTH_REQUIRED" }
          : m,
      );
    this.raw = normalizeCatalog(response);
    return this.catalog;
  }
  async dispose() {
    await this.starting?.catch(() => {});
    await this.runtime?.stop();
    this.runtime = undefined;
  }
  async prepare(id: string, signal?: AbortSignal): Promise<SourceCall> {
    signal?.throwIfAborted();
    if (!this.models().some((m) => m.id === id))
      throw new Error("MODEL_NOT_ENABLED");
    await this.start();
    signal?.throwIfAborted();
    const entries = this.raw.filter((m) => `${m.providerID}/${m.id}` === id),
      backend = this.runtime!.backend;
    const bridge = createBridge({
      backend,
      catalog: { current: () => entries },
      log: () => {},
    });
    return {
      async *run(body, tools, signal): AsyncGenerator<WireEvent> {
        const iterator = bridge
          .stream(
            { ...body, model: id, stream_options: { include_usage: false } },
            signal,
          )
          [Symbol.asyncIterator]();
        const encoder = new TextEncoder();
        // DONE is emitted only after the bridge has validated upstream finish and tool envelope.
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const step = await iterator.next();
              if (step.done) {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              } else
                controller.enqueue(
                  encoder.encode(
                    "data: " + JSON.stringify(step.value) + "\n\n",
                  ),
                );
            } catch (error) {
              controller.error(error);
            }
          },
          async cancel() {
            await iterator.return?.(undefined);
          },
        });
        yield* parseChatStream(stream, tools, signal);
      },
    };
  }
}
