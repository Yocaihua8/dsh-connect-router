import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-token-meter";
import type {} from "@deepseek-ai/dsh-session-query";
import { SessionId, SessionSeq, type Session } from "@deepseek-ai/dsh-session";
import {
  toolPairingBalancedBefore,
  toolPairingBalancedAfter,
} from "@deepseek-ai/dsh-compaction";
import type { GenerateOptions } from "@deepseek-ai/dsh-llm";
import { createContextRescue } from "./workbuddy/vendor/context-rescue.js";
import type { RouterLogs } from "./logs.js";
import type { StreamFinish } from "../shared/types.js";

/** Runs only after a provider-confirmed summary overflow, once its transaction has settled. */
export class ContextRecovery {
  private pending = new Map<
    string,
    { window: number; provider: string; model: string }
  >();
  private active = new Set<string>();
  constructor(
    private ctx: Context,
    private logs: RouterLogs,
    private signal: AbortSignal,
  ) {
    ctx.on("agent/status", ({ agent, status }) => {
      const id = agent.session.id,
        request = this.pending.get(id);
      if (status !== "idle" || !request || this.active.has(id)) return;
      this.pending.delete(id);
      this.active.add(id);
      void Promise.resolve()
        .then(() =>
          agent.runMaintenance(async (maintenance) => {
            const signal = AbortSignal.any([maintenance, this.signal]);
            const meter = this.ctx.get("tokenMeter"),
              compaction = this.ctx.get("compaction"),
              query = this.ctx.get("sessionQuery");
            if (!meter || !compaction || !query)
              throw new Error("COMPACTION_SERVICE_UNAVAILABLE");
            const rescue = createContextRescue(() => ({
              agents: {
                get: (id) => (id === agent.session.id ? agent : undefined),
              },
              meter: {
                measure: (session) => meter.measure(session as Session),
              },
              compaction: {
                compactRegion: async (start, end) => {
                  if (
                    !toolPairingBalancedBefore(
                      agent.session,
                      SessionSeq(start),
                    ) ||
                    !toolPairingBalancedAfter(agent.session, SessionSeq(end))
                  )
                    throw new Error("ROUTER_UNBALANCED_RANGE");
                  return compaction.compactRegion(
                    SessionSeq(start),
                    SessionSeq(end),
                    agent,
                    signal,
                  );
                },
              },
              compactable: async (_session, nodes) => {
                const observation = await query.observeSession(SessionId(id), {
                  signal,
                  projectionMode: "none",
                });
                try {
                  const events = new Map(
                    observation.events.map((e) => [Number(e.seq), e]),
                  );
                  const rows = nodes.map((n) => ({
                    node: n,
                    message: events.has(n.seq)
                      ? agent.session.deriveEventMessage(events.get(n.seq)!)
                      : null,
                  }));
                  let latestUser = -1;
                  rows.forEach((r, i) => {
                    if (r.message?.role === "user") latestUser = i;
                  });
                  if (latestUser < 1) return [];
                  const safe = [];
                  for (const row of rows.slice(0, latestUser)) {
                    if (
                      !row.message ||
                      row.message.role === "system" ||
                      row.message.role === "developer"
                    ) {
                      if (safe.length) break;
                      continue;
                    }
                    safe.push(row.node);
                  }
                  return safe;
                } finally {
                  observation[Symbol.dispose]();
                }
              },
              canShrink: (error) => {
                let current = error;
                for (
                  let depth = 0;
                  depth < 6 && current && typeof current === "object";
                  depth++
                ) {
                  const e = current as {
                    code?: string;
                    message?: string;
                    cause?: unknown;
                  };
                  if (
                    e.code === "CONTEXT_WINDOW_EXCEEDED" ||
                    e.message === "ROUTER_UNBALANCED_RANGE"
                  )
                    return true;
                  current = e.cause;
                }
                return false;
              },
            }));
            const changed = await rescue.rescue(id, request.window, signal);
            await this.logs.append({
              source: request.provider.endsWith("workbuddy")
                ? "workbuddy"
                : "opencode",
              model: request.model,
              result: changed ? "success" : "failed",
              code: changed ? "CONTEXT_COMPACTED" : "COMPACTION_NO_PROGRESS",
            });
          }),
        )
        .catch(() =>
          this.logs
            .append({
              source: request.provider.endsWith("workbuddy")
                ? "workbuddy"
                : "opencode",
              model: request.model,
              result: "failed",
              code: "COMPACTION_STOPPED",
            })
            .catch(() => {}),
        )
        .finally(() => this.active.delete(id));
    });
  }
  observe(options: GenerateOptions, result: StreamFinish, window?: number) {
    if (
      options.purpose === "compaction" &&
      options.sessionId &&
      window &&
      result.code === "CONTEXT_OVERFLOW" &&
      !this.active.has(options.sessionId)
    ) {
      if (this.pending.size < 500)
        this.pending.set(options.sessionId, {
          window,
          provider: options.provider,
          model: options.model,
        });
    }
  }
}
