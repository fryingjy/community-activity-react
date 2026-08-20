import test from "node:test";
import assert from "node:assert/strict";
import {
  activeAuthorToMember,
  mergeObservedAuthorRecords,
  observedAuthorToMember,
} from "../observedAuthors.js";

test("observed authors deduplicate changed handles by stable user ID", () => {
  const merged = mergeObservedAuthorRecords(
    [{
      username: "OldHandle",
      user_id: "42",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      observedPosts: 2,
    }],
    [{
      username: "NewHandle",
      user_id: "42",
      lastSeenCommunityPost: "2026-07-23T00:00:00.000Z",
      count: 3,
    }]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].username, "NewHandle");
  assert.equal(merged[0].observedPosts, 3);
  assert.equal(merged[0].lastSeenAt, "2026-07-23T00:00:00.000Z");
});

test("author evidence is labeled without claiming current roster membership", () => {
  const historical = observedAuthorToMember({
    username: "Alice",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
  });
  const recent = activeAuthorToMember({
    username: "Bob",
    lastSeenCommunityPost: "2026-07-23T00:00:00.000Z",
  });
  assert.equal(historical.membershipEvidence, "historical-community-post");
  assert.equal(historical.roleConfidence, "low");
  assert.equal(recent.membershipEvidence, "recent-community-post");
});
