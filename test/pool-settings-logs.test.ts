import { groupKey } from "../src/shared/groups.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountSnapshot, RouterModel } from "../src/shared/types.js";
import { rankAccounts, PoolSource, type PoolMember } from "../src/host/pool.js";
import { RouterLogs, sanitizeLog } from "../src/host/logs.js";
import { settingsFor, configuredModel } from "../src/host/model-settings.js";
import {
  RouterStore,
  validateAccounts,
  validateSettings,
  DEFAULT_SETTINGS,
} from "../src/host/store.js";
import { requestBody, RouterAdapter, ROUTES } from "../src/host/adapter.js";
import { Accounts, maskLabel } from "../src/host/accounts.js";
import {
  parseUpstreamModel,
  WorkBuddyUpstreamClient,
} from "../src/host/workbuddy/vendor/upstream.js";
import { opencodeModels } from "../src/host/catalog.js";
const model: RouterModel = {
  id: "cn/m",
  upstreamId: "m",
  source: "workbuddy",
  name: "M",
  cost: "free",
  contextWindow: 64000,
  tools: true,
  images: true,
  reasoning: true,
  reasoningCanDisable: true,
};
const account = (id: string): AccountSnapshot => ({
  id,
  source: "workbuddy",
  service: "workbuddy",
  region: "cn",
  label: id,
  enabled: true,
  status: "ready",
  models: [{ ...model }],
  quota: [],
  updatedAt: Date.now(),
});
const requirement = {
  model: model.id,
  tools: false,
  images: false,
  costs: ["free", "credits"],
  window: 32000,
};
test("账号优先临期赠送，同单位已知余额才比较，未知不当零", () => {
  const a = account("a"),
    b = account("b"),
    c = account("c"),
    now = Date.now();
  a.quota = [{ kind: "gift", remaining: 1000, unit: "credits" }];
  b.quota = [
    { kind: "gift", remaining: 5, expiresAt: now + 1000, unit: "credits" },
  ];
  c.lastUsed = 1;
  assert.equal(rankAccounts([a, b, c], requirement)[0]?.id, "b");
  b.quota = [{ kind: "unknown", unit: "USD" }];
  a.lastUsed = 100;
  assert.equal(rankAccounts([a, b], requirement)[0]?.id, "b");
});
test("失效、禁用、能力/窗口不足、未知费用和付费路线不进入默认池", () => {
  const rows = [
    account("disabled"),
    account("expired"),
    account("small"),
    account("image"),
    account("paid"),
    account("unknown"),
    account("ok"),
  ];
  rows[0]!.enabled = false;
  rows[1]!.status = "auth-required";
  rows[2]!.models[0]!.contextWindow = 16000;
  rows[3]!.models[0]!.images = false;
  rows[4]!.models[0]!.cost = "paid";
  rows[5]!.models[0]!.cost = "unknown";
  assert.deepEqual(
    rankAccounts(rows, { ...requirement, images: true }).map((a) => a.id),
    ["ok"],
  );
  const credit = account("credit");
  credit.models[0]!.cost = "credits";
  assert.equal(rankAccounts([credit], requirement).length, 0);
  credit.quota = [{ kind: "gift", unit: "credits", remaining: 10 }];
  assert.equal(rankAccounts([credit], requirement).length, 1);
});
test("同轮工具往返绑定账号，后续新轮重新分配，失败不换号", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-pool-"));
  const used: string[] = [];
  const members: PoolMember[] = [account("a"), account("b")].map((state) => ({
    state,
    refresh: async () => {},
    source: {
      models: () => [model],
      prepare: async () => ({
        async *run() {
          used.push(state.id);
          yield { type: "finish", result: { state: "complete", tools: 0 } };
        },
      }),
    },
  }));
  const pool = new PoolSource(
    "workbuddy",
    () => members,
    () => ({ enabledModels: [model.id], autoCheckin: true }),
    new RouterLogs(directory),
  );
  const run = async (turnId: string) => {
    const call = await pool.prepare(model.id);
    for await (const _ of call.run(
      { messages: [] },
      [],
      new AbortController().signal,
      { sessionId: "s", turnId },
    )) {
    }
  };
  await run("1");
  await run("1");
  await run("2");
  assert.deepEqual(used, ["a", "a", "b"]);
  members[1]!.state.enabled = false;
  await assert.rejects(run("2"), /PINNED_ACCOUNT_UNAVAILABLE/u);
  assert.equal(used.length, 3);
});
test("并发新轮在同等余额时使用最近较少分配账号", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-concurrent-"));
  const used: string[] = [];
  const members: PoolMember[] = [account("a"), account("b")].map((state) => ({
    state,
    refresh: async () => {},
    source: {
      models: () => [model],
      prepare: async () => ({
        async *run() {
          used.push(state.id);
          yield { type: "finish", result: { state: "complete", tools: 0 } };
        },
      }),
    },
  }));
  const pool = new PoolSource(
    "workbuddy",
    () => members,
    () => ({ enabledModels: [model.id], autoCheckin: true }),
    new RouterLogs(directory),
  );
  await Promise.all(
    ["1", "2"].map(async (turnId) => {
      for await (const _ of (await pool.prepare(model.id)).run(
        { messages: [] },
        [],
        new AbortController().signal,
        { sessionId: "s", turnId },
      )) {
      }
    }),
  );
  assert.deepEqual(used.sort(), ["a", "b"]);
});
test("旧设置保留逐模型窗口；未知窗口不猜测，非法覆盖被拒绝", () => {
  const legacy = {
    enabledModels: ["m"],
    autoCheckin: true,
    contextBudget: 32000,
  };
  assert.equal(settingsFor(legacy, model).enabled, true);
  assert.deepEqual(settingsFor(legacy, model).context, {
    mode: "custom",
    tokens: 32000,
  });
  assert.deepEqual(
    settingsFor(legacy, { ...model, contextWindow: undefined }).context,
    { mode: "auto" },
  );
  const cfg = settingsFor(legacy, model);
  assert.throws(
    () => configuredModel({ ...model, contextWindow: 16000 }, cfg),
    /CONTEXT_LIMIT/u,
  );
  assert.throws(
    () =>
      configuredModel(
        { ...model, reasoningCanDisable: false },
        { ...cfg, capabilities: { reasoning: false } },
      ),
    /CANNOT_DISABLE/u,
  );
  const disabled = configuredModel(model, {
    ...cfg,
    capabilities: { tools: false, images: false, reasoning: false },
  });
  assert.equal(disabled.tools || disabled.images || disabled.reasoning, false);
  assert.throws(
    () =>
      validateSettings({
        ...DEFAULT_SETTINGS,
        workbuddy: {
          ...legacy,
          models: {
            m: {
              enabled: true,
              context: { mode: "custom", tokens: 10 },
              capabilities: {},
            },
          },
        },
      }),
    /INVALID_BUDGET/u,
  );
});
test("日志只存白名单字段，7 天及 10000 条轮转不触碰领取账本", async () => {
  const now = Date.now(),
    dir = await mkdtemp(join(tmpdir(), "router-log-")),
    logs = new RouterLogs(dir, () => now);
  const raw = {
    source: "workbuddy",
    account: "a",
    result: "failed",
    code: "https://example.com/?token=secret",
    prompt: "private",
    apiKey: "secret",
  } as any;
  const clean = JSON.stringify(sanitizeLog(raw, now));
  assert.ok(!clean.includes("private") && !clean.includes("secret"));
  await writeFile(
    join(dir, "logs.json"),
    JSON.stringify(
      Array.from({ length: 10002 }, (_, i) => ({
        ...sanitizeLog({ result: "complete" }, now),
        at: i === 0 ? now - 8 * 86400000 : now,
      })),
    ),
  );
  await logs.append(raw);
  const persisted = JSON.parse(await readFile(join(dir, "logs.json"), "utf8"));
  assert.equal(persisted.length, 10000);
  assert.ok(persisted.every((x: any) => x.at === now));
  assert.equal((await logs.query({ result: "failed" })).items.length, 1);
});
test("原生图片请求保留顺序和历史引用，关闭能力不会发送图片", async () => {
  const image = { type: "image", attachment: { id: "fixture" } } as any;
  const options = {
    provider: ROUTES.workbuddy,
    model: "m",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "before" },
          image,
          { type: "text", text: "after" },
        ],
      },
    ],
  } as any;
  const before = JSON.stringify(options);
  const body = requestBody(
    options,
    new Map([[image, "data:image/png;base64,AA=="]]),
  );
  assert.deepEqual(
    (body.messages as any[])[0].content.map((p: any) => p.type),
    ["text", "image_url", "text"],
  );
  assert.equal(JSON.stringify(options), before);
  let sent = false;
  const adapter = new RouterAdapter(
    {
      models: () => [{ ...model, id: "m", images: false }],
      prepare: async () => ({
        async *run() {
          sent = true;
          yield { type: "finish", result: { state: "complete", tools: 0 } };
        },
      }),
    },
    ROUTES.workbuddy,
    () => undefined,
    () => {},
    async () => "data:image/png;base64,AA==",
  );
  await assert.rejects(async () => {
    for await (const _ of adapter.stream(options)) {
    }
  }, /IMAGES_NOT_SUPPORTED/u);
  assert.equal(sent, false);
});
test("目录保留未知窗口、停用模型与不支持的原生输出，Agent 接口明确不可用", () => {
  assert.equal(parseUpstreamModel({ id: "missing" })?.id, "missing");
  assert.equal(
    parseUpstreamModel({ id: "disabled", disabled: true })?.unavailable,
    "MODEL_DISABLED",
  );
  assert.equal(
    parseUpstreamModel({ id: "image", tags: ["text-to-image"] })?.unavailable,
    "AGENT_INTERFACE_NOT_INCLUDED",
  );
  const rows = opencodeModels({
    connected: [],
    all: [
      {
        id: "opencode",
        models: { m: { id: "m", capabilities: { output: { image: true } } } },
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.unavailable, "AUTH_REQUIRED");
  assert.deepEqual(rows[0]?.output, ["image"]);
});
test("账号元数据不接受任意路径，密钥只写 DSH 凭据服务且按账号隔离", async () => {
  assert.throws(
    () => validateAccounts([{ ...account("../escape") }]),
    /INVALID_ACCOUNT/u,
  );
  assert.equal(
    maskLabel("12345678901 a.person@mail.com"),
    "123****8901 a.***@mail.com",
  );
  const dir = await mkdtemp(join(tmpdir(), "router-accounts-")),
    values = new Map<string, any>();
  const ctx = {
    credentials: {
      readRecord: async (k: string) => values.get(k),
      modifyRecord: async (k: string, f: any) => {
        const r = await f(values.get(k));
        values.set(k, r);
        return r;
      },
      deleteRecord: async (k: string) => {
        values.delete(k);
      },
    },
  } as any;
  const store = new RouterStore(dir),
    accounts = new Accounts(
      ctx,
      store,
      new RouterLogs(dir),
      new AbortController().signal,
    );
  await accounts.initialize();
  const a = await accounts.add("opencode", "opencode", "A", "global"),
    b = await accounts.add("opencode", "opencode-go", "B", "global");
  await accounts.setKey(a, "private-key-a");
  await accounts.setKey(b, "private-key-b");
  assert.equal(values.size, 2);
  assert.ok(!JSON.stringify(accounts.snapshot()).includes("private-key"));
  assert.ok(
    !(await readFile(join(dir, "accounts.json"), "utf8")).includes(
      "private-key",
    ),
  );
  await accounts.remove(a);
  assert.equal(values.size, 1);
  assert.ok(JSON.stringify([...values.values()]).includes("private-key-b"));
});

test("请求绑定重启后保留，续写固定原账号，并发同轮不改变绑定", async () => {
  const { RequestBindings } = await import("../src/host/bindings.js");
  const directory = await mkdtemp(join(tmpdir(), "router-bindings-"));
  const a = new RequestBindings(directory),
    b = new RequestBindings(directory);
  const results = await Promise.all([
    a.assign("turn-1", "session-m", false, "account-a"),
    b.assign("turn-1", "session-m", false, "account-b"),
  ]);
  assert.equal(results[0]?.account, results[1]?.account);
  const restarted = new RequestBindings(directory);
  assert.equal(
    (await restarted.assign("turn-2", "session-m", true, "account-c"))?.account,
    results[0]?.account,
  );
  assert.equal(
    await restarted.assign("unknown", "missing-session", true, "account-c"),
    undefined,
  );
});
test("相同毫秒的日志可按游标完整分页", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-pages-"));
  const logs = new RouterLogs(directory, () => 100000);
  for (let i = 0; i < 3; i++)
    await logs.append({ source: "opencode", result: "success" });
  const first = await logs.query({ limit: 2 });
  const last = await logs.query({ limit: 2, cursor: first.nextCursor });
  assert.equal(first.items.length, 2);
  assert.equal(last.items.length, 1);
  assert.equal(
    new Set([...first.items, ...last.items].map((i) => i.id)).size,
    3,
  );
});

test("标题不覆盖主请求绑定，摘要继承原账号，重启续写仍保持一致", async () => {
  const { RequestBindings } = await import("../src/host/bindings.js");
  const directory = await mkdtemp(join(tmpdir(), "router-maintenance-binding-"));
  const bindings = new RequestBindings(directory);
  await bindings.assign("main-turn", "session-m", false, "account-a");
  await bindings.assign("title-turn", "session-m", false, "account-b", { updateLatest: false });
  assert.equal((await bindings.assign("summary-turn", "session-m", false, "account-c", {
    inheritLatest: true, updateLatest: false,
  }))?.account, "account-a");
  assert.equal((await new RequestBindings(directory).assign("continue-turn", "session-m", true, "account-d"))?.account, "account-a");
});
test("一个模型上限失效不阻塞其他目录，推理能力按分配账号核对", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-limits-"));
  const a = account("a");
  a.models = [
    { ...model, contextWindow: undefined },
    { ...model, id: "cn/other", upstreamId: "other", name: "Other", reasoning: false },
  ];
  const pool = new PoolSource(
    "workbuddy",
    () => [{ state: a, source: {} as any, refresh: async () => {} }],
    () => ({
      enabledModels: [],
      autoCheckin: true,
      models: {
        [model.id]: {
          enabled: true,
          context: { mode: "custom", tokens: 64000 },
          capabilities: {},
        },
        "cn/other": {
          enabled: true,
          context: { mode: "auto" },
          capabilities: {},
        },
      },
    }),
    new RouterLogs(directory),
  );
  assert.deepEqual(
    pool.models().map((m) => m.id),
    [groupKey(a.models[1]!)],
  );
  assert.equal(
    rankAccounts([a], { ...requirement, model: "cn/other", reasoning: true })
      .length,
    0,
  );
});
