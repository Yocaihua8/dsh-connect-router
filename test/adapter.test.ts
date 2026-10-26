import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RouterAdapter,
  ROUTES,
  requestBody,
  type RouterSource,
} from "../src/host/adapter.js";
import {
  createSystemMessage,
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
test("请求保持系统指令和工具配对，不修改冻结历史", () => {
  const id = ToolCallId("tool-1");
  const messages = [
    createSystemMessage("system"),
    createUserMessage({
      content: [{ type: "text", text: "问" }],
      source: { kind: "user" },
    }),
    createAssistantMessage({
      source: { provider: ROUTES.workbuddy, model: "free" },
      content: [
        { type: "tool-call", id, name: "read", arguments: '{"path":"a"}' },
      ],
    }),
    createToolResultMessage({
      callId: id,
      isError: false,
      content: [{ type: "text", text: "已完成工具结果" }],
    }),
  ];
  const before = JSON.stringify(messages);
  const request = requestBody({
    provider: ROUTES.workbuddy,
    model: "free",
    messages,
  });
  assert.equal(JSON.stringify(messages), before);
  const rows = request.messages as any[];
  assert.equal(rows[0].role, "system");
  assert.equal(rows[2].tool_calls[0].id, rows[3].tool_call_id);
  assert.equal(rows[3].content, "已完成工具结果");
});
test("DSH 结束原因真实映射，不完整文本有 block-end", async () => {
  let captured: any;
  const source: RouterSource = {
    models: () => [
      {
        id: "m",
        name: "m",
        source: "workbuddy",
        cost: "free",
        contextWindow: 32000,
        tools: true,
        images: false,
        reasoning: false,
      },
    ],
    prepare: async () => ({
      async *run() {
        yield { type: "text", text: "已有回答" };
        yield { type: "finish", result: { state: "disconnected", tools: 0 } };
      },
    }),
  };
  const adapter = new RouterAdapter(
    source,
    ROUTES.workbuddy,
    () => 16000,
    (_o, r) => {
      captured = r;
    },
  );
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.stream({
    provider: ROUTES.workbuddy,
    model: "m",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  }))
    chunks.push(chunk);
  assert.equal(chunks.at(-1)?.type, "finish");
  assert.deepEqual(
    chunks.find((c) => c.type === "block-end"),
    { type: "block-end", index: 0, block: { type: "text", text: "已有回答" } },
  );
  assert.equal(captured.state, "disconnected");
  assert.equal(
    (await adapter.resolveModel(ROUTES.workbuddy, "m")).context?.contextWindow,
    16000,
  );
  assert.equal(adapter.providerRetryPolicy().mode, "normal");
});

test("上游确认超限映射原生压缩错误，渠道拒绝给出准确提示且不重试", async () => {
  for (const code of ["CONTEXT_OVERFLOW", "UPSTREAM_CHANNEL_REJECT"]) {
    let calls = 0;
    const adapter = new RouterAdapter({
      models: () => [{ id: "m", name: "M", source: "workbuddy", cost: "free", contextWindow: 32000, tools: false, images: false, reasoning: false }],
      prepare: async () => ({ async *run() {
        calls++;
        yield { type: "finish", result: { state: "refused", tools: 0, code } };
      } }),
    }, ROUTES.workbuddy, () => undefined, () => {});
    const chunks = [];
    for await (const chunk of adapter.stream({
      provider: ROUTES.workbuddy, model: "m", messages: [],
    })) chunks.push(chunk);
    const end = chunks.at(-1);
    assert.equal(end?.type, "finish");
    if (end?.type !== "finish" || end.reason.kind !== "error") assert.fail("expected error");
    assert.equal(end.reason.failure.code, code === "CONTEXT_OVERFLOW" ? "CONTEXT_WINDOW_EXCEEDED" : code);
    assert.equal(calls, 1);
    const policy = adapter.providerRetryPolicy();
    assert.equal(policy.mode, "normal");
    if (policy.mode === "normal") assert.equal(policy.maxRetries, 0);
  }
});
