import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
export interface BindingPort {
  assign(
    key: string,
    latest: string,
    resume: boolean,
    preferred?: string | { account: string; route: string },
    options?: { inheritLatest?: boolean; updateLatest?: boolean },
  ): Promise<{ account: string; route?: string; pinned: boolean } | undefined>;
}
/** Durable request affinity; contains hashes and account IDs, never message content. */
export class RequestBindings implements BindingPort {
  private path: string;
  constructor(directory: string) {
    this.path = join(directory, "request-bindings.json");
  }
  async assign(
    key: string,
    latest: string,
    resume: boolean,
    preferred?: string | { account: string; route: string },
    options?: { inheritLatest?: boolean; updateLatest?: boolean },
  ) {
    const hash = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    return withFileLock(this.path, async () => {
      let rows: Record<string, string | { account: string; route: string }> = {};
      try {
        rows = JSON.parse(await readFile(this.path, "utf8"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (
        !rows ||
        typeof rows !== "object" ||
        Array.isArray(rows) ||
        Object.entries(rows).some(
          ([k, v]) =>
            !/^[a-f0-9]{64}$/.test(k) ||
            (typeof v === "string" ? !/^[\w-]{1,100}$/.test(v) :
              !v || typeof v !== "object" || !/^[\w-]{1,100}$/.test(v.account) || typeof v.route !== "string" || !v.route.startsWith("route:") || v.route.length > 4096),
        )
      )
        throw new Error("INVALID_REQUEST_BINDINGS");
      const id = hash(key),
        tail = hash(latest),
        existing = rows[id] ?? (resume || options?.inheritLatest ? rows[tail] : undefined);
      const account = existing ?? (resume ? undefined : preferred);
      if (!account) return undefined;
      // Refuse growth instead of silently forgetting a live request's binding.
      const additions = Number(!rows[id]) + Number(options?.updateLatest !== false && tail !== id && !rows[tail]);
      if (Object.keys(rows).length + additions > 10000)
        throw new Error("REQUEST_BINDING_LIMIT");
      rows[id] = account;
      if (options?.updateLatest !== false) rows[tail] = account;
      await writeFileAtomic(this.path, JSON.stringify(rows), {
        mode: 0o600,
        dirMode: 0o700,
      });
      return typeof account === "string" ? { account, pinned: !!existing } : { ...account, pinned: !!existing };
    });
  }
}
