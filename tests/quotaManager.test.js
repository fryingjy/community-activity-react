import test from "node:test";
import assert from "node:assert/strict";
import {
  QuotaManager,
  QUOTA_WARNING_REMAINING,
  readRateLimitHeaders,
} from "../src/api/quotaManager.js";

function headers(map) {
  return new Map(Object.entries(map));
}

test("readRateLimitHeaders returns null when X sends no rate-limit headers", () => {
  assert.equal(readRateLimitHeaders(headers({})), null);
});

test("readRateLimitHeaders converts the reset header from seconds to ms", () => {
  const result = readRateLimitHeaders(headers({
    "x-rate-limit-limit": "500",
    "x-rate-limit-remaining": "480",
    "x-rate-limit-reset": "1700000000",
  }));
  assert.deepEqual(result, { limit: 500, remaining: 480, resetAt: 1700000000000 });
});

test("QuotaManager tracks each operation's bucket independently", () => {
  const manager = new QuotaManager();
  manager.record("CommunitiesMembersAllQuery", { limit: 500, remaining: 300, resetAt: 1000 });
  manager.record("CommunityTweetSearchModuleQuery", { limit: 500, remaining: 495, resetAt: 2000 });
  assert.equal(manager.get("CommunitiesMembersAllQuery").remaining, 300);
  assert.equal(manager.get("CommunityTweetSearchModuleQuery").remaining, 495);
});

test("QuotaManager warns exactly once when remaining drops to the threshold", () => {
  const manager = new QuotaManager();
  const first = manager.record("op", { limit: 500, remaining: QUOTA_WARNING_REMAINING, resetAt: 1000 });
  assert.equal(first.enteringWarning, true);
  const second = manager.record("op", { limit: 500, remaining: QUOTA_WARNING_REMAINING - 1, resetAt: 1000 });
  assert.equal(second.enteringWarning, false);
  assert.equal(manager.get("op").warned, true);
});

test("QuotaManager.isExhausted is true only while remaining is zero and reset is in the future", () => {
  const manager = new QuotaManager();
  manager.record("op", { limit: 500, remaining: 0, resetAt: 5000 });
  assert.equal(manager.isExhausted("op", 4000), true);
  assert.equal(manager.isExhausted("op", 6000), false);
  assert.equal(manager.isExhausted("unknown-op", 4000), false);
});

test("QuotaManager.snapshot wraps the same object it was constructed with", () => {
  const quotas = {};
  const manager = new QuotaManager(quotas);
  manager.record("op", { limit: 500, remaining: 10, resetAt: 1000 });
  assert.equal(manager.snapshot(), quotas);
  assert.equal(quotas.op.remaining, 10);
});
