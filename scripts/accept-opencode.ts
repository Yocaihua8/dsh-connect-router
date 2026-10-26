import { mkdir, writeFile } from "node:fs/promises";
import { OpenCodeSource } from "../src/host/opencode/source.js";
import { RouterAdapter, ROUTES } from "../src/host/adapter.js";
import { resolve } from "node:path";
const directory = resolve("../output/router-opencode-acceptance-20261026");
await mkdir(directory, { recursive: true });
const source = new OpenCodeSource(directory);
const signal = AbortSignal.timeout(90_000);
const result: {
  at: string;
  models?: string[];
  model?: string;
  chunks?: unknown[];
  error?: string;
  scope: string;
} = {
  at: new Date().toISOString(),
  scope: "isolated adapter call only; not DSH desktop acceptance",
};
try {
  const models = await source.refresh(signal);
  result.models = models.filter((m) => m.cost === "free").map((m) => m.id);
  const chosen = models.find(
    (m) => m.id === "opencode/big-pickle" && m.cost === "free",
  );
  if (!chosen) throw new Error("KNOWN_FREE_MODEL_NOT_AVAILABLE");
  source.select([chosen.id]);
  result.model = chosen.id;
  const adapter = new RouterAdapter(
    source,
    ROUTES.opencode,
    () => 32000,
    () => {},
  );
  const chunks = [];
  for await (const c of adapter.stream({
    provider: ROUTES.opencode,
    model: chosen.id,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Reply with only ROUTER_OK." }],
      },
    ],
    maxTokens: 64,
    signal,
  }))
    chunks.push(c);
  result.chunks = chunks;
} catch (e) {
  result.error = e instanceof Error ? e.message : "failed";
} finally {
  await source.dispose();
  await writeFile(
    resolve(directory, "adapter-result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
}
