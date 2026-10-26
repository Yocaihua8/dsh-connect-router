// Adapted from dingminhua/dsh-connect-workbuddy @ 3b558326a962aa2cfa57ff558b452f7635b447ac.
// MIT; Copyright (c) 2026 LaoDing. See THIRD_PARTY_NOTICES.md.
/**
 * WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client: chat streaming,
 * token refresh, model catalog, and credit balance.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）
 *   — 端点与 wire behavior 由其实现，上游协议本身参照
 *     Sliverkiss/workbuddy2api（MIT）。照搬的部分：按 domain 选择
 *     CN/global base、强制 stream:true、tool_choice 压平为字符串、
 *     CLI 形态请求头、chat 请求绝不携带 refresh token 的安全红线、
 *     中英文额度不足标记与错误分类、token 刷新的 X-Refresh-Token 头。
 * 改动：原版的 `fetchModels` 只保留 id/name/maxInputTokens/maxOutputTokens，
 *   丢弃了上游其余 20 个字段。实测上游每个模型还给出 `credits` 积分倍率、
 *   `supportsImages` 多模态、`reasoning.supportedEfforts` 推理档位、
 *   `descriptionZh/En` 描述等，这些正是模型管理卡片所需的信息，
 *   本实现将其完整解析（解析不出则留空，不虚构）。
 *   `reasoning` 另有两种拼写：复数 `supportedEfforts` 形态与单数 `effort`
 *   形态（只声明默认档；两网关实测这些模型接受全阶梯，不发参数即不
 *   思考），解析层将单数形态折叠为复数（见 parseReasoning，issue #7）。
 *   另：积分接口改为按套餐名聚合，实测单个账号下同名「运营裂变包」
 *   可达 19 个，逐条渲染会淹没卡片。
 *   模型目录路径改为 `/v2/enterprises/personal/models`（原版为
 *   `/console/enterprises/personal/models`）：两版官方桌面 App 均调用
 *   `/v2` 形态，CN 网关两条路径逐字节同答，而国际版网关（workbuddy.ai）
 *   只答 `/v2`、`/console` 形态返回 HTTP 500——统一 `/v2` 即同时覆盖
 *   国内版与国际版（WorkBuddy AI）账号，区域由 `domain` 自动路由。
 *
 * @module dsh-connect-workbuddy/upstream
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import { join } from 'node:path';
import type { WorkBuddyCredential } from './auth.ts';
import { isRouterModelId } from './native-modality.ts';
import { parseQueueAnswer } from './queue.ts';
import { attachPromos, parseWorkBuddyPromos } from './promo.ts';
import type { WorkBuddyPromo } from './promo.ts';
import type { WorkBuddyBusyLevel } from './busy.ts';
/** WorkBuddy region selected by the credential's login domain. */
export type WorkBuddyRegion = 'cn' | 'global';

/** Upstream failure classes the shim maps onto distinct HTTP answers. */
export type UpstreamErrorKind = 'hard_credit'
/**
 * The upstream's own volume limit (business code 6004, or a 429 whose body
 * names a reset time). A statement about the ACCOUNT: it comes with a
 * timestamp, it lasts, and another account is a real way around it.
 */
 | 'soft_rate'
/**
 * MODEL-scoped throttling with no stated time (business code 14003).
 *
 * Deliberately its own kind, because treating it as {@link soft_rate} is a
 * 30x amplification of an upstream that says "wait about a minute" — and it
 * makes the pool walk every account into the same wall (issue #56).
 *
 * The evidence that this is the MODEL's load and not the account's, measured
 * on one credential at one moment, byte-identical requests differing ONLY in
 * the `model` field, three attempts each:
 *
 *   | model                  | multiplier | ok  | failures   |
 *   | ---                    | ---        | --- | ---        |
 *   | deepseek-v4.1-flash    | x0.00      | 1/3 | 429 / 14003 |
 *   | deepseek-v4.1-flash-sg | x0.03      | 1/3 | 429 / 14003 |
 *   | glm-5.3-flash          | x0.06      | 3/3 | —          |
 *   | hy3                    | x0.00      | 3/3 | —          |
 *   | kimi-k2.6              | x0.77      | 3/3 | —          |
 *
 * The same account served other models at the same second, so the credential
 * was fine. The upstream's own words agree: "Wait about a minute before
 * retrying, or switch to a less busy model." Both halves are rendered to the
 * user; the second one is the actual remedy.
 */
 | 'model_busy' | 'session_dead' | 'policy_reject'
/**
 * The upstream restricted THIS account for unusual activity (issue #127).
 *
 * Kept separate from {@link policy_reject}, even though both arrive as the
 * `11140` family with the same `msg: "request illegal"`: that one is a CONTENT
 * decision and switching accounts cannot help, while this is a CREDENTIAL
 * decision and switching is exactly the remedy. `displayMsg` is the only
 * discriminator upstream provides ("账号存在异常行为，已被限制使用" / "restricted
 * due to unusual activity").
 */
 | 'account_restricted'
/**
 * The gateway's channel gate refused the request itself (business code
 * 11128, "Illegal API invocation from an unapproved channel").
 *
 * Deliberately its own kind, because its `displayTips` — "this call failed
 * channel verification, possibly because it was not sent from an official
 * client" — names the account or the client version, and NEITHER is the
 * cause. The gate matches the OPENING of a `system` message against a list of
 * known third-party-agent prompts, so the same credential answers 200 to a
 * probe and 400 to a real chat request one second later (issues #87 / #88 /
 * #89 / #90). Filing it as `client` was technically true and practically
 * useless: the generic "refused on its parameters" sentence left the reader
 * to try another account, which cannot change a byte of the prompt.
 *
 * NOT failover-worthy for the same reason: every account sends the same
 * system prompt, so a second account answers the same 11128 one round trip
 * later and each attempt teaches the pool a false fact about a credential
 * that was never the problem.
 */
 | 'channel_reject'
/**
 * The upstream put this request in a queue instead of running it: business
 * codes `6020` (waiting, with a position), `6021` (queue full), `6022` (this
 * user already holds the maximum). See `src/queue.ts`.
 *
 * Its own kind because it is the ONE failure where the credential was fine,
 * the request was fine, and the server already accepted the work — telling the
 * user "请求失败" or rotating accounts is wrong on both counts. A queued
 * request follows the MODEL and the shared queue, not the account, so another
 * account is handed the same position: NOT failover-worthy (see
 * `isFailoverWorthy` in the shim).
 *
 * Classified BEFORE the plain status branches: the queue condition arrives as
 * a business code and the HTTP status it rides on is incidental (observed on
 * 200-shaped envelopes and on 429/500). Without this member it fell through to
 * `server`/`soft_rate`, both of which DO fail over — so hitting a queue walked
 * the whole account pool, burning a real request per account, before saying
 * "you are #8777 in line".
 */
 | 'model_queue' | 'not_found' | 'server' | 'client';

/** Reasoning capability as the upstream catalog declares it. */
export interface WorkBuddyReasoning {
    supportedEfforts?: readonly string[];
    defaultEffort?: string;
    canDisableThinking?: boolean;
    /**
     * An OBSERVED refusal of the `off` tier for this model (issue #83).
     *
     * Never declared by the upstream: it is stamped from this plugin's own
     * refusal record, and it outlives the catalog that witnessed it so the card
     * can keep showing the badge after a refresh. `undefined` means "never
     * observed", which is not the same claim as "accepts".
     */
    refusesOff?: boolean;
}

/** One CLI-usable model, carrying everything the plugin card displays. */
export interface WorkBuddyUpstreamModel {
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
    /** Credit multiplier parsed from the upstream `credits` string. */
    creditMultiplier?: number;
    /**
     * Upstream's OWN image-input default, parsed from `supportsImages` with
     * `disabledMultimodal: true` as a veto. This is only a PRE-FILL for the
     * card's image checkboxes on "Refresh from WorkBuddy" (the refreshed draft
     * overwrites the saved image selection with the models advertising this):
     * it is not itself the runtime capability.
     *
     * The effective flag stays {@link multimodal}, stamped at runtime from the
     * user's saved `imageModelIds` — so a user can still uncheck an upstream-
     * advertised model, and the checked state only changes on an explicit
     * refresh/save.
     */
    supportsImages?: boolean;
    /**
     * Effective image-input support at runtime, decided by the saved
     * `imageModelIds` (which a model refresh pre-fills from {@link supportsImages}
     * but the user can edit before saving). Never inferred directly by the
     * catalog parser — see `withImageSelection` in `index.ts`.
     */
    multimodal?: boolean;
    reasoning?: WorkBuddyReasoning;
    descriptionZh?: string;
    descriptionEn?: string;
    supportsToolCall?: boolean;
    unavailable?: string;
    /**
     * The upstream's own promotion / tier badges that name THIS model.
     *
     * Not a field of the model entry: the upstream publishes the badges in
     * sibling arrays keyed by `modelIds` (`data.modelPromotions` /
     * `data.modelTiers`), inside the SAME `/v3/config` document that carries
     * the roster — so reading them costs no extra request.
     *
     * They ride along UNRESOLVED, and that is deliberate: a badge is a function
     * of the clock (the upstream's windows are wall-clock hours in a named
     * zone), so the entry that holds NOW is decided where the badge is drawn,
     * not where the document was read. See `src/promo.ts`.
     */
    promos?: readonly WorkBuddyPromo[];
    /**
     * How busy this model is RIGHT NOW, from the upstream's own probe
     * (`POST /v2/chat/busy`, see `src/busy.ts`).
     *
     * Deliberately NOT part of the catalog document, and deliberately not
     * persisted: the directory is a fact that survives a restart, a load level is
     * a fact about the minute it was measured. It is stamped onto the in-memory
     * catalog entry at refresh time and disappears with the process.
     */
    busyLevel?: WorkBuddyBusyLevel;
}

/** One billing package as the upstream returns it, dates already parsed. */
export interface WorkBuddyCreditPackage {
    packageName: string;
    capacityType?: number;
    remainingKnown?: boolean;
    totalKnown?: boolean;
    /**
     * Remaining credit, always read from the CYCLE family (issue #58).
     *
     * The upstream reports a monthly resource (`CapacityType 4`) with TWO
     * capacity families, and for a long time this field carried the POOL one on
     * the theory that the pool answers "how much do I have" (issue #48). That was
     * wrong, and the official client settles it: on a live CN account the client
     * shows `总剩余积分 2,196.61` = `套餐基础积分 500` + `平台奖励积分 1,696.61`,
     * which is EXACTLY Σ `CycleCapacityRemainPrecise` over the same response
     * (1696.61 + 500), while Σ `CapacityRemain` is 2,196 — the pool figure lands
     * on the right integer only because that account's cycle is untouched, and
     * the cent is what proves which family the client reads.
     *
     * The pool family is not a balance at all: on a monthly resource whose cycle
     * is fully spent it still reports `CapacityRemain=500, CapacityUsed=0`, i.e.
     * "nothing used, everything left", while the cycle reports
     * `CycleCapacityUsed=500`. Read as a balance it OVER-reports by the whole
     * monthly allowance of every account (measured on 8/8 CN accounts: pool and
     * cycle agree only where the cycle is untouched).
     *
     * Independent confirmation comes from the international gateway: three global
     * accounts report `CapacityRemain=100` while the gateway REFUSES their chat
     * requests with `14018 Credits exhausted`, so the pool figure is not spendable
     * credit there either.
     *
     * A gift (`CapacityType 1`) carries both families with identical values, so
     * reading the cycle uniformly costs nothing and removes the branch that
     * produced the defect.
     */
    remain: number;
    /** The package's capacity, from the same family as {@link remain}. */
    size: number;
    /** CapacityType 4: refreshed every cycle and never expires. */
    monthly: boolean;
    /** Next cycle start (the monthly refresh point); only on monthly packages. */
    refreshAtMs?: number;
    /** One-off expiry; the package disappears from the account at this time. */
    expiresAtMs?: number;
}

