import { graphqlGet } from "../api/graphqlClient.js";
import { DOCUMENT_IDS } from "../api/operations.js";
import { firstKey, findUserResult } from "./graphqlTree.js";
import { unwrapUserResult } from "../core/unwrap.js";

// The About timeline returns only the small visible moderator group (5 entries
// on the audited Community). This operation returns the full moderator and
// admin set — 37 records in one uncursored response on the same Community, 9 of
// which never appeared anywhere in a 46,960-member native roster walk. Every
// record carries an explicit X-assigned role, so it is the strongest membership
// evidence available and costs a single request.
export function parseCommunityModeratorsPayload(payload) {
  const slice = firstKey(payload, "moderators_slice").value;
  const items = Array.isArray(slice?.items_results) ? slice.items_results : [];
  const members = [];
  for (const item of items) {
    const user = unwrapUserResult(item?.result) || findUserResult(item);
    const username = user?.core?.screen_name || user?.legacy?.screen_name;
    if (!username) continue;
    members.push({
      username,
      name: user.core?.name || user.legacy?.name || username,
      user_id: user.rest_id || user.id_str || null,
      role: firstKey(item, "community_role").value || "Moderator",
      protected: typeof user.privacy?.protected === "boolean"
        ? user.privacy.protected
        : typeof user.legacy?.protected === "boolean"
          ? user.legacy.protected
          : null,
      roleConfidence: "high",
      source: "moderator-slice",
      membershipEvidence: "x-roster",
    });
  }
  const raw = typeof slice?.slice_info?.next_cursor === "string"
    ? slice.slice_info.next_cursor
    : null;
  // Same zero-prefixed terminal sentinel the member slice uses.
  const nextCursor = raw && raw.split("|", 1)[0] !== "0" ? raw : null;
  return { members, nextCursor, rawCount: items.length };
}

export async function fetchCommunityModerators(
  communityId,
  { signal, requestStats, log, limiter, operation, count = 100 } = {}
) {
  const moderatorOperation = operation || {
    documentId: DOCUMENT_IDS.moderatorsSliceTimeline_Query,
    operation: "moderatorsSliceTimeline_Query",
  };
  const members = [];
  const seen = new Set();
  let cursor = null;
  const seenCursors = new Set();
  // The audited Community returned every moderator in one page with no next
  // cursor, but the operation does accept one, so a larger moderator group is
  // followed rather than silently truncated.
  for (let page = 0; page < 20; page++) {
    const variables = { communityId, count };
    if (cursor) variables.cursor = cursor;
    const payload = await graphqlGet(
      moderatorOperation.documentId,
      moderatorOperation.operation,
      variables,
      moderatorOperation.features && Object.keys(moderatorOperation.features).length
        ? moderatorOperation.features
        : null,
      {
        signal,
        requestStats,
        log,
        limiter,
        maxAttempts: 3,
        clientTransactionId: moderatorOperation.clientTransactionId || null,
      }
    );
    const parsed = parseCommunityModeratorsPayload(payload);
    for (const member of parsed.members) {
      const key = member.username.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      members.push(member);
    }
    if (!parsed.rawCount || !parsed.nextCursor || seenCursors.has(parsed.nextCursor)) break;
    seenCursors.add(parsed.nextCursor);
    cursor = parsed.nextCursor;
  }
  return members;
}
