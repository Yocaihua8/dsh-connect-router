export type SourceId = "workbuddy" | "opencode";
export type CostClass = "free" | "credits" | "paid" | "unknown";
export type CompletionState =
  | "complete"
  | "length"
  | "disconnected"
  | "timeout"
  | "cancelled"
  | "refused"
  | "invalid";
export interface RouterModel {
  id: string;
  source: SourceId;
  name: string;
  cost: CostClass;
  contextWindow?: number;
  maxOutput?: number;
  tools: boolean;
  images: boolean;
  reasoning: boolean;
  upstreamId?: string;
  service?: string;
  region?: string;
  unavailable?: string;
  input?: readonly string[];
  output?: readonly string[];
  reasoningCanDisable?: boolean;
  reasoningEfforts?: readonly string[];
  accountId?: string;
  accountEligible?: boolean;
}
export interface GroupSettings extends ModelSettings {
  /** Explicit fee approvals are bound to existing routes, never new paid routes. */
  approvedRoutes: string[];
  needsReview?: boolean;
}
export interface ModelGroup extends RouterModel {
  routes: RouterModel[];
  needsReview?: boolean;
}
export type Capability = "tools" | "images" | "reasoning";
export interface ModelSettings {
  enabled: boolean;
  context: { mode: "auto" } | { mode: "custom"; tokens: number };
  capabilities: Partial<Record<Capability, boolean>>;
  allowedCosts?: CostClass[];
}
export interface AccountRecord {
  id: string;
  source: SourceId;
  service: "workbuddy" | "opencode" | "opencode-go" | "anonymous";
  region: "cn" | "global";
  label: string;
  enabled: boolean;
}
export interface QuotaBucket {
  kind: "gift" | "subscription" | "paid" | "unknown";
  unit: string;
  remaining?: number;
  total?: number;
  expiresAt?: number;
}
export interface AccountSnapshot extends AccountRecord {
  status: "ready" | "auth-required" | "unavailable";
  models: RouterModel[];
  quota: QuotaBucket[];
  updatedAt?: number;
  lastUsed?: number;
  error?: string;
}
export interface SourceSettings {
  enabledModels: string[];
  contextBudget?: number;
  autoCheckin: boolean;
  models?: Record<string, ModelSettings>;
  groups?: Record<string, GroupSettings>;
}
export interface RouterSettings {
  workbuddy: SourceSettings;
  opencode: SourceSettings;
}
export interface Receipt {
  key: string;
  state: "pending" | "confirmed" | "unsupported";
  at: number;
}
export interface StreamFinish {
  state: CompletionState;
  tools: number;
  code?: string;
  httpStatus?: number;
}
export interface SessionRecovery extends StreamFinish {
  provider: string;
  model: string;
  at: number;
}
export const CONTINUE_PROMPT =
  "请从刚才中断的位置继续生成，保留已完成的内容，不重复执行已完成的工具。";
export interface RouterSnapshot {
  settings: RouterSettings;
  accounts: AccountSnapshot[];
  models: Record<SourceId, RouterModel[]>;
  groups?: Record<SourceId, ModelGroup[]>;
}
export interface LoginStart {
  loginId: string;
  verificationUri: string;
  expiresIn: number;
}
export interface BenefitStatus {
  unsupported: boolean;
  checkin?: {
    active: boolean;
    todayCheckedIn: boolean;
    todayCredit: number;
    dailyCredit: number;
    streakDays: number;
  };
  items: readonly {
    kind: "compensation" | "gift";
    active: boolean;
    claimed: boolean;
    creditNum: number;
    endsAtMs?: number;
    claimedAtMs?: number;
  }[];
}
export interface AccountTestResult {
  id: string;
  result: string;
  modelCount?: number;
  code?: string;
}

export interface LogEntry {
  id: string;
  at: number;
  kind: "request" | "operation";
  source: SourceId;
  account?: string;
  model?: string;
  group?: string;
  route?: string;
  result: string;
  code?: string;
  reason?: "expiring-gift" | "available-quota" | "least-recent" | "pinned" | "free-first";
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  httpStatus?: number;
}
export interface LogFilter {
  source?: SourceId;
  account?: string;
  model?: string;
  result?: string;
  kind?: LogEntry["kind"];
  before?: number;
  cursor?: string;
  limit?: number;
}

export interface DiagnosticBundle {
  schema: number;
  pluginVersion: string;
  targetDshVersion: string;
  platform: string;
  nodeVersion: string;
  generatedAt: string;
  page: {
    items: (LogEntry & { stage: string; suggestion: string })[];
    nextCursor?: string;
  };
  accounts: {
    id: string;
    source: SourceId;
    service: AccountRecord["service"];
    status: AccountSnapshot["status"];
    enabled: boolean;
    updatedAt?: number;
    modelCount: number;
  }[];
}

export type { FeedbackAuth, FeedbackLogin, FeedbackReport } from "./feedback.js";
