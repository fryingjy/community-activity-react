import { firstKey, findUserResult, bottomTimelineCursor } from "./graphqlTree.js";

// The native `CommunitiesMembersAllQuery` does not answer with the web slice's
// `items_results`/`next_cursor` shape at all. It returns a timeline whose
// entries carry `TimelineUser` items, so a parser written only for the web
// contract reads zero members and no cursor from a perfectly good 200 response
// — which is how the route appeared to "fail" and fall back on every scan.
export function parseCommunityMembersTimelinePayload(payload) {
  const members = [];
  const seen = new Set();
  let rawCount = 0;
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.__typename === "TimelineUser" || node.userResult) {
      rawCount++;
      const user = findUserResult(node.userResult?.result ?? node);
      const username = user?.core?.screen_name || user?.legacy?.screen_name;
      if (username && !seen.has(username.toLowerCase())) {
        seen.add(username.toLowerCase());
        members.push({
          username,
          name: user.core?.name || user.legacy?.name || username,
          user_id: user.rest_id || user.id_str || null,
          role: firstKey(node, "community_role").value || "Member",
          protected: typeof user.privacy?.protected === "boolean"
            ? user.privacy.protected
            : typeof user.legacy?.protected === "boolean"
              ? user.legacy.protected
              : null,
          roleConfidence: "medium",
          source: "cursor",
        });
      }
      return;
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(payload);
  const raw = bottomTimelineCursor(payload);
  const nextCursor = raw && raw.split("|", 1)[0] !== "0" ? raw : null;
  return { members, nextCursor, rawCount };
}

export function parseCommunityMembersCursorPayload(payload) {
  const itemsResult = firstKey(payload, "items_results");
  // No `items_results` means this is not the web slice contract. Fall through
  // to the native timeline shape rather than reporting an empty roster.
  if (!Array.isArray(itemsResult.value)) {
    return parseCommunityMembersTimelinePayload(payload);
  }
  const items = itemsResult.value;
  const members = [];
  for (const item of items) {
    const user = findUserResult(item);
    const username = user?.core?.screen_name || user?.legacy?.screen_name;
    if (!username) continue;
    const roleResult = firstKey(item, "community_role");
    const protectedValue = typeof user.privacy?.protected === "boolean"
      ? user.privacy.protected
      : typeof user.legacy?.protected === "boolean"
        ? user.legacy.protected
        : null;
    members.push({
      username,
      name: user.core?.name || user.legacy?.name || username,
      user_id: user.rest_id || user.id_str || null,
      role: roleResult.value || "Member",
      protected: protectedValue,
      roleConfidence: "high",
      source: "cursor",
    });
  }
  const cursorResult = firstKey(payload, "next_cursor");
  const rawCursor = typeof cursorResult.value === "string"
    ? cursorResult.value
    : bottomTimelineCursor(payload);
  // X uses a leading zero segment as the roster's terminal cursor sentinel.
  // Treating it as another page only repeats the final request and obscures
  // the fact that the server deliberately ended pagination.
  const nextCursor = rawCursor && rawCursor.split("|", 1)[0] !== "0"
    ? rawCursor
    : null;
  return { members, nextCursor: nextCursor || null, rawCount: items.length };
}
