import { randomUUID } from "node:crypto";
import type {
  AccountSnapshot,
  QuotaBucket,
  RouterModel,
  SourceId,
  SourceSettings,
} from "../shared/types.js";
import type { RouterSource, SourceCall, CallIdentity } from "./adapter.js";
import { configuredModel, settingsFor } from "./model-settings.js";
import type { RouterLogs } from "./logs.js";
import type { BindingPort } from "./bindings.js";
import { modelGroups, groupSettings, groupCandidates, configuredGroup, routeKey, feeOrder, groupKey } from "../shared/groups.js";

export interface PoolMember {
  state: AccountSnapshot;
  source: RouterSource;
  refresh(signal: AbortSignal): Promise<void>;
  syncCatalog?(): void;
}
export interface Requirement {
  model: string;
  window?: number;
  tools: boolean;
  images: boolean;
  reasoning?: boolean;
  costs: readonly string[];
}
const sum = (q: QuotaBucket[]) =>
  q.every((x) => x.remaining !== undefined)
    ? q.reduce((n, x) => n + x.remaining!, 0)
    : undefined;
export function eligible(a: AccountSnapshot, r: Requirement) {
  const m = a.models.find((m) => m.id === r.model);
  return (
    a.enabled &&
    a.status === "ready" &&
    !!m &&
    !m.unavailable &&
    r.costs.includes(m.cost) &&
    (m.cost !== "credits" ||
      a.quota.some(
        (q) =>
          ["gift", "subscription"].includes(q.kind) &&
          (q.remaining ?? 0) > 0 &&
          (!q.expiresAt || q.expiresAt > Date.now()),
      )) &&
    (!r.tools || m.tools) &&
    (!r.images || m.images) &&
    (!r.reasoning || m.reasoning) &&
    (!r.window || (!!m.contextWindow && m.contextWindow >= r.window))
  );
}
export function rankAccounts(
  accounts: AccountSnapshot[],
  r: Requirement,
  now = Date.now(),
) {
  const usable = accounts.filter((a) => eligible(a, r));
  return usable.sort((a, b) => compareAccounts(a,b,now));
}
export function compareAccounts(a: AccountSnapshot, b: AccountSnapshot, now = Date.now()) {
  const expiry = (a: AccountSnapshot) => Math.min(...a.quota.filter(q => q.kind === "gift" && (q.remaining ?? 0) > 0 && q.expiresAt !== undefined && q.expiresAt > now && q.expiresAt - now <= 7 * 86400000).map(q => q.expiresAt!));
    const ae = expiry(a),
      be = expiry(b);
    if (ae !== be) return ae < be ? -1 : 1;
    const aq = a.quota.filter(
      (q) =>
        q.kind !== "paid" &&
        q.kind !== "unknown" &&
        (!q.expiresAt || q.expiresAt > now),
    );
    const bq = b.quota.filter(
      (q) =>
        q.kind !== "paid" &&
        q.kind !== "unknown" &&
        (!q.expiresAt || q.expiresAt > now),
    );
    if (
      aq.length &&
      bq.length &&
      new Set([...aq, ...bq].map((q) => q.unit)).size === 1
    ) {
      const av = sum(aq),
        bv = sum(bq);
      if (av !== undefined && bv !== undefined && av !== bv) return bv - av;
    }
    return (a.lastUsed ?? 0) - (b.lastUsed ?? 0) || a.id.localeCompare(b.id);
}
export class PoolSource implements RouterSource {
  private pins = new Map<string, { account: string; route?: string; at: number }>();
  private counter = 0;
  constructor(
    readonly sourceId: SourceId,
    private readonly members: () => PoolMember[],
    private readonly settings: () => SourceSettings,
    private readonly logs: RouterLogs,
    private readonly bindings?: BindingPort,
  ) {}
  catalog(): RouterModel[] {
    const all = new Map<string, RouterModel[]>();
    for (const member of this.members())
      for (const m of member.state.models)
        all.set(routeKey(m), [...(all.get(routeKey(m)) || []), m]);
    return [...all.values()].map((rows) => {
      const available = rows.filter((m) => !m.unavailable),
        candidates = available.length ? available : rows;
      const first = candidates[0]!;
      return {
        ...first,
        contextWindow: candidates.some((m) => m.contextWindow)
          ? Math.max(...candidates.map((m) => m.contextWindow || 0))
          : undefined,
        // Actual request selection enforces the exact account's capabilities and window.
        tools: candidates.some((m) => m.tools),
        images: candidates.some((m) => m.images),
        reasoning: candidates.some((m) => m.reasoning),
        reasoningCanDisable: candidates.every(
          (m) => !m.reasoning || m.reasoningCanDisable,
        ),
        unavailable: available.length ? undefined : first.unavailable,
      };
    });
  }
  groups() {
    for (const member of this.members()) member.syncCatalog?.();
    return modelGroups(this.members().flatMap(member => member.state.models.map(m => ({ ...m, accountId: member.state.id, accountEligible: member.state.enabled && member.state.status === "ready" }))), this.settings());
  }
  models() {
    return this.groups()
      .filter((m) => !m.unavailable && groupSettings(m, this.settings()).enabled)
      .flatMap((m) => {
        // A changed/unknown upstream limit must not disable unrelated routes.
        try {
          return [configuredGroup(m, groupSettings(m, this.settings()))];
        } catch {
          return [];
        }
      });
  }
  resolve(id: string) {
    if (id.startsWith("group:")) return this.models().find(m => m.id === id);
    // Historic conversations retain their exact route, never resolve to a dynamic group.
    const raw = this.catalog().find(m => m.id === id && !m.unavailable && settingsFor(this.settings(), m).enabled);
    if (!raw || this.settings().groups?.[groupKey(raw)]?.enabled === false) return undefined;
    return configuredModel(raw, settingsFor(this.settings(), raw));
  }
  async prepare(id: string, signal?: AbortSignal): Promise<SourceCall> {
    signal?.throwIfAborted();
    const model = this.resolve(id);
    if (!model) throw new Error("MODEL_NOT_ENABLED");
    const group = this.groups().find(m => m.id === id);
    const config = structuredClone(group ? groupSettings(group, this.settings()) : settingsFor(this.settings(), model));
    const self = this;
    return {
      async *run(body, tools, signal, identity?: CallIdentity) {
        const started = Date.now(),
          requestId = randomUUID();
        const members = self.members();
        // Refresh stale account snapshots before making a new allocation. No generation is replayed here.
        for (const m of members.filter(
          (m) =>
            m.state.enabled &&
            (!m.state.updatedAt || started - m.state.updatedAt > 300000),
        )) {
          signal.throwIfAborted();
          await m.refresh(signal).catch(() => {
            m.state.status = "unavailable";
          });
        }
        const key =
          identity?.turnId && identity.sessionId
            ? `${identity.sessionId}:${identity.turnId}:${id}${identity.purpose ? `:${identity.purpose}` : ""}`
            : undefined;
        let pinned = key ? self.pins.get(key) : undefined;
        const requirement: Requirement = {
          model: id,
          window: model.contextWindow,
          tools: tools.length > 0,
          reasoning: model.reasoning,
          images:
            Array.isArray(body.messages) &&
            body.messages.some(
              (m: any) =>
                Array.isArray(m.content) &&
                m.content.some((p: any) => p.type === "image_url"),
            ),
          costs: config.allowedCosts ?? ["free", "credits"],
        };
        const maxOutput = typeof body.max_tokens === "number" ? body.max_tokens : undefined;
        const effort = typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined;
        for (const member of members) member.syncCatalog?.();
        const candidates = members.flatMap(member => {
          const routes = group ? groupCandidates({ ...group, routes: member.state.models.filter(r => groupKey(r) === id) }, config as import("../shared/types.js").GroupSettings) : member.state.models.filter(r => r.id === id);
          return routes.filter(actual => eligible(member.state, { ...requirement, model: actual.id }) &&
            !(config.capabilities.reasoning === false && actual.reasoning && !actual.reasoningCanDisable) &&
            (!effort || effort === "default" || (effort === "off" ? !actual.reasoning || actual.reasoningCanDisable : actual.reasoningEfforts?.includes(effort))) &&
            (!maxOutput || !actual.maxOutput || maxOutput <= actual.maxOutput)).map(actual => ({ account: member.state, actual, member }));
        }).sort((a,b) => feeOrder[a.actual.cost] - feeOrder[b.actual.cost] || compareAccounts(a.account,b.account,started) ||
          a.account.models.indexOf(a.actual)-b.account.models.indexOf(b.actual) || routeKey(a.actual).localeCompare(routeKey(b.actual)));
        if (key && self.bindings) {
          const binding = await self.bindings.assign(
            key,
            `${identity!.sessionId}:${id}:latest`,
            !!identity?.continuation,
            candidates[0] ? { account: candidates[0].account.id, route: routeKey(candidates[0].actual) } : undefined,
            {
              inheritLatest: identity?.purpose === "compaction",
              updateLatest: !identity?.purpose,
            },
          );
          if (binding?.pinned)
            pinned = { account: binding.account, route: binding.route, at: started };
          else if (identity?.continuation)
            throw new Error("RECOVERY_ACCOUNT_UNKNOWN");
        }
        if (pinned && group && !pinned.route) throw new Error("RECOVERY_ROUTE_UNKNOWN");
        const selected = pinned
          ? candidates.find(c => c.account.id === pinned.account && (!pinned.route || routeKey(c.actual) === pinned.route))
          : candidates[0];
        const chosen = selected?.account;
        if (!chosen) {
          await self.logs.append({
            source: self.sourceId,
            model: group ? undefined : id, group: group?.id, route: pinned?.route,
            kind: "request",
            result: "refused",
            code: pinned ? "PINNED_ACCOUNT_UNAVAILABLE" : "NO_ELIGIBLE_ACCOUNT",
          });
          throw new Error(
            pinned ? "PINNED_ACCOUNT_UNAVAILABLE" : "NO_ELIGIBLE_ACCOUNT",
          );
        }
        chosen.lastUsed = started + ++self.counter / 10000;
        if (key && !self.bindings) {
          self.pins.set(key, { account: chosen.id, route: routeKey(selected!.actual), at: started });
          if (!self.bindings && self.pins.size > 10000)
            throw new Error("REQUEST_BINDING_LIMIT");
        }
        const { member, actual } = selected!;
        let result = "disconnected",
          code: string | undefined,
          httpStatus: number | undefined,
          inputTokens: number | undefined,
          outputTokens: number | undefined;
        try {
          const call = await member.source.prepare(
            actual.upstreamId || actual.id,
            signal,
          );
          for await (const event of call.run(
            { ...body, model: actual.upstreamId || actual.id },
            tools,
            signal,
            identity,
          )) {
            if (event.type === "finish") {
              result = event.result.state;
              code = event.result.code;
              httpStatus = event.result.httpStatus;
            }
            if (event.type === "usage") {
              inputTokens = event.input;
              outputTokens = event.output;
            }
            yield event;
          }
        } catch (e) {
          code = signal.aborted ? "CANCELLED" : "UPSTREAM_FAILED";
          result = signal.aborted ? "cancelled" : "disconnected";
          throw e;
        } finally {
          if (actual.cost === "credits" || result === "refused")
            chosen.updatedAt = undefined;
          await self.logs
            .append({
              source: self.sourceId,
              account: chosen.id,
              model: actual.id, group: group?.id, route: routeKey(actual),
              kind: "request",
              result,
              code,
              httpStatus,
              durationMs: Date.now() - started,
              inputTokens,
              outputTokens,
              reason: pinned
                ? "pinned"
                : actual.cost === "free" ? "free-first"
                : chosen.quota.some(
                      (q) =>
                        q.kind === "gift" &&
                        q.expiresAt &&
                        q.expiresAt > started &&
                        q.expiresAt - started <= 7 * 86400000 &&
                        (q.remaining ?? 0) > 0,
                    )
                  ? "expiring-gift"
                  : "least-recent",
            })
            .catch(() => {});
        }
      },
    };
  }
}
