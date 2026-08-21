import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The Phase 3 UI rewrite (see ui/scanEngine.js's own header comment) moved
// every DOM-string-matchable control out of sidepanel.html/js/css and into
// React components under ui/. This concatenates the view layer the same way
// rosterDomainSource() below concatenates the roster domain, so tests that
// used to grep sidepanel.html for a control's id can instead grep for the
// React binding (value=/checked=/onClick=) that replaced it.
async function uiViewSource() {
  const { readdir } = await import("node:fs/promises");
  let combined = await readFile(new URL("../ui/App.jsx", import.meta.url), "utf8") + "\n";
  const base = new URL("../ui/components/", import.meta.url);
  for (const name of await readdir(base)) {
    if (name.endsWith(".jsx")) combined += await readFile(new URL(name, base), "utf8") + "\n";
  }
  return combined;
}

test("lite manifest uses MV3 least privilege and stable Chrome APIs", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "5.17.4");
  assert.equal(manifest.minimum_chrome_version, "114");
  assert.equal("message_serialization" in manifest, false);
  assert.equal(manifest.permissions.includes("tabs"), false);
  assert.equal(manifest.permissions.includes("debugger"), false);
  assert.equal(manifest.permissions.includes("unlimitedStorage"), true);
  assert.equal("optional_permissions" in manifest, false);
  assert.equal("optional_host_permissions" in manifest, false);
  assert.equal(manifest.background.type, "module");
});

test("every declared permission has a verified, current call site - see PRIVACY.md's audit", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const [domScanSource, engineSource, graphqlClientSource] = await Promise.all([
    readFile(new URL("../domScan.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/scanEngine.js", import.meta.url), "utf8"),
    readFile(new URL("../src/api/graphqlClient.js", import.meta.url), "utf8"),
  ]);
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["cookies", "scripting", "sidePanel", "storage", "unlimitedStorage", "webRequest"],
    "the permission list itself changed - update this test and PRIVACY.md's audit deliberately, not silently"
  );
  assert.match(graphqlClientSource, /chrome\.cookies\.get/);
  assert.ok(
    domScanSource.includes("chrome.scripting.executeScript") || engineSource.includes("chrome.scripting.executeScript"),
    "scripting permission has no remaining call site"
  );
  assert.match(domScanSource, /chrome\.webRequest\.onBeforeSendHeaders\.addListener/);
  // Read-only: this permission must never gate a blocking response, header
  // rewrite, or a URL pattern broader than X's own GraphQL surface.
  assert.match(domScanSource, /urls: \["https:\/\/x\.com\/i\/api\/graphql\/\*"\]/);
  assert.doesNotMatch(domScanSource, /webRequestBlocking|onBeforeRequest\.addListener/);
});

test("side panel exposes only essential scan and CSV controls", async () => {
  const ui = await uiViewSource();
  // No element carries an id in the React views, so each control is
  // addressed by the state binding or handler that replaced its id-based
  // hook (value=/checked= for inputs, onClick= for buttons).
  assert.match(ui, /value=\{state\.communityId\}/);
  assert.match(ui, /value=\{String\(state\.lookbackDays\)\}/);
  assert.match(ui, /Inactive when/);
  assert.match(ui, /checked=\{state\.timelineBackfill\}/);
  assert.match(ui, /checked=\{state\.focusLock\}/);
  assert.match(ui, /type="submit"/);
  assert.match(ui, /onClick=\{stopScan\}/);
  assert.match(ui, /onClick=\{handleToggleMode\}/);
  assert.match(ui, /onClick=\{handleOpenCommunityTab\}/);
  assert.match(ui, /onClick=\{exportAllFlagged\}/);
  assert.match(ui, /onClick=\{\(\) => void exportDiagnostics\(\)\}/);
  assert.match(ui, /privatePanelVisible/);
  assert.match(ui, /private accounts found/);
  assert.match(ui, /onClick=\{exportPrivateCsv\}/);
  assert.match(ui, /onClick=\{exportPrivateText\}/);
  assert.match(ui, /aria-live="polite"/);
  assert.doesNotMatch(ui, /minPosts|Minimum posts/);
  for (const removed of ["officialApiToken", "diagnosticRecorderToggle", "operationRecoveryStatus", "exportFormat", "deepRescue", "useApifyProvider", "apifyToken", "apifyMaxCharge"]) {
    assert.doesNotMatch(ui, new RegExp(removed));
  }
});

