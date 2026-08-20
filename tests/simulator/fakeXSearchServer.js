// A deterministic fake for the word-shard Community search backfill
// (src/activity/searchDiscovery.js), driving the real, unmodified
// backfillCommunitySearchAuthors() end to end. Reuses fakeXActivityServer.js's
// response builders (search answers under the same community_filtered_timeline
// envelope as media/activity) but routes by the `query` variable - each of
// the six shard words gets its own independent tweet pool and pagination,
// matching how backfillCommunitySearchAuthors runs six fully independent
// backfillSupplementalTimelineAuthors passes, one per shard, each with its
// own checkpoint.

import { timelinePayload } from "./fakeXActivityServer.js";

// `tweetsByQuery` maps a shard word (see searchDiscovery.js's
// COMMUNITY_SEARCH_SHARDS) to the tweets that shard's search finds. A word
// absent from the map behaves as a genuine zero-result shard.
export function createFakeXSearchServer({ tweetsByQuery, pageSize, documentId, operation, injectFault }) {
  let requestCount = 0;

  function respond(url) {
    requestCount++;
    const fault = injectFault?.(requestCount);
    if (fault === "429") {
      return {
        status: 429, statusText: "Too Many Requests", body: null,
        headers: { "retry-after": "0", "x-rate-limit-reset": String(Math.floor(Date.now() / 1000)) },
      };
    }
    if (fault === "500") return { status: 500, statusText: "Internal Server Error", body: null };

    const parsed = new URL(url);
    const [, , , , reqDocumentId, reqOperation] = parsed.pathname.split("/");
    if (reqDocumentId !== documentId || reqOperation !== operation) {
      return { status: 404, statusText: "Not Found", body: null };
    }
    const variables = JSON.parse(parsed.searchParams.get("variables") || "{}");
    const tweets = tweetsByQuery[variables.query] || [];
    const position = variables.cursor
      ? Number(Buffer.from(variables.cursor, "base64").toString("utf8"))
      : 0;
    const page = tweets.slice(position, position + pageSize);
    const nextPosition = position + page.length;
    const nextCursor = page.length > 0 && nextPosition < tweets.length
      ? Buffer.from(String(nextPosition)).toString("base64")
      : null;
    return {
      status: 200,
      statusText: "OK",
      body: timelinePayload(page, nextCursor, "search"),
      headers: { "x-rate-limit-limit": "500", "x-rate-limit-remaining": "499", "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 900) },
    };
  }

  return {
    respond,
    get requestCount() {
      return requestCount;
    },
  };
}
