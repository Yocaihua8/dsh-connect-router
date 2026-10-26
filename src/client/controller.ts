import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-gateway/client";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "../../lib/typert.remote-client.js";
import type {
  RouterModel,
  RouterSettings,
  ModelSettings,
  SourceId,
} from "../shared/types.js";
import { settingsFor } from "../host/model-settings.js";

export type Rpc = Context["remote"]["connectRouter"];
export function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
export const labels = { workbuddy: "WorkBuddy", opencode: "OpenCode" };
export const contextPresets = [
  16000, 32000, 64000, 128000, 256000, 512000, 1000000,
];
export function contextOptions(max?: number) {
  if (!Number.isSafeInteger(max) || max! < 4096) return [];
  return [...new Set([...contextPresets.filter((n) => n <= max!), max!])].sort(
    (a, b) => a - b,
  );
}
export const formatTokens = (n: number) =>
  n % 1000000 === 0
    ? `${n / 1000000}M`
    : n % 1000 === 0
      ? `${n / 1000}K`
      : n.toLocaleString("zh-CN");
export type Snapshot =
  ReturnType<Rpc["snapshot"]> extends Promise<infer R>
    ? R extends { ok: true; value: infer V }
      ? V
      : never
    : never;

export function contextError(
  model: RouterModel,
  config: ModelSettings,
): string {
  if (config.context.mode === "auto") return "";
  if (!model.contextWindow) return "上限未知，请选择自动";
  const n = config.context.tokens;
  return Number.isInteger(n) && n >= 4096 && n <= model.contextWindow
    ? ""
    : `请输入 4,096–${model.contextWindow.toLocaleString("zh-CN")} 的整数`;
}
export class RouterClient {
  snapshot?: Snapshot;
  draft?: RouterSettings;
  source: SourceId = "workbuddy";
  tab = "签到与福利";
  message = "";
  error = "";
  busy = false;
  login?: { loginId: string; verificationUri: string; expiresAt: number };
  contextModes = new Map<string, string>();
  private listeners = new Set<() => void>();
  private abort = new AbortController();
  private loginAbort?: AbortController;
  constructor(readonly rpc: Rpc) {}
  get signal() {
    return this.abort.signal;
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  changed = () => {
    for (const fn of this.listeners) fn();
  };
  get dirty() {
    return (
      !!this.draft &&
      JSON.stringify(this.draft) !== JSON.stringify(this.snapshot?.settings)
    );
  }
  config(model: RouterModel) {
    return settingsFor(this.draft![model.source], model);
  }
  edit(model: RouterModel, change: Partial<ModelSettings>) {
    if (!this.draft) return;
    const source = this.draft[model.source];
    source.models ??= {};
    source.models[model.id] = { ...this.config(model), ...change };
    this.message = "";
    this.changed();
  }
  validation() {
    if (!this.snapshot || !this.draft) return "";
    for (const source of ["workbuddy", "opencode"] as const)
      for (const model of this.snapshot.models[source]) {
        const error = contextError(model, this.config(model));
        if (error) return `${model.name}：${error}`;
      }
    return "";
  }
  async load() {
    const snapshot = unwrap(await this.rpc.snapshot(this.signal));
    this.snapshot = snapshot;
    this.draft ??= structuredClone(snapshot.settings);
    this.changed();
  }
  async action(run: () => Promise<void>, success = "") {
    if (this.busy || this.signal.aborted) return;
    this.busy = true;
    this.error = "";
    this.message = "";
    this.changed();
    try {
      await run();
      this.message = success;
    } catch (e) {
      if (!this.signal.aborted)
        this.error = e instanceof Error ? e.message : "操作失败";
    } finally {
      this.busy = false;
      if (!this.signal.aborted) this.changed();
    }
  }
  async save() {
    const error = this.validation();
    if (error) {
      this.error = error;
      this.changed();
      return;
    }
    await this.action(async () => {
      const saved = unwrap(
        await this.rpc.saveSettings(structuredClone(this.draft!), this.signal),
      );
      this.snapshot!.settings = saved;
      this.draft = structuredClone(saved);
    }, "已保存，下一次请求生效。");
  }
  undo() {
    this.draft = structuredClone(this.snapshot!.settings);
    this.contextModes.clear();
    this.error = "";
    this.message = "已撤销未保存修改。";
    this.changed();
  }
  async authorize(id?: string) {
    await this.action(async () => {
      await this.cancelLogin();
      const account =
        id ??
        unwrap(
          await this.rpc.addAccount(
            "workbuddy",
            "workbuddy",
            "WorkBuddy",
            "cn",
            this.signal,
          ),
        );
      const login = unwrap(await this.rpc.startLogin(account, this.signal));
      this.login = { ...login, expiresAt: Date.now() + login.expiresIn * 1000 };
      window.open(login.verificationUri, "_blank", "noopener,noreferrer");
      await this.load();
      this.loginAbort = new AbortController();
      void this.poll(this.loginAbort.signal);
    }, "在 WorkBuddy 官方页面扫码授权后返回。");
  }
  private async poll(signal: AbortSignal) {
    try {
      while (this.login && !signal.aborted && !this.signal.aborted) {
        if (Date.now() >= this.login.expiresAt)
          throw new Error("授权已过期，请重新授权。");
        const result = unwrap(
          await this.rpc.pollLogin(this.login.loginId, signal),
        );
        if (result.done) {
          this.login = undefined;
          await this.load();
          this.message = "授权成功。";
          this.changed();
          return;
        }
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 1500);
          signal.addEventListener("abort", done, { once: true });
        });
      }
    } catch (e) {
      if (!signal.aborted && !this.signal.aborted) {
        this.error = e instanceof Error ? e.message : "授权失败";
        await this.cancelLogin();
        this.changed();
      }
    }
  }
  async cancelLogin() {
    this.loginAbort?.abort();
    const login = this.login;
    this.login = undefined;
    if (login) unwrap(await this.rpc.cancelLogin(login.loginId, this.signal));
    this.changed();
  }
  dispose() {
    this.loginAbort?.abort();
    if (this.login)
      void this.rpc
        .cancelLogin(this.login.loginId, new AbortController().signal)
        .catch(() => {});
    this.abort.abort();
    this.listeners.clear();
  }
}
