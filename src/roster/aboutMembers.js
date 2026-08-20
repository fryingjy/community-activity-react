import { graphqlGet } from "../api/graphqlClient.js";
import { DOCUMENT_IDS, TIMELINE_FEATURES } from "../api/operations.js";
import { unwrapUserResult } from "../core/unwrap.js";

// The Community "About" page's visible member/moderator groups. Small (5
// moderators + 10 featured members on the audited Community) but confirmed
// current-membership evidence, since X itself renders these groups.
export async function fetchCommunityAboutMembers(
  communityId,
  { signal, requestStats, log, limiter, operation } = {}
) {
  const aboutOperation = operation || {
    documentId: DOCUMENT_IDS.CommunityAboutTimeline,
    operation: "CommunityAboutTimeline",
  };
  const payload = await graphqlGet(
    aboutOperation.documentId,
    aboutOperation.operation,
    { communityId, withCommunity: true },
    aboutOperation.features && Object.keys(aboutOperation.features).length
      ? aboutOperation.features
      : TIMELINE_FEATURES,
    {
      signal,
      requestStats,
      log,
      limiter,
      clientTransactionId: aboutOperation.clientTransactionId || null,
    }
  );
  const entries =
    payload?.data?.communityResults?.result?.about_timeline?.timeline?.instructions
      ?.flatMap((instruction) => instruction.entries || []) || [];
  const members = [];
  for (const entry of entries) {
    const role = entry?.entryId === "communityModerators" ? "Moderator" : "Member";
    for (const item of entry?.content?.items || []) {
      const user = unwrapUserResult(
        item?.item?.itemContent?.user_results?.result ||
        item?.itemContent?.user_results?.result
      );
      const username = user?.core?.screen_name;
      if (!username) continue;
      members.push({
        username,
        name: user.core?.name || username,
        user_id: user.rest_id || null,
        role,
        protected: typeof user.privacy?.protected === "boolean"
          ? user.privacy.protected
          : typeof user.legacy?.protected === "boolean"
            ? user.legacy.protected
            : null,
        roleConfidence: role === "Moderator" ? "high" : "medium",
        source: role === "Moderator" ? "moderator-surface" : "about-surface",
        membershipEvidence: "x-roster",
      });
    }
  }
  return members;
}
