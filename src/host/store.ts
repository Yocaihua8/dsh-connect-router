import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomic, withFileLock } from "@deepseek-ai/dsh-atomic-write";
import type { BenefitLedger } from "./benefits.js";
import type {
  Receipt,
  RouterSettings,
  AccountRecord,
  SessionRecovery,
} from "../shared/types.js";
export const DEFAULT_SETTINGS: RouterSettings = {
  workbuddy: { enabledModels: [], autoCheckin: true },
  opencode: { enabledModels: [], autoCheckin: false },
};
export class RouterStore implements BenefitLedger {
  constructor(readonly directory: string) {}
  async readRecoveries(): Promise<[string, SessionRecovery][]> {
    try {
      const text = await readFile(
        join(this.directory, "recovery.json"),
        "utf8",
      );
      if (text.length > 1024 * 1024) throw new Error("INVALID_RECOVERY_STORE");
      const rows = JSON.parse(text);
      if (
        !Array.isArray(rows) ||
        rows.length > 500 ||
        rows.some(
          (row) =>
            !Array.isArray(row) ||
            typeof row[0] !== "string" ||
            row[0].length > 128 ||
            !row[1] ||
            ![
              "complete",
              "length",
              "disconnected",
              "timeout",
              "cancelled",
              "refused",
              "invalid",
            ].includes(row[1].state) ||
            typeof row[1].provider !== "string" ||
            typeof row[1].model !== "string" ||
            !Number.isFinite(row[1].at),
        )
      )
        throw new Error("INVALID_RECOVERY_STORE");
      return rows;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
  async writeRecoveries(rows: [string, SessionRecovery][]) {
    await writeFileAtomic(
      join(this.directory, "recovery.json"),
      JSON.stringify(rows.slice(-500)),
      { mode: 0o600, dirMode: 0o700 },
    );
  }
  async initialize() {
    await mkdir(join(this.directory, "receipts"), {
      recursive: true,
      mode: 0o700,
    });
  }
  async readSettings(): Promise<RouterSettings> {
    try {
      return validateSettings(
        JSON.parse(
          await readFile(join(this.directory, "settings.json"), "utf8"),
        ),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return structuredClone(DEFAULT_SETTINGS);
      throw e;
    }
  }
  async saveSettings(value: RouterSettings) {
    const settings = validateSettings(value);
    await this.initialize();
    const path = join(this.directory, "settings.json");
    await withFileLock(path, () =>
      writeFileAtomic(path, JSON.stringify(settings), {
        mode: 0o600,
        dirMode: 0o700,
      }),
    );
    return settings;
  }
  async accounts(): Promise<AccountRecord[]> {
    try {
      return validateAccounts(
        JSON.parse(
          await readFile(join(this.directory, "accounts.json"), "utf8"),
        ),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
  async mutateAccounts(update: (rows: AccountRecord[]) => AccountRecord[]) {
    await this.initialize();
    const path = join(this.directory, "accounts.json");
    return withFileLock(path, async () => {
      const next = validateAccounts(update(await this.accounts()));
      await writeFileAtomic(path, JSON.stringify(next), {
        mode: 0o600,
        dirMode: 0o700,
      });
      return next;
    });
  }
  async exclusive<T>(
    key: string,
    run: (
      prior: Receipt | undefined,
      save: (r: Receipt) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    await this.initialize();
    const path = join(
      this.directory,
      "receipts",
      createHash("sha256").update(key).digest("hex") + ".json",
    );
    return withFileLock(
      path,
      async () => {
        let prior: Receipt | undefined;
        try {
          prior = JSON.parse(await readFile(path, "utf8"));
          if (
            prior?.key !== key ||
            !["pending", "confirmed", "unsupported"].includes(prior.state)
          )
            throw new Error("INVALID_RECEIPT");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        return run(prior, (r) =>
          writeFileAtomic(path, JSON.stringify(r), {
            mode: 0o600,
            dirMode: 0o700,
          }),
        );
      },
      { waitMs: 120_000 },
    );
  }
}
export function validateSettings(value: unknown): RouterSettings {
  if (!value || typeof value !== "object") throw new Error("INVALID_SETTINGS");
  const result = structuredClone(DEFAULT_SETTINGS);
  for (const source of ["workbuddy", "opencode"] as const) {
    const s = (value as any)[source];
    if (
      !s ||
      !Array.isArray(s.enabledModels) ||
      s.enabledModels.length > 256 ||
      s.enabledModels.some(
        (id: unknown) => typeof id !== "string" || id.length > 256,
      ) ||
      typeof s.autoCheckin !== "boolean"
    )
      throw new Error("INVALID_SETTINGS");
    if (
      s.contextBudget !== undefined &&
      (!Number.isInteger(s.contextBudget) ||
        s.contextBudget < 4096 ||
        s.contextBudget > 2_000_000)
    )
      throw new Error("INVALID_BUDGET");
    result[source] = {
      enabledModels: [...new Set<string>(s.enabledModels)],
      autoCheckin: s.autoCheckin,
      ...(s.contextBudget === undefined
        ? {}
        : { contextBudget: s.contextBudget }),
    };
    if (s.models !== undefined) {
      if (
        !s.models ||
        typeof s.models !== "object" ||
        Array.isArray(s.models) ||
        Object.keys(s.models).length > 2048
      )
        throw new Error("INVALID_MODEL_SETTINGS");
      const models: NonNullable<RouterSettings[typeof source]["models"]> = {};
      for (const [id, raw] of Object.entries(s.models)) {
        const m = raw as any;
        if (
          !id ||
          id.length > 512 ||
          ["__proto__", "constructor", "prototype"].includes(id) ||
          !m ||
          typeof m.enabled !== "boolean" ||
          !["auto", "custom"].includes(m.context?.mode)
        )
          throw new Error("INVALID_MODEL_SETTINGS");
        if (
          m.context.mode === "custom" &&
          (!Number.isSafeInteger(m.context.tokens) ||
            m.context.tokens < 4096 ||
            m.context.tokens > 2_000_000)
        )
          throw new Error("INVALID_BUDGET");
        if (
          !m.capabilities ||
          typeof m.capabilities !== "object" ||
          Object.entries(m.capabilities).some(
            ([k, v]) =>
              !["tools", "images", "reasoning"].includes(k) ||
              typeof v !== "boolean",
          )
        )
          throw new Error("INVALID_CAPABILITIES");
        if (
          m.allowedCosts !== undefined &&
          (!Array.isArray(m.allowedCosts) ||
            m.allowedCosts.some(
              (c: unknown) =>
                !["free", "credits", "paid", "unknown"].includes(String(c)),
            ))
        )
          throw new Error("INVALID_COST_POLICY");
        models[id] = {
          enabled: m.enabled,
          context:
            m.context.mode === "auto"
              ? { mode: "auto" }
              : { mode: "custom", tokens: m.context.tokens },
          capabilities: { ...m.capabilities },
          allowedCosts: m.allowedCosts ?? ["free", "credits"],
        };
      }
      result[source].models = models;
    }
    if (s.groups !== undefined) {
      if (!s.groups || typeof s.groups !== "object" || Array.isArray(s.groups) || Object.keys(s.groups).length > 2048)
        throw new Error("INVALID_GROUP_SETTINGS");
      const entries = Object.entries(s.groups);
      const normalized = validateSettings({ ...structuredClone(DEFAULT_SETTINGS), [source]: {
        enabledModels: [], autoCheckin: s.autoCheckin,
        models: Object.fromEntries(entries.map(([,v], i) => [`g${i}`, v])),
      } })[source].models!;
      result[source].groups = Object.fromEntries(entries.map(([id, value], i) => {
        const g = value as any;
        if (!id.startsWith("group:") || id.length > 4096 || !Array.isArray(g.approvedRoutes) || g.approvedRoutes.length > 2048 ||
          g.approvedRoutes.some((r: unknown) => typeof r !== "string" || !r.startsWith("route:") || r.length > 4096) ||
          g.needsReview !== undefined && typeof g.needsReview !== "boolean") throw new Error("INVALID_GROUP_SETTINGS");
        return [id, { ...normalized[`g${i}`]!, approvedRoutes: [...new Set<string>(g.approvedRoutes)], ...(g.needsReview ? { needsReview: true } : {}) }];
      }));
    }
  }
  return result;
}
export function validateAccounts(value: unknown): AccountRecord[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("INVALID_ACCOUNTS");
  const ids = new Set<string>();
  return value.map((a: any) => {
    if (
      !a ||
      !/^[a-zA-Z0-9_-]{1,80}$/u.test(a.id) ||
      ids.has(a.id) ||
      !["workbuddy", "opencode"].includes(a.source) ||
      !["workbuddy", "opencode", "opencode-go", "anonymous"].includes(
        a.service,
      ) ||
      (a.source === "workbuddy") !== (a.service === "workbuddy") ||
      !["cn", "global"].includes(a.region) ||
      typeof a.enabled !== "boolean" ||
      typeof a.label !== "string" ||
      a.label.length > 80 ||
      /[\r\n\0]/u.test(a.label)
    )
      throw new Error("INVALID_ACCOUNT");
    ids.add(a.id);
    return {
      id: a.id,
      source: a.source,
      service: a.service,
      region: a.region,
      enabled: a.enabled,
      label: a.label,
    };
  });
}
