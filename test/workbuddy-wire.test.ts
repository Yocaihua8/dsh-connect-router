import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WorkBuddyUpstreamClient,
  parseUpstreamModel,
} from "../src/host/workbuddy/vendor/upstream.js";
import { workbuddyModel } from "../src/host/catalog.js";
const c = {
  accessToken: "test-access",
  refreshToken: "test-refresh",
  uid: "test-user",
  expiresAtMs: 9999999999999,
  domain: "codebuddy.cn",
  source: "dsh" as const,
  filePath: "",
};
test("复用目录字段正确映射价格/窗口/工具能力", () => {
  const raw = parseUpstreamModel({
    id: "m",
    credits: "x0.00",
    maxInputTokens: 32000,
    maxOutputTokens: 8192,
    supportsToolCall: true,
  });
  assert.ok(raw);
  const m = workbuddyModel(raw);
  assert.equal(m.cost, "free");
  assert.equal(m.contextWindow, 32000);
  assert.equal(m.tools, true);
});
test("聊天包含 DSH attribution 且绝不发送 refresh token", async () => {
  const original = globalThis.fetch;
  let init: RequestInit | undefined;
  globalThis.fetch = async (_input, options) => {
    init = options;
    return new Response("data: [DONE]");
  };
  try {
    await new WorkBuddyUpstreamClient().chatStream(c, "{}");
    const h = new Headers(init?.headers);
    assert.match(h.get("user-agent") ?? "", /deepseek-harness/u);
    assert.equal(h.get("authorization"), "Bearer test-access");
    assert.equal(JSON.stringify(init).includes("test-refresh"), false);
  } finally {
    globalThis.fetch = original;
  }
});
test("福利查询失败不能伪装暂无活动", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("failure", { status: 500 });
  try {
    await assert.rejects(() => new WorkBuddyUpstreamClient().fetchBenefits(c));
  } finally {
    globalThis.fetch = original;
  }
});
