import test from "node:test";
import assert from "node:assert/strict";
import {
  computeCommunityStorageKeys,
  estimateStorageBytes,
  keyBelongsToCommunity,
  summarizeStorageByCommunity,
} from "../src/core/storageInventory.js";

const COMMUNITY_A = "1882332006949744648";
const COMMUNITY_B = "9999999999";

// One representative key of every real shape this project's checkpoint/
// cache modules write, keyed exactly as their own key-builder functions do.
function sampleStorage() {
  return {
    [`cursorRoster:${COMMUNITY_A}:meta`]: { schema: 4, pageCount: 3 },
    [`cursorRoster:${COMMUNITY_A}:gen-abc:page:1`]: { rows: [] },
    [`cursorRoster:android-all-v1:${COMMUNITY_A}:meta`]: { schema: 4, pageCount: 2 },
    [`cursorRoster:android-all-v1:${COMMUNITY_A}:gen-xyz:page:1`]: { rows: [] },
    [`activityScan:${COMMUNITY_A}:2026-07-01:2026-07-01:2026-07-31`]: { pages: 12 },
    [`communityTimelineBackfill:${COMMUNITY_A}`]: { pages: 5 },
    [`communityMediaBackfill:${COMMUNITY_A}`]: { pages: 2 },
    [`communitySearchBackfill:${COMMUNITY_A}:the`]: { pages: 1 },
    [`communitySearchBackfill:${COMMUNITY_A}:a`]: { pages: 1 },
    [`membershipVerification:${COMMUNITY_A}`]: { entries: {} },
    [`activitySearchVerification:${COMMUNITY_A}`]: { entries: {} },
    [`confirmedMemberArchive:${COMMUNITY_A}`]: { members: [] },
    [`observedCommunityAuthors:${COMMUNITY_A}`]: { authors: [] },
    [`cursorRoster:${COMMUNITY_B}:meta`]: { schema: 4, pageCount: 1 },
    liteScanJob: { schema: 3, communityId: COMMUNITY_A, status: "stopped" },
    liteScanSettings: { communityId: COMMUNITY_A, lookbackDays: 30 },
  };
}

test("keyBelongsToCommunity matches only a full colon-delimited segment, never a substring", () => {
  assert.equal(keyBelongsToCommunity(`cursorRoster:${COMMUNITY_A}:meta`, COMMUNITY_A), true);
  assert.equal(keyBelongsToCommunity(`cursorRoster:${COMMUNITY_A}9:meta`, COMMUNITY_A), false);
  assert.equal(keyBelongsToCommunity(`cursorRoster:x${COMMUNITY_A}:meta`, COMMUNITY_A), false);
  assert.equal(keyBelongsToCommunity(null, COMMUNITY_A), false);
  assert.equal(keyBelongsToCommunity(`cursorRoster:${COMMUNITY_A}:meta`, null), false);
});

test("computeCommunityStorageKeys finds every real key shape for the target Community, and nothing from another Community", () => {
  const storage = sampleStorage();
  const keys = computeCommunityStorageKeys(storage, COMMUNITY_A);
  const expectedShapes = [
    `cursorRoster:${COMMUNITY_A}:meta`,
    `cursorRoster:${COMMUNITY_A}:gen-abc:page:1`,
    `cursorRoster:android-all-v1:${COMMUNITY_A}:meta`,
    `cursorRoster:android-all-v1:${COMMUNITY_A}:gen-xyz:page:1`,
    `activityScan:${COMMUNITY_A}:2026-07-01:2026-07-01:2026-07-31`,
    `communityTimelineBackfill:${COMMUNITY_A}`,
    `communityMediaBackfill:${COMMUNITY_A}`,
    `communitySearchBackfill:${COMMUNITY_A}:the`,
    `communitySearchBackfill:${COMMUNITY_A}:a`,
    `membershipVerification:${COMMUNITY_A}`,
    `activitySearchVerification:${COMMUNITY_A}`,
    `confirmedMemberArchive:${COMMUNITY_A}`,
    `observedCommunityAuthors:${COMMUNITY_A}`,
    "liteScanJob",
  ];
  assert.deepEqual([...keys].sort(), [...expectedShapes].sort());
  assert.ok(!keys.includes(`cursorRoster:${COMMUNITY_B}:meta`));
  assert.ok(!keys.includes("liteScanSettings"));
});

test("computeCommunityStorageKeys leaves liteScanJob alone when it belongs to a different Community", () => {
  const storage = sampleStorage();
  storage.liteScanJob = { schema: 3, communityId: COMMUNITY_B, status: "stopped" };
  const keys = computeCommunityStorageKeys(storage, COMMUNITY_A);
  assert.ok(!keys.includes("liteScanJob"));
});

test("estimateStorageBytes grows with more/larger entries and is deterministic for the same input", () => {
  const small = { a: { x: 1 } };
  const large = { a: { x: 1 }, b: { y: "z".repeat(1000) } };
  assert.ok(estimateStorageBytes(large) > estimateStorageBytes(small));
  assert.equal(estimateStorageBytes(small), estimateStorageBytes({ a: { x: 1 } }));
});

test("summarizeStorageByCommunity discovers every Community with saved data, sorted by size, without being told one up front", () => {
  const storage = sampleStorage();
  const summary = summarizeStorageByCommunity(storage);
  const ids = summary.map((entry) => entry.communityId);
  assert.ok(ids.includes(COMMUNITY_A));
  assert.ok(ids.includes(COMMUNITY_B));
  assert.equal(ids.length, 2);
  // Community A has far more keys/bytes than B in this fixture.
  assert.equal(summary[0].communityId, COMMUNITY_A);
  assert.ok(summary[0].bytes > summary[1].bytes);
  const communityAEntry = summary.find((entry) => entry.communityId === COMMUNITY_A);
  assert.equal(communityAEntry.keys, 14);
});
