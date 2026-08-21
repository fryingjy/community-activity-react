import { graphqlGet } from "../api/graphqlClient.js";
import { AdaptiveRateLimiter, delay } from "../api/rateLimiter.js";
import { planWork } from "../api/quotaPlanner.js";
import { DOCUMENT_IDS, TIMELINE_FEATURES } from "../api/operations.js";
import { StoppedError } from "../core/errors.js";
import { communityActivityKind, parseCommunityTimelinePage } from "./timelineParser.js";

const ACTIVITY_SEARCH_VERIFICATION_SCHEMA = 2;
// Positive evidence ("this account posted at time T") is a fact about the
// past and does not expire - not tied to a lookback window, since a search
// answers "when did this account last post here" regardless of which
// rolling window is selected today. Negative evidence ("no qualifying post
// found as of this check") only proves silence up to the moment it was
// checked; applying the same day-long TTL to it let a stale "nothing found"
// answer stand in for "still nothing" across a whole day of re-scans, even
// after the member posted in the meantime - exactly the case direct
// verification exists to catch, since it only runs on members the broader
// crawl already flagged. Short enough that an ordinary same-day re-scan
// always re-verifies; long enough to survive a normal resume/retry within
// one scan session without re-spending a request on the same candidate.
const POSITIVE_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_EVIDENCE_MAX_AGE_MS = 30 * 60 * 1000;

function activitySearchVerificationKey(communityId) {
  return `activitySearchVerification:${communityId}`;
}

// Exported so callers building the flagged list (and filtering it after
// verification) use the exact same identity rule as the cache keys below;
// two independent copies of this logic drifting apart would silently break
// the match between a flagged member and its verification result.
export function activitySearchCandidateIdentity(candidate) {
  return candidate?.user_id
    ? `id:${String(candidate.user_id)}`
    : `username:${String(candidate?.username || "").toLowerCase()}`;
}

// Matches the live contract captured from x.com's own Community search UI on
// 2026-07-31: `query` is exactly `(from:<username>)` — parentheses included —
// with `timelineRankingMode: "Recency"` so the newest post sorts first.
export function buildActivitySearchVariables(communityId, username, cursor = null) {
  return {
    count: 20,
    query: `(from:${username})`,
    communityId,
    timelineRankingMode: "Recency",
    includePromotedContent: false,
    timelineId: `communityTweetSearch-${communityId}-from-${username}-Recency`,
    withBirdwatchNotes: false,
    withDmMuting: false,
    withClientEventToken: false,
    withVoice: false,
    isListMemberTargetUserId: "0",
    withCommunity: false,
    withQuickPromoteEligibilityTweetFields: false,
    withGrokTranslatedBio: false,
    includeProfessionalCategory: true,
    ...(cursor ? { cursor } : {}),
  };
}

// A repost can appear in a Community feed without the account having authored
// anything there, so it must not count as a post when deciding whether the
// member has been active.
export function latestCommunityPostAt(tweets) {
  let latest = null;
  for (const tweet of tweets || []) {
    if (communityActivityKind(tweet) === "repost") continue;
    const createdAt = tweet?.legacy?.created_at ? new Date(tweet.legacy.created_at) : null;
    if (!createdAt || Number.isNaN(createdAt.getTime())) continue;
    if (!latest || createdAt > latest) latest = createdAt;
  }
  return latest;
}

// How far back a page of search results actually reaches, regardless of
// tweet kind - a page of nothing but reposts still proves the search has
// paged past a given point in time, which is what tells the pagination loop
// below it is safe to stop instead of fetching another page it does not
// need.
function oldestResultAt(tweets) {
  let oldest = null;
  for (const tweet of tweets || []) {
    const createdAt = tweet?.legacy?.created_at ? new Date(tweet.legacy.created_at) : null;
    if (!createdAt || Number.isNaN(createdAt.getTime())) continue;
    if (!oldest || createdAt < oldest) oldest = createdAt;
  }
  return oldest;
}

