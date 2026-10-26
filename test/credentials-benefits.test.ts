import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkBuddyCredentials } from "../src/host/workbuddy/credentials.js";
import {
  Benefits,
  checkinDay,
  type BenefitLedger,
} from "../src/host/benefits.js";
import type { Receipt } from "../src/shared/types.js";
test("并发刷新单飞且轮换凭据由存储锁写入", async () => {
  let stored: any = {
    accessToken: "old",
    refreshToken: "r1",
    domain: "codebuddy.cn",
    uid: "owner",
    expiresAtMs: 100,
  };
  let refreshes = 0;
  const vault = new WorkBuddyCredentials(
    {
      read: async () => stored,
      modify: async (fn) => (stored = await fn(stored)),
      remove: async () => {
        stored = undefined;
      },
    },
    async () => {
      refreshes++;
      await new Promise((r) => setTimeout(r, 10));
      return { accessToken: "new", refreshToken: "r2", expiresInSec: 3600 };
    },
    () => 1000,
  );
  await Promise.all(Array.from({ length: 12 }, () => vault.resolve()));
  assert.equal(refreshes, 1);
  assert.equal(stored.refreshToken, "r2");
  assert.equal("accessToken" in (await vault.status()), false);
});
function ledger(): BenefitLedger {
  const data = new Map<string, Receipt>();
  let queue = Promise.resolve();
  return {
    exclusive(key, fn) {
      const run = queue.then(() =>
        fn(data.get(key), async (value) => {
          data.set(key, value);
        }),
      );
      queue = run.then(
        () => {},
        () => {},
      );
      return run;
    },
  };
}
test("同账号同天并发签到只提交一次并核对", async () => {
  let claims = 0;
  let claimed = false;
  const b = new Benefits(ledger());
  const api = {
    status: async (id: string) => ({ id, eligible: true, claimed }),
    claim: async () => {
      claims++;
      claimed = true;
    },
  };
  const key = "checkin:" + checkinDay(Date.UTC(2026, 9, 26), "cn");
  const result = await Promise.all(
    Array.from({ length: 8 }, () =>
      b.claim("owner", key, api, new AbortController().signal),
    ),
  );
  assert.equal(claims, 1);
  assert.ok(result.every((r) => r.state === "confirmed"));
});
test("结果不明确持久记为 pending，下次不重复领取", async () => {
  let calls = 0;
  const b = new Benefits(ledger());
  const api = {
    status: async (id: string) => ({ id, eligible: true, claimed: false }),
    claim: async () => {
      calls++;
      throw new Error("connection lost");
    },
  };
  assert.equal(
    (await b.claim("u", "gift", api, new AbortController().signal)).state,
    "pending",
  );
  await b.claim("u", "gift", api, new AbortController().signal);
  assert.equal(calls, 1);
});
test("企业账号不提交个人福利", async () => {
  let claims = 0;
  const b = new Benefits(ledger());
  const r = await b.claim(
    "enterprise",
    "gift",
    {
      status: async (id) => ({
        id,
        eligible: false,
        claimed: false,
        unsupported: true,
      }),
      claim: async () => {
        claims++;
      },
    },
    new AbortController().signal,
  );
  assert.equal(r.state, "unsupported");
  assert.equal(claims, 0);
});
test("领取当前可领项逐项查询并串行，不提前批量信任资格", async () => {
  const order: string[] = [];
  const claimed = new Set();
  const b = new Benefits(ledger());
  await b.claimAll(
    "u",
    ["a", "b"],
    {
      status: async (id) => {
        order.push("query:" + id);
        return { id, eligible: true, claimed: claimed.has(id) };
      },
      claim: async (id) => {
        order.push("claim:" + id);
        claimed.add(id);
      },
    },
    new AbortController().signal,
  );
  assert.deepEqual(order, [
    "query:a",
    "claim:a",
    "query:a",
    "query:b",
    "claim:b",
    "query:b",
  ]);
});
test("签到按 CN 上游时区，不以机器本地日划分", () => {
  assert.equal(checkinDay(Date.UTC(2026, 9, 25, 16, 1), "cn"), "2026-10-26");
  assert.throws(() => checkinDay(Date.now(), "global"), /UPSTREAM_DAY_UNKNOWN/);
});
