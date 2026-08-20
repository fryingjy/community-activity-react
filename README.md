# Community Activity 5.17.2

## 5.17.2 — a plain-username export, members only, for the confirmed-inactive list

Requested directly off a real export: the CSV's other columns
(`activity_verification`, roster coverage, stop reasons) are exactly the
evidence a reviewer needs before acting, but they're noise once a row has
already been reviewed and the only thing left to do is hand the username to
a moderator. `buildFlaggedUsernamesText` (`src/export/csv.js`) produces a
plain `@username`-per-line list, deduplicated and sorted, with moderators
excluded — and, deliberately, anything that isn't `role === "Member"`
rather than only excluding rows literally labeled `"Moderator"`, so a role
tier this project hasn't hardcoded (an Admin tier, say) can't quietly slip
into a members-only list.

The new **Usernames only (TXT)** button pairs with **Export
direct-search-confirmed only**, not the broad export — same
confirmed-inactive row set, same `assertConfirmedOnlyRowsAreConfirmed`
fail-closed check, same `safeForAutomatedRemoval` gating. That's a
deliberate choice, not an oversight: the broad export mixes confirmed,
unverified, and unverifiable-protected rows on purpose for review, and
that's exactly the wrong list to hand off as bare usernames with no
verification context attached.

173 tests, all green.

## 5.17.2 — throughput/ETA, and separating the inactivity result from the archive's status

Closes out the 5.17.2 punch list's remaining two items.

