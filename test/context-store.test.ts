import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextRescue } from "../src/host/workbuddy/vendor/context-rescue.js";
import { RouterStore, DEFAULT_SETTINGS } from "../src/host/store.js";
import { Benefits } from "../src/host/benefits.js";
test("分块压缩保护末尾当前请求，摘要再次超限时缩小范围", async () => {
  let total = 1500;
  const ranges: number[][] = [];
  const rescue = createContextRescue(() => ({
    agents: { get: () => ({ session: { id: "s" } }) },
    meter: {
      measure: () => ({
        totalTokens: total,
        nodes: [
          { seq: 1, tokens: 100 },
          { seq: 2, tokens: 100 },
          { seq: 3, tokens: 100 },
          { seq: 4, tokens: 100 },
        ],
      }),
    },
    compactable: (_s, n) => n.slice(0, -1),
    canShrink: (e) => e === "SUMMARY_OVERFLOW",
    compaction: {
      compactRegion: async (start, end) => {
        ranges.push([start, end]);
        if (end > 1) throw "SUMMARY_OVERFLOW";
        total = 500;
      },
    },
  }));
  assert.equal(await rescue.rescue("s", 1000), true);
  assert.deepEqual(ranges, [
    [1, 3],
    [1, 2],
    [1, 1],
  ]);
});
test("取消贯穿已启动压缩事务", async () => {
  const c = new AbortController();
  const rescue = createContextRescue(() => ({
    agents: { get: () => ({ session: {} }) },
    meter: {
      measure: () => ({ totalTokens: 1500, nodes: [{ seq: 1, tokens: 100 }] }),
    },
    compactable: (_s, n) => n,
    compaction: {
      compactRegion: async (_a, _b, _c, signal) => {
        c.abort();
        signal?.throwIfAborted();
      },
    },
  }));
  await assert.rejects(() => rescue.rescue("s", 1000, c.signal), {
    name: "AbortError",
  });
});
test("单条超大消息和无法确认保护范围时不压缩", async () => {
  let calls = 0;
  const base = {
    agents: { get: () => ({ session: {} }) },
    meter: {
      measure: () => ({ totalTokens: 9000, nodes: [{ seq: 1, tokens: 9000 }] }),
    },
    compaction: {
      compactRegion: async () => {
        calls++;
      },
    },
  };
  assert.equal(await createContextRescue(() => base).rescue("s", 1000), false);
  assert.equal(
    await createContextRescue(() => ({
      ...base,
      compactable: (_s, n) => n,
    })).rescue("s", 1000),
    false,
  );
  assert.equal(calls, 0);
});
test("压缩无进展只进行一轮", async () => {
  let calls = 0;
  const rescue = createContextRescue(() => ({
    agents: { get: () => ({ session: {} }) },
    meter: {
      measure: () => ({ totalTokens: 2000, nodes: [{ seq: 1, tokens: 100 }] }),
    },
    compactable: (_s, n) => n,
    compaction: {
      compactRegion: async () => {
        calls++;
      },
    },
  }));
  await rescue.rescue("s", 1000);
  assert.equal(calls, 1);
});
test("存储重建后仍保护 pending 领取，设置草稿不写入存储", async () => {
  const dir = await mkdtemp(join(tmpdir(), "router-test-"));
  const first = new RouterStore(dir);
  await first.saveSettings(DEFAULT_SETTINGS);
  const draft = await first.readSettings();
  draft.workbuddy.enabledModels.push("changed");
  assert.deepEqual((await first.readSettings()).workbuddy.enabledModels, []);
  let calls = 0;
  const api = {
    status: async (id: string) => ({ id, eligible: true, claimed: false }),
    claim: async () => {
      calls++;
    },
  };
  await new Benefits(first).claim(
    "owner",
    "gift",
    api,
    new AbortController().signal,
  );
  await new Benefits(new RouterStore(dir)).claim(
    "owner",
    "gift",
    api,
    new AbortController().signal,
  );
  assert.equal(calls, 1);
  assert.ok(
    (await readFile(join(dir, "settings.json"), "utf8")).includes("workbuddy"),
  );
});
