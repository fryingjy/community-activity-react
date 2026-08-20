// Drives the real, unmodified verifyMemberActivityViaSearch()
// (src/activity/directVerification.js) against a fake CommunityTweetSearchModuleQuery
// server. This is the final evidence path before a member is exported as
// confirmed-inactive - the function whose output a moderator might actually
// act on - so proving its real request building, response parsing, caching,
// and error handling end to end matters more here than anywhere else in
// this pipeline.
//
// Whether a "zero results" verdict means confirmed-inactive vs.
// unverifiable-protected is decided by classifySearchVerification
// (src/activity/classification.js, already unit tested directly) from the
// candidate's own `protected` field - the search response itself cannot
// carry that distinction, a protected account's empty result looks
// identical to a genuinely silent public one. So this simulator proves what
// verifyMemberActivityViaSearch itself is responsible for:
// hasActivityInWindow correctness, caching, and error/quota handling.

import test from "node:test";
import assert from "node:assert/strict";
import {
  activitySearchCandidateIdentity,
  verifyMemberActivityViaSearch,
} from "../../src/activity/directVerification.js";
import { AdaptiveRateLimiter } from "../../src/api/rateLimiter.js";
import { DOCUMENT_IDS } from "../../src/api/operations.js";
import { createFakeXVerificationServer } from "./fakeXVerificationServer.js";
import { installFakeXEnvironment } from "./fakeXServer.js";

const noopSleep = async () => {};
function noInjectedDelay() {
  return { limiter: new AdaptiveRateLimiter(1250, noopSleep), delayFn: noopSleep };
}

const DOCUMENT_ID = DOCUMENT_IDS.CommunityTweetSearchModuleQuery;
const OPERATION = "CommunityTweetSearchModuleQuery";
const SINCE = new Date(Date.UTC(2026, 6, 1));
const IN_WINDOW = Date.UTC(2026, 6, 15);
const BEFORE_WINDOW = Date.UTC(2026, 5, 1);

test("verifyMemberActivityViaSearch resolves each candidate's real evidence state and caches it", async () => {
  const candidateA = { username: "alice", user_id: "1" }; // recent original post -> active
  const candidateB = { username: "bob", user_id: "2" }; // recent reply -> active
  const candidateC = { username: "carol", user_id: "3" }; // zero results -> inactive (by this function's own answer)
  const candidates = [candidateA, candidateB, candidateC];

  const server = createFakeXVerificationServer({
    documentId: DOCUMENT_ID,
    operation: OPERATION,
    postsByUsername: {
      alice: [{ tweetId: "a1", authorUserId: "1", authorUsername: "alice", createdAtMs: IN_WINDOW, kind: "post" }],
      bob: [{ tweetId: "b1", authorUserId: "2", authorUsername: "bob", createdAtMs: IN_WINDOW, kind: "reply" }],
      // carol: no entry - a genuine zero-result search.
    },
  });
  const env = installFakeXEnvironment(server);
  try {
    const result = await verifyMemberActivityViaSearch("1234567890", candidates, {
      sinceDate: SINCE,
      ...noInjectedDelay(),
    });

    assert.equal(result.checked, 3);
    assert.equal(result.remaining, 0);
    assert.equal(result.reason, "queue-complete");
    assert.equal(result.error, null);

    const a = result.results.get(activitySearchCandidateIdentity(candidateA));
    const b = result.results.get(activitySearchCandidateIdentity(candidateB));
    const c = result.results.get(activitySearchCandidateIdentity(candidateC));
    assert.equal(a.hasActivityInWindow, true);
    assert.equal(b.hasActivityInWindow, true);
    assert.equal(c.hasActivityInWindow, false);
    assert.equal(c.lastPostAt, null);

    // Re-running immediately must reuse the cache (checked within its
    // freshness window) rather than issuing new requests for the same
    // candidates - the real storage-backed cache path, not just the request
    // loop.
    const requestsBeforeRerun = server.requestCount;
    const rerun = await verifyMemberActivityViaSearch("1234567890", candidates, {
      sinceDate: SINCE,
      ...noInjectedDelay(),
    });
    assert.equal(rerun.checked, 0);
    // Real behavior, not the "up-to-date" one might expect from the initial
    // stoppedReason default: the later `checked >= pendingCandidates.length`
    // check (0 >= 0) overwrites it to "queue-complete" even when nothing was
    // pending in the first place - caught by running the real function
    // twice rather than assumed from reading the code once.
    assert.equal(rerun.reason, "queue-complete");
    assert.equal(server.requestCount, requestsBeforeRerun);
  } finally {
    env.restore();
  }
});

test("a repost does not count as activity even when it is the only result found", async () => {
  const candidate = { username: "dave", user_id: "4" };
  const server = createFakeXVerificationServer({
    documentId: DOCUMENT_ID,
    operation: OPERATION,
    postsByUsername: {
      dave: [{ tweetId: "d1", authorUserId: "4", authorUsername: "dave", createdAtMs: IN_WINDOW, kind: "repost" }],
    },
  });
  const env = installFakeXEnvironment(server);
  try {
    const result = await verifyMemberActivityViaSearch("1234567890", [candidate], {
      sinceDate: SINCE,
      ...noInjectedDelay(),
    });
    const entry = result.results.get(activitySearchCandidateIdentity(candidate));
    assert.equal(entry.hasActivityInWindow, false);
  } finally {
    env.restore();
  }
});

