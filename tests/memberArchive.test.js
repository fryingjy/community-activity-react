import test from "node:test";
import assert from "node:assert/strict";
import { mergeConfirmedMemberArchive } from "../memberArchive.js";
import { mergeMemberLists } from "../domScan.js";

test("confirmed archive unions snapshots by stable ID and records provenance", () => {
  const first = mergeConfirmedMemberArchive([], [{
    username: "OldHandle",
    name: "Member",
    user_id: "42",
    role: "Member",
    protected: false,
    source: "cursor",
    membershipEvidence: "x-roster",
  }], { observedAt: "2026-07-01T00:00:00.000Z", snapshotId: "one" });
  const second = mergeConfirmedMemberArchive(first.records, [{
    username: "NewHandle",
    name: "Member",
    user_id: "42",
    role: "Member",
    protected: true,
    source: "relationship-verification",
    membershipEvidence: "x-roster",
  }], { observedAt: "2026-07-02T00:00:00.000Z", snapshotId: "two" });

  assert.equal(second.records.length, 1);
  assert.equal(second.records[0].username, "NewHandle");
  assert.equal(second.records[0].protected, true);
  assert.equal(second.records[0].sightings, 2);
  assert.deepEqual(
    second.records[0].discoverySources.sort(),
    ["activity_verification", "direct_roster"]
  );
});

test("archive excludes unverified historical author evidence", () => {
  const result = mergeConfirmedMemberArchive([], [{
    username: "Unverified",
    user_id: "7",
    membershipEvidence: "historical-community-post",
  }]);
  assert.equal(result.records.length, 0);
});

test("stronger exact verification promotes an existing author to x-roster", () => {
  const result = mergeMemberLists(
    [{
      username: "Known",
      user_id: "9",
      protected: null,
      membershipEvidence: "recent-community-post",
      roleConfidence: "medium",
    }],
    [{
      username: "Known",
      user_id: "9",
      protected: true,
      membershipEvidence: "x-roster",
      roleConfidence: "high",
      source: "relationship-verification",
    }]
  );
  assert.equal(result.merged[0].membershipEvidence, "x-roster");
  assert.equal(result.merged[0].protected, true);
});

test("weaker historical evidence cannot overwrite confirmed privacy state", () => {
  const result = mergeMemberLists(
    [{
      username: "Confirmed",
      user_id: "11",
      protected: false,
      membershipEvidence: "x-roster",
    }],
    [{
      username: "Confirmed",
      user_id: "11",
      protected: true,
      membershipEvidence: "historical-community-post",
    }]
  );
  assert.equal(result.merged[0].membershipEvidence, "x-roster");
  assert.equal(result.merged[0].protected, false);
});
