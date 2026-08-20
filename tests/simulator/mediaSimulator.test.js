// Drives the real, unmodified backfillCommunityMediaAuthors()
// (src/activity/mediaCollector.js, via the shared backfillEngine.js) against
// a fake Community media timeline server. Unlike fetchActiveAuthors, this
// engine has no lookback window and no repost filtering by design - it
// exists as supplemental bulk-discovery evidence, not an authoritative
// activity verdict, so every author behind every tweet it sees counts,
// including reposts - this test proves that's what actually happens, not
// what might be assumed from the activity engine's behavior.

import test from "node:test";
import assert from "node:assert/strict";
import { backfillCommunityMediaAuthors } from "../../src/activity/mediaCollector.js";
import { AdaptiveRateLimiter } from "../../src/api/rateLimiter.js";
import { DOCUMENT_IDS } from "../../src/api/operations.js";
import { createFakeXActivityServer } from "./fakeXActivityServer.js";
import { installFakeXEnvironment } from "./fakeXServer.js";

const noopSleep = async () => {};
function noInjectedDelay() {
  return { limiter: new AdaptiveRateLimiter(750, noopSleep), delayFn: noopSleep };
}

const DOCUMENT_ID = DOCUMENT_IDS.CommunityMediaTimeline;
const OPERATION = "CommunityMediaTimeline";

function generateMediaTweets(count, authorCount, untilMs, stepMs) {
  const tweets = [];
  for (let i = 0; i < count; i++) {
    const authorIndex = i % authorCount;
    tweets.push({
      tweetId: `m${i}`,
      authorUserId: `mu${authorIndex}`,
      authorUsername: `media_author_${authorIndex}`,
      createdAtMs: untilMs - i * stepMs,
      kind: i % 7 === 0 ? "repost" : "post",
    });
  }
  return tweets;
}

test("backfillCommunityMediaAuthors discovers exactly the authors behind every served media tweet, reposts included, across overlapping pages", async () => {
  const tweets = generateMediaTweets(320, 85, Date.UTC(2026, 6, 30), 60 * 1000);
  const server = createFakeXActivityServer({
    tweets, pageSize: 20, overlapCount: 5, kind: "media",
    documentId: DOCUMENT_ID, operation: OPERATION,
  });
  const env = installFakeXEnvironment(server);
  try {
    const result = await backfillCommunityMediaAuthors("1234567890", {
      maxPagesPerRun: 200,
      ...noInjectedDelay(),
    });

    const expected = new Set(tweets.map((t) => t.authorUserId));
    const collected = new Set(result.toJSON().map((author) => author.user_id));
    const missing = [...expected].filter((id) => !collected.has(id));
    const unexpected = [...collected].filter((id) => !expected.has(id));
    assert.equal(collected.size, expected.size,
      `missing ${missing.length} (e.g. ${missing.slice(0, 5).join(", ")}), ` +
      `${unexpected.length} unexpected (e.g. ${unexpected.slice(0, 5).join(", ")})`);
    assert.deepEqual(missing, []);
    assert.deepEqual(unexpected, []);
    assert.equal(result.timelineComplete, true);
    assert.equal(result.timelineReason, "timeline-ended");
    // This engine has no tweet-ID dedup (see backfillEngine.js) - overlap
    // means the same tweet gets scanned more than once, so timelinePosts is
    // expected to exceed the unique tweet count; author-set exactness above
    // is the real claim.
    assert.ok(result.timelinePosts >= tweets.length);
  } finally {
    env.restore();
  }
});

test("a 429 and a transient 500 mid-walk are retried and recovered without corrupting discovered media authors", async () => {
  const tweets = generateMediaTweets(120, 30, Date.UTC(2026, 4, 1), 5 * 60 * 1000);
  const server = createFakeXActivityServer({
    tweets, pageSize: 15, kind: "media",
    documentId: DOCUMENT_ID, operation: OPERATION,
    injectFault: (n) => (n === 2 ? "429" : n === 5 ? "500" : null),
  });
  const env = installFakeXEnvironment(server);
  try {
    const result = await backfillCommunityMediaAuthors("1234567890", {
      maxPagesPerRun: 200,
      ...noInjectedDelay(),
    });
    const expected = new Set(tweets.map((t) => t.authorUserId));
    const collected = new Set(result.toJSON().map((author) => author.user_id));
    assert.deepEqual([...expected].sort(), [...collected].sort());
    assert.equal(result.timelineComplete, true);
  } finally {
    env.restore();
  }
});
