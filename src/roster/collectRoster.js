import { graphqlGet } from "../api/graphqlClient.js";
import { AdaptiveRateLimiter, delay } from "../api/rateLimiter.js";
import { NATIVE_ROSTER_FALLBACK_COUNT } from "../api/operations.js";
import { StoppedError } from "../core/errors.js";
import { createMemberStore } from "./memberStore.js";
import { parseCommunityMembersCursorPayload } from "./rosterParser.js";
import {
  CURSOR_CHECKPOINT_SCHEMA,
  COMPLETE_CHECKPOINT_MAX_AGE_MS,
  PARTIAL_CHECKPOINT_MAX_AGE_MS,
  checkpointMetaKey,
  loadCursorCheckpoint,
  startFreshCursorCheckpoint,
  saveCursorPage,
} from "./rosterCheckpoint.js";
import { readRosterCursorTimestamp, withRosterCursorTimestamp } from "./cursorCodec.js";
import {
  MAX_IDLE_ROSTER_PAGES,
  SEEK_RESUME_IDLE_PAGE_LIMIT,
  SEEK_RESUME_OVERLAP_MS,
  SEEK_RESUME_MAX_SEGMENTS,
  SEEK_RESUME_MIN_SEGMENT_PAGES,
  SEEK_RESUME_MAX_IDLE_SEGMENTS,
  shouldResumeChain,
  resolveRosterStopReason,
} from "./seekResume.js";
import { seekResumeForwardStep } from "./cursorCodec.js";

export const ROSTER_REQUEST_DELAY_MS = 750;
const SEEK_RESUME_FORWARD_STEP_MS = seekResumeForwardStep();

export function buildMemberCursorRequest(operation, communityId, cursor = null) {
  const liveVariables = operation?.variables && typeof operation.variables === "object"
    ? operation.variables
    : {};
  const liveFeatures = operation?.features && typeof operation.features === "object"
    ? operation.features
    : {};
  const communityVariable = operation?.communityVariable || "communityId";
  const cursorVariable = operation?.cursorVariable || "cursor";
  const variables = { ...liveVariables, [communityVariable]: communityId };
  if (communityVariable !== "communityId") delete variables.communityId;
  if (communityVariable !== "community_rest_id") delete variables.community_rest_id;
  delete variables.count;
  delete variables[cursorVariable];
  if (Object.prototype.hasOwnProperty.call(liveVariables, "count")) {
    variables.count = liveVariables.count;
  }
  if (cursor) variables[cursorVariable] = cursor;
  return {
    variables,
    features: Object.keys(liveFeatures).length ? liveFeatures : null,
  };
}

