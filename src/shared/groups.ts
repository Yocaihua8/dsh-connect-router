import type { ModelGroup, RouterModel, SourceSettings, GroupSettings, ModelSettings, CostClass } from "./types.js";
import { settingsFor, sameModelSettings } from "../host/model-settings.js";

const tuple = (m: RouterModel) => [m.source, m.service || m.source, m.region || "global"];
export const routeKey = (m: RouterModel) => `route:${encodeURIComponent(JSON.stringify([...tuple(m), m.upstreamId || m.id]))}`;
export const approvalKey = (m: RouterModel) => `${routeKey(m)}:${m.cost}`;
export const groupKey = (m: RouterModel) => `group:${encodeURIComponent(JSON.stringify([...tuple(m), m.name.trim().normalize("NFC")]))}`;
export const feeOrder: Record<CostClass, number> = { free: 0, credits: 1, paid: 2, unknown: 3 };
export function isGroup(m: RouterModel): m is ModelGroup { return "routes" in m; }
export function uniqueRoutes(rows: readonly RouterModel[]) {
  const map = new Map<string, RouterModel>();
  for (const r of rows) {
    const key = routeKey(r), prior = map.get(key);
    if (!prior || prior.unavailable && !r.unavailable) map.set(key, r);
  }
  return [...map.values()];
}
export function inheritedGroupSettings(routes: readonly RouterModel[], settings: SourceSettings): GroupSettings {
  const enabled = uniqueRoutes(routes).map(m => ({ model: m, config: settingsFor(settings, m) })).filter(r => r.config.enabled);
  const base = enabled[0]?.config ?? { enabled: false, context: { mode: "auto" as const }, capabilities: {}, allowedCosts: ["free", "credits"] as CostClass[] };
  return {
    ...structuredClone(base),
    approvedRoutes: enabled.filter(r => ["paid", "unknown"].includes(r.model.cost) && (r.config.allowedCosts || ["free", "credits"]).includes(r.model.cost)).map(r => approvalKey(r.model)),
    ...(enabled.some(r => !sameModelSettings(base, r.config)) ? { needsReview: true } : {}),
  };
}
export function groupSettings(m: ModelGroup, settings: SourceSettings): GroupSettings {
  const existing = settings.groups?.[m.id];
  if (existing) return existing;
  // Once group migration has happened, retained legacy IDs are aliases, not
  // authorization to silently enable a newly named group on a future refresh.
  if (settings.groups) return { enabled: false, context: { mode: "auto" }, capabilities: {}, allowedCosts: ["free", "credits"], approvedRoutes: [] };
  return inheritedGroupSettings(m.routes, settings);
}
export function feeAllowed(m: RouterModel, config: GroupSettings) {
  return (config.allowedCosts || ["free", "credits"]).includes(m.cost) &&
    (!["paid", "unknown"].includes(m.cost) || config.approvedRoutes.includes(approvalKey(m)));
}
export function groupCandidates(group: ModelGroup, config: GroupSettings) {
  const caps = config.capabilities;
  return group.routes.filter(r => !r.unavailable && r.accountEligible !== false && feeAllowed(r, config) &&
    (!(group.tools && caps.tools !== false) || r.tools) &&
    (!(group.images && caps.images !== false) || r.images) &&
    (!(group.reasoning && caps.reasoning !== false) || r.reasoning) &&
    !(caps.reasoning === false && r.reasoning && !r.reasoningCanDisable));
}
export function groupWindow(group: ModelGroup, config: GroupSettings) {
  const known = groupCandidates(group, config).map(r => r.contextWindow).filter((v): v is number => !!v);
  return known.length ? Math.max(...known) : undefined;
}
export function groupError(group: ModelGroup, config: GroupSettings): string {
  if (config.needsReview) return "GROUP_SETTINGS_REVIEW_REQUIRED";
  const candidates = groupCandidates(group, config);
  if (!candidates.length) return "NO_MATCHING_GROUP_ROUTE";
  if (config.context.mode === "custom" && (!Number.isSafeInteger(config.context.tokens) || config.context.tokens < 4096 ||
    !candidates.some(r => !!r.contextWindow && r.contextWindow >= (config.context as {tokens:number}).tokens))) return "CONTEXT_LIMIT_UNCONFIRMED";
  return "";
}
export function configuredGroup(group: ModelGroup, config: GroupSettings): RouterModel {
  const error = groupError(group, config);
  if (error) throw new Error(error);
  const window = config.context.mode === "custom" ? config.context.tokens : groupWindow(group, config);
  const rows = groupCandidates(group, config).filter(r => !window || !!r.contextWindow && r.contextWindow >= window);
  const outputs = rows.map(r => r.maxOutput);
  const efforts = rows[0]?.reasoningEfforts?.filter(e => rows.every(r => r.reasoningEfforts?.includes(e)));
  return { ...group, contextWindow: window,
    maxOutput: outputs.length && outputs.every((v): v is number => !!v) ? Math.min(...outputs) : undefined,
    cost: [...rows].sort((a,b) => feeOrder[a.cost]-feeOrder[b.cost])[0]?.cost || "unknown",
    tools: group.tools && config.capabilities.tools !== false,
    images: group.images && config.capabilities.images !== false,
    reasoning: group.reasoning && config.capabilities.reasoning !== false,
    reasoningCanDisable: rows.every(r => !r.reasoning || r.reasoningCanDisable), reasoningEfforts: efforts };
}
/** Keep per-account capability rows: the display union is never proof a route can execute. */
export function modelGroups(rows: readonly RouterModel[], settings: SourceSettings): ModelGroup[] {
  const map = new Map<string, RouterModel[]>();
  for (const r of rows) { const k = groupKey(r); map.set(k, [...(map.get(k) || []), r]); }
  return [...map].map(([id, routes]) => {
    const active = routes.filter(r => !r.unavailable), view = active.length ? active : routes;
    const first = view[0]!;
    const group: ModelGroup = { ...first, id, name: first.name.trim().normalize("NFC"), upstreamId: undefined, accountId: undefined, routes,
      tools: view.some(r => r.tools), images: view.some(r => r.images), reasoning: view.some(r => r.reasoning),
      reasoningCanDisable: view.some(r => !r.reasoning || r.reasoningCanDisable),
      unavailable: active.length ? undefined : first.unavailable || "NO_AVAILABLE_ROUTE" };
    const config = groupSettings(group, settings);
    group.contextWindow = groupWindow(group, config);
    group.cost = [...groupCandidates(group, config)].sort((a,b) => feeOrder[a.cost]-feeOrder[b.cost])[0]?.cost || first.cost;
    group.needsReview = config.needsReview;
    return group;
  });
}
export function sameGroupSettings(a: GroupSettings, b: GroupSettings) {
  return sameModelSettings(a,b) && !!a.needsReview === !!b.needsReview && JSON.stringify([...new Set(a.approvedRoutes)].sort()) === JSON.stringify([...new Set(b.approvedRoutes)].sort());
}
/** Preserve former actual choices, never promote diagnostic-only members of an enabled group. */
export function retainedWorkBuddyIds(settings: SourceSettings, region: string, rows: readonly RouterModel[]) {
  const legacy = [...settings.enabledModels, ...Object.entries(settings.models || {}).filter(([, c]) => c.enabled).map(([id]) => id)]
    .filter(id => !id.includes("/") || id.startsWith(`${region}/`)).map(id => id.replace(new RegExp(`^${region}/`), ""));
  const grouped = rows.filter(m => m.region === region && !m.unavailable && settings.groups?.[groupKey(m)]?.enabled)
    .map(m => m.upstreamId || m.id.replace(new RegExp(`^${region}/`), ""));
  return [...new Set([...legacy, ...grouped])];
}
