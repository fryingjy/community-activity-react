import { DOCUMENT_IDS } from "../api/operations.js";
import { backfillSupplementalTimelineAuthors } from "./backfillEngine.js";

export async function backfillCommunityMediaAuthors(
  communityId,
  {
    signal,
    requestStats,
    log,
    onProgress,
    limiter,
    operation,
    maxPagesPerRun = 75,
    delayFn,
  } = {}
) {
  const mediaOperation = operation || {
    documentId: DOCUMENT_IDS.CommunityMediaTimeline,
    operation: "CommunityMediaTimeline",
  };
  return backfillSupplementalTimelineAuthors(communityId, {
    signal,
    requestStats,
    log,
    onProgress,
    limiter,
    operation: mediaOperation,
    checkpointKey: `communityMediaBackfill:${communityId}`,
    label: "Community media timeline",
    timelineKind: "media",
    maxPagesPerRun,
    delayFn,
    variables: (cursor) => ({
      communityId,
      count: 20,
      cursor,
      withCommunity: true,
    }),
  });
}
