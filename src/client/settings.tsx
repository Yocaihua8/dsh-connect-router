import { useEffect, useReducer, useState } from "react";
import {
  Button,
  Menu,
  Modal,
  IconChevronDownOutlineRegular,
} from "@deepseek-ai/dsh-client-ui-primitives";
import {
  RouterClient,
  unwrap,
  labels,
  contextOptions,
  contextError,
  formatTokens,
} from "./controller.js";
import { summarizeQuota, quotaLabels } from "./quota.js";
import { FeedbackPanel } from "./feedback.js";
import type { Rpc } from "./controller.js";
import type {
  AccountSnapshot,
  Capability,
  ModelSettings,
  RouterModel,
  SourceId,
} from "../shared/types.js";
import type { LogFilter } from "../host/logs.js";
import { diagnostic } from "../host/diagnostics.js";

type Value<K extends keyof Rpc> = Rpc[K] extends (
  ...args: any[]
) => Promise<infer R>
  ? R extends { ok: true; value: infer V }
    ? V
    : never
  : never;
const costLabels = {
  free: "免费",
  credits: "消耗额度",
  paid: "付费",
  unknown: "费用未知",
};
const stateLabels: Record<string, string> = {
  ready: "已连接",
  "auth-required": "待授权",
  unavailable: "不可用",
  complete: "完整",
  success: "成功",
  failed: "失败",
  confirmed: "已领取",
  pending: "待核对",
  unsupported: "不支持",
  refused: "拒绝",
  disconnected: "断流",
  timeout: "超时",
  length: "长度限制",
  cancelled: "已取消",
  invalid: "协议异常",
};
const time = (n?: number) =>
  n === undefined ? "尚未更新" : new Date(n).toLocaleString("zh-CN");
const describe = (code?: string) =>
  ({
    AUTH_REQUIRED: "请完成授权",
    MODEL_DISABLED: "上游已禁用",
    AUTH_EXPIRED: "授权已失效",
    AGENT_INTERFACE_NOT_INCLUDED: "独立 Agent 接口",
    AUTOMATIC_ROUTE_NOT_SUPPORTED: "自动路由不可单独发布",
    NATIVE_OUTPUT_NOT_SUPPORTED: "当前 DSH 不支持此输出类型",
  })[code || ""] || code;

