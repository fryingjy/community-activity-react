import { graphqlGet } from "../api/graphqlClient.js";
import { delay } from "../api/rateLimiter.js";
import { TIMELINE_FEATURES } from "../api/operations.js";
import { StoppedError } from "../core/errors.js";
import { unwrapUserResult } from "../core/unwrap.js";
import { createActivityIndex } from "./classification.js";
import { parseCommunityTimelinePage } from "./timelineParser.js";

// Schema for the resumable checkpoint shared by every supplemental author
// backfill (media, word-shard search) and the main timeline backfill.
export const TIMELINE_BACKFILL_CHECKPOINT_SCHEMA = 1;

// The engine underneath the media, word-shard search, and (via
// timelineBackfill.js's near-identical loop) main timeline author-discovery
// passes. It pages a timeline-shaped operation backward from the newest post,
// checkpointing every page, until the operation's own cursor ends, repeats, or
// goes empty — never claiming completeness beyond what the cursor itself
// proves.
export async function backfillSupplementalTimelineAuthors(
  communityId,
  {
    signal,
    requestStats,
    log,
    onProgress,
    limiter,
    operation,
    checkpointKey,
    label,
    timelineKind,
    variables,
    maxPagesPerRun,
    // Defaults to the real setTimeout-backed delay() - see rateLimiter.js
    // and graphqlClient.js's injectable pacing seam.
    delayFn = delay,
  }
) {
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
  const observed = createActivityIndex(validCheckpoint ? stored.authors || [] : []);
  let cursor = validCheckpoint ? stored.cursor || null : null;
  let scanned = validCheckpoint ? stored.scanned || 0 : 0;
  let pages = validCheckpoint ? stored.pages || 0 : 0;
  let oldestPostAt = validCheckpoint ? stored.oldestPostAt || null : null;
  let complete = validCheckpoint && stored.complete === true;
  let halted = validCheckpoint && stored.terminal === true && !retryStoppedCheckpoint;
  let reason = complete ? stored.reason || "timeline-ended" : "in-progress";
  const seenCursors = new Set(cursor ? [cursor] : []);

  if (complete) {
    log?.(`Loaded the completed ${label} archive with ${observed.size.toLocaleString()} author(s).`);
  } else if (halted) {
    reason = stored.reason || "timeline-stopped";
    log?.(`Loaded the partial ${label} archive stopped at ${reason}.`);
  } else if (validCheckpoint && cursor) {
    log?.(
      `${retryStoppedCheckpoint ? "Retrying" : "Resuming"} ${label} page ` +
      `${(pages + 1).toLocaleString()} with ${observed.size.toLocaleString()} author(s) saved.`
    );
  } else {
    log?.(`Starting the ${label} archive.`);
  }

  const timelineDocumentId = operation?.documentId;
  const timelineOperation = operation?.operation;
  const timelineFeatures = operation?.features && Object.keys(operation.features).length
    ? operation.features
    : TIMELINE_FEATURES;
  let pagesThisRun = 0;
  while (!complete && !halted && pagesThisRun < maxPagesPerRun) {
    if (signal?.aborted) throw new StoppedError();
    const payload = await graphqlGet(
      timelineDocumentId,
      timelineOperation,
      variables(cursor),
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
    const page = parseCommunityTimelinePage(payload, timelineKind);
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
  if (!complete && !halted) reason = "page-budget-reached";
  observed.timelineComplete = complete;
  observed.timelineReason = reason;
  observed.timelinePages = pages;
  observed.timelinePosts = scanned;
  observed.oldestPostAt = oldestPostAt;
  return observed;
}
