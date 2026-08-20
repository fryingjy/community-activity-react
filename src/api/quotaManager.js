// X reports rate limits per operation, not globally: a Community roster
// request and a search request draw from independent 15-minute buckets even
// though both go through the same graphqlGet() call site. QuotaManager turns
// the x-rate-limit-* response headers into queryable per-operation state
// instead of leaving that bookkeeping inline in the HTTP retry loop.

export const QUOTA_WARNING_REMAINING = 5;

function numberHeader(headers, name) {
  const raw = headers.get(name);
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function readRateLimitHeaders(headers) {
  const limit = numberHeader(headers, "x-rate-limit-limit");
  const remaining = numberHeader(headers, "x-rate-limit-remaining");
  const resetAtSeconds = numberHeader(headers, "x-rate-limit-reset");
  if (limit == null && remaining == null && resetAtSeconds == null) return null;
  return {
    limit,
    remaining,
    resetAt: resetAtSeconds == null ? null : resetAtSeconds * 1000,
  };
}

export class QuotaManager {
  // `quotas` is the same plain object requestStats.quotas already pointed at
  // before this module existed; QuotaManager wraps it by reference so every
  // existing reader (diagnostics.js, the CSV/UI layers) keeps working
  // unchanged.
  constructor(quotas = {}) {
    this.quotas = quotas;
  }

  record(operation, headerInfo) {
    if (!headerInfo) return null;
    const previous = this.quotas[operation] || {};
    const quota = {
      limit: headerInfo.limit,
      remaining: headerInfo.remaining,
      resetAt: headerInfo.resetAt,
      warned: previous.warned === true,
    };
    const enteringWarning =
      quota.remaining != null && quota.remaining <= QUOTA_WARNING_REMAINING && !quota.warned;
    if (enteringWarning) quota.warned = true;
    this.quotas[operation] = quota;
    return { quota, enteringWarning };
  }

  get(operation) {
    return this.quotas[operation] || null;
  }

  isExhausted(operation, now = Date.now()) {
    const quota = this.get(operation);
    if (!quota || quota.remaining == null) return false;
    if (quota.remaining > 0) return false;
    return quota.resetAt == null || quota.resetAt > now;
  }

  msUntilReset(operation, now = Date.now()) {
    const quota = this.get(operation);
    if (!quota?.resetAt) return 0;
    return Math.max(0, quota.resetAt - now);
  }

  snapshot() {
    return this.quotas;
  }
}
