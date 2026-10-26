import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { groupKey, routeKey, approvalKey, modelGroups, groupSettings, groupCandidates, configuredGroup, groupError, retainedWorkBuddyIds } from "../src/shared/groups.js";
import type { RouterModel, SourceSettings, AccountSnapshot, RouterSnapshot } from "../src/shared/types.js";
import { PoolSource, type PoolMember } from "../src/host/pool.js";
import { RouterLogs } from "../src/host/logs.js";
import { RequestBindings } from "../src/host/bindings.js";
import { RouterClient, type Rpc } from "../src/client/controller.js";
import { validateSettings, DEFAULT_SETTINGS } from "../src/host/store.js";
import ConnectRouter from "../src/host/service.js";

const route = (id: string, more: Partial<RouterModel> = {}): RouterModel => ({ source: "workbuddy", service: "workbuddy", region: "cn", id: `cn/${id}`, upstreamId: id, name: "Hy4 preview", cost: "free", contextWindow: 960000, maxOutput: 64000, tools: true, images: true, reasoning: false, ...more });
const settings = (): SourceSettings => ({ enabledModels: [], autoCheckin: true, models: { "cn/a": { enabled: true, context: { mode: "auto" }, capabilities: {}, allowedCosts: ["free", "credits"] } } });

test("同名组 ID 稳定、仅 NFC 和首尾空白规范化，服务/区域/版本隔离", () => {
  const a = route("a"), b = route("b", { name: " Hy4 preview " });
  assert.equal(groupKey(a), groupKey(b));
  assert.equal(modelGroups([b, a], settings())[0]!.id, modelGroups([a], settings())[0]!.id);
  assert.equal(groupKey(route("a", { name: "é" })), groupKey(route("b", { name: "e\u0301" })));
  for (const p of [{ region: "global" }, { service: "zen" }, { source: "opencode" as const }, { name: "Hy4 preview-x" }, { name: "HY4 preview" }]) assert.notEqual(groupKey(a), groupKey({ ...a, ...p }));
});
test("继承一致旧选择，冲突待统一，旧线路配置和未知字段校验保留", () => {
  const s = settings(), rows = [route("a"), route("b")];
  s.models!["cn/b"] = { ...s.models!["cn/a"]!, context: { mode: "custom", tokens: 32000 } };
  const g = modelGroups(rows, s)[0]!, c = groupSettings(g, s);
  assert.equal(c.needsReview, true);
  assert.equal(groupError(g, c), "GROUP_SETTINGS_REVIEW_REQUIRED");
  s.groups = { [g.id]: { ...c, needsReview: false } };
  const round = validateSettings({ ...structuredClone(DEFAULT_SETTINGS), workbuddy: s });
  assert.deepEqual(round.workbuddy.models, s.models);
  assert.equal(groupError(g, groupSettings(g, round.workbuddy)), "");
});
test("能力不能取不同线路并集，自动窗口仅从完整匹配候选选择", () => {
  const s = settings();
  const rows = [route("a", { contextWindow: 1000000, images: false }), route("b", { contextWindow: 256000, tools: false })];
  const g = modelGroups(rows, s)[0]!, c = groupSettings(g, s);
  assert.equal(groupError(g, c), "NO_MATCHING_GROUP_ROUTE");
  c.capabilities.images = false;
  assert.equal(configuredGroup(g, c).contextWindow, 1000000);
  c.capabilities = { tools: false };
  assert.equal(configuredGroup(g, c).contextWindow, 256000);
  c.context = { mode: "custom", tokens: 960000 };
  assert.equal(groupError(g, c), "CONTEXT_LIMIT_UNCONFIRMED");
});
test("新免费额度线路自动加入；新付费、未知及费用类别变化须逐线路授权", () => {
  const s = settings(), paid = route("paid", { cost: "paid" }), unknown = route("unknown", { cost: "unknown" });
  const g = modelGroups([route("a"), route("b"), route("credits", { cost: "credits" }), paid, unknown], s)[0]!;
  const c = groupSettings(g, s);
  c.allowedCosts = ["free", "credits", "paid", "unknown"];
  c.approvedRoutes = [approvalKey(paid)];
  assert.deepEqual(groupCandidates(g, c).map(r => r.upstreamId), ["a", "b", "credits", "paid"]);
  assert.equal(groupCandidates({ ...g, routes: [{ ...paid, cost: "unknown" }] }, c).length, 0);
});
test("已启用组保留曾可用线路，不把诊断目录中非名单线路变成历史选择", () => {
  const s = settings(), rows = [route("a"), route("b", { unavailable: "NOT_IN_CURRENT_ROSTER" }), route("c", { region: "global" })];
  const g = modelGroups(rows, s)[0]!; s.groups = { [g.id]: groupSettings(g, s) };
  assert.deepEqual(retainedWorkBuddyIds(s, "cn", rows), ["a"]);
  s.models!["cn/b"] = { ...s.models!["cn/a"]! };
  assert.deepEqual(retainedWorkBuddyIds(s, "cn", rows), ["a", "b"]);
});
test("迁移后新增或改名的组默认关闭，保留的旧线路选择不隐式授权新组", () => {
  const s = settings(), initial = modelGroups([route("a")], s)[0]!;
  s.groups = { [initial.id]: { ...groupSettings(initial, s), enabled: false } };
  const renamed = modelGroups([route("a", { name: "Hy5" })], s)[0]!;
  assert.equal(groupSettings(renamed, s).enabled, false);
  assert.equal(s.models!["cn/a"]!.enabled, true);
});

