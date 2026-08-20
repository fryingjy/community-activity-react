// A deterministic fake X roster server, used to drive the real, unmodified
// fetchCommunityMembersByCursor() end to end instead of proving the
// seek-resume decision logic against a reimplementation of it (see
// liteScanner.test.js's simulateSeekResume, which is the model the tests in
// this directory are meant to close the gap on: that function proves the
// *decision helpers* correct, not the orchestrator that actually calls them
// against real GraphQL responses, checkpoint storage, and the cursor codec).
//
// This file intentionally implements its own small cursor wire format
// (encodeCursor/decodeCursor below) rather than importing cursorCodec.js's
// internals: the whole point of a server double is to encode an independent
// understanding of the contract, so a client-side bug that happens to agree
// with itself doesn't get a free pass. The byte layout matches what
// cursorCodec.js documents (offset 30: big-endian int64 ms timestamp, offset
// 71: the chain's page counter) because that layout is the real, observed
// wire format this project reverse-engineered - matching it is what makes
// this a fake X, not a fake protocol.

const TIMESTAMP_OFFSET = 30;
const COUNTER_OFFSET = 71;
const CURSOR_BYTE_LENGTH = 75;
// Two more fields, in bytes the real client never reads or writes except by
// blind copy: an exact server-side position, and a checksum tying it to the
// timestamp it was issued alongside. Real X's cursor almost certainly opaque-
// encodes more than a timestamp too - a timestamp alone cannot address an
// individual record inside a block of records that all share one timestamp,
// which is exactly the scenario seek-resume's dead-zone handling exists for.
// withRosterCursorTimestamp (the real client seek path) rewrites only the
// timestamp and counter, so after a seek this position/checksum pair is
// stale relative to the new timestamp - the checksum mismatch is how this
// fake server tells "a same-chain continuation, exact" apart from "a
// client-side seek, only approximately relocated by timestamp," the same
// distinction a real server would have to make from an opaque cursor it
// didn't itself just issue for that exact position.
const POSITION_OFFSET = 40;
const CHECKSUM_OFFSET = 50;

function encodeCursor(timestampMs, positionIndex, counter) {
  const bytes = new Uint8Array(CURSOR_BYTE_LENGTH);
  const view = new DataView(bytes.buffer);
  const ts = BigInt(Math.floor(timestampMs));
  const pos = BigInt(positionIndex);
  view.setBigInt64(TIMESTAMP_OFFSET, ts);
  view.setBigInt64(POSITION_OFFSET, pos);
  view.setBigInt64(CHECKSUM_OFFSET, pos ^ ts);
  bytes[COUNTER_OFFSET] = Math.min(255, Math.max(0, counter));
  return Buffer.from(bytes).toString("base64");
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  const bytes = new Uint8Array(Buffer.from(cursor, "base64"));
  if (bytes.length <= COUNTER_OFFSET) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const timestampMs = Number(view.getBigInt64(TIMESTAMP_OFFSET));
  const positionIndex = view.getBigInt64(POSITION_OFFSET);
  const checksum = view.getBigInt64(CHECKSUM_OFFSET);
  const trustedPosition = checksum === (positionIndex ^ BigInt(Math.floor(timestampMs)))
    ? Number(positionIndex)
    : null;
  return { timestampMs, counter: bytes[COUNTER_OFFSET], trustedPosition };
}

function nativeTimelinePayload(pageMembers, nextCursor) {
  const entries = pageMembers.map((member, index) => ({
    entryId: `user-${member.userId}-${index}`,
    content: {
      __typename: "TimelineTimelineItem",
      content: {
        __typename: "TimelineUser",
        userResult: {
          result: {
            __typename: "User",
            rest_id: member.userId,
            legacy: { screen_name: member.username, name: member.username, protected: member.protected === true },
          },
        },
      },
    },
  }));
  if (nextCursor) {
    entries.push({
      entryId: "cursor-bottom",
      content: { __typename: "TimelineTimelineCursor", cursorType: "Bottom", value: nextCursor },
    });
  }
  return {
    data: {
      community_by_rest_id: {
        timeline_response: { timeline: { instructions: [
          { __typename: "TimelineClearCache" },
          { __typename: "TimelineAddEntries", entries },
        ] } },
      },
    },
  };
}

