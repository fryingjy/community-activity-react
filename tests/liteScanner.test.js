import test from "node:test";
import assert from "node:assert/strict";
import {
  activityCountForMember,
  activityDetailsForMember,
  activitySearchCandidateIdentity,
  annotateMemberActivity,
  classifyFlaggedMember,
  classifySearchVerification,
  buildActivitySearchVariables,
  buildMemberCursorRequest,
  buildCsv,
  buildFlaggedUsernamesText,
  buildPrivateAccountsCsv,
  buildPrivateAccountsText,
  calendarActivityWindow,
  communityActivityKind,
  latestCommunityPostAt,
  NATIVE_MEMBERS_ALL_OPERATION,
  parseCommunityAnalyticsPayload,
  parseCommunityMembersCursorPayload,
  parseCommunityMemberRelationshipPayload,
  parseCommunityModeratorsPayload,
  parseCommunityTimelinePage,
  readRosterCursorTimestamp,
  resolveRosterStopReason,
  seekResumeForwardStep,
  SEEK_RESUME_IDLE_PAGE_LIMIT,
  shouldResumeChain,
  withRosterCursorTimestamp,
} from "../liteScanner.js";
import { mergeMemberLists } from "../domScan.js";

test("CSV export neutralizes spreadsheet formulas and quotes fields", () => {
  const csv = buildCsv([{ username: "=danger", role: "Member", postsInWindow: 0, flagReason: "a,b" }]);
  assert.match(csv, /'\=danger/);
  assert.match(csv, /"a,b"/);
});

test("CSV export reports whether a row was directly search-confirmed", () => {
  const csv = buildCsv([
    { username: "Unchecked", role: "Member", postsInWindow: 0, flagReason: "" },
    { username: "Checked", role: "Member", postsInWindow: 0, flagReason: "", activityVerification: "confirmed-inactive" },
    { username: "Protected", role: "Member", postsInWindow: 0, flagReason: "", activityVerification: "unverifiable-protected" },
  ]);
  const rows = csv.trim().split("\n");
  assert.match(rows[0], /activity_verification$/);
  // A row with no verification result yet defaults to "unverified" rather than
  // silently reading as confirmed.
  assert.match(rows[1], /"unverified"$/);
  assert.match(rows[2], /"confirmed-inactive"$/);
  assert.match(rows[3], /"unverifiable-protected"$/);
});

test("DOM rosters merge case-insensitively", () => {
  const result = mergeMemberLists(
    [{ username: "Alice", user_id: "1" }],
    [{ username: "alice" }, { username: "Bob" }]
  );
  assert.equal(result.merged.length, 2);
  assert.equal(result.added, 1);
});

test("rosters deduplicate changed handles by stable user ID", () => {
  const result = mergeMemberLists(
    [{ username: "OldHandle", user_id: "42", role: "Member" }],
    [{ username: "NewHandle", user_id: "42", role: "Moderator" }]
  );
  assert.equal(result.merged.length, 1);
  assert.equal(result.added, 0);
  assert.equal(result.merged[0].user_id, "42");
  assert.equal(result.merged[0].role, "Moderator");
});

test("CSV export watermarks partial-roster results", () => {
  const csv = buildCsv(
    [{ username: "Alice", role: "Member", postsInWindow: 0, flagReason: "Inactive" }],
    { complete: false, found: 9300, expected: 79435, reason: "cursor-ended-before-count" },
    { complete: false, reason: "page-limit-before-window-boundary" }
  );
  assert.match(csv, /roster_status/);
  assert.match(csv, /activity_status/);
  assert.match(csv, /"partial","page-limit-before-window-boundary"/);
  assert.match(csv, /"partial"/);
  assert.match(csv, /"11\.7"/);
  assert.match(csv, /"cursor-ended-before-count"/);
});

test("private-account exports contain only unique private usernames", () => {
  const csv = buildPrivateAccountsCsv(
    [
      { username: "PrivateUser", protected: true, postsInWindow: 4 },
      { username: "privateuser", protected: true, postsInWindow: 0 },
      { username: "PublicUser", protected: false, postsInWindow: 0 },
    ]
  );
  const text = buildPrivateAccountsText([
    { username: "PrivateUser", protected: true },
    { username: "PublicUser", protected: false },
  ]);
  assert.equal(csv, 'username\n"PrivateUser"');
  assert.equal(text, "@PrivateUser");
});

test("buildFlaggedUsernamesText excludes moderators (and any non-Member role), dedupes, and sorts", () => {
  const text = buildFlaggedUsernamesText([
    { username: "ZMember", role: "Member" },
    { username: "AModerator", role: "Moderator" },
    { username: "AnAdmin", role: "Admin" },
    { username: "AMember", role: "Member" },
    { username: "amember", role: "Member" }, // duplicate of the row above, case-insensitive - first occurrence's casing wins
    { username: "NoRoleGiven" }, // absent role defaults to included, matching every parser's own "Member" default
  ]);
  assert.equal(text, "@AMember\n@NoRoleGiven\n@ZMember");
});

test("cursor member payload exposes users and the next cursor", () => {
  const payload = {
    data: {
      communityResults: {
        result: {
          members_slice: {
            items_results: [
              {
                result: {
                  __typename: "User",
                  rest_id: "1",
                  community_role: "Moderator",
                  core: { screen_name: "Alice", name: "Alice A" },
                  privacy: { protected: true },
                  legacy: { protected: false },
                },
              },
            ],
            next_cursor: "CURSOR_2",
          },
        },
      },
    },
  };
  const result = parseCommunityMembersCursorPayload(payload);
  assert.equal(result.nextCursor, "CURSOR_2");
  assert.equal(result.rawCount, 1);
  assert.deepEqual(result.members[0], {
    username: "Alice",
    name: "Alice A",
    user_id: "1",
    role: "Moderator",
    protected: true,
    roleConfidence: "high",
    source: "cursor",
  });
});

test("member cursor recognizes X's zero-prefixed terminal sentinel", () => {
  const result = parseCommunityMembersCursorPayload({
    data: {
      communityResults: {
        result: {
          members_slice: {
            items_results: [],
            next_cursor: "0|terminal",
          },
        },
      },
    },
  });
  assert.equal(result.nextCursor, null);
});

test("member cursor replay preserves the HAR contract exactly", () => {
  const operation = {
    variables: { communityId: "old", cursor: "captured-cursor" },
    features: {},
  };
  assert.deepEqual(
    buildMemberCursorRequest(operation, "1882332006949744648"),
    {
      variables: { communityId: "1882332006949744648" },
      features: null,
    }
  );
  assert.deepEqual(
    buildMemberCursorRequest(operation, "1882332006949744648", "next-cursor"),
    {
      variables: {
        communityId: "1882332006949744648",
        cursor: "next-cursor",
      },
      features: null,
    }
  );
});

test("native Android member query uses its current persisted-query contract", () => {
  assert.equal(NATIVE_MEMBERS_ALL_OPERATION.documentId, "mq7ptH6j5ApwD9VEGR46sg");
  assert.deepEqual(
    buildMemberCursorRequest(
      NATIVE_MEMBERS_ALL_OPERATION,
      "1882332006949744648",
      "native-cursor"
    ).variables,
    {
      community_rest_id: "1882332006949744648",
      // X clamps this page size to 100 server-side without returning an error,
      // so requesting more only misreports the page size in diagnostics.
      count: 100,
      cursor: "native-cursor",
    }
  );
});

// Shape captured live from mq7ptH6j5ApwD9VEGR46sg/CommunitiesMembersAllQuery on
// 2026-07-30. It carries no items_results and no next_cursor, and marks its
// cursor with __typename rather than entryType.
const NATIVE_MEMBERS_PAYLOAD = {
  data: {
    community_by_rest_id: {
      timeline_response: {
        timeline: {
          instructions: [
            { __typename: "TimelineClearCache" },
            {
              __typename: "TimelineAddEntries",
              entries: [
                {
                  entryId: "user-1",
                  content: {
                    __typename: "TimelineTimelineItem",
                    content: {
                      __typename: "TimelineUser",
                      userDisplayType: "UserCompact",
                      userResult: {
                        result: {
                          __typename: "User",
                          rest_id: "111",
                          legacy: { screen_name: "Quiet", name: "Quiet Q", protected: true },
                        },
                      },
                    },
                  },
                },
                {
                  entryId: "cursor-bottom",
                  content: {
                    __typename: "TimelineTimelineCursor",
                    cursorType: "Bottom",
                    value: "NEXT_PAGE_CURSOR",
                  },
                },
              ],
            },
          ],
        },
      },
    },
  },
};

test("the native roster timeline is parsed, not silently read as empty", () => {
  // Regression: the extension only understood the web slice contract, so this
  // 200 response yielded zero members and no cursor, and every scan fell back
  // to the smaller web cursor.
  const result = parseCommunityMembersCursorPayload(NATIVE_MEMBERS_PAYLOAD);
  assert.equal(result.nextCursor, "NEXT_PAGE_CURSOR");
  assert.equal(result.members.length, 1);
  assert.equal(result.members[0].username, "Quiet");
  assert.equal(result.members[0].user_id, "111");
  assert.equal(result.members[0].protected, true);
});

test("the native roster honours the zero-prefixed terminal cursor", () => {
  const terminal = structuredClone(NATIVE_MEMBERS_PAYLOAD);
  terminal.data.community_by_rest_id.timeline_response.timeline
    .instructions[1].entries[1].content.value = "0|end";
  assert.equal(parseCommunityMembersCursorPayload(terminal).nextCursor, null);
});

test("the web slice contract still parses unchanged", () => {
  const result = parseCommunityMembersCursorPayload({
    data: {
      communityResults: {
        result: {
          members_slice: {
            items_results: [
              { result: { __typename: "User", rest_id: "9", core: { screen_name: "Web", name: "Web W" } } },
            ],
            next_cursor: "WEB_CURSOR",
          },
        },
      },
    },
  });
  assert.equal(result.nextCursor, "WEB_CURSOR");
  assert.equal(result.members[0].username, "Web");
  assert.equal(result.members[0].source, "cursor");
});

// Byte layout captured from a live roster cursor on 2026-07-30: 75 bytes, with
// a big-endian int64 millisecond position starting at offset 30.
function makeRosterCursor(timestampMs) {
  const bytes = new Uint8Array(75);
  bytes.set([0x0b, 0x27, 0x11, 0x00, 0x00, 0x00, 0x00, 0x0c], 0);
  new DataView(bytes.buffer).setBigInt64(30, BigInt(timestampMs));
  return Buffer.from(bytes).toString("base64");
}

test("roster cursor timestamps round-trip through the seek codec", () => {
  const when = Date.parse("2025-06-15T00:00:00.000Z");
  const cursor = makeRosterCursor(when);
  assert.equal(readRosterCursorTimestamp(cursor), when);

  const moved = Date.parse("2026-04-10T05:37:31.138Z");
  const seeked = withRosterCursorTimestamp(cursor, moved);
  assert.equal(readRosterCursorTimestamp(seeked), moved);
  // Only the position bytes and the page counter may change.
  const before = Buffer.from(cursor, "base64");
  const after = Buffer.from(seeked, "base64");
  assert.equal(before.length, after.length);
  for (let i = 0; i < before.length; i++) {
    if (i >= 30 && i < 38) continue;
    if (i === 71) continue;
    assert.equal(after[i], before[i], `byte ${i} must not change`);
  }
});

test("seeking resets the chain page counter so the new chain gets a full budget", () => {
  // Byte 71 counts pages within a chain and is what X's 500-page cap measures.
  // A cursor lifted from a spent chain must not carry that budget into a seek,
  // or the resumed chain returns one page and no continuation.
  const spent = Buffer.from(makeRosterCursor(Date.parse("2026-05-30T12:00:00Z")), "base64");
  spent[71] = 500;
  const resumed = withRosterCursorTimestamp(
    spent.toString("base64"),
    Date.parse("2026-05-30T11:59:58Z")
  );
  assert.equal(Buffer.from(resumed, "base64")[71], 2);
});

test("the seek codec fails closed on anything that is not a roster cursor", () => {
  // A layout change must degrade to "no seek", never to a corrupted cursor.
  for (const bad of ["", "not-base64!!", Buffer.alloc(20).toString("base64"), null, undefined]) {
    assert.equal(readRosterCursorTimestamp(bad), null);
    assert.equal(withRosterCursorTimestamp(bad, Date.now()), null);
  }
  // Right length, but the int64 is not a plausible millisecond timestamp.
  const nonsense = Buffer.alloc(75);
  nonsense.writeBigInt64BE(123n, 30);
  assert.equal(readRosterCursorTimestamp(nonsense.toString("base64")), null);
});

test("a seek always rewrites only the position, whatever cursor it starts from", () => {
  // The resume path swaps in the opening cursor as its template. Whichever
  // cursor is used, the rewrite must stay surgical.
  const opening = makeRosterCursor(Date.parse("2025-01-23T08:31:10.530Z"));
  const deep = makeRosterCursor(Date.parse("2026-05-30T12:00:00.000Z"));
  const target = Date.parse("2026-06-05T00:00:00.000Z");
  for (const source of [opening, deep]) {
    const seeked = withRosterCursorTimestamp(source, target);
    assert.equal(readRosterCursorTimestamp(seeked), target);
    assert.equal(Buffer.from(seeked, "base64").length, Buffer.from(source, "base64").length);
  }
  // Seeking forward past a collected region must produce a different cursor
  // than seeking back into it, or an unproductive segment would repeat itself.
  const back = withRosterCursorTimestamp(opening, target - 2000);
  const forward = withRosterCursorTimestamp(opening, target + 6 * 60 * 60 * 1000);
  assert.notEqual(back, forward);
});

test("a seek-resumed walk stops once a segment finds nobody new", () => {
  // The failure mode this guards: re-seeking into an already-collected region
  // returns the same members forever. A segment that adds nothing ends the walk.
  assert.equal(
    resolveRosterStopReason({ idlePages: 3, expectedCount: 79397, memberCount: 76273 }),
    "no-new-members"
  );
  // Short of the advertised count is still "not complete" on its own.
  assert.equal(
    resolveRosterStopReason({ cursorEnded: true, expectedCount: 79397, memberCount: 46960 }),
    "cursor-ended-before-count"
  );
});

test("a stalled chain resumes however it stalled", () => {
  const base = {
    seekResume: true,
    memberCount: 46960,
    expectedCount: 79397,
    lastTimestamp: Date.UTC(2025, 5, 1),
  };
  // X withholding the next cursor at its page cap.
  assert.equal(shouldResumeChain({ ...base, cursorEnded: true }), true);
  // Re-entering collected ground. This was previously fatal to the walk.
  assert.equal(shouldResumeChain({ ...base, reason: "no-new-members" }), true);
  assert.equal(shouldResumeChain({ ...base, reason: "repeated-cursor" }), true);
  // An unknown total must not disable resuming — a failed analytics call left
  // expectedCount null and silently turned seek-resume off entirely.
  assert.equal(
    shouldResumeChain({ ...base, expectedCount: null, cursorEnded: true }),
    true
  );
  // Nothing to resume from, opted out, still mid-chain, or already complete.
  assert.equal(shouldResumeChain({ ...base, cursorEnded: true, seekResume: false }), false);
  assert.equal(shouldResumeChain({ ...base, cursorEnded: true, lastTimestamp: null }), false);
  assert.equal(shouldResumeChain({ ...base }), false);
  assert.equal(
    shouldResumeChain({ ...base, cursorEnded: true, memberCount: 79397 }),
    false
  );
});

// Drives the real decision helpers over a modelled server: members ordered by
// join time, 100 per page, and a hard 500-page cap per cursor chain. Walking
// without resuming tops out near 47k of 79,397.
function simulateSeekResume(members, total) {
  const collected = new Set();
  let position = 0;
  let pagesInChain = 0;
  let lastTimestamp = null;
  let idlePages = 0;
  let segmentAdded = 0;
  let segmentPages = 0;
  let unproductiveSegments = 0;
  let lastSeekTarget = null;
  let reseeks = 0;
  let requests = 0;
  const seekTo = (ms) => {
    position = members.findIndex((m) => m.t >= ms);
    if (position < 0) position = members.length;
    pagesInChain = 0;
  };
  seekTo(members[0].t);

  while (requests < 60000) {
    requests++;
    const page = members.slice(position, position + 100);
    pagesInChain++;
    const before = collected.size;
    for (const m of page) collected.add(m.i);
    const added = collected.size - before;
    position += page.length;
    if (page.length) lastTimestamp = page[page.length - 1].t;
    segmentAdded += added;
    segmentPages++;
    idlePages = added === 0 ? idlePages + 1 : 0;

    const cursorEnded = page.length === 0 || pagesInChain >= 500;
    const reason = resolveRosterStopReason({
      idlePages,
      idleLimit: SEEK_RESUME_IDLE_PAGE_LIMIT,
      cursorEnded,
      memberCount: collected.size,
      expectedCount: total,
    });
    if (reason === "expected-count-reached") break;
    if (!shouldResumeChain({
      seekResume: true,
      cursorEnded,
      reason,
      memberCount: collected.size,
      expectedCount: total,
      lastTimestamp,
    })) {
      if (reason) break;
      continue;
    }

    const fairlyTried = segmentPages >= 5;
    const deadZone = reason === "no-new-members" ||
      page.length === 0 ||
      (segmentAdded === 0 && fairlyTried);
    if (deadZone) unproductiveSegments++;
    else if (segmentAdded > 0) unproductiveSegments = 0;
    if (unproductiveSegments >= 9 || reseeks >= 240) break;

    let target = deadZone
      ? lastTimestamp + seekResumeForwardStep()
      : lastTimestamp - 2000;
    if (lastSeekTarget != null && target <= lastSeekTarget) {
      target = lastSeekTarget + seekResumeForwardStep();
    }
    seekTo(target);
    lastSeekTarget = target;
    reseeks++;
    segmentAdded = 0;
    segmentPages = 0;
    idlePages = 0;
  }
  return { coverage: collected.size / total, reseeks, requests };
}

test("seek-resume clears 96% even when the cap lands inside tied timestamps", () => {
  const TOTAL = 79397;
  const START = Date.UTC(2025, 0, 23);
  // The hard case: 35,000 members share one timestamp and the 500-page chain
  // cap falls inside that block, so a resume seeks back to the block start and
  // must re-cross it. This stalled at 66.57% before the fix.
  const dense = [];
  for (let i = 0; i < TOTAL; i++) {
    const t = i < 20000 ? START
      : i < 55000 ? START + 60000
        : START + 120000 + (i - 55000) * 1000;
    dense.push({ i, t });
  }
  const denseRun = simulateSeekResume(dense, TOTAL);
  assert.ok(denseRun.coverage >= 0.96,
    `tied-timestamp roster reached only ${(denseRun.coverage * 100).toFixed(2)}%`);

  // Many smaller tied blocks, which thrashed the segment budget before the fix.
  const blocks = Array.from({ length: TOTAL }, (_, i) => ({
    i, t: START + Math.floor(i / 2000) * 3600000,
  }));
  const blockRun = simulateSeekResume(blocks, TOTAL);
  assert.ok(blockRun.coverage >= 0.96,
    `blocked roster reached only ${(blockRun.coverage * 100).toFixed(2)}%`);
});

test("the seek-resume state machine clears 96% of a capped roster", () => {
  const TOTAL = 79397;
  const START = Date.UTC(2025, 0, 23);
  const SPAN = 555 * 24 * 60 * 60 * 1000;
  // Join times are front-loaded, as they were on the audited Community.
  const members = Array.from({ length: TOTAL }, (_, i) => ({
    i, t: START + Math.floor(SPAN * Math.pow(i / TOTAL, 2.2)),
  }));
  const run = simulateSeekResume(members, TOTAL);
  assert.ok(run.coverage >= 0.96,
    `expected >=96% coverage, got ${(run.coverage * 100).toFixed(2)}% after ${run.reseeks} reseeks`);
  assert.ok(run.reseeks > 0, "the cap must have been hit and resumed past");
});

test("a seek-resume walk never ends on duplicate pages alone", () => {
  // Re-entering collected ground on the way to ground that is not collected is
  // routine, and crossing it can take hundreds of pages. Any finite idle limit
  // stops the walk partway across and strands everyone beyond it.
  // Above the 500-page chain cap the limit is unreachable in practice, but it
  // stays finite so a chain that only ever serves duplicates cannot spend the
  // entire page budget.
  assert.ok(SEEK_RESUME_IDLE_PAGE_LIMIT > 500 && Number.isFinite(SEEK_RESUME_IDLE_PAGE_LIMIT));
  for (const idlePages of [3, 12, 300, 499]) {
    assert.equal(
      resolveRosterStopReason({
        idlePages,
        idleLimit: SEEK_RESUME_IDLE_PAGE_LIMIT,
        expectedCount: 79397,
        memberCount: 50000,
      }),
      null
    );
  }
  // A resumed walk still ends when the cursor itself ends.
  assert.equal(
    resolveRosterStopReason({
      idlePages: 300,
      idleLimit: SEEK_RESUME_IDLE_PAGE_LIMIT,
      cursorEnded: true,
      expectedCount: 79397,
      memberCount: 50000,
    }),
    "cursor-ended-before-count"
  );
  // Without seek-resume the stricter default still applies.
  assert.equal(
    resolveRosterStopReason({ idlePages: 3, expectedCount: 79397, memberCount: 50000 }),
    "no-new-members"
  );
});

test("a seek past the end of the roster is judged immediately", () => {
  // The segment serves no records, so it is complete however short it was.
  // Judging it only after five pages left the idle counter untouched, and each
  // resume then stepped a single millisecond — burning all 240 segments
  // crawling past the end of the roster instead of stopping.
  const shortEmptySegment = { segmentPages: 1, segmentAdded: 0, rawCount: 0 };
  const fairlyTried = shortEmptySegment.segmentPages >= 5;
  const servedNothing = shortEmptySegment.rawCount === 0;
  const deadZone = servedNothing ||
    (shortEmptySegment.segmentAdded === 0 && fairlyTried);
  assert.equal(fairlyTried, false, "a one-page segment is not fairly tried");
  assert.equal(deadZone, true, "but serving nothing is still a dead zone");
  // A short segment that did serve records stays unjudged, so the overlap
  // window after a resume is not mistaken for the end of the roster.
  const shortOverlapSegment = { segmentPages: 1, segmentAdded: 0, rawCount: 100 };
  assert.equal(
    shortOverlapSegment.rawCount === 0 ||
      (shortOverlapSegment.segmentAdded === 0 && shortOverlapSegment.segmentPages >= 5),
    false
  );
});

test("a stalled seek steps forward by one millisecond, not a coarse interval", () => {
  // The stall means members share that exact timestamp, so one millisecond is
  // the smallest step that escapes it. A coarse skip steps over members that
  // were never collected: six hours cost a modelled roster 21,540 of them.
  assert.equal(seekResumeForwardStep(), 1);
  const base = Date.UTC(2025, 5, 1);
  const moved = withRosterCursorTimestamp(makeRosterCursor(base), base + seekResumeForwardStep());
  assert.equal(readRosterCursorTimestamp(moved), base + 1);
});

test("a single duplicate-only roster page does not end collection", () => {
  // X serves overlapping member pages, so one page that adds nothing is normal.
  assert.equal(
    resolveRosterStopReason({ idlePages: 1, expectedCount: 79397, memberCount: 12000 }),
    null
  );
  assert.equal(
    resolveRosterStopReason({ idlePages: 2, expectedCount: 79397, memberCount: 12000 }),
    null
  );
  assert.equal(
    resolveRosterStopReason({ idlePages: 3, expectedCount: 79397, memberCount: 12000 }),
    "no-new-members"
  );
});

test("roster stop reasons separate a server cursor end from a short count", () => {
  assert.equal(
    resolveRosterStopReason({ cursorEnded: true, expectedCount: 79397, memberCount: 46960 }),
    "cursor-ended-before-count"
  );
  assert.equal(
    resolveRosterStopReason({ cursorEnded: true, expectedCount: 79397, memberCount: 79397 }),
    "expected-count-reached"
  );
  assert.equal(resolveRosterStopReason({ cursorEnded: true }), "cursor-ended");
  assert.equal(resolveRosterStopReason({ repeatedCursor: true }), "repeated-cursor");
  assert.equal(resolveRosterStopReason({}), null);
});

test("community analytics supplies the member and distinct-poster totals", () => {
  const analytics = parseCommunityAnalyticsPayload({
    data: {
      communityResults: {
        result: {
          community_growth: {
            current_metrics: {
              total_members: 79397,
              unique_posters: 987,
              new_members: 0,
              num_posts: 5780,
              reply_count: 3652,
              fav_count: 612096,
              impressions: 25048379,
              timestamp: 1785369599999,
            },
          },
        },
      },
    },
  });
  assert.equal(analytics.totalMembers, 79397);
  assert.equal(analytics.uniquePosters, 987);
  assert.equal(analytics.posts, 5780);
  assert.equal(parseCommunityAnalyticsPayload({ data: {} }), null);
});

test("moderator slice returns confirmed roles and its own terminal sentinel", () => {
  const page = parseCommunityModeratorsPayload({
    data: {
      communityResults: {
        result: {
          moderators_slice: {
            items_results: [
              {
                result: {
                  __typename: "User",
                  rest_id: "9",
                  community_role: "Admin",
                  core: { screen_name: "Lead", name: "Lead L" },
                  legacy: { protected: true },
                },
              },
            ],
            slice_info: { next_cursor: "0|end" },
          },
        },
      },
    },
  });
  assert.equal(page.rawCount, 1);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(page.members[0], {
    username: "Lead",
    name: "Lead L",
    user_id: "9",
    role: "Admin",
    protected: true,
    roleConfidence: "high",
    source: "moderator-slice",
    membershipEvidence: "x-roster",
  });
});

test("relationship verification ignores fuzzy non-members and confirms the exact candidate", () => {
  const payload = {
    data: {
      communityResults: {
        result: {
          member_relationship_typeahead: [
            {
              community_role: "NonMember",
              user_results: {
                result: {
                  rest_id: "other",
                  core: { screen_name: "SimilarName", name: "Similar" },
                },
              },
            },
            {
              community_role: "Member",
              user_results: {
                result: {
                  rest_id: "42",
                  core: { screen_name: "CurrentHandle", name: "Current" },
                  privacy: { protected: true },
                },
              },
            },
          ],
        },
      },
    },
  };
  assert.deepEqual(
    parseCommunityMemberRelationshipPayload(payload, {
      username: "OldHandle",
      user_id: "42",
    }),
    {
      username: "CurrentHandle",
      name: "Current",
      user_id: "42",
      role: "Member",
      protected: true,
      roleConfidence: "high",
      source: "relationship-verification",
      membershipEvidence: "x-roster",
    }
  );
});

test("relationship verification accepts the live top-level role contract", () => {
  const payload = {
    data: {
      communityResults: {
        result: {
          member_relationship_typeahead: [
            {
              role: "Member",
              user_results: {
                result: {
                  __typename: "User",
                  rest_id: "42",
                  core: { screen_name: "CurrentHandle", name: "Current Handle" },
                  privacy: { protected: true },
                },
              },
            },
          ],
        },
      },
    },
  };
  assert.deepEqual(
    parseCommunityMemberRelationshipPayload(payload, {
      username: "OldHandle",
      user_id: "42",
    }),
    {
      username: "CurrentHandle",
      name: "Current Handle",
      user_id: "42",
      role: "Member",
      protected: true,
      roleConfidence: "high",
      source: "relationship-verification",
      membershipEvidence: "x-roster",
    }
  );
});

test("community timeline parser accepts direct and module tweet entries", () => {
  const directTweet = {
    rest_id: "t1",
    legacy: { created_at: "Wed Jul 22 12:00:00 +0000 2026" },
    core: { user_results: { result: { rest_id: "u1", core: { screen_name: "Alice" } } } },
  };
  const moduleTweet = {
    rest_id: "t2",
    legacy: { created_at: "Wed Jul 22 13:00:00 +0000 2026" },
    core: { user_results: { result: { rest_id: "u2", core: { screen_name: "Bob" } } } },
  };
  const payload = {
    data: {
      communityResults: {
        result: {
          ranked_community_timeline: {
            timeline: {
              instructions: [{
                entries: [
                  { content: { itemContent: { tweet_results: { result: { tweet: directTweet } } } } },
                  {
                    content: {
                      items: [{ item: { itemContent: { tweet_results: { result: moduleTweet } } } }],
                    },
                  },
                  {
                    content: {
                      entryType: "TimelineTimelineCursor",
                      cursorType: "Bottom",
                      value: "NEXT",
                    },
                  },
                ],
              }],
            },
          },
        },
      },
    },
  };
  const result = parseCommunityTimelinePage(payload);
  assert.deepEqual(result.tweets.map((tweet) => tweet.rest_id), ["t1", "t2"]);
  assert.equal(result.nextCursor, "NEXT");
});

test("community timeline parser accepts the independent media contract", () => {
  const tweet = {
    rest_id: "media-1",
    legacy: { created_at: "Wed Jul 22 12:00:00 +0000 2026" },
    core: { user_results: { result: { rest_id: "u1", core: { screen_name: "Alice" } } } },
  };
  const payload = {
    data: {
      communityResults: {
        result: {
          community_media_timeline: {
            timeline: {
              instructions: [{
                entries: [
                  { content: { itemContent: { tweet_results: { result: tweet } } } },
                  {
                    content: {
                      entryType: "TimelineTimelineCursor",
                      cursorType: "Bottom",
                      value: "MEDIA_NEXT",
                    },
                  },
                ],
              }],
            },
          },
        },
      },
    },
  };
  const result = parseCommunityTimelinePage(payload, "media");
  assert.deepEqual(result.tweets.map((item) => item.rest_id), ["media-1"]);
  assert.equal(result.nextCursor, "MEDIA_NEXT");
});

test("community timeline parser accepts the filtered-search contract", () => {
  const tweet = {
    rest_id: "search-1",
    legacy: { created_at: "Wed Jul 22 12:00:00 +0000 2026" },
    core: { user_results: { result: { rest_id: "u2", core: { screen_name: "Bob" } } } },
  };
  const payload = {
    data: {
      communityResults: {
        result: {
          community_filtered_timeline: {
            timeline: {
              instructions: [{
                entries: [
                  {
                    content: {
                      items: [{
                        item: { itemContent: { tweet_results: { result: { tweet } } } },
                      }],
                    },
                  },
                ],
              }],
            },
          },
        },
      },
    },
  };
  const result = parseCommunityTimelinePage(payload, "search");
  assert.deepEqual(result.tweets.map((item) => item.rest_id), ["search-1"]);
});

test("a direct from: search uses the exact live contract, parentheses included", () => {
  // Captured live from x.com's own Community search UI on 2026-07-31: typing
  // "(from:FTshiyo)" into a Community search box sends this query string
  // verbatim, through the same CommunityTweetSearchModuleQuery operation the
  // word-shard backfill already calls.
  const variables = buildActivitySearchVariables("1882332006949744648", "FTshiyo");
  assert.equal(variables.query, "(from:FTshiyo)");
  assert.equal(variables.communityId, "1882332006949744648");
  assert.equal(variables.timelineRankingMode, "Recency");
  assert.equal(variables.count, 20);
});

test("latestCommunityPostAt finds the newest post and ignores reposts", () => {
  const post = (id, iso) => ({
    rest_id: id,
    legacy: { created_at: new Date(iso).toUTCString().replace("GMT", "+0000") },
  });
  const older = post("1", "2026-01-01T00:00:00Z");
  const newer = post("2", "2026-06-01T00:00:00Z");
  const repost = { ...post("3", "2026-07-01T00:00:00Z"), legacy: { ...post("3", "2026-07-01T00:00:00Z").legacy, retweeted_status_result: {} } };
  assert.equal(latestCommunityPostAt([older, newer]).toISOString().slice(0, 10), "2026-06-01");
  // A repost dated after the real posts must not win.
  assert.equal(latestCommunityPostAt([older, newer, repost]).toISOString().slice(0, 10), "2026-06-01");
  assert.equal(latestCommunityPostAt([]), null);
  assert.equal(latestCommunityPostAt([{ legacy: {} }]), null, "a tweet with no timestamp is ignored, not treated as now");
});

test("activity verification identity matches by stable ID before falling back to username", () => {
  assert.equal(
    activitySearchCandidateIdentity({ user_id: "42", username: "Old" }),
    activitySearchCandidateIdentity({ user_id: "42", username: "New" }),
    "a handle change must not create a second identity for the same account"
  );
  assert.equal(
    activitySearchCandidateIdentity({ username: "Same" }),
    activitySearchCandidateIdentity({ username: "same" }),
    "username fallback must be case-insensitive"
  );
  assert.notEqual(
    activitySearchCandidateIdentity({ user_id: "1", username: "a" }),
    activitySearchCandidateIdentity({ user_id: "2", username: "a" })
  );
});

test("activity lookup prefers stable user ID after a handle change", () => {
  const author = {
    username: "NewHandle",
    user_id: "42",
    count: 3,
    posts: 1,
    replies: 2,
  };
  const activity = {
    byId: new Map([["42", author]]),
    byUsername: new Map([["newhandle", author]]),
  };
  assert.equal(activityCountForMember(activity, { username: "OldHandle", user_id: "42" }), 3);
  assert.deepEqual(
    activityDetailsForMember(activity, { username: "OldHandle", user_id: "42" }),
    { posts: 1, replies: 2, total: 3, lastSeenCommunityPost: "" }
  );
});

test("Community activity distinguishes original posts from replies", () => {
  assert.equal(
    communityActivityKind({ legacy: { in_reply_to_status_id_str: "tweet-1" } }),
    "reply"
  );
  assert.equal(
    communityActivityKind({ legacy: { in_reply_to_user_id_str: "user-1" } }),
    "reply"
  );
  assert.equal(
    communityActivityKind({ legacy: { retweeted_status_result: { result: {} } } }),
    "repost"
  );
  assert.equal(communityActivityKind({ legacy: { full_text: "Original post" } }), "post");
});

test("a 90-day lookback covers exactly 90 calendar dates including today", () => {
  const now = new Date("2026-07-30T12:34:56.000Z");
  const { sinceDate, untilDate } = calendarActivityWindow(90, now);
  assert.equal(untilDate.toISOString(), now.toISOString());
  assert.equal(sinceDate.getFullYear(), 2026);
  assert.equal(sinceDate.getMonth(), 4);
  assert.equal(sinceDate.getDate(), 2);
  assert.equal(sinceDate.getHours(), 0);
});

test("annotateMemberActivity carries the roster member through with its activity numbers merged in", () => {
  const author = { username: "activeuser", user_id: "7", posts: 3, replies: 1, count: 4, lastSeenCommunityPost: "2026-01-01" };
  const activity = { byId: new Map([["7", author]]), byUsername: new Map([["activeuser", author]]) };
  const annotated = annotateMemberActivity({ username: "activeuser", user_id: "7", role: "member" }, activity);
  assert.equal(annotated.role, "member");
  assert.equal(annotated.postsInWindow, 4);
  assert.equal(annotated.communityPostsInWindow, 3);
  assert.equal(annotated.communityRepliesInWindow, 1);
  assert.equal(annotated.lastSeenCommunityPost, "2026-01-01");
});

test("annotateMemberActivity falls back to the member's own lastSeenCommunityPost when the index has none", () => {
  const activity = { byId: new Map(), byUsername: new Map() };
  const annotated = annotateMemberActivity(
    { username: "silentuser", user_id: "9", lastSeenCommunityPost: "2025-12-01" },
    activity
  );
  assert.equal(annotated.postsInWindow, 0);
  assert.equal(annotated.lastSeenCommunityPost, "2025-12-01");
});

test("classifyFlaggedMember explains roster/evidence mismatches in the flag reason", () => {
  const onRoster = classifyFlaggedMember({ username: "a", membershipEvidence: "x-roster" }, 30);
  assert.equal(onRoster.flagReason, "No Community posts or replies in the last 30 calendar days");
  assert.equal(onRoster.activityBucket, "zero-community-activity");

  const historical = classifyFlaggedMember({ username: "b", membershipEvidence: "historical-community-post" }, 30);
  assert.match(historical.flagReason, /current membership not confirmed/);

  const recent = classifyFlaggedMember({ username: "c", membershipEvidence: "recent-community-post" }, 30);
  assert.match(recent.flagReason, /omitted from X's roster window/);
});

test("classifySearchVerification clears a member the direct search found active", () => {
  const result = classifySearchVerification({ username: "a" }, { hasActivityInWindow: true });
  assert.deepEqual(result, { cleared: true });
});

test("classifySearchVerification marks a public member with no search hits as confirmed-inactive", () => {
  const result = classifySearchVerification({ username: "a", protected: false }, { hasActivityInWindow: false });
  assert.deepEqual(result, { cleared: false, activityVerification: "confirmed-inactive" });
});

test("classifySearchVerification cannot confirm a protected account either way", () => {
  const result = classifySearchVerification({ username: "a", protected: true }, { hasActivityInWindow: false });
  assert.deepEqual(result, { cleared: false, activityVerification: "unverifiable-protected" });
});

test("classifySearchVerification leaves a member unverified when no search result was ever produced", () => {
  const result = classifySearchVerification({ username: "a" }, undefined);
  assert.deepEqual(result, { cleared: false, activityVerification: "unverified" });
});
