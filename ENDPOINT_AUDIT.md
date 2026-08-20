# X Community roster endpoint audit

Audit date: 2026-07-27, revised 2026-07-30, 2026-08-20

## Live re-verification (2026-08-20)

A real signed-in session against the same reference Community
(`1882332006949744648`, "NMS HUB", still 79.1K members and fully public - see
the platform-status note below) was used to re-check every document ID this
project hardcodes as a fallback, by triggering each surface's real UI tab and
reading the resulting request URL.

| Operation | 2026-07-27 audit | 2026-08-20 observed | Status |
| --- | --- | --- | --- |
| `CommunityQuery` | `-ElI1vg3dYbttVMhBhGdLw` | `-ElI1vg3dYbttVMhBhGdLw` | unchanged |
| `membersSliceTimeline_Query` | `woAp_YdzAdqnWDrqLTNpAw` | `woAp_YdzAdqnWDrqLTNpAw` | unchanged |
| `CommunityAboutTimeline` | `zEwxuy-wFr9_C6lPW4xXmA` | `H-QOvucTlztqr3leGYpg7g` | **rotated - fixed in operations.js** |
| `CommunityTweetsTimeline` | `dD1uF9vQx0OX-e1rKA4YLw` | `EwftYyqQemkckQ0wzGM6uw` | rotated - fixed (fallback only; live-discovered in normal operation) |

`CommunityAboutTimeline` matters more than a routine rotation: unlike the
roster cursor and timeline operations, nothing in this codebase discovers it
live (no `discoverCommunityAboutOperation` exists; `aboutMembers.js`'s
`operation` parameter is never supplied by any call site). The stale ID meant
every scan's About-surface pass - the small but authoritative
moderator/featured-member evidence source - was silently failing, not merely
at risk of failing. Fixed directly in `src/api/operations.js`.

**Not yet re-verified this pass**, still resting on the 2026-07-27 values with
the same no-live-discovery exposure as `CommunityAboutTimeline` had:
`CommunityMediaTimeline`, `CommunityTweetSearchModuleQuery` (the operation
behind the `confirmed-inactive` direct-verification evidence tier - the export
this project treats as safe for automated action), `CommunityAnalyticsQuery`,
and `moderatorsSliceTimeline_Query`. Worth the same live check next.


Target observed: `1882332006949744648` (79,397 advertised members, per X's own
analytics operation)

## Conclusion

The public Members page, direct web GraphQL pagination, and browser-export
extensions all converge on X's `membersSliceTimeline_Query` cursor. For this
large Community, that source terminates at roughly 9,200–9,300 members. The
cursor ends server-side: the DOM has no remaining loading sentinel, document
height stops increasing, and direct pagination receives no usable next cursor.
More scroll events, background-throttling flags, request retries, or a larger
client-side page limit cannot create another cursor.

**Neither cursor is the ceiling.** The roster cursor is an unsigned base64
Thrift struct whose byte-30 int64 is a join-time seek position. Rewriting it
seeks anywhere in the roster and returns a valid continuation cursor, so the
500-page chain cap is not a roster limit. Seek-resuming reached **76,273
members (96.07%)** on the target Community, after which a 24-point sweep across
the entire join-time range returned zero further members. The remaining ~3,100
of the advertised 79,397 are counted but never served. See "Cursor seek" below.

**The web cursor is not the ceiling.** The 2026-07-30 measurement below shows
X's native `CommunitiesMembersAllQuery` reaching 46,960 unique members — about
five times the web cursor — before hitting its own separate server-side end.
Every statement elsewhere in this document that treats ~9,300 as the limit of
what a browser can enumerate describes the web slice only.

## Measured native-route termination (2026-07-30)

A signed-in walk of `mq7ptH6j5ApwD9VEGR46sg` / `CommunitiesMembersAllQuery` was
run to termination from the page context, 350 ms between requests:

| Measurement | Result |
| --- | --- |
| Pages walked | 501 |
| Unique members | 46,960 |
| Advertised total | 79,397 |
| Coverage | 59.15% |
| Records per page | 100 (hard server cap; `count:200` returns 100, no error) |
| Unique per page | ~91 after deduplication |
| Stop condition | response contained no `Bottom` cursor entry at all |
| Rate limiting | none observed across 500+ consecutive requests |

