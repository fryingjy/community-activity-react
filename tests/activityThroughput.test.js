import test from "node:test";
import assert from "node:assert/strict";
import { estimateActivityThroughput, pushSample } from "../src/core/activityThroughput.js";

const DAY_MS = 24 * 60 * 60 * 1000;

test("estimateActivityThroughput needs at least two samples", () => {
  assert.equal(estimateActivityThroughput([], Date.now()), null);
  assert.equal(estimateActivityThroughput([{ atMs: 0, pages: 1, oldestSeenAtMs: 0 }], Date.now()), null);
});

test("estimateActivityThroughput computes rate, days-per-page, and ETA from a worked example", () => {
  const july20 = Date.UTC(2026, 6, 20);
  const july10 = Date.UTC(2026, 6, 10);
  const july1 = Date.UTC(2026, 6, 1);
  const samples = [
    { atMs: 0, pages: 10, oldestSeenAtMs: july20 },
    { atMs: 10 * 60 * 1000, pages: 60, oldestSeenAtMs: july10 }, // 50 pages in 10 min, moved back 10 days
  ];
  const result = estimateActivityThroughput(samples, july1);
  assert.equal(result.pagesPerMinute, 5);
  assert.equal(result.daysCoveredPerPage, 0.2);
  assert.equal(result.daysRemaining, 9);
  assert.equal(result.estimatedPagesRemaining, 45);
  assert.equal(result.estimatedMinutesRemaining, 9);
});

test("estimateActivityThroughput reports zero remaining once the target is already reached", () => {
  const july1 = Date.UTC(2026, 6, 1);
  const june20 = Date.UTC(2026, 5, 20);
  const samples = [
    { atMs: 0, pages: 10, oldestSeenAtMs: july1 + 5 * DAY_MS },
    { atMs: 60000, pages: 20, oldestSeenAtMs: june20 }, // already past the target
  ];
  const result = estimateActivityThroughput(samples, july1);
  assert.equal(result.daysRemaining, 0);
  assert.equal(result.estimatedPagesRemaining, 0);
  assert.equal(result.estimatedMinutesRemaining, 0);
});

test("estimateActivityThroughput returns null for a stalled or non-progressing window (no time, no pages, or moving forward)", () => {
  const base = Date.UTC(2026, 6, 1);
  // No elapsed time between samples.
  assert.equal(estimateActivityThroughput([
    { atMs: 1000, pages: 10, oldestSeenAtMs: base },
    { atMs: 1000, pages: 20, oldestSeenAtMs: base - DAY_MS },
  ], base - 10 * DAY_MS), null);
  // No pages progressed.
  assert.equal(estimateActivityThroughput([
    { atMs: 0, pages: 10, oldestSeenAtMs: base },
    { atMs: 60000, pages: 10, oldestSeenAtMs: base - DAY_MS },
  ], base - 10 * DAY_MS), null);
  // oldestSeenAt moved forward instead of back - not a trustworthy window.
  assert.equal(estimateActivityThroughput([
    { atMs: 0, pages: 10, oldestSeenAtMs: base - DAY_MS },
    { atMs: 60000, pages: 20, oldestSeenAtMs: base },
  ], base - 10 * DAY_MS), null);
});

test("pushSample keeps a bounded FIFO window", () => {
  let window = [];
  for (let i = 0; i < 45; i++) window = pushSample(window, { atMs: i, pages: i, oldestSeenAtMs: i }, 40);
  assert.equal(window.length, 40);
  assert.equal(window[0].atMs, 5);
  assert.equal(window[window.length - 1].atMs, 44);
});
