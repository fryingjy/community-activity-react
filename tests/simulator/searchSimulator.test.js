// Drives the real, unmodified backfillCommunitySearchAuthors()
// (src/activity/searchDiscovery.js) against a fake Community search server.
// The underlying per-shard walk (backfillSupplementalTimelineAuthors) is
// already proven by mediaSimulator.test.js, since media and search share
// that exact engine - what's specific to searchDiscovery.js itself, and so
// what this test is actually for, is the six-shard iteration: one
// independent checkpointed pass per word, each contributing to one combined,
// deduplicated author set.

import test from "node:test";
import assert from "node:assert/strict";
import {
  backfillCommunitySearchAuthors,
  COMMUNITY_SEARCH_SHARDS,
} from "../../src/activity/searchDiscovery.js";
import { AdaptiveRateLimiter } from "../../src/api/rateLimiter.js";
import { DOCUMENT_IDS } from "../../src/api/operations.js";
import { createFakeXSearchServer } from "./fakeXSearchServer.js";
import { installFakeXEnvironment } from "./fakeXServer.js";

const noopSleep = async () => {};
function noInjectedDelay() {
  return { limiter: new AdaptiveRateLimiter(750, noopSleep), delayFn: noopSleep };
}

const DOCUMENT_ID = DOCUMENT_IDS.CommunityTweetSearchModuleQuery;
const OPERATION = "CommunityTweetSearchModuleQuery";

function tweet(id, authorUserId, ms) {
  return { tweetId: id, authorUserId, authorUsername: `author_${authorUserId}`, createdAtMs: ms, kind: "post" };
}

test("backfillCommunitySearchAuthors unions and deduplicates authors across all six independent shards", async () => {
  const [a, the, to, and_, i, you] = COMMUNITY_SEARCH_SHARDS;
  const now = Date.UTC(2026, 6, 1);
  // "the" and "a" both surface X2; "and" and "i" both surface X4; "to" is a
  // genuine zero-result shard - exactly the "duplicate author across
  // multiple shards" and "zero results" cases the completion plan asks for.
  const tweetsByQuery = {
    [a]: [tweet("t1", "X1", now), tweet("t2", "X2", now - 1000)],
    [the]: [tweet("t3", "X2", now - 2000), tweet("t4", "X3", now - 3000)],
    [to]: [],
    [and_]: [tweet("t5", "X4", now - 4000)],
    [i]: [tweet("t6", "X4", now - 5000), tweet("t7", "X5", now - 6000)],
    [you]: [tweet("t8", "X6", now - 7000)],
  };
  const server = createFakeXSearchServer({
    tweetsByQuery, pageSize: 20, documentId: DOCUMENT_ID, operation: OPERATION,
  });
  const env = installFakeXEnvironment(server);
  try {
    const result = await backfillCommunitySearchAuthors("1234567890", {
      maxPagesPerShard: 10,
      ...noInjectedDelay(),
    });

    const expected = new Set(["X1", "X2", "X3", "X4", "X5", "X6"]);
    const collected = new Set(result.toJSON().map((author) => author.user_id));
    assert.deepEqual([...collected].sort(), [...expected].sort());

    assert.equal(result.shards.length, COMMUNITY_SEARCH_SHARDS.length);
    assert.equal(result.timelineComplete, true);
    const toShard = result.shards.find((state) => state.query === to);
    assert.equal(toShard.authors, 0);
    assert.equal(toShard.complete, true);
    const aShard = result.shards.find((state) => state.query === a);
    assert.equal(aShard.authors, 2);
  } finally {
    env.restore();
  }
});

test("a 429 and a transient 500 mid-shard are retried and recovered without corrupting the combined author set", async () => {
  const [a, the, to, and_, i, you] = COMMUNITY_SEARCH_SHARDS;
  const now = Date.UTC(2026, 4, 1);
  const tweetsByQuery = {
    [a]: [tweet("t1", "Y1", now)],
    [the]: [tweet("t2", "Y2", now - 1000)],
    [to]: [],
    [and_]: [],
    [i]: [tweet("t3", "Y3", now - 2000)],
    [you]: [],
  };
  const server = createFakeXSearchServer({
    tweetsByQuery, pageSize: 20, documentId: DOCUMENT_ID, operation: OPERATION,
    injectFault: (n) => (n === 2 ? "429" : n === 4 ? "500" : null),
  });
  const env = installFakeXEnvironment(server);
  try {
    const result = await backfillCommunitySearchAuthors("1234567890", {
      maxPagesPerShard: 10,
      ...noInjectedDelay(),
    });
    const collected = new Set(result.toJSON().map((author) => author.user_id));
    assert.deepEqual([...collected].sort(), ["Y1", "Y2", "Y3"]);
    assert.equal(result.timelineComplete, true);
  } finally {
    env.restore();
  }
});
