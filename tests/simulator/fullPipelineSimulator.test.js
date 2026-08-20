// The capstone simulator test: chains the real, unmodified production
// functions - roster collection, activity discovery, pure classification,
// direct verification, and the completeness/actionability gate - in
// exactly the sequence sidepanel.js's finalizeResultsAndSave/
// verifySearchActivityForFlagged chain them (see that file for the
// original), against one shared fake X. sidepanel.js itself can't be
// imported into a Node test (it manipulates DOM elements directly), so this
// reproduces its call sequence using the same exported, real functions
// rather than reimplementing what any of them decide.
//
// Every final member state is declared up front and asserted exactly - not
// "most members end up right," the literal claim the completion plan's
// full-pipeline test asks for.

import test from "node:test";
import assert from "node:assert/strict";
import { fetchCommunityMembersByCursor } from "../../src/roster/collectRoster.js";
import { fetchActiveAuthors } from "../../src/activity/timelineCollector.js";
import {
  annotateMemberActivity,
  classifyFlaggedMember,
  classifySearchVerification,
} from "../../src/activity/classification.js";
import {
  activitySearchCandidateIdentity,
  verifyMemberActivityViaSearch,
} from "../../src/activity/directVerification.js";
import { summarizeScanCompleteness, determineActionability } from "../../src/core/scanCompleteness.js";
import { calendarActivityWindow } from "../../src/core/time.js";
import { AdaptiveRateLimiter } from "../../src/api/rateLimiter.js";
import { NATIVE_MEMBERS_ALL_OPERATION, DOCUMENT_IDS } from "../../src/api/operations.js";
import { createFakeXRosterServer, installFakeXEnvironment, composeFakeXServers } from "./fakeXServer.js";
import { createFakeXActivityServer } from "./fakeXActivityServer.js";
import { createFakeXVerificationServer } from "./fakeXVerificationServer.js";

const noopSleep = async () => {};
function noInjectedDelay() {
  return { limiter: new AdaptiveRateLimiter(750, noopSleep), delayFn: noopSleep };
}

