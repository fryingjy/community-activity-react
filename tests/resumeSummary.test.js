import test from "node:test";
import assert from "node:assert/strict";
import {
  SCAN_STEP_ORDER,
  describeResumeStages,
  summarizeResumableJob,
} from "../src/core/resumeSummary.js";

test("describeResumeStages marks a never-recorded step pending, not failed or complete", () => {
  const stages = describeResumeStages({ diagnostics: { steps: [] } });
  assert.equal(stages.length, SCAN_STEP_ORDER.length);
  for (const stage of stages) assert.equal(stage.status, "pending");
});

test("describeResumeStages reflects complete, running, and pending stages in the real recorded order", () => {
  const job = {
    diagnostics: {
      steps: [
        { name: "discover-community", status: "complete" },
        { name: "collect-native-roster", status: "running" },
      ],
    },
  };
  const stages = describeResumeStages(job);
  const byName = Object.fromEntries(stages.map((stage) => [stage.name, stage.status]));
  assert.equal(byName["discover-community"], "complete");
  assert.equal(byName["collect-native-roster"], "running");
  assert.equal(byName["collect-cursor-roster"], "pending");
  // Order must match SCAN_STEPS' real execution order, not recording order.
  assert.deepEqual(stages.map((stage) => stage.name), [...SCAN_STEP_ORDER]);
});

test("describeResumeStages infers complete/failed for a step recorded before the status field existed", () => {
  const job = { diagnostics: { steps: [{ name: "discover-community", ok: false }] } };
  const stages = describeResumeStages(job);
  assert.equal(stages.find((stage) => stage.name === "discover-community").status, "failed");
});

test("summarizeResumableJob extracts roster/activity/verification progress with safe defaults", () => {
  const summary = summarizeResumableJob({
    communityId: "999",
    status: "stopped",
    updatedAt: 1700000000000,
    roster: { found: 5000, expected: 79295, complete: false },
    activity: { complete: true },
    diagnostics: {
      activitySearchVerification: { checked: 300, queued: 612 },
      steps: [{ name: "discover-community", status: "complete" }],
    },
  });
  assert.equal(summary.communityId, "999");
  assert.equal(summary.status, "stopped");
  assert.equal(summary.rosterFound, 5000);
  assert.equal(summary.rosterExpected, 79295);
  assert.equal(summary.rosterComplete, false);
  assert.equal(summary.activityComplete, true);
  assert.equal(summary.verificationChecked, 300);
  assert.equal(summary.verificationQueued, 612);
  assert.equal(summary.stages.length, SCAN_STEP_ORDER.length);
});

test("describeResumeStages attaches a resumePolicy to every stage, one of the two real, checked classifications", () => {
  const stages = describeResumeStages({ diagnostics: { steps: [] } });
  for (const stage of stages) {
    assert.ok(
      ["checkpoint-resumable", "idempotent-rerun"].includes(stage.resumePolicy),
      `unexpected resumePolicy for ${stage.name}: ${stage.resumePolicy}`
    );
  }
  // The stages whose expensive work is itself backed by a chrome.storage
  // checkpoint one layer down (roster cursor pages, activity's stored
  // cursor, the timeline/media/search backfill checkpoints, membership/
  // direct-search verification's own caches) - see interruptionSimulator.test.js
  // for a real, running proof at that checkpoint layer.
  const byName = Object.fromEntries(stages.map((stage) => [stage.name, stage.resumePolicy]));
  assert.equal(byName["collect-native-roster"], "checkpoint-resumable");
  assert.equal(byName["collect-cursor-roster"], "checkpoint-resumable");
  assert.equal(byName["analyze-recent-activity"], "checkpoint-resumable");
  assert.equal(byName["archive-timeline-media-search"], "checkpoint-resumable");
  assert.equal(byName["merge-and-verify-authors"], "checkpoint-resumable");
  // The stages with no checkpoint of their own, safe to redo because they
  // only ever overwrite derived state rather than accumulate onto it.
  assert.equal(byName["discover-community"], "idempotent-rerun");
  assert.equal(byName["collect-dom-fallback"], "idempotent-rerun");
  assert.equal(byName["finalize-roster"], "idempotent-rerun");
  assert.equal(byName["finalize-results"], "idempotent-rerun");
});

test("summarizeResumableJob is safe against a missing or malformed job", () => {
  const summary = summarizeResumableJob(null);
  assert.equal(summary.communityId, "");
  assert.equal(summary.status, "unknown");
  assert.equal(summary.rosterFound, 0);
  assert.equal(summary.rosterExpected, null);
  assert.equal(summary.verificationChecked, null);
});
