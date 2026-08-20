// Machine-checkable invariants for the data this project actually produces,
// grounded in the real shapes classification.js/directVerification.js/
// scanCompleteness.js already use - not abstract pseudocode. Each one is
// wired in at the point production code would otherwise trust an assumption
// silently; a violation throws InvariantViolation instead of exporting or
// acting on data that doesn't actually satisfy what its own label claims.

import { activitySearchCandidateIdentity } from "../activity/directVerification.js";

export class InvariantViolation extends Error {
  constructor(name, detail) {
    super(`Invariant violated: ${name}${detail ? ` — ${detail}` : ""}`);
    this.name = "InvariantViolation";
    this.invariant = name;
  }
}

const KNOWN_ACTIVITY_VERIFICATIONS = new Set([
  "confirmed-inactive",
  "unverifiable-protected",
  "unverified",
]);

// A row that was direct-search-confirmed active is never labeled at all -
// classifySearchVerification removes it from the flagged list instead
// (see sidepanel.js: `if (classified.cleared) { ...; return kept; }`). So
// "known" here is deliberately the three states a still-flagged row can
// actually carry, not a fourth "confirmed-active" that would never appear.
export function assertActivityVerificationIsKnown(rows) {
  for (const row of rows || []) {
    if (!KNOWN_ACTIVITY_VERIFICATIONS.has(row?.activityVerification)) {
      throw new InvariantViolation(
        "activity-verification-known",
        `username=${row?.username ?? "?"} activityVerification=${JSON.stringify(row?.activityVerification)}`
      );
    }
  }
}

// The confirmed-only export's entire reason to exist is that every row in
// it was individually direct-search-verified - see determineActionability's
// safeForAutomatedRemoval and the "manual-review warning" UI copy this rule
// exists to make true, not just claimed.
export function assertConfirmedOnlyRowsAreConfirmed(rows) {
  for (const row of rows || []) {
    if (row?.activityVerification !== "confirmed-inactive") {
      throw new InvariantViolation(
        "confirmed-only-rows-are-confirmed",
        `username=${row?.username ?? "?"} activityVerification=${JSON.stringify(row?.activityVerification)}`
      );
    }
  }
}

// determineActionability's own contract: automated removal can never be
// judged safe while the activity window itself is incomplete, whatever else
// is true of the scan.
export function assertAutomatedRemovalRequiresCompleteActivity(actionability, completeness) {
  if (actionability?.safeForAutomatedRemoval && completeness?.activity?.complete !== true) {
    throw new InvariantViolation(
      "automated-removal-requires-complete-activity",
      `activity.complete=${completeness?.activity?.complete}`
    );
  }
}

// activitySearchCandidateIdentity's own fallback (id if present, else
// lowercased username) is what every cache key, dedup, and verification
// lookup in this project relies on being resolvable at all - a member with
// neither is invisible to all of them, not just weakly identified.
export function assertEveryMemberHasAResolvableIdentity(members) {
  for (const member of members || []) {
    if (!member?.user_id && !member?.username) {
      throw new InvariantViolation("member-has-resolvable-identity", `member=${JSON.stringify(member)}`);
    }
  }
}

// Two different member records resolving to the same identity means a
// dedup step upstream (createMemberStore, createActivityIndex, or the
// verification cache) failed to collapse them - exactly the class of bug a
// changed-handle or duplicate-roster-page scenario would produce.
export function assertNoDuplicateMemberIdentities(members) {
  const seen = new Set();
  for (const member of members || []) {
    const identity = activitySearchCandidateIdentity(member);
    if (seen.has(identity)) {
      throw new InvariantViolation("no-duplicate-member-identities", `identity=${identity}`);
    }
    seen.add(identity);
  }
}
