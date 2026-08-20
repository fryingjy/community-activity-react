// Property/fuzz tests for the roster cursor codec, which relies on an
// undocumented X byte layout (see cursorCodec.js's own header comments for
// the two offsets and why they were chosen). The hand-written tests in
// liteScanner.test.js pin a handful of fixed example cursors; this file
// generates thousands of synthetic ones instead, so a layout assumption that
// happens to hold for those few examples but not in general gets caught.
//
// This project has zero runtime or dev dependencies by design (see the
// "extension remains local and free of third-party roster services" test),
// so this is a small hand-rolled seeded PRNG rather than pulling in a
// property-testing library like fast-check. The seed is fixed so a failure
// is always reproducible from the printed seed/iteration alone.

import test from "node:test";
import assert from "node:assert/strict";
import {
  readRosterCursorTimestamp,
  withRosterCursorTimestamp,
} from "../src/roster/cursorCodec.js";

const ROSTER_CURSOR_TIMESTAMP_OFFSET = 30;
const ROSTER_CURSOR_PAGE_COUNTER_OFFSET = 71;
const ROSTER_CURSOR_PAGE_COUNTER_START = 2;
const PLAUSIBLE_MIN_MS = 1.3e12;
const PLAUSIBLE_MAX_MS = 2.0e12;
const ITERATIONS = 3000;
const SEED = 0xc0ffee;

// mulberry32: tiny, deterministic, good enough statistical spread for fuzzing.
function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng, min, max) {
  return Math.floor(min + rng() * (max - min));
}

function randomPlausibleTimestamp(rng) {
  return randomInt(rng, PLAUSIBLE_MIN_MS, PLAUSIBLE_MAX_MS);
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(cursor) {
  return new Uint8Array(Buffer.from(cursor, "base64"));
}

// A synthetic cursor: random bytes everywhere, a plausible timestamp written
// at the real offset, and a random page-counter byte (chains are observed at
// many different counter values, never just the one liteScanner.test.js
// happens to fix).
function makeSyntheticCursor(rng, { length, timestampMs, counterByte }) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = randomInt(rng, 0, 256);
  const view = new DataView(bytes.buffer);
  view.setBigInt64(ROSTER_CURSOR_TIMESTAMP_OFFSET, BigInt(Math.floor(timestampMs)));
  bytes[ROSTER_CURSOR_PAGE_COUNTER_OFFSET] = counterByte;
  return bytes;
}

test(`round-trip: reading back a written timestamp is exact across ${ITERATIONS} synthetic cursors`, () => {
  const rng = makeRng(SEED);
  for (let i = 0; i < ITERATIONS; i++) {
    const length = randomInt(rng, ROSTER_CURSOR_PAGE_COUNTER_OFFSET + 1, ROSTER_CURSOR_PAGE_COUNTER_OFFSET + 40);
    const timestampMs = randomPlausibleTimestamp(rng);
    const counterByte = randomInt(rng, 0, 256);
    const bytes = makeSyntheticCursor(rng, { length, timestampMs, counterByte });
    const cursor = bytesToBase64(bytes);
    assert.equal(
      readRosterCursorTimestamp(cursor),
      timestampMs,
      `seed=${SEED} iteration=${i} length=${length} timestampMs=${timestampMs}`
    );
  }
});

test(`seek invariants hold across ${ITERATIONS} synthetic cursors: only the timestamp and counter bytes change, and only those`, () => {
  const rng = makeRng(SEED + 1);
  for (let i = 0; i < ITERATIONS; i++) {
    const length = randomInt(rng, ROSTER_CURSOR_PAGE_COUNTER_OFFSET + 1, ROSTER_CURSOR_PAGE_COUNTER_OFFSET + 40);
    const originalTimestampMs = randomPlausibleTimestamp(rng);
    const targetTimestampMs = randomPlausibleTimestamp(rng);
    const counterByte = randomInt(rng, 0, 256);
    const bytes = makeSyntheticCursor(rng, { length, timestampMs: originalTimestampMs, counterByte });
    const cursor = bytesToBase64(bytes);
    const context = `seed=${SEED + 1} iteration=${i} length=${length} original=${originalTimestampMs} target=${targetTimestampMs}`;

    const seeked = withRosterCursorTimestamp(cursor, targetTimestampMs);
    assert.ok(seeked, context);
    const seekedBytes = base64ToBytes(seeked);

    assert.equal(seekedBytes.length, bytes.length, context);
    assert.equal(readRosterCursorTimestamp(seeked), targetTimestampMs, context);
    // The page counter always resets to the start value on a seek, whatever
    // it was before - this is what gives a resumed chain a full budget.
    assert.equal(seekedBytes[ROSTER_CURSOR_PAGE_COUNTER_OFFSET], ROSTER_CURSOR_PAGE_COUNTER_START, context);
    // Every byte outside the timestamp field and the counter byte must be
    // untouched: a seek rewrites position, nothing else about the cursor.
    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex++) {
      if (byteIndex >= ROSTER_CURSOR_TIMESTAMP_OFFSET && byteIndex < ROSTER_CURSOR_TIMESTAMP_OFFSET + 8) continue;
      if (byteIndex === ROSTER_CURSOR_PAGE_COUNTER_OFFSET) continue;
      assert.equal(seekedBytes[byteIndex], bytes[byteIndex], `${context} byte=${byteIndex}`);
    }
  }
});

test(`the codec fails closed on undersized buffers across ${ITERATIONS} random lengths`, () => {
  const rng = makeRng(SEED + 2);
  for (let i = 0; i < ITERATIONS; i++) {
    const length = randomInt(rng, 0, ROSTER_CURSOR_PAGE_COUNTER_OFFSET + 1); // always < required minimum
    const bytes = new Uint8Array(length);
    for (let j = 0; j < length; j++) bytes[j] = randomInt(rng, 0, 256);
    const cursor = bytesToBase64(bytes);
    const context = `seed=${SEED + 2} iteration=${i} length=${length}`;
    assert.equal(readRosterCursorTimestamp(cursor), null, context);
    assert.equal(withRosterCursorTimestamp(cursor, Date.now()), null, context);
  }
});

test(`readRosterCursorTimestamp rejects implausible timestamps across ${ITERATIONS} out-of-range values`, () => {
  const rng = makeRng(SEED + 3);
  for (let i = 0; i < ITERATIONS; i++) {
    const length = randomInt(rng, ROSTER_CURSOR_PAGE_COUNTER_OFFSET + 1, ROSTER_CURSOR_PAGE_COUNTER_OFFSET + 40);
    // Either far below or far above the plausible millisecond-timestamp window.
    const belowRange = randomInt(rng, -1e12, PLAUSIBLE_MIN_MS - 1);
    const aboveRange = randomInt(rng, PLAUSIBLE_MAX_MS + 1, PLAUSIBLE_MAX_MS + 1e12);
    const timestampMs = i % 2 === 0 ? belowRange : aboveRange;
    const bytes = makeSyntheticCursor(rng, { length, timestampMs, counterByte: randomInt(rng, 0, 256) });
    const cursor = bytesToBase64(bytes);
    assert.equal(
      readRosterCursorTimestamp(cursor),
      null,
      `seed=${SEED + 3} iteration=${i} timestampMs=${timestampMs}`
    );
  }
});
