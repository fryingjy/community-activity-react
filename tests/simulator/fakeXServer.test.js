import test from "node:test";
import assert from "node:assert/strict";
import { createFakeXRosterServer, installFakeXEnvironment } from "./fakeXServer.js";

const DOCUMENT_ID = "doc-id";
const OPERATION = "TestOperation";

function makeMembers(count, { tiedTimestamp = false } = {}) {
  const start = Date.UTC(2025, 0, 1);
  return Array.from({ length: count }, (_, i) => ({
    userId: String(i),
    username: `user_${i}`,
    joinTimeMs: tiedTimestamp ? start : start + i * 1000,
  }));
}

async function fetchPage(server, variables) {
  const url = `https://x.com/i/api/graphql/${DOCUMENT_ID}/${OPERATION}?variables=${encodeURIComponent(JSON.stringify(variables))}`;
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

function membersFromPayload(payload) {
  const entries = payload.data.community_by_rest_id.timeline_response.timeline.instructions[1].entries;
  return entries
    .filter((entry) => entry.content.__typename === "TimelineTimelineItem")
    .map((entry) => entry.content.content.userResult.result.rest_id);
}

function nextCursorFromPayload(payload) {
  const entries = payload.data.community_by_rest_id.timeline_response.timeline.instructions[1].entries;
  const cursorEntry = entries.find((entry) => entry.content.__typename === "TimelineTimelineCursor");
  return cursorEntry?.content.value ?? null;
}

test("the fake server serves sequential pages and ends the chain at the request's page cap", async () => {
  const server = createFakeXRosterServer({
    members: makeMembers(25),
    pageSize: 10,
    chainPageCap: 2,
    documentId: DOCUMENT_ID,
    operation: OPERATION,
  });
  const env = installFakeXEnvironment(server);
  try {
    const page1 = await fetchPage(server, { count: 10 });
    assert.deepEqual(membersFromPayload(page1.body), ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    const cursor1 = nextCursorFromPayload(page1.body);
    assert.ok(cursor1);

    const page2 = await fetchPage(server, { count: 10, cursor: cursor1 });
    assert.deepEqual(membersFromPayload(page2.body), ["10", "11", "12", "13", "14", "15", "16", "17", "18", "19"]);
    // Chain cap is 2 pages; this was the second page of the chain, so no
    // further cursor even though 5 members remain unserved.
    assert.equal(nextCursorFromPayload(page2.body), null);
  } finally {
    env.restore();
  }
});

test("a natural (non-seek) cursor walks through a same-timestamp block exactly, page by page", async () => {
  // 15 members share one timestamp; pageSize 5 means 3 pages must be walked
  // to cross it. If the fake server only understood timestamps, every page
  // would collide back onto the first 5 members - this is the same failure
  // mode the real seek-resume feature exists to work around.
  const server = createFakeXRosterServer({
    members: makeMembers(15, { tiedTimestamp: true }),
    pageSize: 5,
    chainPageCap: 10,
    documentId: DOCUMENT_ID,
    operation: OPERATION,
  });
  const env = installFakeXEnvironment(server);
  try {
    let cursor = null;
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const { body } = await fetchPage(server, cursor ? { count: 5, cursor } : { count: 5 });
      seen.push(...membersFromPayload(body));
      cursor = nextCursorFromPayload(body);
    }
    assert.deepEqual(seen, makeMembers(15).map((m) => m.userId));
  } finally {
    env.restore();
  }
});

test("a request for an unknown document ID or operation gets a 404, not silently routed", async () => {
  const server = createFakeXRosterServer({
    members: makeMembers(5),
    pageSize: 5,
    chainPageCap: 10,
    documentId: DOCUMENT_ID,
    operation: OPERATION,
  });
  const env = installFakeXEnvironment(server);
  try {
    const response = await fetch(
      `https://x.com/i/api/graphql/wrong-doc/${OPERATION}?variables=${encodeURIComponent("{}")}`
    );
    assert.equal(response.status, 404);
  } finally {
    env.restore();
  }
});

test("installFakeXEnvironment's fake chrome.storage.local round-trips get/set/remove", async () => {
  const server = createFakeXRosterServer({
    members: makeMembers(5),
    pageSize: 5,
    chainPageCap: 10,
    documentId: DOCUMENT_ID,
    operation: OPERATION,
  });
  const env = installFakeXEnvironment(server);
  try {
    await chrome.storage.local.set({ a: 1, b: 2 });
    assert.deepEqual(await chrome.storage.local.get(["a", "b", "missing"]), { a: 1, b: 2 });
    await chrome.storage.local.remove("a");
    assert.deepEqual(await chrome.storage.local.get(["a", "b"]), { b: 2 });
    assert.deepEqual(await chrome.cookies.get({ url: "https://x.com", name: "ct0" }), { value: "fake-ct0-token" });
  } finally {
    env.restore();
  }
});
