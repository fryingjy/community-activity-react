// Proves the "checkpoint-resumable" claim SCAN_STEPS makes for four real
// collectors, not just asserts it: interrupts each mid-walk (an AbortController
// fired from inside the fake server, at an exact request count, standing in
// for "the browser closed right here"), reconstructs by calling the same
// function again with a fresh signal against the *same* fake chrome.storage
// (simulating chrome.storage.local surviving a real restart), and asserts
// the resumed result is identical to an uninterrupted baseline run - not
// "close enough." Also checks the interrupted-then-resumed pair's total
// request count against the baseline, so a checkpoint that silently
// discards progress and starts over would show up as a large, visible
// overshoot instead of just failing quietly on output alone.

import test from "node:test";
import assert from "node:assert/strict";
import { fetchCommunityMembersByCursor } from "../../src/roster/collectRoster.js";
import { fetchActiveAuthors } from "../../src/activity/timelineCollector.js";
import { verifyMemberActivityViaSearch } from "../../src/activity/directVerification.js";
import { verifyKnownCommunityMembers } from "../../src/roster/membershipVerification.js";
import {
  annotateMemberActivity,
  classifyFlaggedMember,
  classifySearchVerification,
} from "../../src/activity/classification.js";
import { activitySearchCandidateIdentity } from "../../src/activity/directVerification.js";
import { calendarActivityWindow } from "../../src/core/time.js";
import { AdaptiveRateLimiter } from "../../src/api/rateLimiter.js";
import { NATIVE_MEMBERS_ALL_OPERATION, DOCUMENT_IDS } from "../../src/api/operations.js";
import { MEMBER_RELATIONSHIP_OPERATION } from "../../src/api/operations.js";
import { createFakeXRosterServer, installFakeXEnvironment, composeFakeXServers } from "./fakeXServer.js";
import { createFakeXActivityServer } from "./fakeXActivityServer.js";
import { createFakeXVerificationServer } from "./fakeXVerificationServer.js";

const noopSleep = async () => {};
function noInjectedDelay() {
  return { limiter: new AdaptiveRateLimiter(750, noopSleep), delayFn: noopSleep };
}

