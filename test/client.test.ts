import { test } from "node:test";
import assert from "node:assert/strict";
import { RouterClient, contextError } from "../src/client/controller.js";
import type { Rpc } from "../src/client/controller.js";
import type { RouterSnapshot, RouterModel } from "../src/shared/types.js";
const model: RouterModel = {
  id: "cn/m",
  name: "M",
  source: "workbuddy",
  cost: "free",
  contextWindow: 128000,
  tools: true,
  images: true,
  reasoning: false,
};
function setup() {
  const snapshot: RouterSnapshot = {
    settings: {
      workbuddy: { enabledModels: [], autoCheckin: true },
      opencode: { enabledModels: [], autoCheckin: false },
    },
    accounts: [],
    models: {
      workbuddy: [model],
      opencode: [{ ...model, source: "opencode", id: "zen/m" }],
    },
  };
  let fail = false;
  const rpc = {
    snapshot: async () => ({ ok: true, value: structuredClone(snapshot) }),
    saveSettings: async (settings: RouterSnapshot["settings"]) =>
      fail
        ? { ok: false, error: { message: "SAVE_FAILED" } }
        : { ok: true, value: structuredClone(settings) },
  } as unknown as Rpc;
  return {
    client: new RouterClient(rpc),
    fail: () => {
      fail = true;
    },
  };
}
test("正式设置跨页/来源/目录刷新保留草稿，保存失败后仍可撤销", async () => {
  const { client, fail } = setup();
  await client.load();
  assert.equal(client.config(model).enabled, false);
  client.edit(model, {
    enabled: true,
    context: { mode: "custom", tokens: 64000 },
  });
  client.source = "opencode";
  client.tab = "连接与恢复";
  await client.load();
  assert.equal(client.config(model).context.mode, "custom");
  assert.equal(
    client.config(client.snapshot!.models.opencode[0]!).context.mode,
    "auto",
  );
  fail();
  await client.save();
  assert.equal(client.error, "SAVE_FAILED");
  assert.equal(client.dirty, true);
  client.undo();
  assert.equal(client.config(model).enabled, false);
  assert.equal(client.dirty, false);
});
test("正式上下文拒绝未知上限、小于 4096、非整数和超限；合法值保存", async () => {
  const { client } = setup();
  await client.load();
  for (const n of [0, 4095, 4096.5, 128001])
    assert.ok(
      contextError(model, {
        enabled: false,
        capabilities: {},
        context: { mode: "custom", tokens: n },
      }),
    );
  assert.ok(
    contextError(
      { ...model, contextWindow: undefined },
      {
        enabled: false,
        capabilities: {},
        context: { mode: "custom", tokens: 64000 },
      },
    ),
  );
  client.edit(model, {
    context: { mode: "custom", tokens: 72000 },
    capabilities: { images: false },
  });
  await client.save();
  assert.equal(client.dirty, false);
  assert.equal(
    client.snapshot!.settings.workbuddy.models![model.id]!.capabilities.images,
    false,
  );
});
