import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitHubFeedback,
  makeReport,
  redactFeedback,
} from "../src/host/feedback.js";
import type { DiagnosticBundle } from "../src/shared/types.js";
import ConnectRouter from "../src/host/service.js";
const bundle: DiagnosticBundle = {
  schema: 1,
  pluginVersion: "test",
  targetDshVersion: "0.2.1-rc.3",
  platform: "win32",
  nodeVersion: "24",
  generatedAt: "",
  accounts: [],
  page: { items: [] },
};
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
test("group and route diagnostics decode before redaction and never expose account identity", () => {
  const data = structuredClone(bundle);
  data.page.items = [{ id: "test", at: 0, source: "workbuddy", kind: "request", result: "refused", account: "private-id", model: "cn/m", group: `group:${encodeURIComponent('["workbuddy","workbuddy","cn","a@example.com"]')}`, route: `route:${encodeURIComponent('["https://example.com/?token=secret"]')}`, reason: "free-first", stage: "response", suggestion: "" }];
  const report = makeReport(data, "test", "synthetic");
  assert.doesNotMatch(report.body, /a@example|example\.com|secret|private-id|%40/);
  assert.match(report.body, /free-first/);
  assert.match(report.body, /cn\/m/);
});
async function setup(
  request: typeof fetch,
  initial: unknown = {
    accessToken: "secret",
    login: "owner",
    expiresAt: Date.now() + 3600000,
  },
  now = Date.now,
) {
  const dir = await mkdtemp(join(tmpdir(), "router-feedback-"));
  let value = initial;
  const store = {
    read: async () => value,
    modify: async (fn: (x: unknown) => Promise<unknown>) =>
      (value = await fn(value)),
    remove: async () => {
      value = undefined;
    },
  };
  return {
    api: new GitHubFeedback(dir, store, request, "test-client", now),
    store,
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
test("public report excludes identities, bodies and credentials, aliases accounts, caps whole records", () => {
  const data = structuredClone(bundle);
  data.page.items = Array.from({ length: 50 }, (_, i) => ({
    id: String(i),
    at: 0,
    kind: "request",
    source: "workbuddy",
    account: "private-account",
    model: "cn/model",
    result: "refused",
    stage: "response",
    suggestion: "x".repeat(2000),
    code: "A".repeat(1000),
  }));
  const report = makeReport(
    data,
    "bug",
    "email a@example.com https://a.test?token=secret C:\\Users\\Bob\\test\nBearer abc ghp_ABCDEFG sk-foobar",
  );
  assert.ok(Buffer.byteLength(report.body) <= 48 * 1024);
  for (const secret of [
    "private-account",
    "a@example.com",
    "secret",
    "Bob",
    "ABCDEFG",
    "foobar",
    "Bearer abc",
  ])
    assert.ok(!report.body.includes(secret), secret);
  assert.match(report.body, /账号 1/);
  assert.match(report.body, /省略 [1-9]/);
  assert.ok(!redactFeedback("/home/bob/work/file").includes("bob"));
});
test("concurrent submits create only one issue; sent receipt survives restart", async () => {
  let calls = 0;
  const s = await setup(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 30));
    return reply({
      html_url: "https://github.com/Yocaihua8/dsh-connect-router/issues/1",
    });
  });
  try {
    const p = await s.api.preview(bundle, "bug", "");
    await Promise.all([
      s.api.submit(p.id, new AbortController().signal),
      s.api.submit(p.id, new AbortController().signal),
    ]);
    assert.equal(calls, 1);
    assert.equal(
      (await s.api.result(p.id, new AbortController().signal)).state,
      "sent",
    );
  } finally {
    await s.cleanup();
  }
});
test("ambiguous transport failure stays pending across restart; read-only reconciliation never resends", async () => {
  let posts = 0,
    body = "";
  const request: typeof fetch = async (_url, init) => {
    if (init?.method === "POST") {
      posts++;
      body = JSON.parse(init.body as string).body;
      throw new Error("network");
    }
    return reply([
      {
        body,
        html_url: "https://github.com/Yocaihua8/dsh-connect-router/issues/2",
      },
    ]);
  };
  const s = await setup(request);
  try {
    const p = await s.api.preview(bundle, "bug", "");
    assert.equal(
      (await s.api.submit(p.id, new AbortController().signal)).state,
      "pending",
    );
    const restarted = new GitHubFeedback(
      s.dir,
      s.store,
      request,
      "test-client",
    );
    assert.equal((await restarted.pending())?.id, p.id);
    await restarted.submit(p.id, new AbortController().signal);
    assert.equal(posts, 1);
    assert.equal(
      (await restarted.result(p.id, new AbortController().signal)).state,
      "sent",
    );
  } finally {
    await s.cleanup();
  }
});
test("explicit permission/rate rejection is reported, never an automatic retry", async () => {
  for (const status of [401, 403, 410, 422, 429]) {
    let calls = 0;
    const s = await setup(async () => {
      calls++;
      return reply({}, status);
    });
    try {
      const p = await s.api.preview(bundle, "bug", "");
      assert.equal(
        (await s.api.submit(p.id, new AbortController().signal)).state,
        "failed",
      );
      await s.api.submit(p.id, new AbortController().signal);
      assert.equal(calls, 1);
    } finally {
      await s.cleanup();
    }
  }
});
test("device authorization honors interval/slow_down, cancellation and official URL", async () => {
  let clock = 1000,
    calls = 0;
  const s = await setup(
    async (url) => {
      calls++;
      return String(url).endsWith("/device/code")
        ? reply({
            device_code: "device",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          })
        : reply({ error: "slow_down" });
    },
    undefined,
    () => clock,
  );
  try {
    const l = await s.api.start(new AbortController().signal);
    assert.equal(await s.api.poll(l.id, new AbortController().signal), false);
    assert.equal(calls, 1);
    clock += 5000;
    await s.api.poll(l.id, new AbortController().signal);
    clock += 5000;
    await s.api.poll(l.id, new AbortController().signal);
    assert.equal(calls, 2);
    s.api.cancel(l.id);
    await assert.rejects(
      s.api.poll(l.id, new AbortController().signal),
      /EXPIRED/,
    );
  } finally {
    await s.cleanup();
  }
});
test("expired grants refresh once for concurrent callers without a client secret", async () => {
  let refreshes = 0;
  const s = await setup(
    async (url, init) => {
      if (String(url).includes("access_token")) {
        refreshes++;
        assert.ok(!(init?.body as string).includes("client_secret"));
        return reply({
          access_token: "new",
          refresh_token: "rotated",
          expires_in: 3600,
        });
      }
      return reply({
        html_url: "https://github.com/Yocaihua8/dsh-connect-router/issues/3",
      });
    },
    { accessToken: "old", refreshToken: "r", expiresAt: 0, login: "owner" },
  );
  try {
    const p = await s.api.preview(bundle, "bug", "");
    await Promise.all([
      s.api.submit(p.id, new AbortController().signal),
      s.api.submit(p.id, new AbortController().signal),
    ]);
    assert.equal(refreshes, 1);
  } finally {
    await s.cleanup();
  }
});
test("every feedback RPC fails closed for non-owner before touching credentials or reports", async () => {
  const proto = ConnectRouter.prototype as any;
  const context = {
    ctx: { invocation: { peer: { principal: { kind: "guest" } } } },
    ready: Promise.resolve(),
    guarded: proto.guarded,
  };
  for (const [method, args] of Object.entries({
    feedbackAuth: [],
    feedbackStartLogin: [],
    feedbackPollLogin: ["id"],
    feedbackCancelLogin: ["id"],
    feedbackDisconnect: [],
    previewFeedback: [{}, "title", "body"],
    submitFeedback: ["id"],
    feedbackResult: ["id"],
    pendingFeedback: [],
  })) {
    await assert.rejects(
      proto[method].apply(context, [...args, new AbortController().signal]),
      /OWNER_REQUIRED/,
      method,
    );
  }
});
test("device refusal, expiry and untrusted verification URL never store a grant", async () => {
  let clock = 1000;
  const device = {
    device_code: "device",
    user_code: "ABCD-EFGH",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
  };
  const s = await setup(
    async (url) =>
      reply(
        String(url).endsWith("/device/code")
          ? device
          : { error: "access_denied" },
      ),
    null,
    () => clock,
  );
  try {
    const d = await s.api.start(new AbortController().signal);
    clock += 5000;
    await assert.rejects(
      s.api.poll(d.id, new AbortController().signal),
      /DENIED/,
    );
    assert.equal((await s.api.status()).connected, false);
    const e = await s.api.start(new AbortController().signal);
    clock += 901000;
    await assert.rejects(
      s.api.poll(e.id, new AbortController().signal),
      /EXPIRED/,
    );
    device.verification_uri = "https://evil.example";
    await assert.rejects(s.api.start(new AbortController().signal), /INVALID/);
  } finally {
    await s.cleanup();
  }
});

test("network and timeout errors stay safe and an active device flow can recover", async () => {
  let time = 0, polls = 0;
  const s = await setup(async (url) => {
    if (String(url).endsWith('/login/device/code')) return reply({device_code:'device-secret',user_code:'TEST-CODE',verification_uri:'https://github.com/login/device',expires_in:900,interval:5});
    if (String(url).endsWith('/user')) return reply({login:'owner'});
    if (++polls === 1) throw new TypeError('network details with private URL');
    return reply({access_token:'secret',expires_in:3600});
  }, undefined, () => time);
  try {
    const login = await s.api.start(new AbortController().signal);
    time = 5000;
    await assert.rejects(s.api.poll(login.id,new AbortController().signal), /^Error: GITHUB_NETWORK_ERROR$/);
    time = 10000;
    assert.equal(await s.api.poll(login.id,new AbortController().signal), true);
    assert.equal((await s.api.status()).connected, true);
  } finally { await s.cleanup(); }
  const failure = await setup(async () => {throw new DOMException('private timeout detail','TimeoutError');});
  try {await assert.rejects(failure.api.start(new AbortController().signal), /^Error: GITHUB_TIMEOUT$/);} finally {await failure.cleanup();}
});