/** Aggregated credit answer for one credential. */
export interface WorkBuddyCredits {
    total: number;
    packages: readonly WorkBuddyCreditPackage[];
    /** Credits expiring within 3 days across every package. */
    expiringSoon: number;
    /** When the nearest package expires, in ms. */
    nearestExpiryMs?: number;
}

/** Daily check-in activity state. */
export interface WorkBuddyCheckinStatus {
    active: boolean;
    todayCheckedIn: boolean;
    streakDays: number;
    dailyCredit: number;
    todayCredit: number;
    isStreakDay: boolean;
    nextStreakDay: number;
    streakBonusDays: number;
    streakBonusCredit: number;
    claimButtonText?: string;
}

/** Daily check-in claim result. */
export interface WorkBuddyCheckinClaim {
    credit: number;
    streakDays: number;
    isStreakDay: boolean;
}

/**
 * One promotional benefit the account may or may not still be entitled to.
 *
 * Read from the billing gateway's OWN status endpoints — the same two the
 * 「套餐与积分」 page calls before it decides whether to render a claim card
 * (`/billing/meter/compensation-status`, `/billing/meter/check-gift-claimed`).
 * Reading them is what makes the card honest: the plugin shows a benefit only
 * while the gateway itself would still show one.
 *
 * The two flags answer DIFFERENT questions and neither can be derived from the
 * other — this is the single most important fact about this shape, measured on
 * a real account pool:
 *
 *   - `active` is about the WINDOW, not about the reader. An account that has
 *     already claimed still reports `active: true` (observed: `claimed: true`
 *     together with `active: true` on a claimed gift), so `active` alone cannot
 *     mean "claimable".
 *   - `claimed` is about THIS account, and it survives the window: once the
 *     campaign lapses the endpoint keeps answering `claimed: false` with
 *     `active: false` (observed on every international account, whose campaign
 *     ended months ago).
 *
 * Hence a benefit is claimable exactly when {@link active} AND NOT
 * {@link claimed}. See `benefitOf` in `src/benefits.ts`.
 */
export interface WorkBuddyBenefit {
    /** Which campaign this is; the plugin renders one row per kind. */
    kind: 'compensation' | 'gift';
    /** The campaign is inside its window (empty, see: already claimed ≠ inactive). */
    active: boolean;
    /** This account has already taken it — permanently, even after the window. */
    claimed: boolean;
    /** Credits on offer, as the gateway states them. */
    creditNum: number;
    /** Window end, epoch ms. Absent when the gateway sent none it could parse. */
    endsAtMs?: number;
    /** Window start, epoch ms. Compensation omits it. */
    startsAtMs?: number;
    /** When this account claimed it, epoch ms. Only meaningful with `claimed`. */
    claimedAtMs?: number;
}

/**
 * The write half of each campaign: the endpoint that actually grants the
 * credits.
 *
 * Kept beside the status paths because they must move together: the pair is
 * what the 「套餐与积分」 page itself uses (`xp`/`vp` in its bundle), and a
 * campaign whose status is read from one path can only be claimed through its
 * matching claim path. Note the same absence of a `/v2` prefix.
 */
const BENEFIT_CLAIM_PATHS: Readonly<Record<WorkBuddyBenefit['kind'], string>> = {
    compensation: '/billing/meter/claim-compensation',
    gift: '/billing/meter/claim-gift',
};

/** Token refresh answer; fields the upstream omits stay absent. */
export interface WorkBuddyRefreshOutcome {
    accessToken: string;
    refreshToken?: string;
    expiresInSec?: number;
    domain?: string;
}

/** Chat answer: either a live SSE response or a classified failure. */
export type WorkBuddyChatResult = {
    ok: true;
    response: Response;
} | {
    ok: false;
    status: number;
    kind: UpstreamErrorKind;
    message: string;
    /** Structured fields lifted from a JSON failure body, when there were any. */
    detail?: UpstreamErrorDetail | undefined;
};

const CN_CHAT_BASE = 'https://copilot.tencent.com';

const CN_BILLING_BASE = 'https://www.codebuddy.cn';

const GLOBAL_BASE = 'https://www.workbuddy.ai';

/**
 * Legacy model-catalog path, kept only as the CN region's FALLBACK.
 *
 * This is the document the WorkBuddy *plugin* used to read, and it is NOT the
 * document the WorkBuddy *app* reads: the gateway answers it with the CLI
 * channel's roster, which carries neither the app's `auto` slot nor any
 * promotion feed. The free Hy4 tier that used to live here as a separate
 * `hy4-preview-f` record is gone as a record — measured 2026-10-21, both
 * channels list the paid `hy4-preview` (`x0.29`) — and the free tier is now
 * expressed as a promotion badge (`夜间免费`) in the app-channel document only.
 * So this path is strictly poorer than {@link GLOBAL_CONFIG_PATH}; it stays
 * only so that a gateway which stops serving the modern document degrades
 * instead of emptying the region.
 */
const MODELS_CATALOG_PATH = '/v2/enterprises/personal/models';

/**
 * Remote product-config path — the document the WorkBuddy app itself reads for
 * its model list, its prices AND its promotion badges.
 *
 * It is field-compatible with {@link MODELS_CATALOG_PATH} for every key
 * {@link parseUpstreamModel} reads, so one parser still serves both, and it
 * additionally carries `modelPromotions` / `modelTiers` — the promotion feed
 * no other path publishes (see {@link withPromos}).
 *
 * Which document this path answers depends on the CHANNEL the request claims
 * to be (see {@link PRODUCT_UA}); it does not depend on the host: `www.workbuddy.cn`,
 * `copilot.tencent.com`, `wb.tencentbuddy.com` and `www.codebuddy.cn` answer
 * byte-identically under the same header.
 */
const GLOBAL_CONFIG_PATH = '/v3/config';

/**
 * The chat channel's user agent — the identity the plugin's adapter speaks as.
 *
 * Chat is a different contract from configuration: the conversation-identity
 * triple (conversation id, session id, device id) is bound to this channel, and
 * the upstream bills and rate-limits it as the CLI agent. The plugin chats as
 * the CLI agent on purpose, so this stays {@link CLIENT_UA} everywhere the
 * request is a CHAT.
 */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';

/**
 * The product-config channel's user agent: the WorkBuddy APP's own product
 * identity, byte-for-byte the header the app sends.
 *
 * The app builds it in `buildVlmGatewayHeaders` (WorkBuddy 5.8.3) as
 *
 *     `User-Agent: WorkBuddy/<app> WorkBuddy/<app> CLI/<cli>`
 *
 * — the app version twice, the CLI version once — and sends it to
 * `/v3/config`; the app's own log reads
 * `fetch cloud product from url:https://www.workbuddy.cn/v3/config success`
 * with `{"user-agent":"WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0", …}`.
 *
 * It matters, because `/v3/config` answers a DIFFERENT product configuration
 * per client channel. Measured 2026-10-21, same token, same URL, only this
 * header differing (CN gateway):
 *
 *   | User-Agent                                    | `/v3/config` answer                    |
 *   | ---                                           | ---                                    |
 *   | `CLI/2.63.2 CodeBuddy/2.63.2` (CLI channel)   | 5 keys, 35 models, NO promotion feed    |
 *   | `WorkBuddy/5.8.3` (app channel, no CLI part)  | 18 keys, 37 models, no promotion feed   |
 *   | `WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0` | 22 keys, 62 models, 8 promos + 1 tier   |
 *
 * The CLI channel's answer is a strict SUBSET of the app channel's: it
 * publishes neither `modelPromotions` nor `modelTiers`. That is precisely why
 * the CN card showed no promotion badge while the WorkBuddy app showed one on
 * the very same account — the plugin was reading a document the upstream
 * publishes WITHOUT the feed, not a feed that does not exist.
 *
 * The version suffixes are inert — `WorkBuddy/1.0.0 CLI/2.63.2
 * CodeBuddy/2.63.2` answers identically — so what selects the document is the
 * CHANNEL the header claims, not the version in it.
 *
 * Global answers the same document under either app-shaped header (17 keys,
 * 28 models, 5 promotions + 1 tier, identical roster), so both regions read
 * `/v3/config` as {@link PRODUCT_UA}.
 */
const PRODUCT_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0';

/**
 * The app version inside {@link PRODUCT_UA}, for headers that need it alone.
 *
 * Derived from the UA instead of repeated as a literal: the `X-IDE-Version`
 * header (issue #132) must agree with what the UA claims, and two independent
 * literals is exactly how those two drift apart at the next version bump.
 */
const APP_VERSION = PRODUCT_UA.match(/WorkBuddy\/([^\s]+)/u)?.[1] ?? '5.8.3';

const JSON_TIMEOUT_MS = 30000;

const ERROR_BODY_LIMIT = 4096;

/**
 * Insufficient-credit markers.
 *
 * ENGLISH IS MATCHED CASE-INSENSITIVELY (see {@link classifyUpstreamError}) so
 * each entry is spelled once, lowercase. Chinese has no case, so those entries
 * are the upstream's own wording.
 *
 * `credits exhausted` is listed alongside `credit exhausted` because the
 * upstream ships the PLURAL — measured 2026-10-13 on a live `14018`:
 *
 *   {"error":{"data":{"code":14018,"msg":"Credits exhausted. Please visit the
 *    link below to purchase add-on packs and get more credits: …"}}}
 *
 * The singular-only entry silently missed it (`'credits exhausted.'.includes(
 * 'credit exhausted')` is FALSE — the `s` sits between the two words), so a
 * failure whose entire point is "go top up" was reported as "wait a bit" and
 * benched a healthy account for the 30-minute fallback. Both spellings are kept
 * because the gateway has been observed to change its wording; neither is
 * assumed to be the only one.
 */
const HARD_CREDIT_MARKERS: readonly string[] = [
    'insufficient credit', 'no credit', 'credit exhausted', 'credits exhausted',
    'out of credit', 'quota exceeded', 'quota exhaust', 'payment required',
    'credit not enough', 'not enough credit', 'credits not enough',
    '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
];

/**
 * Business code of the exhaustion refusal (`14018`).
 *
 * The CODE, not the prose — see {@link HARD_CREDIT_MARKERS} for the wording bug
 * this guards against. Marker tables rot in a way codes do not: the gateway can
 * reword its sentence without changing the contract it advertises, and the
 * failure is silent (the branch simply stops matching). A code cannot drift like
 * that, and matching it in quoted-key form keeps a request id that happens to
 * contain the digits from promoting an unrelated body.
 *
 * ONLY a corroborating signal, never a substitute: the code is checked in
 * addition to the markers, so a body that names the code AND reads as a policy
 * refusal still resolves by the marker table's order.
 */
const CREDITS_EXHAUSTED_CODE = '"code":14018';

/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS: readonly string[] = ['Offline user session not found', '12153'];

/**
 * The business code a failure envelope states, or `undefined` when it names none.
 *
 * WHY PARSE RATHER THAN SEARCH THE TEXT. The five marker constants below this
 * file used to look for the quoted-key form (`'"code":11140'`) with `includes`,
 * which is exact only for ONE serialization: measured behaviour of the real
 * gateway is compact JSON, so it worked. It is nonetheless a spelling test
 * dressed up as a code test, and two spellings that a proxy, a re-serializer or
 * a nested envelope can produce fell through it — `{"code": 11140}` (a space) and
 * `"code":"11140"` (a string). The consequence of a MISS is not neutral: with no
 * policy marker and no channel marker, the body classifies as `client`, and
 * `outcomeOfFailure(403, …)` then answers `credential-rejected`, which marks a
 * perfectly healthy account as SIGNED OUT and benches it (issue #127 review).
 *
 * Reading the field is exact for all three spellings and for the nested
 * `{"error":{"data":{"code":…}}}` shape this file already documents at the
 * credit markers. `JSON.parse` also decodes `\uXXXX` escapes, which raw-text
 * matching cannot see (see {@link isAccountRestrictedBody}).
 *
 * The body arrives TRUNCATED to {@link ERROR_BODY_LIMIT}, so a parse failure is
 * normal for a large HTML error page and falls back to the compact/spaced text
 * forms rather than reporting no code. A request id is hexadecimal and can
 * contain `11140` by coincidence, which is why the fallback anchors on the
 * quoted key and a digit boundary rather than the bare digits.
 */
