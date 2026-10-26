import type { Receipt } from "../shared/types.js";
export interface BenefitStatus {
  id: string;
  eligible: boolean;
  claimed: boolean;
  unsupported?: boolean;
}
export interface BenefitLedger {
  /** Implement using a durable, process-shared lock; hold it through query/claim/verify. */
  exclusive<T>(
    key: string,
    run: (
      prior: Receipt | undefined,
      save: (r: Receipt) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
}
export interface BenefitApi {
  status(id: string, signal: AbortSignal): Promise<BenefitStatus>;
  claim(id: string, signal: AbortSignal): Promise<void>;
}
export class Benefits {
  constructor(
    private readonly ledger: BenefitLedger,
    private readonly now = Date.now,
  ) {}
  async claim(
    account: string,
    id: string,
    api: BenefitApi,
    signal: AbortSignal,
  ): Promise<Receipt> {
    if (!account || !id) throw new Error("INVALID_BENEFIT_KEY");
    const key = JSON.stringify([account, id]);
    return this.ledger.exclusive(key, async (prior, save) => {
      signal.throwIfAborted();
      const status = await api.status(id, signal);
      if (status.id !== id) throw new Error("BENEFIT_MISMATCH");
      const receipt = (state: Receipt["state"]): Receipt => ({
        key,
        state,
        at: this.now(),
      });
      if (status.unsupported) {
        const r = receipt("unsupported");
        await save(r);
        return r;
      }
      if (status.claimed) {
        const r = receipt("confirmed");
        await save(r);
        return r;
      }
      // An uncertain earlier mutation remains uncertain across refreshes/restarts.
      if (prior?.state === "pending") return prior;
      if (prior?.state === "confirmed")
        throw new Error("BENEFIT_STATE_CHANGED");
      if (!status.eligible) throw new Error("BENEFIT_NOT_ELIGIBLE");
      signal.throwIfAborted();
      const pending = receipt("pending");
      await save(pending);
      try {
        await api.claim(id, signal);
      } catch {
        return pending;
      }
      try {
        const after = await api.status(id, signal);
        if (after.id === id && after.claimed) {
          const r = receipt("confirmed");
          await save(r);
          return r;
        }
      } catch {
        /* Query failure is not a confirmed claim. */
      }
      return pending;
    });
  }
  async claimAll(
    account: string,
    ids: readonly string[],
    api: BenefitApi,
    signal: AbortSignal,
  ) {
    const results: Receipt[] = [];
    for (const id of new Set(ids)) {
      signal.throwIfAborted();
      results.push(await this.claim(account, id, api, signal));
    }
    return results;
  }
}
export function checkinDay(now: number, region: "cn" | "global"): string {
  if (region !== "cn") throw new Error("UPSTREAM_DAY_UNKNOWN");
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}
