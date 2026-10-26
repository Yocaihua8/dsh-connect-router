import { createHash } from "node:crypto";
import { WorkBuddyUpstreamClient, regionOf } from "./vendor/upstream.js";
import { oauthStart, oauthPoll, oauthCancel } from "./vendor/oauth.js";
import { WorkBuddyCredentials } from "./credentials.js";
import { Benefits, checkinDay, type BenefitApi } from "../benefits.js";
import { workbuddyModel } from "../catalog.js";
import { parseChatStream } from "../stream.js";
import type { RouterModel } from "../../shared/types.js";
import type { RouterSource, SourceCall } from "../adapter.js";
export class WorkBuddySource implements RouterSource {
  private catalog: RouterModel[] = [];
  private selected: string[] = [];
  constructor(
    readonly credentials: WorkBuddyCredentials,
    readonly benefits: Benefits,
    readonly upstream = new WorkBuddyUpstreamClient(),
    readonly region: "cn" | "global" = "cn",
  ) {}
  models() {
    return this.catalog.filter((m) => this.selected.includes(m.id));
  }
  select(ids: readonly string[]) {
    this.selected = [...ids];
  }
  async refresh(signal: AbortSignal) {
    const c = await this.credentials.resolve(signal);
    this.catalog = (await this.upstream.fetchModels(c, signal)).map(
      workbuddyModel,
    );
    return this.catalog;
  }
  async prepare(id: string, signal?: AbortSignal): Promise<SourceCall> {
    if (!this.models().some((m) => m.id === id))
      throw new Error("MODEL_NOT_ENABLED");
    const c = await this.credentials.resolve(signal),
      upstream = this.upstream;
    return {
      async *run(body, tools, signal) {
        const result = await upstream.chatStream(
          c,
          JSON.stringify(body),
          signal,
        );
        if (!result.ok) {
          yield {
            type: "finish",
            result: {
              state: signal.aborted ? "cancelled" : "refused",
              tools: 0,
              httpStatus: result.status || undefined,
              code:
                result.kind === "session_dead"
                  ? "AUTH_EXPIRED"
                  : /context.{0,20}(?:length|limit|window)|maximum context|上下文.{0,8}超|token.{0,10}limit/iu.test(
                        result.message,
                      )
                    ? "CONTEXT_OVERFLOW"
                    : `UPSTREAM_${result.kind.toUpperCase()}`,
            },
          };
          return;
        }
        if (!result.response.body) {
          yield {
            type: "finish",
            result: { state: "disconnected", tools: 0, code: "EMPTY_BODY" },
          };
          return;
        }
        yield* parseChatStream(result.response.body, tools, signal);
      },
    };
  }
  async startLogin(signal: AbortSignal) {
    const result = await oauthStart(this.region, { signal });
    if ("error" in result) throw new Error("AUTH_START_FAILED");
    const url = new URL(result.verificationUri);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      ![
        "codebuddy.cn",
        "workbuddy.cn",
        "codebuddy.ai",
        "workbuddy.ai",
        "qq.com",
        "tencent.com",
      ].some(
        (host) => url.hostname === host || url.hostname.endsWith("." + host),
      )
    ) {
      oauthCancel(result.loginId);
      throw new Error("UNEXPECTED_AUTH_URL");
    }
    return result;
  }
  async pollLogin(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const r = await oauthPoll(id, this.region, { signal });
    signal.throwIfAborted();
    if (!r.done) return { done: false };
    if ("error" in r) throw new Error("AUTH_FAILED");
    await this.credentials.accept(r.account);
    return { done: true };
  }
  cancelLogin(id: string) {
    oauthCancel(id);
  }
  async quota(signal: AbortSignal) {
    return this.upstream.fetchCredits(
      await this.credentials.resolve(signal),
      signal,
    );
  }
  async claim(id: "checkin" | "compensation" | "gift", signal: AbortSignal) {
    const c = await this.credentials.resolve(signal),
      account = createHash("sha256")
        .update(c.domain + "\0" + c.uid)
        .digest("hex");
    const day =
      id === "checkin" ? checkinDay(Date.now(), regionOf(c.domain)) : undefined;
    const key = day ? "checkin:" + day : id,
      upstream = this.upstream;
    const api: BenefitApi = {
      status: async (_id, signal) => {
        if (c.enterpriseId)
          return {
            id: key,
            eligible: false,
            claimed: false,
            unsupported: true,
          };
        if (id === "checkin") {
          const s = await upstream.fetchCheckinStatus(c, signal);
          return {
            id: key,
            eligible: s.active && !s.todayCheckedIn,
            claimed: s.todayCheckedIn,
            unsupported: !s.active,
          };
        }
        const b = (await upstream.fetchBenefits(c, signal)).find(
          (b) => b.kind === id,
        );
        if (!b) throw new Error("BENEFIT_STATUS_UNKNOWN");
        return {
          id: key,
          eligible:
            b.active &&
            !b.claimed &&
            (b.endsAtMs === undefined || b.endsAtMs > Date.now()),
          claimed: b.claimed,
        };
      },
      claim: async (_id, signal) => {
        if (id === "checkin") await upstream.claimDailyCheckin(c, signal);
        else await upstream.claimBenefit(c, id, signal);
      },
    };
    return this.benefits.claim(account, key, api, signal);
  }
  async benefitStatus(signal: AbortSignal) {
    const c = await this.credentials.resolve(signal);
    if (c.enterpriseId) return { unsupported: true, items: [] };
    return {
      unsupported: false,
      checkin: await this.upstream.fetchCheckinStatus(c, signal),
      items: await this.upstream.fetchBenefits(c, signal),
    };
  }
}