async function harness(rows: RouterModel[][], config = settings()) {
  const dir = await mkdtemp(join(tmpdir(), "router-groups-")), logs = new RouterLogs(dir);
  const calls: string[] = [];
  const members: PoolMember[] = rows.map((models, i) => ({
    state: { id: `acct-${i}`, label: "test", source: "workbuddy", service: "workbuddy", region: "cn", enabled: true, status: "ready", models, quota: [{ kind: "gift", unit: "credits", remaining: 10, expiresAt: Date.now() + 10000 }], updatedAt: Date.now() } as AccountSnapshot,
    refresh: async () => {},
    source: { models: () => models, prepare: async (id) => ({ async *run() { calls.push(`${i}:${id}`); yield { type: "finish" as const, result: { state: "refused" as const, tools: 0, code: "UPSTREAM_CHANNEL_REJECT" } }; } }) },
  }));
  const create = () => new PoolSource("workbuddy", () => members, () => config, logs, new RequestBindings(dir));
  const run = async (pool: PoolSource, turnId = "t", continuation = false, id = groupKey(rows[0]![0]!)) => {
    const c = await pool.prepare(id);
    for await (const _ of c.run({ messages: [] }, [], new AbortController().signal, { sessionId: "s", turnId, continuation })) {}
  };
  return { dir, logs, members, calls, create, run, config };
}
test("免费优先、同账号名单顺序、并发和重启续写绑定实际线路，拒绝不重发", async () => {
  const h = await harness([[route("credits", { cost: "credits" }), route("a"), route("b")], [route("c")]]);
  const pool = h.create();
  assert.equal(pool.models().length, 1);
  await Promise.all([h.run(pool), h.run(pool)]);
  assert.deepEqual(h.calls, ["0:a", "0:a"]);
  await h.run(h.create(), "continued", true);
  assert.equal(h.calls.at(-1), "0:a");
  assert.equal(h.members[0]!.state.models[1]!.unavailable, undefined);
  const records = (await h.logs.query()).items;
  assert.equal(records[0]!.route, routeKey(route("a")));
  assert.equal(records[0]!.group, groupKey(route("a")));
  assert.equal(records[0]!.reason, "pinned");
  h.members[0]!.state.models[1]!.unavailable = "MODEL_DISABLED";
  await assert.rejects(h.run(h.create(), "continued-2", true), /PINNED_ACCOUNT_UNAVAILABLE/);
  assert.equal(h.calls.length, 3);
  await h.run(h.create(), "new-request");
  assert.notEqual(h.calls.at(-1), "0:a");
});
test("按账号实际窗口选线，旧会话 ID 固定线路，未知恢复线路明确停止", async () => {
  const h = await harness([[route("a", { contextWindow: 32000 }), route("b")], [route("a")]]);
  await h.run(h.create());
  assert.equal(h.calls[0], "0:b");
  await h.run(h.create(), "old", false, "cn/a");
  assert.equal(h.calls[1], "1:a");
  await new RequestBindings(h.dir).assign(`legacy:${groupKey(route("a"))}:latest`, "unused", false, "acct-0");
  const call = await h.create().prepare(groupKey(route("a")));
  await assert.rejects(async () => { for await (const _ of call.run({}, [], new AbortController().signal, { sessionId: "legacy", turnId: "resume", continuation: true })) {} }, /RECOVERY_ROUTE_UNKNOWN/);
});
test("暂停账号不抬高自动窗口，赠送耗尽不因其他付费许可转付费", async () => {
  const h = await harness([[route("a", { contextWindow: 32000 })], [route("a")]]);
  h.members[1]!.state.enabled = false;
  assert.equal(h.create().models()[0]!.contextWindow, 32000);
  const credit = route("a", { cost: "credits" });
  h.members[0]!.state.models = [credit]; h.members[0]!.state.quota = [];
  h.config.models!["cn/a"]!.allowedCosts = ["free", "credits", "paid"];
  await assert.rejects(h.run(h.create()), /NO_ELIGIBLE_ACCOUNT/);
});
test("实际推理档位和最大输出也必须由同一条线路满足", async () => {
  const h = await harness([[route("a", { reasoning: true, reasoningEfforts: ["low"], maxOutput: 32000 }), route("b", { reasoning: true, reasoningEfforts: ["high"], maxOutput: 64000 })]]);
  const call = await h.create().prepare(groupKey(route("a")));
  for await (const _ of call.run({ reasoning_effort: "high", max_tokens: 48000 }, [], new AbortController().signal, { sessionId: "effort", turnId: "one" })) {}
  assert.deepEqual(h.calls, ["0:b"]);
});
test("旧会话与冲突组并存，其他组可保存；不可用组编辑不可保存", async () => {
  const h = await harness([[route("a"), route("b")]]);
  h.config.models!["cn/b"] = { enabled: true, context: { mode: "custom", tokens: 32000 }, capabilities: {} };
  const pool = h.create();
  assert.equal(pool.models().length, 0);
  assert.ok(pool.resolve("cn/a"));
  const group = pool.groups()[0]!, proto = ConnectRouter.prototype as any;
  const initial = { ...structuredClone(DEFAULT_SETTINGS), workbuddy: { ...h.config, groups: { [group.id]: groupSettings(group, h.config) } } };
  const context = { ctx: { invocation: { peer: { principal: { kind: "owner" } } }, emit: () => {} }, ready: Promise.resolve(), guarded: proto.guarded, settings: initial,
    pools: { workbuddy: pool, opencode: { catalog: () => [], groups: () => [] } }, store: { saveSettings: async (s: typeof initial) => validateSettings(s) } };
  const next = structuredClone(initial); next.opencode.autoCheckin = true;
  await proto.saveSettings.call(context, next, new AbortController().signal);
  h.members[0]!.state.models.forEach(m => m.unavailable = "MODEL_DISABLED");
  next.workbuddy.groups[group.id]!.enabled = false;
  await assert.rejects(proto.saveSettings.call(context, next, new AbortController().signal), /UNAVAILABLE_MODEL_CHANGED/);
});
test("客户端统一草稿、冲突确认、隐藏后保留、保存失败与撤销", async () => {
  const s = settings(); s.models!["cn/b"] = { ...s.models!["cn/a"]!, context: { mode: "custom", tokens: 32000 } };
  const rows = [route("a"), route("b")];
  const snap: RouterSnapshot = { settings: { ...structuredClone(DEFAULT_SETTINGS), workbuddy: s }, accounts: [], models: { workbuddy: rows, opencode: [] }, groups: { workbuddy: modelGroups(rows, s), opencode: [] } };
  const client = new RouterClient({ snapshot: async () => ({ ok: true, value: structuredClone(snap) }), saveSettings: async () => ({ ok: false, error: { message: "SAVE_FAILED" } }) } as unknown as Rpc);
  await client.load();
  let g = client.models()[0]!;
  client.confirmGroup(g as any, { ...s.models!["cn/b"]! });
  client.tab = "连接与恢复"; client.source = "opencode"; await client.load(); client.source = "workbuddy";
  assert.deepEqual(client.config(client.models()[0]!).context, { mode: "custom", tokens: 32000 });
  await client.save(); assert.equal(client.dirty, true);
  snap.groups!.workbuddy[0]!.routes.forEach(m => m.unavailable = "MODEL_DISABLED");
  await client.load(); assert.equal(client.models().length, 0); assert.match(client.validation(), /Hy4 preview.*撤销/);
  client.undo(); assert.equal(client.validation(), "");
  snap.groups!.workbuddy[0]!.routes.forEach(m => delete m.unavailable);
  await client.load(); assert.equal(client.models().length, 1);
});
