import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RESERVE, planWork, usableQuota } from "../src/api/quotaPlanner.js";

test("usableQuota reserves the larger of the flat and proportional reserve", () => {
  // limit 500, 5% = 25, flat default 20 -> 25 wins.
  assert.equal(usableQuota({ remaining: 463, limit: 500 }), 463 - 25);
  // limit 100, 5% = 5, flat default 20 -> 20 wins.
  assert.equal(usableQuota({ remaining: 50, limit: 100 }), 50 - 20);
});

test("usableQuota is null for an unobserved quota, and never negative for a reserve larger than remaining", () => {
  assert.equal(usableQuota(null), null);
  assert.equal(usableQuota({ remaining: null, limit: 500 }), null);
  assert.equal(usableQuota({ remaining: 5, limit: 500 }, { reserve: 20 }), 0);
});

test("planWork matches the completion plan's own worked example: 612 queued, 463 remaining, 30 reserved", () => {
  const plan = planWork(612, { remaining: 463, limit: 500 }, { reserve: 30, perRunSafetyCap: 1000 });
  assert.equal(plan.usable, 433);
  assert.equal(plan.processNow, 433);
  assert.equal(plan.defer, 179);
  assert.equal(plan.reason, "quota-budget");
});

test("planWork processes everything when quota comfortably covers the whole queue", () => {
  const plan = planWork(50, { remaining: 463, limit: 500 });
  assert.equal(plan.processNow, 50);
  assert.equal(plan.defer, 0);
  assert.equal(plan.reason, "queue-fits");
});

test("planWork defers everything when quota is exhausted, distinct from quota merely being tight", () => {
  const plan = planWork(50, { remaining: 0, limit: 500, resetAt: 1700000000000 });
  assert.equal(plan.processNow, 0);
  assert.equal(plan.defer, 50);
  assert.equal(plan.reason, "quota-exhausted");
  assert.equal(plan.resetAt, 1700000000000);
});

test("planWork falls back to unknownQuotaFallback, not zero, when no quota has been observed yet", () => {
  const plan = planWork(1000, null, { unknownQuotaFallback: 400, perRunSafetyCap: 600 });
  assert.equal(plan.usable, null);
  assert.equal(plan.processNow, 400);
  assert.equal(plan.defer, 600);
  assert.equal(plan.reason, "run-limit");
});

test("planWork never exceeds perRunSafetyCap even when the bucket has ample quota", () => {
  const plan = planWork(1000, { remaining: 5000, limit: 5000 }, { perRunSafetyCap: 600, reserve: 20 });
  assert.equal(plan.processNow, 600);
  assert.equal(plan.defer, 400);
  assert.equal(plan.reason, "run-limit");
});

test("planWork handles an empty queue without touching quota at all", () => {
  const plan = planWork(0, { remaining: 0, limit: 500 });
  assert.deepEqual(plan, { processNow: 0, defer: 0, usable: null, resetAt: null, reason: "queue-empty" });
});

test("planWork re-planned against a lower remaining (headers decreasing across requests) shrinks the next run's budget", () => {
  // limit 500 -> proportional reserve 25 wins over the flat 20 passed here.
  const first = planWork(300, { remaining: 300, limit: 500 }, { reserve: 20 });
  assert.equal(first.processNow, 275);
  const second = planWork(first.defer, { remaining: 300 - first.processNow, limit: 500 }, { reserve: 20 });
  assert.ok(second.processNow < first.processNow);
});

test("planWork treats independent operations independently - one exhausted bucket does not affect another's plan", () => {
  const rosterPlan = planWork(50, { remaining: 400, limit: 500 });
  const searchPlan = planWork(50, { remaining: 0, limit: 500, resetAt: Date.now() + 60000 });
  assert.equal(rosterPlan.reason, "queue-fits");
  assert.equal(searchPlan.reason, "quota-exhausted");
});

test("planWork after a reset (remaining back up) resumes normal-sized runs", () => {
  const exhausted = planWork(200, { remaining: 0, limit: 500, resetAt: Date.now() - 1000 });
  assert.equal(exhausted.processNow, 0);
  const resumed = planWork(exhausted.defer, { remaining: 500, limit: 500, resetAt: null });
  assert.ok(resumed.processNow > 0);
  // limit 500 -> proportional reserve (25) wins over the flat DEFAULT_RESERVE (20).
  assert.equal(resumed.usable, 500 - Math.ceil(500 * 0.05));
  assert.ok(Math.ceil(500 * 0.05) > DEFAULT_RESERVE);
});
