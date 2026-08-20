// A deterministic fake X Community timeline server, driving the real,
// unmodified fetchActiveAuthors() (src/activity/timelineCollector.js) end to
// end - same rationale as fakeXServer.js for the roster collector: prove the
// real orchestration and parser wiring, not a reimplementation of it.
//
// Unlike the roster cursor, this endpoint has no seek/reseek mechanism in
// production - fetchActiveAuthors only ever walks forward via the server's
// own page.nextCursor until it decides the window is covered - so an opaque
// position-encoded cursor is an honest model here; there is no dead-zone
// class of bug for this endpoint to reproduce.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// X's classic tweet date format ("Wed Jul 22 12:00:00 +0000 2026") - the
// exact string production's `new Date(tweet.legacy.created_at)` must parse.
export function twitterDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000 ${d.getUTCFullYear()}`;
}

export function tweetNode(t) {
  return {
    rest_id: t.tweetId,
    legacy: {
      created_at: twitterDate(t.createdAtMs),
      ...(t.kind === "reply" ? { in_reply_to_status_id_str: `parent-${t.tweetId}` } : {}),
      ...(t.kind === "repost" ? { retweeted_status_result: { result: { rest_id: `orig-${t.tweetId}` } } } : {}),
    },
    core: {
      user_results: {
        result: {
          rest_id: t.authorUserId,
          core: { screen_name: t.authorUsername, name: t.authorUsername },
          legacy: { protected: t.protected === true },
        },
      },
    },
  };
}

// Matches graphqlContracts.js's requireCommunityTimeline: activity, media,
// and search each nest the same instructions/entries shape under a
// different top-level field. One fake server body covers all three real
// endpoints (they share this contract), parameterized by which field to
// answer under - not by pretending the endpoints are more different than
// they are.
const ENVELOPE_FIELD = Object.freeze({
  activity: "ranked_community_timeline",
  media: "community_media_timeline",
  search: "community_filtered_timeline",
});

export function timelinePayload(pageTweets, nextCursor, kind = "activity") {
  const entries = pageTweets.map((t, i) => ({
    entryId: `tweet-${t.tweetId}-${i}`,
    content: { itemContent: { tweet_results: { result: tweetNode(t) } } },
  }));
  if (nextCursor) {
    entries.push({
      content: { entryType: "TimelineTimelineCursor", cursorType: "Bottom", value: nextCursor },
    });
  }
  const field = ENVELOPE_FIELD[kind] || ENVELOPE_FIELD.activity;
  return {
    data: {
      communityResults: {
        result: { [field]: { timeline: { instructions: [{ entries }] } } },
      },
    },
  };
}

// `tweets` must be pre-sorted descending by createdAtMs (newest first) -
// that's the order a real Community timeline walks. `overlapCount` re-serves
// the tail of the previous page at the start of the next one, modelling the
// overlapping/duplicate pages a real cursor walk actually returns; the real
// collector's seenTweetIds dedup is what's under test when this is nonzero.
// `onRequest(requestNumber)`, if given, runs before every response is built
// - see fakeXServer.js's identical hook for why (simulating an interruption
// at an exact point without racing real timing).
// `remainingQuota`, if given, overrides the x-rate-limit-remaining header on
// every 200 response - a fixed number, or a function of the request number
// for a bucket that visibly drains over the walk. Defaults to a constant
// generous value, matching every existing test's assumption of "quota is
// never the limiting factor here."
export function createFakeXActivityServer({
  tweets, pageSize, documentId, operation, overlapCount = 0, injectFault, kind = "activity", onRequest, remainingQuota = 499,
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
    if (fault === "malformed") return { status: 200, statusText: "OK", body: { data: {} } };

    const parsed = new URL(url);
    const [, , , , reqDocumentId, reqOperation] = parsed.pathname.split("/");
    if (reqDocumentId !== documentId || reqOperation !== operation) {
      return { status: 404, statusText: "Not Found", body: null };
    }
    const variables = JSON.parse(parsed.searchParams.get("variables") || "{}");
    const requestedPosition = variables.cursor
      ? Number(Buffer.from(variables.cursor, "base64").toString("utf8"))
      : 0;
    const position = Math.max(0, requestedPosition - overlapCount);
    const page = tweets.slice(position, position + pageSize);
    const nextPosition = position + page.length;
    const nextCursor = page.length > 0 && nextPosition < tweets.length
      ? Buffer.from(String(nextPosition)).toString("base64")
      : null;
    const remaining = typeof remainingQuota === "function" ? remainingQuota(requestCount) : remainingQuota;
    return {
      status: 200,
      statusText: "OK",
      body: timelinePayload(page, nextCursor, kind),
      headers: { "x-rate-limit-limit": "500", "x-rate-limit-remaining": String(remaining), "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 900) },
    };
  }

  return {
    respond,
    get requestCount() {
      return requestCount;
    },
  };
}