function businessCodeOf(body: string): number | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body) as unknown;
    }
    catch {
        const match = /"code"\s*:\s*"?(\d{4,6}(?!\d))/u.exec(body);
        return match?.[1] === undefined ? undefined : Number(match[1]);
    }
    if (typeof parsed !== 'object' || parsed === null)
        return undefined;
    const raw = parsed as Record<string, unknown>;
    const direct = asBusinessCode(raw['code']);
    if (direct !== undefined)
        return direct;
    // The documented credit shape nests its verdict: {"error":{"data":{"code":…}}}.
    const error = raw['error'];
    if (typeof error === 'object' && error !== null) {
        const data = (error as Record<string, unknown>)['data'];
        if (typeof data === 'object' && data !== null) {
            const nested = asBusinessCode((data as Record<string, unknown>)['code']);
            if (nested !== undefined)
                return nested;
        }
    }
    const data = raw['data'];
    if (typeof data === 'object' && data !== null) {
        return asBusinessCode((data as Record<string, unknown>)['code']);
    }
    return undefined;
}

/** One code field, accepting the number and the string spelling alike. */
function asBusinessCode(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isInteger(value))
        return value;
    if (typeof value === 'string' && /^\d{4,6}$/u.test(value.trim()))
        return Number(value.trim());
    return undefined;
}

/** The `11140` content-policy family, whatever the envelope's JSON spelling is. */
const CONTENT_POLICY_CODE = 11140;

/**
 * Content-policy refusal markers from the chat gateway. The quoted-key form
 * avoids substring hits inside unrelated values (request ids are hex and can
 * contain `11140` by coincidence).
 *
 * `request illegal` is deliberately absent: the live `11128` channel-gate body
 * uses the SAME `msg`, so this marker used to run first and classify that gate
 * as `policy_reject`. The consequence was severe — the channel rescue ladder
 * never ran, the reply changed 400 to 403, and users were told to switch
 * accounts for a request-side refusal (issue #127).
 */
function isContentPolicyBody(body: string): boolean {
    return businessCodeOf(body) === CONTENT_POLICY_CODE;
}

/**
 * Whether a failure body is the account-restriction member of the `11140`
 * family (issue #127).
 *
 * TWO HALVES MUST BOTH HOLD — the business code `"code":11140` AND one of the
 * restriction spellings. This is the same rule this file already applies to the
 * `11128` family after issue #127: a bare sentence never classifies anything,
 * because it is text that can appear anywhere.
 *
 * WHY THE CODE HALF IS NOT OPTIONAL HERE. The verdict is the heaviest in the
 * classifier: `account_restricted` is failover-worthy AND benches the account
 * with NO cooldown — nothing but a re-authorisation returns it. Measured before
 * the code was required (see `classifyUpstreamError`), a body that merely
 * MENTIONS the phrase classified as `account_restricted` whatever else it was:
 * a 402 credit exhaustion, a 401 dead session, and even a 500 whose generic
 * `retry later` text happened to contain the words. Each of those would have
 * taken an account permanently out of the pool for a condition that was about
 * the wallet, the token, or the platform. The code half is what keeps a heavy,
 * non-self-healing verdict pinned to the one business code that states it.
 *
 * Both measured `displayMsg` spellings are recognised (the Chinese sentence and
 * its English translation). A `11140` body carrying neither stays
 * `policy_reject`: inventing an account verdict from the shared code alone would
 * bench an account over a request-side refusal — the mirror-image error, which
 * the code half must not be allowed to fix by loosening the phrase half.
 */
const ACCOUNT_RESTRICTED_MARKERS: readonly string[] = [
    '账号存在异常行为',
    'restricted due to unusual activity',
];

/**
 * Whether a failure body is the account-restriction member of the `11140` family.
 *
 * Three separations make this decision safe, and all three were earned by the
 * issue #127 review:
 *
 * 1. **Code-gated.** Only a `11140` envelope can reach the phrase test
 *    ({@link isContentPolicyBody}). The phrase alone is not evidence about the
 *    account: a risk-control throttle, a credit notice or an HTML edge page can
 *    carry the same sentence, and this verdict is the only IRREVERSIBLE one in
 *    the classifier — it benches the account with no cooldown.
 * 2. **Decoded text.** The match runs on `displayMsg` / `displayTips` / `msg`
 *    after `JSON.parse`, not on the raw bytes. An upstream or proxy that
 *    serializes non-ASCII as `\uXXXX` (Python's `json.dumps` default) would
 *    otherwise never match the Chinese sentence, and a restriction would silently
 *    degrade to a content refusal. Matching the FIELD rather than the whole body
 *    also stops the phrase in an unrelated field from deciding the class.
 * 3. **Whitespace-normalized.** A line break inside the sentence survives as
 *    `\n` in raw JSON and as real whitespace once parsed; collapsing runs of
 *    whitespace means both spellings match.
 */
function isAccountRestrictedBody(body: string): boolean {
    if (!isContentPolicyBody(body))
        return false;
    const haystack = accountVerdictText(body);
    if (haystack === '')
        return false;
    return ACCOUNT_RESTRICTED_MARKERS.some(marker => haystack.includes(normalizeVerdictText(marker)));
}

/** The sentences an account verdict can be stated in: display fields, then `msg`. */
function accountVerdictText(body: string): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body) as unknown;
    }
    catch {
        // Non-JSON (an edge page, or a body truncated mid-envelope): fall back to the
        // text this function is about, with the same normalization applied.
        return normalizeVerdictText(body);
    }
    if (typeof parsed !== 'object' || parsed === null)
        return '';
    const raw = parsed as Record<string, unknown>;
    const parts = [
        localizedText(raw['displayMsg']),
        localizedText(raw['displayTips']),
        typeof raw['msg'] === 'string' ? raw['msg'] : undefined,
    ].filter((value): value is string => typeof value === 'string');
    return normalizeVerdictText(parts.join(' '));
}

/** NFKC, zero-width stripped, whitespace runs collapsed, lower-cased. */
function normalizeVerdictText(text: string): string {
    return text
        .normalize('NFKC')
        .replace(/[\u200b-\u200d\ufeff]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
        .toLowerCase();
}

/**
 * A `11140` body whose display fields decode to NOTHING at all.
 *
 * THE FAILURE MODE THIS CATCHES. `isAccountRestrictedBody` needs the business
 * code AND a phrase in `displayMsg` / `displayTips` / `msg` — deliberately, so a
 * shared sentence cannot bench an account. The mirror risk is a MISS: if the
 * upstream renames those fields, escapes them differently, or moves the
 * restriction wording somewhere new, every restriction degrades silently to
 * `policy_reject` and a benched-worthy account keeps taking traffic with no log
 * line anywhere. A genuine content refusal always carries the fields (its whole
 * point is a human-facing sentence), so a `11140` that decodes to no display
 * text at all is an anomalous envelope shape, not a normal refusal — exactly the
 * narrow condition worth a warning. Bodies WITH display text that merely lack
 * the restriction phrase are the everyday `policy_reject` and stay silent.
 *
 * Pure and side-effect-free: the caller (the transport layer, which holds the
 * injected logger) decides what to do with the answer.
 */
export function isUndecodablePolicyBody(body: string): boolean {
    return isContentPolicyBody(body) && accountVerdictText(body) === '';
}

/**
 * Business code of the MODEL-scoped throttle (`14003`, "too many requests").
 *
 * The quoted-key form for the same reason as the policy markers: a request id is
 * hexadecimal and can contain the digits `14003` by coincidence, and a bare
 * substring search over an arbitrary failure body is how a red herring gets
 * promoted into a routing decision.
 */
const MODEL_BUSY_CODE = '"code":14003';

/**
 * Business code of the gateway's CHANNEL gate (`11128`, "Illegal API invocation
 * from an unapproved channel").
 *
 * The quoted-key form for the same reason as the markers above: a request id is
 * hexadecimal and can contain the digits `11128` by coincidence.
 *
 * A DIFFERENT gate from the one {@link conversationHeaders} works around, which
 * also answers `11128` (`conversation id missing`). The code is the same
 * because the gateway reuses it for every rule in that family; the BODY is what
 * tells them apart, so {@link isChannelRejectBody} requires both halves.
 */
const CHANNEL_REJECT_CODE = '"code":11128';

/**
 * Whether a failure body is the MODEL-scoped throttle rather than an account
 * limit.
 *
 * `14003` and `6004` are different codes from the same gateway and mean
 * different things. Measured on one credential at one moment, with requests that
 * differed ONLY in `model`, three attempts each: `deepseek-v4.1-flash`
 * (multiplier x0.00) answered 1/3 and refused 2/3 with `429 / 14003`, while
 * `glm-5.3-flash`, `hy3` and `kimi-k2.6` answered 3/3 — the SAME account, the
 * SAME second. A 6004, by contrast, carries a `将在 … UTC+8 重置` sentence and
 * is per-account.
 *
 * So the criterion is the CODE alone, matched in its quoted-key form so a
 * request id that happens to contain the digits cannot promote it. Exported so
 * the probe and the chat path cannot drift into two different answers about one
 * body.
 */
export function isModelBusyBody(body: string): boolean {
    return body.includes(MODEL_BUSY_CODE);
}

/**
 * Whether a failure body belongs to the `11128` gate family AT ALL.
 *
 * The code is matched in its quoted-key form (`"code":11128`): a request id is
 * hexadecimal and can contain the digits `11128` by coincidence, and a bare
 * substring search over an arbitrary failure body is how a red herring gets
 * promoted into a diagnosis.
 */
export function isChannelGateFamilyBody(body: string): boolean {
    return body.includes(CHANNEL_REJECT_CODE);
}

/**
 * Whether a failure body is the gateway's CHANNEL gate — i.e. whether it
 * belongs to the `11128` FAMILY.
 *
 * ISSUE #113, AND WHY THIS NOW ANSWERS "IS IT THE FAMILY" RATHER THAN "IS IT
 * THE PROMPT MEMBER". The family has three members (prompt fingerprint,
 * missing conversation id, missing system head) sharing one business code and
 * one `displayTips` sentence, so the `msg` wording used to be the only thing
 * that could tell them apart — and the wording is NOT reliable. Issue #113
 * measured a CN refusal whose `msg` read `conversation id missing` while the
 * three conversation-id headers were all present and correct; the refusal was
 * about the request's CONTENT.
 *
 * The old rule required the channel wording AND the absence of the sibling
 * wordings, so such a body was excluded from the channel gate entirely and
 * filed as a plain `client`. That was not cosmetic: `client` never enters the
 * plugin's two-step retry ladder (`forceNeutralHead`, then the invisible
 * perturbation), so the rescue path that exists for precisely this refusal
 * never ran. That is very likely why the reporters in issue #98's thread found
 * that upgrading changed nothing.
 *
 * Every member of this family is a CHANNEL-verification refusal — the
 * upstream's own shared sentence says so — so acting on the family is correct
 * whoever the member is. Which member it is decides only what the reply
 * ADVISES, and that is {@link channelGateMemberOf}'s job, decided by the
 * plugin's own evidence rather than by a wording the upstream may misreport.
 *
 * The code is matched in its quoted-key form (`"code":11128`): a request id is
 * hexadecimal and can contain the digits `11128` by coincidence, and a bare
 * substring search over an arbitrary failure body is how a red herring gets
 * promoted into a diagnosis.
 */
export function isChannelRejectBody(body: string): boolean {
    return isChannelGateFamilyBody(body);
}

/**
 * Classify an upstream failure from its HTTP status and body excerpt.
 *
 * The `11128` family is classified BY ITS CODE, not by the `msg` wording —
 * see {@link isChannelRejectBody} and {@link channelGateMemberOf}. Which
 * member of the family it is decides the ADVICE in the reply, never the
 * classification: every member is a channel-verification refusal that no
 * account, region or top-up can change.
 */
export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
    if (status === 402)
        return 'hard_credit';
    const lower = body.toLowerCase();
    for (const marker of HARD_CREDIT_MARKERS) {
        if (lower.includes(marker.toLowerCase()) || body.includes(marker))
            return 'hard_credit';
    }
    // The code path, for the same class of failure. Kept INSTEAD OF trusting the
    // markers alone rather than replacing them: the live `14018` body spells
    // "Credits exhausted.", which the singular marker missed outright (see
    // HARD_CREDIT_MARKERS), and a wording change must not be able to silently
    // downgrade "go top up" into "wait a bit" again.
    //
    // Ordered with the markers, i.e. BEFORE `model_busy`: a body carrying both an
    // exhaustion code and a throttling code still resolves to the actionable,
    // wallet-shaped answer.
    if (body.includes(CREDITS_EXHAUSTED_CODE))
        return 'hard_credit';
    for (const marker of SESSION_DEAD_MARKERS) {
        if (body.includes(marker))
            return 'session_dead';
    }
    // The account-restriction member of the `11140` family must be split BEFORE
    // the content-policy answer: both reuse `msg: "request illegal"`, and only
    // `displayMsg` distinguishes them. A restricted credential is an ACCOUNT
    // problem (issue #127): another account is the only useful next move, and the
    // pool must bench this one. Treating it as `policy_reject` instead made every
    // request burn a doomed attempt on the restricted account, then switch while
    // being told the account itself was fine.
    //
    // PLACED HERE — inside the `11140` branch it splits — rather than as the
    // classifier's first test: the code half is what makes that placement
    // equivalent for real `11140` bodies while a 402, 401 or 500 that merely
    // quotes the phrase cannot reach this line at all.
    if (isAccountRestrictedBody(body))
        return 'account_restricted';
    if (isContentPolicyBody(body))
        return 'policy_reject';
    // AFTER the policy markers so a body that really is a content refusal keeps
    // that (more specific) reply, and BEFORE the plain 400 fallback so the channel
    // gate stops being filed as `client` — the misclassification that sent issues
    // #87–#90's reporters through account swaps that could not help.
    //
    // ISSUE #113: the whole `11128` FAMILY is classified here, by code. The old
    // rule excluded a body carrying the conversation-id wording, on the theory
    // that it must be a header problem — but that wording is not reliable (a
    // content refusal was measured carrying it), and the exclusion pushed such
    // bodies into `client`, which skips the plugin's retry ladder entirely.
    // Which member it actually is now decides the reply's ADVICE only
    // (`channelGateMemberOf`), never whether the rescue path runs.
    if (isChannelRejectBody(body))
        return 'channel_reject';
    // BEFORE the plain 429 branch: a 14003 is a 429, and classifying it as
    // `soft_rate` is the whole of issue #56 — it made the pool treat a
    // model-scoped, second-scale throttle as a 30-minute per-account cooldown and
    // walk every account into the same wall.
    //
    // Checked AFTER the credit markers so a body carrying both ("insufficient
    // credit" alongside a throttling code) still reads as the actionable,
    // wallet-shaped failure: the user must top up, not retry.
    if (isModelBusyBody(body))
        return 'model_busy';
    // BEFORE the plain status branches, for the same reason as `model_busy`: a
    // queue condition is a BUSINESS CODE and the HTTP status it rides on is
    // incidental. Measured on the OpenAI-compatible channel it arrives with 200,
    // 429 and 500-shaped envelopes alike; classifying by status first made a
    // queue look like `server`/`soft_rate`, and both of those fail over — so one
    // queued request walked the entire account pool (a real request per account)
    // before the queue was even recognised.
    if (parseQueueAnswer(body) !== undefined)
        return 'model_queue';
    if (status === 429)
        return 'soft_rate';
    if (status === 404)
        return 'not_found';
    if (status >= 500)
        return 'server';
    if (status >= 400)
        return 'client';
    return 'client';
}