test("a post found but before the selected window does not count as in-window activity", async () => {
  const candidate = { username: "erin", user_id: "5" };
  const server = createFakeXVerificationServer({
    documentId: DOCUMENT_ID,
    operation: OPERATION,
    postsByUsername: {
      erin: [{ tweetId: "e1", authorUserId: "5", authorUsername: "erin", createdAtMs: BEFORE_WINDOW, kind: "post" }],
    },
  });
  const env = installFakeXEnvironment(server);
  try {
    const result = await verifyMemberActivityViaSearch("1234567890", [candidate], {
      sinceDate: SINCE,
      ...noInjectedDelay(),
    });
    const entry = result.results.get(activitySearchCandidateIdentity(candidate));
    assert.equal(entry.hasActivityInWindow, false);
    assert.ok(entry.lastPostAt, "the post itself must still be recorded, just outside the window");
  } finally {
    env.restore();
  }
});

test("a candidate whose request never completes (quota run-limit) is left unverified rather than guessed at", async () => {
  const candidates = Array.from({ length: 5 }, (_, i) => ({ username: `user${i}`, user_id: String(10 + i) }));
  const server = createFakeXVerificationServer({
    documentId: DOCUMENT_ID,
    operation: OPERATION,
    postsByUsername: {},
  });
  const env = installFakeXEnvironment(server);
  try {
    const result = await verifyMemberActivityViaSearch("1234567890", candidates, {
      sinceDate: SINCE,
      maxCandidatesPerRun: 2,
      ...noInjectedDelay(),
    });
    assert.equal(result.checked, 2);
    assert.equal(result.remaining, 3);
    assert.equal(result.reason, "run-limit");
    // The 3 deferred candidates have no result entry at all - the caller's
    // classifySearchVerification treats a missing entry as "unverified",
    // never as an inferred verdict.
    for (const candidate of candidates.slice(2)) {
      assert.equal(result.results.get(activitySearchCandidateIdentity(candidate)), undefined);
    }
  } finally {
    env.restore();
  }
});

test("a real observed quota - not the static fallback - decides how many candidates this run actually checks", async () => {
  const candidates = Array.from({ length: 10 }, (_, i) => ({ username: `quser${i}`, user_id: String(20 + i) }));
  const server = createFakeXVerificationServer({
    documentId: DOCUMENT_ID,
    operation: OPERATION,
    postsByUsername: {},
  });
  const env = installFakeXEnvironment(server);
  try {
    // Simulates the word-shard backfill having already drawn down this same
    // bucket earlier in the same scan, exactly as real scans share it - see
    // directVerification.js's own comment on why this bucket is shared.
    const requestStats = { quotas: { [OPERATION]: { remaining: 30, limit: 500, resetAt: null } } };
    const result = await verifyMemberActivityViaSearch("1234567890", candidates, {
      sinceDate: SINCE,
      requestStats,
      // Deliberately not passing maxCandidatesPerRun: if the static
      // fallback were still driving this, it would default to 400 and
      // check everything - only the real observed quota explains checking
      // fewer than all 10.
      ...noInjectedDelay(),
    });
    // usable = 30 remaining - 25 reserved (5% of 500, the larger of the two
    // reserve rules) = 5.
    assert.equal(result.checked, 5);
    assert.equal(result.remaining, 5);
    assert.equal(result.reason, "quota-budget");
    assert.equal(result.quota.usable, 5);
    assert.equal(server.requestCount, 5);
  } finally {
    env.restore();
  }
});

test("a transient 500 is retried and resolved correctly within one candidate's request", async () => {
  const candidate = { username: "frank", user_id: "6" };
  const server = createFakeXVerificationServer({
    documentId: DOCUMENT_ID,
    operation: OPERATION,
    postsByUsername: {
      frank: [{ tweetId: "f1", authorUserId: "6", authorUsername: "frank", createdAtMs: IN_WINDOW, kind: "post" }],
    },
    injectFault: (n) => (n === 1 ? "500" : null),
  });
  const env = installFakeXEnvironment(server);
  try {
    const result = await verifyMemberActivityViaSearch("1234567890", [candidate], {
      sinceDate: SINCE,
      ...noInjectedDelay(),
    });
    assert.equal(result.checked, 1);
    assert.equal(result.error, null);
    assert.equal(result.results.get(activitySearchCandidateIdentity(candidate)).hasActivityInWindow, true);
  } finally {
    env.restore();
  }
});

test("a permanent contract failure on one candidate stops the run and leaves later candidates unverified, with the failure surfaced", async () => {
  const grace = { username: "grace", user_id: "7" }; // never reached
  const gary = { username: "gary", user_id: "8" }; // fails permanently
  const server = createFakeXVerificationServer({
    documentId: DOCUMENT_ID,
    operation: OPERATION,
    postsByUsername: {},
    // gary is processed first; its every attempt (maxAttempts: 3) comes back
    // as a contract failure, which graphqlGet does not retry at all.
    injectFault: () => "graphql-error",
  });
  const env = installFakeXEnvironment(server);
  try {
    const result = await verifyMemberActivityViaSearch("1234567890", [gary, grace], {
      sinceDate: SINCE,
      ...noInjectedDelay(),
    });
    assert.equal(result.checked, 0);
    assert.equal(result.reason, "request-error");
    assert.ok(result.error instanceof Error);
    assert.equal(result.results.get(activitySearchCandidateIdentity(gary)), undefined);
    assert.equal(result.results.get(activitySearchCandidateIdentity(grace)), undefined);
    // Exactly one request: the permanent failure stops the whole run rather
    // than moving on to the next candidate - real behavior, proven here
    // rather than assumed.
    assert.equal(server.requestCount, 1);
  } finally {
    env.restore();
  }
});
