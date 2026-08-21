// A deterministic fake for CommunityTweetSearchModuleQuery's direct
// `(from:username)` verification path (src/activity/directVerification.js),
// driving the real, unmodified verifyMemberActivityViaSearch(). This is the
// final evidence path before a member gets exported as confirmed-inactive,
// so proving its real orchestration - not a reimplementation - matters most
// of anywhere in this pipeline: this is the function whose output a
// moderator might act on directly.
//
// Reuses fakeXActivityServer.js's tweetNode/timelinePayload builders: a
// direct search answers under the same community_filtered_timeline envelope
// the word-shard search backfill uses (both are CommunityTweetSearchModuleQuery),
// just scoped to one specific author via the query variable instead of a
// generic word.

import { timelinePayload } from "./fakeXActivityServer.js";

// `postsByUsername` maps a username to the tweets that account posted in
// this Community - empty/absent means a genuine zero-result search, exactly
// like a real account with no Community activity (or a protected one this
// session cannot see into; that distinction is made by the caller from the
// candidate's own `protected` field, not from anything the search response
// can carry, so this fake server does not need to model it separately).
// `pageSize` (default 20, matching the real count:20 request) pages a
// username's tweets exactly like fakeXServer.js's roster cursor does - a
// base64 numeric-offset cursor, so a test can put a qualifying post past the
// first page (e.g. behind a page of reposts) and prove real pagination in
// verifyMemberActivityViaSearch, not just its single-page path.
// `onRequest(requestNumber)`, if given, runs before every response is built
// - see fakeXServer.js's identical hook for why.
export function createFakeXVerificationServer({
  postsByUsername, documentId, operation, injectFault, onRequest, pageSize = 20,
}) {
  let requestCount = 0;

  function respond(url) {
    requestCount++;
    onRequest?.(requestCount);
    const fault = injectFault?.(requestCount);
    if (fault === "429") {
      return {
        status: 429, statusText: "Too Many Requests", body: null,
        headers: { "retry-after": "0", "x-rate-limit-reset": String(Math.floor(Date.now() / 1000)) },
      };
    }
    if (fault === "500") return { status: 500, statusText: "Internal Server Error", body: null };
    if (fault === "graphql-error") {
      return {
        status: 200, statusText: "OK",
        body: { errors: [{ message: "This operation does not exist." }] },
      };
    }

    const parsed = new URL(url);
    const [, , , , reqDocumentId, reqOperation] = parsed.pathname.split("/");
    if (reqDocumentId !== documentId || reqOperation !== operation) {
      return { status: 404, statusText: "Not Found", body: null };
    }
    const variables = JSON.parse(parsed.searchParams.get("variables") || "{}");
    const match = /^\(from:(.+)\)$/.exec(variables.query || "");
    const username = match?.[1] || "";
    const tweets = postsByUsername[username] || [];
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
