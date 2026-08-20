import test from "node:test";
import assert from "node:assert/strict";
import {
  InvariantViolation,
  assertActivityVerificationIsKnown,
  assertAutomatedRemovalRequiresCompleteActivity,
  assertConfirmedOnlyRowsAreConfirmed,
  assertEveryMemberHasAResolvableIdentity,
  assertNoDuplicateMemberIdentities,
} from "../src/core/invariants.js";

test("assertActivityVerificationIsKnown passes real classified rows and rejects an unknown label", () => {
  assert.doesNotThrow(() => assertActivityVerificationIsKnown([
    { username: "a", activityVerification: "confirmed-inactive" },
    { username: "b", activityVerification: "unverifiable-protected" },
    { username: "c", activityVerification: "unverified" },
  ]));
  assert.throws(
    () => assertActivityVerificationIsKnown([{ username: "d", activityVerification: "confirmed-active" }]),
    InvariantViolation
  );
  assert.throws(
    () => assertActivityVerificationIsKnown([{ username: "e" }]),
    InvariantViolation
  );
});

test("assertConfirmedOnlyRowsAreConfirmed rejects any row that isn't confirmed-inactive", () => {
  assert.doesNotThrow(() => assertConfirmedOnlyRowsAreConfirmed([
    { username: "a", activityVerification: "confirmed-inactive" },
  ]));
  assert.throws(
    () => assertConfirmedOnlyRowsAreConfirmed([
      { username: "a", activityVerification: "confirmed-inactive" },
      { username: "b", activityVerification: "unverified" },
    ]),
    InvariantViolation
  );
});

test("assertAutomatedRemovalRequiresCompleteActivity rejects safeForAutomatedRemoval alongside an incomplete activity window", () => {
  assert.doesNotThrow(() => assertAutomatedRemovalRequiresCompleteActivity(
    { safeForAutomatedRemoval: true },
    { activity: { complete: true } }
  ));
  assert.doesNotThrow(() => assertAutomatedRemovalRequiresCompleteActivity(
    { safeForAutomatedRemoval: false },
    { activity: { complete: false } }
  ));
  assert.throws(
    () => assertAutomatedRemovalRequiresCompleteActivity(
      { safeForAutomatedRemoval: true },
      { activity: { complete: false } }
    ),
    InvariantViolation
  );
});

test("assertEveryMemberHasAResolvableIdentity accepts user_id-only or username-only members, rejects neither", () => {
  assert.doesNotThrow(() => assertEveryMemberHasAResolvableIdentity([
    { user_id: "1" },
    { username: "onlyname" },
    { user_id: "2", username: "both" },
  ]));
  assert.throws(
    () => assertEveryMemberHasAResolvableIdentity([{ role: "member" }]),
    InvariantViolation
  );
});

test("assertNoDuplicateMemberIdentities catches a changed-handle-style duplicate by stable ID", () => {
  assert.doesNotThrow(() => assertNoDuplicateMemberIdentities([
    { user_id: "1", username: "alice" },
    { user_id: "2", username: "bob" },
  ]));
  assert.throws(
    () => assertNoDuplicateMemberIdentities([
      { user_id: "1", username: "alice" },
      { user_id: "1", username: "alice-renamed" },
    ]),
    InvariantViolation
  );
  // No stable ID on either side still resolves through the username
  // fallback - a duplicate there must be caught the same way.
  assert.throws(
    () => assertNoDuplicateMemberIdentities([
      { username: "carol" },
      { username: "Carol" },
    ]),
    InvariantViolation
  );
});
