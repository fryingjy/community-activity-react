import test from "node:test";
import assert from "node:assert/strict";
import {
  determineActionability,
  summarizeScanCompleteness,
} from "../src/core/scanCompleteness.js";

test("summarizeScanCompleteness reports a fully clean scan with no caveats", () => {
  const summary = summarizeScanCompleteness({
    roster: { complete: true, found: 79295, expected: 79295, reason: "server-cursor-end" },
    activity: { complete: true, reason: "selected-window-covered" },
    verification: { checked: 1842, queued: 1842, remaining: 0 },
  });
  assert.equal(summary.roster.complete, true);
  assert.equal(summary.activity.complete, true);
  assert.equal(summary.verification.remaining, 0);
  assert.deepEqual(summary.caveats, []);
});

test("summarizeScanCompleteness flags a partial roster as a caveat without making the scan unreviewable", () => {
  const summary = summarizeScanCompleteness({
    roster: { complete: false, found: 76077, expected: 79295, reason: "seek-resume-segment-limit" },
    activity: { complete: true, reason: "selected-window-covered" },
    verification: { checked: 400, queued: 612, remaining: 212 },
  });
  assert.deepEqual(summary.caveats, ["roster-partial", "verification-remaining"]);
  // A partial roster means some members were never discovered at all, not
  // that the members already flagged were wrongly flagged - both gates stay
  // open, just with caveats a reviewer needs to see.
  assert.deepEqual(determineActionability(summary), { reviewable: true, safeForAutomatedRemoval: true, reason: null });
});

test("summarizeScanCompleteness reports an unrun verification queue distinctly from an empty one", () => {
  const summary = summarizeScanCompleteness({
    roster: { complete: true, found: 100, expected: 100 },
    activity: { complete: false, reason: "activity-window-incomplete" },
    verification: null,
  });
  assert.equal(summary.verification.ran, false);
});

test("determineActionability blocks both review and automated removal on an incomplete activity window, regardless of roster/verification state", () => {
  const summary = summarizeScanCompleteness({
    roster: { complete: true, found: 100, expected: 100 },
    activity: { complete: false },
    verification: { checked: 5, queued: 5, remaining: 0 },
  });
  assert.deepEqual(determineActionability(summary), {
    reviewable: false,
    safeForAutomatedRemoval: false,
    reason: "activity-window-incomplete",
  });
});

test("determineActionability allows a complete activity window even with a partial roster", () => {
  const summary = summarizeScanCompleteness({
    roster: { complete: false, found: 76077, expected: 79295 },
    activity: { complete: true },
    verification: { checked: 400, queued: 612, remaining: 212 },
  });
  assert.deepEqual(determineActionability(summary), {
    reviewable: true,
    safeForAutomatedRemoval: true,
    reason: null,
  });
});