test("full pipeline: roster -> activity -> classification -> direct verification -> completeness produces exactly the declared final member states", async () => {
  const LOOKBACK_DAYS = 30;
  const { sinceDate, untilDate } = calendarActivityWindow(LOOKBACK_DAYS);
  const inWindowMs = untilDate.getTime() - 60 * 60 * 1000;
  const beforeWindowMs = sinceDate.getTime() - 60 * 60 * 1000;

  // 30 roster members. 1-20 post within the window (active, never flagged).
  // 21-30 have zero timeline activity, so they get flagged; 29-30 are
  // protected, the rest public.
  const rosterMembers = Array.from({ length: 30 }, (_, i) => {
    const n = i + 1;
    return { userId: String(n), username: `member${n}`, joinTimeMs: Date.UTC(2025, 0, 1) + n * 60000, protected: n >= 29 };
  });

  const rosterServer = createFakeXRosterServer({
    members: rosterMembers,
    pageSize: 100,
    chainPageCap: 500,
    documentId: NATIVE_MEMBERS_ALL_OPERATION.documentId,
    operation: NATIVE_MEMBERS_ALL_OPERATION.operation,
  });
  const activeTweets = Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    return { tweetId: `p${n}`, authorUserId: String(n), authorUsername: `member${n}`, createdAtMs: inWindowMs - n * 1000, kind: "post" };
  });
  const activityServer = createFakeXActivityServer({
    tweets: activeTweets,
    pageSize: 20,
    kind: "activity",
    documentId: DOCUMENT_IDS.CommunityTweetsTimeline,
    operation: "CommunityTweetsTimeline",
  });

  // Direct search evidence for the 10 flagged candidates (21-30): 21 and 22
  // actually posted (the broad crawl above simply never covers them - a
  // realistic gap this verification step exists to close); 23-28 are
  // genuinely silent public accounts; 29-30 are protected, so their empty
  // result can never be told apart from genuine silence.
  const verificationServer = createFakeXVerificationServer({
    documentId: DOCUMENT_IDS.CommunityTweetSearchModuleQuery,
    operation: "CommunityTweetSearchModuleQuery",
    postsByUsername: {
      member21: [{ tweetId: "v21", authorUserId: "21", authorUsername: "member21", createdAtMs: inWindowMs, kind: "post" }],
      member22: [{ tweetId: "v22", authorUserId: "22", authorUsername: "member22", createdAtMs: inWindowMs, kind: "reply" }],
      // member23..30 intentionally absent: a genuine zero-result search.
    },
  });

  const server = composeFakeXServers(rosterServer, activityServer, verificationServer);
  const env = installFakeXEnvironment(server);
  try {
    const rosterResult = await fetchCommunityMembersByCursor("1234567890", NATIVE_MEMBERS_ALL_OPERATION, {
      expectedCount: rosterMembers.length,
      checkpointScope: "pipeline-sim",
      maxPages: 200,
      ...noInjectedDelay(),
    });
    assert.equal(rosterResult.complete, true);
    assert.equal(rosterResult.members.length, 30);

    const activity = await fetchActiveAuthors("1234567890", sinceDate, untilDate, {
      checkpointScope: "pipeline-sim-activity",
      maxPagesPerRun: 200,
      ...noInjectedDelay(),
    });
    assert.equal(activity.activityWindowComplete, true);

    // Exactly sidepanel.js's finalizeResultsAndSave: annotate every roster
    // member with its activity, then flag whoever has zero.
    const analyzedMembers = rosterResult.members.map((member) => annotateMemberActivity(member, activity));
    let currentResults = analyzedMembers
      .filter((member) => member.postsInWindow === 0)
      .map((member) => classifyFlaggedMember(member, LOOKBACK_DAYS));
    assert.equal(currentResults.length, 10);

    // Exactly sidepanel.js's verifySearchActivityForFlagged.
    const verification = await verifyMemberActivityViaSearch("1234567890", currentResults, {
      sinceDate,
      maxCandidatesPerRun: 400,
      ...noInjectedDelay(),
    });
    let cleared = 0;
    currentResults = currentResults.reduce((kept, member) => {
      const result = verification.results.get(activitySearchCandidateIdentity(member));
      const classified = classifySearchVerification(member, result);
      if (classified.cleared) {
        cleared++;
        return kept;
      }
      kept.push({ ...member, activityVerification: classified.activityVerification });
      return kept;
    }, []);

    assert.equal(cleared, 2, "member21 and member22 must be cleared by direct search");
    assert.equal(currentResults.length, 8);

    const byUsername = Object.fromEntries(currentResults.map((row) => [row.username, row.activityVerification]));
    const expected = {
      member23: "confirmed-inactive",
      member24: "confirmed-inactive",
      member25: "confirmed-inactive",
      member26: "confirmed-inactive",
      member27: "confirmed-inactive",
      member28: "confirmed-inactive",
      member29: "unverifiable-protected",
      member30: "unverifiable-protected",
    };
    assert.deepEqual(byUsername, expected);

    // member1-20 (active) must never appear in the final flagged list at all.
    for (let n = 1; n <= 20; n++) assert.ok(!(`member${n}` in byUsername));
    // member21/22 (cleared) must not appear either - cleared means removed,
    // not relabeled.
    assert.ok(!("member21" in byUsername) && !("member22" in byUsername));

    const completeness = summarizeScanCompleteness({
      roster: { complete: rosterResult.complete, found: rosterResult.members.length, expected: rosterMembers.length },
      activity: { complete: activity.activityWindowComplete },
      verification: { checked: verification.checked, queued: verification.queued, remaining: verification.remaining },
    });
    const actionability = determineActionability(completeness);
    assert.deepEqual(actionability, { reviewable: true, safeForAutomatedRemoval: true, reason: null });
    assert.deepEqual(completeness.caveats, []);
  } finally {
    env.restore();
  }
});
