// X's native roster cursor is an unsigned base64 Apache Thrift struct. Byte
// offset 30 holds a plain big-endian int64 millisecond timestamp — the seek
// position into a roster ordered by join time — and the server validates
// nothing else about it: rewriting those eight bytes seeks anywhere in the
// roster and returns a fresh, valid continuation cursor.
const ROSTER_CURSOR_TIMESTAMP_OFFSET = 30;
// Byte 71 is the chain's page counter. Reading eight consecutive pages on
// 2026-07-30 returned 2, 3, 4, 5, 6, 7, 8, 9 there while every other byte moved
// unpredictably. It is what the 500-page cap counts, so a cursor taken from
// deep in a spent chain resumes with an exhausted budget: rewriting only its
// timestamp yields a single page and no continuation, which is precisely how a
// resumed walk stalled at 46,951 of 79,397. Seeking resets it.
const ROSTER_CURSOR_PAGE_COUNTER_OFFSET = 71;
const ROSTER_CURSOR_PAGE_COUNTER_START = 2;
const ROSTER_CURSOR_MIN_BYTES = ROSTER_CURSOR_PAGE_COUNTER_OFFSET + 1;
// When a chain stalls, the next seek steps just past the position it stalled
// on. One millisecond is deliberate: the stall means members share that exact
// timestamp, and the only ones a timestamp seek cannot reach are the remainder
// of that millisecond. Skipping by a coarse interval instead steps over members
// that were never collected — a modelled roster lost 21,540 of them to a single
// six-hour skip and finished at 66.57%, where a one-millisecond step finishes
// at 100%.
const SEEK_RESUME_FORWARD_STEP_MS = 1;

export function seekResumeForwardStep() {
  return SEEK_RESUME_FORWARD_STEP_MS;
}

function decodeCursorBytes(cursor) {
  if (typeof cursor !== "string" || !cursor) return null;
  try {
    const binary = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    if (binary.length < ROSTER_CURSOR_MIN_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function readRosterCursorTimestamp(cursor) {
  const bytes = decodeCursorBytes(cursor);
  if (!bytes) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const value = Number(view.getBigInt64(ROSTER_CURSOR_TIMESTAMP_OFFSET));
  // Only accept something that reads as a plausible millisecond timestamp, so a
  // layout change degrades to "no seek" instead of producing a junk cursor.
  if (!Number.isFinite(value) || value < 1.3e12 || value > 2.0e12) return null;
  return value;
}

// Seeking starts a new chain, so the page counter is reset alongside the
// position. Without this a seek inherits the spent budget of the chain its
// cursor came from and dies after one page.
export function withRosterCursorTimestamp(cursor, timestampMs) {
  const bytes = decodeCursorBytes(cursor);
  if (!bytes || !Number.isFinite(timestampMs)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setBigInt64(ROSTER_CURSOR_TIMESTAMP_OFFSET, BigInt(Math.floor(timestampMs)));
  bytes[ROSTER_CURSOR_PAGE_COUNTER_OFFSET] = ROSTER_CURSOR_PAGE_COUNTER_START;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
