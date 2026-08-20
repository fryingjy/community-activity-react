// Shared tree-walking helpers for roster-shaped GraphQL payloads (member
// lists, moderator slices, analytics, relationship verification). Response
// envelopes nest the same field under different paths depending on which
// operation answered, so these search the whole tree rather than assuming a
// fixed path — the cost of one extra traversal buys resilience to X moving a
// field between response versions.
export function firstKey(node, key) {
  if (!node || typeof node !== "object") return { found: false, value: undefined };
  if (Object.prototype.hasOwnProperty.call(node, key)) return { found: true, value: node[key] };
  for (const value of Object.values(node)) {
    const result = firstKey(value, key);
    if (result.found) return result;
  }
  return { found: false, value: undefined };
}

export function findUserResult(node) {
  if (!node || typeof node !== "object") return null;
  if (node.core?.screen_name || node.legacy?.screen_name) return node;
  for (const value of Object.values(node)) {
    const result = findUserResult(value);
    if (result) return result;
  }
  return null;
}

// X marks timeline nodes with `entryType` on some surfaces and `__typename` on
// others. The native Android roster uses `__typename` only, so testing one
// field alone silently loses that route's cursor.
export function isCursorNode(node) {
  return node.entryType === "TimelineTimelineCursor" ||
    node.__typename === "TimelineTimelineCursor";
}

export function bottomTimelineCursor(node) {
  if (!node || typeof node !== "object") return null;
  if (
    isCursorNode(node) &&
    String(node.cursorType || "").toLowerCase() === "bottom" &&
    typeof node.value === "string"
  ) return node.value;
  for (const value of Object.values(node)) {
    const cursor = bottomTimelineCursor(value);
    if (cursor) return cursor;
  }
  return null;
}
