import { graphqlGet } from "../api/graphqlClient.js";
import { delay } from "../api/rateLimiter.js";
import { usableQuota } from "../api/quotaPlanner.js";
import { DOCUMENT_IDS, TIMELINE_FEATURES } from "../api/operations.js";
import { StoppedError } from "../core/errors.js";
import { unwrapUserResult } from "../core/unwrap.js";
import { createActivityIndex } from "./classification.js";
import { communityActivityKind, parseCommunityTimelinePage } from "./timelineParser.js";

// Schema 4 records unique tweet IDs and separates original Community posts
// from Community replies. Older checkpoints cannot provide those guarantees,
// so they are intentionally rebuilt.
export const ACTIVITY_CHECKPOINT_SCHEMA = 4;

// Scans the recent-activity window (the selected lookback) forward from the
// newest post, separately from the full-history backfill in
// timelineBackfill.js: this pass exists to answer "who posted in the selected
// window", checkpointed per exact window so a shorter or longer lookback on a
// later scan does not silently reuse a different window's coverage.
export async function fetchActiveAuthors(
  communityId,
  sinceDate,
  untilDate,
  {
    signal,
    requestStats,
    log,
    onProgress,
    limiter,
    operation,
    observationSinceDate = sinceDate,
    // A sanity ceiling, not the normal stop condition. A live 30-day-window
    // scan on an active-enough Community can genuinely need several
    // thousand pages to walk back that far - stopping at a small fixed
    // count here previously meant the scan reliably reported "0 flagged"
    // and told the operator to press Start again, over and over, never
    // reaching the window it needed to classify anyone. The real stop
    // conditions are the window being covered or this operation's own
    // observed quota running low (see the loop below); this only guards
    // against a walk that never ends for some other reason.
    maxPagesPerRun = 5000,
    // Forwarded to quotaPlanner.js's usableQuota() - see its own defaults
    // and reasoning for the reserve policy.
    quotaReserve,
    quotaMinimumReserveFraction,
    // Defaults to the real setTimeout-backed delay() - see rateLimiter.js
    // and graphqlClient.js's injectable pacing seam. Only ever overridden by
    // tests driving this against a fake server.
    delayFn = delay,
  } = {}
) {
  const checkpointKey =
    `activityScan:${communityId}:${sinceDate.toISOString().slice(0, 10)}:` +
    `${observationSinceDate.toISOString().slice(0, 10)}:${untilDate.toISOString().slice(0, 10)}`;
  const stored = (await chrome.storage.local.get(checkpointKey))[checkpointKey];
  const checkpointAge = stored?.updatedAt ? Date.now() - stored.updatedAt : Infinity;
  const canResume =
    stored?.schema === ACTIVITY_CHECKPOINT_SCHEMA &&
    !stored.complete &&
    stored.cursor &&
    checkpointAge < 12 * 60 * 60 * 1000;
  const canReuseComplete =
    stored?.schema === ACTIVITY_CHECKPOINT_SCHEMA &&
    stored.complete &&
    checkpointAge < 10 * 60 * 1000;
  const active = createActivityIndex(canResume || canReuseComplete ? stored.authors : []);
  const observed = createActivityIndex(
    canResume || canReuseComplete ? stored.observedAuthors : []
  );
  const seenTweetIds = new Set(
    canResume || canReuseComplete ? stored.seenTweetIds || [] : []
  );
  const finalizeActivity = (windowComplete, backfillComplete, pages, oldestSeenAt, stopReason) => {
    active.observedAuthors = observed.toJSON();
    active.activityWindowComplete = windowComplete;
    active.observationComplete = backfillComplete;
    active.observationPages = pages;
    active.continuationCursor = stored?.cursor || null;
    // The progress marker for "how far back have we actually walked" -
    // distinct from the window boundary itself, so the UI can show a
    // concrete "reached July 18, target July 9, 9 days remaining" instead
    // of only a boolean complete/incomplete.
    active.oldestSeenAt = oldestSeenAt ? oldestSeenAt.toISOString() : null;
    active.stopReason = stopReason || null;
    return active;
  };
  if (canReuseComplete) {
    log?.(
      `Loaded a recent activity checkpoint with ${active.size.toLocaleString()} active and ` +
      `${observed.size.toLocaleString()} observed author(s).`
    );
    return finalizeActivity(
      true,
      true,
      stored.pages || 0,
      stored.oldestSeenAt ? new Date(stored.oldestSeenAt) : null,
      "window-covered"
    );
  }
  let cursor = null;
  let scanned = 0;
  let pages = 0;
  let activityWindowComplete = false;
  let observationComplete = false;
  let continuationCursor = null;
  let oldestSeenAt = null;
  let stopReason = null;
  if (canResume) {
    cursor = stored.cursor;
    scanned = stored.scanned || 0;
    pages = stored.pages || 0;
    activityWindowComplete = stored.activityWindowComplete === true;
    oldestSeenAt = stored.oldestSeenAt ? new Date(stored.oldestSeenAt) : null;
    log?.(
      `Resuming author backfill with ${active.size.toLocaleString()} active and ` +
      `${observed.size.toLocaleString()} observed author(s).`
    );
  }

  let pagesThisRun = 0;
  const timelineDocumentId = operation?.documentId || DOCUMENT_IDS.CommunityTweetsTimeline;
  const timelineOperation = operation?.operation || "CommunityTweetsTimeline";
  const timelineVariables = operation?.variables && typeof operation.variables === "object"
    ? operation.variables
    : {};
  const timelineFeatures = operation?.features && Object.keys(operation.features).length
    ? operation.features
    : TIMELINE_FEATURES;
  while (pagesThisRun < maxPagesPerRun) {
    if (signal?.aborted) throw new StoppedError();
    // The real stop condition ahead of the window being covered: this
    // operation's own observed quota (populated by graphqlGet from real
    // response headers - see quotaManager.js) running low. Unknown quota
    // (nothing observed yet this scan) is not a reason to stop; only an
    // actually-measured, actually-low bucket is.
    const observedQuota = requestStats?.quotas?.[timelineOperation] || null;
    if (usableQuota(observedQuota, { reserve: quotaReserve, minimumReserveFraction: quotaMinimumReserveFraction }) === 0) {
      stopReason = "quota-paused";
      break;
    }
    const payload = await graphqlGet(
      timelineDocumentId,
      timelineOperation,
      {
        ...timelineVariables,
        communityId,
        count: 20,
        cursor,
        displayLocation: "Community",
        rankingMode: "Recency",
        withCommunity: true,
      },
      timelineFeatures,
      {
        signal,
        requestStats,
        log,
        limiter,
        clientTransactionId: operation?.clientTransactionId || null,
        delayFn,
      }
    );
    const page = parseCommunityTimelinePage(payload);
    pages++;
    pagesThisRun++;
    let pageHasObservedPost = false;
    let pageHasInWindowEntry = false;
    let pageHasOlderPost = false;
    let pageHasPreWindowPost = false;

    for (const tweet of page.tweets) {
      const author = unwrapUserResult(tweet?.core?.user_results?.result);
      const username = author?.core?.screen_name;
      const createdAt = tweet?.legacy?.created_at ? new Date(tweet.legacy.created_at) : null;
      if (!username || !createdAt || Number.isNaN(createdAt.getTime())) continue;
      // Tracked regardless of window membership - this is "how far back has
      // the walk actually reached," the concrete progress marker the UI
      // shows against the requested boundary.
      if (!oldestSeenAt || createdAt < oldestSeenAt) oldestSeenAt = createdAt;
      if (createdAt < sinceDate) pageHasPreWindowPost = true;
      if (createdAt < observationSinceDate) {
        pageHasOlderPost = true;
        continue;
      }
      if (createdAt > untilDate) continue;

      pageHasInWindowEntry = true;
      // Timeline pages can overlap. Count each Community post/reply once even
      // when X repeats it on the following cursor page or a scan resumes.
      const tweetId = String(tweet.rest_id || tweet.legacy?.id_str || "");
      if (tweetId && seenTweetIds.has(tweetId)) continue;
      if (tweetId) seenTweetIds.add(tweetId);
      const activityKind = communityActivityKind(tweet);
      // A repost can be visible in a Community feed, but it is neither an
      // original Community post nor a reply authored there.
      if (activityKind === "repost") continue;
      const isReply = activityKind === "reply";
      pageHasObservedPost = true;
      scanned++;
      const authorRecord = {
        username,
        count: 1,
        posts: isReply ? 0 : 1,
        replies: isReply ? 1 : 0,
        user_id: author.rest_id || null,
        name: author.core?.name || username,
        protected: typeof author.privacy?.protected === "boolean"
          ? author.privacy.protected
          : typeof author.legacy?.protected === "boolean"
            ? author.legacy.protected
            : null,
        lastSeenCommunityPost: createdAt.toISOString(),
      };
      observed.add(authorRecord);
      if (createdAt >= sinceDate) active.add(authorRecord);
    }

    activityWindowComplete =
      activityWindowComplete ||
      // One old/pinned entry can be mixed into an otherwise recent page.
      // Require a page with no qualifying in-window activity before treating
      // the selected date boundary as covered.
      (pageHasPreWindowPost && !pageHasInWindowEntry) ||
      !page.nextCursor ||
      page.entryCount === 0;
    observationComplete =
      (pageHasOlderPost && !pageHasInWindowEntry) ||
      !page.nextCursor ||
      page.entryCount === 0;
    onProgress?.({
      scanned,
      authors: active.size,
      activeAuthors: active.size,
      observedAuthors: observed.size,
      pages,
      windowComplete: activityWindowComplete,
      backfillComplete: observationComplete,
      oldestSeenAt: oldestSeenAt ? oldestSeenAt.toISOString() : null,
      sinceDate: sinceDate.toISOString(),
    });
    await chrome.storage.local.set({
      [checkpointKey]: {
        schema: ACTIVITY_CHECKPOINT_SCHEMA,
        communityId,
        since: sinceDate.toISOString(),
        observationSince: observationSinceDate.toISOString(),
        until: untilDate.toISOString(),
        cursor: page.nextCursor,
        scanned,
        pages,
        activityWindowComplete,
        complete: observationComplete,
        authors: active.toJSON(),
        observedAuthors: observed.toJSON(),
        seenTweetIds: [...seenTweetIds],
        oldestSeenAt: oldestSeenAt ? oldestSeenAt.toISOString() : null,
        updatedAt: Date.now(),
      },
    });
    continuationCursor = page.nextCursor || null;
    if (observationComplete) {
      stopReason = "window-covered";
      break;
    }
    cursor = page.nextCursor;
  }
  if (!stopReason && pagesThisRun >= maxPagesPerRun) stopReason = "page-budget-reached";
  if (!observationComplete) {
    const reasonLabel = stopReason === "quota-paused"
      ? "the timeline operation's quota is running low"
      : `${pagesThisRun.toLocaleString()} page(s) this run`;
    log?.(`Author backfill paused (${reasonLabel}); the saved cursor will continue next scan.`);
  }
  const result = finalizeActivity(activityWindowComplete, observationComplete, pages, oldestSeenAt, stopReason);
  result.continuationCursor = continuationCursor;
  return result;
}