// `members` must be pre-sorted ascending by joinTimeMs - that's the ordering
// X's real roster cursor walks, and it's what makes a synthetic timestamp
// collision block ("large timestamp collision groups") an honest stress
// case rather than an artifact of generation order.
// `injectFault(requestNumber)` lets a test make specific requests (1-indexed,
// across the server's whole lifetime) come back as a transient failure
// instead of a real page - `"429"` or `"500"`, or a falsy value for no
// fault. The real production retry/backoff paths (see graphqlClient.js) are
// what's actually under test here, not this server's fault logic, so it
// stays deliberately simple: one fault per configured request number, then
// normal service resumes on retry.
// `onRequest(requestNumber)`, if given, runs before every response is
// built - a test uses it to trigger a side effect (typically aborting a
// signal) at an exact request count, to simulate "the browser closed right
// here" without racing real timing.
export function createFakeXRosterServer({ members, pageSize, chainPageCap, documentId, operation, injectFault, onRequest }) {
  let requestCount = 0;

  function findPosition(timestampMs) {
    const index = members.findIndex((member) => member.joinTimeMs >= timestampMs);
    return index < 0 ? members.length : index;
  }

  function respond(url) {
    requestCount++;
    onRequest?.(requestCount);
    const fault = injectFault?.(requestCount);
    if (fault === "429") {
      return {
        status: 429,
        statusText: "Too Many Requests",
        body: null,
        headers: { "retry-after": "0", "x-rate-limit-reset": String(Math.floor(Date.now() / 1000)) },
      };
    }
    if (fault === "500") {
      return { status: 500, statusText: "Internal Server Error", body: null };
    }
    const parsed = new URL(url);
    const [, , , , reqDocumentId, reqOperation] = parsed.pathname.split("/");
    if (reqDocumentId !== documentId || reqOperation !== operation) {
      return { status: 404, statusText: "Not Found", body: null };
    }
    const variables = JSON.parse(parsed.searchParams.get("variables") || "{}");
    const incomingCursor = variables.cursor || null;
    const decoded = decodeCursor(incomingCursor);
    const incomingCounter = decoded ? decoded.counter : 1;
    // Exact position for an ordinary continuation; approximate (timestamp-
    // only) repositioning for a client-side seek - see the field comments
    // above for why those are distinguishable at all.
    const position = decoded
      ? (decoded.trustedPosition != null ? decoded.trustedPosition : findPosition(decoded.timestampMs))
      : 0;
    const page = members.slice(position, position + pageSize);
    const nextPosition = position + page.length;
    const nextTimestampMs = page.length ? page.at(-1).joinTimeMs : (decoded?.timestampMs ?? 0);
    // A chain caps at chainPageCap total pages served since it opened (or
    // since the client last seeked, which resets the counter): this is
    // exactly the "500-page chain cutoff" from real X, scaled down.
    const chainCapped = incomingCounter >= chainPageCap;
    const nextCursor = !chainCapped && page.length > 0
      ? encodeCursor(nextTimestampMs, nextPosition, incomingCounter + 1)
      : null;

    return {
      status: 200,
      statusText: "OK",
      body: nativeTimelinePayload(page, nextCursor),
      headers: { "x-rate-limit-limit": "500", "x-rate-limit-remaining": "499", "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 900) },
    };
  }

  return {
    respond,
    get requestCount() {
      return requestCount;
    },
  };
}

// Combines several fake servers (each answering a different documentId/
// operation pair) into one, for tests that drive multiple real collectors
// against one shared fake X - e.g. the full-pipeline simulator, where
// roster, activity, media, search, and verification all need to answer
// through the same installed fetch. Every server here already returns 404
// on a documentId/operation mismatch, so routing is just "first one that
// doesn't 404 wins." This assumes none of the composed servers have active
// fault injection in the same test (fault injection short-circuits the
// documentId/operation check by design, so it isn't routable this way) -
// true for the full-pipeline test, which is fault-free by scope; each
// stage's own fault handling is already proven in its dedicated simulator.
export function composeFakeXServers(...servers) {
  return {
    respond(url) {
      for (const server of servers) {
        const result = server.respond(url);
        if (result.status !== 404) return result;
      }
      return { status: 404, statusText: "Not Found", body: null };
    },
    get requestCount() {
      return servers.reduce((sum, server) => sum + server.requestCount, 0);
    },
  };
}

function fakeResponse({ status, statusText, body, headers = {} }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: (name) => headers[name.toLowerCase()] ?? headers[name] ?? null },
    json: async () => body,
  };
}

// Installs fetch/chrome fakes for the duration of a test and returns a
// restore() to undo them, plus the server so assertions can read its
// requestCount. graphqlClient.js and rosterCheckpoint.js talk to
// globalThis.fetch/chrome directly (they're extension code, not
// dependency-injected), so a Node test has to replace those globals rather
// than pass in a client.
export function installFakeXEnvironment(server) {
  const realFetch = globalThis.fetch;
  const realChrome = globalThis.chrome;
  const storage = new Map();

  globalThis.fetch = async (url) => {
    const result = server.respond(String(url));
    return fakeResponse(result);
  };

  globalThis.chrome = {
    ...realChrome,
    cookies: { async get() { return { value: "fake-ct0-token" }; } },
    storage: {
      local: {
        async get(keys) {
          const list = keys == null ? [...storage.keys()] : Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) if (storage.has(key)) out[key] = storage.get(key);
          return out;
        },
        async set(obj) {
          for (const [key, value] of Object.entries(obj)) storage.set(key, value);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
        },
      },
    },
  };

  return {
    storage,
    restore() {
      globalThis.fetch = realFetch;
      globalThis.chrome = realChrome;
    },
  };
}
