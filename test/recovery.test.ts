import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextRecovery } from "../src/host/recovery.js";

test("仅摘要确认超限后在宿主空闲维护事务中压缩，保护系统和当前请求", async () => {
  let status: (event: any) => void = () => {};
  const controller = new AbortController(), calls: number[][] = [], logs: any[] = [];
  const events = ["system", "user", "assistant", "user"].map((role, seq) => ({
    seq, type: "message", role,
  }));
  const session = {
    id: "session", surface: { nodes: [0, 1, 2, 3], replaceGeneration: 0 },
    eventAt: (seq: number) => events[seq],
    deriveEventMessage: (event: any) => ({ role: event.role, content: [] }),
  };
  let released = 0, total = 20000, maintenance = 0;
  const services = {
    tokenMeter: { measure: () => ({ totalTokens: total, nodes: events.map(e => ({ seq: e.seq, tokens: 1000 })) }) },
    sessionQuery: { observeSession: async () => ({ events, [Symbol.dispose]: () => released++ }) },
    compaction: { compactRegion: async (start: number, end: number, agent: any, signal: AbortSignal) => {
      assert.equal(agent.session, session);
      assert.equal(signal.aborted, false);
      calls.push([start, end]); total = 1000;
    } },
  };
  const agent = { session, runMaintenance: async (run: (signal: AbortSignal) => Promise<void>) => {
    maintenance++; await run(controller.signal);
  } };
  const recovery = new ContextRecovery({
    on: (_name: string, callback: typeof status) => { status = callback; },
    get: (name: keyof typeof services) => services[name],
  } as any, { append: async (entry: any) => { logs.push(entry); } } as any, controller.signal);
  const options = { sessionId: "session", provider: "connect-router-workbuddy", model: "m", messages: [] } as any;
  recovery.observe(options, { state: "refused", tools: 0, code: "CONTEXT_OVERFLOW" }, 32000);
  status({ agent, status: "idle" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maintenance, 0);
  recovery.observe({ ...options, purpose: "compaction" }, { state: "refused", tools: 0, code: "CONTEXT_OVERFLOW" }, 32000);
  status({ agent, status: "running" });
  assert.equal(maintenance, 0);
  status({ agent, status: "idle" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [[1, 1]]);
  assert.equal(released, 1);
  assert.equal(logs[0]?.code, "CONTEXT_COMPACTED");
  controller.abort();
  recovery.observe({ ...options, purpose: "compaction" }, { state: "refused", tools: 0, code: "CONTEXT_OVERFLOW" }, 32000);
  status({ agent, status: "idle" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(logs.at(-1)?.code, "COMPACTION_STOPPED");
});