test("private-account export becomes durable before activity analysis", async () => {
  const source = await readFile(new URL("../ui/scanEngine.js", import.meta.url), "utf8");
  const rosterPrivateIndex = source.indexOf(
    "currentPrivateAccounts = ctx.members.filter((member) => member.protected === true)"
  );
  const activityIndex = source.indexOf('setPhase("Analyzing posts", "activity")');
  assert.ok(rosterPrivateIndex >= 0);
  assert.ok(activityIndex > rosterPrivateIndex);
  assert.match(source, /privateAccounts: currentPrivateAccounts/);
  assert.match(source, /privateRosterReady/);
  assert.match(source, /member\.membershipEvidence === "x-roster"/);
});

test("the primary activity scan is not stopped by a small fixed page cap - the first real-validation finding", async () => {
  const [engineSource, collectorSource] = await Promise.all([
    readFile(new URL("../ui/scanEngine.js", import.meta.url), "utf8"),
    readFile(new URL("../src/activity/timelineCollector.js", import.meta.url), "utf8"),
  ]);
  // A live scan on an active-enough Community previously stopped after 250
  // pages (5,000 timeline entries) without ever reaching the requested
  // 30-day window, reported 0 flagged members every run, and told the
  // operator to press Start again indefinitely. The primary activity call
  // must not pass a small fixed maxPagesPerRun anymore.
  const analyzeIndex = engineSource.indexOf("async function analyzeRecentActivity");
  const nextFunctionIndex = engineSource.indexOf("\nasync function archiveTimelineMediaAndSearch");
  assert.ok(analyzeIndex >= 0 && nextFunctionIndex > analyzeIndex);
  const analyzeBody = engineSource.slice(analyzeIndex, nextFunctionIndex);
  // Checks for the actual property assignment, not the bare word - which
  // also appears in this function's own explanatory comment about why
  // there isn't one.
  assert.doesNotMatch(analyzeBody, /maxPagesPerRun:/);
  // The real stop conditions are the window being covered or this
  // operation's own observed quota running low - not a static count.
  assert.match(collectorSource, /maxPagesPerRun = 5000/);
  assert.match(collectorSource, /usableQuota\(observedQuota/);
  assert.match(collectorSource, /stopReason = "quota-paused"/);
  // The archival/backfill pass is intentionally different - conservative
  // and fine to spread across scans - and must keep its own budget.
  assert.match(engineSource, /maxPagesPerRun: AUTHOR_BACKFILL_PAGES_PER_RUN/);
});

test("side panel uses structured scan events and accessible motion", async () => {
  const [ui, css, script, background] = await Promise.all([
    uiViewSource(),
    readFile(new URL("../ui/theme.css", import.meta.url), "utf8"),
    readFile(new URL("../ui/scanEngine.js", import.meta.url), "utf8"),
    readFile(new URL("../background.js", import.meta.url), "utf8"),
  ]);
  assert.match(ui, /className="phase-rail"/);
  assert.match(ui, /className="scan-log"/);
  assert.match(ui, /role="log"/);
  assert.match(script, /professionalLogMessage/);
  assert.match(script, /Live roster connection established/);
  assert.match(script, /buildDiagnosticReport/);
  assert.match(script, /archiving-timeline/);
  assert.match(script, /will not physically scroll/);
  assert.match(ui, /data-stage=\{state\.phaseStage\}/);
  assert.match(script, /stage === "activity"/);
  assert.match(script, /collectSafeBrowserDiagnostics/);
  assert.match(script, /dashboardMode/);
  assert.match(ui, /Open Lite panel/);
  assert.match(script, /focusCommunityTab/);
  assert.match(script, /dashboardTab/);
  assert.match(background, /chrome\.tabs\.create/);
  assert.match(background, /ACQUIRE_SCAN_LEASE/);
  assert.match(background, /chrome\.storage\.session \|\| chrome\.storage\.local/);
  assert.match(background, /chrome\.storage\.session\?\.setAccessLevel\?\./);
  assert.match(script, /acquireScanLease/);
  assert.doesNotMatch(background, /chrome\.windows\.create/);
  assert.match(css, /data-mode="dashboard"/);
  // The vanilla version needed a `main:has(.progress-card[hidden])` layout
  // hack because hiding a section only ever toggled its `hidden` attribute.
  // ProgressPanel now conditionally unmounts instead (returns null when not
  // visible - see ProgressPanel.jsx), so there is nothing left for a :has()
  // selector to key off; its absence here is the correct state, not a gap.
  assert.doesNotMatch(css, /:has\(/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /--ease-out/);
});

test("panel typography stays on real font weights and a legible floor", async () => {
  const css = await readFile(new URL("../ui/theme.css", import.meta.url), "utf8");
  // Static system faces cannot render 520/650/720/750, so two labels asking for
  // different phantom weights render identically and the hierarchy is lost.
  const weights = [...css.matchAll(/font-weight:\s*(\d{3})/g)].map((match) => Number(match[1]));
  const inlineWeights = [...css.matchAll(/font:\s*(\d{3})\s/g)].map((match) => Number(match[1]));
  for (const weight of [...weights, ...inlineWeights]) {
    assert.ok([100, 200, 300, 400, 500, 600, 700, 800, 900].includes(weight),
      `unsupported font-weight ${weight}`);
  }
  // Nothing may be smaller than the --step--2 floor.
  const sizes = [...css.matchAll(/font-size:\s*(\d+)px/g)].map((match) => Number(match[1]));
  for (const size of sizes) assert.ok(size >= 10, `font-size ${size}px is below the 10px floor`);
  assert.match(css, /--step--2:\s*10px/);
  assert.match(css, /prefers-contrast: more/);
  // Counters must not reflow while a scan increments them.
  assert.match(css, /font-variant-numeric: tabular-nums/);
  // Cards no longer force a composited layer for the whole scan. Matches the
  // declaration only, so the comment explaining the removal is allowed to
  // mention the property by name.
  assert.doesNotMatch(css, /^\s*backdrop-filter:/m);
});

test("the scan log appends entries instead of rebuilding the list", async () => {
  const [script, component] = await Promise.all([
    readFile(new URL("../ui/scanEngine.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/components/ScanLog.jsx", import.meta.url), "utf8"),
  ]);
  // React's keyed reconciliation replaces the hand-rolled appendLogEntry()/
  // pinnedToBottom DOM-diffing the vanilla version needed - see ScanLog.jsx's
  // own header comment for why. What still has to hold: every entry needs a
  // stable, unique key (a real incrementing id, not array index - or React
  // re-animates/misorders unrelated rows), and scroll position must stay
  // pinned to the bottom unless the reader scrolled up to read something.
  assert.match(script, /let nextLogEntryId = 1;/);
  assert.match(script, /id: nextLogEntryId\+\+/);
  assert.match(component, /key=\{entry\.id\}/);
  assert.match(component, /pinnedRef/);
  assert.match(component, /el\.scrollTop = el\.scrollHeight/);
  assert.match(script, /coveragePercent/);
});

test("DOM collection sends deltas instead of cloning the full roster per pass", async () => {
  const source = await readFile(new URL("../domScan.js", import.meta.url), "utf8");
  assert.match(source, /primaryColumn \|\| document/);
  assert.match(source, /rosterRows\(\)/);
  assert.doesNotMatch(source, /state\.mutations\+\+;\s*collect\(\)/);
  assert.match(source, /pendingMembers = Object\.values\(state\.pending\)/);
  assert.doesNotMatch(source, /members:\s*Object\.values\(state\.members\)/);
  assert.doesNotMatch(source, /Object\.keys\(state\.members\)\.length/);
  assert.doesNotMatch(source, /onCheckpoint\?\.\(\{ members, complete: true \}\)/);
  assert.match(source, /stopReason = "dom-stalled"/);
  assert.match(source, /row-ancestor/);
  assert.match(source, /targetCount/);
});

// The 5.14 module split moved every pattern this test checks for out of
// liteScanner.js (now a re-export barrel, see its own header comment) into
// src/api/ and src/roster/. Concatenating that domain's real source keeps
// every regression this test pins meaningful, without needing a separate
// test per file for what was always one cohesive concern: the roster cursor
// implementation.
async function rosterDomainSource() {
  const { readdir } = await import("node:fs/promises");
  const dirs = ["../src/api", "../src/roster", "../src/activity"];
  let combined = "";
  for (const dir of dirs) {
    const base = new URL(dir + "/", import.meta.url);
    for (const name of await readdir(base)) {
      if (name.endsWith(".js")) combined += await readFile(new URL(name, base), "utf8") + "\n";
    }
  }
  return combined;
}

test("cursor mode discovers the live operation and checkpoints every page", async () => {
  const [domSource, scannerSource, setupFormSource, engineSource] = await Promise.all([
    readFile(new URL("../domScan.js", import.meta.url), "utf8"),
    rosterDomainSource(),
    readFile(new URL("../ui/components/SetupForm.jsx", import.meta.url), "utf8"),
    readFile(new URL("../ui/scanEngine.js", import.meta.url), "utf8"),
  ]);
  assert.match(domSource, /membersSliceTimeline_Query/);
  assert.match(domSource, /performance\.getEntriesByType\("resource"\)/);
  assert.match(domSource, /chrome\.tabs\.reload\(tabId\)/);
  assert.match(domSource, /safeRotatedName/);
  assert.match(domSource, /chrome\.webRequest\.onBeforeSendHeaders/);
  assert.match(domSource, /https:\/\/x\.com\/i\/api\/graphql\/\*/);
  assert.match(scannerSource, /clientTransactionId/);
  assert.match(scannerSource, /buildMemberCursorRequest/);
  assert.match(scannerSource, /cursorRoster:/);
  assert.match(scannerSource, /saveCursorPage/);
  assert.match(scannerSource, /repeated-cursor/);
  assert.match(scannerSource, /rate-limited/);
  assert.match(scannerSource, /activityScan:/);
  assert.match(scannerSource, /communityTimelineBackfill:/);
  assert.match(scannerSource, /backfillCommunityTimelineAuthors/);
  assert.match(scannerSource, /backfillCommunityMediaAuthors/);
  assert.match(scannerSource, /backfillCommunitySearchAuthors/);
  assert.match(scannerSource, /fetchCommunityAboutMembers/);
  assert.match(scannerSource, /activityWindowComplete/);
  assert.match(domSource, /discoverCommunityTimelineOperation/);
  assert.match(scannerSource, /timelineDocumentId/);
  assert.match(scannerSource, /operation\?\.documentId \|\| DOCUMENT_IDS\.CommunityQuery/);
  assert.match(scannerSource, /pageHasPreWindowPost/);
  assert.match(scannerSource, /no-new-members/);
  assert.match(scannerSource, /PARTIAL_CHECKPOINT_MAX_AGE_MS/);
  // Checkpoints written by the pre-5.10.1 collector could say "terminal, 0
  // members" for the native scope; they must not be replayed.
  assert.match(scannerSource, /CURSOR_CHECKPOINT_SCHEMA = 4/);
  assert.match(scannerSource, /checkpointHasMembers/);
  assert.match(scannerSource, /parseCommunityMembersTimelinePayload/);
  // Production pacing must stay the default: a test-injected limiter/delayFn
  // (see rateLimiter.test.js, simulator tests) must be opt-in, never a
  // change to what an ordinary scan actually waits.
  assert.match(scannerSource, /injectedLimiter \|\| new AdaptiveRateLimiter\(ROSTER_REQUEST_DELAY_MS\)/);
  assert.match(scannerSource, /delayFn = delay/);
  // Seek-resume must stay opt-in and must never loop on an exhausted region.
  assert.match(scannerSource, /seekResume = false/);
  assert.match(scannerSource, /seek-resume-exhausted/);
  assert.match(scannerSource, /SEEK_RESUME_MAX_SEGMENTS/);
  // Regression: a resumed segment was judged after a single page, which lands
  // inside the overlap window, so the walk ended at the cap with 46,951 of
  // 79,397 and called itself complete.
  assert.match(scannerSource, /SEEK_RESUME_MIN_SEGMENT_PAGES/);
  assert.match(scannerSource, /segmentPages >= SEEK_RESUME_MIN_SEGMENT_PAGES/);
  assert.match(scannerSource, /unproductiveSegments/);
  // Regression: duplicate pages must not end a resumed walk. Re-entering
  // collected ground on the way to uncollected ground can take hundreds of
  // pages, and any finite idle limit strands everyone beyond it.
  // Above X's 500-page chain cap, so it cannot fire mid-crossing, but finite so
  // a duplicate-only chain cannot spend the whole page budget.
  assert.match(scannerSource, /SEEK_RESUME_IDLE_PAGE_LIMIT = 600/);
  // Regression: a coarse forward skip steps over members that were never
  // collected. One millisecond escapes a tied timestamp without doing that.
  assert.match(scannerSource, /SEEK_RESUME_FORWARD_STEP_MS = 1/);
  // Regression: successive resumes must advance, or a segment that ends before
  // it can be judged pins the walk and burns the segment budget.
  assert.match(scannerSource, /lastSeekTarget/);
  // Re-seeks must use the opening cursor; a late-chain cursor carries a spent
  // page budget and yields one page with no continuation.
  assert.match(scannerSource, /seekTemplateCursor/);
  // A short roster must never be reported as complete.
  assert.doesNotMatch(
    scannerSource,
    /reason === "seek-resume-exhausted";\s*\n\s*const terminal/
  );
  // The checkbox itself carries no id in the React form - it is addressed by
  // its checked= binding, and defaults off through the store's own initial
  // state rather than a hardcoded `checked` attribute.
  assert.match(setupFormSource, /checked=\{state\.seekResume\}/);
  assert.match(engineSource, /seekResume: false,/);
  assert.match(scannerSource, /CommunitiesMembersAllQuery/);
  assert.match(scannerSource, /checkpointScope/);
  assert.match(scannerSource, /CommunityMemberRelationshipTypeahead/);
  assert.match(scannerSource, /verifyKnownCommunityMembers/);
  assert.doesNotMatch(scannerSource, /byUsername\.size/);
  assert.match(domSource, /maxIdlePasses = MAX_IDLE_PASSES/);
});

test("the scan runs its nine stages through ScanCoordinator, in order, with per-step timing recorded", async () => {
  const [engineSource, coordinatorSource] = await Promise.all([
    readFile(new URL("../ui/scanEngine.js", import.meta.url), "utf8"),
    readFile(new URL("../src/core/scanCoordinator.js", import.meta.url), "utf8"),
  ]);
  assert.match(engineSource, /new ScanCoordinator\(SCAN_STEPS\)/);
  assert.match(engineSource, /await coordinator\.run\(ctx,/);
  assert.match(engineSource, /requestStats\.steps/);
  const stepsIndex = engineSource.indexOf("const SCAN_STEPS = [");
  assert.ok(stepsIndex >= 0);
  const order = [
    "discover-community",
    "collect-native-roster",
    "collect-cursor-roster",
    "collect-dom-fallback",
    "finalize-roster",
    "analyze-recent-activity",
    "archive-timeline-media-search",
    "merge-and-verify-authors",
    "finalize-results",
  ];
  let cursor = stepsIndex;
  for (const name of order) {
    const found = engineSource.indexOf(`"${name}"`, cursor);
    assert.ok(found > cursor, `expected step "${name}" to appear in order after position ${cursor}`);
    cursor = found;
  }
  // Stopping mid-scan must not silently swallow which step failed: the
  // coordinator still lets the error propagate to the existing Stopped/Error
  // branching in the submit handler, it only adds observability around it.
  assert.match(coordinatorSource, /throw thrown/);
  assert.match(coordinatorSource, /onStepEnd\?\.\(step\.name, ctx, \{ durationMs/);
  // A step interrupted mid-run (browser closed, service worker suspended)
  // must leave a "running" trace, not be indistinguishable from a step that
  // was never reached at all.
  assert.match(coordinatorSource, /onStepStart\?\.\(step\.name, ctx\)/);
  assert.match(engineSource, /onStepStart: \(name\) => \{/);
  assert.match(engineSource, /status: "running"/);
  // Every stage's resumePolicy is a claim checked against its own real side
  // effects (see SCAN_STEPS' own comment), not copied from a template -
  // pinned here so a future step addition can't silently ship without one.
  for (const name of order) {
    assert.match(
      engineSource,
      new RegExp(`name: "${name}", resumePolicy: "(checkpoint-resumable|idempotent-rerun)"`)
    );
  }
});

test("resuming a saved scan job requires matching settings, not just the Community", async () => {
  const source = await readFile(new URL("../ui/scanEngine.js", import.meta.url), "utf8");
  // A job saved for a 90-day lookback must never be silently restored as
  // though it answered today's 30-day selection - see jobIdentity.js.
  assert.match(source, /isJobResumable\(\s*previousJob,\s*\{ communityId, lookbackDays, seekResume, timelineBackfill \},\s*SCAN_JOB_SCHEMA\s*\)/);
  // Both the save path (saveScanJob) and the resume-match path (init) must
  // read live settings through the same single scanSettingsSnapshot()
  // function, not two separately-tracked (and driftable) copies of it.
  const snapshotDefinitions = source.match(/function scanSettingsSnapshot\(\)/g) || [];
  assert.equal(snapshotDefinitions.length, 1, "scanSettingsSnapshot must be a single shared source of truth");
  assert.match(source, /const settings = scanSettingsSnapshot\(\);/);
  assert.match(source, /const SCAN_JOB_SCHEMA = 3;/);
});

test("Clear saved data is a distinct action from Discard resume, confirmed before running, and gated while a scan is active", async () => {
  const [storagePanelSource, engineSource] = await Promise.all([
    readFile(new URL("../ui/components/StoragePanel.jsx", import.meta.url), "utf8"),
    readFile(new URL("../ui/scanEngine.js", import.meta.url), "utf8"),
  ]);
  assert.match(storagePanelSource, /onClick=\{handleClearCommunity\}/);
  assert.match(storagePanelSource, /onClick=\{handleClearAll\}/);
  // The copy must state the distinction explicitly - see PRIVACY.md and the
  // completion plan's own finding that a user could otherwise believe
  // Discard resume deletes checkpoints it deliberately leaves in place.
  assert.match(storagePanelSource, /separate from\{" "\}\s*<strong>Discard resume<\/strong>/);
  assert.match(engineSource, /computeCommunityStorageKeys\(allEntries, communityId\)/);
  assert.match(engineSource, /await chrome\.storage\.local\.clear\(\)/);
  // Both destructive actions require an explicit confirmation before running.
  assert.equal((storagePanelSource.match(/const confirmed = confirm\(/g) || []).length, 2,
    "expected a confirm() gate on both clear actions");
  // Mid-scan, clearing storage could remove a checkpoint the running scan is
  // reading from or about to write to - gated by the same busy flag every
  // other storage-mutating control respects.
  assert.match(engineSource, /clearCommunityEnabled: currentCommunityHasData && !getState\(\)\.busy/);
  assert.match(engineSource, /clearAllEnabled: summary\.length > 0 && !getState\(\)\.busy/);
  assert.match(storagePanelSource, /disabled=\{!state\.clearCommunityEnabled\}/);
  assert.match(storagePanelSource, /disabled=\{!state\.clearAllEnabled\}/);
});

test("the supplemental archive's status is shown separately from the inactivity result, never blocking or implying it", async () => {
  const [flaggedViewSource, engineSource] = await Promise.all([
    readFile(new URL("../ui/components/FlaggedMembersView.jsx", import.meta.url), "utf8"),
    readFile(new URL("../ui/scanEngine.js", import.meta.url), "utf8"),
  ]);
  assert.match(flaggedViewSource, /archive-status/);
  assert.match(flaggedViewSource, /Separate from the flagged list above/);
  // The old resultSummary sentence blending timeline-archive status into the
  // same paragraph as the inactivity verdict must be gone, not duplicated.
  assert.doesNotMatch(engineSource, /Timeline archive: \$\{ctx\.timelineArchiveState/);
  assert.match(engineSource, /function renderArchiveStatus\(ctx\)/);
  assert.match(engineSource, /renderArchiveStatus\(ctx\);/);
  // Restoring a completed job from storage must show the same archive
  // status, not just the live in-scan path.
  assert.match(engineSource, /renderArchiveStatus\(\{ timelineArchiveState: previousJob\.diagnostics\?\.timelineBackfill/);
});

test("a plain-username export exists for the confirmed-inactive list, members only, gated the same as the CSV it pairs with", async () => {
  const [flaggedViewSource, engineSource, csvSource] = await Promise.all([
    readFile(new URL("../ui/components/FlaggedMembersView.jsx", import.meta.url), "utf8"),
    readFile(new URL("../ui/scanEngine.js", import.meta.url), "utf8"),
    readFile(new URL("../src/export/csv.js", import.meta.url), "utf8"),
  ]);
  assert.match(flaggedViewSource, /onClick=\{exportUsernamesOnly\}/);
  assert.match(csvSource, /export function buildFlaggedUsernamesText/);
  // Excludes any non-"Member" role, not just "Moderator" by name, so an
  // unhardcoded role tier (e.g. an Admin tier) can't slip into a
  // members-only list.
  assert.match(csvSource, /row\.role && row\.role !== "Member"/);
  assert.match(engineSource, /buildFlaggedUsernamesText\(confirmed\)/);
  // Same confirmed-inactive row set and the same fail-closed invariant check
  // as exportConfirmedOnly - the wrong list to act on directly is the broad
  // export, not this one.
  assert.match(engineSource, /export function exportUsernamesOnly\(\) \{\s*\n\s*const confirmed = currentResults\.filter\(\(row\) => row\.activityVerification === "confirmed-inactive"\);\s*\n\s*if \(!confirmed\.length\) return;\s*\n\s*assertConfirmedOnlyRowsAreConfirmed\(confirmed\);/);
  assert.match(flaggedViewSource, /disabled=\{!state\.exportUsernamesEnabled\}/);
});

test("export buttons are gated through the shared scan-completeness gate, not a local re-derivation", async () => {
  const [engineSource, flaggedViewSource] = await Promise.all([
    readFile(new URL("../ui/scanEngine.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/components/FlaggedMembersView.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(engineSource, /summarizeScanCompleteness\(\{/);
  assert.match(engineSource, /determineActionability\(currentCompleteness\)/);
  // The two gates stay distinct on purpose: a bare "safe: true" sitting next
  // to caveats like roster-partial invites misreading, so the broad export
  // (mixed confirmed/unverified/unverifiable-protected rows, for review) and
  // the confirmed-only export (individually direct-search-verified rows,
  // closer to safe for automated action) each get their own named gate.
  assert.match(engineSource, /exportEnabled: reviewable && rows\.length > 0/);
  assert.match(engineSource, /exportConfirmedEnabled: safeForAutomatedRemoval && confirmedCount > 0/);
  // The gate must not silently start blocking a partial-roster export - that
  // remains a deliberate, surfaced caveat, not a hard stop. See
  // scanCompleteness.js: only an incomplete activity window blocks either gate.
  assert.doesNotMatch(engineSource, /currentRosterState\.complete !== true \|\|/);
  assert.match(flaggedViewSource, /disabled=\{!state\.exportEnabled\}/);
  assert.match(flaggedViewSource, /disabled=\{!state\.exportConfirmedEnabled\}/);
});

test("flagged members are confirmed with a direct from: search before export", async () => {
  const [scannerSource, engineSource, csvSource, classificationSource] = await Promise.all([
    readFile(new URL("../src/activity/directVerification.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/scanEngine.js", import.meta.url), "utf8"),
    readFile(new URL("../src/export/csv.js", import.meta.url), "utf8"),
    readFile(new URL("../src/activity/classification.js", import.meta.url), "utf8"),
  ]);
  assert.match(scannerSource, /export async function verifyMemberActivityViaSearch/);
  // Same operation and document ID the word-shard backfill already uses — this
  // is a different query on an existing contract, not a new endpoint.
  assert.match(scannerSource, /query: `\(from:\$\{username\}\)`/);
  assert.match(scannerSource, /DOCUMENT_IDS\.CommunityTweetSearchModuleQuery/);
  // Verification must run only against members already flagged, never the
  // full roster — the roster is tens of thousands of accounts and this is not
  // a request budget spent on everyone.
  assert.match(engineSource, /verifySearchActivityForFlagged/);
  assert.match(engineSource, /verifyMemberActivityViaSearch\(\s*ctx\.communityId,\s*currentResults/);
  assert.doesNotMatch(engineSource, /verifyMemberActivityViaSearch\(\s*ctx\.communityId,\s*ctx\.members/);
  // A confirmed-active member must be removed from the exported flagged list,
  // not merely annotated.
  assert.match(classificationSource, /result\?\.hasActivityInWindow/);
  assert.match(engineSource, /classified\.cleared/);
  assert.match(scannerSource, /activitySearchCandidateIdentity/);
  // A protected account returns the same empty search result whether it
  // genuinely posted nothing or is simply invisible to this session, so an
  // empty result there is not the same evidence it is for a public account.
  // A row must say so rather than reading as an equally-confirmed "inactive".
  assert.match(classificationSource, /unverifiable-protected/);
  assert.match(classificationSource, /member\.protected === true/);
  // Every exported row must state whether it rests on the direct search or
  // only on the broad crawl's inference, and default to the unconfirmed state
  // rather than silently reading as verified.
  assert.match(csvSource, /activity_verification/);
  assert.match(csvSource, /row\.activityVerification \|\| "unverified"/);
  // How many candidates one run actually checks is planned from this
  // operation's real observed quota when available, not always the static
  // fallback constant.
  assert.match(scannerSource, /planWork\(pendingCandidates\.length, observedQuota/);
  assert.match(scannerSource, /requestStats\?\.quotas\?\.\[searchOperation\.operation\]/);
});

test("a separate export offers only the directly-confirmed subset, with a manual-review warning", async () => {
  // This export's stated purpose is deciding who to remove from a Community.
  // The main export intentionally mixes confirmed, unverified, and
  // unverifiable-protected rows for review; a second, narrower export must
  // exist so that decision doesn't default to the unfiltered list.
  const [flaggedViewSource, engineSource] = await Promise.all([
    readFile(new URL("../ui/components/FlaggedMembersView.jsx", import.meta.url), "utf8"),
    readFile(new URL("../ui/scanEngine.js", import.meta.url), "utf8"),
  ]);
  assert.match(flaggedViewSource, /onClick=\{exportConfirmedOnly\}/);
  assert.match(flaggedViewSource, /unverifiable-protected/);
  assert.match(flaggedViewSource, /review both manually before acting on them/);
  assert.match(engineSource, /activityVerification === "confirmed-inactive"/);
  assert.match(flaggedViewSource, /state\.confirmedCount\.toLocaleString\(\)/);
  // The confirmed export must filter currentResults, not just relabel it —
  // an unverified row must never end up in this file.
  assert.match(
    engineSource,
    /currentResults\.filter\(\(row\) => row\.activityVerification === "confirmed-inactive"\)/
  );
  // Fail closed rather than export: a thrown, machine-checkable invariant
  // backs the filter above instead of only trusting it silently.
  assert.match(engineSource, /assertConfirmedOnlyRowsAreConfirmed\(confirmed\)/);
});

test("the setup form names X's announced-but-unexecuted Communities shutdown, not silently", async () => {
  // X announced a hard 2026-05-30 cutoff and then missed it with no further
  // public statement (see the audit conversation this test comes from). A
  // sudden, total scan failure on a Community that worked before deserves to
  // read as "the platform may be gone", not as an unexplained bug in the
  // scanner - this only asserts the standing notice exists, not any
  // particular failure-detection behavior, since X's actual failure shape
  // can't be verified before it happens.
  const [notice, setupForm] = await Promise.all([
    readFile(new URL("../ui/components/PlatformStatusNotice.jsx", import.meta.url), "utf8"),
    readFile(new URL("../ui/components/SetupForm.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(notice, /2026-05-30/);
  assert.match(setupForm, /<PlatformStatusNotice \/>/);
});

test("roster sources use a pluggable registry", async () => {
  const { createRosterSourceRegistry } = await import("../rosterSources.js");
  const registry = createRosterSourceRegistry([
    { id: "fixture", collect: async () => ({ members: [{ username: "Alice" }], reason: "fixture" }) },
  ]);
  assert.equal(registry.has("fixture"), true);
  const result = await registry.collect("fixture", {});
  assert.equal(result.source, "fixture");
  assert.equal(result.members[0].username, "Alice");
});

test("extension remains local and free of third-party roster services", async () => {
  const ui = await uiViewSource();
  const [manifestText, engineSource, storeSource, packageText, privacy] = await Promise.all([
    readFile(new URL("../manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../ui/scanEngine.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/store.js", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../PRIVACY.md", import.meta.url), "utf8"),
  ]);
  for (const source of [manifestText, ui, engineSource, storeSource, packageText]) {
    assert.doesNotMatch(source, /api\.apify|Apify|Xquik|prove:full-roster/i);
  }
  assert.match(privacy, /No scan data is sent\s+to another service/);
});

test("optional launcher disables the three Chromium background schedulers", async () => {
  const source = await readFile(new URL("../launch-unthrottled-chrome.ps1", import.meta.url), "utf8");
  for (const flag of [
    "--disable-backgrounding-occluded-windows",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ]) assert.match(source, new RegExp(flag));
  assert.doesNotMatch(source, /Stop-Process|taskkill/i);
});