Re-issuing the final cursor reproduces the same terminal page — 100 users, HTTP
200, no `errors`, no cursor — so the stop is a deliberate server-side end and
not a transient failure.

Note the response contract, which differs from the web slice entirely and was
the cause of the 5.10.0 regression: there is **no `items_results` and no
`next_cursor`**. Members arrive as
`data.community_by_rest_id.timeline_response.timeline.instructions[].entries[]`
whose `content.content.__typename` is `TimelineUser`, and the continuation is an
entry with `__typename: "TimelineTimelineCursor"` and `cursorType: "Bottom"` —
`entryType` is absent. `count` is accepted with or without the Android feature
switches; both forms return HTTP 200. This resolves the open question recorded in the 5.4
section below: the native operation does advance far beyond the web cursor
cutoff, but it does not enumerate the full roster.

### Cursor seek (2026-07-30)

The 75-byte roster cursor decodes to base64 Thrift. Offset 30 begins a
big-endian int64 millisecond join-time position; consecutive pages differ only
at bytes 19–25, 35–37 and 71, and the byte-19 region proved inert — setting it
to `0x00` or `0xff` returned byte-identical results. Only the timestamp steers
the read.

| Seek | Result |
| --- | --- |
| base +30 days | 96 members from 2025-02-24, valid cursor, 0 overlap |
| base +180 days | 94 members from 2025-07-24, 0 overlap |
| base +400 days | 97 members from 2026-04-10, 0 overlap |
| 2026-07-29 onward | 0 members — true end of roster |

