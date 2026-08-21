// Drives the real, unmodified fetchCommunityMembersByCursor() against a fake
// X roster server, instead of proving the seek-resume *decision helpers*
// correct against a reimplementation of the orchestration loop (see
// liteScanner.test.js's simulateSeekResume). This exercises the actual
// production code path: request building, the real cursor codec, real
// checkpoint persistence, and the real chain-cap/dead-zone/reseek state
// machine in collectRoster.js - so a bug in how that code wires the
// decision helpers together, not just in the helpers themselves, would fail
// this test.
//
// Every test here injects a no-op limiter/delayFn (see rateLimiter.js and
// graphqlClient.js's injectable pacing seam) so none of this waits out
// fetchCommunityMembersByCursor's real ~750ms-per-request pacing or
// graphqlGet's real multi-second retry backoffs - production defaults for
// both are unchanged and pinned by a separate regression assertion in
// extensionArtifacts.test.js and by rateLimiter.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { fetchCommunityMembersByCursor } from "../../src/roster/collectRoster.js";
import { AdaptiveRateLimiter } from "../../src/api/rateLimiter.js";
import { NATIVE_MEMBERS_ALL_OPERATION } from "../../src/api/operations.js";
import { createFakeXRosterServer, installFakeXEnvironment } from "./fakeXServer.js";

const noopSleep = async () => {};
function noInjectedDelay() {
  return { limiter: new AdaptiveRateLimiter(750, noopSleep), delayFn: noopSleep };
}

function generateServableMembers(total, tiedBlockSize, spanMs, start) {
  const members = [];
  for (let i = 0; i < total; i++) {
    const joinTimeMs = i < tiedBlockSize
      ? start
      : start + Math.floor(spanMs * Math.pow((i - tiedBlockSize) / (total - tiedBlockSize), 2.2));
    members.push({ userId: String(1000 + i), username: `member_${i}`, joinTimeMs });
  }
  members.sort((left, right) => left.joinTimeMs - right.joinTimeMs);
  return members;
}

function assertExactCoverage(result, servable) {
  const expectedIds = new Set(servable.map((member) => member.userId));
  const collectedIds = new Set(result.members.map((member) => member.user_id));
  const missing = [...expectedIds].filter((id) => !collectedIds.has(id));
  const unexpected = [...collectedIds].filter((id) => !expectedIds.has(id));
  assert.equal(collectedIds.size, expectedIds.size,
    `missing ${missing.length} id(s) (e.g. ${missing.slice(0, 5).join(", ")}), ` +
    `${unexpected.length} unexpected id(s) (e.g. ${unexpected.slice(0, 5).join(", ")})`);
  assert.deepEqual(missing, []);
  assert.deepEqual(unexpected, []);
  assert.equal(result.complete, true);
  assert.equal(result.reason, "expected-count-reached");
}

test(
  "fetchCommunityMembersByCursor's collected IDs exactly equal the servable roster's IDs, through real seek-resume against a fake X server",
  async () => {
    const TOTAL = 900;
    const servable = generateServableMembers(TOTAL, 100, 200 * 24 * 60 * 60 * 1000, Date.UTC(2025, 0, 23));
    const server = createFakeXRosterServer({
      members: servable,
      pageSize: 30,
      chainPageCap: 6,
      documentId: NATIVE_MEMBERS_ALL_OPERATION.documentId,
      operation: NATIVE_MEMBERS_ALL_OPERATION.operation,
    });
    const env = installFakeXEnvironment(server);
    try {
      const result = await fetchCommunityMembersByCursor(
        "9999999999",
        NATIVE_MEMBERS_ALL_OPERATION,
        {
          expectedCount: TOTAL,
          seekResume: true,
          checkpointScope: "simulator-roster",
          maxPages: 2000,
          ...noInjectedDelay(),
        }
      );

      assertExactCoverage(result, servable);
      // The chain cap (6 pages) is far below what a single unbroken chain
      // could serve (900/30 = 30 pages), so completing at all is only
      // possible if the real seek-resume path in collectRoster.js actually
      // fired, not just the plain linear-cursor path.
      assert.ok(result.reseeks >= 3, `expected multiple seek-resume reseeks, got ${result.reseeks}`);

      // The real checkpoint code path must have actually run, not just the
      // request loop - this is what proves rosterCheckpoint.js's storage
      // contract, not only collectRoster.js's request/response handling.
      const checkpointKeys = [...env.storage.keys()].filter((key) => key.startsWith("cursorRoster:simulator-roster:"));
      assert.ok(checkpointKeys.length > 0, "expected checkpoint pages to be written during the walk");
    } finally {
      env.restore();
    }
  }
);

