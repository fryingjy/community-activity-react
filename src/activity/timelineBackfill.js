import { graphqlGet } from "../api/graphqlClient.js";
import { DOCUMENT_IDS, TIMELINE_FEATURES } from "../api/operations.js";
import { StoppedError } from "../core/errors.js";
import { unwrapUserResult } from "../core/unwrap.js";
import { createActivityIndex } from "./classification.js";
import { parseCommunityTimelinePage } from "./timelineParser.js";
import { TIMELINE_BACKFILL_CHECKPOINT_SCHEMA } from "./backfillEngine.js";

// The main chronological archive: pages the Community timeline backward from
// the newest post toward the oldest one X will serve, independent of the
// selected activity window. This is the primary, exhaustive author-discovery
// source — it does not depend on guessing search words the way the word-shard
// backfill in searchDiscovery.js does.
export async function backfillCommunityTimelineAuthors(
  communityId,
  {
    signal,
    requestStats,
    log,
    onProgress,
    limiter,
    operation,
    initialCursor = null,
    seedAuthors = [],
    maxPagesPerRun = 250,
  } = {}
) {
  const checkpointKey = `communityTimelineBackfill:${communityId}`;
  const stored = (await chrome.storage.local.get(checkpointKey))[checkpointKey];
  const validCheckpoint =
    stored?.schema === TIMELINE_BACKFILL_CHECKPOINT_SCHEMA &&
    stored.communityId === communityId;
  const checkpointAge = stored?.updatedAt ? Date.now() - stored.updatedAt : Infinity;
  const retryStoppedCheckpoint =
    validCheckpoint &&
    stored.terminal === true &&
    stored.complete !== true &&
    checkpointAge >= 6 * 60 * 60 * 1000;
  const observed = createActivityIndex([
    ...(validCheckpoint ? stored.authors || [] : []),
    ...(seedAuthors || []),
  ]);
  let cursor = validCheckpoint ? stored.cursor || null : initialCursor;
  let scanned = validCheckpoint ? stored.scanned || 0 : 0;
  let pages = validCheckpoint ? stored.pages || 0 : 0;
  let oldestPostAt = validCheckpoint ? stored.oldestPostAt || null : null;
  let complete = validCheckpoint && stored.complete === true;
  let halted = validCheckpoint && stored.terminal === true && !retryStoppedCheckpoint;
  let reason = complete ? stored.reason || "timeline-ended" : "in-progress";
  const seenCursors = new Set(cursor ? [cursor] : []);

  if (complete) {
    log?.(
      `Loaded the completed timeline archive with ${observed.size.toLocaleString()} unique author(s).`
    );
  } else if (halted) {
    reason = stored.reason || "timeline-stopped";
    log?.(
      `Loaded a partial timeline archive stopped at ${reason}, with ` +
      `${observed.size.toLocaleString()} unique author(s).`
    );
  } else if (validCheckpoint && cursor) {
    log?.(
      `${retryStoppedCheckpoint ? "Retrying" : "Resuming"} the Community timeline at page ` +
      `${(pages + 1).toLocaleString()} with ` +
      `${observed.size.toLocaleString()} unique author(s) already saved.`
    );
  } else {
    log?.("Starting the Community timeline archive from the newest available posts.");
  }

  const timelineDocumentId = operation?.documentId || DOCUMENT_IDS.CommunityTweetsTimeline;
  const timelineOperation = operation?.operation || "CommunityTweetsTimeline";
  const timelineVariables = operation?.variables && typeof operation.variables === "object"
    ? operation.variables
    : {};
  const timelineFeatures = operation?.features && Object.keys(operation.features).length
    ? operation.features
    : TIMELINE_FEATURES;
  let pagesThisRun = 0;

  while (!complete && !halted && pagesThisRun < maxPagesPerRun) {
    if (signal?.aborted) throw new StoppedError();
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
      }
    );
    const page = parseCommunityTimelinePage(payload);
    pages++;
    pagesThisRun++;
    let acceptedPosts = 0;

    for (const tweet of page.tweets) {
      const author = unwrapUserResult(tweet?.core?.user_results?.result);
      const username = author?.core?.screen_name;
      const createdAt = tweet?.legacy?.created_at ? new Date(tweet.legacy.created_at) : null;
      if (!username || !createdAt || Number.isNaN(createdAt.getTime())) continue;
      acceptedPosts++;
      scanned++;
      const postTime = createdAt.toISOString();
      if (!oldestPostAt || postTime < oldestPostAt) oldestPostAt = postTime;
      observed.add({
        username,
        count: 0,
        user_id: author.rest_id || null,
        name: author.core?.name || username,
        protected: typeof author.privacy?.protected === "boolean"
          ? author.privacy.protected
          : typeof author.legacy?.protected === "boolean"
            ? author.legacy.protected
            : null,
        lastSeenCommunityPost: postTime,
      });
    }

    const repeatedCursor =
      Boolean(page.nextCursor) &&
      (page.nextCursor === cursor || seenCursors.has(page.nextCursor));
    if (!page.nextCursor) {
      complete = true;
      reason = "timeline-ended";
    } else if (repeatedCursor) {
      halted = true;
      reason = "repeated-cursor";
    } else if (page.entryCount === 0 || (acceptedPosts === 0 && page.tweets.length === 0)) {
      halted = true;
      reason = "empty-page";
    } else {
      cursor = page.nextCursor;
      seenCursors.add(cursor);
    }

    await chrome.storage.local.set({
      [checkpointKey]: {
        schema: TIMELINE_BACKFILL_CHECKPOINT_SCHEMA,
        communityId,
        cursor: complete ? null : cursor,
        scanned,
        pages,
        oldestPostAt,
        complete,
        terminal: complete || halted,
        reason,
        authors: observed.toJSON(),
        updatedAt: Date.now(),
      },
    });
    onProgress?.({
      scanned,
      authors: observed.size,
      pages,
      pagesThisRun,
      oldestPostAt,
      complete,
      reason,
    });
  }

  if (!complete && !halted) {
    reason = "page-budget-reached";
    log?.(
      `Timeline archive paused after ${pagesThisRun.toLocaleString()} page(s) this run; ` +
      `the durable cursor will continue next scan.`
    );
  } else if (complete) {
    log?.(
      `Timeline archive reached X's oldest available post; ` +
      `${observed.size.toLocaleString()} unique author(s) saved.`
    );
  } else {
    log?.(
      `Timeline archive stopped at ${reason}; saved authors remain available as partial evidence.`
    );
  }
  observed.timelineComplete = complete;
  observed.timelineReason = reason;
  observed.timelinePages = pages;
  observed.timelinePosts = scanned;
  observed.oldestPostAt = oldestPostAt;
  return observed;
}
