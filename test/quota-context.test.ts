import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeQuota } from "../src/client/quota.js";
import {
  contextOptions,
  formatTokens,
  contextError,
} from "../src/client/controller.js";
test("quota combines categories of one unit, excludes expired buckets", () => {
  const q = summarizeQuota(
    [
      { kind: "gift", unit: "credits", remaining: 20, total: 100 },
      { kind: "gift", unit: "credits", remaining: 10, total: 20 },
      { kind: "paid", unit: "credits", remaining: 40, total: 50 },
      {
        kind: "gift",
        unit: "credits",
        remaining: 999,
        total: 999,
        expiresAt: 10,
      },
      { kind: "paid", unit: "USD", remaining: 30, total: 30 },
    ],
    "credits",
    20,
  );
  assert.equal(q.known, 70);
  assert.equal(q.total, 170);
  assert.equal(q.groups.length, 2);
  assert.equal(q.expired, 1);
});
test("unknown/invalid quota never becomes zero usage or a fake percentage", () => {
  const q = summarizeQuota(
    [
      { kind: "gift", unit: "c", remaining: 10 },
      { kind: "subscription", unit: "c", total: 100 },
    ],
    "c",
  );
  assert.equal(q.known, 10);
  assert.equal(q.unknown, true);
  assert.equal(q.knownCount, 1);
  const missing = summarizeQuota([{ kind: "unknown", unit: "c" }], "c");
  assert.equal(missing.knownCount, 0);
  assert.equal(missing.unknown, true);
  assert.equal(q.total, undefined);
  assert.equal(q.proportional, false);
  assert.equal(
    summarizeQuota([{ kind: "gift", unit: "c", remaining: 20, total: 10 }], "c")
      .proportional,
    false,
  );
});
test("context presets retain actual maximum and never invent 1M support", () => {
  assert.deepEqual(contextOptions(undefined), []);
  assert.equal(contextOptions(256000).at(-1), 256000);
  assert.deepEqual(contextOptions(960000).slice(-2), [512000, 960000]);
  assert.equal(contextOptions(1000000).filter((n) => n === 1000000).length, 1);
  assert.equal(formatTokens(1000000), "1M");
  assert.equal(formatTokens(960000), "960K");
  assert.equal(formatTokens(1048576), "1,048,576");
});