function createFakeMembershipVerificationServer({ onRequest }) {
  let requestCount = 0;
  return {
    respond(url) {
      const parsed = new URL(url);
      const [, , , , documentId, operation] = parsed.pathname.split("/");
      if (documentId !== MEMBER_RELATIONSHIP_OPERATION.documentId || operation !== MEMBER_RELATIONSHIP_OPERATION.operation) {
        return { status: 404, statusText: "Not Found", body: null };
      }
      requestCount++;
      onRequest?.(requestCount);
      const { prefix } = JSON.parse(parsed.searchParams.get("variables") || "{}");
      return {
        status: 200,
        statusText: "OK",
        headers: { "x-rate-limit-limit": "500", "x-rate-limit-remaining": "499", "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 900) },
        body: {
          data: {
            member_relationship_typeahead: [{
              role: "Member",
              user: {
                __typename: "User",
                rest_id: `id-${prefix}`,
                legacy: { screen_name: prefix, name: prefix, protected: false },
              },
            }],
          },
        },
      };
    },
    get requestCount() {
      return requestCount;
    },
  };
}

function generateRosterMembers(total, tiedBlockSize, spanMs, start) {
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

test("roster collection interrupted mid-walk resumes to the exact same final result as an uninterrupted run", async () => {
  const TOTAL = 900;
  const servable = generateRosterMembers(TOTAL, 100, 200 * 24 * 60 * 60 * 1000, Date.UTC(2025, 0, 23));
  const rosterOptions = {
    members: servable, pageSize: 30, chainPageCap: 6,
    documentId: NATIVE_MEMBERS_ALL_OPERATION.documentId, operation: NATIVE_MEMBERS_ALL_OPERATION.operation,
  };

  const baselineServer = createFakeXRosterServer(rosterOptions);
  const baselineEnv = installFakeXEnvironment(baselineServer);
  const baseline = await fetchCommunityMembersByCursor("1111111111", NATIVE_MEMBERS_ALL_OPERATION, {
    expectedCount: TOTAL, seekResume: true, checkpointScope: "interrupt-roster-baseline", maxPages: 2000, ...noInjectedDelay(),
  });
  baselineEnv.restore();

  const controller = new AbortController();
  const server = createFakeXRosterServer({ ...rosterOptions, onRequest: (n) => { if (n === 5) controller.abort(); } });
  const env = installFakeXEnvironment(server);
  try {
    await assert.rejects(
      fetchCommunityMembersByCursor("1111111111", NATIVE_MEMBERS_ALL_OPERATION, {
        expectedCount: TOTAL, seekResume: true, checkpointScope: "interrupt-roster-resumed",
        maxPages: 2000, signal: controller.signal, ...noInjectedDelay(),
      }),
      (error) => error.name === "StoppedError"
    );
    const requestsAtInterruption = server.requestCount;
    assert.equal(requestsAtInterruption, 5);

    // "Chrome restarted": a fresh signal, the same checkpointScope, and the
    // same fake chrome.storage (env.storage was never reset).
    const resumed = await fetchCommunityMembersByCursor("1111111111", NATIVE_MEMBERS_ALL_OPERATION, {
      expectedCount: TOTAL, seekResume: true, checkpointScope: "interrupt-roster-resumed",
      maxPages: 2000, ...noInjectedDelay(),
    });

    assert.equal(resumed.complete, true);
    const baselineIds = new Set(baseline.members.map((m) => m.user_id));
    const resumedIds = new Set(resumed.members.map((m) => m.user_id));
    assert.deepEqual([...resumedIds].sort(), [...baselineIds].sort());

    // A checkpoint that silently discarded progress and started over would
    // show up here as a large overshoot, not just a subtly wrong number.
    assert.ok(
      server.requestCount <= baselineServer.requestCount + 3,
      `interrupted+resumed used ${server.requestCount} requests vs baseline's ${baselineServer.requestCount} - checkpoint likely did not survive`
    );
  } finally {
    env.restore();
  }
});

test("activity collection interrupted mid-walk resumes to the exact same final result as an uninterrupted run", async () => {
  const untilMs = Date.UTC(2026, 6, 30, 12, 0, 0);
  const sinceMs = untilMs - 30 * 24 * 60 * 60 * 1000;
  const tweets = [];
  for (let i = 0; i < 400; i++) {
    tweets.push({
      tweetId: `t${i}`, authorUserId: `u${i % 100}`, authorUsername: `author_${i % 100}`,
      createdAtMs: untilMs - i * 45000, kind: i % 4 === 0 ? "reply" : "post",
    });
  }
  const activityOptions = { tweets, pageSize: 20, documentId: DOCUMENT_IDS.CommunityTweetsTimeline, operation: "CommunityTweetsTimeline" };

  const baselineServer = createFakeXActivityServer(activityOptions);
  const baselineEnv = installFakeXEnvironment(baselineServer);
  const baseline = await fetchActiveAuthors("2222222222", new Date(sinceMs), new Date(untilMs), {
    maxPagesPerRun: 2000, ...noInjectedDelay(),
  });
  baselineEnv.restore();

  const controller = new AbortController();
  const server = createFakeXActivityServer({ ...activityOptions, onRequest: (n) => { if (n === 4) controller.abort(); } });
  const env = installFakeXEnvironment(server);
  try {
    await assert.rejects(
      fetchActiveAuthors("2222222222", new Date(sinceMs), new Date(untilMs), {
        maxPagesPerRun: 2000, signal: controller.signal, ...noInjectedDelay(),
      }),
      (error) => error.name === "StoppedError"
    );
    assert.equal(server.requestCount, 4);

    const resumed = await fetchActiveAuthors("2222222222", new Date(sinceMs), new Date(untilMs), {
      maxPagesPerRun: 2000, ...noInjectedDelay(),
    });

    assert.equal(resumed.activityWindowComplete, true);
    const baselineIds = new Set(baseline.toJSON().map((a) => a.user_id));
    const resumedIds = new Set(resumed.toJSON().map((a) => a.user_id));
    assert.deepEqual([...resumedIds].sort(), [...baselineIds].sort());
    assert.ok(
      server.requestCount <= baselineServer.requestCount + 3,
      `interrupted+resumed used ${server.requestCount} requests vs baseline's ${baselineServer.requestCount}`
    );
  } finally {
    env.restore();
  }
});

test("direct verification interrupted mid-run resumes at the correct queue offset, never re-checking or skipping a candidate", async () => {
  const candidates = Array.from({ length: 12 }, (_, i) => ({ username: `vuser${i}`, user_id: String(300 + i) }));
  const verificationOptions = {
    documentId: DOCUMENT_IDS.CommunityTweetSearchModuleQuery, operation: "CommunityTweetSearchModuleQuery",
    postsByUsername: { vuser2: [{ tweetId: "v2", authorUserId: "302", authorUsername: "vuser2", createdAtMs: Date.now(), kind: "post" }] },
  };
  const sinceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const baselineServer = createFakeXVerificationServer(verificationOptions);
  const baselineEnv = installFakeXEnvironment(baselineServer);
  const baseline = await verifyMemberActivityViaSearch("3333333333", candidates, { sinceDate, ...noInjectedDelay() });
  baselineEnv.restore();

  const controller = new AbortController();
  const server = createFakeXVerificationServer({ ...verificationOptions, onRequest: (n) => { if (n === 5) controller.abort(); } });
  const env = installFakeXEnvironment(server);
  try {
    await assert.rejects(
      verifyMemberActivityViaSearch("3333333333", candidates, { sinceDate, signal: controller.signal, ...noInjectedDelay() }),
      (error) => error.name === "StoppedError"
    );
    assert.equal(server.requestCount, 5);

    const resumed = await verifyMemberActivityViaSearch("3333333333", candidates, { sinceDate, ...noInjectedDelay() });

    assert.equal(resumed.remaining, 0);
    for (const candidate of candidates) {
      const baselineEntry = baseline.results.get(activitySearchCandidateIdentity(candidate));
      const resumedEntry = resumed.results.get(activitySearchCandidateIdentity(candidate));
      assert.equal(resumedEntry.hasActivityInWindow, baselineEntry.hasActivityInWindow, `mismatch for ${candidate.username}`);
    }
    // Exactly 12 requests total across both calls (5 before the abort, 7
    // after) - not fewer (a skipped candidate) and not more (a re-checked
    // one), proving the resume picked up at exactly the right offset.
    assert.equal(server.requestCount, 12);
  } finally {
    env.restore();
  }
});

test("membership verification interrupted mid-run resumes without repeating completed checks", async () => {
  const candidates = Array.from({ length: 12 }, (_, index) => ({
    username: `member${index}`,
    user_id: `id-member${index}`,
  }));
  const baselineServer = createFakeMembershipVerificationServer({});
  const baselineEnv = installFakeXEnvironment(baselineServer);
  const baseline = await verifyKnownCommunityMembers("5555555555", candidates, noInjectedDelay());
  baselineEnv.restore();

  const controller = new AbortController();
  const server = createFakeMembershipVerificationServer({
    onRequest: (requestNumber) => { if (requestNumber === 5) controller.abort(); },
  });
  const env = installFakeXEnvironment(server);
  try {
    await assert.rejects(
      verifyKnownCommunityMembers("5555555555", candidates, {
        signal: controller.signal,
        ...noInjectedDelay(),
      }),
      (error) => error.name === "StoppedError"
    );
    assert.equal(server.requestCount, 5);

    const resumed = await verifyKnownCommunityMembers("5555555555", candidates, noInjectedDelay());
    assert.equal(resumed.members.length, baseline.members.length);
    assert.equal(resumed.remaining, 0);
    assert.equal(server.requestCount, 12);
  } finally {
    env.restore();
  }
});

test("membership verification uses the observed relationship-operation quota instead of its static fallback", async () => {
  const candidates = Array.from({ length: 10 }, (_, index) => ({
    username: `quotaMember${index}`,
    user_id: `id-quotaMember${index}`,
  }));
  const server = createFakeMembershipVerificationServer({});
  const env = installFakeXEnvironment(server);
  try {
    const result = await verifyKnownCommunityMembers("6666666666", candidates, {
      requestStats: {
        quotas: {
          [MEMBER_RELATIONSHIP_OPERATION.operation]: { remaining: 30, limit: 500, resetAt: null },
        },
      },
      ...noInjectedDelay(),
    });
    assert.equal(result.checked, 5);
    assert.equal(result.scheduled, 5);
    assert.equal(result.remaining, 5);
    assert.equal(result.reason, "quota-budget");
    assert.equal(result.quota.usable, 5);
    assert.equal(server.requestCount, 5);
  } finally {
    env.restore();
  }
});

test("a full pipeline interrupted during roster collection, then fully resumed, produces the same final classified member states as an uninterrupted run", async () => {
  const LOOKBACK_DAYS = 30;
  const { sinceDate, untilDate } = calendarActivityWindow(LOOKBACK_DAYS);
  const inWindowMs = untilDate.getTime() - 60 * 60 * 1000;

  const rosterMembers = Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    return { userId: String(n), username: `pmember${n}`, joinTimeMs: Date.UTC(2025, 0, 1) + n * 60000, protected: false };
  });
  const activeTweets = Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    return { tweetId: `pp${n}`, authorUserId: String(n), authorUsername: `pmember${n}`, createdAtMs: inWindowMs - n * 1000, kind: "post" };
  });
  const verificationPosts = { pmember13: [{ tweetId: "pv13", authorUserId: "13", authorUsername: "pmember13", createdAtMs: inWindowMs, kind: "post" }] };

  async function runFullPipeline({ checkpointScope, rosterSignal }) {
    // pageSize 5 against 20 members forces 4 real pages - a pipeline test's
    // job is proving stage assembly, not roster's own stress cases (already
    // covered in rosterSimulator.test.js), but it still needs *some* real
    // page boundary for a mid-walk interruption to land on.
    const rosterServer = createFakeXRosterServer({
      members: rosterMembers, pageSize: 5, chainPageCap: 500,
      documentId: NATIVE_MEMBERS_ALL_OPERATION.documentId, operation: NATIVE_MEMBERS_ALL_OPERATION.operation,
    });
    const activityServer = createFakeXActivityServer({
      tweets: activeTweets, pageSize: 20, kind: "activity",
      documentId: DOCUMENT_IDS.CommunityTweetsTimeline, operation: "CommunityTweetsTimeline",
    });
    const verificationServer = createFakeXVerificationServer({
      documentId: DOCUMENT_IDS.CommunityTweetSearchModuleQuery, operation: "CommunityTweetSearchModuleQuery",
      postsByUsername: verificationPosts,
    });
    const server = composeFakeXServers(rosterServer, activityServer, verificationServer);
    const env = installFakeXEnvironment(server);
    try {
      const rosterResult = await fetchCommunityMembersByCursor("4444444444", NATIVE_MEMBERS_ALL_OPERATION, {
        expectedCount: rosterMembers.length, checkpointScope, maxPages: 200, signal: rosterSignal, ...noInjectedDelay(),
      });
      const activity = await fetchActiveAuthors("4444444444", sinceDate, untilDate, { maxPagesPerRun: 200, ...noInjectedDelay() });
      const analyzedMembers = rosterResult.members.map((member) => annotateMemberActivity(member, activity));
      let currentResults = analyzedMembers
        .filter((member) => member.postsInWindow === 0)
        .map((member) => classifyFlaggedMember(member, LOOKBACK_DAYS));
      const verification = await verifyMemberActivityViaSearch("4444444444", currentResults, { sinceDate, ...noInjectedDelay() });
      currentResults = currentResults.reduce((kept, member) => {
        const result = verification.results.get(activitySearchCandidateIdentity(member));
        const classified = classifySearchVerification(member, result);
        if (classified.cleared) return kept;
        kept.push({ ...member, activityVerification: classified.activityVerification });
        return kept;
      }, []);
      return { currentResults, requestCount: server.requestCount, env };
    } finally {
      env.restore();
    }
  }

  const baseline = await runFullPipeline({ checkpointScope: "interrupt-pipeline-baseline" });

  // Interrupt specifically during roster (request 3 of the native roster
  // chain), reconstruct with a fresh signal but the same checkpointScope -
  // exactly "chrome restarted mid roster collection."
  const controller = new AbortController();
  const interruptingRosterServer = createFakeXRosterServer({
    members: rosterMembers, pageSize: 5, chainPageCap: 500,
    documentId: NATIVE_MEMBERS_ALL_OPERATION.documentId, operation: NATIVE_MEMBERS_ALL_OPERATION.operation,
    onRequest: (n) => { if (n === 2) controller.abort(); },
  });
  const interruptingActivityServer = createFakeXActivityServer({
    tweets: activeTweets, pageSize: 20, kind: "activity",
    documentId: DOCUMENT_IDS.CommunityTweetsTimeline, operation: "CommunityTweetsTimeline",
  });
  const interruptingVerificationServer = createFakeXVerificationServer({
    documentId: DOCUMENT_IDS.CommunityTweetSearchModuleQuery, operation: "CommunityTweetSearchModuleQuery",
    postsByUsername: verificationPosts,
  });
  const interruptedComposed = composeFakeXServers(interruptingRosterServer, interruptingActivityServer, interruptingVerificationServer);
  const interruptedEnv = installFakeXEnvironment(interruptedComposed);
  try {
    await assert.rejects(
      fetchCommunityMembersByCursor("4444444444", NATIVE_MEMBERS_ALL_OPERATION, {
        expectedCount: rosterMembers.length, checkpointScope: "interrupt-pipeline-resumed",
        maxPages: 200, signal: controller.signal, ...noInjectedDelay(),
      }),
      (error) => error.name === "StoppedError"
    );

    // "Chrome restarted": run the whole pipeline again from the top with a
    // fresh signal, same checkpointScope, same fake chrome.storage - roster
    // resumes from its checkpoint, everything downstream runs normally.
    const rosterResult = await fetchCommunityMembersByCursor("4444444444", NATIVE_MEMBERS_ALL_OPERATION, {
      expectedCount: rosterMembers.length, checkpointScope: "interrupt-pipeline-resumed", maxPages: 200, ...noInjectedDelay(),
    });
    const activity = await fetchActiveAuthors("4444444444", sinceDate, untilDate, { maxPagesPerRun: 200, ...noInjectedDelay() });
    const analyzedMembers = rosterResult.members.map((member) => annotateMemberActivity(member, activity));
    let currentResults = analyzedMembers
      .filter((member) => member.postsInWindow === 0)
      .map((member) => classifyFlaggedMember(member, LOOKBACK_DAYS));
    const verification = await verifyMemberActivityViaSearch("4444444444", currentResults, { sinceDate, ...noInjectedDelay() });
    currentResults = currentResults.reduce((kept, member) => {
      const result = verification.results.get(activitySearchCandidateIdentity(member));
      const classified = classifySearchVerification(member, result);
      if (classified.cleared) return kept;
      kept.push({ ...member, activityVerification: classified.activityVerification });
      return kept;
    }, []);

    const baselineByUsername = Object.fromEntries(baseline.currentResults.map((row) => [row.username, row.activityVerification]));
    const resumedByUsername = Object.fromEntries(currentResults.map((row) => [row.username, row.activityVerification]));
    assert.deepEqual(resumedByUsername, baselineByUsername);
  } finally {
    interruptedEnv.restore();
  }
});
