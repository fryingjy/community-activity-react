import test from "node:test";
import assert from "node:assert/strict";
import { KNOWN_OPERATIONS, OperationRegistry } from "../src/api/operationRegistry.js";

test("KNOWN_OPERATIONS catalogs every operation with a name and the capability it serves", () => {
  assert.ok(KNOWN_OPERATIONS.length >= 10);
  for (const entry of KNOWN_OPERATIONS) {
    assert.equal(typeof entry.name, "string");
    assert.ok(entry.name.length > 0);
    assert.equal(typeof entry.role, "string");
    assert.ok(entry.role.length > 0);
  }
  const names = KNOWN_OPERATIONS.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, "operation names must be unique");
});

test("OperationRegistry reports unknown for an operation it has never seen", () => {
  const registry = new OperationRegistry();
  assert.deepEqual(registry.get("CommunityQuery"), { status: "unknown", reason: null, checkedAt: null });
});

test("OperationRegistry records success and contract failures independently per operation", () => {
  const registry = new OperationRegistry();
  registry.recordSuccess("CommunitiesMembersAllQuery");
  registry.recordContractFailure("CommunityTweetSearchModuleQuery", "http-400");

  const roster = registry.get("CommunitiesMembersAllQuery");
  assert.equal(roster.status, "ok");
  assert.equal(roster.reason, null);
  assert.ok(Number.isFinite(roster.checkedAt));

  const search = registry.get("CommunityTweetSearchModuleQuery");
  assert.equal(search.status, "broken");
  assert.equal(search.reason, "http-400");
});

test("OperationRegistry's later outcome overwrites an operation's earlier one", () => {
  const registry = new OperationRegistry();
  registry.recordContractFailure("CommunityAnalyticsQuery", "graphql-error");
  registry.recordSuccess("CommunityAnalyticsQuery");
  assert.equal(registry.get("CommunityAnalyticsQuery").status, "ok");
});

test("OperationRegistry.snapshot wraps the same object it was constructed with", () => {
  const state = {};
  const registry = new OperationRegistry(state);
  registry.recordSuccess("CommunityQuery");
  assert.equal(registry.snapshot(), state);
  assert.equal(state.CommunityQuery.status, "ok");
});