/** Structured fields lifted out of a JSON upstream failure body. */
export interface UpstreamErrorDetail {
    /** Numeric upstream error code, e.g. 11140 for a content-policy refusal. */
    upstreamCode?: number;
    /** Upstream request id — the handle support asks for. */
    requestId?: string;
    /**
     * The upstream's RAW `msg`, kept beside {@link displayMsg}.
     *
     * On the `11128` family this is the DIAGNOSTIC half — it is what names which
     * gate fired ("conversation id missing", "first message is not system
     * prompt"), while `displayMsg` is the user-facing sentence the plugin must
     * NOT use as a diagnosis (issue #113 measured it to mislabel a content
     * refusal). Keeping both means a reply can echo what arrived AND say why it
     * is or is not believable, without one overwriting the other.
     */
    rawMsg?: string;
    /** Best human-facing message: `displayMsg.zh`, falling back to `.en`, then `msg`. */
    displayMsg?: string;
    /**
     * What the upstream says to DO about it: `displayTips.zh`, falling back to
     * `.en` (issue #78).
     *
     * Kept separate from {@link displayMsg} because the two answer different
     * questions and both are needed: `displayMsg` names what was rejected
     * ("模型无法处理此请求"), while `displayTips` names the REMEDY ("请新建任务、换个
     * 模型或稍后重试"). The generic failure path used to discard it and render the
     * raw body instead, whose first 400 characters are the `code`/`requestId`/
     * `extError` skeleton — so the one actionable sentence was always cut off, and
     * a plain parameter rejection read like an empty account pool.
     *
     * Recorded as data rather than folded into `displayMsg` so a caller that wants
     * to tell the user what to change can do so without the "what went wrong"
     * clause losing its own meaning.
     */
    tips?: string;
    /**
     * The request parameter the upstream named as rejected, from
     * `extError.param` (issue #83).
     *
     * Kept because the generic sentences cannot say WHICH parameter was at fault:
     * a 11133 caused by `reasoning_effort` reads exactly like a model that is
     * unavailable, and the fix (untick one checkbox) lives nowhere in the reply.
     */
    rejectedParam?: string;
    /** The offending value of {@link rejectedParam}, when the body carries one. */
    rejectedTier?: string;
}

/**
 * Read one of the upstream's localized fields, in either shape it ships: a plain
 * string, or a `{ zh, en }` object.
 *
 * One reader for every such field on purpose. `displayMsg` and `displayTips`
 * arrive in the same two shapes from the same envelope, so parsing them with two
 * separate hand-rolled branches is how one of them ends up only handling the
 * object form (which is exactly what happened to `displayTips`: it was never
 * read at all, issue #78).
 */
function localizedText(value: unknown): string | undefined {
    if (typeof value === 'string')
        return value;
    if (typeof value !== 'object' || value === null)
        return undefined;
    const localized = value as Record<string, unknown>;
    const pick = localized.zh ?? localized.en;
    return typeof pick === 'string' ? pick : undefined;
}

/**
 * Parse the known-good fields out of an upstream failure body. Non-JSON
 * bodies (HTML error pages, empty strings) yield undefined rather than a guess.
 */
export function parseUpstreamErrorDetail(body: string): UpstreamErrorDetail | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null)
        return undefined;
    const raw = parsed as Record<string, unknown>;
    // `msg` is the fallback only when `displayMsg` is absent: it is the raw
    // machine sentence ("the request parameters were rejected by the model
    // provider"), which is worse prose than `displayMsg` but far better than the
    // JSON skeleton the generic path used to print.
    const displayMsg = localizedText(raw.displayMsg)
        ?? (typeof raw.msg === 'string' ? raw.msg : undefined);
    const tips = localizedText(raw.displayTips);
    const detail: UpstreamErrorDetail = {};
    if (typeof raw.code === 'number')
        detail.upstreamCode = raw.code;
    if (typeof raw.requestId === 'string')
        detail.requestId = raw.requestId;
    if (typeof raw.msg === 'string' && raw.msg !== '')
        detail.rawMsg = raw.msg;
    if (displayMsg !== undefined)
        detail.displayMsg = displayMsg;
    if (tips !== undefined)
        detail.tips = tips;
    // `extError` carries the parameter-level verdict. Read defensively: it is
    // absent on most failures, and a malformed one must not cost the fields above.
    const ext = raw.extError;
    if (typeof ext === 'object' && ext !== null && !Array.isArray(ext)) {
        const extRaw = ext as Record<string, unknown>;
        const param = extRaw['param'];
        if (typeof param === 'string' && param !== '')
            detail.rejectedParam = param;
        const value = extRaw['value'];
        if (typeof value === 'string' && value !== '')
            detail.rejectedTier = value;
    }
    return detail;
}

/**
 * Region for a login domain; an empty domain means CN (matching upstream tooling).
 *
 * The international product is reachable under TWO brand domains: the WorkBuddy
 * AI desktop app signs in at `workbuddy.ai`, while the CodeBuddy CLI signs the
 * same international account in at `codebuddy.ai` (verified against a real
 * credential file, issue #4). Both are served by the same gateway stack — a
 * read-only probe shows `/v3/config` answering HTTP 200 with the same JSON
 * envelope on both hosts — so both classify as `global`. Missing the
 * `codebuddy.ai` spelling sent those tokens to the CN gateway, which rejected
 * them at the openresty layer with an HTML 401.
 */
export function regionOf(domain: string): WorkBuddyRegion {
    const lowered = domain.trim().toLowerCase();
    if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai'))
        return 'global';
    if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai'))
        return 'global';
    return 'cn';
}

/**
 * Gateway for a global credential.
 *
 * International accounts are NOT interchangeable across brand domains: a token
 * issued at `codebuddy.ai` is rejected by the `workbuddy.ai` gateway (and vice
 * versa), so the base must follow the credential's OWN domain rather than a
 * single hardcoded host. Anything unrecognised falls back to `workbuddy.ai`,
 * the desktop app's gateway.
 */
export function globalBase(domain: string): string {
    const lowered = domain.trim().toLowerCase();
    if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai'))
        return 'https://www.codebuddy.ai';
    return GLOBAL_BASE;
}

function chatBase(credential: WorkBuddyCredential): string {
    return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_CHAT_BASE;
}

function billingBase(credential: WorkBuddyCredential): string {
    return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_BILLING_BASE;
}

function originReferer(credential: WorkBuddyCredential): string {
    return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_BILLING_BASE;
}

/** Headers every upstream request shares. */
function commonHeaders(credential: WorkBuddyCredential): Record<string, string> {
    return {
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': originReferer(credential),
        'Referer': `${originReferer(credential)}/`,
        'User-Agent': CLIENT_UA,
    };
}

/**
 * The conversation-identity triple the chat endpoint now requires (issue #66).
 *
 * WHY THIS EXISTS. The international gateway added a second gate on top of the
 * `system`-head rule from 3.1.0: a chat request must carry the official desktop
 * client's conversation identity, or every step is refused with business code
 * `11128` / `conversation id missing`. That error's own `displayTips` blames
 * "渠道校验 / 不是官方客户端发出的", which reads as a client-identity problem —
 * the literal message is the actionable part, and it names a MISSING CONVERSATION
 * ID, not a missing or wrong user agent.
 *
 * The two gates are independent, and both must hold (measured 2026-10-16 on the
 * real international gateway, plugin body shape unchanged):
 *
 *   headers            messages          result
 *   -----------------  ----------------  --------------
 *   plugin as-shipped  ["system","user"] 400 / 11128
 *   plugin + triple    ["system","user"] 200
 *   plugin + triple    ["user"]          400 / 11128
 *
 * So `ensureSystemHead()` must NOT be dropped as "no longer needed": the system
 * rule went from sufficient to necessary-but-not-sufficient. The last row is what
 * keeps this function from being mistaken for a replacement for it.
 *
 * MINIMAL SET. The official bundle's `applyGatewayHeaders` also sends
 * `acp-connection-id`, `X-Agent-Intent` / `X-Agent-Purpose`, `X-IDE-*`,
 * `X-Private-Data` and trace headers. Bisecting them one at a time showed NONE of
 * those is required: `X-Conversation-Request-ID` and `-Message-ID` are needed
 * alongside `X-Conversation-ID` (that one alone still fails), and each of the
 * extras is satisfied by the triple without it. Hence exactly three.
 *
 * VALUES. The gateway does not verify where these ids come from — any well-formed
 * UUID passes — so nothing here is a secret and nothing is persisted. They are
 * still freshly generated per request, as the official client generates
 * its own per call: reusing one value across requests would forge a
 * conversation identity the plugin does not actually have, and the first thing
 * that would break is the upstream's own correlation of a session it is being
 * told about twice under one id.
 *
 * APPLIED TO BOTH REGIONS on purpose. The CN gateway tolerates their absence
 * today, so this is harmless there — and a header that is only ever sent on one
 * side is exactly how the 3.1.0 defect became international-only and invisible
 * from the CN side. One code path, both regions.
 *
 * @returns the three headers (four when the usage identity is on, which adds
 * `X-Request-ID`), every value distinct.
 */
