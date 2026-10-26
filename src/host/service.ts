import type { Context } from "@deepseek-ai/cordis";
import {
  Remote,
  RemoteError,
  TypertRemoteService,
} from "@deepseek-ai/dsh-typert-protocol";
import "@deepseek-ai/dsh-attachment";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { RouterStore, DEFAULT_SETTINGS, validateSettings } from "./store.js";
import { RouterAdapter, ROUTES } from "./adapter.js";
import { Accounts } from "./accounts.js";
import { PoolSource } from "./pool.js";
import { RouterLogs, type LogFilter, type LogEntry } from "./logs.js";
import { validateModelChange, settingsFor, sameModelSettings } from "./model-settings.js";
import { groupSettings, groupKey, groupError, sameGroupSettings, approvalKey, retainedWorkBuddyIds } from "../shared/groups.js";
import { diagnostic } from "./diagnostics.js";
import { RequestBindings } from "./bindings.js";
import { ContextRecovery } from "./recovery.js";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { GitHubFeedback } from "./feedback.js";
import { ROUTER_VERSION } from "../shared/feedback.js";
import type {
  FeedbackAuth,
  FeedbackLogin,
  FeedbackReport,
} from "../shared/feedback.js";
import type {
  DiagnosticBundle,
  RouterSnapshot,
  LoginStart,
  BenefitStatus,
  AccountTestResult,
  AccountSnapshot,
  QuotaBucket,
  Receipt,
  SourceId,
  RouterSettings,
  StreamFinish,
  SessionRecovery,
  AccountRecord,
} from "../shared/types.js";
declare module "@deepseek-ai/cordis" {
  interface Context {
    connectRouter: ConnectRouter;
  }
}
declare module "@deepseek-ai/dsh-typert-protocol" {
  interface RemoteErrorDetailsMap {
    "connect-router/failed": { reason: string };
  }
}
export default class ConnectRouter extends TypertRemoteService {
  static inject = ["llm", "credentials", "typert", "attachments"];
  private abort = new AbortController();
  private store: RouterStore;
  private accounts: Accounts;
  private logs: RouterLogs;
  private feedback: GitHubFeedback;
  private pools: Record<SourceId, PoolSource>;
  private ready: Promise<void>;
  private settings: RouterSettings = structuredClone(DEFAULT_SETTINGS);
  private diagnostics = new Map<string, SessionRecovery>();
  private recoveryWrite: Promise<void> = Promise.resolve();
  private logins = new Map<string, string>();
  constructor(ctx: Context) {
    super(ctx, "connectRouter");
    this.store = new RouterStore(dshHomePath("plugins", "dsh-connect-router"));
    this.logs = new RouterLogs(this.store.directory);
    const feedbackKey = credentialKey("dsh-connect-router", "github-feedback");
    this.feedback = new GitHubFeedback(this.store.directory, {
      read: async () => {
        const r = await ctx.credentials.readRecord(feedbackKey);
        return r?.kind === "grant" ? r.payload : undefined;
      },
      modify: async (mutate) => {
        const r = await ctx.credentials.modifyRecord(
          feedbackKey,
          async (old) => ({
            kind: "grant",
            payload: await mutate(
              old?.kind === "grant" ? old.payload : undefined,
            ),
          }),
        );
        return r?.kind === "grant" ? r.payload : undefined;
      },
      remove: () => ctx.credentials.deleteRecord(feedbackKey),
    });
    this.accounts = new Accounts(ctx, this.store, this.logs, this.abort.signal, (region, cached) => {
      return retainedWorkBuddyIds(this.settings.workbuddy, region, [...cached, ...[...this.accounts.members.values()].flatMap(m => m.state.models)]);
    });
    const recovery = new ContextRecovery(ctx, this.logs, this.abort.signal);
    this.pools = Object.fromEntries(
      (["workbuddy", "opencode"] as const).map((id) => [
        id,
        new PoolSource(
          id,
          () =>
            [...this.accounts.members.values()].filter(
              (m) => m.state.source === id,
            ),
          () => this.settings[id],
          this.logs,
          new RequestBindings(this.store.directory),
        ),
      ]),
    ) as Record<SourceId, PoolSource>;
    for (const id of ["workbuddy", "opencode"] as const)
      ctx.llm.registerAdapter(
        [ROUTES[id]],
        new RouterAdapter(
          this.pools[id],
          ROUTES[id],
          () => undefined,
          (options, result) => {
            recovery.observe(
              options,
              result,
              this.pools[id].resolve(options.model)
                ?.contextWindow,
            );
            if (options.sessionId && !options.purpose) {
              this.diagnostics.set(options.sessionId, {
                ...result,
                provider: options.provider,
                model: options.model,
                at: Date.now(),
              });
              if (this.diagnostics.size > 500)
                this.diagnostics.delete(this.diagnostics.keys().next().value!);
              this.recoveryWrite = this.recoveryWrite
                .then(() => this.store.writeRecoveries([...this.diagnostics]))
                .catch(() =>
                  this.logs
                    .append({
                      source: id,
                      result: "failed",
                      code: "RECOVERY_PERSIST_FAILED",
                    })
                    .catch(() => {}),
                );
            }
          },
          async (block, signal) => {
            const image = await ctx.attachments.readImage(
              block.attachment,
              signal,
            );
            return `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString("base64")}`;
          },
        ),
      );
    this.ready = this.initialize();
    this.ready.catch(() => {});
    ctx.effect(() => () => {
      this.abort.abort();
      for (const [login, id] of this.logins)
        this.accounts.members.get(id)?.workbuddy?.cancelLogin(login);
      return Promise.all([this.accounts.dispose(), this.recoveryWrite]);
    });
  }
  private async initialize() {
    await this.store.initialize();
    this.settings = await this.store.readSettings();
    this.diagnostics = new Map(await this.store.readRecoveries());
    await this.accounts.initialize();
    const refreshes: Promise<unknown>[] = [];
    for (const m of this.accounts.members.values()) {
      if (m.state.enabled)
        refreshes.push(m
          .refresh(this.abort.signal)
          .then(() => this.ctx.emit("llm/adapters-updated"))
          .catch(() => {}));
      if (m.workbuddy && this.settings.workbuddy.autoCheckin)
        void this.startupCheckin(m.state.id);
    }
    await Promise.all(refreshes);
    const migrated = structuredClone(this.settings);
    for (const id of ["workbuddy", "opencode"] as const) for (const group of this.pools[id].groups()) {
      migrated[id].groups ??= {};
      if (!migrated[id].groups![group.id]) {
        const inherited = groupSettings(group, this.settings[id]);
        migrated[id].groups![group.id] = inherited.enabled && groupError(group, inherited)
          ? { ...inherited, needsReview: true } : inherited;
      }
    }
    if (JSON.stringify(migrated) !== JSON.stringify(this.settings)) this.settings = await this.store.saveSettings(migrated);
    this.ctx.emit("llm/adapters-updated");
  }
  private async startupCheckin(id: string) {
    try {
      const m = this.accounts.get(id);
      if (!m.workbuddy || !(await m.workbuddy.credentials.status()).configured)
        return;
      const r = await m.workbuddy.claim("checkin", this.abort.signal);
      await this.logs.append({
        source: "workbuddy",
        account: id,
        result: r.state,
        code: "AUTO_CHECKIN",
      });
    } catch {
      await this.logs
        .append({
          source: "workbuddy",
          account: id,
          result: "failed",
          code: "AUTO_CHECKIN",
        })
        .catch(() => {});
    }
  }
  private async guarded<T>(
    signal: AbortSignal,
    run: () => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.ctx.invocation?.peer.principal.kind !== "owner")
      throw new RemoteError("connect-router/failed", "OWNER_REQUIRED", {
        reason: "OWNER_REQUIRED",
      });
    await this.ready;
    try {
      return await run();
    } catch (e) {
      signal.throwIfAborted();
      const code =
        e instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(e.message)
          ? e.message
          : "OPERATION_FAILED";
      throw new RemoteError("connect-router/failed", code, { reason: code });
    }
  }
  @Remote async snapshot(signal: AbortSignal): Promise<RouterSnapshot> {
    return this.guarded(signal, async () => ({
      settings: structuredClone(this.settings),
      accounts: this.accounts.snapshot(),
      models: {
        workbuddy: this.pools.workbuddy.catalog(),
        opencode: this.pools.opencode.catalog(),
      },
      groups: { workbuddy: this.pools.workbuddy.groups(), opencode: this.pools.opencode.groups() },
    }));
  }
  @Remote async saveSettings(
    settings: RouterSettings,
    signal: AbortSignal,
  ): Promise<RouterSettings> {
    return this.guarded(signal, async () => {
      const next = validateSettings(settings);
      for (const id of ["workbuddy", "opencode"] as const)
        for (const m of this.pools[id].catalog()) {
          if (next[id].groups?.[groupKey(m)] && sameModelSettings(settingsFor(this.settings[id], m), settingsFor(next[id], m))) continue;
          validateModelChange(
            m,
            settingsFor(this.settings[id], m),
            settingsFor(next[id], m),
          );
        }
      for (const id of ["workbuddy", "opencode"] as const) {
        const groups = this.pools[id].groups?.() || [];
        for (const [key, config] of Object.entries(next[id].groups || {})) {
          const group = groups.find(g => g.id === key);
          const previous = group ? groupSettings(group, this.settings[id]) : this.settings[id].groups?.[key];
          if (previous && sameGroupSettings(previous, config)) continue;
          if (!group || group.unavailable) throw new Error("UNAVAILABLE_MODEL_CHANGED");
          if (config.approvedRoutes.some(r => !previous?.approvedRoutes.includes(r) && !group.routes.some(m => approvalKey(m) === r))) throw new Error("INVALID_ROUTE_APPROVAL");
          const error = groupError(group, config);
          if (error && (config.enabled || config.needsReview)) throw new Error(error);
          if (config.context.mode === "custom" && error === "CONTEXT_LIMIT_UNCONFIRMED") throw new Error(error);
        }
      }
      this.settings = await this.store.saveSettings(next);
      this.ctx.emit("llm/adapters-updated");
      return structuredClone(this.settings);
    });
  }
  @Remote async addAccount(
    source: SourceId,
    service: AccountRecord["service"],
    label: string,
    region: AccountRecord["region"],
    signal: AbortSignal,
  ): Promise<string> {
    return this.guarded(signal, () =>
      this.accounts.add(source, service, label, region),
    );
  }
  @Remote async setAccountKey(
    id: string,
    key: string,
    signal: AbortSignal,
  ): Promise<void> {
    return this.guarded(signal, async () => {
      await this.accounts.setKey(id, key);
      await this.accounts.get(id).refresh(signal);
      await this.accounts.update(id, true);
      this.ctx.emit("llm/adapters-updated");
    });
  }
  @Remote async updateAccount(
    id: string,
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    return this.guarded(signal, async () => {
      await this.accounts.update(id, enabled);
      this.ctx.emit("llm/adapters-updated");
    });
  }
  @Remote async removeAccount(id: string, signal: AbortSignal): Promise<void> {
    return this.guarded(signal, async () => {
      for (const [login, account] of this.logins)
        if (account === id) {
          this.accounts.get(id).workbuddy?.cancelLogin(login);
          this.logins.delete(login);
        }
      await this.accounts.remove(id);
      this.ctx.emit("llm/adapters-updated");
    });
  }
  @Remote async refresh(
    source: SourceId,
    signal: AbortSignal,
  ): Promise<AccountSnapshot[]> {
    return this.guarded(signal, async () => {
      if (!this.pools[source]) throw new Error("INVALID_SOURCE");
      for (const m of this.accounts.members.values())
        if (m.state.source === source) {
          signal.throwIfAborted();
          await m.refresh(signal).catch(() => {});
        }
      signal.throwIfAborted();
      this.ctx.emit("llm/adapters-updated");
      return this.accounts.snapshot().filter((a) => a.source === source);
    });
  }
  @Remote async refreshAccount(id: string, signal: AbortSignal): Promise<void> {
    return this.guarded(signal, async () => {
      await this.accounts.get(id).refresh(signal);
      this.ctx.emit("llm/adapters-updated");
      await this.logs.append({
        source: this.accounts.get(id).state.source,
        account: id,
        result: "success",
        code: "REFRESH",
      });
    });
  }
  @Remote async startLogin(
    accountId: string,
    signal: AbortSignal,
  ): Promise<LoginStart> {
    return this.guarded(signal, async () => {
      const wb = this.accounts.get(accountId).workbuddy;
      if (!wb) throw new Error("KEY_REQUIRED");
      for (const [login, id] of this.logins)
        if (id === accountId) {
          wb.cancelLogin(login);
          this.logins.delete(login);
        }
      const result = await wb.startLogin(signal);
      this.logins.set(result.loginId, accountId);
      return result;
    });
  }
  @Remote async pollLogin(
    id: string,
    signal: AbortSignal,
  ): Promise<{ done: boolean }> {
    return this.guarded(signal, async () => {
      const accountId = this.logins.get(id);
      if (!accountId) throw new Error("INVALID_LOGIN");
      const m = this.accounts.get(accountId),
        result = await m.workbuddy!.pollLogin(id, signal);
      if (result.done) {
        this.logins.delete(id);
        const resolvedId = await this.accounts.completeAuthorization(accountId);
        await this.accounts.get(resolvedId).refresh(signal);
        this.ctx.emit("llm/adapters-updated");
        if (this.settings.workbuddy.autoCheckin)
          void this.startupCheckin(resolvedId);
        await this.logs.append({
          source: "workbuddy",
          account: resolvedId,
          result: "success",
          code: "AUTHORIZATION",
        });
      }
      return result;
    });
  }
  @Remote async cancelLogin(id: string, signal: AbortSignal): Promise<void> {
    return this.guarded(signal, async () => {
      const account = this.logins.get(id);
      if (account) this.accounts.get(account).workbuddy?.cancelLogin(id);
      this.logins.delete(id);
    });
  }
  @Remote async quota(id: string, signal: AbortSignal): Promise<QuotaBucket[]> {
    return this.guarded(signal, async () => {
      await this.accounts.get(id).refresh(signal);
      return structuredClone(this.accounts.get(id).state.quota);
    });
  }
  @Remote async benefits(
    id: string,
    signal: AbortSignal,
  ): Promise<BenefitStatus> {
    return this.guarded(signal, async () => {
      const wb = this.accounts.get(id).workbuddy;
      return wb ? wb.benefitStatus(signal) : { unsupported: true, items: [] };
    });
  }
  @Remote async claim(
    accountId: string,
    id: "checkin" | "compensation" | "gift",
    signal: AbortSignal,
  ): Promise<Receipt> {
    return this.guarded(signal, async () => {
      if (!["checkin", "compensation", "gift"].includes(id))
        throw new Error("INVALID_BENEFIT");
      const wb = this.accounts.get(accountId).workbuddy;
      if (!wb) throw new Error("BENEFITS_UNSUPPORTED");
      const r = await wb.claim(id, signal);
      await this.logs.append({
        source: "workbuddy",
        account: accountId,
        result: r.state,
        code: id.toUpperCase(),
      });
      return r;
    });
  }
  @Remote async claimEligible(
    accountId: string,
    signal: AbortSignal,
  ): Promise<Receipt[]> {
    return this.guarded(signal, async () => {
      const wb = this.accounts.get(accountId).workbuddy;
      if (!wb) return [];
      const state = await wb.benefitStatus(signal),
        results = [];
      for (const item of state.items) {
        signal.throwIfAborted();
        if (item.active && !item.claimed)
          results.push(await wb.claim(item.kind, signal));
      }
      await this.logs.append({
        source: "workbuddy",
        account: accountId,
        result: results.some((r) => r.state === "pending")
          ? "pending"
          : "complete",
        code: "CLAIM_ELIGIBLE",
      });
      return results;
    });
  }
  @Remote async queryLogs(
    filter: LogFilter,
    signal: AbortSignal,
  ): Promise<{ items: LogEntry[]; nextCursor?: string }> {
    return this.guarded(signal, () => this.logs.query(filter));
  }
  @Remote async exportDiagnostics(
    filter: LogFilter,
    signal: AbortSignal,
  ): Promise<DiagnosticBundle> {
    return this.guarded(signal, async () => ({
      schema: 1,
      pluginVersion: ROUTER_VERSION,
      targetDshVersion: "0.2.1-rc.3",
      platform: process.platform,
      nodeVersion: process.versions.node,
      generatedAt: new Date().toISOString(),
      page: await this.logs
        .query(filter)
        .then((p) => ({ ...p, items: p.items.map(diagnostic) })),
      accounts: this.accounts.snapshot().map((a) => ({
        id: a.id,
        source: a.source,
        service: a.service,
        status: a.status,
        enabled: a.enabled,
        updatedAt: a.updatedAt,
        modelCount: a.models.length,
      })),
    }));
  }
  @Remote async feedbackAuth(signal: AbortSignal): Promise<FeedbackAuth> {
    return this.guarded(signal, () => this.feedback.status());
  }
  @Remote async feedbackStartLogin(
    signal: AbortSignal,
  ): Promise<FeedbackLogin> {
    return this.guarded(signal, () => this.feedback.start(signal));
  }
  @Remote async feedbackPollLogin(
    id: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.guarded(signal, () => this.feedback.poll(id, signal));
  }
  @Remote async feedbackCancelLogin(
    id: string,
    signal: AbortSignal,
  ): Promise<void> {
    return this.guarded(signal, async () => this.feedback.cancel(id));
  }
  @Remote async feedbackDisconnect(signal: AbortSignal): Promise<void> {
    return this.guarded(signal, () => this.feedback.disconnect());
  }
  @Remote async previewFeedback(
    filter: LogFilter,
    title: string,
    description: string,
    signal: AbortSignal,
  ): Promise<FeedbackReport> {
    return this.guarded(signal, async () =>
      this.feedback.preview(
        await this.exportDiagnostics(
          { ...filter, cursor: undefined, limit: 50 },
          signal,
        ),
        title,
        description,
      ),
    );
  }
  @Remote async submitFeedback(
    id: string,
    signal: AbortSignal,
  ): Promise<FeedbackReport> {
    return this.guarded(signal, () => this.feedback.submit(id, signal));
  }
  @Remote async feedbackResult(
    id: string,
    signal: AbortSignal,
  ): Promise<FeedbackReport> {
    return this.guarded(signal, () => this.feedback.result(id, signal));
  }
  @Remote async pendingFeedback(
    signal: AbortSignal,
  ): Promise<FeedbackReport | null> {
    return this.guarded(signal, () => this.feedback.pending());
  }
  @Remote async testAccounts(
    source: SourceId,
    signal: AbortSignal,
  ): Promise<AccountTestResult[]> {
    return this.guarded(signal, async () => {
      if (!this.pools[source]) throw new Error("INVALID_SOURCE");
      const results = [];
      for (const m of this.accounts.members.values())
        if (m.state.source === source) {
          signal.throwIfAborted();
          const start = Date.now();
          try {
            await m.refresh(signal);
            results.push({
              id: m.state.id,
              result: "connected",
              modelCount: m.state.models.length,
            });
          } catch {
            signal.throwIfAborted();
            results.push({
              id: m.state.id,
              result: "failed",
              code: m.state.error,
            });
          }
          await this.logs.append({
            source,
            account: m.state.id,
            result: m.state.status === "ready" ? "success" : "failed",
            code: m.state.error || "CONNECTION_TEST",
            durationMs: Date.now() - start,
          });
        }
      this.ctx.emit("llm/adapters-updated");
      return results;
    });
  }
  @Remote async sessionRecovery(
    id: string,
    signal: AbortSignal,
  ): Promise<SessionRecovery | null> {
    return this.guarded(signal, async () => this.diagnostics.get(id) ?? null);
  }
}