export async function fetchCommunityMembersByCursor(
  communityId,
  operation,
  {
    signal,
    requestStats,
    log,
    onProgress,
    expectedCount,
    maxPages = 10000,
    checkpointScope = "web",
    seekResume = false,
    // Both default to the real pacing/backoff, so no production call site is
    // affected. Tests running the real collector against a fake server
    // inject a limiter built with a no-op sleep (and a no-op delayFn for
    // retry/backoff paths) instead of waiting out real multi-second delays -
    // see rateLimiter.js and graphqlClient.js for the same seam.
    limiter: injectedLimiter,
    delayFn = delay,
  } = {}
) {
  if (!operation?.documentId || !operation?.operation) {
    throw new Error("The live Community member cursor operation was not detected.");
  }

  let checkpoint = await loadCursorCheckpoint(communityId, checkpointScope);
  // A previous run's saved contract is a fact worth surfacing the moment a new
  // one is discovered, not only once a scan fails outright. X has changed this
  // response shape before (see ENDPOINT_AUDIT.md's 5.10.0 regression), and a
  // failure that only shows up as a stalled scan is much harder to diagnose
  // than a log line naming exactly what changed and when.
  if (
    checkpoint?.meta?.documentId &&
    (checkpoint.meta.documentId !== operation.documentId || checkpoint.meta.operation !== operation.operation)
  ) {
    log?.(
      `X's ${checkpointScope} roster contract changed since the last run for this Community: ` +
      `${checkpoint.meta.operation || "unknown"} (${checkpoint.meta.documentId}) -> ` +
      `${operation.operation} (${operation.documentId}). Existing checkpoint data is still used.`
    );
  }
  const checkpointAge = checkpoint?.meta?.updatedAt ? Date.now() - checkpoint.meta.updatedAt : Infinity;
  const expectedCountMatches = checkpoint?.meta?.expectedCount == null ||
    expectedCount == null ||
    checkpoint.meta.expectedCount === expectedCount;
  // A cached result holding no members is never worth replaying: it can only
  // have come from a source that failed to yield anything, and reusing it turns
  // one bad run into hours of empty ones.
  const checkpointHasMembers = (checkpoint?.members?.length || 0) > 0;
  const completeCheckpoint = checkpoint?.meta?.complete &&
    checkpointHasMembers &&
    checkpointAge <= COMPLETE_CHECKPOINT_MAX_AGE_MS &&
    expectedCountMatches;
  const partialTerminalCheckpoint = checkpoint?.meta?.terminal &&
    !checkpoint.meta.complete &&
    checkpointHasMembers &&
    checkpointAge <= PARTIAL_CHECKPOINT_MAX_AGE_MS &&
    expectedCountMatches;
  const canResume = Boolean(
    checkpoint &&
    !checkpoint.meta.terminal &&
    !checkpoint.meta.complete &&
    checkpoint.meta.nextCursor
  );

  if (completeCheckpoint) {
    log?.(`Loaded a complete ${checkpoint.members.length.toLocaleString()}-member cursor checkpoint.`);
    return {
      members: checkpoint.members,
      complete: true,
      resumed: true,
      pages: checkpoint.meta.pageCount,
      reason: "checkpoint-complete",
    };
  }
  if (partialTerminalCheckpoint) {
    log?.(
      `Loaded a recent partial ${checkpoint.members.length.toLocaleString()}-member checkpoint ` +
      `(${checkpoint.meta.reason}); skipping a duplicate crawl.`
    );
    return {
      members: checkpoint.members,
      complete: false,
      resumed: true,
      pages: checkpoint.meta.pageCount,
      reason: checkpoint.meta.reason || "checkpoint-partial",
      cached: true,
    };
  }

  let meta;
  let seededMembers;
  if (canResume) {
    meta = checkpoint.meta;
    seededMembers = checkpoint.members;
    log?.(`Resuming cursor page ${meta.pageCount + 1} with ${seededMembers.length.toLocaleString()} saved member(s).`);
  } else {
    meta = await startFreshCursorCheckpoint(communityId, checkpoint?.meta, checkpointScope);
    seededMembers = [];
    await chrome.storage.local.set({ [checkpointMetaKey(communityId, checkpointScope)]: meta });
  }

  const store = createMemberStore(seededMembers);
  const seenCursors = new Set();
  let cursor = meta.nextCursor || null;
  if (cursor) seenCursors.add(cursor);
  let reason = null;
  let terminalError = null;
  let idlePages = 0;
  // Seek-resume bookkeeping. `segmentAdded` is the guard that a naive
  // implementation lacks: once a chain ends, re-seeking into a region that is
  // already fully collected returns the same members forever, so a segment that
  // contributes nothing new ends the walk instead of looping.
  // Seeded from the resumed cursor itself, not left null: without this, a
  // resumed walk whose very first page immediately hits the chain cap (no
  // nextCursor to read a timestamp from) never sets lastCursorTimestamp at
  // all, so shouldResumeChain's lastTimestamp == null check fails and the
  // walk reports itself terminally stopped instead of reseeking - exactly
  // the situation seek-resume exists to handle, defeated by its own resume
  // path never having initialized the one value it needs to act.
  let lastCursorTimestamp = readRosterCursorTimestamp(cursor);
  let segments = 0;
  let reseeks = 0;
  let segmentAdded = 0;
  let segmentPages = 0;
  let unproductiveSegments = 0;
  // Every resume must land strictly ahead of the previous one, so a segment
  // that ends too early to be judged cannot pin the walk in place.
  let lastSeekTarget = null;
  // The opening cursor doubles as the seek template: it carries an unspent page
  // budget, which a cursor from deep in a capped chain does not.
  let seekTemplateCursor = cursor && readRosterCursorTimestamp(cursor) != null ? cursor : null;
  // X's web roster is fixed at about 20 records per response. A shorter
  // adaptive interval improves throughput while the shared limiter still
  // backs off on low quota, throttling, network failures, and 5xx responses.
  const limiter = injectedLimiter || new AdaptiveRateLimiter(ROSTER_REQUEST_DELAY_MS);
  let requestOperation = operation;
  let nativePageSizeDowngraded = false;

  while (meta.pageCount < maxPages) {
    if (signal?.aborted) throw new StoppedError();
    let payload;
    try {
      const request = buildMemberCursorRequest(requestOperation, communityId, cursor);
      payload = await graphqlGet(
        requestOperation.documentId,
        requestOperation.operation,
        request.variables,
        request.features,
        {
          signal,
          requestStats,
          log,
          limiter,
          maxAttempts: 6,
          clientTransactionId: requestOperation.clientTransactionId || null,
          delayFn,
        }
      );
    } catch (error) {
      if (error instanceof StoppedError || error?.name === "StoppedError") throw error;
      const requestedCount = Number(requestOperation?.variables?.count);
      if (
        store.members.length === 0 &&
        !nativePageSizeDowngraded &&
        Number.isFinite(requestedCount) &&
        requestedCount > NATIVE_ROSTER_FALLBACK_COUNT
      ) {
        nativePageSizeDowngraded = true;
        requestOperation = {
          ...requestOperation,
          variables: {
            ...requestOperation.variables,
            count: NATIVE_ROSTER_FALLBACK_COUNT,
          },
        };
        log?.(
          `X rejected the ${requestedCount}-member native page; retrying with ` +
          `${NATIVE_ROSTER_FALLBACK_COUNT}.`
        );
        continue;
      }
      if (store.members.length === 0) throw error;
      terminalError = error;
      reason = error?.code === "rate-limited" ? "rate-limited" : "request-error";
      break;
    }
    const page = parseCommunityMembersCursorPayload(payload);
    const before = store.members.length;
    for (const member of page.members) {
      store.upsert(member);
    }
    const added = store.members.length - before;
    idlePages = added === 0 ? idlePages + 1 : 0;
    segmentAdded += added;
    segmentPages++;
    const idleLimit = seekResume ? SEEK_RESUME_IDLE_PAGE_LIMIT : MAX_IDLE_ROSTER_PAGES;
    if (page.nextCursor) {
      const timestamp = readRosterCursorTimestamp(page.nextCursor);
      if (timestamp != null) lastCursorTimestamp = timestamp;
      if (!seekTemplateCursor) seekTemplateCursor = page.nextCursor;
    }
    reason = resolveRosterStopReason({
      idlePages,
      idleLimit,
      repeatedCursor: Boolean(
        page.nextCursor && (page.nextCursor === cursor || seenCursors.has(page.nextCursor))
      ),
      cursorEnded: !page.nextCursor,
      memberCount: store.members.length,
      expectedCount,
    });

    meta = await saveCursorPage(
      communityId,
      meta,
      cursor,
      page.nextCursor,
      page.members,
      checkpointScope
    );
    onProgress?.({
      page: meta.pageCount,
      count: store.members.length,
      added,
      nextCursor: page.nextCursor,
      segments: segments + 1,
    });

    // X caps a single cursor chain well before a large roster is exhausted. If
    // the chain ended rather than the roster, re-seek from the last position
    // and keep going; the guards below stop a walk that is no longer finding
    // anyone, which is what separates this from an endless re-seek loop.
    if (shouldResumeChain({
      seekResume,
      cursorEnded: !page.nextCursor,
      reason,
      memberCount: store.members.length,
      expectedCount,
      lastTimestamp: lastCursorTimestamp,
    })) {
      // A segment is only judged once it has had a fair run. The first pages
      // after a re-seek land inside the deliberate overlap window and return
      // members already held, so ruling on one page ends the walk at the very
      // cap it exists to defeat.
      const segmentWasFairlyTried = segmentPages >= SEEK_RESUME_MIN_SEGMENT_PAGES;
      // A page that served no records at all means the seek landed past the end
      // of the roster. That is a complete verdict on the segment however short
      // it was, and it must count: without it the segment was never judged
      // unproductive, the counter never advanced, and each resume stepped a
      // single millisecond — burning the entire 240-segment budget crawling
      // past the end of the roster instead of stopping.
      const servedNothing = page.rawCount === 0;
      // Stalling on duplicates means the walk is standing in ground it already
      // holds, whatever the segment produced earlier, so seeking back from
      // there would re-enter the same region.
      const deadZone = reason === "no-new-members" ||
        servedNothing ||
        (segmentAdded === 0 && segmentWasFairlyTried);
      if (deadZone) {
        unproductiveSegments++;
      } else if (segmentAdded > 0) {
        unproductiveSegments = 0;
      }
      if (unproductiveSegments >= SEEK_RESUME_MAX_IDLE_SEGMENTS) {
        reason = "seek-resume-exhausted";
      } else if (reseeks >= SEEK_RESUME_MAX_SEGMENTS) {
        reason = "seek-resume-segment-limit";
      } else {
        // Seek from the first cursor of the walk rather than the exhausted
        // one. A late-chain cursor carries that chain's spent page budget, so
        // rewriting its position yields a single page and no continuation; the
        // opening cursor reseeks with a fresh budget.
        const template = seekTemplateCursor || cursor || page.nextCursor;
        // An unproductive segment means this position is already collected, so
        // step forward past it instead of retrying the same dead zone.
        let target = deadZone
          ? lastCursorTimestamp + SEEK_RESUME_FORWARD_STEP_MS
          : lastCursorTimestamp - SEEK_RESUME_OVERLAP_MS;
        // Seek positions must advance. A segment that ends before it can be
        // judged fairly tried leaves the idle counter untouched, so without
        // this every resume computed the same target, re-walked the same
        // ground, and burned the segment budget without progressing — a
        // modelled roster whose page cap fell inside a large block of members
        // sharing one timestamp thrashed through 240 resumes and stalled at
        // 66.57%. Forcing strictly forward movement turns that into progress.
        if (lastSeekTarget != null && target <= lastSeekTarget) {
          target = lastSeekTarget + SEEK_RESUME_FORWARD_STEP_MS;
        }
        const resumed = withRosterCursorTimestamp(template, target);
        if (resumed && !seenCursors.has(resumed)) {
          reseeks++;
          segments++;
          segmentAdded = 0;
          segmentPages = 0;
          idlePages = 0;
          reason = null;
          cursor = resumed;
          lastCursorTimestamp = target;
          lastSeekTarget = target;
          seenCursors.add(resumed);
          log?.(
            `Roster chain ended at X's page cap; resuming from ` +
            `${new Date(lastCursorTimestamp).toISOString().slice(0, 10)} ` +
            `(segment ${segments + 1}, ${store.members.length.toLocaleString()} member(s) so far).`
          );
          continue;
        }
      }
    }

    if (reason) break;
    cursor = page.nextCursor;
    seenCursors.add(cursor);
  }

  if (!reason && meta.pageCount >= maxPages) reason = "page-safety-limit";
  // `seek-resume-exhausted` means X stopped returning anyone new, which is not
  // the same as reaching the advertised count. Treating it as complete once
  // labelled a 46,951-of-79,397 result as finished. A result below the
  // advertised count stays partial and carries its own stop reason, in keeping
  // with never claiming completeness the roster does not support.
  const complete = reason === "expected-count-reached" || reason === "cursor-ended";
  const terminal = !complete && !["request-error", "page-safety-limit"].includes(reason);
  meta = {
    ...meta,
    complete,
    terminal,
    reason,
    operation: requestOperation.operation,
    documentId: requestOperation.documentId,
    memberCount: store.members.length,
    expectedCount: expectedCount || null,
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ [checkpointMetaKey(communityId, checkpointScope)]: meta });
  log?.(
    `Cursor collection stopped (${reason || "unknown"}) after ${meta.pageCount.toLocaleString()} page(s): ` +
    `${store.members.length.toLocaleString()} unique member(s).`
  );
  return {
    members: store.members,
    complete,
    resumed: Boolean(canResume),
    pages: meta.pageCount,
    reason,
    error: terminalError,
    segments: segments + 1,
    reseeks,
  };
}