// The broad Community timeline/media/word-shard crawl that supplies
// `activityDetailsForMember` can miss a member's post: it never covers the full
// history, and the generic word-shard search only catches posts containing one
// of a handful of common words. A member with genuine activity the crawl did
// not happen to see is then flagged inactive incorrectly.
//
// `CommunityTweetSearchModuleQuery` — the same operation and document ID the
// word-shard backfill already uses — accepts an X search operator directly:
// `(from:<username>)` scoped to `communityId` returns exactly that member's
// posts in this Community, ranked by recency. One request per member settles
// the question with certainty instead of inference, so this is meant to run
// only against members a scan has already flagged, not the full roster: the
// full roster is tens of thousands of accounts, and it is not a request budget
// this can spend on everyone.
export async function verifyMemberActivityViaSearch(
  communityId,
  candidates,
  {
    signal,
    requestStats,
    log,
    onProgress,
    operation,
    sinceDate,
    // Verified directly against x.com's own rate-limit response headers:
    // CommunityTweetSearchModuleQuery gets its own 500-per-15-minute bucket,
    // separate from every other operation this scan uses. This many-run-old
    // constant is now only the *fallback* size used when this operation's
    // quota has not actually been observed yet this scan (its own first
    // request, or a scan that never ran the word-shard backfill first) -
    // once quotaManager.js has a real reading, quotaPlanner.js's planWork()
    // sizes the run from that instead of guessing. See quotaPlanner.js for
    // why "unread" and "exhausted" are handled differently.
    maxCandidatesPerRun = 400,
    // A page of nothing but reposts does not prove inactivity - the
    // qualifying post could be one page further back. Most candidates
    // resolve on the first page (a qualifying post, or a page old enough to
    // have already crossed the requested window boundary); this bounds how
    // far a single ambiguous candidate can page before its evidence still
    // counts as inconclusive, so one hard-to-resolve account cannot consume
    // an unbounded share of the run's shared quota.
    maxPagesPerCandidate = 5,
    // Both default to the real pacing/backoff, so no production call site is
    // affected - see the identical seam on fetchCommunityMembersByCursor and
    // fetchActiveAuthors.
    limiter: injectedLimiter,
    delayFn = delay,
  } = {}
) {
  const searchOperation = operation || {
    documentId: DOCUMENT_IDS.CommunityTweetSearchModuleQuery,
    operation: "CommunityTweetSearchModuleQuery",
  };
  const key = activitySearchVerificationKey(communityId);
  const stored = (await chrome.storage.local.get(key))[key];
  const entries = stored?.schema === ACTIVITY_SEARCH_VERIFICATION_SCHEMA &&
    stored.entries && typeof stored.entries === "object"
    ? { ...stored.entries }
    : {};
  const now = Date.now();

  // A cached entry is only trustworthy for the exact question it actually
  // answered: the account it searched (the query is username-based even
  // though the cache key is stable-ID-based - a rename invalidates it, since
  // a search for the old handle stops being the right query, and may not
  // even resolve to the same account's posts any more) and, for a negative
  // result, how recently it was checked (see NEGATIVE_EVIDENCE_MAX_AGE_MS
  // above for why that can't share positive evidence's day-long TTL).
  function entryIsReusable(entry, candidate) {
    if (!entry?.checkedAt) return false;
    if (String(entry.usernameAtCheck || "").toLowerCase() !== String(candidate?.username || "").toLowerCase()) {
      return false;
    }
    const maxAge = entry.lastPostAt ? POSITIVE_EVIDENCE_MAX_AGE_MS : NEGATIVE_EVIDENCE_MAX_AGE_MS;
    return now - entry.checkedAt <= maxAge;
  }

  const seenIdentities = new Set();
  const pendingCandidates = [];
  for (const candidate of candidates || []) {
    if (!candidate?.username) continue;
    const identity = activitySearchCandidateIdentity(candidate);
    if (seenIdentities.has(identity)) continue;
    seenIdentities.add(identity);
    if (entryIsReusable(entries[identity], candidate)) continue;
    pendingCandidates.push({ identity, candidate });
  }

  const limiter = injectedLimiter || new AdaptiveRateLimiter(1250);
  const searchFeatures = searchOperation.features && Object.keys(searchOperation.features).length
    ? searchOperation.features
    : TIMELINE_FEATURES;
  // The observed quota, if any request against this operation already ran
  // earlier in the same scan (e.g. the word-shard backfill shares this
  // exact bucket) - null means genuinely unread, not exhausted.
  const observedQuota = requestStats?.quotas?.[searchOperation.operation] || null;
  const plan = planWork(pendingCandidates.length, observedQuota, {
    unknownQuotaFallback: maxCandidatesPerRun,
  });
  let checked = 0;
  let stoppedReason = pendingCandidates.length ? plan.reason : "up-to-date";
  let terminalError = null;

  try {
    for (const { identity, candidate } of pendingCandidates.slice(0, plan.processNow)) {
      if (signal?.aborted) throw new StoppedError();
      try {
        let cursor = null;
        let lastPostAt = null;
        let pagesChecked = 0;
        // Page newest-to-oldest until one of three things actually proves
        // the answer: a qualifying post/reply is found (ACTIVE - stop
        // immediately, no need to page further back than the newest
        // evidence); the page's oldest result has already aged past the
        // window this scan cares about (INACTIVE, proven - anything further
        // back cannot change that verdict); or X's own cursor ends
        // (INACTIVE, proven exhaustively). Only the budget/error paths below
        // leave the answer unresolved.
        while (pagesChecked < maxPagesPerCandidate) {
          const payload = await graphqlGet(
            searchOperation.documentId,
            searchOperation.operation,
            buildActivitySearchVariables(communityId, candidate.username, cursor),
            searchFeatures,
            {
              signal,
              requestStats,
              log,
              limiter,
              maxAttempts: 3,
              clientTransactionId: searchOperation.clientTransactionId || null,
              delayFn,
            }
          );
          const page = parseCommunityTimelinePage(payload, "search");
          pagesChecked++;
          const pageLatest = latestCommunityPostAt(page.tweets);
          if (pageLatest) {
            lastPostAt = pageLatest;
            break;
          }
          const oldestOnPage = oldestResultAt(page.tweets);
          const boundaryReached = Boolean(sinceDate && oldestOnPage && oldestOnPage < sinceDate);
          if (boundaryReached || !page.nextCursor) break;
          cursor = page.nextCursor;
        }
        entries[identity] = {
          checkedAt: Date.now(),
          lastPostAt: lastPostAt ? lastPostAt.toISOString() : null,
          usernameAtCheck: candidate.username,
        };
        checked++;
        if (checked % 10 === 0) {
          await chrome.storage.local.set({
            [key]: { schema: ACTIVITY_SEARCH_VERIFICATION_SCHEMA, updatedAt: Date.now(), entries },
          });
        }
        onProgress?.({ checked, queued: pendingCandidates.length });
      } catch (error) {
        if (error instanceof StoppedError || error?.name === "StoppedError") throw error;
        terminalError = error;
        stoppedReason = error?.code === "rate-limited" ? "rate-limited" : "request-error";
        break;
      }
    }
  } finally {
    // Every exit path - normal completion, a request error breaking the
    // loop, or an interruption thrown mid-candidate from the signal check
    // above - persists whatever was actually checked. Without this, an
    // interruption between periodic saves (every 10 candidates) silently
    // lost that progress, and a resume re-spent real, rate-limited requests
    // re-checking candidates that had already been confirmed.
    await chrome.storage.local.set({
      [key]: { schema: ACTIVITY_SEARCH_VERIFICATION_SCHEMA, updatedAt: Date.now(), entries },
    });
  }

  if (!terminalError && checked >= pendingCandidates.length) stoppedReason = "queue-complete";

  const results = new Map();
  for (const candidate of candidates || []) {
    if (!candidate?.username) continue;
    const identity = activitySearchCandidateIdentity(candidate);
    if (results.has(identity)) continue;
    const entry = entries[identity];
    // A candidate this run didn't have quota to reach still has whatever
    // entry was already cached - which entryIsReusable() above already
    // judged too stale or username-mismatched to select for re-verification
    // in the first place. Returning it here anyway would silently launder a
    // rejected cache entry back in as this run's answer.
    if (!entry || !entryIsReusable(entry, candidate)) continue;
    const lastPostAt = entry.lastPostAt ? new Date(entry.lastPostAt) : null;
    results.set(identity, {
      username: candidate.username,
      lastPostAt: entry.lastPostAt || null,
      hasActivityInWindow: Boolean(lastPostAt && sinceDate && lastPostAt >= sinceDate),
      checkedAt: entry.checkedAt,
    });
  }

  return {
    results,
    checked,
    queued: pendingCandidates.length,
    remaining: Math.max(0, pendingCandidates.length - checked),
    reason: stoppedReason,
    error: terminalError,
    // The quota this run's size was actually planned against - null usable
    // means the operation's quota was never observed this scan, not that it
    // was exhausted (see quotaPlanner.js). Exposed so a caller (UI, later
    // diagnostics) can show why a run was smaller than the full queue.
    quota: { usable: plan.usable, resetAt: plan.resetAt },
  };
}
