// Shared across roster (moderator slices) and activity (tweet timelines):
// both response families nest the object of interest behind a `.result` /
// `.tweet` / `.user` chain of arbitrary depth depending on which surface
// answered.
export function unwrapTweetResult(result) {
  if (!result || typeof result !== "object") return null;
  if (result.tweet) return unwrapTweetResult(result.tweet);
  if (result.result) return unwrapTweetResult(result.result);
  return result.legacy?.created_at ? result : null;
}

export function unwrapUserResult(result) {
  if (!result || typeof result !== "object") return null;
  if (result.user) return unwrapUserResult(result.user);
  if (result.result) return unwrapUserResult(result.result);
  return result.core?.screen_name || result.legacy?.screen_name ? result : null;
}
