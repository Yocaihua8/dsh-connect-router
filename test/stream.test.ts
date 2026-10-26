import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChatStream, readSse } from "../src/host/stream.js";
const encode = new TextEncoder();
const signal = () => new AbortController().signal;
const packet = (delta: unknown, finish_reason?: string) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;
function body(text: string, fail = false) {
  const bytes = encode.encode(text);
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < bytes.length) c.enqueue(bytes.slice(i, ++i));
      else if (fail) c.error(new Error("socket reset"));
      else c.close();
    },
  });
}
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}
async function parse(text: string, fail = false) {
  return collect(
    parseChatStream(
      body(text, fail),
      [{ name: "read", validate: (v) => (v as any)?.path === "a" }],
      signal(),
    ),
  );
}
test("中文跨字节 + CRLF 半帧 + 无换行末帧", async () => {
  const r = await parse(
    packet({ content: "你好" }) + packet({}, "stop") + "data: [DONE]",
  );
  assert.equal(r[0]?.type, "text");
  assert.equal(
    r
      .filter((e) => e.type === "text")
      .map((e) => (e as any).text)
      .join(""),
    "你好",
  );
  assert.equal((r.at(-1) as any).result.state, "complete");
});
test("读流错误保留部分文本且不补发成功", async () => {
  const r = await parse(packet({ content: "保留" }), true);
  assert.equal((r[0] as any).text, "保留");
  assert.equal((r.at(-1) as any).result.state, "disconnected");
});
test("缺少 finish 或 DONE 都不报告成功", async () => {
  for (const t of [
    packet({ content: "x" }) + "data: [DONE]",
    packet({ content: "x" }) + packet({}, "stop"),
  ]) {
    const final = (await parse(t)).at(-1);
    assert.equal(final?.type, "finish");
    if (final?.type === "finish")
      assert.equal(final.result.state, "disconnected");
  }
});
test("工具参数截断不会释放工具", async () => {
  const r = await parse(
    packet({
      tool_calls: [
        {
          index: 0,
          id: "t",
          function: { name: "read", arguments: '{"path":' },
        },
      ],
    }) +
      packet({}, "tool_calls") +
      "data: [DONE]",
  );
  assert.equal(
    r.some((e) => e.type === "tool"),
    false,
  );
  assert.equal((r.at(-1) as any).result.state, "invalid");
});
test("完整合法的工具参数只释放一次", async () => {
  const r = await parse(
    packet({
      tool_calls: [
        {
          index: 0,
          id: "t",
          function: { name: "read", arguments: '{"path":' },
        },
      ],
    }) +
      packet({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }) +
      packet({}, "tool_calls") +
      "data: [DONE]",
  );
  assert.equal(r.filter((e) => e.type === "tool").length, 1);
  assert.equal((r.at(-1) as any).result.state, "complete");
});
test("长度限制保留内容但不执行工具", async () => {
  const r = await parse(
    packet({ content: "未完" }) + packet({}, "length") + "data: [DONE]",
  );
  assert.equal((r.at(-1) as any).result.state, "length");
});
test("取消中止挂起的 read", async () => {
  const c = new AbortController();
  const b = new ReadableStream<Uint8Array>({
    start(x) {
      x.enqueue(encode.encode(packet({ content: "a" })));
    },
  });
  const events = parseChatStream(b, [], c.signal);
  assert.equal((await events.next()).value.type, "text");
  const next = events.next();
  c.abort();
  assert.equal((await next).value.result.state, "cancelled");
});
test("timeout 与取消分开报告", async () => {
  const c = new AbortController();
  c.abort(new DOMException("timeout", "TimeoutError"));
  const r = await collect(parseChatStream(body(""), [], c.signal));
  assert.equal((r.at(-1) as any).result.state, "timeout");
});
test("SSE 注释不作为数据", async () =>
  assert.deepEqual(
    await collect(readSse(body(": ping\n\ndata: ok"), signal())),
    ["ok"],
  ));

test("未接入的原生输出不得丢弃后报告成功", async () => {
  for (const delta of [
    { content: [{ type: "image", data: "x" }] },
    { audio: { data: "x" } },
    { images: ["x"] },
  ]) {
    const result = await parse(
      packet(delta) + packet({}, "stop") + "data: [DONE]",
    );
    assert.equal((result.at(-1) as any).result.state, "invalid");
  }
});
