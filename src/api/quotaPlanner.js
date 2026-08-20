// QuotaManager only observes; this is the planner that turns what it has
// observed into a decision about how much queued work to actually perform
// right now, versus defer to a later scan. Kept as a separate, pure module
// rather than merged into QuotaManager or the HTTP client: quota state is a
// fact about the world, work planning is a policy decision on top of it,
// and the two change for different reasons.

// Never intentionally spend a bucket down toward zero: `reserve` is a flat
// floor, `minimumReserveFraction` a proportional one for large buckets -
// whichever leaves more headroom applies. X's own quota-warning threshold
// (QuotaManager.QUOTA_WARNING_REMAINING) is 5; this reserves well above
// that so hitting the warning is already a sign the plan under-reserved,
// not a routine occurrence.
export const DEFAULT_RESERVE = 20;
export const DEFAULT_MINIMUM_RESERVE_FRACTION = 0.05;

// How much of a quota bucket is safe to spend, after reserving margin. Null
// means "unknown" (no quota has been observed for this operation yet this
// scan) - deliberately distinct from 0 ("observed, and exhausted"), since a
// caller needs to tell those apart to pick a sensible fallback.
export function usableQuota(quota, {
  reserve = DEFAULT_RESERVE,
  minimumReserveFraction = DEFAULT_MINIMUM_RESERVE_FRACTION,
} = {}) {
  if (!quota || !Number.isFinite(quota.remaining)) return null;
  const proportionalReserve = Number.isFinite(quota.limit)
    ? Math.ceil(quota.limit * minimumReserveFraction)
    : 0;
  const effectiveReserve = Math.max(reserve, proportionalReserve);
  return Math.max(0, quota.remaining - effectiveReserve);
}

// `queueLength` is how much work is actually pending. `quota` is whatever
// QuotaManager has observed for the specific operation this work spends -
// null if nothing has been observed yet this scan, which is not the same
// claim as "exhausted." `unknownQuotaFallback` governs sizing only in that
// unobserved case (matches this project's previous fixed-400 behavior, the
// safe default before any quota had actually been read this scan);
// `perRunSafetyCap` is an unconditional ceiling regardless of what the
// quota math says, e.g. so a corrupted header reading can't authorize an
// enormous single run.
export function planWork(queueLength, quota, {
  perRunSafetyCap = 600,
  unknownQuotaFallback = 400,
  reserve,
  minimumReserveFraction,
} = {}) {
  const queue = Math.max(0, Math.trunc(Number(queueLength) || 0));
  if (queue === 0) {
    return { processNow: 0, defer: 0, usable: null, resetAt: null, reason: "queue-empty" };
  }

  const usable = usableQuota(quota, { reserve, minimumReserveFraction });
  const budget = usable == null
    ? Math.min(unknownQuotaFallback, perRunSafetyCap)
    : Math.min(usable, perRunSafetyCap);
  const processNow = Math.max(0, Math.min(queue, budget));
  const defer = queue - processNow;
  const resetAt = quota?.resetAt ?? null;

  let reason;
  if (defer === 0) {
    reason = "queue-fits";
  } else if (usable === 0) {
    reason = "quota-exhausted";
  } else if (usable != null && usable < perRunSafetyCap) {
    reason = "quota-budget";
  } else {
    reason = "run-limit";
  }
  return { processNow, defer, usable, resetAt, reason };
}