test(
  "a changed document ID or operation name since the last checkpoint is logged, not silently swallowed",
  async () => {
    const TOTAL = 40;
    const servable = generateServableMembers(TOTAL, 0, 5 * 24 * 60 * 60 * 1000, Date.UTC(2025, 5, 1));
    const server = createFakeXRosterServer({
      members: servable,
      pageSize: 25,
      chainPageCap: 20,
      documentId: NATIVE_MEMBERS_ALL_OPERATION.documentId,
      operation: NATIVE_MEMBERS_ALL_OPERATION.operation,
    });
    const env = installFakeXEnvironment(server);
    const communityId = "6666666666";
    const scope = "simulator-roster-drift";
    const lines = [];
    const log = (message) => lines.push(message);
    try {
      const first = await fetchCommunityMembersByCursor(communityId, NATIVE_MEMBERS_ALL_OPERATION, {
        expectedCount: TOTAL,
        checkpointScope: scope,
        maxPages: 2000,
        log,
        ...noInjectedDelay(),
      });
      assert.equal(first.complete, true);
      assert.ok(!lines.some((line) => line.includes("contract changed")));

      // A later scan against the same Community discovers a different live
      // operation (X rotated its persisted document ID). The already-complete
      // checkpoint is still reused - this only needs to be visible, not to
      // invalidate data that is still perfectly valid.
      const rotatedOperation = {
        ...NATIVE_MEMBERS_ALL_OPERATION,
        documentId: "rotatedDocumentId123",
        operation: "CommunitiesMembersAllQueryV2",
      };
      const second = await fetchCommunityMembersByCursor(communityId, rotatedOperation, {
        expectedCount: TOTAL,
        checkpointScope: scope,
        maxPages: 2000,
        log,
        ...noInjectedDelay(),
      });
      assert.equal(second.reason, "checkpoint-complete");
      assert.ok(
        lines.some((line) =>
          line.includes("contract changed") &&
          line.includes(NATIVE_MEMBERS_ALL_OPERATION.documentId) &&
          line.includes("rotatedDocumentId123")
        ),
        `expected a contract-change log line, got: ${JSON.stringify(lines)}`
      );
    } finally {
      env.restore();
    }
  }
);

test(
  "a 429 and a transient 500 mid-walk are retried and recovered without corrupting the collected roster",
  async () => {
    const TOTAL = 300;
    const servable = generateServableMembers(TOTAL, 0, 60 * 24 * 60 * 60 * 1000, Date.UTC(2025, 3, 1));
    const server = createFakeXRosterServer({
      members: servable,
      pageSize: 25,
      chainPageCap: 20,
      documentId: NATIVE_MEMBERS_ALL_OPERATION.documentId,
      operation: NATIVE_MEMBERS_ALL_OPERATION.operation,
      // Requests are 1-indexed across the server's whole lifetime; page 3
      // gets a 429, page 6 gets a transient 500, both must be survived by
      // the real retry/backoff path in graphqlGet.
      injectFault: (requestNumber) => (requestNumber === 3 ? "429" : requestNumber === 6 ? "500" : null),
    });
    const env = installFakeXEnvironment(server);
    try {
      const result = await fetchCommunityMembersByCursor(
        "8888888888",
        NATIVE_MEMBERS_ALL_OPERATION,
        {
          expectedCount: TOTAL,
          seekResume: true,
          checkpointScope: "simulator-roster-faults",
          maxPages: 2000,
          ...noInjectedDelay(),
        }
      );
      assertExactCoverage(result, servable);
    } finally {
      env.restore();
    }
  }
);

