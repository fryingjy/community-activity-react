import test from "node:test";
import assert from "node:assert/strict";
import { AdaptiveRateLimiter, delay } from "../src/api/rateLimiter.js";

test("AdaptiveRateLimiter defaults to the real setTimeout-backed delay, unchanged from before injection existed", () => {
  const limiter = new AdaptiveRateLimiter(750);
  assert.equal(limiter.sleep, delay);
  assert.equal(limiter.minDelayMs, 750);
});

test("AdaptiveRateLimiter.wait() calls an injected sleep instead of the real one, and resolves without a real wait", async () => {
  const calls = [];
  const limiter = new AdaptiveRateLimiter(750, async (ms, signal) => { calls.push({ ms, signal }); });
  const startedAt = Date.now();
  await limiter.wait(undefined);
  assert.ok(Date.now() - startedAt < 50, "injected sleep must not actually wait");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].ms >= 750 && calls[0].ms <= 750 + 750 * 0.08);
});

test("AdaptiveRateLimiter.success narrows delay back toward the floor, never below it", () => {
  const limiter = new AdaptiveRateLimiter(500, async () => {});
  limiter.delayMs = 2000;
  limiter.success();
  assert.ok(limiter.delayMs < 2000 && limiter.delayMs >= 500);
  for (let i = 0; i < 500; i++) limiter.success();
  assert.equal(limiter.delayMs, 500);
});

test("AdaptiveRateLimiter.failure grows delay by the given multiplier, capped at 12s", () => {
  const limiter = new AdaptiveRateLimiter(500, async () => {});
  limiter.failure(2);
  assert.equal(limiter.delayMs, 1000);
  for (let i = 0; i < 20; i++) limiter.failure(2);
  assert.equal(limiter.delayMs, 12000);
});
