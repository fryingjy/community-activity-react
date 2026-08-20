import { DOCUMENT_IDS } from "../api/operations.js";
import { createActivityIndex } from "./classification.js";
import { backfillSupplementalTimelineAuthors } from "./backfillEngine.js";

// Six common words, not a real search strategy: this exists to catch a member
// whose post the chronological timeline backfill has not reached yet, not to
// enumerate every author on its own. It cannot find a post that avoids all six
// words, and it is not the primary discovery mechanism (see
// timelineBackfill.js for that).
export const COMMUNITY_SEARCH_SHARDS = Object.freeze(["a", "the", "to", "and", "i", "you"]);

export async function backfillCommunitySearchAuthors(
  communityId,
  {
    signal,
    requestStats,
    log,
    onProgress,
    limiter,
    operation,
    maxPagesPerShard = 8,
    delayFn,
  } = {}
) {
  const searchOperation = operation || {
    documentId: DOCUMENT_IDS.CommunityTweetSearchModuleQuery,
    operation: "CommunityTweetSearchModuleQuery",
  };
  const combined = createActivityIndex();
  const shardStates = [];
  for (const query of COMMUNITY_SEARCH_SHARDS) {
    const archive = await backfillSupplementalTimelineAuthors(communityId, {
      signal,
      requestStats,
      log,
      limiter,
      operation: searchOperation,
      checkpointKey: `communitySearchBackfill:${communityId}:${query}`,
      label: `Community search “${query}”`,
      timelineKind: "search",
      maxPagesPerRun: maxPagesPerShard,
      delayFn,
      variables: (cursor) => ({
        count: 20,
        cursor,
        query,
        communityId,
        timelineRankingMode: "Recency",
        includePromotedContent: false,
        timelineId: `communityTweetSearch-${communityId}-${query}-Recency`,
        withBirdwatchNotes: false,
        withDmMuting: false,
        withClientEventToken: false,
        withVoice: false,
        isListMemberTargetUserId: "0",
        withCommunity: false,
        withQuickPromoteEligibilityTweetFields: false,
        withGrokTranslatedBio: false,
        includeProfessionalCategory: true,
      }),
    });
    for (const author of archive.toJSON()) combined.add(author);
    shardStates.push({
      query,
      pages: archive.timelinePages,
      posts: archive.timelinePosts,
      authors: archive.size,
      oldestPostAt: archive.oldestPostAt,
      complete: archive.timelineComplete,
      reason: archive.timelineReason,
    });
    onProgress?.({
      query,
      shard: shardStates.length,
      shardCount: COMMUNITY_SEARCH_SHARDS.length,
      authors: combined.size,
      states: shardStates,
    });
  }
  combined.shards = shardStates;
  combined.timelineComplete = shardStates.every((state) => state.complete);
  return combined;
}
