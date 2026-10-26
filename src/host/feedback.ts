import { randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic, withFileLock } from "@deepseek-ai/dsh-atomic-write";
import type { GrantStore } from "./workbuddy/credentials.js";
import type { DiagnosticBundle } from "../shared/types.js";
import { FEEDBACK_REPOSITORY, FEEDBACK_CLIENT_ID } from "../shared/feedback.js";
import type {
  FeedbackAuth,
  FeedbackLogin,
  FeedbackReport,
} from "../shared/feedback.js";

type Fetch = typeof fetch;
type Grant = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  login: string;
};
type Device = FeedbackLogin & { code: string; nextPoll: number };
const LIMIT = 48 * 1024;
const grant = (x: unknown): Grant | undefined => {
  const g = x as Grant | undefined;
  return g &&
    typeof g.accessToken === "string" &&
    typeof g.login === "string" &&
    typeof g.expiresAt === "number"
    ? g
    : undefined;
};
/** Free text is scrubbed again at the publication boundary; raw provider bodies are never included. */
export function redactFeedback(s: string) {
  return s
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g,
      "[凭据已移除]",
    )
    .replace(
      /(?:authorization|bearer|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|cookie)\s*[=:]?\s*["']?[^\s,"'}]+/gi,
      "[凭据已移除]",
    )
    .replace(/https?:\/\/[^\s<>"）)]+/gi, "[地址已移除]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱已移除]")
    .replace(/(?:[A-Z]:[\\/]|\\\\)[^\r\n<>"|]*/gi, "[本地路径已移除]")
    .replace(/\/(?:Users|home|tmp|var)\/[^\s"<>]+/g, "[本地路径已移除]");
}
export function makeReport(
  bundle: DiagnosticBundle,
  title: string,
  description: string,
  now = Date.now(),
): FeedbackReport {
  if (!title.trim() || title.length > 160 || description.length > 12000)
    throw new Error("FEEDBACK_INPUT_INVALID");
  const id = randomUUID(),
    aliases = new Map<string, string>();
  const alias = (account?: string) =>
    account
      ? (aliases.get(account) ??
        (aliases.set(account, `账号 ${aliases.size + 1}`),
        aliases.get(account)))
      : undefined;
  // Explicit allowlist: never spread arbitrary diagnostic objects into a public report.
  const rows = bundle.page.items.slice(0, 50).map((e) => ({
    request: e.id,
    at: new Date(e.at).toISOString(),
    source: e.source,
    account: alias(e.account),
    model: redactFeedback(e.model || ""),
    stage: e.stage,
    code: e.code,
    result: e.result,
    reason: e.reason,
    httpStatus: e.httpStatus,
    durationMs: e.durationMs,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
  }));
  const safeTitle = redactFeedback(title).replace(/[\r\n]/g, " ");
  const header = `## 问题描述\n${redactFeedback(description)}\n\n## 环境\n插件 ${bundle.pluginVersion} · DSH ${bundle.targetDshVersion} · ${bundle.platform} · Node ${bundle.nodeVersion}\n\n`;
  let count = rows.length,
    body = "";
  do {
    body =
      redactFeedback(
        header +
          `## 脱敏诊断\n包含 ${count} 条；省略 ${rows.length - count} 条${bundle.page.nextCursor ? "，另有更早记录可本地导出" : ""}。\n\n` +
          "```json\n" +
          JSON.stringify(rows.slice(0, count), null, 2) +
          "\n```\n",
      ) + `<!-- connect-router-feedback:${id} -->`;
    if (Buffer.byteLength(body) <= LIMIT) break;
    count--;
  } while (count >= 0);
  if (count < 0) throw new Error("FEEDBACK_TOO_LARGE");
  return {
    id,
    title: safeTitle,
    body,
    repository: FEEDBACK_REPOSITORY,
    at: now,
    state: "preview",
  };
}

export class GitHubFeedback {
  private devices = new Map<string, Device>();
  private refreshFlight?: Promise<Grant>;
  private pollFlight = new Map<string, Promise<boolean>>();
  private path: string;
  constructor(
    private directory: string,
    private credentials: GrantStore,
    private request: Fetch = fetch,
    private clientId = FEEDBACK_CLIENT_ID,
    private now = Date.now,
  ) {
    this.path = join(directory, "feedback-reports.json");
  }
  private async json(url: string, init: RequestInit, signal?: AbortSignal) {
    const r = await this.request(url, {
      ...init,
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    }).catch((error: unknown) => {
      signal?.throwIfAborted();
      throw new Error(error instanceof Error && error.name === "TimeoutError" ? "GITHUB_TIMEOUT" : "GITHUB_NETWORK_ERROR");
    });
    if (!r.ok)
      throw new Error(
        r.status === 401
          ? "GITHUB_AUTH_REQUIRED"
          : r.status === 403
            ? "GITHUB_FORBIDDEN"
            : r.status === 429
              ? "GITHUB_RATE_LIMITED"
              : `GITHUB_HTTP_${r.status}`,
      );
    return (await r.json()) as Record<string, any>;
  }
  private token(body: Record<string, string>, signal?: AbortSignal) {
    return this.json(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ client_id: this.clientId, ...body }),
      },
      signal,
    );
  }
  private async api(
    path: string,
    g: Grant,
    init: RequestInit = {},
    signal?: AbortSignal,
  ) {
    return this.json(
      `https://api.github.com/${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${g.accessToken}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
      },
      signal,
    );
  }
  async status(): Promise<FeedbackAuth> {
    const g = grant(await this.credentials.read());
    return {
      configured: !!this.clientId,
      connected: !!g && (g.expiresAt > this.now() || !!g.refreshToken),
      login: g?.login,
    };
  }
  async start(signal: AbortSignal): Promise<FeedbackLogin> {
    if (!this.clientId) throw new Error("GITHUB_APP_NOT_CONFIGURED");
    this.devices.clear();
    const r = await this.json(
      "https://github.com/login/device/code",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: this.clientId,
          scope: "offline_access",
        }),
      },
      signal,
    );
    if (
      r.verification_uri !== "https://github.com/login/device" ||
      typeof r.device_code !== "string" ||
      typeof r.user_code !== "string" ||
      !Number.isFinite(r.expires_in) ||
      !Number.isFinite(r.interval)
    )
      throw new Error("GITHUB_AUTH_INVALID");
    const login: FeedbackLogin = {
      id: randomUUID(),
      userCode: r.user_code,
      url: r.verification_uri,
      expiresAt: this.now() + Math.min(900, r.expires_in) * 1000,
      interval: Math.max(5, r.interval) * 1000,
    };
    this.devices.set(login.id, {
      ...login,
      code: r.device_code,
      nextPoll: this.now() + login.interval,
    });
    return login;
  }
  cancel(id: string) {
    this.devices.delete(id);
  }
  poll(id: string, signal: AbortSignal): Promise<boolean> {
    if (this.pollFlight.has(id)) return this.pollFlight.get(id)!;
    const flight = this.pollOnce(id, signal).finally(() =>
      this.pollFlight.delete(id),
    );
    this.pollFlight.set(id, flight);
    return flight;
  }
  private async pollOnce(id: string, signal: AbortSignal) {
    const d = this.devices.get(id);
    if (!d || d.expiresAt <= this.now()) {
      this.devices.delete(id);
      throw new Error("GITHUB_AUTH_EXPIRED");
    }
    if (this.now() < d.nextPoll) return false;
    d.nextPoll = this.now() + d.interval;
    const r = await this.token(
      {
        device_code: d.code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
      signal,
    );
    if (r.error === "authorization_pending") return false;
    if (r.error === "slow_down") {
      d.interval += 5000;
      d.nextPoll = this.now() + d.interval;
      return false;
    }
    if (r.error) {
      this.devices.delete(id);
      throw new Error(
        r.error === "access_denied"
          ? "GITHUB_AUTH_DENIED"
          : "GITHUB_AUTH_EXPIRED",
      );
    }
    const g = this.fromToken(r, "");
    const user = await this.api("user", g, {}, signal);
    if (typeof user.login !== "string" || !/^[\w-]+$/.test(user.login))
      throw new Error("GITHUB_AUTH_INVALID");
    g.login = user.login;
    if (!this.devices.has(id)) throw new Error("GITHUB_AUTH_CANCELLED");
    await this.credentials.modify(async () => g);
    this.devices.delete(id);
    return true;
  }
  private fromToken(r: Record<string, any>, login: string): Grant {
    if (
      typeof r.access_token !== "string" ||
      !r.access_token ||
      (r.expires_in !== undefined &&
        (!Number.isFinite(r.expires_in) || r.expires_in <= 0))
    )
      throw new Error("GITHUB_AUTH_INVALID");
    return {
      accessToken: r.access_token,
      refreshToken:
        typeof r.refresh_token === "string" ? r.refresh_token : undefined,
      expiresAt: r.expires_in
        ? this.now() + r.expires_in * 1000
        : this.now() + 8 * 3600000,
      login,
    };
  }
  private async resolve() {
    this.refreshFlight ??= (async () => {
      const result = await this.credentials.modify(async (old) => {
        const g = grant(old);
        if (!g) throw new Error("GITHUB_AUTH_REQUIRED");
        if (g.expiresAt > this.now() + 60000) return g;
        if (!g.refreshToken) throw new Error("GITHUB_AUTH_REQUIRED");
        const r = await this.token({
          refresh_token: g.refreshToken,
          grant_type: "refresh_token",
        });
        if (r.error) throw new Error("GITHUB_AUTH_REQUIRED");
        return this.fromToken(r, g.login);
      });
      return grant(result)!;
    })().finally(() => {
      this.refreshFlight = undefined;
    });
    return this.refreshFlight;
  }
  async disconnect() {
    this.devices.clear();
    await this.refreshFlight?.catch(() => {});
    await this.credentials.remove();
  }
  private async mutate<T>(fn: (rows: FeedbackReport[]) => T) {
    await mkdir(this.directory, { recursive: true });
    return withFileLock(this.path, async () => {
      let rows: FeedbackReport[] = [];
      try {
        rows = JSON.parse(await readFile(this.path, "utf8"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      rows = rows.filter((r) => r.at >= this.now() - 7 * 86400000);
      const value = fn(rows);
      await writeFileAtomic(this.path, JSON.stringify(rows.slice(-100)), {
        mode: 0o600,
        dirMode: 0o700,
      });
      return value;
    });
  }
  async preview(bundle: DiagnosticBundle, title: string, description: string) {
    const report = makeReport(bundle, title, description, this.now());
    await this.mutate((rows) => {
      rows.push(report);
    });
    return report;
  }
  async pending(): Promise<FeedbackReport | null> {
    return this.mutate(
      (rows) => rows.findLast((r) => r.state === "pending") ?? null,
    );
  }
  private async get(id: string) {
    return this.mutate((rows) => {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new Error("FEEDBACK_REPORT_EXPIRED");
      return { ...r };
    });
  }
  private async update(id: string, patch: Partial<FeedbackReport>) {
    return this.mutate((rows) => {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new Error("FEEDBACK_REPORT_EXPIRED");
      Object.assign(r, patch);
      return { ...r };
    });
  }
  async submit(id: string, signal: AbortSignal): Promise<FeedbackReport> {
    const g = await this.resolve();
    const chosen = await this.mutate((rows) => {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new Error("FEEDBACK_REPORT_EXPIRED");
      if (r.state !== "preview") return { report: { ...r }, send: false };
      r.state = "pending";
      r.author = g.login;
      return { report: { ...r }, send: true };
    });
    if (!chosen.send) return chosen.report;
    try {
      const r = await this.api(
        `repos/${FEEDBACK_REPOSITORY}/issues`,
        g,
        {
          method: "POST",
          body: JSON.stringify({
            title: chosen.report.title,
            body: chosen.report.body,
          }),
        },
        signal,
      );
      if (!this.issueUrl(r.html_url))
        throw new Error("GITHUB_RESPONSE_UNKNOWN");
      return await this.update(id, { state: "sent", url: r.html_url });
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      // Only explicit rejection is a known failure. Transport/5xx errors may have created the issue.
      const failed =
        /^GITHUB_(AUTH_REQUIRED|FORBIDDEN|RATE_LIMITED|HTTP_(400|404|410|422))$/.test(
          code,
        );
      return this.update(id, {
        state: failed ? "failed" : "pending",
        code: failed ? code : "GITHUB_RESULT_UNKNOWN",
      });
    }
  }
  private issueUrl(value: unknown): value is string {
    return (
      typeof value === "string" &&
      new RegExp(
        `^https://github.com/${FEEDBACK_REPOSITORY}/issues/[0-9]+$`,
        "i",
      ).test(value)
    );
  }
  async result(id: string, signal: AbortSignal) {
    const report = await this.get(id);
    if (report.state !== "pending") return report;
    const g = await this.resolve();
    // Read-only reconciliation. A missing result never triggers another POST.
    const rows = await this.api(
      `repos/${FEEDBACK_REPOSITORY}/issues?state=all&creator=${encodeURIComponent(report.author || g.login)}&sort=created&direction=desc&per_page=100`,
      g,
      {},
      signal,
    );
    if (Array.isArray(rows)) {
      const match = rows.find(
        (r) =>
          typeof r.body === "string" &&
          r.body.includes(`<!-- connect-router-feedback:${id} -->`) &&
          this.issueUrl(r.html_url),
      );
      if (match)
        return this.update(id, {
          state: "sent",
          url: match.html_url,
          code: undefined,
        });
    }
    return report;
  }
}
