import { graphqlGet } from "../api/graphqlClient.js";
import { AdaptiveRateLimiter, delay } from "../api/rateLimiter.js";
import { planWork } from "../api/quotaPlanner.js";
import { DOCUMENT_IDS, TIMELINE_FEATURES } from "../api/operations.js";
import { StoppedError } from "../core/errors.js";
import { communityActivityKind, parseCommunityTimelinePage } from "./timelineParser.js";

const ACTIVITY_SEARCH_VERIFICATION_SCHEMA = 1;
// Not tied to a lookback window: a search answers "when did this account last
// post here", which stays true regardless of which rolling window is selected
// today. The cache only needs to be fresh enough that a very recent post could
// not have been missed.
const ACTIVITY_SEARCH_VERIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
export function buildActivitySearchVariables(communityId, username) {
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

  const seenIdentities = new Set();
  const pendingCandidates = [];
  for (const candidate of candidates || []) {
    if (!candidate?.username) continue;
    const identity = activitySearchCandidateIdentity(candidate);
    if (seenIdentities.has(identity)) continue;
    seenIdentities.add(identity);
    const previous = entries[identity];
    if (previous?.checkedAt && now - previous.checkedAt <= ACTIVITY_SEARCH_VERIFICATION_MAX_AGE_MS) {
      continue;
    }
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
        const payload = await graphqlGet(
          searchOperation.documentId,
          searchOperation.operation,
          buildActivitySearchVariables(communityId, candidate.username),
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
        const lastPostAt = latestCommunityPostAt(page.tweets);
        entries[identity] = {
          checkedAt: Date.now(),
          lastPostAt: lastPostAt ? lastPostAt.toISOString() : null,
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
    if (!entry) continue;
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
