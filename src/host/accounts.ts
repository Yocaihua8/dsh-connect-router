import type { Context } from "@deepseek-ai/cordis";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { RouterStore } from "./store.js";
import { WorkBuddyCredentials } from "./workbuddy/credentials.js";
import { WorkBuddySource } from "./workbuddy/source.js";
import { OpenCodeSource } from "./opencode/source.js";
import { WorkBuddyUpstreamClient } from "./workbuddy/vendor/upstream.js";
import { Benefits } from "./benefits.js";
import type { AccountRecord, AccountSnapshot, RouterModel } from "../shared/types.js";
import type { PoolMember } from "./pool.js";
import type { RouterLogs } from "./logs.js";

export interface AccountMember extends PoolMember {
  workbuddy?: WorkBuddySource;
  opencode?: OpenCodeSource;
}
export class Accounts {
  readonly members = new Map<string, AccountMember>();
  private flights = new Map<string, Promise<void>>();
  constructor(
    private readonly ctx: Context,
    private readonly store: RouterStore,
    private readonly logs: RouterLogs,
    private readonly signal: AbortSignal,
    private readonly keptModels: (region: string, catalog: RouterModel[]) => readonly string[] = () => [],
  ) {}
  private key(id: string) {
    return credentialKey(
      "dsh-connect-router",
      id === "legacy-workbuddy" ? "workbuddy" : `account-${id}`,
    );
  }
  async initialize() {
    const old = await this.ctx.credentials.readRecord(
      this.key("legacy-workbuddy"),
    );
    const rows = await this.store.mutateAccounts((rows) => {
      if (old && !rows.some((a) => a.id === "legacy-workbuddy"))
        rows.push({
          id: "legacy-workbuddy",
          source: "workbuddy",
          service: "workbuddy",
          region: "cn",
          label: "WorkBuddy",
          enabled: true,
        });
      if (!rows.some((a) => a.id === "anonymous"))
        rows.push({
          id: "anonymous",
          source: "opencode",
          service: "anonymous",
          region: "global",
          label: "匿名公共来源",
          enabled: true,
        });
      return rows;
    });
    for (const row of rows) this.mount(row);
  }
  get(id: string) {
    const m = this.members.get(id);
    if (!m) throw new Error("ACCOUNT_NOT_FOUND");
    return m;
  }
  async add(
    source: "workbuddy" | "opencode",
    service: AccountRecord["service"],
    label: string,
    region: AccountRecord["region"],
  ) {
    if (service === "anonymous") throw new Error("ANONYMOUS_ACCOUNT_EXISTS");
    const record = {
      id: randomUUID(),
      source,
      service,
      label,
      region,
      enabled: false,
    };
    await this.store.mutateAccounts((rows) => [...rows, record]);
    this.mount(record);
    return record.id;
  }
  private mount(record: AccountRecord) {
    const state: AccountSnapshot = {
      ...record,
      status: "auth-required",
      models: [],
      quota: [],
    };
    const key = this.key(record.id);
    const wbCredentials = new WorkBuddyCredentials(
      {
        read: async () => {
          const r = await this.ctx.credentials.readRecord(key);
          return r?.kind === "grant" ? r.payload : undefined;
        },
        modify: async (mutate) => {
          const r = await this.ctx.credentials.modifyRecord(
            key,
            async (old) => ({
              kind: "grant",
              payload: await mutate(
                old?.kind === "grant" ? old.payload : undefined,
              ),
            }),
          );
          return r?.kind === "grant" ? r.payload : undefined;
        },
        remove: () => this.ctx.credentials.deleteRecord(key),
      },
      (c) => new WorkBuddyUpstreamClient().refreshToken(c, this.signal),
    );
    const workbuddy =
      record.source === "workbuddy"
        ? new WorkBuddySource(
            wbCredentials,
            new Benefits(this.store),
            new WorkBuddyUpstreamClient((message) => { void this.logs.append({ source: "workbuddy", account: record.id, result: "degraded", code: message === "MODEL_ROSTER_MISSING" ? message : "MODEL_CATALOG_FALLBACK" }).catch(() => {}); }),
            record.region,
            catalog => this.keptModels(record.region, catalog.map(m => ({ ...m, region: record.region, service: record.service }))),
            join(this.store.directory, "accounts", record.id, "catalog.json"),
            code => { void this.logs.append({ source: "workbuddy", account: record.id, result: "degraded", code }).catch(() => {}); },
          )
        : undefined;
    const opencode =
      record.source === "opencode"
        ? new OpenCodeSource(
            join(this.store.directory, "accounts", record.id),
            record.service as "anonymous" | "opencode" | "opencode-go",
            async () => {
              if (record.service === "anonymous") return {};
              const r = await this.ctx.credentials.readRecord(key),
                payload = r?.kind === "grant" ? (r.payload as any) : undefined;
              if (typeof payload?.key !== "string" || !payload.key)
                throw new Error("AUTH_REQUIRED");
              return { [record.service]: { type: "api", key: payload.key } };
            },
          )
        : undefined;
    const source = workbuddy || opencode!;
    const refresh = (signal: AbortSignal) => {
      signal.throwIfAborted();
      let flight = this.flights.get(record.id);
      if (!flight) {
        flight = (async () => {
          try {
            const models = await source.refresh(this.signal);
            source.select(
              models.filter((m) => !m.unavailable).map((m) => m.id),
            );
            state.models = models.map((m) => ({
              ...m,
              upstreamId: m.id,
              id: workbuddy ? `${record.region}/${m.id}` : m.id,
              region: record.region,
              service: m.service || record.service,
            }));
            state.status = "ready";
            state.error = undefined;
            if (workbuddy) {
              const identity = await workbuddy.credentials.identity();
              const status = await workbuddy.credentials.status();
              state.label = `${maskLabel(status.nickname || "WorkBuddy")} · ${identity?.slice(0, 6) || record.id.slice(0, 6)}`;
              const credits = await workbuddy
                .quota(this.signal)
                .catch(() => undefined);
              state.quota =
                credits?.packages.map((q) => ({
                  kind:
                    q.capacityType === 1
                      ? "gift"
                      : q.capacityType === 4
                        ? "subscription"
                        : "unknown",
                  unit: "credits",
                  remaining: q.remainingKnown ? q.remain : undefined,
                  total: q.totalKnown ? q.size : undefined,
                  expiresAt: q.expiresAtMs,
                })) || [];
            }
            state.updatedAt = Date.now();
          } catch (e) {
            state.status =
              e instanceof Error && /^AUTH_/u.test(e.message)
                ? "auth-required"
                : "unavailable";
            state.error =
              state.status === "auth-required"
                ? "AUTH_REQUIRED"
                : "REFRESH_FAILED";
            state.updatedAt = Date.now();
            throw e;
          }
        })().finally(() => this.flights.delete(record.id));
        this.flights.set(record.id, flight);
      }
      return new Promise<void>((resolve, reject) => {
        const cancel = () => reject(signal.reason);
        signal.addEventListener("abort", cancel, { once: true });
        flight!
          .then(() => {
            signal.throwIfAborted();
            resolve();
          })
          .catch(reject)
          .finally(() => signal.removeEventListener("abort", cancel));
        if (signal.aborted) cancel();
      });
    };
    this.members.set(record.id, {
      state,
      source,
      workbuddy,
      opencode,
      refresh,
      syncCatalog: workbuddy ? () => {
        const rows = workbuddy.currentCatalog();
        if (rows.length) state.models = rows.map(m => ({ ...m, upstreamId: m.id, id: `${record.region}/${m.id}`, region: record.region, service: record.service }));
      } : undefined,
    });
  }
  async setKey(id: string, keyValue: string) {
    const m = this.get(id);
    if (
      !m.opencode ||
      m.state.service === "anonymous" ||
      typeof keyValue !== "string" ||
      !keyValue.trim() ||
      keyValue.length > 8192 ||
      /[\r\n]/u.test(keyValue)
    )
      throw new Error("INVALID_KEY");
    await this.ctx.credentials.modifyRecord(this.key(id), async () => ({
      kind: "grant",
      payload: { key: keyValue.trim() },
    }));
    await m.opencode.dispose();
    m.state.status = "auth-required";
    m.state.updatedAt = undefined;
  }
  async completeAuthorization(id: string) {
    const current = this.get(id);
    if (!current.workbuddy) return id;
    const identity = await current.workbuddy.credentials.identity();
    for (const other of this.members.values())
      if (
        other.state.id !== id &&
        other.workbuddy &&
        identity &&
        (await other.workbuddy.credentials.identity()) === identity
      ) {
        await other.workbuddy.credentials.accept(
          await current.workbuddy.credentials.resolve(this.signal),
        );
        await this.remove(id);
        await this.update(other.state.id, true);
        return other.state.id;
      }
    await this.update(id, true);
    return id;
  }
  async update(id: string, enabled: boolean) {
    const m = this.get(id);
    if (typeof enabled !== "boolean") throw new Error("INVALID_ACCOUNT");
    await this.store.mutateAccounts((rows) =>
      rows.map((a) => (a.id === id ? { ...a, enabled } : a)),
    );
    m.state.enabled = enabled;
  }
  async remove(id: string) {
    const m = this.get(id);
    if (m.state.service === "anonymous")
      throw new Error("ANONYMOUS_ACCOUNT_REQUIRED");
    await this.update(id, false);
    await this.flights.get(id)?.catch(() => {});
    await m.opencode?.dispose();
    await this.ctx.credentials.deleteRecord(this.key(id));
    await this.store.mutateAccounts((rows) => rows.filter((a) => a.id !== id));
    this.members.delete(id);
  }
  snapshot() {
    return [...this.members.values()].map((m) =>
      structuredClone({ ...m.state, label: maskLabel(m.state.label) }),
    );
  }
  async dispose() {
    await Promise.allSettled([...this.flights.values()]);
    await Promise.allSettled(
      [...this.members.values()].map((m) => m.opencode?.dispose()),
    );
  }
}
export function maskLabel(label: string) {
  return label
    .replace(/([\w.+-]{1,2})[\w.+-]*(@[^\s]+)/gu, "$1***$2")
    .replace(/\b(\d{3})\d{4}(\d{4})\b/gu, "$1****$2");
}
