import { test } from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "../src/host/opencode/vendor/bridge.js";
import { normalizeCatalog } from "../src/host/opencode/vendor/catalog.js";
import { Backend } from "../src/host/opencode/vendor/backend.js";
const model = {
  id: "m",
  providerID: "p",
  name: "m",
  toolCall: true,
  inputImage: false,
};
const request = {
  model: "p/m",
  messages: [{ role: "user", content: "hello" }],
};
const waitAbort = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
function backend(finish: unknown, parts: unknown[]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async createSession() {
      return { id: "s" };
    },
    async abortSession() {},
    async deleteSession() {},
    async *events() {},
    async sendMessage() {
      calls++;
      return { info: { finish }, parts };
    },
  };
}
test("OpenCode 未知费用不会误入免费列表", () => {
  const models = normalizeCatalog({
    connected: ["p"],
    all: [{ id: "p", models: { m: { id: "m" } } }],
  });
  assert.equal(models[0]?.free, false);
  assert.equal(models[0]?.priceKnown, false);
});
test("OpenCode 缺失结束证据不报告成功，也不隐藏重试", async () => {
  const b = backend(undefined, [{ type: "text", text: "partial" }]);
  const bridge = createBridge({
    backend: b,
    catalog: { current: () => [model] },
    log: () => {},
  });
  await assert.rejects(
    () => bridge.complete(request, new AbortController().signal),
    /complete response/,
  );
  assert.equal(b.calls, 1);
});
test("OpenCode 非法工具 envelope 只请求一次", async () => {
  const b = backend("stop", [{ type: "text", text: "not valid JSON" }]);
  const bridge = createBridge({
    backend: b,
    catalog: { current: () => [model] },
    log: () => {},
  });
  await assert.rejects(() =>
    bridge.complete(
      {
        ...request,
        tools: [
          {
            type: "function",
            function: { name: "read", parameters: { type: "object" } },
          },
        ],
      },
      new AbortController().signal,
    ),
  );
  assert.equal(b.calls, 1);
});
test("OpenCode 完整工具 envelope 转换保留声明的工具", async () => {
  const b = backend("stop", [
    {
      type: "text",
      text: JSON.stringify({
        content: "",
        calls: [{ name: "read", arguments: { path: "a" } }],
      }),
    },
  ]);
  const bridge = createBridge({
    backend: b,
    catalog: { current: () => [model] },
    log: () => {},
  });
  const result: any = await bridge.complete(
    {
      ...request,
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        },
      ],
    },
    new AbortController().signal,
  );
  assert.equal(result.choices[0].finish_reason, "tool_calls");
  assert.equal(result.choices[0].message.tool_calls[0].function.name, "read");
  assert.equal(b.calls, 1);
});

test("OpenCode 先订阅事件再发送；retry 会取消请求且不会再次调用", async () => {
  let ready = false,
    calls = 0,
    cancelled = false,
    deleted = 0;
  let release!: () => void;
  const sent = new Promise<void>((r) => {
    release = r;
  });
  const b = {
    async createSession() {
      return { id: "s" };
    },
    async abortSession() {},
    async deleteSession() {
      deleted++;
    },
    async *events(signal: AbortSignal, onReady: () => void) {
      await Promise.resolve();
      ready = true;
      onReady();
      await sent;
      yield {
        type: "session.status",
        properties: {
          sessionID: "s",
          status: {
            type: "retry",
            attempt: 1,
            message: "Free usage limit reached",
            next: Date.now() + 1000,
          },
        },
      };
      await waitAbort(signal);
    },
    async sendMessage(_id: string, _payload: unknown, signal: AbortSignal) {
      assert.equal(ready, true);
      calls++;
      release();
      await waitAbort(signal);
      cancelled = true;
      throw signal.reason;
    },
  };
  const bridge = createBridge({
    backend: b,
    catalog: { current: () => [model] },
  });
  await assert.rejects(
    async () => {
      for await (const _ of bridge.stream(request, AbortSignal.timeout(2000))) {
      }
    },
    (e: any) => e.code === "UPSTREAM_RETRY_STOPPED",
  );
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
  assert.equal(deleted, 1);
});

test("OpenCode 事件订阅失败时不发送请求", async () => {
  const b = backend("stop", []);
  b.events = async function* () {
    throw new Error("subscription failed");
  };
  const bridge = createBridge({
    backend: b,
    catalog: { current: () => [model] },
  });
  await assert.rejects(async () => {
    for await (const _ of bridge.stream(request, AbortSignal.timeout(2000))) {
    }
  }, /subscription failed/);
  assert.equal(b.calls, 0);
});

test("OpenCode SSE 支持中文半字节、CRLF、无换行尾帧，并拒绝损坏 JSON", async () => {
  const original = globalThis.fetch;
  let ready = false;
  try {
    const raw = new TextEncoder().encode(
      'data: {"text":"中文"}\r\n\r\ndata: {"tail":true}',
    );
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (const byte of raw) c.enqueue(Uint8Array.of(byte));
            c.close();
          },
        }),
      );
    const b = new Backend("http://127.0.0.1:1", "test-only");
    const events = [];
    for await (const e of b.events(new AbortController().signal, () => {
      ready = true;
    }))
      events.push(e);
    assert.equal(ready, true);
    assert.deepEqual(events, [{ text: "中文" }, { tail: true }]);
    globalThis.fetch = async () => new Response('data: {"broken":');
    await assert.rejects(
      async () => {
        for await (const _ of b.events(new AbortController().signal)) {
        }
      },
      (e: any) => e.code === "INVALID_PACKET",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("OpenCode 半截 envelope 只保留正文，中文转义和工具参数不混入正文", async () => {
  const { partialEnvelopeContent } = await import(
    "../src/host/opencode/vendor/protocol.js"
  );
  assert.equal(
    partialEnvelopeContent(
      '{"calls":[{"name":"x","arguments":{"content":"SECRET"}}],"content":"你好',
    ),
    "你好",
  );
  const text = JSON.stringify({
    content: "你好\n🙂结尾",
    calls: [{ name: "read", arguments: { path: "secret" } }],
  });
  for (let i = 0; i <= text.length; i++) {
    const partial = partialEnvelopeContent(text.slice(0, i));
    assert.ok("你好\n🙂结尾".startsWith(partial));
    assert.equal(partial.includes("secret"), false);
  }
  assert.equal(partialEnvelopeContent(text), "你好\n🙂结尾");
});
