import { test } from "node:test";
import assert from "node:assert/strict";
import ConnectRouter from "../src/host/service.js";
import { DEFAULT_SETTINGS, validateSettings } from "../src/host/store.js";
import type { RouterModel, RouterSettings } from "../src/shared/types.js";

const model: RouterModel = { source: "workbuddy", id: "cn/hidden", name: "Hidden", cost: "free", tools: true, images: true, reasoning: true, contextWindow: undefined, unavailable: "MODEL_DISABLED" };
function setup() {
  const proto = ConnectRouter.prototype as any;
  let writes = 0;
  const context = {
    ctx: { invocation: { peer: { principal: { kind: "owner" } } }, emit: () => {} },
    ready: Promise.resolve(), guarded: proto.guarded,
    settings: structuredClone(DEFAULT_SETTINGS),
    pools: { workbuddy: { catalog: () => [model] }, opencode: { catalog: () => [] } },
    store: { saveSettings: async (s: RouterSettings) => { writes++; return validateSettings(s); } },
  };
  context.settings.workbuddy.models = { [model.id]: { enabled: true, context: { mode: "custom", tokens: 960000 }, capabilities: { reasoning: false }, allowedCosts: ["free"] } };
  return { context, writes: () => writes, save: (s: RouterSettings) => proto.saveSettings.call(context, s, new AbortController().signal) };
}
test("owner saveSettings preserves unavailable stale settings while saving another source", async () => {
  const s = setup(), next = structuredClone(s.context.settings);
  next.opencode.enabledModels = ["opencode/free"];
  const saved = await s.save(next);
  assert.deepEqual(saved.workbuddy, next.workbuddy);
  assert.deepEqual(saved.opencode.enabledModels, ["opencode/free"]);
  assert.equal(s.writes(), 1);
});
test("backend rejects hidden enable, context, capability and fee edits before storage", async () => {
  for (const patch of [{ enabled: false }, { context: { mode: "auto" as const } }, { capabilities: { images: false } }, { allowedCosts: ["free" as const, "paid" as const] }]) {
    const s = setup(), next = structuredClone(s.context.settings);
    Object.assign(next.workbuddy.models![model.id]!, patch);
    await assert.rejects(s.save(next), /UNAVAILABLE_MODEL_CHANGED/);
    assert.equal(s.writes(), 0);
  }
});
test("restored models revalidate capacity and capabilities; non-owner remains denied", async () => {
  const s = setup();
  s.context.pools.workbuddy.catalog = () => [{ ...model, unavailable: undefined, contextWindow: 32000, reasoningCanDisable: true }];
  await assert.rejects(s.save(s.context.settings), /CONTEXT_LIMIT_UNCONFIRMED/);
  s.context.ctx.invocation.peer.principal.kind = "guest";
  await assert.rejects(s.save(s.context.settings), /OWNER_REQUIRED/);
  assert.equal(s.writes(), 0);
});
