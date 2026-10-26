import type { LogEntry } from "./logs.js";
const hints: Record<string, string> = {
  AUTH_REQUIRED: "重新完成官方授权或更新此账号密钥；核对凭据读写与刷新状态。",
  AUTH_EXPIRED: "检查凭据有效期、刷新响应与账号隔离，重新授权后复测。",
  NO_ELIGIBLE_ACCOUNT:
    "核对账号启用状态、模型资格、费用策略、已知额度及上下文要求。",
  PINNED_ACCOUNT_UNAVAILABLE:
    "本轮绑定账号已不可用；保留内容，不自动换号重放工具。",
  CONTEXT_OVERFLOW:
    "对照实际模型窗口、请求预算及压缩记录，检查上游上下文分类。",
  MISSING_COMPLETION_EVIDENCE:
    "检查流结束事件、网络中断及解析器帧边界；不能补发成功终止符。",
  UPSTREAM_REJECTED:
    "核对上游限制类型、HTTP 状态与重置时间；不要循环重试或切换付费模型。",
  UPSTREAM_HARD_CREDIT:
    "额度不足；核对额度查询字段与扣减时间，刷新额度后重新评估可用性。",
  UPSTREAM_SOFT_RATE: "上游账号频率限制；核对重置时间，避免自动重试。",
  UPSTREAM_CHANNEL_REJECT:
    "上游拒绝当前调用通道；核对协议与渠道资格，不修改系统指令绕过限制。",
  UPSTREAM_MODEL_BUSY:
    "模型繁忙；检查错误分类和服务恢复时间，不将其记成账号失效。",
  REFRESH_FAILED:
    "检查目录请求、网络与返回结构；目录失败不能当作零模型或零额度。",
};
export function diagnostic(entry: LogEntry) {
  return {
    ...entry,
    stage:
      entry.kind === "operation"
        ? "account-operation"
        : entry.result === "refused"
          ? "upstream-response"
          : "stream",
    suggestion:
      hints[entry.code || ""] ??
      (entry.result === "complete" || entry.result === "success"
        ? "未检测到异常。"
        : "使用请求标识关联同一次操作，检查该阶段的协议解析与取消处理。"),
  };
}