No HMAC, no signature, no server-side validation: a hand-edited cursor is
accepted and served. Public research on X cursors
(<https://gist.github.com/0xdevalias/8885b10795eb3267b703ed5943087953>)
documents the Thrift encoding and that field 1 holds a `rest_id`, but stops
before testing mutation and states that cursor manipulation is difficult to
bypass. Every reviewed client — Twikit, twscrape, TwCommunity, X Group Scraper,
the Apify actors, Xquik — replays cursors verbatim; none seeks.

Coverage audit after seek-resume: 24 probes evenly spaced across the 18-month
join range sampled 2,255 members and found **0** not already collected.

Two operations were confirmed readable by an account holding **no role** in the
target Community:

- `WjkcJu3u0ICw288PAUaPOQ` / `CommunityAnalyticsQuery` returns
  `total_members` (79,397), `unique_posters` (987), `num_posts`, `impressions`,
  `fav_count`, `reply_count` and period-over-period percentages. `total_members`
  is now the coverage denominator and `unique_posters` the completeness target
  for author discovery.
- `0oYT9GRiWUhrz5xoqFE9uw` / `moderatorsSliceTimeline_Query` returned all 37
  moderators and admins in one response with no next cursor. The About timeline
  exposes only 5 moderators and 10 featured members, and 9 of the 37 appeared
  nowhere in the 46,960-member walk.

`timelinesMembersLogQuery` and `timelinesRemovedUsersLogQuery` both answer
`Authorization: Invalid community role.` for a non-moderator, so they remain
conditional sources usable only where the operator holds a role.

The current `bundle.Communities` registry also contains Community⇄X-List
operations absent from the earlier capture — `lists_CommunityListQuery`
(`6U6ODXxtpU2F9UXU_qYfPA`, taking `communityId` and `listId`),
`lists_UsersListsQuery`, and `CommunitiesListActivityQuery`. These describe
lists attached to a Community, not its roster.

One earlier reading is corrected: `PeopleCommunity_Query` appears to accept
`communityId`, `role`, and `userId`, but the latter two belong to the adjacent
`communityPeopleActionMenu_roleUpdate_Mutation` in the minified bundle. The
query takes `communityId` alone and returns only the viewer's role, as
originally reported.

No official X API endpoint currently enumerates Community members. X documents
only Community lookup and Community search. The similarly named List Members
API applies to X Lists, not X Communities.

## Live and bundle findings

### Live multi-surface audit (5.9)

A sanitized Chrome DevTools audit on 2026-07-27 confirmed the current contracts:

- `CommunityTweetsTimeline`
  (`dD1uF9vQx0OX-e1rKA4YLw`) uses Recency/Relevance and a 20-post cursor;
- `CommunityMediaTimeline`
  (`9MUOEALCr46-4atDb2nq1A`) has an independent 20-post cursor;
- `CommunityTweetSearchModuleQuery`
  (`00kKs1lbMvTB7qWooua0rQ`) uses a separate filtered-timeline cursor and
  supports chronological ranking;
- `CommunityAboutTimeline`
  (`zEwxuy-wFr9_C6lPW4xXmA`) returned visible moderator and featured-member
  groups; and
- `membersSliceTimeline_Query` remained
  `woAp_YdzAdqnWDrqLTNpAw`, with only `communityId` and `cursor`.

Version 5.9 archives the first three post surfaces independently and merges the
About groups as confirmed current-member evidence. Operation failures remain
isolated so a rotated supplemental query cannot destroy a roster scan.

Current open-source implementations were checked directly as well. Twikit,
Twitter Web Exporter, Mass Block Twitter, Nitter, and the public internal-API
catalogs all use the same `membersSliceTimeline_Query`/`members_slice` contract
and its `next_cursor`; none implements a second broad Community roster or
demonstrates pagination beyond the terminal cursor. Twikit independently
confirms that `CommunityMediaTimeline` and
`CommunityTweetSearchModuleQuery` are cursor-based post sources, which supports
using them for author discovery but not treating them as a complete roster.

### Durable full-timeline author archive (5.8)

Version 5.8 separates recent activity analysis from historical author
discovery. Each activity scan refreshes the selected lookback from the newest
posts. When enabled, the historical archive then continues from a permanent
`communityTimelineBackfill:<communityId>` cursor toward the oldest post X
exposes. It checkpoints every page, unique author, oldest observed timestamp,
post count, and stop reason. This avoids restarting a long backfill when the
calendar date changes. It does not convert an author into a confirmed current
member without exact membership evidence.

### Durable source union (5.7)

Version 5.7 stores a compact permanent union of members directly confirmed by
X, keyed by stable user ID with username fallback. Each record tracks first and
last confirmation, snapshot sightings, protected status, and discovery source:
`direct_roster`, `activity_verification`, `moderator_surface`, or `import`.
Only `x-roster` evidence enters the confirmed archive; unverified post authors,
pending requests, invitations, and historical moderation targets cannot become
current removal candidates merely because they were observed.

The 350-item exact-verification safety batch is now backed by an explicit
durable pending queue. Successful checks are removed from the queue, including
exact `NonMember` results, while rate-limited or interrupted work remains for a
later scan. Exact verification also promotes matching post-author records to
the stronger `x-roster` evidence level.

### Xquik public-contract audit (5.6)

Xquik's public documentation, OpenAPI schema, generated TypeScript SDK, agent
skill, and Apify listing were inspected on 2026-07-27. The public SDK contains
no X scraper: it sends `GET /x/communities/{id}/members` to Xquik with an
opaque `cursor` and a `pageSize` from 20 to 200. Xquik describes Community
exports as bounded, charges per returned member, and runs bulk extraction as a
private server job. Its extraction-result `nextCursor` paginates rows already
stored by Xquik and is not an upstream X roster cursor.

The public documentation intentionally refers only to a private read service,
browser service, and network-egress service. The Apify wrapper likewise says it
uses Xquik's own infrastructure, does not expose a resume cursor, and can
inspect more profiles than it writes. None of the public repositories contains
the server collector, account-pool logic, or evidence that a Community export
continues beyond X's terminal member cursor.

A fresh sanitized Chrome capture found the current web operation
`woAp_YdzAdqnWDrqLTNpAw/membersSliceTimeline_Query`. It accepts only
`communityId` and `cursor`, returned 19 and 20 roster entries in two observed
pages, and emitted a 100-character opaque next cursor. This confirms that
Xquik's documented 200-result response is a server-side aggregation over
smaller upstream pages rather than a hidden 200-member web request.

Version 5.6 adopts only the evidence-backed efficiency improvements: 750 ms
adaptive roster pacing, a 200-record request for the distinct Android
`CommunitiesMembersAllQuery`, and automatic downgrade to 100 if X rejects the
larger native page. These changes reduce scan time but cannot extend a terminal
server cursor.

### Current web bundle audit (5.5)

The 2026-07-27 `bundle.Communities` Relay registry exposes several operations
that were not present in the earlier capture:

- `a7hXLYYtg_qT42KgM0WmYQ/timelinesMembersLogQuery` accepts `communityId`
  and `cursor`, and returns moderation-log target, moderator, action, and
  revert references;
- `zE2vR5iclwY1sbKhc54tAg/MemberRequests_Query` returns pending join-request
  users;
- `WjkcJu3u0ICw288PAUaPOQ/CommunityAnalyticsQuery` returns aggregate growth,
  active-member, new-member, total-member, visitor, favorite, and reply
  metrics;
- `6YgvBKI7c3YZ9d7zKKojng/CommunityMemberRelationshipTypeahead` accepts a
  known username prefix and labels returned global account candidates with
  their Community relationship.

The moderation-log route is client-gated for the connected `NonMember`
session: loading the exact shipped route does not issue its GraphQL request.
The typeahead route is readable, but it is not an enumerable member search. A
one-letter prefix returned a global `NonMember` candidate, while an exact known
handle returned a small fuzzy mixture of `Admin`, `Member`, and `NonMember`
relationships.

Version 5.5 therefore uses typeahead only as an exact verifier for candidates
already discovered from Community posts. It matches stable user ID when
available, otherwise exact case-insensitive username, and rejects
`NonMember`. Up to 350 candidates are verified per run with seven-day local
checkpoints. The post-author backfill window is extended to ten years and
remains cursor-resumable. This can confirm additional current members beyond
the roster window without pretending that fuzzy search enumerates unknown
accounts.

### Current native Android operation (5.4)

The signed X Android 12.11.0-release.0 package published on 2026-07-24 was
downloaded from APKPure and verified against its published SHA-256:
`a8b9a0d449bfacd91e7cffb1f82d06a9ba68496915ae408372c1c6315fc92be6`.
Static analysis of its operation registry found a current, distinct member
operation:

- query ID: `mq7ptH6j5ApwD9VEGR46sg`;
- operation: `CommunitiesMembersAllQuery`;
- registered numeric inputs: `community_rest_id` and `count`;
- operation type: query;
- separate related operations:
  `CommunitiesMembersModeratorsQuery`, `CommunityMembersSearch`, and
  `CommunityMembersSlice`.

Version 5.4 tries this read-only native operation as an independent roster
source before the live web slice. It has a separate checkpoint namespace,
merges by stable user ID, records only sanitized outcome metadata, and falls
back automatically. The word `All` is X's operation name and is not treated as
proof of complete coverage; only reaching the advertised member count can mark
the roster complete. A live signed-in extension run is still required to
measure whether X's server allows this operation to advance beyond the web
cursor cutoff.

A sanitized HAR captured on 2026-07-23 confirmed the current live roster
contract:

- query ID: `WSbJGJjZaVasSj9bnqSZSA`;
- operation: `membersSliceTimeline_Query`;
- variables: `communityId` and optional `cursor` only;
- no `count` variable and no `features` query parameter;
- 20 results at `data.communityResults.result.members_slice.items_results`;
- next cursor at
  `data.communityResults.result.members_slice.slice_info.next_cursor`.

Version 4.5.2 replays that captured contract exactly and carries X's live
`x-client-transaction-id` header when network discovery exposes it. Cookies,
authorization headers, CSRF values, response account data, and raw HAR contents
are not copied into the extension.

| Surface | Inputs | Pagination | Finding |
| --- | --- | --- | --- |
| `membersSliceTimeline_Query` | `communityId`, `cursor` (some clients also send `count`) | bottom/next cursor | Real roster source used by the Members page and this extension; server cursor ends far before the advertised count |
| `CommunityMemberRelationshipTypeahead` | `communityId`, `prefix` | none visible in the current bundle contract | Search-only relationship query; the signed-in non-member session returned no suggestions, including known members |
| `CommunityUserRelationshipTypeahead` | `communityId`, `prefix` | none visible | Invite-user search, not member enumeration |
| Community moderators | `communityId`, cursor | cursor | Moderator/admin subset only |
| Community tweets/search | `communityId`, cursor/date/search variables | cursor | Can discover authors who posted, but cannot reveal inactive members |
| Membership verification services | community + known user | one candidate at a time | Useful only when a candidate roster already exists |

The current X main bundle identifies
`CommunityMemberRelationshipTypeahead` with query ID
`6YgvBKI7c3YZ9d7zKKojng`. Its implementation sends exactly
`{communityId, prefix}` and filters returned relationships to roles other than
`NonMember`; it does not expose an independent alphabetic roster or a paginated
prefix result. The observed empty search UI therefore cannot be used to
partition the 79,000-member roster.

The extension's MAIN-world performance observer discovers current persisted
query URLs without reading cookies or authorization headers. A later sanitized
CDP audit on 2026-07-27 also confirmed the live operation contracts described
below.

## Independent evidence

- X API Community lookup:
  <https://docs.x.com/x-api/communities/get-community-by-id>
- X API rate-limit table lists only Community lookup and Community search:
  <https://docs.x.com/x-api/fundamentals/rate-limits>
- Twitter Exporter documents an approximately 9,300-member Community limit:
  <https://store.rxliuli.com/blog/how-to-block-twitter-community-members/>
- API Dance exposes the same upstream operation by name:
  <https://doc.apidance.pro/communitymembers-21791527e0>
- SocialData documents the same approximately 20-user cursor contract:
  <https://docs.socialdata.tools/reference/get-community-members/>
- Sorsa exposes a cursor proxy but does not document a beyond-X coverage
  guarantee:
  <https://docs.sorsa.io/api-reference/community/community-members>
- An Apify actor advertising “complete” extraction still documents only 50
  pages/about 1,000 members:
  <https://apify.com/igview-owner/twitter-x-community-members>
- A more candid cookieless actor explicitly limits its coverage to creators,
  featured members, and recent post authors:
  <https://apify.com/khadinakbar/x-community-members-scraper>

## External-provider proof gate

External providers may use their own authenticated account pool or stored data,
but a marketing claim is not evidence of full coverage. A provider is useful
for this project only if a low-cost proof run on the target Community:

1. returns at least member 9,301;
2. continues with a new cursor rather than repeating the X terminal cursor;
3. returns stable X user IDs;
4. reaches a terminal page close to the advertised count; and
5. does not require exporting the browser's `auth_token` or `ct0` cookies.

No reviewed provider produced verifiable full-roster evidence under the
project's free-only requirement, so none is integrated or labeled as a complete
solution.

## Free-only decision (4.8)

The audit reviewed Nitter, twikit, twscrape, Twitter Web Exporter,
Mass Block Twitter, Twitee, standalone GitHub scripts, Chrome Web Store
exporters, forum discussions, and the official X API documentation. The
open-source implementations all call the same
`membersSliceTimeline_Query` cursor used by the web page; wrappers do not create
an additional upstream roster.

Live testing also entered both a one-letter prefix and the prefix of a member
already visible in the roster. The current non-moderator account received no
member-search suggestions in either case, confirming that typeahead cannot
partition this roster for this session.

A second GitHub-wide code search on 2026-07-24 found more than 40 current
references to `membersSliceTimeline_Query`. The independent clients and forks
again converged on the same operation and response path. The current
undocumented-operation catalogs add `CommunitiesMembershipsSlice` and
`CommunitiesMembershipsTimeline`, but those enumerate Communities associated
with a user rather than users belonging to one Community. The only separate
Community-user surfaces found were member relationship typeahead and the
moderator subset.

XActions was also inspected because it advertises a free, local Community
member export. Its implementation does not call an alternate endpoint: it
collects rendered `[data-testid="UserCell"]` rows, scrolls the page, defaults to
100 members, and stops after a configured number of empty scroll attempts. It
therefore wraps the same visible roster and cannot cross X's terminal server
cursor.

Version 4.8 therefore contains no paid provider, external API-token input, or
third-party roster host permission. Its free coverage improvements are limited
to exact deduplication, cursor checkpoints, short DOM reconciliation, and the
union of recent and historical Community-post authors. These preserve every
member the browser can actually prove while never marking a result complete
below the advertised member count.

## Chrome Web Store exporter verification (2026-07-27)

The public packages for TwCommunity and X Group Scraper were inspected after
their Web Store listings were supplied for comparison:

- <https://chromewebstore.google.com/detail/twcommunity-export-x-comm/ekmakfofejepagjcfllcfjapmhdeafdg>
- <https://chromewebstore.google.com/detail/x-group-scraper-twitter-c/nbhfolmjbloiecjfajemineiagnfdidn>

Both capture the browser's live `membersSliceTimeline_Query`, replay it with the
next `members_slice.slice_info.next_cursor`, and parse `items_results`. Neither
package contains an alternate full-roster endpoint. X Group Scraper advertises
a paid limit of 5,000 records, while TwCommunity removes its own export cap on
the paid plan but still depends on X's terminal cursor. "Unlimited" therefore
describes the extension's plan limit, not evidence that X returns every member.

TwCommunity explicitly treats a cursor whose first pipe-delimited segment is
`0` as terminal. Version 5.9.2 adopts that safe protocol detail so the scanner
does not issue a redundant final request or mislabel X's server cutoff.

## Live Chrome protocol audit (2026-07-27)

The signed-in Community UI was inspected surface by surface with sanitized
Chrome DevTools Protocol metadata. No cookies, authorization or CSRF headers,
usernames, complete cursors, or response bodies were retained.

| UI surface | Live operation | Inputs observed | Rate-limit bucket |
| --- | --- | --- | --- |
| Top / Latest | `CommunityTweetsTimeline` | `communityId`, `count`, `displayLocation`, `rankingMode`, `withCommunity`, optional `cursor` | 500 |
| Media | `CommunityMediaTimeline` | `communityId`, `count`, `withCommunity` | 500 |
| About | `CommunityAboutTimeline` | `communityId`, `withCommunity` | 50 |
| Community search | `CommunityTweetSearchModuleQuery` | community, query, ranking, timeline, feature and cursor fields | 500 |
| Members | `membersSliceTimeline_Query` | `communityId`, optional `cursor` | 500 |
| Moderators | `moderatorsSliceTimeline_Query` | `communityId`, `count`, optional `cursor` | 500 |
| Members search | `CommunityMemberRelationshipTypeahead` | `communityId`, `prefix` | 500 |

The Members page also called `PeopleCommunity_Query`, which returned only the
current viewer's Community role, and `CommunityInviteButtonQuery`, whose result
contained invite-button state. Neither response contained a roster.

The live member slice returned 18–19 records per request and a 100-character
opaque continuation cursor. Community search paginated independently and the
Top and Latest search tabs used Likes and Recency ranking respectively.
`moderatorsSliceTimeline_Query` is a genuine cursor, but it is only a
moderator/admin subset and does not reveal hidden ordinary members.

Most importantly, the current member typeahead response places membership in a
top-level `role` field. A two-character discovery prefix returned 11 results,
all marked `NonMember`: this surface searches inviteable X accounts rather
than enumerating Community membership. Version 5.9.2 accepts both this live
top-level role field and the older nested `community_role` shape when verifying
an already-known post author.

No console warnings or errors were emitted while loading these Community
surfaces. None of the observed operations supplied a second complete ordinary
member roster.

## Product strategy

Version 4.4 keeps direct cursor collection as the primary source, performs only
a short DOM reconciliation after a server-limited cursor, reuses recent partial
checkpoints, deduplicates by stable user ID, records exact stop reasons, restores
completed results, and watermarks partial CSV exports.

It also checkpoints post-analysis cursors and author counts, parses direct and
module timeline entries, matches post activity by stable user ID, records
server rate-limit headers, detects Chrome's frozen-tab state, and restricts
checkpoint storage to trusted extension contexts. These changes prevent false
inactive flags and reduce repeated work; they do not expand X's server-limited
roster.

Version 4.4 now unions newly exposed members and Community-post authors across
periodic scans. Supplemental authors carry `recent-community-post` or
`historical-community-post` evidence in the CSV, and historical rows warn that
current membership is unverified. This improves coverage going forward without
pretending it can reconstruct already hidden, never-posting members from the
historical roster.

Chrome platform references:

- Frozen tabs cannot execute timers or event handlers:
  <https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab>
- Extension service workers can terminate and should persist resumable state:
  <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- Local extension storage access can be restricted with `setAccessLevel()`:
  <https://developer.chrome.com/docs/extensions/reference/api/storage>