function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      listClassName="dsh-connect-router-menu"
      open={open && !disabled}
      onClose={() => setOpen(false)}
      portal
      autoFocus
      align="end"
      minWidthFromAnchor
      compact
      selectedId={value}
      items={options}
      onSelect={(id) => {
        setOpen(false);
        onChange(id);
      }}
      anchor={
        <Button
          variant="toolbar"
          size="sm"
          disabled={disabled}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="cr-select-label">
            <span>
              {options.find((o) => o.id === value)?.label || "请选择"}
            </span>
            <IconChevronDownOutlineRegular aria-hidden />
          </span>
        </Button>
      }
    />
  );
}
function Quota({ account }: { account: AccountSnapshot }) {
  const units = [...new Set(account.quota.map((q) => q.unit))];
  const [selected, setSelected] = useState("");
  const unit = units.includes(selected) ? selected : units[0] || "";
  const now = Date.now(),
    q = summarizeQuota(account.quota, unit, now);
  const number = (n: number) =>
    n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  const denominator = q.proportional ? q.total! : q.known;
  return (
    <div className="cr-quota">
      <div className="cr-split">
        <span>可用额度</span>
        {units.length > 1 && (
          <Select
            label="额度单位"
            value={unit}
            options={units.map((id) => ({ id, label: id }))}
            onChange={setSelected}
          />
        )}
        <strong>
          {!account.quota.length
            ? "额度未知"
            : `${q.unknown ? "已知 " : ""}${number(q.known)}${q.proportional ? ` / ${number(q.total!)}` : ""} ${unit}`}
        </strong>
      </div>
      <div
        className="cr-quota-bar"
        role="img"
        aria-label={
          q.proportional
            ? `可用 ${number(q.known)}，总量 ${number(q.total!)} ${unit}`
            : `已知余额构成 ${number(q.known)} ${unit}，不表示使用比例`
        }
      >
        {denominator > 0 &&
          q.groups.map((g) => (
            <span
              key={g.kind}
              className={`cr-quota-${g.kind}`}
              style={{ width: `${(g.known / denominator) * 100}%` }}
            />
          ))}
      </div>
      <div className="cr-quota-legend">
        {q.groups.map((g) => (
          <span key={g.kind}>
            <i className={`cr-quota-${g.kind}`} />
            {quotaLabels[g.kind]} {number(g.known)}
            {g.unknown ? " + 未知" : ""}
          </span>
        ))}
      </div>
      {q.unknown && <small>部分余额未知</small>}
      {!q.proportional && !!account.quota.length && (
        <small>总量未知或不可比较 · 图形仅表示已知余额构成</small>
      )}
      <details className="cr-quota-details">
        <summary>额度明细{q.expired ? ` · ${q.expired} 项已到期` : ""}</summary>
        {account.quota
          .filter((item) => item.unit === unit)
          .map((item, i) => (
            <div key={i} className="cr-quota-package">
              <div className="cr-split">
                <span>{quotaLabels[item.kind]}</span>
                <span>
                  {item.remaining === undefined
                    ? "余额未知"
                    : number(item.remaining)}
                  {item.total === undefined ? "" : ` / ${number(item.total)}`}{" "}
                  {unit}
                </span>
              </div>
              <small>
                {item.expiresAt === undefined
                  ? "到期时间未知"
                  : `${item.expiresAt <= now ? "已到期" : "到期时间"} ${time(item.expiresAt)}`}
              </small>
            </div>
          ))}
      </details>
      <small>
        {account.models.length} 个模型 · 更新于 {time(account.updatedAt)}
      </small>
    </div>
  );
}
function AccountPool({ client }: { client: RouterClient }) {
  const [keyForm, setKeyForm] = useState<{
    id?: string;
    service: "opencode" | "opencode-go";
  }>();
  const [key, setKey] = useState(""),
    [label, setLabel] = useState(""),
    [remove, setRemove] = useState("");
  const [tests, setTests] = useState<Value<"testAccounts">>([]);
  const accounts = client.snapshot!.accounts.filter(
    (a) => a.source === client.source,
  );
  const run = (fn: () => Promise<unknown>) =>
    void client.action(async () => {
      await fn();
      await client.load();
    });
  return (
    <section className="cr-pool">
      <div className="cr-heading">
        <h3>账号池</h3>
        <div className="cr-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={client.busy || !accounts.length}
            onClick={() =>
              run(async () =>
                setTests(
                  unwrap(
                    await client.rpc.testAccounts(client.source, client.signal),
                  ),
                ),
              )
            }
          >
            统一测试
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={client.busy || !!client.login}
            onClick={() =>
              client.source === "workbuddy"
                ? void client.authorize()
                : setKeyForm({ service: "opencode" })
            }
          >
            {client.source === "workbuddy" ? "扫码添加账号" : "添加账号"}
          </Button>
        </div>
      </div>
      <p className="cr-muted">自动分配 · 临期赠送额度优先</p>
      {keyForm && client.source === "opencode" && (
        <form
          className="cr-account"
          onSubmit={(e) => {
            e.preventDefault();
            const secret = key;
            setKey("");
            run(async () => {
              const id =
                keyForm.id ??
                unwrap(
                  await client.rpc.addAccount(
                    "opencode",
                    keyForm.service,
                    label || (keyForm.service === "opencode" ? "Zen" : "Go"),
                    "global",
                    client.signal,
                  ),
                );
              setKeyForm({ ...keyForm, id });
              unwrap(await client.rpc.setAccountKey(id, secret, client.signal));
              setKeyForm(undefined);
              setLabel("");
            });
          }}
        >
          <h4>{keyForm.id ? "更新密钥" : "添加 OpenCode 账号"}</h4>
          {!keyForm.id && (
            <>
              <Select
                label="OpenCode 服务"
                value={keyForm.service}
                options={[
                  { id: "opencode", label: "Zen" },
                  { id: "opencode-go", label: "Go" },
                ]}
                onChange={(id) =>
                  setKeyForm({ service: id as "opencode" | "opencode-go" })
                }
              />
              <label>
                备注
                <input
                  value={label}
                  maxLength={80}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
            </>
          )}
          <label>
            官方 API Key
            <input
              type="password"
              autoComplete="off"
              value={key}
              required
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <div className="cr-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setKey("");
                setKeyForm(undefined);
              }}
            >
              取消
            </Button>
            <Button type="submit" disabled={client.busy || !key.trim()}>
              连接
            </Button>
          </div>
        </form>
      )}
      {!accounts.length && <p className="cr-empty">尚未添加账号</p>}
      {accounts.map((account) => (
        <article className="cr-account" key={account.id}>
          <div className="cr-split">
            <strong title={account.label}>{account.label}</strong>
            <span className="cr-tag">{stateLabels[account.status]}</span>
          </div>
          <Quota account={account} />
          {account.error && (
            <p className="cr-error">{describe(account.error)}</p>
          )}
          <div className="cr-account-actions">
            <label>
              <input
                type="checkbox"
                checked={account.enabled}
                disabled={client.busy}
                onChange={(e) =>
                  run(async () =>
                    unwrap(
                      await client.rpc.updateAccount(
                        account.id,
                        e.target.checked,
                        client.signal,
                      ),
                    ),
                  )
                }
              />
              参与分配
            </label>
            <div className="cr-actions">
              <Button
                variant="ghost"
                size="sm"
                disabled={client.busy}
                onClick={() =>
                  run(async () =>
                    unwrap(
                      await client.rpc.refreshAccount(
                        account.id,
                        client.signal,
                      ),
                    ),
                  )
                }
              >
                刷新
              </Button>
              {account.service !== "anonymous" && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={client.busy}
                  onClick={() =>
                    account.source === "workbuddy"
                      ? void client.authorize(account.id)
                      : setKeyForm({
                          id: account.id,
                          service: account.service as
                            | "opencode"
                            | "opencode-go",
                        })
                  }
                >
                  {account.source === "workbuddy" ? "重新授权" : "更新密钥"}
                </Button>
              )}
              {account.service !== "anonymous" && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={client.busy}
                  onClick={() => setRemove(account.id)}
                >
                  移除
                </Button>
              )}
            </div>
          </div>
          {remove === account.id && (
            <div className="cr-inline-notice">
              移除该账号及其凭据？
              <Button variant="ghost" size="sm" onClick={() => setRemove("")}>
                取消
              </Button>
              <Button
                size="sm"
                disabled={client.busy}
                onClick={() =>
                  run(async () => {
                    unwrap(
                      await client.rpc.removeAccount(account.id, client.signal),
                    );
                    setRemove("");
                  })
                }
              >
                确认移除
              </Button>
            </div>
          )}
          {tests.find((t) => t.id === account.id) && (
            <p role="status">
              {tests.find((t) => t.id === account.id)?.result === "connected"
                ? "连接测试通过"
                : "连接测试失败"}
            </p>
          )}
        </article>
      ))}
    </section>
  );
}
function ModelRow({
  model,
  client,
}: {
  model: RouterModel;
  client: RouterClient;
}) {
  const config = client.config(model),
    mapKey = `${model.source}:${model.id}`;
  const mode =
    client.contextModes.get(mapKey) ??
    (config.context.mode === "auto"
      ? "auto"
      : contextOptions(model.contextWindow).includes(config.context.tokens)
        ? String(config.context.tokens)
        : "custom");
  const presets = contextOptions(model.contextWindow);
  const caps: [Capability, string][] = [
    ["tools", "工具调用"],
    ["images", "图片输入"],
    ["reasoning", "推理"],
  ];
  const change = (choice: string) => {
    client.contextModes.set(mapKey, choice);
    client.edit(model, {
      context:
        choice === "auto"
          ? { mode: "auto" }
          : {
              mode: "custom",
              tokens:
                choice === "custom"
                  ? config.context.mode === "custom"
                    ? config.context.tokens
                    : Math.min(64000, model.contextWindow!)
                  : Number(choice),
            },
    });
  };
  const error = contextError(model, config);
  return (
    <div className="cr-model">
      <div className="cr-model-main">
        <input
          type="checkbox"
          aria-label={`启用 ${model.name}`}
          checked={config.enabled}
          disabled={!!model.unavailable || client.busy}
          onChange={(e) => client.edit(model, { enabled: e.target.checked })}
        />
        <span className="cr-model-title">
          <strong
            className="cr-model-name"
            tabIndex={0}
            title={`${model.name}\n${model.id}`}
          >
            {model.name}
          </strong>
          <span className="cr-tag">{costLabels[model.cost]}</span>
        </span>
        {model.contextWindow ? (
          <div
            className="cr-context"
            role="radiogroup"
            onFocusCapture={(e) =>
              (e.target as HTMLElement).scrollIntoView({
                block: "nearest",
                inline: "nearest",
              })
            }
            aria-label={`${model.name} 的上下文长度`}
          >
            {["auto", ...presets.map(String), "custom"].map((value) => (
              <label
                key={value}
                className={mode === value ? "cr-selected" : ""}
                title={
                  value === "auto"
                    ? `自动 (${formatTokens(model.contextWindow!)})`
                    : value === "custom"
                      ? "自定义"
                      : `${Number(value).toLocaleString("zh-CN")} tokens`
                }
              >
                <input
                  type="radio"
                  name={`context-${mapKey}`}
                  aria-label={`${model.name} 上下文 ${value === "auto" ? "自动" : value === "custom" ? "自定义" : formatTokens(Number(value))}`}
                  checked={mode === value}
                  disabled={client.busy}
                  onChange={() => change(value)}
                />
                {value === "auto"
                  ? `自动 ${formatTokens(model.contextWindow!)}`
                  : value === "custom"
                    ? "自定义"
                    : formatTokens(Number(value))}
              </label>
            ))}
          </div>
        ) : (
          <span className="cr-muted cr-context-unknown">
            {model.input?.includes("text") !== false ? "上限未知" : "不适用"}
          </span>
        )}
      </div>
      <div className="cr-model-detail">
        <div className="cr-capabilities">
          {model.input?.includes("text") !== false && (
            <label>
              <input type="checkbox" checked readOnly disabled />
              文本
            </label>
          )}
          {caps
            .filter(([cap]) => model[cap])
            .map(([cap, title]) => (
              <label key={cap}>
                <input
                  type="checkbox"
                  checked={config.capabilities[cap] !== false}
                  disabled={
                    client.busy ||
                    (cap === "reasoning" && !model.reasoningCanDisable)
                  }
                  onChange={(e) =>
                    client.edit(model, {
                      capabilities: {
                        ...config.capabilities,
                        [cap]: e.target.checked,
                      },
                    })
                  }
                />
                {title}
              </label>
            ))}
          {model.input
            ?.filter((m) => !["text", "image"].includes(m))
            .map((m) => (
              <span key={m}>
                {(
                  { audio: "音频", video: "视频", pdf: "PDF" } as Record<
                    string,
                    string
                  >
                )[m] || m}
                输入（未接入）
              </span>
            ))}
          {model.output
            ?.filter((m) => m !== "text")
            .map((m) => (
              <span key={m}>{m} 输出</span>
            ))}
        </div>
        <small>
          上下文{" "}
          {model.contextWindow ? formatTokens(model.contextWindow) : "未知"} ·
          最大输出 {model.maxOutput ? formatTokens(model.maxOutput) : "未知"}
        </small>
        {mode === "custom" && (
          <label className="cr-custom">
            自定义 tokens
            <input
              type="number"
              min={4096}
              max={model.contextWindow}
              step={1}
              aria-label={`${model.name} 的自定义上下文长度`}
              aria-invalid={!!error}
              value={
                config.context.mode === "custom"
                  ? config.context.tokens || ""
                  : ""
              }
              disabled={client.busy}
              onChange={(e) =>
                client.edit(model, {
                  context: {
                    mode: "custom",
                    tokens: e.target.value === "" ? 0 : Number(e.target.value),
                  },
                })
              }
            />
          </label>
        )}
        {error && (
          <p className="cr-error" role="alert">
            {error}
          </p>
        )}
        {model.unavailable && (
          <p className="cr-muted">{describe(model.unavailable)}</p>
        )}
        {(model.cost === "paid" || model.cost === "unknown") && (
          <label className="cr-cost-consent">
            <input
              type="checkbox"
              checked={config.allowedCosts?.includes(model.cost) ?? false}
              disabled={client.busy}
              onChange={(e) =>
                client.edit(model, {
                  allowedCosts: e.target.checked
                    ? [
                        ...new Set([
                          ...(config.allowedCosts || ["free", "credits"]),
                          model.cost,
                        ]),
                      ]
                    : (config.allowedCosts || []).filter(
                        (c) => c !== model.cost,
                      ),
                })
              }
            />
            {model.cost === "paid"
              ? "允许此模型使用付费额度"
              : "允许调用费用未知的路线"}
          </label>
        )}
      </div>
    </div>
  );
}
function Models({ client }: { client: RouterClient }) {
  const [search, setSearch] = useState(""),
    [cap, setCap] = useState("all"),
    [enabled, setEnabled] = useState(false);
  const models = client.snapshot!.models[client.source].filter(
    (m) =>
      `${m.name} ${m.id}`.toLowerCase().includes(search.toLowerCase()) &&
      (!enabled || client.config(m).enabled) &&
      (cap === "all" || m[cap as Capability]),
  );
  return (
    <>
      <AccountPool key={client.source} client={client} />
      <div className="cr-heading">
        <h3>模型</h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={client.busy}
          onClick={() =>
            void client.action(async () => {
              unwrap(await client.rpc.refresh(client.source, client.signal));
              await client.load();
            }, "目录已刷新。")
          }
        >
          刷新目录
        </Button>
      </div>
      <div className="cr-filters">
        <input
          type="search"
          aria-label="搜索模型"
          placeholder="搜索模型"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          label="能力筛选"
          value={cap}
          options={[
            { id: "all", label: "全部能力" },
            { id: "tools", label: "工具调用" },
            { id: "images", label: "图片输入" },
            { id: "reasoning", label: "推理" },
          ]}
          onChange={setCap}
        />
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          仅看已启用
        </label>
      </div>
      {models.map((model) => (
        <ModelRow
          key={`${model.source}:${model.id}`}
          model={model}
          client={client}
        />
      ))}
      {!models.length && <p className="cr-empty">暂无匹配模型</p>}
    </>
  );
}
function Benefits({ client }: { client: RouterClient }) {
  const accounts = client.snapshot!.accounts.filter(
    (a) => a.source === client.source,
  );
  const [selected, setSelected] = useState(""),
    [data, setData] = useState<Value<"benefits">>(),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  const id = accounts.some((a) => a.id === selected)
    ? selected
    : accounts[0]?.id;
  useEffect(() => {
    const abort = new AbortController();
    setData(undefined);
    setError("");
    if (id)
      void client.rpc
        .benefits(id, abort.signal)
        .then(unwrap)
        .then(setData)
        .catch((e) => {
          if (!abort.signal.aborted) setError(e.message);
        });
    return () => abort.abort();
  }, [id, refresh, client]);
  const claim = (kind?: "checkin" | "compensation" | "gift") =>
    void client.action(async () => {
      const receipts = kind
        ? [unwrap(await client.rpc.claim(id!, kind, client.signal))]
        : unwrap(await client.rpc.claimEligible(id!, client.signal));
      setRefresh((n) => n + 1);
      await client.load();
      if (receipts.some((r) => r.state === "pending"))
        throw new Error("领取结果待核对，请刷新状态；不要重复领取。");
    }, "领取状态已更新。");
  const checkin = data && "checkin" in data ? data.checkin : undefined;
  return (
    <>
      {id && (
        <Select
          label="福利账号"
          value={id}
          options={accounts.map((a) => ({ id: a.id, label: a.label }))}
          onChange={setSelected}
          disabled={client.busy}
        />
      )}
      {!id ? (
        <p className="cr-empty">请先在模型来源中添加账号</p>
      ) : (
        <>
          <div className="cr-heading">
            <h3>今日签到</h3>
            <Button
              variant="ghost"
              size="sm"
              disabled={
                client.busy || !checkin?.active || checkin.todayCheckedIn
              }
              onClick={() => claim("checkin")}
            >
              {checkin?.todayCheckedIn ? "已签到" : "签到"}
            </Button>
          </div>
          <p className="cr-muted">
            {error ||
              (data?.unsupported
                ? "此账号不支持签到与福利"
                : !data
                  ? "正在查询…"
                  : checkin?.todayCheckedIn
                    ? `已签到 · 获得 ${checkin.todayCredit} 积分`
                    : checkin?.active
                      ? `签到可获得 ${checkin.dailyCredit} 积分`
                      : "暂无签到活动")}
          </p>
          {client.source === "workbuddy" && (
            <label className="cr-setting-row">
              启动时自动签到
              <input
                type="checkbox"
                checked={client.draft!.workbuddy.autoCheckin}
                disabled={client.busy}
                onChange={(e) => {
                  client.draft!.workbuddy.autoCheckin = e.target.checked;
                  client.changed();
                }}
              />
            </label>
          )}
          <div className="cr-heading">
            <h3>可领取活动</h3>
            <div className="cr-actions">
              <Button
                variant="ghost"
                size="sm"
                disabled={client.busy}
                onClick={() => setRefresh((n) => n + 1)}
              >
                刷新
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  client.busy ||
                  !data?.items.some((i) => i.active && !i.claimed)
                }
                onClick={() => claim()}
              >
                一键领取
              </Button>
            </div>
          </div>
          {data?.items
            .filter((i) => i.active || i.claimed)
            .map((item) => (
              <div className="cr-setting-row" key={item.kind}>
                <div>
                  <strong>
                    {item.kind === "gift" ? "赠送活动" : "补偿活动"}
                  </strong>
                  <p className="cr-muted">
                    {item.creditNum} 积分
                    {item.endsAtMs ? ` · ${time(item.endsAtMs)} 截止` : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={client.busy || item.claimed || !item.active}
                  onClick={() => claim(item.kind)}
                >
                  {item.claimed ? "已领取" : "领取"}
                </Button>
              </div>
            ))}
          {data && !data.items.some((i) => i.active && !i.claimed) && (
            <p className="cr-empty">暂无可领取活动</p>
          )}
          <details className="cr-history">
            <summary>领取记录</summary>
            <Logs
              client={client}
              account={id}
              operationsOnly
              compact
              key={id}
              refresh={refresh}
            />
          </details>
        </>
      )}
    </>
  );
}
function download(data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `connect-router-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Logs({
  client,
  account,
  operationsOnly,
  compact,
  refresh = 0,
}: {
  client: RouterClient;
  account?: string;
  operationsOnly?: boolean;
  compact?: boolean;
  refresh?: number;
}) {
  const [filter, setFilter] = useState<LogFilter>({
      account,
      kind: operationsOnly ? "operation" : undefined,
    }),
    [page, setPage] = useState<Value<"queryLogs">>({ items: [] }),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [feedback, setFeedback] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setError("");
    void client.rpc
      .queryLogs(filter, abort.signal)
      .then(unwrap)
      .then(setPage)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [client, filter, revision, refresh]);
  const change = (name: keyof LogFilter, value: string) =>
    setFilter({ ...filter, [name]: value || undefined, cursor: undefined });
  return (
    <section className="cr-logs">
      {feedback && (
        <FeedbackPanel
          client={client}
          filter={filter}
          onClose={() => setFeedback(false)}
        />
      )}
      {!compact && (
        <>
          <div className="cr-heading">
            <h3>日志</h3>
            <div className="cr-actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFeedback(true)}
              >
                反馈问题
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRevision((n) => n + 1)}
              >
                刷新
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={client.busy}
                onClick={() =>
                  void client.action(async () =>
                    download(
                      unwrap(
                        await client.rpc.exportDiagnostics(
                          { ...filter, cursor: undefined, limit: 500 },
                          client.signal,
                        ),
                      ),
                    ),
                  )
                }
              >
                导出诊断包
              </Button>
            </div>
          </div>
          <div className="cr-filters">
            <Select
              label="日志来源"
              value={filter.source || ""}
              onChange={(id) => {
                setFilter({
                  ...filter,
                  source: (id as SourceId) || undefined,
                  account: undefined,
                  model: undefined,
                  cursor: undefined,
                });
              }}
              options={[
                { id: "", label: "全部来源" },
                ...Object.entries(labels).map(([id, label]) => ({ id, label })),
              ]}
            />
            <Select
              label="日志账号"
              value={filter.account || ""}
              onChange={(id) => change("account", id)}
              options={[
                { id: "", label: "全部账号" },
                ...client
                  .snapshot!.accounts.filter(
                    (a) => !filter.source || a.source === filter.source,
                  )
                  .map((a) => ({ id: a.id, label: a.label })),
              ]}
            />
            <Select
              label="日志模型"
              value={filter.model || ""}
              onChange={(id) => change("model", id)}
              options={[
                { id: "", label: "全部模型" },
                ...Object.values(client.snapshot!.models)
                  .flat()
                  .filter((m) => !filter.source || m.source === filter.source)
                  .map((m) => ({ id: m.id, label: m.name })),
              ]}
            />
            <Select
              label="日志结果"
              value={filter.result || ""}
              onChange={(id) => change("result", id)}
              options={[
                { id: "", label: "全部结果" },
                ...[
                  "complete",
                  "success",
                  "failed",
                  "refused",
                  "pending",
                  "length",
                  "disconnected",
                  "timeout",
                  "cancelled",
                  "invalid",
                ].map((id) => ({ id, label: stateLabels[id]! })),
              ]}
            />
            <Select
              label="日志类型"
              value={filter.kind || ""}
              onChange={(id) => change("kind", id)}
              options={[
                { id: "", label: "全部日志" },
                { id: "request", label: "请求日志" },
                { id: "operation", label: "操作日志" },
              ]}
            />
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="cr-error">
          {error}
        </p>
      )}
      {page.items
        .filter(
          (entry) =>
            !compact ||
            [
              "AUTO_CHECKIN",
              "CHECKIN",
              "COMPENSATION",
              "GIFT",
              "CLAIM_ELIGIBLE",
            ].includes(entry.code || ""),
        )
        .map((entry) => {
          const detail = diagnostic(entry);
          return (
            <details key={entry.id}>
              <summary>
                <span>
                  {time(entry.at)}{" · "}
                  {entry.kind === "request" ? entry.model : entry.code}
                </span>
                <span className="cr-tag">
                  {stateLabels[entry.result] || entry.result}
                </span>
              </summary>
              <dl>
                <dt>请求标识</dt>
                <dd>{entry.id}</dd>
                <dt>来源 / 账号</dt>
                <dd>
                  {labels[entry.source]} / {entry.account || "—"}
                </dd>
                <dt>阶段 / 错误码</dt>
                <dd>
                  {detail.stage} / {entry.code || "—"}
                </dd>
                <dt>HTTP / 耗时</dt>
                <dd>
                  {entry.httpStatus ?? "未知"} /{" "}
                  {entry.durationMs === undefined
                    ? "未知"
                    : `${entry.durationMs} ms`}
                </dd>
                <dt>分配原因</dt>
                <dd>{entry.reason || "—"}</dd>
                <dt>输入 / 输出 tokens</dt>
                <dd>
                  {entry.inputTokens ?? "未知"} / {entry.outputTokens ?? "未知"}
                </dd>
                <dt>排查建议</dt>
                <dd>{detail.suggestion}</dd>
              </dl>
            </details>
          );
        })}
      {!page.items.some(
        (entry) =>
          !compact ||
          [
            "AUTO_CHECKIN",
            "CHECKIN",
            "COMPENSATION",
            "GIFT",
            "CLAIM_ELIGIBLE",
          ].includes(entry.code || ""),
      ) &&
        !error && <p className="cr-empty">暂无记录</p>}
      <div className="cr-actions">
        {filter.cursor && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilter({ ...filter, cursor: undefined })}
          >
            返回最新
          </Button>
        )}
        {page.nextCursor && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilter({ ...filter, cursor: page.nextCursor })}
          >
            更早记录
          </Button>
        )}
      </div>
    </section>
  );
}
function Diagnostics({ client }: { client: RouterClient }) {
  const [open, setOpen] = useState(false),
    [feedback, setFeedback] = useState(false);
  return (
    <>
      <div className="cr-heading">
        <h3>诊断与反馈</h3>
        <div className="cr-actions">
          <Button variant="ghost" onClick={() => setOpen(true)}>
            查看日志
          </Button>
          <Button variant="ghost" onClick={() => setFeedback(true)}>
            反馈问题
          </Button>
        </div>
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="连接日志"
        closeLabel="关闭日志"
        className="cr-dialog"
      >
        <div className="dsh-connect-router">
          {open && <Logs client={client} />}
        </div>
      </Modal>
      {feedback && (
        <FeedbackPanel
          client={client}
          filter={{}}
          onClose={() => setFeedback(false)}
        />
      )}
    </>
  );
}
export function RouterSettingsPage({ client }: { client: RouterClient }) {
  const [, render] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    const stop = client.subscribe(render);
    void client.action(() => client.load());
    return stop;
  }, [client]);
  return (
    <div className="dsh-connect-router">
      <h2>Connect Router</h2>
      <p className="cr-muted">在 Harness 中连接模型，管理额度与每日福利。</p>
      <div className="cr-tabs" role="tablist">
        {["签到与福利", "模型来源", "连接与恢复"].map((tab) => (
          <button
            key={tab}
            role="tab"
            aria-selected={client.tab === tab}
            onClick={() => {
              client.tab = tab;
              client.changed();
            }}
          >
            {tab}
          </button>
        ))}
      </div>
      {client.snapshot && client.draft ? (
        <>
          <div className="cr-source">
            <Select
              label="当前来源"
              value={client.source}
              options={Object.entries(labels).map(([id, label]) => ({
                id,
                label,
              }))}
              disabled={client.busy}
              onChange={(id) => {
                client.source = id as SourceId;
                client.changed();
              }}
            />
            <span className="cr-muted">
              {
                client.snapshot.accounts.filter(
                  (a) => a.source === client.source && a.status === "ready",
                ).length
              }{" "}
              个账号已连接
            </span>
          </div>
          {client.login && (
            <div className="cr-inline-notice" role="status">
              等待官方扫码授权
              <a
                href={client.login.verificationUri}
                target="_blank"
                rel="noreferrer"
              >
                打开登录页
              </a>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void client.action(() => client.cancelLogin())}
              >
                取消授权
              </Button>
            </div>
          )}
          {client.tab === "模型来源" ? (
            <Models client={client} />
          ) : client.tab === "签到与福利" ? (
            <Benefits key={client.source} client={client} />
          ) : (
            <>
              <h3>连接状态</h3>
              {client.snapshot.accounts
                .filter((a) => a.source === client.source)
                .map((a) => (
                  <div className="cr-setting-row" key={a.id}>
                    <strong>{a.label}</strong>
                    <span>
                      {stateLabels[a.status]}
                      {a.error ? ` · ${describe(a.error)}` : ""}
                    </span>
                  </div>
                ))}
              <Diagnostics client={client} />
            </>
          )}
        </>
      ) : (
        <p>
          {client.busy ? "正在读取…" : "未能读取设置"}
          {!client.busy && (
            <Button
              variant="ghost"
              onClick={() => void client.action(() => client.load())}
            >
              重试
            </Button>
          )}
        </p>
      )}
      <footer className="cr-footer">
        <div aria-live="polite">
          {client.error ? (
            <p className="cr-error" role="alert">
              {client.error}
            </p>
          ) : client.busy ? (
            "正在处理…"
          ) : (
            client.message || (client.dirty ? "有未保存修改" : "")
          )}
        </div>
        <div className="cr-actions">
          {client.dirty && (
            <Button
              variant="ghost"
              disabled={client.busy}
              onClick={() => client.undo()}
            >
              撤销
            </Button>
          )}
          <Button
            variant="primary"
            disabled={!client.dirty || client.busy || !!client.validation()}
            onClick={() => void client.save()}
          >
            保存设置
          </Button>
        </div>
      </footer>
    </div>
  );
}
