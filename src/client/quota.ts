import type { QuotaBucket } from "../shared/types.js";

export const quotaLabels = {
  gift: "赠送",
  subscription: "套餐",
  paid: "付费",
  unknown: "类别未知",
};
const valid = (n: number | undefined): n is number =>
  n !== undefined && Number.isFinite(n) && n >= 0;
/** Presentation only: allocation continues to use original buckets. */
export function summarizeQuota(
  buckets: QuotaBucket[],
  unit: string,
  now = Date.now(),
) {
  const active = buckets.filter(
    (q) => q.unit === unit && (q.expiresAt === undefined || q.expiresAt > now),
  );
  const groups = (Object.keys(quotaLabels) as QuotaBucket["kind"][])
    .map((kind) => {
      const rows = active.filter((q) => q.kind === kind);
      return {
        kind,
        count: rows.length,
        known: rows.reduce(
          (s, q) => s + (valid(q.remaining) ? q.remaining : 0),
          0,
        ),
        unknown: rows.some((q) => !valid(q.remaining)),
      };
    })
    .filter((g) => g.count);
  const known = groups.reduce((s, g) => s + g.known, 0);
  const complete =
    active.length > 0 &&
    active.every(
      (q) => valid(q.remaining) && valid(q.total) && q.remaining <= q.total,
    );
  const total = complete ? active.reduce((s, q) => s + q.total!, 0) : undefined;
  return {
    groups,
    known,
    unknown: groups.some((g) => g.unknown),
    total,
    proportional: total !== undefined && total > 0,
    expired: buckets.filter(
      (q) => q.unit === unit && q.expiresAt !== undefined && q.expiresAt <= now,
    ).length,
  };
}
