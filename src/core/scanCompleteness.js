// Whether a scan's output can be trusted used to be answered by re-deriving
// it independently in three places: two export-button `.disabled` checks and
// a hand-built results summary sentence, each reading `currentRosterState`/
// `currentActivityState`/the verification diagnostics slightly differently.
// This module makes it one canonical, pure computation instead, and gives
// the sanitized diagnostics export a single "can this output be trusted"
// answer rather than requiring a reader to reconstruct it from scattered
// booleans.
//
// This intentionally does NOT block exporting a partial-roster or
// partial-verification result — that's a deliberate product decision (a
// large Community may never reach 100% roster coverage in one run, and
// blocking the export entirely would defeat the point of seek-resume). What
// it does do is make the exact conditions that already gate the confirmed
// export explicit and testable, and surface the caveats a reviewer needs
// before acting on the output, instead of leaving them implicit in prose.

export function summarizeScanCompleteness({ roster, activity, verification } = {}) {
  const rosterComplete = roster?.complete === true;
  const activityComplete = activity?.complete === true;
  const verificationRan = verification != null;
  const verificationRemaining = Math.max(0, Number(verification?.remaining) || 0);
  return {
    roster: {
      complete: rosterComplete,
      found: Number.isFinite(roster?.found) ? roster.found : 0,
      expected: Number.isFinite(roster?.expected) ? roster.expected : null,
      reason: roster?.reason || null,
    },
    activity: {
      complete: activityComplete,
      reason: activity?.reason || null,
    },
    verification: {
      ran: verificationRan,
      checked: Number.isFinite(verification?.checked) ? verification.checked : 0,
      queued: Number.isFinite(verification?.queued) ? verification.queued : 0,
      remaining: verificationRemaining,
    },
    caveats: [
      !rosterComplete ? "roster-partial" : null,
      verificationRan && verificationRemaining > 0 ? "verification-remaining" : null,
    ].filter(Boolean),
  };
}

// A bare `safe: true` sitting next to caveats like "roster-partial" invites
// exactly the misreading this whole module exists to prevent - so instead
// of one boolean, this names the two things "can I trust this output" can
// actually mean for this tool, given what acting on it does (see the
// "manual-review warning" export/UI copy): `reviewable` gates the broad
// export, which deliberately mixes confirmed, unverified, and
// unverifiable-protected rows for a human to look at - never something to
// act on unreviewed. `safeForAutomatedRemoval` gates the confirmed-only
// export, whose rows were already individually verified by a direct search
// (see classifySearchVerification; a protected account can never earn that
// tag, since a search can't see into it either way).
//
// Both compute from the same activity-window precondition today, because
// that is the only scan-level gate either export currently needs - a
// flagged member's per-row confirmed/unverified/unverifiable-protected tag
// already carries the rest of the safety information, and re-deriving it
// here would just be a second, driftable copy of that same fact. The names
// stay distinct so a future scan-level gate - e.g. refusing automated
// removal specifically while direct-search verification still has a
// remaining queue, without also hiding the broad export from review - has
// somewhere to attach without conflating the two.
export function determineActionability(summary) {
  const activityComplete = summary?.activity?.complete === true;
  return {
    reviewable: activityComplete,
    safeForAutomatedRemoval: activityComplete,
    reason: activityComplete ? null : "activity-window-incomplete",
  };
}