test(
  "a rate limit that outlasts every retry is not cached as a terminal stop - the next scan resumes, it doesn't replay a stale partial roster",
  async () => {
    // Real-validation finding: exhausting graphqlGet's own retries (6
    // attempts, real backoff) on a persistent 429 is not evidence the
    // roster itself is exhausted the way X repeating/withholding a cursor
    // is - only that this run couldn't get the next page right now. Before
    // this fix, that stop was cached as `terminal: true`, which made every
    // scan for the next 6 hours (PARTIAL_CHECKPOINT_MAX_AGE_MS) replay the
    // same truncated member list instead of resuming, even though X's
    // per-operation rate-limit windows clear in minutes.
    const TOTAL = 50;
    const servable = generateServableMembers(TOTAL, 0, 20 * 24 * 60 * 60 * 1000, Date.UTC(2025, 2, 1));
    let faultActive = true;
    const server = createFakeXRosterServer({
      members: servable,
      pageSize: 10,
      chainPageCap: 20,
      documentId: NATIVE_MEMBERS_ALL_OPERATION.documentId,
      operation: NATIVE_MEMBERS_ALL_OPERATION.operation,
      // Pages 1-3 succeed (30 members collected); from request 4 onward the
      // rate limit never clears within this run, so graphqlGet's 4th-page
      // attempt burns all 6 attempts and throws the exhausted-retries error.
      injectFault: (requestNumber) => (faultActive && requestNumber >= 4 ? "429" : null),
    });
    const env = installFakeXEnvironment(server);
    const communityId = "5555555555";
    const scope = "simulator-roster-rate-limit";
    try {
      const first = await fetchCommunityMembersByCursor(communityId, NATIVE_MEMBERS_ALL_OPERATION, {
        expectedCount: TOTAL,
        checkpointScope: scope,
        maxPages: 2000,
        ...noInjectedDelay(),
      });
      assert.equal(first.reason, "rate-limited");
      assert.equal(first.complete, false);
      assert.equal(first.members.length, 30);
      assert.ok(first.error, "expected the exhausted-retries error to be surfaced, not swallowed");

      const metaKey = `cursorRoster:${scope}:${communityId}:meta`;
      assert.equal(env.storage.get(metaKey).terminal, false,
        "a retry-exhausted rate limit must not be cached as a terminal stop");

      // The rate limit clears; a later scan (still well inside the 6-hour
      // partial-checkpoint window) must resume the cursor walk rather than
      // replaying the cached 30 members untouched.
      faultActive = false;
      const requestsBeforeResume = server.requestCount;
      const second = await fetchCommunityMembersByCursor(communityId, NATIVE_MEMBERS_ALL_OPERATION, {
        expectedCount: TOTAL,
        checkpointScope: scope,
        maxPages: 2000,
        ...noInjectedDelay(),
      });
      assert.ok(server.requestCount > requestsBeforeResume,
        "expected the resumed walk to make real requests, not just replay the cached checkpoint");
      assert.equal(second.resumed, true);
      assertExactCoverage(second, servable);
    } finally {
      env.restore();
    }
  }
);

test(
  "a large synthetic Community (79,000 members, 500-page chain cap) reaches exact servable coverage",
  { timeout: 60000 },
  async () => {
    // The scale this project was actually built around: matches the
    // audited Community's advertised size and X's real per-chain page cap.
    // Only affordable in a normal test run because pacing is injected -
    // see the file header.
    const TOTAL = 79000;
    const servable = generateServableMembers(TOTAL, 12000, 600 * 24 * 60 * 60 * 1000, Date.UTC(2024, 6, 1));
    const server = createFakeXRosterServer({
      members: servable,
      pageSize: 100,
      chainPageCap: 500,
      documentId: NATIVE_MEMBERS_ALL_OPERATION.documentId,
      operation: NATIVE_MEMBERS_ALL_OPERATION.operation,
    });
    const env = installFakeXEnvironment(server);
    try {
      const result = await fetchCommunityMembersByCursor(
        "7777777777",
        NATIVE_MEMBERS_ALL_OPERATION,
        {
          expectedCount: TOTAL,
          seekResume: true,
          checkpointScope: "simulator-roster-large",
          maxPages: 5000,
          ...noInjectedDelay(),
        }
      );
      assertExactCoverage(result, servable);
    } finally {
      env.restore();
    }
  }
);
