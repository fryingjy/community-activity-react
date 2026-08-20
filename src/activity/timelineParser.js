import { requireCommunityTimeline } from "../../graphqlContracts.js";
import { unwrapTweetResult } from "../core/unwrap.js";

export function communityActivityKind(tweet) {
  if (
    tweet?.legacy?.retweeted_status_result ||
    tweet?.retweeted_status_result
  ) {
    return "repost";
  }
  return tweet?.legacy?.in_reply_to_status_id_str ||
    tweet?.legacy?.in_reply_to_user_id_str
    ? "reply"
    : "post";
}

export function parseCommunityTimelinePage(payload, kind = "activity") {
  const timeline = requireCommunityTimeline(payload, kind);
  const entries = (timeline.instructions || []).flatMap((instruction) => instruction.entries || []);
  const tweets = [];
  const tweetIds = new Set();
  let nextCursor = null;

  for (const entry of entries) {
    const content = entry?.content || {};
    if (
      content.entryType === "TimelineTimelineCursor" &&
      String(content.cursorType).toLowerCase() === "bottom"
    ) {
      nextCursor = content.value || null;
      continue;
    }
    const itemContents = [
      content.itemContent,
      ...(content.items || []).map((item) => item?.item?.itemContent || item?.itemContent),
    ].filter(Boolean);
    for (const itemContent of itemContents) {
      const tweet = unwrapTweetResult(itemContent?.tweet_results?.result);
      if (!tweet) continue;
      const tweetId = String(tweet.rest_id || tweet.legacy?.id_str || "");
      if (tweetId && tweetIds.has(tweetId)) continue;
      if (tweetId) tweetIds.add(tweetId);
      tweets.push(tweet);
    }
  }
  return { tweets, nextCursor, entryCount: entries.length };
}
