import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDiagnosticReport,
  redactDiagnosticText,
} from "../diagnostics.js";

test("diagnostic text removes secrets, URL queries, handles, and opaque values", () => {
  const opaque = "A".repeat(120);
  const text = redactDiagnosticText(
    `authorization=secret ct0:token https://x.com/path?cursor=secret @alice ${opaque}`
  );
  assert.doesNotMatch(text, /secret|token|cursor=|@alice|A{96}/);
  assert.match(text, /authorization=\[redacted\]/);
  assert.match(text, /ct0=\[redacted\]/);
  assert.match(text, /https:\/\/x\.com\/path/);
  assert.match(text, /@user/);
  assert.match(text, /\[opaque value removed\]/);
});

test("diagnostic report includes metadata but excludes member records", () => {
  const report = buildDiagnosticReport({
    manifest: { name: "Community Activity Lite", version: "5.0.0", manifest_version: 3 },
    userAgent: "Chrome test",
    language: "en",
    settings: {
      communityId: "123",
      lookbackDays: 2,
      inactivityRule: "zero-community-posts-or-replies",
      timelineBackfill: true,
      focusLock: true,
    },
    job: {
      communityId: "123",
      status: "complete",
      phase: "complete",
      roster: { complete: false, found: 76077, expected: 79295, reason: "seek-resume-segment-limit" },
      activity: { complete: true, backfillComplete: false, reason: "selected-window-covered" },
      results: [{ username: "inactive_person" }],
      privateAccounts: [{ username: "private_person" }],
      diagnostics: {
        count: 2,
        activitySearchVerification: { checked: 400, queued: 612, remaining: 212 },
        operations: {
          CommunitiesMembersAllQuery: { status: "ok", reason: null, checkedAt: 1700000000000 },
          CommunityTweetSearchModuleQuery: { status: "broken", reason: "http-400", checkedAt: 1700000001000 },
        },
        network: [
          { operation: "Roster", attempt: 1, status: 200, durationMs: 42, outcome: "response" },
          { operation: "Roster", attempt: 2, status: 429, durationMs: 84, outcome: "http-error" },
        ],
        rosterPages: Array.from({ length: 40 }, (_, index) => ({
          page: index + 1,
          total: (index + 1) * 20,
          added: 20,
          hasNextCursor: index < 39,
        })),
        timelineBackfill: {
          pages: 34,
          scannedPosts: 680,
          authors: 655,
          oldestPostAt: "2026-06-20T12:00:00.000Z",
          complete: false,
          reason: "in-progress",
        },
        mediaBackfill: {
          pages: 4,
          scannedPosts: 80,
          authors: 42,
          complete: true,
          reason: "timeline-ended",
        },
        searchBackfill: {
          authors: 19,
          complete: false,
          shardCount: 6,
          completedShards: 2,
          error: "cursor=@alice",
        },
        steps: [
          { name: "discover-community", durationMs: 120, ok: true },
          { name: "collect-native-roster", durationMs: 5000, ok: true },
        ],
      },
    },
    events: [{ time: "10:00", level: "info", message: "Saw @alice" }],
    tab: { active: true, frozen: false },
    page: { renderedMemberRows: 20, renderedNonRosterUserRows: 3 },
  });
  const serialized = JSON.stringify(report);
  assert.equal(report.scan.flaggedCount, 1);
  assert.equal(report.scan.privateCount, 1);
  assert.equal(report.scan.requestCount, 2);
  assert.equal(report.scan.activity.complete, true);
  assert.equal(report.settings.timelineBackfill, true);
  assert.equal(
    report.settings.inactivityRule,
    "zero-community-posts-or-replies"
  );
  assert.equal(report.diagnostics.timelineBackfill.pages, 34);
  assert.equal(report.diagnostics.timelineBackfill.authors, 655);
  assert.equal(report.diagnostics.mediaBackfill.complete, true);
  assert.equal(report.diagnostics.searchBackfill.shardCount, 6);
  assert.equal(report.diagnostics.searchBackfill.completedShards, 2);
  assert.doesNotMatch(report.diagnostics.searchBackfill.error, /@alice/);
  assert.equal(report.diagnostics.networkSummary[0].count, 2);
  assert.equal(report.diagnostics.networkSummary[0].retries, 1);
  assert.equal(report.diagnostics.rosterSummary.recordedPages, 40);
  assert.equal(report.diagnostics.rosterPages.length, 20);
  assert.equal(report.diagnostics.rosterPages.at(-1).hasNextCursor, false);
  assert.equal(report.page.renderedMemberRows, 20);
  assert.equal(report.page.renderedNonRosterUserRows, 3);
  assert.deepEqual(report.diagnostics.steps, [
    { name: "discover-community", durationMs: 120, ok: true, status: "complete" },
    { name: "collect-native-roster", durationMs: 5000, ok: true, status: "complete" },
  ]);
  assert.equal(report.diagnostics.operations.CommunitiesMembersAllQuery.status, "ok");
  assert.equal(report.diagnostics.operations.CommunityTweetSearchModuleQuery.status, "broken");
  assert.equal(report.diagnostics.operations.CommunityTweetSearchModuleQuery.reason, "http-400");
  assert.equal(report.scan.completeness.reviewable, true);
  assert.equal(report.scan.completeness.safeForAutomatedRemoval, true);
  assert.deepEqual(report.scan.completeness.caveats, ["roster-partial", "verification-remaining"]);
  assert.equal(report.scan.completeness.verification.remaining, 212);
  assert.doesNotMatch(serialized, /inactive_person|private_person|@alice/);
});

test("a step interrupted mid-run reports status: running, not indistinguishable from never having started", () => {
  const report = buildDiagnosticReport({
    manifest: { name: "Community Activity Lite", version: "5.0.0", manifest_version: 3 },
    userAgent: "Chrome test",
    language: "en",
    settings: { communityId: "123" },
    job: {
      communityId: "123",
      diagnostics: {
        count: 1,
        steps: [
          { name: "discover-community", durationMs: 120, ok: true, status: "complete" },
          { name: "collect-native-roster", durationMs: null, ok: null, status: "running" },
        ],
      },
    },
    events: [],
  });
  assert.deepEqual(report.diagnostics.steps, [
    { name: "discover-community", durationMs: 120, ok: true, status: "complete" },
    { name: "collect-native-roster", durationMs: null, ok: true, status: "running" },
  ]);
});
