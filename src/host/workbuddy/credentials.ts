import type { WorkBuddyCredential } from "./vendor/auth.js";
import type { WorkBuddyRefreshOutcome } from "./vendor/upstream.js";
import { createHash } from "node:crypto";

/** Adapter supplied by ctx.credentials; no second credential file or desktop scan. */
export interface GrantStore {
  read(): Promise<unknown>;
  modify(mutate: (current: unknown) => Promise<unknown>): Promise<unknown>;
  remove(): Promise<void>;
}
export function credential(value: unknown): WorkBuddyCredential | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Partial<WorkBuddyCredential>;
  if (
    typeof v.accessToken !== "string" ||
    !v.accessToken ||
    typeof v.refreshToken !== "string" ||
    typeof v.domain !== "string" ||
    typeof v.uid !== "string" ||
    !v.uid ||
    typeof v.expiresAtMs !== "number" ||
    !Number.isFinite(v.expiresAtMs)
  )
    return undefined;
  return { ...v, source: "dsh", filePath: "" } as WorkBuddyCredential;
}
export class WorkBuddyCredentials {
  private flight: Promise<WorkBuddyCredential> | undefined;
  constructor(
    private readonly store: GrantStore,
    private readonly refresh: (
      c: WorkBuddyCredential,
    ) => Promise<WorkBuddyRefreshOutcome>,
    private readonly now = Date.now,
  ) {}
  async accept(value: unknown): Promise<void> {
    const c = credential(value);
    if (!c) throw new Error("INVALID_CREDENTIAL");
    await this.store.modify(async () => c);
  }
  async status() {
    const c = credential(await this.store.read());
    return {
      configured: !!c,
      expiresAtMs: c?.expiresAtMs,
      enterprise: !!c?.enterpriseId,
      nickname: c?.nickname,
    };
  }
  async identity(): Promise<string | undefined> {
    const c = credential(await this.store.read());
    return c ? createHash("sha256").update(c.domain + "\0" + c.uid).digest("hex") : undefined;
  }
  async resolve(signal?: AbortSignal): Promise<WorkBuddyCredential> {
    signal?.throwIfAborted();
    // Shared refresh completes atomically even if one caller cancels, preventing rotation loss.
    this.flight ??= this.load().finally(() => {
      this.flight = undefined;
    });
    const result = await this.flight;
    signal?.throwIfAborted();
    return result;
  }
  private async load(): Promise<WorkBuddyCredential> {
    const first = credential(await this.store.read());
    if (!first) throw new Error("AUTH_REQUIRED");
    if (first.expiresAtMs > this.now() + 300_000) return first;
    const result = await this.store.modify(async (raw) => {
      const current = credential(raw);
      if (!current) throw new Error("AUTH_REQUIRED");
      if (current.expiresAtMs > this.now() + 300_000) return current;
      if (!current.refreshToken) {
        if (current.expiresAtMs > this.now()) return current;
        throw new Error("AUTH_EXPIRED");
      }
      if (
        current.refreshExpiresAtMs !== undefined &&
        current.refreshExpiresAtMs <= this.now()
      )
        throw new Error("AUTH_EXPIRED");
      try {
        const next = await this.refresh(current);
        if (!next.accessToken) throw new Error("INVALID_REFRESH");
        return {
          ...current,
          accessToken: next.accessToken,
          refreshToken: next.refreshToken || current.refreshToken,
          domain: next.domain || current.domain,
          expiresAtMs: next.expiresInSec
            ? this.now() + next.expiresInSec * 1000
            : 0,
          lastRefreshAtMs: this.now(),
        };
      } catch (error) {
        if (
          current.expiresAtMs > this.now() &&
          !(
            error instanceof Error &&
            /REJECTED|INVALID_CREDENTIAL|AUTH_EXPIRED/u.test(error.message)
          )
        )
          return current;
        throw new Error("AUTH_REFRESH_FAILED");
      }
    });
    const c = credential(result);
    if (!c) throw new Error("AUTH_REQUIRED");
    return c;
  }
}
