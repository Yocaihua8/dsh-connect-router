import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import type { SourceId } from "../shared/types.js";

import type { LogEntry, LogFilter } from "../shared/types.js";
export type { LogEntry, LogFilter } from "../shared/types.js";
const safeId = (v: unknown) =>
  typeof v === "string" && /^[a-zA-Z0-9_./:@+-]{1,256}$/u.test(v)
    ? v
    : undefined;
const safeNumber = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const safeRoute = (v: unknown) => typeof v === "string" && /^(group|route):[A-Za-z0-9%_.!~*'()-]{1,4000}$/u.test(v) ? v : undefined;
/** Allowlist at the persistence boundary: extra payloads, bodies and URLs never enter the file. */
export function sanitizeLog(
  raw: Partial<LogEntry>,
  now = Date.now(),
): LogEntry {
  return {
    id: randomUUID(),
    at: now,
    kind: raw.kind === "request" ? "request" : "operation",
    source: raw.source === "opencode" ? "opencode" : "workbuddy",
    account: safeId(raw.account),
    model: safeId(raw.model),
    group: safeRoute(raw.group),
    route: safeRoute(raw.route),
    result: safeId(raw.result) || "unknown",
    code: safeId(raw.code),
    reason: [
      "expiring-gift",
      "available-quota",
      "least-recent",
      "pinned",
      "free-first",
    ].includes(raw.reason || "")
      ? raw.reason
      : undefined,
    durationMs: safeNumber(raw.durationMs),
    inputTokens: safeNumber(raw.inputTokens),
    outputTokens: safeNumber(raw.outputTokens),
    httpStatus:
      Number.isInteger(raw.httpStatus) &&
      raw.httpStatus! >= 100 &&
      raw.httpStatus! <= 599
        ? raw.httpStatus
        : undefined,
  };
}
export class RouterLogs {
  private readonly path: string;
  constructor(
    private readonly directory: string,
    private readonly now = Date.now,
  ) {
    this.path = join(directory, "logs.json");
  }
  private async load(): Promise<LogEntry[]> {
    try {
      const rows = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(rows)) throw new Error("INVALID_LOG_STORE");
      return rows
        .filter(
          (r) => typeof r.at === "number" && r.at >= this.now() - 7 * 86400000,
        )
        .slice(-10000);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
  async append(event: Partial<LogEntry>) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await withFileLock(this.path, async () => {
      const rows = await this.load();
      rows.push(sanitizeLog(event, this.now()));
      await writeFileAtomic(this.path, JSON.stringify(rows.slice(-10000)), {
        mode: 0o600,
        dirMode: 0o700,
      });
    });
  }
  async query(filter: LogFilter = {}) {
    const limit = Math.min(500, Math.max(1, Math.floor(filter.limit || 100)));
    const rows = (await this.load())
      .reverse()
      .filter(
        (r) =>
          (!filter.source || r.source === filter.source) &&
          (!filter.account || r.account === filter.account) &&
          (!filter.model || r.model === filter.model || r.group === filter.model) &&
          (!filter.result || r.result === filter.result) &&
          (!filter.kind || r.kind === filter.kind) &&
          (filter.before === undefined || r.at < filter.before),
      );
    const offset = filter.cursor
      ? rows.findIndex((r) => r.id === filter.cursor) + 1
      : 0;
    if (filter.cursor && offset === 0) throw new Error("LOG_CURSOR_EXPIRED");
    const items = rows.slice(offset, offset + limit);
    return {
      items,
      nextCursor: rows.length > offset + limit ? items.at(-1)?.id : undefined,
    };
  }
}