function conversationHeaders(shape: 'chat' | 'image', identity: WorkBuddyWireIdentity = {}): Record<string, string> {
    // CHAT sends UUIDv7 in the 32-hex form the official client uses (issue #132),
    // plus `X-Request-ID` mirroring the message id: the gateway echoes that value
    // as the SSE `id` and writes it into the usage page, so a hyphenated v4 id
    // made one account's rows look like two different clients. Every value is
    // still generated per request.
    //
    // IMAGE keeps the hyphenated v4 it was measured with (2026-10-21: HTTP 200 at
    // both `copilot.tencent.com` and `www.workbuddy.cn`). #132's reporter measured
    // CHAT, not the image endpoint, and id FORMAT is not what the image gate asks
    // about — so that path keeps the bytes known to answer instead of being swept
    // into an untested shape by a display-fidelity change.
    // The v7 shape travels with the same switch as `X-IDE-*`: both are the
    // usage-page alignment the reporter measured, and neither is a gate.
    const officialIds = shape === 'chat' && identity.usageIdentity === true;
    const id = officialIds ? uuidv7 : randomUUID;
    const messageId = id();
    return {
        'X-Conversation-ID': id(),
        'X-Conversation-Request-ID': id(),
        'X-Conversation-Message-ID': messageId,
        ...officialIds ? { 'X-Request-ID': messageId } : {},
    };
}

/**
 * A 32-character lowercase UUIDv7, as the official client's request ids appear.
 *
 * WHY THE FORMAT MATTERS AT ALL (issue #132). The gateway echoes
 * `X-Conversation-Message-ID` back as the SSE `id`, and the WorkBuddy usage page
 * shows that value as the request id. Official traffic therefore shows
 * `01a169…`-style 32-hex ids, while this plugin's `randomUUID()` produced
 * hyphenated v4 ids — so the same account's usage page read as two different
 * clients, and a reporter comparing them concluded the plugin was not the
 * official client. Nothing upstream REJECTS a v4 id — the hyphenated v4 this
 * plugin has always sent is what answers 200 today — so this is a
 * display-fidelity fix, not a gate.
 *
 * Only the FORMAT is aligned, never the value's meaning: the timestamp prefix
 * is the moment this request was generated, which is exactly what a v7 id is
 * for. It is NOT a claim that these ids correlate with an official session —
 * the plugin still generates a fresh identity per request (see
 * {@link conversationHeaders}).
 */
export function uuidv7(nowMs = Date.now()): string {
    const bytes = randomBytes(16);
    // 48-bit big-endian unix timestamp in milliseconds.
    for (let index = 0; index < 6; index++) {
        bytes[index] = Math.floor(nowMs / 2 ** (8 * (5 - index))) & 0xff;
    }
    // Version 7 in the high nibble of byte 6, RFC 4122 variant in byte 8.
    bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
    bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
    return bytes.toString('hex');
}

/**
 * How the plugin should identify itself where the upstream only RECORDS the
 * request (issue #132). One switch, because the two halves are one decision.
 */
export interface WorkBuddyWireIdentity {
    /**
     * Adopt the official client's usage-page identity on chat requests.
     *
     * ON adds `X-IDE-Type` / `X-IDE-Name` / `X-IDE-Version` and switches the
     * conversation-identity triple to the 32-hex UUIDv7 shape the official client
     * uses (plus `X-Request-ID`, which mirrors the message id there).
     *
     * OFF by default, and the reason is the evidence tier, not the mechanism: the
     * reporter measured HTTP 200 on their own build of this PLUGIN at 5.3.1
     * (the WorkBuddy client itself was 5.8.3), and this plugin has not
     * reproduced that against the live gateway. Nothing in either gate is documented
     * as reading these headers — `11128`'s three doors are the message openings,
     * the missing conversation id and a non-system first message, none of which a
     * header can change — but this gateway has repeatedly refused requests for
     * reasons visible only in the answer, so a display-only alignment ships behind a
     * switch rather than as a silent upgrade for every account. `User-Agent` and the
     * request BODY are untouched either way.
     */
    usageIdentity?: boolean;
}

/**
 * The IDE identity headers the official desktop client sends on chat (issue #132).
 *
 * WHY. The gateway records the usage page's 使用端 (client) column from
 * `X-IDE-Name`, and it is EMPTY when the header is absent. The plugin has always
 * spoken the CLI channel — {@link CLIENT_UA}, which is correct for the chat
 * contract — but it sent no `X-IDE-*` at all, so every request this plugin made
 * appeared on the user's own usage page as an unidentified client while the
 * official app's requests read `WorkBuddy`. That is a reporting mismatch, not a
 * gate: the reporter measured that adding the header changes the usage column
 * and nothing else (HTTP 200, model unaffected).
 *
 * `X-IDE-Type` stays `CLI` on purpose. Claiming the desktop app's type as well
 * would be a bigger identity claim than the one this fix needs, and the mixed
 * CLI + WorkBuddy shape is what the reporter measured. The version comes from
 * {@link PRODUCT_UA} rather than a second hardcoded number, so the two cannot
 * drift apart when the app version is bumped.
 *
 * Sent only when {@link WorkBuddyWireIdentity.usageIdentity} is on — see that
 * field for the evidence tier behind the default.
 */
function ideHeaders(identity: WorkBuddyWireIdentity): Record<string, string> {
    if (identity.usageIdentity !== true)
        return {};
    return {
        'X-IDE-Type': 'CLI',
        'X-IDE-Name': 'WorkBuddy',
        'X-IDE-Version': APP_VERSION,
    };
}

/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential: WorkBuddyCredential, identity: WorkBuddyWireIdentity = {}): Record<string, string> {
    const headers: Record<string, string> = {
        ...commonHeaders(credential),
        'Content-Type': 'application/json',
        // 安全红线：chat 请求绝不携带 refresh token。
        ...credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid },
        ...credential.enterpriseId === undefined || credential.enterpriseId === ''
            ? { 'X-No-Enterprise-Id': '1' }
            : { 'X-Enterprise-Id': credential.enterpriseId },
        ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
        'X-Product': 'SaaS',
        ...ideHeaders(identity),
        ...conversationHeaders('chat', identity),
    };
    delete headers['User-Agent'];
    return { ...headers, ...attributionHeaders() };
}

/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential: WorkBuddyCredential): Record<string, string> {
    const headers: Record<string, string> = {
        ...commonHeaders(credential),
        'X-Refresh-Token': credential.refreshToken,
        'X-Auth-Refresh-Source': 'workbuddy',
    };
    if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
        headers['X-Enterprise-Id'] = credential.enterpriseId;
    }
    return headers;
}

/** Billing request headers. */
function billingHeaders(credential: WorkBuddyCredential): Record<string, string> {
    const headers: Record<string, string> = {
        'Authorization': `Bearer ${credential.accessToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    };
    if (credential.uid !== '')
        headers['X-User-Id'] = credential.uid;
    if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
        headers['X-Enterprise-Id'] = credential.enterpriseId;
        headers['X-Tenant-Id'] = credential.enterpriseId;
    }
    if (credential.domain !== '')
        headers['X-Domain'] = credential.domain;
    return headers;
}

/** One JSON-envelope response from the upstream, already unwrapped. */
interface Envelope {
    code: number;
    msg: string;
    data: unknown;
}

/**
 * Gateway (openresty/APISIX) rejection of a token it no longer accepts.
 *
 * The business APIs answer JSON; an edge rejection answers an HTML error page
 * instead. A 401 that is not JSON therefore means the credential was refused
 * before routing — almost always a revoked/expired token rather than a bug in
 * the request. Detected from the body so a proxy's own error page (which would
 * also be HTML) is still described accurately.
 */
function isGatewayAuthRejection(status: number, text: string): boolean {
    if (status !== 401 && status !== 403)
        return false;
    const lower = text.toLowerCase();
    return lower.includes('openresty') || lower.includes('apisix') || lower.includes('authorization required');
}

/** Marker carried by {@link WorkBuddyCredentialRejectedError}; survives bundling. */
export const CREDENTIAL_REJECTED_CODE = 'WORKBUDDY_CREDENTIAL_REJECTED';

/**
 * The upstream refused the CREDENTIAL itself rather than failing the request.
 *
 * This is a distinct, actionable class: the token is not usable and no retry
 * with the same token will help. Callers use it to tell the user what to do
 * about it (switch accounts, or sign in again) instead of showing a raw HTTP
 * error, and the card must never confuse it with a transient upstream fault.
 *
 * Identified by {@link CREDENTIAL_REJECTED_CODE} rather than `instanceof`, so
 * the check keeps working when the caller and the thrower end up in different
 * module instances (bundled host half vs. a test's source import).
 */
export class WorkBuddyCredentialRejectedError extends Error {
    readonly code = CREDENTIAL_REJECTED_CODE;
    /** HTTP status the upstream answered with (401 or 403). */
    readonly status: number;
    constructor(status: number) {
        super(`workbuddy: the signed-in credential was rejected by the upstream gateway (http ${status}).`
            + ' The stored token is no longer accepted — most likely a stale credential file from an earlier'
            + ' sign-in was selected. Re-sign in to the WorkBuddy desktop app, then pick that account in the'
            + ' plugin card. Run `dsh-connect-workbuddy doctor` to list every discovered credential.');
        this.name = 'WorkBuddyCredentialRejectedError';
        this.status = status;
    }
}

async function readEnvelope(response: Response): Promise<Envelope> {
    const text = await response.text();
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        if (isGatewayAuthRejection(response.status, text)) {
            throw new WorkBuddyCredentialRejectedError(response.status);
        }
        throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`);
    }
    const document = parsed as Record<string, unknown>;
    const envelope: Envelope = {
        code: typeof document['code'] === 'number' ? document['code'] : 0,
        msg: typeof document['msg'] === 'string' ? document['msg'] : '',
        data: 'data' in document ? document['data'] : undefined,
    };
    return envelope;
}

/**
 * Parse the enterprise endpoint's `cycleResetTime` ("2026-11-01 00:00:00").
 *
 * The value carries NO timezone marker, and the official client renders it as
 * local wall-clock time (it is what the user sees in "resets on 11/01 00:00"),
 * so it is read as LOCAL time rather than as UTC. `Date.parse` on that shape is
 * implementation-defined, which is exactly why it is assembled by hand.
 */
function parseEnterpriseInstant(value: string): number | undefined {
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
    if (match === null) {
        const fallback = Date.parse(value);
        return Number.isNaN(fallback) ? undefined : fallback;
    }
    const [, y, mo, d, h, mi, se] = match;
    const parsed = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se ?? '0')).getTime();
    return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Fail an envelope whose business code is non-zero, classified like HTTP errors.
 *
 * A JSON body on a 401/403 is still a credential refusal: the edge answered in
 * the business shape, but the token is just as unusable, so it maps to the same
 * actionable error instead of a generic "client" failure.
 */
