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
    snapshot,
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

test("隐藏不可用模型仍保留配置，搜索、能力和已启用筛选只返回可用项", async () => {
  const { client, snapshot } = setup();
  snapshot.models.workbuddy.push({ ...model, id: "cn/auto", name: "Auto", unavailable: "AUTOMATIC_ROUTE_NOT_SUPPORTED" });
  snapshot.settings.workbuddy.enabledModels = ["cn/auto", model.id];
  await client.load();
  assert.deepEqual(client.models().map(m => m.id), [model.id]);
  assert.equal(client.models("Auto", "tools", true).length, 0);
  assert.deepEqual(client.models("cn/m", "images", true).map(m => m.id), [model.id]);
  assert.equal(client.models("", "reasoning").length, 0);
  client.edit(model, { capabilities: { images: false } });
  await client.save();
  assert.ok(client.snapshot!.settings.workbuddy.enabledModels.includes("cn/auto"));
});

test("不可用的已保存超限配置不阻塞其他模型，恢复可用后重新校验", async () => {
  const { client, snapshot } = setup();
  const hidden = { ...model, id: "cn/hidden", name: "隐藏模型", contextWindow: undefined, unavailable: "MODEL_DISABLED" };
  snapshot.models.workbuddy.push(hidden);
  const saved = { enabled: true, context: { mode: "custom" as const, tokens: 64000 }, capabilities: { images: false }, allowedCosts: ["free" as const] };
  snapshot.settings.workbuddy.models = { [hidden.id]: saved };
  await client.load();
  client.edit(model, { enabled: true });
  assert.equal(client.validation(), "");
  await client.save();
  assert.deepEqual(client.snapshot!.settings.workbuddy.models![hidden.id], saved);
  snapshot.models.workbuddy[1] = { ...hidden, unavailable: undefined, contextWindow: 32000 };
  await client.load();
  assert.equal(client.models().length, 2);
  assert.match(client.validation(), /隐藏模型.*32,000/);
});

test("刷新使草稿模型不可用时点名阻止保存，保留草稿直至撤销", async () => {
  const { client, snapshot } = setup();
  await client.load();
  client.edit(model, { context: { mode: "custom", tokens: 64000 }, capabilities: { images: false } });
  snapshot.models.workbuddy[0] = { ...model, unavailable: "AUTH_REQUIRED" };
  await client.load();
  assert.equal(client.models().length, 0);
  assert.match(client.validation(), /M：模型暂不可用.*撤销/);
  await client.save();
  assert.equal(client.dirty, true);
  assert.equal(client.config(model).context.mode, "custom");
  client.undo();
  assert.equal(client.validation(), "");
  assert.equal(client.dirty, false);
  snapshot.models.workbuddy[0] = model;
  await client.load();
  assert.equal(client.models().length, 1);
  assert.equal(client.config(model).enabled, false);
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
