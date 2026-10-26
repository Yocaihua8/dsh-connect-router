// Roster/overlay cases adapted from dsh-connect-workbuddy 3b558326 (MIT, LaoDing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selectCliModels, WorkBuddyUpstreamClient } from "../src/host/workbuddy/vendor/upstream.js";
import { mergeRoster, overlayLiveCapabilities } from "../src/host/workbuddy/vendor/catalog-sync.js";
import { WorkBuddySource } from "../src/host/workbuddy/source.js";
import { workbuddyModel } from "../src/host/catalog.js";

const raw = (id: string, extra = {}) => ({ id, name: id, maxInputTokens: 960000, maxOutputTokens: 64000, credits: "x0.00", supportsToolCall: true, ...extra });
const data = () => ({ models: [raw("auto"), raw("a"), raw("b"), raw("retired"), raw("disabled", { disabled: true })], agents: [{ name: "cli", models: ["b", "a", "disabled"] }] });
const credential = { accessToken: "synthetic-token", refreshToken: "synthetic-refresh", uid: "test", domain: "codebuddy.cn", source: "dsh" as const, filePath: "", expiresAtMs: Date.now() + 3600000 };
test("上游名单顺序、历史选择、路由排除、缺失名单降级与空名单", () => {
  const d = data();
  assert.deepEqual(selectCliModels(d.models, d.agents).map(m => m.id), ["b", "a", "disabled"]);
  assert.deepEqual(selectCliModels(d.models, d.agents, ["retired", "auto", "deleted"]).map(m => m.id), ["b", "a", "disabled", "retired"]);
  assert.equal(selectCliModels(d.models, undefined).length, 4);
  assert.equal(selectCliModels(d.models, [{ name: "cli", models: [] }]).length, 4);
  assert.throws(() => selectCliModels([raw("auto")], undefined), /empty list/);
});
test("原同步函数让实时推理/费用/图片覆盖缓存，并移除已结束促销", () => {
  const saved = { id: "a", name: "saved", contextWindow: 32000, maxTokens: 8000, supportsImages: false, creditMultiplier: 1, promos: [] };
  const live = { ...saved, name: "live", creditMultiplier: 0, supportsImages: true, reasoning: { supportedEfforts: ["high"] } };
  const fixed = overlayLiveCapabilities(saved, live);
  assert.equal(fixed.creditMultiplier, 0); assert.equal(fixed.supportsImages, true);
  assert.deepEqual(fixed.reasoning, live.reasoning);
  assert.equal("promos" in overlayLiveCapabilities(saved, { ...live, promos: undefined }), false);
  assert.deepEqual(mergeRoster([saved], [{ ...live, id: "b" }]).map(m => m.id), ["b", "a"]);
});
test("真实目录读取路径复用：v3 失败回落 v2，原始诊断包含非名单模型", async t => {
  const paths: string[] = [], reasons: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    paths.push(url);
    return new Response(JSON.stringify(paths.length === 1 ? { code: 1, msg: "unavailable" } : { code: 0, data: data() }), { status: 200 });
  });
  const client = new WorkBuddyUpstreamClient(m => reasons.push(m));
  assert.deepEqual((await client.fetchModels(credential)).map(m => m.id), ["b", "a", "disabled"]);
  assert.match(paths[0]!, /v3\/config/); assert.match(paths[1]!, /v2\/enterprises\/personal\/models/);
  assert.equal(client.lastCatalog.find(m => m.id === "retired")?.unavailable, "NOT_IN_CURRENT_ROSTER");
  assert.equal(client.lastCatalog.find(m => m.id === "disabled")?.unavailable, "MODEL_DISABLED");
  assert.equal(reasons.length, 1);
});
test("目录缓存重启降级/恢复、实时窗口修复、明确删除与授权失效", async t => {
  const directory = await mkdtemp(join(tmpdir(), "router-roster-")), file = join(directory, "catalog.json"), reasons: string[] = [];
  let mode = "live";
  t.mock.method(globalThis, "fetch", async () => {
    if (mode === "network") throw new Error("timeout");
    if (mode === "auth") return new Response("{}", { status: 401 });
    const d = data();
    if (mode === "recovered") { d.models = [raw("a", { maxInputTokens: 1000000 })]; d.agents = [{ name: "cli", models: ["a"] }]; }
    return new Response(JSON.stringify({ code: 0, data: d }));
  });
  const create = () => new WorkBuddySource({ resolve: async () => credential } as any, {} as any, new WorkBuddyUpstreamClient(), "cn", () => ["retired"], file, s => reasons.push(s));
  let source = create(); let rows = await source.refresh(new AbortController().signal);
  assert.equal(rows.find(m => m.id === "retired")?.unavailable, undefined);
  mode = "network"; source = create(); rows = await source.refresh(new AbortController().signal);
  assert.equal(rows.find(m => m.id === "a")?.unavailable, undefined);
  assert.ok(reasons.includes("MODEL_CATALOG_CACHED"));
  mode = "recovered"; rows = await source.refresh(new AbortController().signal);
  assert.equal(rows.find(m => m.id === "a")?.contextWindow, 1000000);
  assert.equal(rows.find(m => m.id === "b")?.unavailable, "MODEL_REMOVED");
  mode = "auth"; await assert.rejects(source.refresh(new AbortController().signal), /AUTH_EXPIRED/);
  const cache = await readFile(file, "utf8"); assert.doesNotMatch(cache, /synthetic-token|synthetic-refresh/);
});
test("名单缺失记录降级，动态免费价格按成熟促销时间计算", async t => {
  const reasons: string[] = [];
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ code: 0, data: { models: [raw("a")] } })));
  await new WorkBuddyUpstreamClient(s => reasons.push(s)).fetchModels(credential);
  assert.deepEqual(reasons, ["MODEL_ROSTER_MISSING"]);
  const promo = { id: "free", modelIds: ["a"], source: "promotion", priority: 1, badge: { text: "free" }, schedule: { validFrom: Date.now() - 10000, validUntil: Date.now() + 10000 }, discount: { multiplier: 0, displayMode: "replace" } } as any;
  assert.equal(workbuddyModel({ id: "a", creditMultiplier: 1, promos: [promo] }).cost, "free");
  promo.schedule.validUntil = Date.now() - 1;
  assert.equal(workbuddyModel({ id: "a", creditMultiplier: 1, promos: [promo] }).cost, "credits");
  assert.equal(workbuddyModel({ id: "a", promos: [promo] }).cost, "unknown");
});