**Throughput and ETA**, built on 5.17.1's `oldestSeenAt` tracking.
`src/core/activityThroughput.js`'s `estimateActivityThroughput` takes a
sliding window of `{atMs, pages, oldestSeenAtMs}` samples (a moving average
over the last ~40 pages, not one page's rate — posting density varies a lot
over a real Community's history) and derives pages/minute, days-covered-per-
page, and an ETA to the requested boundary. `pushSample` is the tiny bounded
FIFO the window itself lives in, kept in `sidepanel.js` next to the rest of
its scan-progress state rather than inside the estimator. During a long
30–90 day scan, the status line now reads something like `18,420 posts ·
340 active · 890 observed · reached Jul 18 (target Jul 9, 9 day(s)
remaining) · 47 pages/min · ~210 pages left · ~4.5 hr left` instead of a
number climbing with no sense of how much further it has to go.

**Classification vs. archive, visibly separated.** The results panel used
to fold the supplemental timeline/media/search archive's status into the
same paragraph as the inactivity verdict — easy to read as "the results
aren't done yet" when they already were. A new `archiveStatusPanel` shows
Timeline/Media/Search-shard status as its own bordered section, explicitly
labeled "Separate from the inactivity result above: none of this blocks or
changes it, and it can keep going across later scans" — matching what
5.17.1 already did internally (the primary activity pass blocks
classification on window coverage; the supplemental archive doesn't block
anything and is explicitly fine to spread across scans), now made visible
instead of implicit. Restoring a completed job from storage renders the
same section from the saved diagnostics, not just the live in-scan path.

171 tests, all green. This closes the punch list from the last review:
permission audit (5.17.1), Clear saved data (5.17.1), and now throughput
metrics and archive/classification separation. Per the reviewer's own
sequence, the next step is rerunning a real Community on 5.17.2 — small,
then medium, then the ~79K Community — not more infrastructure.

## 5.17.1 — a real "Clear saved data" control, distinct from Discard resume

5.17.0's own commit message said it plainly: Discard resume only removes
the incomplete-scan notice, every stage's checkpoint stays in place, and a
true "clear all saved data" action didn't exist yet. It does now.

`src/core/storageInventory.js` is the reason this could be built as one
general rule instead of a hand-maintained list of key prefixes: every
`chrome.storage.local` key this extension writes — checked against every
checkpoint/cache module's own key-builder function — embeds the Community
ID as a full colon-delimited segment of the key itself
(`cursorRoster:<id>:meta`, `activityScan:<id>:<since>:...`,
`communitySearchBackfill:<id>:<shard>`, and so on). `keyBelongsToCommunity`
and `computeCommunityStorageKeys` use that directly rather than
special-casing each module; the one exception, `liteScanJob`, is a single
global key checked by its `communityId` field instead, since only one scan
job is ever remembered regardless of Community.

The side panel's new Storage section shows how many Communities have saved
data and how much (the real `chrome.storage.local.getBytesInUse()` figure
when available, falling back to a deterministic estimate), and offers two
explicit, separately confirmed actions: **Clear this Community** and
**Clear all Community Activity data**. Both are locked while a scan is
active — clearing storage mid-scan could remove a checkpoint the running
scan is reading from or about to write to — and re-evaluated the moment it
finishes.

`summarizeStorageByCommunity` discovers which Communities have data without
being told one up front, using the same insight from the other direction:
a Community ID is the only purely-numeric segment any of these key shapes
ever contains, so "the first all-digit segment" reliably identifies it.

165 tests, all green. Second item of the 5.17.2 punch list.

## 5.17.1 — permission audit: scripting and webRequest both confirmed necessary

Before a stable release, every declared manifest permission needed a
verified, current call site — not "probably still needed." Audited by
grepping the codebase for the actual API each one gates:

- **`scripting`** — genuinely used, seven call sites across `domScan.js`
  and `sidepanel.js`: `chrome.scripting.executeScript` injects the DOM
  fallback/reconciliation collector into the visible X Members tab, the
  mechanism this extension relies on when direct cursor pagination is
  unavailable.
- **`webRequest`** — genuinely used, and narrowly: one read-only,
  non-blocking `onBeforeSendHeaders` listener scoped to
  `https://x.com/i/api/graphql/*`, reading only the `x-client-transaction-id`
  header the page's own request already carries. Nothing is modified,
  cancelled, or redirected, and no broader URL pattern is registered.

No permission was removed — this audit's finding is that both are minimal
and necessary, which is itself the useful outcome: it replaces "probably
fine" with a verified answer. `PRIVACY.md` gained a `## Permissions` section
documenting each one this way, and `tests/extensionArtifacts.test.js` now
pins both the exact permission list and each one's call site, so a future
permission change — an addition or a removal — has to be deliberate and
reviewed rather than silent drift in either direction.

159 tests, all green.

## 5.17.1 — the first real-world validation finding: activity collection stopped at a fixed page cap, not the actual window boundary

The first live scan against a real Community reported 0 flagged members —
not a classification bug. `fetchActiveAuthors`' recent-activity pass
defaulted to `maxPagesPerRun = 250` (5,000 timeline entries at 20/page), a
limit from before this project had quota tracking, durable checkpoints, or
resume. On a Community active enough that 5,000 entries don't reach 30 days
back, the scan checkpointed and stopped short of the window every run,
`activityWindowComplete` never became `true`, and the operator was told to
press Start again — indefinitely, since the same fixed cap would strike
again next run.

The fix changes what "done for this run" means. `maxPagesPerRun` is no
longer the normal stop condition — it's now a sanity ceiling (5,000 pages)
against a pathological walk, not the expected outcome of a healthy one. The
real stop conditions, checked every page:
- the requested window is actually covered (`activityWindowComplete`), or
- this operation's own *observed* quota (from real `x-rate-limit-*`
  response headers, via the same `quotaPlanner.js` used for direct
  verification's scheduler) has run low — checked with `usableQuota()`
  before every request, not guessed from a static budget.

Unknown quota (nothing observed yet this scan) is deliberately not a reason
to stop — only an actually-measured, actually-low bucket is, the same
"unread is not the same claim as exhausted" distinction `quotaPlanner.js`
already made for verification.

The collector now also tracks `oldestSeenAt` — the actual progress marker,
"how far back has the walk reached" — independent of whether that's inside
or outside the requested window, persisted in the checkpoint and returned
alongside `stopReason` (`"window-covered"`, `"quota-paused"`, or
`"page-budget-reached"`). `sidepanel.js` uses it to show real progress
(`reached July 18 · target July 9 · 9 day(s) remaining`) instead of a bare
"incomplete" boolean, and distinguishes a genuine quota pause ("progress is
saved and the next scan continues from here") from the old generic "run the
scan again" copy.

Scope stayed narrow on purpose: this only changes the *primary*,
classification-blocking activity pass (`analyzeRecentActivity`). The
separate, supplemental archival backfill
(`archiveTimelineMediaAndSearch` → `backfillCommunityTimelineAuthors`/media/search)
keeps its existing conservative per-run budget — it's explicitly fine for
that one to spread across multiple scans, since nothing downstream is
blocked on it finishing.

Two new simulator tests prove the fix directly: a ~6,500-tweet, 30-day
scenario needing ~325 pages (past the old 250-page cap, under the new
5,000-page ceiling) reaches `activityWindowComplete: true` in one
continuous run; and a quota-draining scenario pauses after exactly the
requests the observed quota allowed, then reaches completion once quota
recovers — the exact "resumed run eventually produces classifications"
proof this fix needed. 158 tests, all green.

## 5.17.0 — durable resume, closed out: explicit stage policies, a real interruption proof, and two bugs it actually found

The final hardening pass on durable resume, and the reason to do it before a
live large-Community run: an interruption bug is exactly the kind of thing
that costs the most at 79,000 members, and this pass found two real ones
before that run happened.

**Explicit resume policies, checked against real side effects.** Every
`SCAN_STEPS` entry now carries a `resumePolicy`: `"checkpoint-resumable"`
(the step's expensive work is itself backed by a `chrome.storage`
checkpoint or cache one layer down) or `"idempotent-rerun"` (no checkpoint
of its own, but safe and cheap to redo because it only ever overwrites
derived state rather than accumulating onto it). Every one of the nine
steps was read individually — not assumed — before being classified;
`src/core/resumeSummary.js` mirrors the same classification for the resume
panel, which now shows it as a tooltip per stage. None of the nine
classified as `"restart-required"`, which is itself a real finding: it
means every step whose own work is actually expensive already delegates to
something checkpoint-backed, and the orchestration wrapped around that is
cheap enough to just redo — a property of how the underlying collectors
were built over this project's history, not an assumption made here.

**A real interruption proof, not just a classification.**
`tests/simulator/interruptionSimulator.test.js` fires an `AbortController`
from inside a fake server at an exact request count (standing in for "the
browser closed right here"), reconstructs by calling the same collector
again against the *same* fake `chrome.storage` (chrome.storage.local
survives a real restart, so the fake does too), and asserts the resumed
result is identical to an uninterrupted baseline — for roster, activity,
direct verification, and one full pipeline run interrupted mid-roster. Each
fake server gained an `onRequest` hook to make this possible without racing
real timing.

**What it actually found, before ever touching a real Community:**

1. Direct verification's cache only saved to `chrome.storage` every 10
   candidates, or once at the very end. An interruption between saves lost
   every completed-but-unsaved check — the interruption test caught this as
   17 total requests for 12 candidates (5 re-checked after resume) instead
   of 12. Fixed in `src/activity/directVerification.js`: the whole loop is
   now wrapped in `try/finally`, so every exit path — normal completion, a
   request error, or an interruption — persists whatever was actually
   checked.
2. `fetchCommunityMembersByCursor`'s seek-resume state
   (`lastCursorTimestamp`) was never seeded from the resumed checkpoint's
   own cursor, only ever updated from a *subsequent* page's returned
   cursor. If a resumed walk's very first page immediately hit the chain
   cap (no next cursor to read a timestamp from), `lastCursorTimestamp`
   stayed `null` forever, `shouldResumeChain`'s `lastTimestamp == null`
   guard failed, and the walk reported itself terminally stopped — the
   exact situation seek-resume exists to handle, defeated by its own resume
   path never initializing the one value it needed. Fixed in
   `src/roster/collectRoster.js`: `lastCursorTimestamp` now seeds from
   `readRosterCursorTimestamp(cursor)` on entry, exactly mirroring how
   `seekTemplateCursor` already did on the very next line.

**Discard renamed to "Discard resume," with the semantics spelled out.**
It only ever removed the `SCAN_JOB_KEY` notice; every stage's own
lower-level checkpoint (roster pages, activity cursor, backfill
checkpoints, verification cache) was always left intact, and a new scan
could still silently reuse them. The button and its panel copy now say so
explicitly, and name the actual gap: a real "clear all saved data" action
is a distinct, not-yet-built feature, not something the current button
does.

155 tests, all green, closing the completion plan's durable-resume
checklist. Next: real Community validation — small, medium, then the
~79,000-member scan this project was built around — not more
infrastructure, per the plan's own instruction to resist adding
abstractions unless the live scan exposes a need.

## 5.16.0 — an actual Resume/Discard prompt, not a relabeled Start button

Reopening the side panel on an incomplete scan used to just change the
Start button's text to "Resume scan" and update one line of context text —
clicking it did work (each stage's own checkpoint picks up where it left
off), but nothing told the operator *what* would resume, or gave them a way
to say "no, forget this one."

`src/core/resumeSummary.js` turns a saved job into a pure, testable
description: which of the nine scan stages are complete, running, or never
reached (using the `status` field `5.16.0`'s step-tracking change just
added), plus roster/activity/verification progress. `sidepanel.html` gained
a `resumePanel` section — shown only when a saved job's settings actually
match the current form (see the settings-fingerprint fix earlier in this
version) — rendering that description as a real per-stage list with status
dots, a roster/activity/verification summary line, and two explicit
buttons: **Resume scan**, which submits the form exactly as before (the
underlying resume mechanism is unchanged — this is a real prompt in front
of it, not a new resume path), and **Discard**, which removes the saved job
and resets the panel back to a clean "New analysis" state without touching
anything already exported or any stage's own lower-level checkpoint data.

**Still open** for the full durable-resume picture: per-stage resume-policy
classification (idempotent vs. checkpoint-resumable vs. restart-required —
today every stage is treated the same way), and testing an actual
interruption at every stage boundary rather than trusting the lower-level
checkpoints' own existing tests to cover it end to end.

## 5.16.0 — a start on durable resume: settings-safe job identity and real step status

The first two pieces of durable stage-level resume, ahead of the larger
resume/discard UI still to come.

**A real correctness gap, not just a missing feature:** `initialize()`'s
check for whether a saved scan job could be restored only ever compared
`communityId`. A job saved for a 90-day lookback with seek-resume on could
be silently restored — results, roster state, activity state and all — the
moment the page reopened with the lookback dropdown at 30 days, because
nothing checked that the settings had changed. `src/core/jobIdentity.js`
adds `jobSettingsFingerprint`/`isJobResumable`, folding `lookbackDays`,
`seekResume`, and `timelineBackfill` into resume identity alongside the
Community — a checkpoint answers a specific question, and a saved job must
answer the one currently being asked, not a different one that happens to
share a Community ID. `SCAN_JOB_SCHEMA` bumped `2 → 3` so an old job record
(lacking these fields entirely) fails the schema check outright rather than
coincidentally matching an under-specified fingerprint.

**Real step status, not just history:** `ScanCoordinator` already reported
`onStepEnd`, but nothing recorded `onStepStart` — a step interrupted
mid-run (browser closed, service worker suspended) left no trace at all in
`requestStats.steps`, indistinguishable from a step that was never reached.
`sidepanel.js` now records a `status: "running"` entry the instant a step
starts and updates it in place when the step ends, and `diagnostics.js`'s
sanitizer carries that status through (inferring `"complete"`/`"failed"`
for older records that predate the field, so nothing already stored breaks).
This is what makes a real `discover-community: complete, collect-roster:
running` display possible later — the data existed nowhere before this.

**What's still open** for the doc's full "durable resume" vision: an actual
Resume/Discard UI (today, "Resume scan" is still just a relabeled Start
button that re-runs the full step sequence, relying on each stage's own
lower-level checkpoint to skip finished work — which does work today, just
implicitly, one layer down from job-level state); per-stage resume-policy
classification (idempotent vs. checkpoint-resumable vs. restart-required);
and testing an actual interruption at every stage boundary. This increment
is the safety fix and the observability foundation those need, not the
whole feature.

## 5.16.0 — the quota scheduler: QuotaManager observes, quotaPlanner decides

`QuotaManager` only ever recorded what X's rate-limit headers said; nothing
used that information to decide how much work to actually do. Direct
verification's `maxCandidatesPerRun = 400` was a static guess sized against
`CommunityTweetSearchModuleQuery`'s known 500-per-15-minute bucket, with
margin held back by hand for the word-shard backfill sharing the same
bucket earlier in the same scan.

`src/api/quotaPlanner.js` is a new, deliberately separate pure module —
`QuotaManager` stays an observer, `quotaPlanner` is the policy layered on
top, because quota state is a fact about the world and how much work to run
against it is a decision, and the two change for different reasons.
`usableQuota(quota, { reserve, minimumReserveFraction })` reserves the
larger of a flat floor (20) and a proportional one (5% of the bucket limit),
so a large bucket doesn't get run all the way down to a thin margin.
`planWork(queueLength, quota, options)` turns that into
`{ processNow, defer, reason }` — `null` usable (quota never observed this
scan) is handled distinctly from `0` usable (observed and exhausted), since
they call for different fallbacks: unobserved falls back to the old static
400; exhausted defers everything and reports `resetAt`. This is exactly the
completion plan's own worked example: 612 queued, 463 remaining, 30
reserved → 433 processed now, 179 deferred.

`verifyMemberActivityViaSearch` (`src/activity/directVerification.js`) now
computes its run size from `requestStats.quotas[operation]` — the same
object the word-shard backfill and every other collector already populate
during the same scan — before slicing its pending-candidate queue, instead
of always slicing to the static constant. Since `sidepanel.js` already
threads `ctx.requestStats` into this call (unchanged), the live extension
picks up quota-aware sizing automatically: no UI or orchestration change was
needed for the behavior itself to take effect, only for it to eventually be
*shown* (still open, see the completion plan's UI phase). The old constant
is kept, renamed only in comment, as the fallback for the case quota has
genuinely never been observed — the common case is a change in what decides
the number, not a change in what happens when nothing is known yet.

Proven directly against the fake verification server (not just the pure
planner in isolation): a run pre-seeded with a tight observed quota checks
fewer candidates than the old static constant would have allowed, and
`server.requestCount` matches the planned number exactly — the real
function, not an assumption about what it would do.

## 5.15.0 — Full End-to-End Proof

Every production collector in this pipeline — roster, activity timeline,
media, word-shard search, and direct verification — now runs end to end
against a deterministic fake X in CI, asserting exact output equality
against a declared expectation, not "close enough." The entries below (still
filed under 5.14.0, where the work actually happened commit by commit) cover
the individual pieces; this entry is the milestone they add up to.

**What's proven now, that wasn't before:**
- The real, unmodified production orchestrators are what's under test —
  request building, checkpoint persistence, cursor codec, response
  parsing — not a parallel reimplementation of their decision logic.
- A full pipeline test (`tests/simulator/fullPipelineSimulator.test.js`)
  chains roster → activity → classification → direct verification →
  completeness using the same real functions and the same sequence
  `sidepanel.js` uses, with every final member's classification declared up
  front and asserted exactly.
- A 79,000-member, 500-page-chain-cap scenario — the actual scale and cap
  this project was built around — runs in CI in under a second, because
  request pacing is now injectable (`AdaptiveRateLimiter`'s `sleep` and
  `graphqlGet`'s `delayFn`) without changing any production default.
- Every collector recovers correctly from a 429 and a transient 500 —
  previously untestable against the real retry path without paying real
  multi-second backoffs.
- `src/core/invariants.js` makes five of this project's implicit
  correctness assumptions machine-checkable — grounded in real data shapes,
  not abstract pseudocode — and one of them
  (`assertConfirmedOnlyRowsAreConfirmed`) is now wired into the
  confirmed-only export itself: a thrown, fail-closed check backing the
  filter that was previously only trusted silently.
- Full suite: 125 tests, ~3.4 seconds, all green in GitHub Actions.

**What this milestone deliberately does not include** (see the completion
plan's next phases): quota-aware scheduling, durable stage-level resume
across a browser restart, and real large-Community validation. `QuotaManager`
still only observes; `ScanCoordinator` still runs a scan start-to-finish in
one sitting. Those are explicitly the next work, not folded into this one.

## 5.14.0 — machine-checkable invariants, and the full pipeline simulator

`src/core/invariants.js` turns five implicit correctness assumptions into
functions that throw `InvariantViolation` instead of silently trusting them:
every flagged row's `activityVerification` is one of the three states a
still-flagged row can actually carry (a confirmed-active member is removed,
never labeled — a fourth state that would never legitimately appear);
every row in a confirmed-only export is actually `confirmed-inactive`;
`safeForAutomatedRemoval` never holds alongside an incomplete activity
window; every member has an identity `activitySearchCandidateIdentity` can
actually resolve (its own fallback — ID or lowercased username — already
assumes a member might lack `user_id`, so the invariant matches that
assumption instead of a stricter one nothing in this codebase relies on);
and no two members collapse to the same identity, the exact failure mode a
changed handle or duplicate roster page would produce. Each is grounded in
this project's real data shapes, not the completion plan's illustrative
pseudocode, and each has both a passing and a violating test case.
`assertConfirmedOnlyRowsAreConfirmed` is now wired into the confirmed-only
export's click handler in `sidepanel.js` — the filter already guarantees
the invariant by construction, so this is a fail-closed backstop against a
future change breaking that guarantee silently, not a check expected to
ever actually fire today.

`tests/simulator/fullPipelineSimulator.test.js` is the capstone: it chains
`fetchCommunityMembersByCursor`, `fetchActiveAuthors`,
`annotateMemberActivity`, `classifyFlaggedMember`,
`verifyMemberActivityViaSearch`, `classifySearchVerification`, and
`summarizeScanCompleteness`/`determineActionability` in exactly the sequence
`sidepanel.js`'s `finalizeResultsAndSave`/`verifySearchActivityForFlagged`
use — reproduced here because `sidepanel.js` itself manipulates DOM elements
directly and can't be imported into a Node test. Against a 30-member
synthetic Community (20 active, 10 flagged, 2 cleared by direct search, 6
confirmed-inactive, 2 unverifiable-protected), every final member's
classification is declared up front and asserted exactly against what the
real functions produce. `composeFakeXServers` (`fakeXServer.js`) makes this
possible by routing one shared fake X across all four fake servers by
documentId/operation, so one test can drive every collector in the same run.

## 5.14.0 — a fake word-shard search server, closing out the simulator's fake-X endpoints

The per-shard walk itself (`backfillSupplementalTimelineAuthors`) was
already proven by the media simulator, since media and search share that
exact engine. What was still untested was what's specific to
`searchDiscovery.js`: the six-shard iteration itself, each an independent
checkpointed pass, accumulated into one deduplicated author set.
`fakeXSearchServer.js` routes by the `query` variable to give each shard its
own tweet pool; `searchSimulator.test.js` drives the real, unmodified
`backfillCommunitySearchAuthors` against six shards where two authors each
appear in two different shards and one shard finds nothing at all — proving
the union-and-dedup logic and the "some shards can be genuinely empty"
case together. `COMMUNITY_SEARCH_SHARDS` is now exported so the test
references the real shard words instead of a hand-duplicated copy that
could drift.

This closes out every fake-X endpoint from the "immediate next task": roster,
activity, media, search, and direct verification are now all driven through
their real, unmodified production collectors.

## 5.14.0 — a fake direct-verification server, driving the function whose output gets acted on

`verifyMemberActivityViaSearch` (`src/activity/directVerification.js`) is
the final evidence path before a member is exported as
`confirmed-inactive` — the one whose output this whole project's stated use
case (feeding a list to moderators) might act on directly. It had no
end-to-end test against the real orchestration at all before this.
`tests/simulator/fakeXVerificationServer.js` fakes
`CommunityTweetSearchModuleQuery`'s direct `(from:username)` search, and
`verificationSimulator.test.js` drives the real function against it —
reusing `fakeXActivityServer.js`'s response builders, since a direct search
answers under the same `community_filtered_timeline` envelope the
word-shard backfill already uses.

Six scenarios, each proving something specific: a recent post and a recent
reply both resolve to active; a genuine zero-result search resolves to
inactive; a repost is not counted as activity even as the only result found;
a post found but before the selected window correctly does not count as
in-window; a candidate deferred by a per-run cap gets no result entry at all
(never a guessed verdict); a transient 500 is retried and resolved correctly
within one candidate's request; and a permanent contract failure on one
candidate stops the *entire* run, leaving every later candidate unverified —
real, existing behavior this test surfaced rather than assumed, since a
single exhausted-retries failure aborts the whole batch instead of skipping
just that candidate.

Running the real function twice in the same test (to prove its storage-
backed cache is genuinely used, not just its request loop) caught a real,
minor finding along the way: the re-run's `reason` came back
`"queue-complete"`, not the `"up-to-date"` a first read of the initial
`stoppedReason` default might suggest — a later `checked >=
pendingCandidates.length` check (`0 >= 0`) overwrites it even when nothing
was pending. Harmless (both values mean "nothing left to do"), but exactly
the kind of thing only running the real code catches.

`verifyMemberActivityViaSearch` gained the same `limiter`/`delayFn`
injection points as the other collectors.

## 5.14.0 — a fake Community media server, driving the real media collector

`graphqlContracts.js`'s `requireCommunityTimeline` already documents that
Community activity, media, and search share one response contract, differing
only in which top-level field the timeline is nested under. Rather than a
third near-duplicate fake server, `fakeXActivityServer.js` gained a `kind`
parameter (`activity` | `media` | `search`) selecting the right envelope
field, and `tests/simulator/mediaSimulator.test.js` drives the real,
unmodified `backfillCommunityMediaAuthors`
(`src/activity/mediaCollector.js`, via the shared `backfillEngine.js`)
against it.

This engine turned out to behave differently from `fetchActiveAuthors` in
two ways worth proving rather than assuming: it has no lookback window (it
walks the whole history until the timeline genuinely ends), and it has no
repost filtering or tweet-ID dedup at all — every author behind every tweet
it sees counts, reposts included, because this pass exists as supplemental
bulk-discovery evidence, not an authoritative activity verdict (that comes
later, from direct search verification). The first test run caught this the
useful way: an assertion that assumed tweet-level dedup like the activity
engine's failed with a concrete number (420 scanned vs. 320 unique tweets)
that pointed straight at the real difference instead of a guess.

`backfillSupplementalTimelineAuthors` (the shared engine underneath media,
search, and — via a near-identical loop — the main timeline backfill) and
both `mediaCollector.js` and `searchDiscovery.js` gained the same `delayFn`
injection point as the roster and activity collectors.

## 5.14.0 — a fake X Community timeline server, driving the real activity collector

Same rationale as the roster simulator, applied to the other half of the
pipeline: `tests/simulator/fakeXActivityServer.js` is a deterministic fake
Community timeline server, and `tests/simulator/activitySimulator.test.js`
drives the real, unmodified `fetchActiveAuthors`
(`src/activity/timelineCollector.js`) against it — real request building,
the real `parseCommunityTimelinePage`/`communityActivityKind` parser, real
tweet-ID dedup across overlapping/duplicate pages, and the real
activity-window-complete decision logic.

Unlike the roster cursor, this endpoint has no seek/reseek mechanism in
production — `fetchActiveAuthors` only ever walks forward via the server's
own `nextCursor` until it decides the window is covered — so the fake
server's cursor is a plain opaque position, no equivalent of the roster's
dead-zone problem applies here, and none had to be invented.

The scenario proves several properties simultaneously against 600 synthetic
tweets across 140 authors: reposts never count as activity even within the
window; overlapping pages (each page re-serves the last 5 tweets of the
previous one, forcing the real `seenTweetIds` dedup to actually do work)
never inflate the discovered-author count; the window boundary is exactly
inclusive at `sinceDate` and exclusive one millisecond before it — two
tweets are planted precisely there and the assertion checks each
independently. A second test injects a 429 and a transient 500 mid-walk and
asserts the discovered authors come out identical to the fault-free run.

Extending the injectable-pacing seam from the roster work,
`fetchActiveAuthors` gained the same `delayFn` option (default: the real
`delay()`), so these tests run in milliseconds instead of paying real
per-request pacing.

## 5.14.0 — injectable pacing, and the roster simulator gets fast, adversarial, and full-scale

The roster simulator's real ~750ms-per-request pacing made its one test take
~30 seconds — a real cost, since it's the same pacing an actual scan uses to
stay well under X's rate limits, and it shouldn't change just because a test
wants to run faster. `AdaptiveRateLimiter` now takes an optional second
constructor argument, `sleep`, defaulting to the real timer-backed `delay()`
(`src/api/rateLimiter.js`); `graphqlGet` gained the matching `delayFn` option
for its own retry/backoff waits (network errors, 429, 5xx), same default.
`fetchCommunityMembersByCursor` threads both through as optional overrides,
defaulting to exactly what it already constructed internally
(`new AdaptiveRateLimiter(ROSTER_REQUEST_DELAY_MS)`). No production call site
changed behavior — pinned by a new `rateLimiter.test.js` and a source-text
regression assertion — and there's no global "test mode" flag anywhere;
injection is explicit, per call.

With that seam in place, `tests/simulator/rosterSimulator.test.js` went from
one ~30-second test to three, all fast:
- the original 900-member/tied-block/chain-cap scenario, now ~40ms;
- a new fault-injection scenario (a 429 and a transient 500 mid-walk) proving
  the real retry path in `graphqlGet` recovers without corrupting the
  collected roster — previously untested against the real collector, since
  injecting failures used to mean paying their real multi-second backoffs;
- a new **79,000-member, 500-page-chain-cap** scenario — the actual scale and
  cap this project was built around, previously only provable at a scaled-down
  size — reaching exact servable-ID coverage in ~550ms.

Total test suite: 4 seconds for 107 tests, versus 34 seconds for 101 before
this change.

## 5.14.0 — split the export safety gate's name, not just its value

`determineActionability` returned a single `{ safe, reason }` — a bare
`safe: true` sitting next to a completeness summary that could simultaneously
say `roster-partial`/`verification-remaining` invites misreading it as "this
whole scan is safe," when what it actually meant was narrower. It now
returns `{ reviewable, safeForAutomatedRemoval, reason }`: `reviewable`
gates the broad export, which deliberately mixes confirmed, unverified, and
unverifiable-protected rows for a human to look at; `safeForAutomatedRemoval`
gates the confirmed-only export, whose rows were already individually
verified by a direct search. Both compute from the same activity-window
precondition today — that's still the only scan-level gate either export
needs, since a row's own confirmed/unverified/unverifiable-protected tag
already carries the rest of the safety information — but the names now stay
distinct so a future scan-level gate has somewhere to attach without
conflating "safe to review" with "safe to act on unreviewed."

## 5.14.0 — a fake X roster server, driving the real production collector end to end

Every seek-resume test up to this point proved the *decision helpers*
correct (`shouldResumeChain`, `resolveRosterStopReason`, the cursor codec)
by driving them from a parallel reimplementation of the orchestration loop
(`liteScanner.test.js`'s `simulateSeekResume`) — never the actual, shipped
`fetchCommunityMembersByCursor` in `collectRoster.js`. A bug in how that
function actually wires those helpers together, as opposed to a bug in the
helpers themselves, had no test that could have caught it.

`tests/simulator/fakeXServer.js` is a small deterministic fake X roster
server, and `tests/simulator/rosterSimulator.test.js` drives the real,
unmodified `fetchCommunityMembersByCursor` against it — real request
building, the real cursor codec, real checkpoint persistence via a fake
`chrome.storage.local`, and the real chain-cap/dead-zone/reseek state
machine — then asserts the collected member ID set **exactly equals** the
servable roster's ID set, not just "most of it."

Building the fake server surfaced a real design lesson worth recording: an
early version encoded only a timestamp in its cursor, and a 100-member
same-timestamp block made it loop forever — any page-size slice of a tied
block maps back to the same timestamp, so a timestamp-only cursor can never
address "the 31st record sharing this timestamp." That's not a fake-only
problem; it's the exact reason production's dead-zone/overlap logic exists.
The fix was to have the fake server's cursor carry an exact position too,
checksummed against its timestamp — a real client-side seek
(`withRosterCursorTimestamp`) only ever rewrites the timestamp and page
counter, so after a seek the checksum no longer matches and the server
falls back to approximate (timestamp-only) repositioning, while an ordinary
continuation keeps its exact position. That's a faithful model of the real
constraint, not an artifact of the test.

The test scenario (900 members, a 100-member tied-timestamp block, a chain
cap of 6 pages — small next to a real Community's ~79,000 members and
500-page cap) is scaled down deliberately: `fetchCommunityMembersByCursor`'s
rate limiter imposes a real ~750ms wait per request, uninjectable from test
code by design since it's the same pacing a real scan uses, so wall-clock
cost is directly proportional to request count. At this scale the walk
takes 38 requests and ~30 seconds to reach exact 900/900 coverage through 7
real seek-resume segments — still structurally adversarial (a chain cap far
below what one unbroken chain could serve, and a tied block that would loop
forever without the dead-zone escape actually firing), just bounded enough
to run in CI on every push.

## 5.14.0 — OperationRegistry

X's persisted GraphQL operations are identified by an opaque document ID it
can retire or rewrite without warning — `operations.js`'s own comments
already note this happened once. There was previously no record of which
operations a scan actually confirmed still work versus one that came back
with a definitive rejection; a broken contract just looked like any other
error in the log. `src/api/operationRegistry.js` adds `OperationRegistry`,
wired into `graphqlClient.js` at exactly two points: a non-2xx HTTP status
and a GraphQL-level error in an otherwise-200 response both mean the
operation itself was rejected, so they're recorded as `broken` with a
reason (`http-400`, `graphql-error`); everything else — network blips, rate
limits, 5xx, session/auth failures — is deliberately left unrecorded, since
none of those say anything about whether the operation still exists.
Deliberately not a startup preflight probe: spending extra requests just to
check "is this alive" before every scan would cost real quota for no
benefit when the scan calls every operation it needs anyway, so health is
derived from real scan traffic instead. Uses the same "wrap
`requestStats`'s plain object by reference" pattern as `QuotaManager`, so it
required no changes to any of the 11 call sites across 8 files that call
`graphqlGet` — only `graphqlClient.js` itself changed. Now appears in the
sanitized diagnostics export as `report.diagnostics.operations`.

## 5.14.0 — cursor codec fuzz tests

The roster cursor codec mutates an undocumented X byte layout (see
`cursorCodec.js`'s own header comments), and the existing tests only proved
it correct against a handful of fixed example cursors. `tests/cursorCodecFuzz.test.js`
adds a small seeded PRNG (mulberry32 — this project has zero dependencies by
design, so no property-testing library) and generates 3,000 synthetic
cursors per property: timestamp round-trip, "a seek changes only the
timestamp field and the page-counter byte, nothing else," the page counter
always resetting to its start value, and failing closed on both undersized
buffers and implausible timestamps. The seed is fixed, so any failure is
reproducible from the seed/iteration number printed in the assertion
message. 12,000 total synthetic cursors exercised per run, versus roughly
half a dozen fixed examples before.

## 5.14.0 — one canonical answer to "can this output be trusted"

Whether a scan's output was safe to act on used to be answered three
separate times: the two export buttons' `.disabled` conditions each
re-checked `currentActivityState.complete` independently, and the results
summary sentence built its own partial-roster/verification-remaining caveats
inline as string concatenation. `src/core/scanCompleteness.js` makes it one
computation instead: `summarizeScanCompleteness({ roster, activity,
verification })` builds a canonical snapshot with an `actionable` flag and a
`caveats` list (`roster-partial`, `verification-remaining`), and
`determineActionability(summary)` is the specific gate the export buttons
now both call through. This intentionally does not turn into a new blocking
rule — a partial roster still exports, exactly as before, because blocking
it would defeat the reason seek-resume exists for large Communities. What
changes is that the rule is now one tested function instead of a duplicated
inline check, and the same canonical object now appears in the sanitized
diagnostics export (`report.scan.completeness`) as a single authoritative
answer instead of something a reader has to reconstruct from `roster` and
`activity` separately.

## 5.14.0 — CI

`.github/workflows/test.yml` runs `npm run check` (syntax check across every
top-level entry point, then the full test suite) on every push and pull
request. Everything the 5.14 refactor relied on running clean locally is now
enforced on GitHub too, instead of depending on remembering to run it by
hand before merging.

## 5.14.0 — ScanCoordinator

A scan's nine stages — discover the Community, collect the native roster,
collect by cursor, DOM fallback, finalize the roster, analyze recent
activity, archive timeline/media/search, merge and verify authors, finalize
results — used to be nine bare `await` calls in a row inside the form's
submit handler. Nothing owned that sequence as data: it couldn't be timed,
inspected, or iterated over, only read top-to-bottom as code.
`src/core/scanCoordinator.js` adds `ScanCoordinator`, a small class that runs
an explicit, named step list (`sidepanel.js`'s `SCAN_STEPS`) and reports each
step's name, duration, and success/failure via `onStepStart`/`onStepEnd`
hooks. It deliberately does not take over UI phase text, DOM updates, or
Stopped/error handling — those still belong to each step function and to the
existing try/catch in the submit handler; the coordinator only makes the
outer sequencing itself explicit and observable instead of implicit. Each
step's timing now lands in `requestStats.steps` and flows into the sanitized
diagnostics export (`diagnostics.js`), so a scan that stalls or runs slow now
shows *which* stage did it, not just the eventual failure message. Unit
tested directly (`tests/scanCoordinator.test.js`) with fake steps, no
`chrome.*` mocking required.

## 5.14.0 — classification as pure evidence-to-verdict functions

The rule for what makes a member "flagged," what a flag reason says, and what
a direct-search result means for an already-flagged member used to live
inline in `sidepanel.js`'s `finalizeResultsAndSave`/`verifySearchActivityForFlagged`
— correct, but only exercisable by running a scan, and mixed in with the
DOM/progress-bar updates around it. `src/activity/classification.js` now
exposes it as three pure functions: `annotateMemberActivity(member, activity)`
merges a roster member with its activity counts; `classifyFlaggedMember(member,
lookbackDays)` produces the flag reason; `classifySearchVerification(member,
result)` resolves what a direct `(from:username)` search result means —
cleared, `confirmed-inactive`, `unverifiable-protected` (a protected account's
empty search result can never be told apart from genuine silence), or
`unverified` (no result was ever produced). All three are unit-tested
directly (`tests/liteScanner.test.js`) without running a scan or mocking
`chrome.*`. `sidepanel.js` now just calls them and applies the result — no
duplicated `verification.results.get(...)` lookup, no rule logic left to
drift out of sync between the filter and the map that used to compute it
twice.

## 5.14.0 — QuotaManager

Rate-limit bookkeeping used to be four inline `numberHeader()` calls and a
hand-rolled warning-threshold check buried inside `graphqlGet`'s retry loop —
correct, but untestable in isolation and easy to break silently while editing
the surrounding retry logic. `src/api/quotaManager.js` pulls that out into
`readRateLimitHeaders()` (a pure function: `Headers` in, `{limit, remaining,
resetAt}` or `null` out) and a `QuotaManager` class that tracks each
operation's bucket independently, since X's `x-rate-limit-*` headers are
per-operation, not global — verified live earlier this project by comparing
`CommunityTweetSearchModuleQuery`'s bucket against the roster/timeline
operations' buckets and finding them unaffected by each other. `graphqlGet`
now just calls `quotaManager.record(operation, headerInfo)`; the "remaining
requests dropped low enough to back off" decision (`enteringWarning`) is now
a return value instead of nested mutation, and both pieces have direct unit
tests (`tests/quotaManager.test.js`) that don't require mocking `fetch`.
`requestStats.quotas` — read by `diagnostics.js` and the UI — keeps its exact
existing shape; `QuotaManager` just wraps that same object by reference, so
this is a pure extraction, not a contract change.

## 5.14.0 — the module split

Everything that used to live in one 2,541-line `liteScanner.js` — GraphQL
transport, rate limiting, operation contracts, roster collection, cursor
seeking, checkpointing, activity discovery, direct verification, and CSV
export — is now organized into 27 files under `src/`:

```
src/core/     shared low-level helpers (errors, time, response-tree unwrapping)
src/api/      the GraphQL transport layer (client, rate limiter, operation contracts)
src/roster/   roster collection: cursor codec, seek-resume, checkpointing,
              parsing, moderators, community info, membership verification
src/activity/ timeline/media/search discovery, direct search verification,
              activity classification
src/export/   CSV builders
```

`liteScanner.js` is now a 71-line re-export barrel — every symbol it used to
define, it now re-exports from its real home under `src/`, under the exact
same name. Nothing that imports from it (`sidepanel.js`, every test file)
needed to change. This was done as a careful, verified cutover, not a
rewrite: every extracted block is the original code, moved and given real
module boundaries based on its actual dependencies rather than assumed ones
— for example, the tree-walking helpers `firstKey`/`findUserResult` turned
out to be shared by five different roster parsers, so they got their own
`roster/graphqlTree.js`, and `unwrapUserResult`/`unwrapTweetResult` are used
by both roster's moderator parser and activity's tweet parser, so they
landed in `core/`. The full 64-test suite passes against the new module
tree exactly as it did against the old single file.

## 5.13.3 — a separate export for what is actually safe to act on

The main export intentionally mixes three states in one file — `confirmed-inactive`,
`unverified`, and `unverifiable-protected` — because that mix is the right
thing to review. It is the wrong thing to act on directly: when this list's
purpose is choosing who to remove from a Community, treating an unverified row
the same as a confirmed one risks removing someone who was never actually
checked. A second export, **Export direct-search-confirmed only**, filters to
just the rows a direct search actually confirmed, with its own count shown on
the button before export. The main export and its manual-review warning are
unchanged and remain the default; this adds a narrower, lower-risk option
alongside it rather than replacing anything.

## 5.13.2 — external audit: nothing public beats this, tuned the one thing that could

A survey of the public ecosystem — `twscrape`, `twitter-api-client`, the
Chrome Web Store roster exporters, the Apify community scrapers — turned up no
implementation that goes past the same `membersSliceTimeline_Query` web-cursor
cutoff this project's own audit already identified. `twscrape`'s source, read
directly, confirms it: its `community_members()` calls only that operation,
with plain cursor-following and no seek. None of the public tools use the
native Android roster route this project uses, and none rewrites a cursor's
position. The roster mechanism here has no known public precedent to catch up
to.

One number from that audit was worth checking directly rather than trusting a
library's docs: `CommunityTweetSearchModuleQuery` — the operation 5.13.0's
direct-search verification depends on — was confirmed live, from its own
`x-rate-limit-*` response headers, to hold its **own 500-per-15-minute quota,
independent of every other operation the scan uses**. It shares that bucket
only with the word-shard author-discovery backfill earlier in the same scan
(≤48 requests), not with roster collection or the timeline archive. With that
confirmed rather than assumed, the per-run verification cap moves from 300 to
**400** flagged members — checked math, not a guess: 400 + 48 ≤ 448, preserving
roughly the same safety margin under 500 the previous number had before this
was known, while working down a large flagged backlog about a third faster.

### On "scan every member's tweets"

Individually querying all ~79,000 members would cost that many requests; even
saturating the confirmed 500-per-15-minute budget with zero errors, that is
close to **40 hours of continuous requests** — and X's rate limit is enforced
server-side per account, so no cursor trick defeats it the way the roster page
cap was defeated. It is also unnecessary: the chronological timeline archive
already discovers every author who has ever posted at a cost bounded by total
*posts*, not total *members*, which is normally far smaller. The efficient
architecture — already what 5.13.0 shipped — is bulk discovery first
(timeline + media + word-shard search, cheap, exhaustive), then per-member
direct search only on the residual members that bulk discovery could not
confirm. That residual set is the actual price of certainty, and it is
supposed to be much smaller than the full roster.

## 5.13.1 — the CSV states which rows were actually confirmed

5.13.0 shipped direct-search verification but left its result invisible in the
export: a large flagged set is worked down 300 members per scan, so most rows
in an early export were unconfirmed and looked identical to the ones the direct
search had just cleared. Each exported row now carries an `activity_verification`
column:

- `confirmed-inactive` — a direct search found nothing, and the result is
  trustworthy for this account.
- `unverifiable-protected` — a direct search found nothing, but the account is
  protected. An empty result there means only that this session cannot see its
  posts, not that none exist, so the row must not be read as confirmed.
- `unverified` (the default) — not yet checked; the row rests on the broad
  crawl alone.

The results summary now states how many flagged members were confirmed this
scan and how many remain, and (before this fix) a globally very active account
that had never posted in the target Community was independently verified live
to return zero results, confirming the search is genuinely community-scoped
rather than leaking a member's activity anywhere on X.

## 5.13.0 — every flagged member is confirmed with a direct search, not inferred

The broad Community timeline/media/word-shard crawl that activity classification
was built on cannot see everything: it runs on a bounded page budget, and its
only search coverage is a handful of generic words (`a`, `the`, `to`, …). A
member who genuinely posted, just not in a way that crawl happened to catch,
was flagged inactive on inference rather than evidence.

`CommunityTweetSearchModuleQuery` — the exact operation and document ID the
word-shard backfill already calls — accepts an X search operator directly.
Querying `(from:<username>)` scoped to the Community, confirmed against the
live x.com search UI, returns exactly that member's posts there, ranked by
recency. One request per member answers the question with certainty.

This only ever runs against the members a scan has **already flagged**, never
the full roster: the roster is tens of thousands of accounts, and a member
already confirmed active by the broad crawl needs no further check. Verification
is capped at 300 members per run and its result — a plain "when did this account
last post here" timestamp, not tied to any particular lookback window — is
cached for 24 hours, so a large flagged set is worked down across scans exactly
the way membership verification already is. A member the direct search confirms
active is removed from the exported list entirely, not merely annotated.

## 5.12.3 — seek-resume actually reaches the end of the roster

Seek-resume existed but stopped at 46,951 of 79,397 and recorded
`seek-resume-exhausted`, i.e. it resumed once, re-entered ground it already
held, and concluded the roster was finished. Four faults combined to produce
that, all now fixed:

- **Only one kind of stall counted as resumable.** A chain that stalled because
  the walk re-entered collected ground (`no-new-members`) or because the cursor
  repeated simply ended the walk; only X withholding the next cursor triggered a
  resume. `shouldResumeChain()` now treats all three as the chain ending rather
  than the roster ending.
- **A known member count was required.** The resume condition demanded
  `expectedCount`, so a failed `CommunityAnalyticsQuery` — its quota is 50
  requests per window — silently disabled seek-resume entirely and dropped the
  scan back to the page cap with no indication why. An unknown total is now a
  reason to keep going.
- **Duplicate pages ended a resumed chain.** Re-crossing collected ground on the
  way to ground that is not collected yet took about 350 pages in a modelled
  roster, while the idle limit was three. The limit during a resumed walk is now
  600 — above X's 500-page chain cap, so it cannot fire mid-crossing, yet finite
  so a chain serving only duplicates cannot spend the whole page budget.
- **Successive resumes could compute the same position forever.** A segment that
  ended before it could be judged left the idle counter untouched, so every
  resume seeked to the same target, re-walked the same ground, and burned the
  segment budget without advancing. Seek targets are now strictly monotonic.
- **A seek past the end of the roster was never judged.** X counts deactivated
  and suspended accounts it will not serve, so a walk can never reach the
  advertised total and must instead recognise that the roster has ended. A
  segment that served no records at all was too short to be judged "fairly
  tried", so the idle counter never advanced and each resume stepped a single
  millisecond past the end. Serving nothing is now a complete verdict on a
  segment however short it was. On a roster advertising 79,397 with 76,273
  actually servable this cut a run from 1,242 requests and 240 resumes to 772
  and 9 — the same members either way, 38% fewer requests — and, more usefully,
  changed the recorded stop reason from `seek-resume-segment-limit` (an internal
  budget ran out) to `seek-resume-exhausted` (X served everyone it will). That
  is the difference between a scan that gave up and one that finished.

One earlier fix was wrong and has been replaced. Stepping forward past a stalled
position used a skip that doubled from six hours to sixty-four days. That steps
over members who were never collected — a modelled roster lost 21,540 of them to
a single six-hour skip and finished at 66.57%. The step is now **one
millisecond**: a stall means members share that exact timestamp, so one
millisecond is the smallest move that escapes it and the only one that cannot
skip anybody.

Measured on the modelled server (members ordered by join time, 100 per page,
500-page chain cap):

| roster shape | before | after |
| --- | --- | --- |
| cap lands inside a block of members sharing one timestamp | 66.57% | 100% |
| many smaller tied blocks | 87.41% | 100% |
| realistic front-loaded join times | 100% | 100% |

The simulation that previously guarded this passed with the broken constants in
place, so it proved nothing; it now drives the real exported helpers over the
shapes that actually failed.

Seek-resume remains opt-in. It relies on X's current cursor layout and issues
many more requests, and every helper fails closed, so an unrecognised cursor
disables seeking rather than corrupting a scan.

## 5.12 — explicit zero-activity classification

A member is now flagged as inactive only when the selected Community timeline
window is fully covered and the scanner finds **zero original Community posts
and zero Community replies** for that member. Likes, reposts, posts outside the
Community, and authors merely quoted by another member do not count.

The configurable minimum-post threshold has been removed to make the rule
unambiguous. Activity checkpoints now retain unique tweet IDs so overlapping
cursor pages cannot inflate counts, and exports report original posts and
replies separately. A lookback of 90 days covers exactly 90 calendar dates,
including today, through the current moment.

## 5.11 — past X's roster page cap

X's roster cursor is an unsigned base64 Thrift struct. Byte 30 begins a
big-endian int64 holding the join-time position the next page reads from, and
the server validates nothing else about it. Rewriting those eight bytes seeks to
any point in the roster and returns a fresh, valid continuation cursor.

That matters because a cursor chain is capped at **500 pages**. On the audited
79,397-member Community the cap stopped collection at 46,960 with the final page
still returning a full 100 records and `zeroAdditionPages: 0` — the roster was
not exhausted, the chain was. Re-seeking from the last position starts a new
chain and continues.

A measured run reached **76,273 members (96.07%)**, 5,487 of them private. A
24-point sweep across the whole join-time range then returned **zero** further
members, so the roster is saturated: the remaining ~3,100 are counted in X's
advertised total but never served, and are almost certainly deactivated or
suspended accounts. **76,273 is 100% of what X will return.**

This is **opt-in and off by default** (*Continue past X's roster page cap*). It
deliberately works around a server-side pagination limit rather than replaying
X's own cursors, it multiplies request volume enough to hit the 500-per-15-minute
quota, and it depends on X's current cursor layout. Every codec helper fails
closed: an unexpected layout yields `null` and the scan simply stops at the cap
as before.

The naive version of this loops forever — once a chain ends, re-seeking into an
already-collected region returns the same members indefinitely. A segment that
adds nobody new therefore ends the walk (`seek-resume-exhausted`), and a hard
segment limit backs that up.

### 5.12.1 — the resume that never resumed

The first shipped version of the above stalled at **46,951 of 79,397** and
labelled it complete. Two defects, both found by reading a real scan's
checkpoint rather than the code:

- **The page counter travelled with the cursor.** Byte 71 of the cursor counts
  pages within a chain, and it is what the 500-page cap measures — eight
  consecutive pages read 2, 3, 4, 5, 6, 7, 8, 9 there. Re-seeking reused the
  cursor from the *end* of the spent chain, so the new chain inherited a budget
  of 500 and returned a single page with no continuation (`pageCount: 501`).
  Seeking now resets that byte and prefers the walk's opening cursor as its
  template.
- **A segment was judged after one page.** A resumed segment deliberately opens
  inside a two-second overlap window, so its first page returns members already
  held. Concluding "this segment found nobody" from that ended the walk at the
  very cap it exists to defeat. A segment must now run at least five pages
  before it can be called unproductive, two consecutive unproductive segments
  are required to stop, and an unproductive position is skipped *forward* rather
  than retried.

`seek-resume-exhausted` also no longer counts as complete. X ceasing to return
new members is not the same as reaching the advertised count, and treating it as
completion is what let a 59%-coverage result present itself as finished.

**5.10.2 discards every checkpoint written before the parser fix.** The broken
collector could record "terminal, 0 members" for the native scope, and
`fetchCommunityMembersByCursor` replays a recent terminal partial checkpoint for
six hours — so a scan run straight after upgrading could reuse that empty result
and appear unfixed. The cursor checkpoint schema is bumped to 3, which makes
`loadCursorCheckpoint` drop the old records, and a checkpoint holding zero
members is now never reused regardless of its age.

**5.10.1 fixes the bug that made all of the above unreachable in practice.** The
native roster route had never actually returned a member. It does not answer
with the web slice's `items_results`/`next_cursor` shape at all — it returns a
timeline whose entries carry `TimelineUser` items and whose cursor node is
marked with `__typename`, not `entryType`. The parser understood only the web
contract, so a perfectly good HTTP 200 was read as zero members and no cursor,
the route was recorded as having stopped, and every scan fell back to the web
slice. On the audited Community that showed up as **9,237 members / 11.6%
coverage** instead of the 46,960 the same endpoint returns when its response is
parsed. `parseCommunityMembersCursorPayload` now detects the shape and delegates
to `parseCommunityMembersTimelinePayload`, and `bottomTimelineCursor` accepts
both node markers. Verified live: 92–96 members per page with the cursor
advancing normally.

Version 5.10 replaces an assumption that shaped every earlier release. A
signed-in walk to termination on 2026-07-30 measured X's native
`CommunitiesMembersAllQuery` route reaching **46,960 unique members over 501
pages** on a Community advertising 79,397 — roughly **five times** the ~9,300
records the web `membersSliceTimeline_Query` cursor returns. The native route is
the primary roster source, not the bounded experiment 5.4 described. Once it
reaches X's own terminal cursor the web slice is skipped instead of replayed at
18 records per page, which removes thousands of requests that could only
re-derive a smaller set.

Three further changes come from the same live audit:

- **A single duplicate-only page no longer ends a scan.** X serves overlapping
  member pages — the measured walk averaged about 91 unique records per
  100-record page — so collection now continues until three consecutive pages
  add nothing, the cursor repeats, or the cursor ends. Previously one such page
  truncated the roster and cached the truncation as terminal for six hours.
- **`moderatorsSliceTimeline_Query` is collected as roster evidence.** It
  returned all 37 moderators and admins in one uncursored request, against the
  5 the About timeline exposes; 9 of them appeared nowhere in the full
  46,960-member walk. Every record carries an X-assigned role.
- **`CommunityAnalyticsQuery` supplies the totals.** It answers for a viewer
  holding no Community role, giving an authoritative `total_members` as the
  coverage denominator and `unique_posters` as a completeness target for author
  discovery, which previously ran until a cursor ended with nothing to measure
  itself against.

The native page size is now requested as 100. X clamps this operation to 100
server-side without returning an error, so the previous 200-record request only
misreported the page size in diagnostics; the downgrade path is retained in case
X starts rejecting oversized pages outright.

### Interface work in 5.10

The panel was measured in a real browser rather than restyled by eye:

- **Typography now targets the fonts that actually resolve.** The design asked
  for Inter at weights like 520, 650, 720, and 750. Inter ships with neither
  Chrome nor Windows, so most installs render Segoe UI, which has no such
  faces — every one of those weights collapsed onto 400 or 700 and labels meant
  to differ came out identical. Weights are now the five real ones, hierarchy
  comes from size, letter-spacing, and colour, and a shared type scale replaces
  scattered pixel values. The dashboard gets the same scale one step larger
  instead of two dozen font-size overrides.
- **Nothing renders below 10px.** Stat labels were 8px and several captions 9px.
  A test enforces the floor and rejects unsupported weights so the regression
  cannot come back.
- **The scan log no longer flickers.** Every log line rebuilt all 80 retained
  rows, which re-ran each row's entrance animation and threw away the reader's
  scroll position mid-read. Entries are appended, and the view auto-scrolls only
  when it was already at the bottom.
- **Less compositing during long scans.** Cards no longer carry a
  `backdrop-filter` that was invisible over an opaque background, the two
  blurred ambient elements became background gradients, and the progress
  shimmer runs only while progress is genuinely indeterminate.
- **Coverage is a stat, not a sentence.** The percentage an operator acts on sits
  in the stat row beside the raw counts, amber while partial.
- Contrast was raised on muted text, decorative dots are hidden from screen
  readers, the phase rail is an ordered list, the progress bar is labelled,
  inputs and the log disclosure have visible focus rings, and a
  `prefers-contrast: more` block flattens the translucent surfaces.

Version 5.9 adds three independently verified X Community sources discovered
from the live web client:

- `CommunityMediaTimeline`, with its own resumable cursor and author archive;
- chronological `CommunityTweetSearchModuleQuery` shards for common terms,
  each with an independent durable cursor; and
- `CommunityAboutTimeline`, which returns visible moderator and featured-member
  groups as confirmed roster evidence.

These sources are merged by stable user ID and retain separate diagnostics and
stop reasons. A failure or operation rotation in a supplemental source does
not abort the main roster/activity scan. Search and media authors remain
supplemental until exact membership verification succeeds. This increases
historical-author coverage but does not expose accounts that never posted and
are absent from X's returned member groups.

Version 5.9.2 also accepts the live July 2026 relationship-verification
contract, where X places `role` directly on each typeahead result. This fixes
exact member verification for known post authors while retaining compatibility
with the older nested `community_role` shape.

Version 5.8 adds an explicit **Archive the Community timeline from newest to
oldest** option. The archive follows X's `CommunityTweetsTimeline` cursor,
stores every page and unique author locally, and resumes from a durable
Community-specific checkpoint on later scans. The normal activity window is
still refreshed from the newest posts on every scan, while the archive keeps
moving backward without restarting. Reaching X's terminal timeline cursor is
reported separately from hitting the per-run page budget or a repeated/empty
cursor. Timeline authors are supplemental evidence until X's exact membership
check confirms them; accounts that never posted remain undiscoverable through
this source.

A local Chrome extension that finds Community members
who posted fewer than a chosen number of times during a recent date window.
It uses your existing x.com login and exports one CSV for manual review.

Version 5.7 keeps a permanent, stable-ID union of every member directly
confirmed by X across roster snapshots. It records first/last confirmation,
snapshot sightings, privacy state, and discovery provenance without treating
an older sighting as proof of current membership. Exact author-verification
work now has an explicit durable pending queue, so the 350-check safety batch
continues on later scans instead of being reconstructed only from the current
run. Stronger exact-verification evidence also correctly promotes an existing
post-author record to `x-roster`.

Version 5.6 incorporates a public-contract and live-browser audit of Xquik.
Xquik's documented 200-result page is an aggregation provided by its private
server, while X's live web roster still returns about 20 records per GraphQL
page. The scanner now uses faster adaptive roster pacing and asks the distinct
Android roster operation for up to 200 records, automatically retrying at 100
when X rejects the larger request. This improves speed only; it does not change
X's terminal roster cursor or claim complete coverage.

Version 5.5 turns Community post authors into current-roster candidates. It
backfills up to ten years of Community history with resumable cursors, then
uses X's live `CommunityMemberRelationshipTypeahead` operation to verify exact
stable user IDs or usernames. Only exact matches whose current role is not
`NonMember` become confirmed roster records or private-account removal
candidates. Verification is locally checkpointed for seven days, limited to
350 candidates per run, and pauses cleanly on X rate limits.

Version 5.4 adds a bounded native-roster experiment discovered in the signed X
Android 12.11.0 app. The scanner tries Android's current
`CommunitiesMembersAllQuery` before replaying the live web member cursor. It has
its own durable checkpoint, merges by stable user ID, records sanitized
diagnostics, and falls back automatically when X rejects, retires, or caps the
operation. “All” is X's operation name, not a completeness guarantee; exports
remain partial unless the discovered roster reaches the advertised member
count.

Version 5.3 scopes DOM collection to X's primary Community roster column, so
the unrelated **Who to follow** rows rendered with the same `UserCell` marker
cannot enter member or private-account exports. It also adds a renewable
cross-interface scan lease: Lite and Full cannot run competing scans against
the same shared checkpoints or duplicate X request traffic. Activity analysis
now discovers X's current live `CommunityTweetsTimeline` operation before
scanning, preventing persisted-query hash rotations from breaking GraphQL
activity collection. Private-account exports remain restricted to accounts
actually returned by the current X roster; historical author evidence cannot
create a false removal candidate.

Version 5.2 refines the desktop dashboard with a deterministic two-column
workspace, responsive result placement, a direct **Open X tab** control, and
automatic return to the dashboard after the live member cursor is connected.
Cards no longer overlap when completed results are restored.

Version 5.1 added two interfaces over the same local scanner. **Lite** remains
the compact side panel beside X. **Full dashboard** opens a wide, responsive
Chrome tab with the same settings, checkpoints, diagnostics, privacy
results, and exports. Use the mode button in the header to switch surfaces;
no roster data is copied between services because both surfaces run inside the
installed extension.

Version 4.7 introduced a responsive dark operations interface with structured
scan stages, accessible status indicators, reduced-motion support, and a
professional event timeline. Raw query names, machine stop codes, DOM pixel
positions, and stack traces are translated into concise operator-facing scan
messages while technical errors remain available in the extension console.

Version 5.0 separates selected-window activity completeness from the optional
90-day author backfill, labels partial activity evidence in the CSV and
filename, stops short DOM reconciliation after three truly idle passes, and
compresses diagnostic histories into operation/page summaries plus small
tails. This makes a diagnostic export dramatically smaller without losing the
terminal cursor, latency, status, quota, or retry evidence needed to diagnose
a scan.

Version 4.9 added a one-click sanitized diagnostic report. It records request
status and duration, cursor page totals, rate-limit metadata, DOM fallback
state, activity progress, tab lifecycle state, the professional event timeline,
and the final stop reason. The report deliberately excludes cookies, request
headers, tokens, usernames, member records, and response bodies.

Version 4.8 is free and local-only. It removes external roster providers,
third-party API tokens, and paid-service permissions after a live browser and
open-source endpoint audit found no free source that can enumerate the hidden
remainder of a large Community roster. It keeps the direct X cursor, visible
DOM fallback, resumable checkpoints, and Community-author union, while clearly
labeling every result that falls short of the advertised member count as
partial.

## Why version 4 exists

The older extension tried to scroll X's virtualized Members roster in a hidden
popup. That cannot be made reliable from a normal extension: Chrome stops
`requestAnimationFrame`, throttles background timers, and can suspend painting
for fully covered windows. A JavaScript visibility shim and DevTools focus
emulation did not prevent Windows occlusion from stopping X's renderer.

Version 4 removes the hidden-popup claim. The Members page remains visible in
the main browser area and the scanner runs beside it in Chrome's side panel.
Reliable mode focus-locks that tab only while collecting members. Once post
analysis begins, the focus lock is released.

The collector was also changed from returning the entire accumulated roster on
every scroll step to returning only new or changed rows. This avoids quadratic
cross-extension copying on Communities with tens of thousands of members.

Version 4.4 uses X's cursor-based `membersSliceTimeline_Query` as the primary
roster collector. It detects the current persisted-query hash from the visible
Members page instead of hard-coding a hash that X can rotate, then requests
`{communityId, count, cursor}` pages directly. Every successful page and its
next cursor are checkpointed in `chrome.storage.local`. Interrupted scans resume
from the last saved cursor; repeated cursors and pages with no new members stop
immediately.

When X ends the cursor before the advertised member count, 4.4 records a
specific partial-roster reason and does not repeat the same server-limited
roster through hours of browser scrolling. Recent terminal partial checkpoints
are reused for six hours. A cursor-limited result gets at most a 15-pass DOM
reconciliation and stops after three genuinely idle passes; extended DOM
collection runs only when the cursor operation is unavailable or produced no
members. DOM idle and time-limit stops are never marked complete.

Roster records are deduplicated by stable X user ID when available, with
case-insensitive username fallback. Scan phase, stop reason, coverage, and
request totals are saved as durable job metadata. CSV exports include roster
status, coverage, found/expected counts, and stop reason on every result row;
partial exports also include `partial` in the filename.

Version 4.6 makes private-account review a separate roster result. It appears
as soon as member collection finishes, remains exportable while post analysis
runs, and survives Stop, errors, and side-panel closure. It contains every
discovered record whose X profile reports `protected: true`, including accounts
that were active and therefore absent from the inactivity CSV. The CSV contains
one `username` column. The text export contains one `@username` per line.
Private-account detection does not depend on Community activity or the selected
lookback window.

Version 4.4 also stops throwing away Community authors that are absent from
X's truncated Members response. Authors observed in the Community timeline are
deduplicated by user ID, added as supplemental evidence, and retained locally
for later scans. A recent author is labeled `recent-community-post`; an author
known only from an earlier scan is labeled `historical-community-post`.
Historical-author rows explicitly warn that current membership was not
confirmed by X's returned roster. They are manual-review candidates, not a
claim that the inaccessible portion of the roster was fully enumerated.

This author union costs no third-party API fee and requires no member-search
guessing. It grows with repeated scans and can discover accounts outside the
roughly 9,300 records X currently exposes through the Members cursor, but it
cannot discover members who never post.

Each scan counts activity only inside the selected lookback, while the same
timeline pass continues backward for up to 90 days to collect supplemental
author evidence. The backfill is capped at 250 pages per run and checkpoints
its cursor, so a busy Community can continue on the next scan instead of
restarting. Older author evidence never increases the selected-window post
count.

Post analysis is checkpointed separately by Community and date window. It
resumes from the last saved timeline cursor, understands both direct and module
timeline entries, and matches activity by stable user ID before falling back to
the current username. Server-provided rate-limit headers are recorded during
the scan, and Chrome-frozen tabs are reported explicitly.

## Use

1. Reload the unpacked extension at `chrome://extensions`.
2. Open the Community on x.com.
3. Click the **Community Activity** toolbar icon.
4. Stay in Lite beside X, or click **Full dashboard** to open the same scanner
   as a wide web-app interface in a separate Chrome tab. The dashboard reuses
   an existing dashboard tab instead of opening duplicates.
5. Choose the lookback window. The inactivity rule is fixed at zero Community
   posts and zero Community replies.
6. Leave **Keep the X Members tab visible if DOM fallback is needed** enabled
   unless Chrome was launched with the optional unthrottled launcher.
7. Start the scan. Cursor collection continues without scrolling once the live
   operation is detected.
8. Export the flagged results as CSV.
9. As soon as roster collection finishes, use **Export private usernames CSV**
   or **Export private usernames TXT** to review every detected private account.
   You do not need to wait for post analysis.
10. From Full, click **Open Lite panel** to activate the matching X Community
    tab and reopen the side panel.

The result is explicitly scoped to the number of members actually discovered.
If X stops serving the roster before the advertised Community count, the panel
shows the resulting coverage percentage and exact stop reason instead of
presenting it as complete.

## Optional unthrottled Chrome launcher

[`launch-unthrottled-chrome.ps1`](./launch-unthrottled-chrome.ps1) starts Chrome
with Chromium's testing switches that disable occluded-window, timer, and
renderer background throttling. Close every Chrome process before running it;
Chrome reads those switches only when the first process starts. The switches
apply to that Chrome session and can consume more CPU and battery.

When Chrome was started by this launcher, the foreground-lock checkbox can be
disabled and another application or Chrome window can cover the collector.
Keep the Members tab selected inside its own Chrome window: Chrome still pauses
animation frames for an inactive tab. The visible/focus-locked mode remains the
safest option.

These switches address Chrome scheduling only. They do not evade X login,
Community access controls, request quotas, or server-side pagination limits.

## What was removed

- Official X API bearer-token input
- Raw network/HAR recorder
- Runtime GraphQL operation-recovery controls
- Hidden/background Members popup
- Debugger permission and focus emulation
- Scan history and change comparison in the primary interface
- Role filters, protected-account presets, support bundles, XLSX/ZIP/JSON export
- Decorative progress features that do not communicate scan state

Both interfaces contain Community ID, lookback, activity threshold, focus lock,
progress, Stop, results preview, inactivity CSV export, and private-account
CSV/TXT export. Lite stays beside X; Full uses a dedicated extension tab.

## Permissions

- `cookies`: reads the x.com CSRF cookie needed for the same authenticated
  requests used by the web client.
- `scripting`: reads member rows from the visible x.com Members page.
- `webRequest`: observes x.com GraphQL request URLs during the one-time Members
  reload so the current operation ID, variables, and feature flags can be
  detected when Chrome's page Performance buffer omits the request. It selects
  only the live `x-client-transaction-id` header needed by the replayed request;
  cookie, authorization, and CSRF headers are not selected, stored, logged, or
  exported. Traffic outside x.com is not observed.
- `storage`: remembers the form settings and resumable cursor checkpoints.
- `unlimitedStorage`: prevents Chrome's normal local-storage quota from
  truncating checkpoints for Communities containing tens of thousands of
  members.
- `sidePanel`: hosts the scanner beside X.
- `https://x.com/*`: restricts page access and requests to x.com.

The scan stays in the extension and x.com. Cursor roster checkpoints remain in
Chrome local extension storage so a closed panel can resume. No Community
roster, browser cookie, or API token is sent to a third-party roster service.

## Limits

- X can change its DOM selectors or internal GraphQL operations without notice.
- Closing the side panel stops the current request, but successful member pages
  and job state remain checkpointed. An interrupted scan is identified when the
  panel reopens and cursor collection resumes on the next scan.
- In ordinary Chrome, switching away while foreground lock is disabled will
  slow or stop virtualized roster loading.
- On the audited 79,397-member Community, the web member cursor ends after
  roughly 9,300 records and the native route ends after 46,960 (59.15%). Both
  cutoffs are server-side and neither can be extended by more scrolling,
  retries, or a larger requested page size. No verified free API, extension, or
  open-source client exposes the members behind the native route's cutoff.
- Community-post authors can expand coverage over time, but cannot reveal
  members who never post. The extension never calls this union a complete
  roster unless the unique-member count reaches X's advertised count.
- Chromium command-line switches are testing controls and may change later.
- Automated access may conflict with X's terms. Use conservative thresholds,
  respect pauses, and manually review results before taking moderation action.
