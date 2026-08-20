export function createActivityIndex(seed = []) {
  const byUsername = new Map();
  const byId = new Map();
  // byUsername can map more than one key to the same author object (a
  // username change keeps the old key so lookups by either still resolve),
  // so unique authors are tracked separately rather than recomputed from
  // byUsername.values() on every size/toJSON access — that access happens
  // once per page during a scan and would otherwise rebuild a Set over the
  // full author list each time.
  const uniqueAuthors = new Set();
  const counts = (author) => {
    const rawCount = Number(author?.count);
    const rawPosts = Number(author?.posts);
    const rawReplies = Number(author?.replies);
    const hasBreakdown = Number.isFinite(rawPosts) || Number.isFinite(rawReplies);
    const posts = hasBreakdown
      ? Math.max(0, Number.isFinite(rawPosts) ? rawPosts : 0)
      : Math.max(0, Number.isFinite(rawCount) ? rawCount : 0);
    const replies = hasBreakdown
      ? Math.max(0, Number.isFinite(rawReplies) ? rawReplies : 0)
      : 0;
    return { posts, replies, count: posts + replies };
  };
  const add = (author) => {
    if (!author?.username) return;
    const incoming = counts(author);
    const usernameKey = author.username.toLowerCase();
    const idKey = author.user_id ? String(author.user_id) : null;
    const previous = (idKey && byId.get(idKey)) || byUsername.get(usernameKey);
    if (previous) {
      previous.posts = (previous.posts || 0) + incoming.posts;
      previous.replies = (previous.replies || 0) + incoming.replies;
      previous.count = previous.posts + previous.replies;
      if (
        author.lastSeenCommunityPost &&
        (!previous.lastSeenCommunityPost ||
          author.lastSeenCommunityPost > previous.lastSeenCommunityPost)
      ) {
        previous.lastSeenCommunityPost = author.lastSeenCommunityPost;
      }
      if (previous.username.toLowerCase() !== usernameKey) byUsername.set(usernameKey, previous);
      return;
    }
    const next = {
      ...author,
      posts: incoming.posts,
      replies: incoming.replies,
      count: incoming.count,
    };
    byUsername.set(usernameKey, next);
    if (idKey) byId.set(idKey, next);
    uniqueAuthors.add(next);
  };
  for (const author of seed || []) add(author);
  return {
    byUsername,
    byId,
    add,
    get size() {
      return uniqueAuthors.size;
    },
    toJSON: () => [...uniqueAuthors],
  };
}

export function activityDetailsForMember(activity, member) {
  const byStableId = member?.user_id ? activity?.byId?.get(String(member.user_id)) : null;
  const record = byStableId || activity?.byUsername?.get(member?.username?.toLowerCase());
  const posts = Math.max(0, Number(record?.posts) || 0);
  const replies = Math.max(0, Number(record?.replies) || 0);
  const legacyCount = Math.max(0, Number(record?.count) || 0);
  const total = posts + replies || legacyCount;
  return {
    posts,
    replies,
    total,
    lastSeenCommunityPost: record?.lastSeenCommunityPost || "",
  };
}

export function activityCountForMember(activity, member) {
  return activityDetailsForMember(activity, member).total;
}

// Pure evidence -> verdict functions. Kept free of DOM/UI state so the
// classification rules themselves (what counts as flagged, what a flag
// reason says, how a direct-search result resolves a flagged member) are
// unit-testable without a scan, a browser, or mocked chrome.* APIs.

export function annotateMemberActivity(member, activity) {
  const details = activityDetailsForMember(activity, member);
  return {
    ...member,
    postsInWindow: details.total,
    communityPostsInWindow: details.posts,
    communityRepliesInWindow: details.replies,
    lastSeenCommunityPost: details.lastSeenCommunityPost || member.lastSeenCommunityPost || "",
  };
}

export function classifyFlaggedMember(member, lookbackDays) {
  const flagReason =
    `No Community posts or replies in the last ${lookbackDays} calendar days` +
    (member.membershipEvidence === "historical-community-post"
      ? "; current membership not confirmed by X's returned roster"
      : member.membershipEvidence === "recent-community-post"
        ? "; observed posting in this Community but omitted from X's roster window"
        : "");
  return {
    ...member,
    flagReason,
    activityBucket: "zero-community-activity",
    changeStatus: "",
  };
}

// Resolves what a direct (from:username) search result means for a member
// already flagged by the broad crawl. `result` is the matching entry (or
// undefined) from verifyMemberActivityViaSearch's results map. A protected
// account returns the same empty search result whether it genuinely posted
// nothing or simply cannot be seen by this session, so an empty result there
// is not evidence of inactivity the way it is for a public account.
export function classifySearchVerification(member, result) {
  if (result?.hasActivityInWindow) return { cleared: true };
  return {
    cleared: false,
    activityVerification: !result
      ? "unverified"
      : member.protected === true
        ? "unverifiable-protected"
        : "confirmed-inactive",
  };
}