function envelopeError(status: number, envelope: Envelope): Error {
    if (status === 401 || status === 403)
        return new WorkBuddyCredentialRejectedError(status);
    const kind = classifyUpstreamError(status, envelope.msg);
    return new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`);
}

/**
 * Parse the upstream's `credits` string into a multiplier.
 *
 * Observed forms: `"x0.79 credits"`, `"x0.05"`, `"x0.00 credits"`,
 * and absent. Unparsable values yield undefined rather than a guess — the
 * card simply omits the rate instead of displaying a fabricated one.
 */
export function parseCreditMultiplier(value: unknown): number | undefined {
    if (typeof value !== 'string')
        return undefined;
    const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value);
    if (match === null)
        return undefined;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * The effort vocabulary the upstream's plural-form payloads declare across both
 * gateways (live union of every `supportedEfforts` list seen; `minimal` has
 * never appeared). Both gateways also accept every level in it on
 * singular-form models — medium/xhigh fold into high, low/max answer with
 * their own budgets — so the singular `effort` value is a DEFAULT, never the
 * model's only level.
 */
const SINGULAR_EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * The singular spelling of reasoning metadata: `effort` (plus the ignored
 * `summary`) and none of the plural-form fields. Observed on CN
 * `deepseek-v4.1-flash`/`kimi-k3-1`/`glm-5.2`… and global
 * `deepseek-v4.1-flash`/`kimi-k3`/`gemini-3.5-flash`… (issue #7).
 */
function isSingularEffortForm(raw: Record<string, unknown>): boolean {
    return typeof raw['effort'] === 'string'
        && !Array.isArray(raw['supportedEfforts'])
        && typeof raw['defaultEffort'] !== 'string'
        && typeof raw['canDisableThinking'] !== 'boolean';
}

/**
 * Fold a singular-form `effort` into the plural shape the rest of the plugin
 * already understands. Live probes on both gateways (issue #7) show these
 * models answer with distinct `reasoning_content` across the whole ladder —
 * and think NOT AT ALL when no `reasoning_effort` is sent — so the fold
 * widens `supportedEfforts` and carries the declared value into
 * `defaultEffort`. An unrecognized `effort` value passes through as the lone
 * level, leaving its fate to the adapter's known-level filter.
 */
function singularEffortLadder(raw: Record<string, unknown>): string[] | undefined {
    const effort = typeof raw['effort'] === 'string' ? raw['effort'] : undefined;
    if (effort === undefined)
        return undefined;
    return (SINGULAR_EFFORT_LADDER as readonly string[]).includes(effort) ? [...SINGULAR_EFFORT_LADDER] : [effort];
}

/**
 * Parse the upstream's `reasoning` object; unknown shapes degrade to `{}`.
 * Both spellings normalize here: the plural form passes through as declared,
 * and the singular `effort` form folds via {@link singularEffortLadder}.
 */
export function parseReasoning(value: unknown): WorkBuddyReasoning | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const raw = value as Record<string, unknown>;
    const effort = typeof raw['effort'] === 'string' ? raw['effort'] : undefined;
    const supportedEfforts = Array.isArray(raw['supportedEfforts'])
        ? raw['supportedEfforts'].filter((entry): entry is string => typeof entry === 'string')
        : singularEffortLadder(raw);
    const defaultEffort = typeof raw['defaultEffort'] === 'string' ? raw['defaultEffort'] : effort;
    const canDisableThinking = typeof raw['canDisableThinking'] === 'boolean'
        ? raw['canDisableThinking']
        : isSingularEffortForm(raw) ? true : undefined;
    if (supportedEfforts === undefined && defaultEffort === undefined && canDisableThinking === undefined) {
        return undefined;
    }
    return {
        ...supportedEfforts === undefined || supportedEfforts.length === 0 ? {} : { supportedEfforts },
        ...defaultEffort === undefined ? {} : { defaultEffort },
        ...canDisableThinking === undefined ? {} : { canDisableThinking },
    };
}

/** Keep every identified catalog entry. Token limits come only from declared maxInputTokens/maxOutputTokens. */
export function parseUpstreamModel(value: unknown): WorkBuddyUpstreamModel | undefined {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const raw = value as Record<string, unknown>;
    const id = typeof raw['id'] === 'string' ? raw['id'] : '';
    if (id === '')
        return undefined;
    const input = typeof raw['maxInputTokens'] === 'number' ? raw['maxInputTokens'] : 0;
    const output = typeof raw['maxOutputTokens'] === 'number' ? raw['maxOutputTokens'] : 0;

    const name = typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : id;
    const descriptionZh = typeof raw['descriptionZh'] === 'string' && raw['descriptionZh'] !== '' ? raw['descriptionZh'] : undefined;
    const descriptionEn = typeof raw['descriptionEn'] === 'string' && raw['descriptionEn'] !== '' ? raw['descriptionEn'] : undefined;
    const creditMultiplier = parseCreditMultiplier(raw['credits']);
    const reasoning = parseReasoning(raw['reasoning']);
    const supportsToolCall = typeof raw['supportsToolCall'] === 'boolean' ? raw['supportsToolCall'] : undefined;
    // Upstream's image-input default. `disabledMultimodal: true` is a hard veto
    // whenever `supportsImages` is true. That pair has not been seen to conflict
    // on live data (CN 2026-09-29: 0 contradictory entries of 30), so the veto is
    // defensive — it only decides which way to lean if upstream ever does. The
    // value pre-fills the card's checkboxes on refresh; the effective capability
    // stays the saved `imageModelIds`.
    const supportsImages = raw['disabledMultimodal'] === true
        ? false
        : typeof raw['supportsImages'] === 'boolean'
            ? raw['supportsImages']
            : undefined;
    return {
        id,
        name,
        unavailable: raw['disabled'] === true ? 'MODEL_DISABLED' :
            ['auto', 'default-model'].includes(id) ? 'AUTOMATIC_ROUTE_NOT_SUPPORTED' :
            Array.isArray(raw['tags']) && (raw['tags'] as unknown[]).some(t => ['text-to-image', 'image-to-image', 'text-to-video', 'image-to-video'].includes(String(t))) ? 'AGENT_INTERFACE_NOT_INCLUDED' : undefined,
        contextWindow: input,
        maxTokens: output,
        ...creditMultiplier === undefined ? {} : { creditMultiplier },
        ...supportsImages === undefined ? {} : { supportsImages },
        ...reasoning === undefined ? {} : { reasoning },
        ...descriptionZh === undefined ? {} : { descriptionZh },
        ...descriptionEn === undefined ? {} : { descriptionEn },
        ...supportsToolCall === undefined ? {} : { supportsToolCall },
    };
}

/**
 * Select the chat-capable models from a catalog-shaped document: parse every
 * entry, then keep the `cli` agent's roster in its declared order.
 *
 * Both the CN personal-models document and the global `/v3/config` document
 * carry `models` plus an `agents` roster with the same entry shape, so one
 * selector serves them. Without a usable `cli` roster the whole parsed catalog
 * is exposed rather than nothing: the roster is an upstream detail that may
 * change, and an empty answer would silently disarm the provider.
 *
 * ROUTERS ARE NOT MODELS. The upstream lists `auto` (CN) and its global
 * equivalents alongside real models, but those entries are ROUTING decisions,
 * not models: the gateway resolves them to whichever model it thinks fits, so
 * a row for one would offer a name whose price, context window and behaviour
 * are all decided at request time by something else. Selected this way it also
 * duplicates a real row — upstream resolves CN `auto` to `hy4-preview`, which
 * is already in the same roster. They are dropped here, at the single place
 * the roster is built, so the card, the picker, the probe and the discovery
 * route all agree. A user who already had one enabled keeps it through
 * `keepIds` below: this removes the OFFER, never a running model (issue #32's
 * failure mode).
 *
 * `keepIds` is the user's own selection riding along with the refresh. The
 * upstream roster may drop a model the user is actually running — the app
 * channel's `cli` roster dropped `minimax-m2.7` on 2026-10-21 while the SAME
 * document still publishes it (`x0.26`) and the chat endpoint still answers for
 * it (measured HTTP 200). A roster read is therefore the upstream's roster PLUS
 * the kept ids this document still lists: a refresh may add or withdraw
 * upstream models, but it never silently withdraws a model the user is on.
 */
export function selectCliModels(rawModels: unknown, agents: unknown, keepIds: readonly string[] = []): WorkBuddyUpstreamModel[] {
    const byId = new Map<string, WorkBuddyUpstreamModel>();
    for (const model of Array.isArray(rawModels) ? rawModels : []) {
        const parsed = parseUpstreamModel(model);
        if (parsed !== undefined)
            byId.set(parsed.id, parsed);
    }
    let cliIds: readonly string[] | undefined;
    for (const agent of Array.isArray(agents) ? agents : []) {
        if (typeof agent === 'object' && agent !== null) {
            const wrapped = agent as Record<string, unknown>;
            if (wrapped['name'] === 'cli' && Array.isArray(wrapped['models'])) {
                cliIds = wrapped['models'].filter((id): id is string => typeof id === 'string');
                break;
            }
        }
    }
    const ids = cliIds !== undefined && cliIds.length > 0 ? cliIds : [...byId.keys()];
    const models = ids
        .filter(id => !isRouterModelId(id))
        .map(id => byId.get(id))
        .filter((model): model is WorkBuddyUpstreamModel => model !== undefined);
    // `keepIds` is the user's own selection, carried so a refresh does not
    // withdraw a model the user is running (issue #32). A ROUTER is excluded here
    // too, and that filter is load-bearing rather than belt-and-braces: a profile
    // saved BEFORE routers were dropped still lists `auto`/`default-model` in
    // `enabledModelIds`, and without this line that stored id would be re-added
    // through the kept branch — resurrecting the exact row this version stops
    // offering, and doing it on every single refresh rather than once.
    const kept = keepIds
        .filter(id => !ids.includes(id) && !isRouterModelId(id))
        .map(id => byId.get(id))
        .filter((model): model is WorkBuddyUpstreamModel => model !== undefined);
    // Guard the ANSWER, not the upstream's share of it. A roster that is nothing
    // but routers still leaves the region usable through the kept ids, and
    // throwing before they were merged would turn "the upstream renamed its
    // router" into "the region has no models at all".
    const resolved = [...models, ...kept];
    if (resolved.length === 0)
        throw new Error('workbuddy model catalog resolved to an empty list');
    return resolved;
}

/**
 * The roster plus the promotion badges the SAME document carries.
 *
 * `data.modelPromotions` and `data.modelTiers` sit beside `data.models` in
 * the upstream's `/v3/config` document, so the badges cost no extra request:
 * they are read out of the response the roster was read from. Which models
 * they name is resolved here; WHICH badge holds at a given moment is not
 * (see `src/promo.ts` — a badge is a function of the clock).
 *
 * BOTH regions publish the feed, and they publish it in the app channel's
 * document: measured 2026-10-21 on the same accounts the app reads, CN
 * `/v3/config` carries 8 promotions + 1 tier badge (Chinese labels such as
 * `夜间折扣` / `限时免费` / `订阅优先`, with `schedule.daily` night windows),
 * and the global gateway carries 5 promotions + 1 tier badge. The feed is
 * absent only from the CLI channel's answer, which the plugin never reads a
 * product configuration as (see {@link PRODUCT_UA}).
 */
function withPromos(models: readonly WorkBuddyUpstreamModel[], data: Record<string, unknown>): readonly WorkBuddyUpstreamModel[] {
    const promos = parseWorkBuddyPromos(data['modelPromotions'], data['modelTiers']);
    return promos.length === 0 ? models : attachPromos(models, promos);
}

/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take
 * the credential explicitly so token refreshes apply on the next call.
 */
export class WorkBuddyUpstreamClient {
    /**
     * Reports an anomaly the reader or classifier had to tolerate.
     *
     * Injected rather than logged here because this module holds no logger on
     * purpose — it is pure transport + parsing, so it stays importable from
     * tests and the CLI without a cordis context. The host wires its
     * `ctx.logger.warn` in; without a host the event is dropped, which is the
     * same silence the previous single-source reader had.
     */
    constructor(private readonly onFallback?: (message: string) => void, private readonly identity: WorkBuddyWireIdentity = {}) { }
    /** POST the chat endpoint; a successful answer is the raw SSE response. */
    async chatStream(credential: WorkBuddyCredential, bodyJson: string, signal?: AbortSignal): Promise<WorkBuddyChatResult> {
        let response: Response;
        // Deliberately NO ceiling of our own here, unlike `probeChat`.
        //
        // A chat answer has to prefill the whole prompt before its first byte, and
        // that legitimately varies by an order of magnitude with context size — a
        // bound tight enough to matter would eventually cut a real answer short, and
        // cutting a real answer is worse than waiting for a slow one. What remains is
        // the caller's cancellation (the shim's controller, which aborts when the
        // client hangs up) plus the HTTP client's own default headers timeout.
        //
        // Detecting a DEAD endpoint is the probe's job, not this path's: the pool
        // tests liveness with a cheap fixed request (see `PROBE_TIMEOUT_MS`) and
        // excludes what does not answer. Bounding the real request as well would be a
        // second, far more expensive detector for the same fact.
        try {
            response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
                method: 'POST',
                headers: { ...chatHeaders(credential, this.identity), 'Authorization': `Bearer ${credential.accessToken}` },
                body: bodyJson,
                ...signal === undefined ? {} : { signal },
            });
        }
        catch (error: unknown) {
            return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` };
        }
        if (response.ok)
            return { ok: true, response };
        const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
        const kind = classifyUpstreamError(response.status, text);
        // Anomaly report, not a reclassification: the kind stands as classified.
        // The point is that a `11140` with no decodable display fields is the one
        // envelope shape in which a real restriction would be silently MISSED by
        // `isAccountRestrictedBody` — every such miss keeps a benched-worthy account
        // in rotation with nothing in the logs. Genuine content refusals carry their
        // display sentence, so they never reach this line.
        if (isUndecodablePolicyBody(text)) {
            this.onFallback?.(`11140 失败体没有任何可解码的 displayMsg/displayTips/msg 字段，` +
                `若上游调整了限制措辞或字段名，账号停权判定会全部漏判。` +
                `失败体片段：${text.slice(0, 200)}`);
        }
        return {
            ok: false,
            status: response.status,
            kind,
            message: text,
            detail: parseUpstreamErrorDetail(text),
        };
    }
    /** POST the token-refresh endpoint; the caller merges the outcome. */
    async refreshToken(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<WorkBuddyRefreshOutcome> {
        const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
            method: 'POST',
            headers: refreshHeaders(credential),
            signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(JSON_TIMEOUT_MS)]),
        });
        const envelope = await readEnvelope(response);
        if (!response.ok || envelope.code !== 0)
            throw envelopeError(response.status, envelope);
        const data = typeof envelope.data === 'object' && envelope.data !== null
            ? envelope.data as Record<string, unknown>
            : {};
        const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : '';
        if (accessToken === '')
            throw new Error('workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app');
        const outcome: WorkBuddyRefreshOutcome = { accessToken };
        if (typeof data['refreshToken'] === 'string' && data['refreshToken'] !== '')
            outcome.refreshToken = data['refreshToken'];
        if (typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0)
            outcome.expiresInSec = data['expiresIn'];
        if (typeof data['domain'] === 'string' && data['domain'] !== '')
            outcome.domain = data['domain'];
        return outcome;
    }
    /**
     * Read the model directory for the credential's region.
     *
     * Both regions read `/v3/config`, the document the WorkBuddy app itself
     * consumes, and both read it as the APP's product identity
     * ({@link PRODUCT_UA}) — the header the app sends, not the CLI channel's.
     * That is load-bearing, not cosmetic: the CLI channel's answer is a strict
     * subset of the app channel's and publishes neither `modelPromotions` nor
     * `modelTiers`, so reading `/v3/config` as the CLI channel is what left the
     * CN card without a single promotion badge while the app showed one on the
     * same account (see {@link PRODUCT_UA}).
     *
     * CN falls back to the legacy {@link MODELS_CATALOG_PATH} when `/v3` fails,
     * returns a non-zero envelope, or resolves to no usable model, so a gateway
     * that stops serving the modern document degrades to the previous roster
     * instead of leaving the region empty. The fallback is silent when unused and
     * reported when it fires, because a roster that silently differs from the
     * app's is exactly the bug this ordering exists to fix.
     *
     * No user-side toggle is involved: the region comes from the credential's
     * `domain`.
     *
     * `keepModelIds` is the user's own selection, passed through to
     * {@link selectCliModels}: a model the upstream roster dropped but the SAME
     * document still publishes stays in the roster, so reading the directory
     * never withdraws a model the user is running (issue #32's failure mode,
     * one step upstream of it).
     */
    async fetchModels(credential: WorkBuddyCredential, signal?: AbortSignal, keepModelIds: readonly string[] = []): Promise<readonly WorkBuddyUpstreamModel[]> {
        const timeout = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(JSON_TIMEOUT_MS)]);
        const global = regionOf(credential.domain) === 'global';
        if (global) {
            const response = await fetch(`${globalBase(credential.domain)}${GLOBAL_CONFIG_PATH}`, {
                headers: {
                    'Authorization': `Bearer ${credential.accessToken}`,
                    'Accept': 'application/json',
                    ...credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
                    ...credential.domain === '' ? {} : { 'X-Domain': credential.domain },
                    'X-Product': 'SaaS',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Connection': 'close',
                    'User-Agent': PRODUCT_UA,
                },
                signal: timeout,
            });
            const envelope = await readEnvelope(response);
            if (!response.ok || envelope.code !== 0)
                throw envelopeError(response.status, envelope);
            const data = typeof envelope.data === 'object' && envelope.data !== null
                ? envelope.data as Record<string, unknown>
                : {};
            return withPromos((Array.isArray(data['models']) ? data['models'] : []).map(parseUpstreamModel).filter((m): m is WorkBuddyUpstreamModel => !!m), data);
        }
        const readCatalog = async (path: string): Promise<readonly WorkBuddyUpstreamModel[]> => {
            const response = await fetch(`${chatBase(credential)}${path}`, {
                headers: {
                    'Authorization': `Bearer ${credential.accessToken}`,
                    'Accept': 'application/json',
                    'Origin': originReferer(credential),
                    'Referer': `${originReferer(credential)}/`,
                    'User-Agent': PRODUCT_UA,
                },
                signal: timeout,
            });
            const envelope = await readEnvelope(response);
            if (!response.ok || envelope.code !== 0)
                throw envelopeError(response.status, envelope);
            const data = typeof envelope.data === 'object' && envelope.data !== null
                ? envelope.data as Record<string, unknown>
                : {};
            return withPromos((Array.isArray(data['models']) ? data['models'] : []).map(parseUpstreamModel).filter((m): m is WorkBuddyUpstreamModel => !!m), data);
        };
        try {
            return await readCatalog(GLOBAL_CONFIG_PATH);
        }
        catch (error: unknown) {
            // Three failures land here, and all three want the fallback: a transport
            // error, a non-zero envelope, and an EMPTY roster — `selectCliModels`
            // throws on the last one, so a `/v3` that stops listing models degrades
            // rather than emptying the region.
            this.onFallback?.(`CN model catalog ${GLOBAL_CONFIG_PATH} failed; falling back to ${MODELS_CATALOG_PATH}: `
                + (error instanceof Error ? error.message : String(error)));
            return await readCatalog(MODELS_CATALOG_PATH);
        }
    }
    /** Query today's check-in status without changing account state. */
    async fetchCheckinStatus(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<WorkBuddyCheckinStatus> {
        const response = await fetch(`${billingBase(credential)}/v2/billing/meter/checkin-activity-status`, {
            method: 'POST',
            headers: billingHeaders(credential),
            body: '{}',
            signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(JSON_TIMEOUT_MS)]),
        });
        const envelope = await readEnvelope(response);
        if (!response.ok || envelope.code !== 0)
            throw envelopeError(response.status, envelope);
        const data = typeof envelope.data === 'object' && envelope.data !== null
            ? envelope.data as Record<string, unknown>
            : {};
        const numberField = (key: string): number => typeof data[key] === 'number' ? data[key] as number : 0;
        return {
            active: data['active'] === true,
            todayCheckedIn: data['today_checked_in'] === true,
            streakDays: numberField('streak_days'),
            dailyCredit: numberField('daily_credit'),
            todayCredit: numberField('today_credit'),
            isStreakDay: data['is_streak_day'] === true,
            nextStreakDay: numberField('next_streak_day'),
            streakBonusDays: numberField('streak_bonus_days'),
            streakBonusCredit: numberField('streak_bonus_credit'),
            ...typeof data['claim_button_text'] === 'string' && data['claim_button_text'] !== ''
                ? { claimButtonText: data['claim_button_text'] }
                : {},
        };
    }
    /**
     * Read every promotional benefit this account can still see, WITHOUT claiming
     * anything.
     *
     * The campaign list is closed and small on purpose: the gateway exposes one
     * status endpoint per campaign, so "discover benefits" is a fixed fan-out, not
     * a search. A new campaign type means a new `/billing/meter/*-status` endpoint
     * added here — the plugin never guesses at undocumented ones.
     *
     * Every endpoint is read in parallel because they are independent, and a
     * failure is per-endpoint: one campaign answering 5xx must not blank out the
     * other. The caller gets only what was actually read.
     *
     * Note the paths carry NO `/v2` prefix — these are not the `/v2/billing/meter`
     * family the credit and check-in calls use. Probing `/v2/...` answers 404, which
     * is how this distinction was found.
     */
    async fetchBenefits(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<readonly WorkBuddyBenefit[]> {
        const read = async (kind: WorkBuddyBenefit['kind'], path: string): Promise<WorkBuddyBenefit | undefined> => {
            try {
                return await this.readBenefitStatus(kind, credential, path, signal);
            }
            catch (error) {
                throw error;
            }
        };
        const [compensation, gift] = await Promise.all([
            read('compensation', '/billing/meter/compensation-status'),
            read('gift', '/billing/meter/check-gift-claimed'),
        ]);
        return [compensation, gift].filter((benefit): benefit is WorkBuddyBenefit => benefit !== undefined);
    }
    /** One benefit status endpoint. Throws on anything that is not a clean `code: 0`. */
    private async readBenefitStatus(kind: WorkBuddyBenefit['kind'], credential: WorkBuddyCredential, path: string, signal?: AbortSignal): Promise<WorkBuddyBenefit> {
        const response = await fetch(`${billingBase(credential)}${path}`, {
            method: 'POST',
            headers: billingHeaders(credential),
            body: '{}',
            signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(JSON_TIMEOUT_MS)]),
        });
        const envelope = await readEnvelope(response);
        if (!response.ok || envelope.code !== 0)
            throw envelopeError(response.status, envelope);
        const data = typeof envelope.data === 'object' && envelope.data !== null
            ? envelope.data as Record<string, unknown>
            : {};
        const numberField = (key: string): number => typeof data[key] === 'number' ? data[key] as number : 0;
        /** The gateway states times as `YYYY-MM-DD HH:MM:SS` in local time. */
        const timeField = (key: string): number | undefined => {
            const raw = data[key];
            if (typeof raw !== 'string' || raw.trim() === '')
                return undefined;
            const normalized=raw.replace(' ', 'T');
            const parsed = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/u.test(normalized) ? normalized : regionOf(credential.domain)==='cn' ? normalized+'+08:00' : 'invalid');
            return Number.isNaN(parsed) ? undefined : parsed;
        };
        const endsAtMs = timeField('end_time');
        const startsAtMs = timeField('start_time');
        const claimedAtMs = timeField('claimed_at');
        return {
            kind,
            active: data['active'] === true,
            claimed: data['claimed'] === true,
            creditNum: numberField('credit_num'),
            ...endsAtMs === undefined ? {} : { endsAtMs },
            ...startsAtMs === undefined ? {} : { startsAtMs },
            ...claimedAtMs === undefined ? {} : { claimedAtMs },
        };
    }
    /**
     * Claim one benefit campaign on ONE account (issue #79).
     *
     * This is a real credit grant on a real account, so it takes no account
     * argument other than the credential it is handed: the caller decides which
     * single account, and there is deliberately no batch form of this method. The
     * browser route is the only caller, and it guards the mutation with the same
     * POST + loopback checks the check-in route carries.
     *
     * The response is not parsed: the documented envelope of these two endpoints
     * is an empty success, and the caller re-reads the status afterwards. That
     * re-read, not this answer, is what the user is shown — which is why a claim
     * that silently did nothing still cannot leave the card saying 待领取.
     */
    async claimBenefit(credential: WorkBuddyCredential, kind: WorkBuddyBenefit['kind'], signal?: AbortSignal): Promise<void> {
        const response = await fetch(`${billingBase(credential)}${BENEFIT_CLAIM_PATHS[kind]}`, {
            method: 'POST',
            headers: billingHeaders(credential),
            body: '{}',
            signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(JSON_TIMEOUT_MS)]),
        });
        const envelope = await readEnvelope(response);
        if (!response.ok || envelope.code !== 0)
            throw envelopeError(response.status, envelope);
    }
    /** Claim today's check-in reward. The browser route guards this mutation. */
    async claimDailyCheckin(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<WorkBuddyCheckinClaim> {
        const response = await fetch(`${billingBase(credential)}/v2/billing/meter/daily-checkin`, {
            method: 'POST',
            headers: billingHeaders(credential),
            body: '{}',
            signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(JSON_TIMEOUT_MS)]),
        });
        const envelope = await readEnvelope(response);
        if (!response.ok || envelope.code !== 0)
            throw envelopeError(response.status, envelope);
        const data = typeof envelope.data === 'object' && envelope.data !== null
            ? envelope.data as Record<string, unknown>
            : {};
        const numberField = (key: string): number => typeof data[key] === 'number' ? data[key] as number : 0;
        return {
            credit: numberField('credit'),
            streakDays: numberField('streak_days'),
            isStreakDay: data['is_streak_day'] === true,
        };
    }
    /**
     * The ENTERPRISE credit table (issue #124).
     *
     * `/v2/billing/meter/get-user-resource` answers an enterprise member with
     * HTTP 200 and an empty `Accounts` list — a legally-shaped "you have no
     * credits" that is simply false, because the member's credits live under the
     * enterprise account. The official client branches on the account's
     * `type: "ultimate"` and calls `/billing/meter/get-enterprise-user-usage`
     * instead (no `/v2` prefix), which returns:
     *
     *   { credit: 1234, limitNum: 5000, cycleResetTime: "2026-11-01 00:00:00" }
     *
     * What REMAINS is `limitNum - credit`. `credit` there is the amount SPENT,
     * not the amount left — reading it as a balance inverts the answer, which is
     * worse than the zero it replaces.
     *
     * @returns the credits, or `undefined` when this response carried no
     *          readable balance (the caller turns that into an error rather than
     *          reporting zero).
     */
    private async fetchEnterpriseCredits(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<WorkBuddyCredits | undefined> {
        const response = await fetch(`${billingBase(credential)}/billing/meter/get-enterprise-user-usage`, {
            method: 'POST',
            headers: billingHeaders(credential),
            body: JSON.stringify({}),
            signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(JSON_TIMEOUT_MS)]),
        });
        const envelope = await readEnvelope(response);
        if (!response.ok || envelope.code !== 0)
            throw envelopeError(response.status, envelope);
        const wrapper = typeof envelope.data === 'object' && envelope.data !== null
            ? envelope.data as Record<string, unknown>
            : {};
        // The payload has been seen both at the top level and under `Data`, so both
        // are accepted; whichever carries the two numbers wins.
        const inner = typeof wrapper['Data'] === 'object' && wrapper['Data'] !== null
            ? wrapper['Data'] as Record<string, unknown>
            : wrapper;
        const limit = typeof inner['limitNum'] === 'number' && Number.isFinite(inner['limitNum'])
            ? inner['limitNum']
            : undefined;
        const used = typeof inner['credit'] === 'number' && Number.isFinite(inner['credit'])
            ? inner['credit']
            : undefined;
        // Without BOTH numbers there is no balance to report. Returning `total: 0`
        // here would reproduce the exact symptom this branch exists to fix.
        if (limit === undefined || used === undefined)
            return undefined;
        const remain = Math.max(0, limit - used);
        const refreshAtMs = typeof inner['cycleResetTime'] === 'string'
            ? parseEnterpriseInstant(inner['cycleResetTime'])
            : undefined;
        return {
            total: remain,
            packages: [{
                    packageName: '企业积分',
                    remain,
                    size: limit,
                    monthly: true,
                    ...refreshAtMs === undefined ? {} : { refreshAtMs },
                }],
            expiringSoon: 0,
        };
    }
    /**
     * POST the billing endpoint for the remaining credit, keeping every package
     * separate: the card groups monthly-cycle packages itself and lists the
     * nearest-expiring one-off packages, so aggregation here would lose the
     * dates it needs.
     */
    async fetchCredits(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<WorkBuddyCredits> {
        // ENTERPRISE ACCOUNTS READ A DIFFERENT ENDPOINT (issue #124).
        //
        // The personal endpoint answers 200 with a legally-shaped empty list for an
        // enterprise member, so the card showed `total 0` on an account that had
        // credits — the plugin was asking the wrong table, not getting a refusal.
        // The enterprise table is `/billing/meter/get-enterprise-user-usage`
        // (no `/v2` prefix) and returns `{credit, limitNum, cycleResetTime}`: what
        // REMAINS is `limitNum - credit`, and it resets when the cycle rolls.
        //
        // Which branch to take is decided by `enterpriseId` ALONE, never by the
        // personal answer: an enterprise account whose personal response happened
        // to be non-empty must not be read through the personal table either, and
        // `status.active` is `false` for every enterprise member (measured), so it
        // cannot serve as a discriminator.
        if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
            const enterprise = await this.fetchEnterpriseCredits(credential, signal);
            if (enterprise !== undefined)
                return enterprise;
            // Fall through to the personal table only when the enterprise endpoint
            // gave us nothing usable. Returning an empty answer there is NOT an
            // option: `total: 0` on a funded account is the exact symptom #124
            // reports, so an unreadable enterprise response is reported as a
            // failure, not as a balance.
            throw new Error('workbuddy upstream enterprise credit: no readable balance in the response');
        }
        const now = new Date();
        const format = (date: Date): string => [
            date.getFullYear().toString().padStart(4, '0'),
            (date.getMonth() + 1).toString().padStart(2, '0'),
            date.getDate().toString().padStart(2, '0'),
        ].join('-') + ' ' + [
            date.getHours().toString().padStart(2, '0'),
            date.getMinutes().toString().padStart(2, '0'),
            date.getSeconds().toString().padStart(2, '0'),
        ].join(':');
        const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
            method: 'POST',
            headers: billingHeaders(credential),
            body: JSON.stringify({
                PageNumber: 1,
                PageSize: 100,
                ProductCode: 'p_tcaca',
                Status: [0, 3],
                PackageEndTimeRangeBegin: format(now),
                PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
            }),
            signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(JSON_TIMEOUT_MS)]),
        });
        const envelope = await readEnvelope(response);
        if (!response.ok || envelope.code !== 0)
            throw envelopeError(response.status, envelope);
        const responseWrapper = typeof envelope.data === 'object' && envelope.data !== null
            ? envelope.data as Record<string, unknown>
            : {};
        const data = typeof responseWrapper['Response'] === 'object' && responseWrapper['Response'] !== null
            ? responseWrapper['Response'] as Record<string, unknown>
            : {};
        const inner = typeof data['Data'] === 'object' && data['Data'] !== null
            ? data['Data'] as Record<string, unknown>
            : {};
        const rawAccounts = Array.isArray(inner['Accounts']) ? inner['Accounts'] : [];
        let total = 0;
        let nearestExpiryMs: number | undefined;
        let expiringSoon = 0;
        const SOON_MS = 3 * 24 * 60 * 60 * 1000;
        const parseDate = (raw: unknown): number | undefined => {
            if (typeof raw === 'number' && raw > 1000000000000)
                return raw;
            if (typeof raw === 'string' && raw !== '') {
                const parsed = Date.parse(raw);
                if (!Number.isNaN(parsed))
                    return parsed;
            }
            return undefined;
        };
        const packages: WorkBuddyCreditPackage[] = [];
        for (const raw of rawAccounts) {
            if (typeof raw !== 'object' || raw === null)
                continue;
            const account = raw as Record<string, unknown>;
            const numberField = (key: string): number => (typeof account[key] === 'number' ? account[key] as number : 0);
            // Every capacity is ALSO sent as a `*Precise` string carrying the fraction
            // the integer field drops ("96.61000218" beside 96). The official client
            // reads these — its total ends in a decimal (2,196.61) which no sum of the
            // integer fields can produce. Prefer the precise spelling, fall back to the
            // integer so a response that omits it still parses.
            const preciseField = (key: string): number => {
                const raw = account[`${key}Precise`];
                if (typeof raw === 'string' && raw !== '') {
                    const parsed = Number.parseFloat(raw);
                    if (Number.isFinite(parsed))
                        return parsed;
                }
                if (typeof raw === 'number' && Number.isFinite(raw))
                    return raw;
                return numberField(key);
            };
            // CapacityType 4 = monthly capacity resource (refreshed every cycle, never
            // expires: empty ExpiredTime, DeductionEndTime years out). CapacityType 1 =
            // deduction-based gift (CapacityRemain drains to 0, ExpiredTime set).
            // CycleEndTime exists on both, so it alone cannot tell them apart.
            const monthly = numberField('CapacityType') === 4;
            // The BALANCE is the cycle family, for BOTH kinds (issue #58 — see
            // WorkBuddyCreditPackage.remain for the evidence and for what #48 got
            // wrong). `CycleCapacitySize` is read first because on a monthly resource
            // it is the size the balance is a fraction OF; `CapacitySize` is both the
            // gift spelling and the fallback for a row that carries no cycle family.
            const size = preciseField('CycleCapacitySize') || preciseField('CapacitySize');
            const hasCycle = account['CycleCapacityRemain'] !== undefined
                || account['CycleCapacityRemainPrecise'] !== undefined;
            const remain = hasCycle ? preciseField('CycleCapacityRemain') : preciseField('CapacityRemain');
            const cappedRemain = remain < 0 ? 0 : remain;
            // For the monthly resource the cycle end is the refresh point; display the
            // next cycle's start (end + 1s) since "refreshes on 08/31 23:59:59" reads
            // like the package dies then. For a gift, ExpiredTime is when it vanishes.
            const cycleEndMs = parseDate(account['CycleEndTime']);
            const expiresAtMs = monthly ? undefined : parseDate(account['ExpiredTime']) ?? cycleEndMs;
            const refreshAtMs = monthly
                ? cycleEndMs === undefined ? undefined : cycleEndMs + 1000
                : undefined;
            // Drop one-off gifts that are exhausted or already expired: they carry
            // no usable credits and would clutter the nearest-expiry list. Monthly
            // resources (CapacityType 4) are always kept.
            if (!monthly && (cappedRemain <= 0 || (expiresAtMs !== undefined && expiresAtMs <= Date.now()))) {
                continue;
            }
            total += cappedRemain;
            const expiryMs = expiresAtMs;
            if (expiryMs !== undefined) {
                if (nearestExpiryMs === undefined || expiryMs < nearestExpiryMs)
                    nearestExpiryMs = expiryMs;
                if (expiryMs - Date.now() <= SOON_MS)
                    expiringSoon += cappedRemain;
            }
            packages.push({
                capacityType: numberField('CapacityType'),
                remainingKnown: [hasCycle ? 'CycleCapacityRemain' : 'CapacityRemain'].some(k => [account[k], account[k + 'Precise']].some(v => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v)))),
                totalKnown: ['CycleCapacitySize', 'CapacitySize'].some(k => [account[k], account[k + 'Precise']].some(v => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v)))),
                packageName: typeof account['PackageName'] === 'string' ? account['PackageName'] : '(unnamed)',
                remain: cappedRemain,
                size,
                monthly,
                ...refreshAtMs === undefined ? {} : { refreshAtMs },
                ...expiresAtMs === undefined ? {} : { expiresAtMs },
            });
        }
        return {
            total,
            packages,
            expiringSoon,
            ...nearestExpiryMs === undefined ? {} : { nearestExpiryMs },
        };
    }
}
