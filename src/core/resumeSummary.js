// Turns a saved scan job into the plain data a resume prompt needs to
// render - kept separate from sidepanel.js's DOM code so the "what does an
// incomplete scan actually look like" question has a pure, testable answer,
// the same reason every other classification/completeness function in this
// project lives outside the UI layer.

// Mirrors sidepanel.js's SCAN_STEPS list and order exactly - duplicated
// rather than imported because SCAN_STEPS itself carries live function
// references (the step runners), which don't belong in a pure module.
const STEP_LABELS = Object.freeze({
  "discover-community": "Discover Community",
  "collect-native-roster": "Collect roster (native)",
  "collect-cursor-roster": "Collect roster (cursor)",
  "collect-dom-fallback": "Roster DOM fallback",
  "finalize-roster": "Finalize roster",
  "analyze-recent-activity": "Analyze recent activity",
  "archive-timeline-media-search": "Archive timeline/media/search",
  "merge-and-verify-authors": "Merge & verify authors",
  "finalize-results": "Finalize results",
});

export const SCAN_STEP_ORDER = Object.freeze(Object.keys(STEP_LABELS));

// Mirrors SCAN_STEPS' resumePolicy field exactly - see that file's comment
// for what each value actually claims and why. Duplicated for the same
// reason STEP_LABELS is: SCAN_STEPS carries live function references that
// don't belong in a pure module.
const STEP_RESUME_POLICIES = Object.freeze({
  "discover-community": "idempotent-rerun",
  "collect-native-roster": "checkpoint-resumable",
  "collect-cursor-roster": "checkpoint-resumable",
  "collect-dom-fallback": "idempotent-rerun",
  "finalize-roster": "idempotent-rerun",
  "analyze-recent-activity": "checkpoint-resumable",
  "archive-timeline-media-search": "checkpoint-resumable",
  "merge-and-verify-authors": "checkpoint-resumable",
  "finalize-results": "idempotent-rerun",
});

// A step this job's diagnostics never recorded at all is "pending" - never
// reached, not failed and not running. A step recorded before the
// running/complete/failed status field existed infers from its old ok
// field, matching diagnostics.js's own inference for the same reason.
export function describeResumeStages(job) {
  const recorded = new Map((job?.diagnostics?.steps || []).map((step) => [step?.name, step]));
  return SCAN_STEP_ORDER.map((name) => {
    const entry = recorded.get(name);
    let status = "pending";
    if (entry) {
      status = ["running", "complete", "failed"].includes(entry.status)
        ? entry.status
        : entry.ok === false ? "failed" : "complete";
    }
    return { name, label: STEP_LABELS[name], status, resumePolicy: STEP_RESUME_POLICIES[name] };
  });
}

export function summarizeResumableJob(job) {
  return {
    communityId: job?.communityId || "",
    status: job?.status || "unknown",
    updatedAt: Number.isFinite(job?.updatedAt) ? job.updatedAt : null,
    rosterFound: Number.isFinite(job?.roster?.found) ? job.roster.found : 0,
    rosterExpected: Number.isFinite(job?.roster?.expected) ? job.roster.expected : null,
    rosterComplete: job?.roster?.complete === true,
    activityComplete: job?.activity?.complete === true,
    verificationChecked: Number.isFinite(job?.diagnostics?.activitySearchVerification?.checked)
      ? job.diagnostics.activitySearchVerification.checked
      : null,
    verificationQueued: Number.isFinite(job?.diagnostics?.activitySearchVerification?.queued)
      ? job.diagnostics.activitySearchVerification.queued
      : null,
    stages: describeResumeStages(job),
  };
}
