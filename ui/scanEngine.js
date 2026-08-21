// The orchestration layer that used to live inside sidepanel.js, ported close
// to verbatim: every function below still does exactly the same work in the
// same order, against the same untouched src/*, domScan.js, liteScanner.js,
// rosterSources.js, observedAuthors.js, memberArchive.js, and diagnostics.js
// modules. The only thing that changed is *how a result becomes visible*:
// every `element.textContent = ...` / `classList.toggle` / manual DOM-node
// build from the original is replaced with a `setState(...)` patch that a UI
// layer (today: a thin vanilla adapter in sidepanel.js; later: React
// components) subscribes to and renders from. This module owns no DOM
// element references at all.
import {
  discoverCommunityTimelineOperation,
  discoverCommunityMembersOperation,
  fetchMembersFromActiveTab,
  mergeMemberLists,
} from "../domScan.js";
import {
  AdaptiveRateLimiter,
  ScanCoordinator,
  StoppedError,
  activityDetailsForMember,
  annotateMemberActivity,
  classifyFlaggedMember,
  classifySearchVerification,
  determineActionability,
  summarizeScanCompleteness,
  assertConfirmedOnlyRowsAreConfirmed,
  isJobResumable,
  summarizeResumableJob,
  computeCommunityStorageKeys,
  summarizeStorageByCommunity,
  estimateActivityThroughput,
  pushSample,
  buildCsv,
  buildFlaggedUsernamesText,
  buildPrivateAccountsCsv,
  buildPrivateAccountsText,
  calendarActivityWindow,
  backfillCommunityMediaAuthors,
  backfillCommunitySearchAuthors,
  backfillCommunityTimelineAuthors,
  downloadBlob,
  fetchActiveAuthors,
  fetchCommunityAboutMembers,
  fetchCommunityAnalytics,
  fetchCommunityInfo,
  fetchCommunityMembersByCursor,
  fetchCommunityModerators,
  NATIVE_MEMBERS_ALL_OPERATION,
  activitySearchCandidateIdentity,
  verifyKnownCommunityMembers,
  verifyMemberActivityViaSearch,
} from "../liteScanner.js";
import { createRosterSourceRegistry } from "../rosterSources.js";
import {
  activeAuthorToMember,
  observedAuthorToMember,
  rememberCommunityAuthors,
} from "../observedAuthors.js";
import { rememberConfirmedMembers } from "../memberArchive.js";
import { buildDiagnosticReport } from "../diagnostics.js";
import { createStore } from "./store.js";

const SCAN_JOB_KEY = "liteScanJob";
// Bumped to 3 when resume identity started including lookbackDays/
// seekResume/timelineBackfill, not just communityId - a schema-2 job record
// lacks those fields entirely, so this bump makes old records fail closed on
// the schema check instead of coincidentally matching an under-specified
// fingerprint.
const SCAN_JOB_SCHEMA = 3;
const SCAN_LEASE_MS = 45_000;
const scanOwnerId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const DOM_RECONCILIATION_PASSES = 15;
// Only for the supplemental timeline/media/search archival pass
// (archiveTimelineMediaAndSearch) - deliberately conservative and fine to
// spread across multiple scans, unlike the classification-blocking primary
// activity scan in analyzeRecentActivity, which no longer uses a fixed page
// cap at all (see fetchActiveAuthors' own default and reasoning).
const AUTHOR_BACKFILL_PAGES_PER_RUN = 250;

const rosterSources = createRosterSourceRegistry([
  {
    id: "x-native-all",
    collect: ({ communityId, operation, options }) =>
      fetchCommunityMembersByCursor(communityId, operation, options),
  },
  {
    id: "x-cursor",
    collect: ({ communityId, operation, options }) =>
      fetchCommunityMembersByCursor(communityId, operation, options),
  },
  {
    id: "x-moderators-slice",
    collect: async ({ communityId, options }) => {
      const members = await fetchCommunityModerators(communityId, options);
      return { members, complete: true, reason: "moderator-slice-complete" };
    },
  },
  {
    id: "x-dom",
    collect: ({ communityId, tabId, options }) =>
      fetchMembersFromActiveTab(communityId, tabId, options),
  },
]);

const dashboardMode = new URLSearchParams(location.search).get("mode") === "dashboard";

export const store = createStore({
  dashboardMode,
  surfaceNotice: "",
  contextLabel: "Open an X Community or paste its numeric ID.",
  contextTitle: null,

  resumeJob: null, // set to a summarizeResumableJob()-shaped object to show the resume panel

  communityId: "",
  lookbackDays: 30,
  timelineBackfill: true,
  focusLock: true,
  seekResume: false,
  busy: false,
  startLabel: "Start scan",

  progressVisible: false,
  phaseLabel: "Starting",
  phaseStage: "roster",
  phaseActiveIndex: 0,
  badgeClass: "",
  badgeLabel: "Running",
  statusText: "0 members",
  membersFound: 0,
  expectedMembers: null,
  coveragePercent: null, // null = indeterminate
  requestsCount: 0,
  coverageMessage: "",
  coverageMessagePartial: false,
  logLines: [],
  diagnosticsExportEnabled: false,
  diagnosticsExportBusy: false,

  archiveRows: [], // empty = hidden, matches archiveStatusPanel.hidden

  privatePanelVisible: false,
  privateRosterReady: false,
  privateAccounts: [],
  privateNote: "",

  resultsPanelVisible: false,
  results: [],
  resultSummary: "",
  previewNote: "",
  exportEnabled: false,
  exportConfirmedEnabled: false,
  exportUsernamesEnabled: false,
  confirmedCount: 0,

  storageCommunityCount: null, // null renders as "—"
  storageBytesLabel: null,
  clearCommunityEnabled: false,
  clearAllEnabled: false,
});

const { getState, setState } = store;

// ---------------------------------------------------------------------------
// Module-scope mutable engine state - mirrors exactly what were module-level
// `let` bindings in sidepanel.js. Deliberately NOT part of the reactive
// store: currentDiagnostics in particular is mutated at very high frequency
// (once per roster/activity page) and is only ever surfaced on demand (the
// "Export sanitized diagnostics" button, or folded into a saved job record),
// never rendered live field-by-field - publishing every mutation through
// setState would notify subscribers hundreds of times a minute for data
// nothing renders continuously.
let abortController = null;
let currentResults = [];
let currentPrivateAccounts = [];
let privateRosterReady = false;
let currentDiagnostics = null;
let currentCommunityId = "";
let expectedMembers = null;
let logLines = [];
let currentRosterState = { complete: false, found: 0, expected: null, reason: "not-started" };
let currentActivityState = { complete: false, backfillComplete: false, reason: "not-started" };
let currentCompleteness = null;
// A sliding window of {atMs, pages, oldestSeenAtMs} samples from the primary
// activity scan, feeding estimateActivityThroughput's moving-average
// rate/ETA - reset at the start of every scan, not carried across scans.
let activityThroughputWindow = [];
let leaseHeartbeat = null;
// Sticky across setPhase calls, exactly like the DOM version's persisted
// "active" class: a "stopped"/"error" stage keeps whichever step was already
// active rather than resetting to the first one.
let lastPhaseActiveIndex = 0;

export function getDiagnostics() {
  return currentDiagnostics;
}

// ---------------------------------------------------------------------------
// Pure helpers - unchanged from sidepanel.js, no DOM involved either before
// or after this port.

function communityIdFrom(value) {
  const text = String(value || "").trim();
  return text.match(/\/communities\/(\d+)/i)?.[1] || (/^\d+$/.test(text) ? text : "");
}

function professionalLogMessage(message) {
  const original = String(message || "").split("\n")[0].trim();
  const browserSweep = original.match(
    /^Browser scroll ([\d,]+): ([\d,]+) unique member\(s\);/
  );
  if (browserSweep) {
    return `Roster sweep ${browserSweep[1]} · ${browserSweep[2]} unique members discovered`;
  }
  const cursorFinished = original.match(
    /^Cursor collection stopped \(([^)]+)\) after ([\d,]+) page\(s\): ([\d,]+) unique member\(s\)\./
  );
  if (cursorFinished) {
    const reason = cursorFinished[1];
    if (reason === "cursor-ended-before-count") {
      return `Direct connection succeeded · X ended the server cursor after ${cursorFinished[2]} pages · ${cursorFinished[3]} members returned`;
    }
    return `Direct roster finished · ${cursorFinished[3]} members across ${cursorFinished[2]} pages · ${friendlyStopReason(reason)}`;
  }
  const browserFinished = original.match(
    /^Browser scroll stopped \(([^)]+)\): ([\d,]+) unique member\(s\)\./
  );
  if (browserFinished) {
    return `Visible roster finished · ${browserFinished[2]} members · ${friendlyStopReason(browserFinished[1])}`;
  }
  return original
    .replace(
      "Watching the Members page for X's live cursor operation...",
      "Connecting to X’s live member roster…"
    )
    .replace(
      /The original Members request was not in Chrome's resource buffer; capturing the next x\.com GraphQL request during one page reload\./,
      "Refreshing the Members page once to establish the roster connection."
    )
    .replace(/Detected live membersSliceTimeline_Query operation\./, "Live roster connection established.")
    .replace(/membersSliceTimeline_Query/g, "member roster")
    .replace(/CommunityTweetsTimeline/g, "Community timeline")
    .replace(/GraphQL/gi, "direct")
    .replace(/\s+/g, " ")
    .trim();
}

function logLevel(message) {
  if (/error|failed|cannot access|challenge|unreadable/i.test(message)) return "error";
  if (/partial|paused|stopped|limit|retry|froze|background|unavailable|ended access/i.test(message)) return "warning";
  if (/established|complete|loaded|reached|remembered|finished/i.test(message)) return "success";
  return "info";
}

let nextLogEntryId = 1;

function log(message) {
  const polished = professionalLogMessage(message);
  if (!polished) return;
  const entry = {
    id: nextLogEntryId++,
    message: polished,
    level: logLevel(polished),
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  };
  // Always a fresh array (never push-then-reassign-in-place): setState
  // relies on reference inequality to notify subscribers, and a React
  // subscriber later relies on the same thing to know a re-render is due.
  logLines = logLines.length >= 80 ? [...logLines.slice(-79), entry] : [...logLines, entry];
  setState({ logLines });
}

// Drives the phase rail from an explicit stage instead of pattern-matching
// displayed text, so a future wording change to a phase label can't silently
// desync the rail. stage is one of:
// "roster" | "activity" | "complete" | "stopped" | "error".
function setPhase(label, stage) {
  let activeIndex = stage === "activity" ? 1 : stage === "complete" ? 2 : 0;
  if (stage === "stopped" || stage === "error") activeIndex = lastPhaseActiveIndex;
  lastPhaseActiveIndex = activeIndex;
  const badge =
    stage === "complete"
      ? { cls: "complete", label: "Complete" }
      : stage === "error"
        ? { cls: "error", label: "Attention" }
        : stage === "stopped"
          ? { cls: "stopped", label: "Stopped" }
          : { cls: "", label: "Running" };
  setState({
    phaseLabel: label,
    phaseStage: stage,
    phaseActiveIndex: activeIndex,
    badgeClass: badge.cls,
    badgeLabel: badge.label,
  });
}

function friendlyStopReason(reason) {
  return (
    {
      "expected-count-reached": "expected member count reached",
      "seek-resume-exhausted": "X stopped returning new members; the remainder are counted but never served",
      "seek-resume-segment-limit": "seek-resume segment limit reached",
      "cursor-ended": "server cursor ended",
      "cursor-ended-before-count": "X ended the server cursor before the advertised count",
      "no-new-members": "X returned no new members",
      "repeated-cursor": "X repeated the same roster cursor",
      "rate-limited": "X rate limit remained active after automatic retries",
      "request-error": "member request paused after repeated errors",
      "page-safety-limit": "request safety limit reached",
      "dom-stalled": "visible roster stopped advancing",
      "dom-time-limit": "browser-scroll time limit reached",
      "dom-reconciliation-limit": "DOM reconciliation limit reached",
      "tab-throttled": "Members tab was backgrounded and stopped advancing",
      "tab-frozen": "Chrome froze the Members tab",
      "cursor-unavailable": "direct member cursor unavailable",
      "selected-window-covered": "selected activity window covered",
      "selected-window-in-progress": "selected activity window still in progress",
      "page-limit-before-window-boundary":
        "page limit reached before the selected activity window was fully covered",
    }[reason] || String(reason || "unknown stop")
  );
}

function formatStorageBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

// "9 days remaining" reads better than a raw date-to-date gap once the walk
// is close; both are shown so an operator can see real progress even far
// from the boundary.
function activityCoverageProgressLabel(sinceDate, oldestSeenAtIso) {
  const oldestSeenAt = new Date(oldestSeenAtIso);
  const daysRemaining = Math.max(0, Math.ceil((oldestSeenAt.getTime() - sinceDate.getTime()) / (24 * 60 * 60 * 1000)));
  return `${oldestSeenAt.toLocaleDateString()} (target ${sinceDate.toLocaleDateString()}, ` +
    `${daysRemaining.toLocaleString()} day(s) remaining)`;
}

// Built from estimateActivityThroughput's moving-average result - never
// exact, since posting density changes over the walk, but far more useful
// than a bare "incomplete" while a long 30-90 day scan runs.
function activityThroughputLabel(throughput) {
  const rate = `${throughput.pagesPerMinute.toFixed(throughput.pagesPerMinute >= 10 ? 0 : 1)} pages/min`;
  if (throughput.estimatedMinutesRemaining == null) return rate;
  const minutes = Math.round(throughput.estimatedMinutesRemaining);
  const eta = minutes < 1
    ? "<1 min left"
    : minutes < 60
      ? `~${minutes} min left`
      : `~${(minutes / 60).toFixed(1)} hr left`;
  return `${rate} · ~${Math.round(throughput.estimatedPagesRemaining).toLocaleString()} pages left · ${eta}`;
}

// Deliberately separate from resultSummary: the inactivity result is already
// final and actionable once the activity window is covered, and none of this
// supplemental, best-effort archival evidence blocks or changes that -
// conflating "results are ready" with "the archive isn't done yet" was the
// exact confusion this section exists to prevent.
function archiveStatusRow(name, state, { unitLabel = "author(s)" } = {}) {
  if (!state) return null;
  if (state.error) {
    return { name, status: "unavailable", detail: "unavailable this scan" };
  }
  const count = Number.isFinite(state.authors) ? state.authors.toLocaleString() : "0";
  return {
    name,
    status: state.complete ? "complete" : "in-progress",
    detail: state.complete ? `${count} ${unitLabel}` : `${count} ${unitLabel} so far · will continue`,
  };
}

function renderArchiveStatus(ctx) {
  const rows = [
    archiveStatusRow("Timeline", ctx.timelineArchiveState),
    archiveStatusRow("Media", currentDiagnostics?.mediaBackfill),
    currentDiagnostics?.searchBackfill
      ? {
          name: "Search shards",
          status: currentDiagnostics.searchBackfill.error
            ? "unavailable"
            : currentDiagnostics.searchBackfill.complete
              ? "complete"
              : "in-progress",
          detail: currentDiagnostics.searchBackfill.error
            ? "unavailable this scan"
            : `${currentDiagnostics.searchBackfill.completedShards || 0}/${currentDiagnostics.searchBackfill.shardCount || 6} shards`,
        }
      : null,
  ].filter(Boolean);
  setState({ archiveRows: rows });
}

function updateMemberProgress(found) {
  const patch = { membersFound: found, statusText: `${found.toLocaleString()} members` };
  if (expectedMembers) {
    const percent = Math.min(100, (found / expectedMembers) * 100);
    patch.coveragePercent = percent;
  } else {
    patch.coveragePercent = null;
  }
  setState(patch);
}

function renderResults(rows) {
  currentCompleteness = summarizeScanCompleteness({
    roster: currentRosterState,
    activity: currentActivityState,
    verification: currentDiagnostics?.activitySearchVerification,
  });
  const { reviewable, safeForAutomatedRemoval } = determineActionability(currentCompleteness);
  const confirmedCount = rows.filter((row) => row.activityVerification === "confirmed-inactive").length;
  setState({
    results: rows,
    previewNote:
      rows.length > 100
        ? `Showing 100 of ${rows.length.toLocaleString()}; the CSV contains all flagged members.`
        : `Showing all ${rows.length.toLocaleString()} flagged members.`,
    exportEnabled: reviewable && rows.length > 0,
    confirmedCount,
    exportConfirmedEnabled: safeForAutomatedRemoval && confirmedCount > 0,
    exportUsernamesEnabled: safeForAutomatedRemoval && confirmedCount > 0,
  });
}

function renderPrivateExportState() {
  setState({
    privatePanelVisible: privateRosterReady,
    privateAccounts: currentPrivateAccounts,
    privateNote: currentPrivateAccounts.length
      ? `${currentPrivateAccounts.length.toLocaleString()} private account(s) found in the ` +
        `${currentRosterState.found.toLocaleString()} discovered roster record(s), regardless of activity.`
      : "No private accounts were detected in the discovered records.",
  });
}

// ---------------------------------------------------------------------------
// Scan lease coordination (unchanged - no DOM involvement in the original).

function scanSettingsSnapshot() {
  const { communityId, lookbackDays, timelineBackfill, focusLock, seekResume } = getState();
  return { communityId, lookbackDays, timelineBackfill, focusLock, seekResume };
}

async function acquireScanLease() {
  const response = await chrome.runtime.sendMessage({
    type: "ACQUIRE_SCAN_LEASE",
    owner: scanOwnerId,
    mode: getState().dashboardMode ? "Full dashboard" : "Lite panel",
    ttl: SCAN_LEASE_MS,
  });
  if (response?.error) throw new Error(response.error);
  if (!response?.acquired) return response;
  clearInterval(leaseHeartbeat);
  leaseHeartbeat = setInterval(() => {
    void chrome.runtime.sendMessage({
      type: "RENEW_SCAN_LEASE",
      owner: scanOwnerId,
      ttl: SCAN_LEASE_MS,
    }).catch(() => {});
  }, 15_000);
  return response;
}

async function releaseScanLease() {
  clearInterval(leaseHeartbeat);
  leaseHeartbeat = null;
  await chrome.runtime.sendMessage({
    type: "RELEASE_SCAN_LEASE",
    owner: scanOwnerId,
  }).catch(() => {});
}

addEventListener("pagehide", () => {
  if (leaseHeartbeat) {
    clearInterval(leaseHeartbeat);
    leaseHeartbeat = null;
    void chrome.runtime.sendMessage({
      type: "RELEASE_SCAN_LEASE",
      owner: scanOwnerId,
    }).catch(() => {});
  }
  if (abortController) {
    chrome.storage.local.set({
      [SCAN_JOB_KEY]: {
        schema: SCAN_JOB_SCHEMA,
        communityId: currentCommunityId,
        status: "stopped",
        phase: "panel-closed",
        expectedMembers,
        roster: currentRosterState,
        activity: currentActivityState,
        privateAccounts: currentPrivateAccounts,
        privateRosterReady,
        diagnostics: currentDiagnostics ? JSON.parse(JSON.stringify(currentDiagnostics)) : null,
        updatedAt: Date.now(),
      },
    });
    abortController.abort();
  }
});

// ---------------------------------------------------------------------------
// Tab discovery (unchanged - no DOM involvement in the original beyond
// reading the community-id input, now read from state instead).

export async function activeTab() {
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (current?.id && communityIdFrom(current.url)) return current;
  const communityId = currentCommunityId || communityIdFrom(getState().communityId);
  const candidates = await chrome.tabs.query({
    url: ["https://x.com/i/communities/*", "https://x.com/i/communities/*/members"],
  });
  const matching = candidates.find((tab) =>
    tab?.id &&
    communityIdFrom(tab.url) &&
    (!communityId || communityIdFrom(tab.url) === communityId)
  );
  if (!matching?.id) {
    throw new Error("Open the matching X Community Members page before starting.");
  }
  return matching;
}

export async function focusCommunityTab() {
  const communityTab = await activeTab();
  await chrome.windows.update(communityTab.windowId, { focused: true });
  await chrome.tabs.update(communityTab.id, { active: true });
  return communityTab;
}

export async function openCommunityTab() {
  try {
    await focusCommunityTab();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error?.message || "Community tab not found" };
  }
}

export async function toggleDashboardMode() {
  if (!getState().dashboardMode) {
    const response = await chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
    return response?.opened ? { ok: true } : { ok: false, message: response?.error || "Could not open dashboard" };
  }
  try {
    const communityTab = await focusCommunityTab();
    await chrome.sidePanel.open({ windowId: communityTab.windowId });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error?.message || "Open the matching X Community" };
  }
}

// ---------------------------------------------------------------------------
// Storage: save/resume/discard/clear (unchanged logic; DOM writes replaced).

async function saveScanJob(status, details = {}) {
  const diagnostics = currentDiagnostics ? JSON.parse(JSON.stringify(currentDiagnostics)) : null;
  const settings = scanSettingsSnapshot();
  await chrome.storage.local.set({
    [SCAN_JOB_KEY]: {
      schema: SCAN_JOB_SCHEMA,
      communityId: currentCommunityId,
      // Resume identity, not just display settings: a job saved under one
      // lookback/seek-resume/backfill combination must never be treated as
      // resumable under a different one - see jobIdentity.js. Read live from
      // state rather than from a separate copy: these settings stay fixed
      // (inputs disabled) for the duration of a scan, so state still
      // reflects exactly the settings that started it.
      lookbackDays: Number.parseInt(settings.lookbackDays, 10) || 30,
      seekResume: settings.seekResume,
      timelineBackfill: settings.timelineBackfill,
      status,
      expectedMembers,
      roster: currentRosterState,
      activity: currentActivityState,
      privateAccounts: currentPrivateAccounts,
      privateRosterReady,
      diagnostics,
      requests: diagnostics?.count || 0,
      updatedAt: Date.now(),
      ...details,
    },
  });
}

// Refreshed on load, after a scan completes, and after either clear action -
// never assumed stale-but-fine, since it directly drives whether the clear
// actions are even enabled.
export async function refreshStorage() {
  const allEntries = await chrome.storage.local.get(null);
  const summary = summarizeStorageByCommunity(allEntries);
  let bytes = summary.reduce((sum, entry) => sum + entry.bytes, 0);
  if (chrome.storage.local.getBytesInUse) {
    try {
      bytes = await chrome.storage.local.getBytesInUse(null);
    } catch {
      // Fall back to the estimate already computed above.
    }
  }
  const currentId = communityIdFrom(getState().communityId);
  const currentCommunityHasData = Boolean(
    currentId && summary.some((entry) => entry.communityId === currentId)
  );
  setState({
    storageCommunityCount: summary.length,
    storageBytesLabel: formatStorageBytes(bytes),
    clearCommunityEnabled: currentCommunityHasData && !getState().busy,
    clearAllEnabled: summary.length > 0 && !getState().busy,
  });
  return { allEntries, summary };
}

export async function clearCommunityData(communityId) {
  const { allEntries } = await refreshStorage();
  const keys = computeCommunityStorageKeys(allEntries, communityId);
  if (keys.length) await chrome.storage.local.remove(keys);
  if (keys.includes(SCAN_JOB_KEY)) {
    setState({ resumeJob: null, startLabel: "Start scan" });
  }
  log(`Cleared ${keys.length.toLocaleString()} saved item(s) for Community ${communityId}.`);
  await refreshStorage();
}

export async function clearAllData() {
  await chrome.storage.local.clear();
  setState({ resumeJob: null, startLabel: "Start scan" });
  log("Cleared all Community Activity data saved in this browser.");
  await refreshStorage();
}

// This discards the *resume notice* (the SCAN_JOB_KEY record and this
// panel's visible state) - it deliberately does not touch any stage's own
// lower-level checkpoint (roster cursor pages, activity's stored cursor, the
// timeline/media/search backfill checkpoints, verification cache). Those are
// separate, intentionally durable data with their own freshness rules, and a
// later scan may still reuse them even after this runs. A true "clear all
// saved data" action is the distinct clearAllData() above - conflating the
// two here would make this either too weak (an operator expects "discard" to
// mean gone) or too dangerous (silently nuking checkpoints an operator may
// still want).
export async function discardScan() {
  await chrome.storage.local.remove(SCAN_JOB_KEY);
  currentResults = [];
  currentPrivateAccounts = [];
  privateRosterReady = false;
  currentDiagnostics = null;
  currentCompleteness = null;
  currentRosterState = { complete: false, found: 0, expected: null, reason: "not-started" };
  currentActivityState = { complete: false, backfillComplete: false, reason: "not-started" };
  expectedMembers = null;
  currentCommunityId = "";
  setState({
    resumeJob: null,
    startLabel: "Start scan",
    diagnosticsExportEnabled: false,
    resultsPanelVisible: false,
    archiveRows: [],
    privatePanelVisible: false,
    contextLabel: communityIdFrom(getState().communityId)
      ? "Community detected. The visible X tab will become the collector."
      : "Open an X Community or paste its numeric ID.",
    contextTitle: null,
  });
  log("Resume notice discarded; saved checkpoints are unaffected.");
}

// ---------------------------------------------------------------------------
// Startup restore.

const RESUME_STATUS_LABEL = { running: "Interrupted", stopped: "Stopped", error: "Error" };

function buildResumeJobView(job) {
  const summary = summarizeResumableJob(job);
  return {
    communityId: summary.communityId,
    statusLabel: RESUME_STATUS_LABEL[summary.status] || summary.status,
    summaryText:
      `Roster ${summary.rosterComplete ? "complete" : "partial"}: ` +
      (summary.rosterExpected
        ? `${summary.rosterFound.toLocaleString()} of ${summary.rosterExpected.toLocaleString()} member(s)`
        : `${summary.rosterFound.toLocaleString()} member(s)`) +
      `. Activity window ${summary.activityComplete ? "complete" : "incomplete"}.` +
      (summary.verificationQueued
        ? ` · direct verification ${(summary.verificationChecked || 0).toLocaleString()}/${summary.verificationQueued.toLocaleString()}`
        : ""),
    stages: summary.stages.map((stage) => ({
      label: stage.label,
      status: stage.status,
      statusText: stage.status === "pending" ? "Not reached" : stage.status,
      resumeHint:
        stage.resumePolicy === "checkpoint-resumable"
          ? "Resumes from its own saved checkpoint, not from the start."
          : "No checkpoint of its own; safe and cheap to redo from the top.",
    })),
  };
}

// Restores saved settings/results/resume-state on load. Call once when the
// UI mounts.
export async function init() {
  const [tab, stored] = await Promise.all([
    activeTab().catch(() => null),
    chrome.storage.local.get(["liteScanSettings", SCAN_JOB_KEY]),
  ]);
  const detected = communityIdFrom(tab?.url);
  const saved = stored.liteScanSettings || {};
  const communityId = detected || saved.communityId || "";
  const lookbackDays = Number(saved.lookbackDays) || 30;
  const timelineBackfill = saved.timelineBackfill !== false;
  const focusLock = saved.focusLock !== false;
  // Opt-in: defaults to off because it multiplies request volume.
  const seekResume = saved.seekResume === true;
  setState({
    communityId,
    lookbackDays,
    timelineBackfill,
    focusLock,
    seekResume,
    contextLabel: detected
      ? "Community detected. The visible X tab will become the collector."
      : getState().contextLabel,
  });

  const previousJob = stored[SCAN_JOB_KEY];
  // A saved job only counts as a match for the *current* settings, not just
  // the current Community - see jobIdentity.js: a 90-day-lookback job must
  // never be restored as though it answered today's 30-day selection.
  const matchingPreviousJob = isJobResumable(
    previousJob,
    { communityId, lookbackDays, seekResume, timelineBackfill },
    SCAN_JOB_SCHEMA
  );

  if (matchingPreviousJob) {
    currentDiagnostics = previousJob.diagnostics || null;
    setState({ diagnosticsExportEnabled: true });
  }

  if (
    matchingPreviousJob &&
    Array.isArray(previousJob.privateAccounts) &&
    (previousJob.privateRosterReady || previousJob.status === "complete")
  ) {
    currentCommunityId = previousJob.communityId || "";
    currentPrivateAccounts = previousJob.privateAccounts;
    privateRosterReady = true;
    currentRosterState = previousJob.roster || currentRosterState;
    currentActivityState = previousJob.activity || currentActivityState;
    expectedMembers = previousJob.expectedMembers ?? currentRosterState.expected ?? null;
    renderPrivateExportState();
  }

  if (previousJob?.status === "complete" && matchingPreviousJob && Array.isArray(previousJob.results)) {
    currentCommunityId = previousJob.communityId || "";
    currentResults = previousJob.results;
    currentRosterState = previousJob.roster || currentRosterState;
    currentActivityState = previousJob.activity || currentActivityState;
    expectedMembers = previousJob.expectedMembers ?? currentRosterState.expected ?? null;
    setState({
      resultSummary: `Restored ${currentResults.length.toLocaleString()} flagged member(s) from the last completed scan.`,
      resultsPanelVisible: true,
    });
    renderArchiveStatus({ timelineArchiveState: previousJob.diagnostics?.timelineBackfill || null });
    renderResults(currentResults);
    renderPrivateExportState();
  }

  if (matchingPreviousJob && ["running", "stopped", "error"].includes(previousJob.status)) {
    setState({ resumeJob: buildResumeJobView(previousJob), startLabel: "Start scan" });
  }

  await refreshStorage();
}

// ---------------------------------------------------------------------------
// Scan phases. Each takes the same shared, mutable ctx object the original
// threaded by reference (mirroring requestStats/currentDiagnostics), so the
// data flow and module-level state assignments are unchanged from
// sidepanel.js; only the DOM writes at the leaves are now setState calls.

async function discoverActivityAndCommunityInfo(ctx) {
  setPhase("Checking access", "roster");
  setState({ statusText: "Reading Community" });
  ctx.tab = await activeTab();
  ctx.dashboardTab = getState().dashboardMode ? await chrome.tabs.getCurrent() : null;
  ctx.timelineOperation = null;
  try {
    ctx.timelineOperation = await discoverCommunityTimelineOperation(ctx.communityId, ctx.tab.id, {
      signal: ctx.signal,
      log,
      lockForeground: ctx.lockForeground,
    });
    if (ctx.timelineOperation) {
      currentDiagnostics.activityOperation = {
        name: ctx.timelineOperation.operation,
        documentIdLength: ctx.timelineOperation.documentId?.length || null,
        variableKeys: Object.keys(ctx.timelineOperation.variables || {}),
        featureCount: Object.keys(ctx.timelineOperation.features || {}).length,
        transactionHeaderPresent: Boolean(ctx.timelineOperation.clientTransactionId),
      };
      if (ctx.timelineOperation.communityQuery) {
        currentDiagnostics.communityOperation = {
          name: ctx.timelineOperation.communityQuery.operation,
          documentIdLength: ctx.timelineOperation.communityQuery.documentId?.length || null,
          variableKeys: Object.keys(ctx.timelineOperation.communityQuery.variables || {}),
          featureCount: Object.keys(ctx.timelineOperation.communityQuery.features || {}).length,
        };
      }
    }
  } catch (error) {
    if (error instanceof StoppedError || error?.name === "StoppedError") throw error;
    log(`Live activity operation unavailable; using the bundled fallback. ${error.message}`);
  }
  if (ctx.dashboardTab?.id != null) {
    await chrome.windows.update(ctx.dashboardTab.windowId, { focused: true }).catch(() => {});
    await chrome.tabs.update(ctx.dashboardTab.id, { active: true }).catch(() => {});
  }
  try {
    const info = await fetchCommunityInfo(ctx.communityId, {
      signal: ctx.signal,
      requestStats: ctx.requestStats,
      log,
      limiter: ctx.limiter,
      operation: ctx.timelineOperation?.communityQuery || null,
    });
    expectedMembers = Number.isFinite(info?.memberCount) ? info.memberCount : null;
    currentRosterState.expected = expectedMembers;
    setState({
      expectedMembers,
      requestsCount: ctx.requestStats.count,
      ...(info?.name ? { contextLabel: info.name, contextTitle: info.name } : {}),
    });
  } catch (error) {
    if (/401|session|logged/i.test(error.message)) throw error;
    log(`Community count unavailable; continuing from the visible Members page. ${error.message}`);
  }
  await collectCommunityAnalytics(ctx);
}

// X's analytics panel answers with real totals for a viewer holding no
// Community role, so one request replaces a guessed denominator and gives
// author discovery something to measure itself against.
async function collectCommunityAnalytics(ctx) {
  try {
    const analytics = await fetchCommunityAnalytics(ctx.communityId, {
      signal: ctx.signal,
      requestStats: ctx.requestStats,
      log,
      limiter: ctx.limiter,
    });
    if (!analytics) return;
    currentDiagnostics.analytics = analytics;
    ctx.uniquePosters = analytics.uniquePosters;
    if (Number.isFinite(analytics.totalMembers) && analytics.totalMembers > 0) {
      expectedMembers = analytics.totalMembers;
      currentRosterState.expected = expectedMembers;
      setState({ expectedMembers });
    }
    setState({ requestsCount: ctx.requestStats.count });
    log(
      `X analytics reports ${analytics.totalMembers?.toLocaleString() || "an unknown number of"} ` +
      `member(s) and ${analytics.uniquePosters?.toLocaleString() || "an unknown number of"} ` +
      `distinct poster(s) in its current period.`
    );
  } catch (error) {
    if (error instanceof StoppedError || error?.name === "StoppedError") throw error;
    log(`Community analytics unavailable; using the Community header count. ${error.message}`);
  }
}

async function collectNativeRoster(ctx) {
  setPhase("Testing native roster route", "roster");
  setState({ statusText: "Checking X's signed Android query" });
  await saveScanJob("running", { phase: "testing-native-roster" });
  try {
    const nativeResult = await rosterSources.collect("x-native-all", {
      communityId: ctx.communityId,
      operation: NATIVE_MEMBERS_ALL_OPERATION,
      options: {
        signal: ctx.signal,
        requestStats: ctx.requestStats,
        log,
        expectedCount: expectedMembers,
        checkpointScope: "android-all-v1",
        seekResume: ctx.seekResume === true,
        onProgress: ({ page, count, added, nextCursor }) => {
          currentDiagnostics.rosterPages.push({
            source: "android-all",
            page,
            total: count,
            added,
            hasNextCursor: Boolean(nextCursor),
          });
          if (currentDiagnostics.rosterPages.length > 1000) {
            currentDiagnostics.rosterPages.shift();
          }
          updateMemberProgress(Math.max(ctx.members.length, count));
          setState({
            requestsCount: ctx.requestStats.count,
            statusText: `${count.toLocaleString()} members · native page ${page.toLocaleString()}`,
          });
        },
      },
    });
    ctx.members = mergeMemberLists(ctx.members, nativeResult.members).merged;
    ctx.cursorComplete = nativeResult.complete || Boolean(expectedMembers && ctx.members.length >= expectedMembers);
    ctx.cursorReturnedMembers = ctx.members.length > 0;
    ctx.rosterReason = ctx.cursorComplete ? "expected-count-reached" : nativeResult.reason;
    // When the native route reaches X's own terminal cursor it has already
    // answered for this roster, and it reaches about five times what the web
    // slice does. Replaying the web slice at 18 records per page afterwards
    // costs thousands of requests to re-derive a smaller set, so it is
    // skipped and the visible-DOM reconciliation below remains the safety
    // net.
    ctx.nativeReachedTerminalCursor =
      nativeResult.members.length > 0 &&
      ["cursor-ended", "cursor-ended-before-count", "checkpoint-complete"].includes(nativeResult.reason);
    currentDiagnostics.nativeRosterOperation = {
      name: NATIVE_MEMBERS_ALL_OPERATION.operation,
      documentId: NATIVE_MEMBERS_ALL_OPERATION.documentId,
      returned: nativeResult.members.length,
      complete: nativeResult.complete === true,
      reason: nativeResult.reason,
      reachedTerminalCursor: ctx.nativeReachedTerminalCursor === true,
      segments: nativeResult.segments ?? 1,
      reseeks: nativeResult.reseeks ?? 0,
    };
    if ((nativeResult.reseeks ?? 0) > 0) {
      log(
        `Seek-resume continued past X's page cap ${nativeResult.reseeks.toLocaleString()} ` +
        `time(s) across ${(nativeResult.segments ?? 1).toLocaleString()} cursor chain(s).`
      );
    }
    if (nativeResult.error) {
      log(`Native roster route paused: ${nativeResult.error.message}`);
    } else if (nativeResult.members.length > 0) {
      log(
        `Native roster route returned ${nativeResult.members.length.toLocaleString()} ` +
        `member(s) (${friendlyStopReason(nativeResult.reason)}).`
      );
    }
  } catch (error) {
    if (error instanceof StoppedError || error?.name === "StoppedError") throw error;
    currentDiagnostics.nativeRosterOperation = {
      name: NATIVE_MEMBERS_ALL_OPERATION.operation,
      documentId: NATIVE_MEMBERS_ALL_OPERATION.documentId,
      returned: 0,
      complete: false,
      reason: "request-rejected",
      error: String(error?.message || error).slice(0, 240),
    };
    log(`Native roster route unavailable; continuing with X's live web connection. ${error.message}`);
  }
}

async function collectCursorRoster(ctx) {
  if (ctx.cursorComplete) return;
  if (ctx.nativeReachedTerminalCursor) {
    currentDiagnostics.webCursorSkipped = {
      reason: "native-route-reached-terminal-cursor",
      nativeMembers: ctx.members.length,
    };
    log(
      `Skipping the web member slice: the native route already reached X's terminal ` +
      `cursor with ${ctx.members.length.toLocaleString()} member(s).`
    );
    return;
  }
  setPhase("Locating member cursor", "roster");
  setState({ statusText: "Watching X's Members request" });
  await saveScanJob("running", { phase: "locating-member-cursor" });
  try {
    const operation = await discoverCommunityMembersOperation(ctx.communityId, ctx.tab.id, {
      signal: ctx.signal,
      log,
      lockForeground: ctx.lockForeground,
    });
    currentDiagnostics.rosterOperation = {
      name: operation.operation,
      documentId: operation.documentId,
      variableKeys: Object.keys(operation.variables || {}),
      featureCount: Object.keys(operation.features || {}).length,
      transactionHeaderPresent: Boolean(operation.clientTransactionId),
    };
    if (ctx.dashboardTab?.id != null) {
      await chrome.windows.update(ctx.dashboardTab.windowId, { focused: true }).catch(() => {});
      await chrome.tabs.update(ctx.dashboardTab.id, { active: true }).catch(() => {});
    }
    setPhase("Collecting members by cursor", "roster");
    setState({ statusText: "Starting direct pagination" });
    const cursorResult = await rosterSources.collect("x-cursor", {
      communityId: ctx.communityId,
      operation,
      options: {
        signal: ctx.signal,
        requestStats: ctx.requestStats,
        log,
        expectedCount: expectedMembers,
        onProgress: ({ page, count, added, nextCursor }) => {
          currentDiagnostics.rosterPages.push({ page, total: count, added, hasNextCursor: Boolean(nextCursor) });
          if (currentDiagnostics.rosterPages.length > 1000) {
            currentDiagnostics.rosterPages.shift();
          }
          updateMemberProgress(Math.max(ctx.members.length, count));
          setState({
            requestsCount: ctx.requestStats.count,
            statusText: `${count.toLocaleString()} members · page ${page.toLocaleString()}`,
          });
          if (added === 0) {
            setState({ coverageMessage: "X returned a page with no new members; stopping direct pagination." });
          }
          if (page % 10 === 0) {
            void saveScanJob("running", {
              phase: "collecting-members",
              requests: ctx.requestStats.count,
              roster: { complete: false, found: Math.max(ctx.members.length, count), expected: expectedMembers, reason: "cursor-in-progress" },
            });
          }
        },
      },
    });
    ctx.members = mergeMemberLists(ctx.members, cursorResult.members).merged;
    ctx.cursorComplete = cursorResult.complete || Boolean(expectedMembers && ctx.members.length >= expectedMembers);
    ctx.cursorReturnedMembers = ctx.members.length > 0;
    ctx.rosterReason = ctx.cursorComplete ? "expected-count-reached" : cursorResult.reason;
    if (cursorResult.error) log(`Direct cursor request paused: ${cursorResult.error.message}`);
    if (!ctx.cursorComplete && ctx.cursorReturnedMembers) {
      log(`Direct connection succeeded with a partial roster (${friendlyStopReason(cursorResult.reason)}).`);
    }
  } catch (error) {
    if (error instanceof StoppedError || error?.name === "StoppedError") throw error;
    log(`Direct member cursor unavailable; using visible DOM collection. ${error.message}`);
  }
}

async function collectDomFallbackOrReconcile(ctx) {
  if (!ctx.cursorComplete && !ctx.cursorReturnedMembers) {
    setPhase(ctx.lockForeground ? "DOM fallback · focus locked" : "DOM fallback", "roster");
    const domResult = await rosterSources.collect("x-dom", {
      communityId: ctx.communityId,
      tabId: ctx.tab.id,
      options: {
        signal: ctx.signal,
        log,
        resumeMembers: ctx.members,
        expectedCount: expectedMembers,
        lockForeground: ctx.lockForeground,
        onProgress: ({ count }) => {
          currentDiagnostics.dom ||= { mode: "full-fallback", updates: 0, lastCount: 0 };
          currentDiagnostics.dom.updates++;
          currentDiagnostics.dom.lastCount = count;
          updateMemberProgress(count);
        },
      },
    });
    ctx.members = mergeMemberLists(ctx.members, domResult.members).merged;
    ctx.cursorComplete = domResult.complete;
    ctx.rosterReason = domResult.reason;
    currentDiagnostics.dom = {
      ...(currentDiagnostics.dom || {}),
      mode: "full-fallback",
      complete: domResult.complete,
      reason: domResult.reason,
      passes: domResult.passes,
      lastCount: ctx.members.length,
    };
  } else if (!ctx.cursorComplete && ctx.cursorReturnedMembers) {
    setPhase("Reconciling visible members", "roster");
    setState({ statusText: "Short DOM reconciliation" });
    const beforeReconciliation = ctx.members.length;
    const domResult = await rosterSources.collect("x-dom", {
      communityId: ctx.communityId,
      tabId: ctx.tab.id,
      options: {
        signal: ctx.signal,
        log,
        resumeMembers: ctx.members,
        expectedCount: expectedMembers,
        lockForeground: ctx.lockForeground,
        maxPasses: DOM_RECONCILIATION_PASSES,
        maxIdlePasses: 3,
        onProgress: ({ count }) => {
          currentDiagnostics.dom ||= { mode: "reconciliation", updates: 0, lastCount: 0 };
          currentDiagnostics.dom.updates++;
          currentDiagnostics.dom.lastCount = count;
          setState({ statusText: `${count.toLocaleString()} visible member(s) checked` });
        },
      },
    });
    ctx.members = mergeMemberLists(ctx.members, domResult.members).merged;
    const reconciled = ctx.members.length - beforeReconciliation;
    currentDiagnostics.dom = {
      ...(currentDiagnostics.dom || {}),
      mode: "reconciliation",
      complete: domResult.complete,
      reason: domResult.reason,
      passes: domResult.passes,
      lastCount: ctx.members.length,
    };
    log(`Short DOM reconciliation checked ${DOM_RECONCILIATION_PASSES} passes and added ${reconciled.toLocaleString()} member(s).`);
    if (expectedMembers && ctx.members.length >= expectedMembers) {
      ctx.cursorComplete = true;
      ctx.rosterReason = "expected-count-reached";
    }
  }
  updateMemberProgress(ctx.members.length);
}

async function finalizeRosterAndAboutMembers(ctx) {
  ctx.members = ctx.members.map((member) => ({
    ...member,
    membershipEvidence: member.membershipEvidence || "x-roster",
  }));
  ctx.directRosterCount = ctx.members.length;
  try {
    const aboutMembers = await fetchCommunityAboutMembers(ctx.communityId, {
      signal: ctx.signal,
      requestStats: ctx.requestStats,
      log,
      limiter: ctx.limiter,
    });
    const beforeAbout = ctx.members.length;
    ctx.members = mergeMemberLists(ctx.members, aboutMembers).merged;
    const aboutAdditions = ctx.members.length - beforeAbout;
    currentDiagnostics.aboutSurface = { returned: aboutMembers.length, added: aboutAdditions };
    if (aboutAdditions) {
      log(`About surface added ${aboutAdditions.toLocaleString()} member(s) not seen in the roster cursor.`);
    }
  } catch (error) {
    if (error instanceof StoppedError || error?.name === "StoppedError") throw error;
    currentDiagnostics.aboutSurface = { error: error.message };
    log(`About surface unavailable; continuing with the collected roster. ${error.message}`);
  }
  currentPrivateAccounts = ctx.members.filter((member) => member.protected === true);
  privateRosterReady = true;
  renderPrivateExportState();
  log(
    `Privacy review ready · ${currentPrivateAccounts.length.toLocaleString()} private ` +
    `account(s) detected in the discovered roster.`
  );
  await saveScanJob("running", { phase: "roster-collected" });

  if (expectedMembers) {
    const coverage = ctx.members.length / expectedMembers;
    setState({
      coverageMessage:
        `${(coverage * 100).toFixed(1)}% roster coverage ` +
        `(${ctx.members.length.toLocaleString()} of ${expectedMembers.toLocaleString()}). ` +
        (ctx.cursorComplete
          ? "Roster complete."
          : ctx.rosterReason === "cursor-ended-before-count"
            ? "Direct connection succeeded; X returned its terminal server cursor before the advertised total."
            : `Partial: ${friendlyStopReason(ctx.rosterReason)}.`),
      coverageMessagePartial: !ctx.cursorComplete,
    });
  } else if (!ctx.cursorComplete) {
    setState({
      coverageMessage: `${ctx.members.length.toLocaleString()} members discovered. Partial: ${friendlyStopReason(ctx.rosterReason)}.`,
      coverageMessagePartial: true,
    });
  }
}

async function analyzeRecentActivity(ctx) {
  setPhase("Analyzing posts", "activity");
  setState({ statusText: "The X tab is unlocked", coveragePercent: null });
  await saveScanJob("running", { phase: "analyzing-posts" });
  // Include today as one calendar day and stop at the current moment.
  const { sinceDate, untilDate } = calendarActivityWindow(ctx.lookbackDays);
  ctx.active = await fetchActiveAuthors(ctx.communityId, sinceDate, untilDate, {
    signal: ctx.signal,
    requestStats: ctx.requestStats,
    log,
    limiter: ctx.limiter,
    operation: ctx.timelineOperation,
    observationSinceDate: sinceDate,
    // No maxPagesPerRun override: this is the classification-blocking pass
    // (see fetchActiveAuthors' own comment), so it should run until the
    // window is actually covered or its own quota runs low, not stop at a
    // small fixed page count and make the operator press Start repeatedly
    // until the timeline happens to get old enough.
    onProgress: ({ scanned, activeAuthors, observedAuthors, pages, windowComplete, backfillComplete, oldestSeenAt }) => {
      currentDiagnostics.activity = { pages, scannedPosts: scanned, activeAuthors, observedAuthors, windowComplete, backfillComplete, oldestSeenAt };
      currentActivityState = {
        complete: windowComplete === true,
        backfillComplete: backfillComplete === true,
        reason: windowComplete ? "selected-window-covered" : "selected-window-in-progress",
        oldestSeenAt,
      };
      let throughputLabel = "";
      if (!windowComplete && oldestSeenAt) {
        activityThroughputWindow = pushSample(activityThroughputWindow, {
          atMs: Date.now(),
          pages,
          oldestSeenAtMs: new Date(oldestSeenAt).getTime(),
        });
        const throughput = estimateActivityThroughput(activityThroughputWindow, sinceDate.getTime());
        if (throughput) throughputLabel = ` · ${activityThroughputLabel(throughput)}`;
      }
      setState({
        requestsCount: ctx.requestStats.count,
        statusText:
          `${scanned.toLocaleString()} posts · ${activeAuthors.toLocaleString()} active · ` +
          `${observedAuthors.toLocaleString()} observed` +
          (windowComplete || !oldestSeenAt ? "" : ` · reached ${activityCoverageProgressLabel(sinceDate, oldestSeenAt)}`) +
          throughputLabel,
      });
      if (pages % 25 === 0) {
        void saveScanJob("running", { phase: "analyzing-posts", requests: ctx.requestStats.count, activity: currentActivityState });
      }
    },
  });
  ctx.activeAuthors = ctx.active.toJSON();
  // The final, authoritative state - onProgress's last call already set
  // this, but stopReason (e.g. "quota-paused") only exists on the settled
  // result, not on any single in-flight progress event.
  currentActivityState = {
    complete: ctx.active.activityWindowComplete === true,
    backfillComplete: ctx.active.observationComplete === true,
    reason: ctx.active.activityWindowComplete
      ? "selected-window-covered"
      : ctx.active.stopReason === "quota-paused"
        ? "quota-paused"
        : "selected-window-in-progress",
    oldestSeenAt: ctx.active.oldestSeenAt || null,
  };
}

async function archiveTimelineMediaAndSearch(ctx) {
  if (!ctx.timelineBackfill) return;
  setPhase("Archiving Community timeline", "activity");
  setState({ statusText: "Paging newest to oldest in the background" });
  log(
    "Timeline archive started. X's chronological cursor is paged directly, so the visible " +
    "Community tab will not physically scroll."
  );
  await saveScanJob("running", { phase: "archiving-timeline" });
  const timelineArchive = await backfillCommunityTimelineAuthors(ctx.communityId, {
    signal: ctx.signal,
    requestStats: ctx.requestStats,
    log,
    limiter: ctx.limiter,
    operation: ctx.timelineOperation,
    initialCursor: ctx.active.continuationCursor,
    seedAuthors: ctx.active.observedAuthors || ctx.activeAuthors,
    maxPagesPerRun: AUTHOR_BACKFILL_PAGES_PER_RUN,
    onProgress: ({ scanned, authors, pages, pagesThisRun, oldestPostAt, complete, reason }) => {
      const oldestLabel = oldestPostAt ? new Date(oldestPostAt).toLocaleDateString() : "locating oldest post";
      setState({
        requestsCount: ctx.requestStats.count,
        statusText: `${scanned.toLocaleString()} posts archived · ${authors.toLocaleString()} authors · oldest ${oldestLabel}`,
      });
      currentDiagnostics.timelineBackfill = { pages, scannedPosts: scanned, authors, oldestPostAt, complete, reason };
      if (pagesThisRun === 1 || pagesThisRun % 10 === 0 || complete) {
        log(`Timeline cursor page ${pages.toLocaleString()} · ${scanned.toLocaleString()} posts archived · oldest ${oldestLabel}`);
        void saveScanJob("running", { phase: "archiving-timeline", requests: ctx.requestStats.count });
      }
    },
  });
  ctx.timelineAuthors = timelineArchive.toJSON();
  ctx.timelineArchiveState = {
    ...(currentDiagnostics.timelineBackfill || {}),
    pages: timelineArchive.timelinePages,
    scannedPosts: timelineArchive.timelinePosts,
    authors: timelineArchive.size,
    oldestPostAt: timelineArchive.oldestPostAt,
    complete: timelineArchive.timelineComplete,
    reason: timelineArchive.timelineReason,
  };
  currentDiagnostics.timelineBackfill = ctx.timelineArchiveState;
  await saveScanJob("running", {
    phase: ctx.timelineArchiveState.complete ? "timeline-archive-complete" : "timeline-archive-paused",
    requests: ctx.requestStats.count,
  });

  try {
    setPhase("Archiving Community media", "activity");
    setState({ statusText: "Following the independent Media cursor" });
    await saveScanJob("running", { phase: "archiving-media" });
    const mediaArchive = await backfillCommunityMediaAuthors(ctx.communityId, {
      signal: ctx.signal,
      requestStats: ctx.requestStats,
      log,
      limiter: ctx.limiter,
      maxPagesPerRun: 75,
      onProgress: ({ scanned, authors, oldestPostAt }) => {
        setState({
          requestsCount: ctx.requestStats.count,
          statusText: `${scanned.toLocaleString()} media posts · ${authors.toLocaleString()} authors · oldest ${oldestPostAt ? new Date(oldestPostAt).toLocaleDateString() : "locating"}`,
        });
      },
    });
    ctx.mediaAuthors = mediaArchive.toJSON();
    currentDiagnostics.mediaBackfill = {
      pages: mediaArchive.timelinePages,
      scannedPosts: mediaArchive.timelinePosts,
      authors: mediaArchive.size,
      oldestPostAt: mediaArchive.oldestPostAt,
      complete: mediaArchive.timelineComplete,
      reason: mediaArchive.timelineReason,
    };
    await saveScanJob("running", { phase: "media-archive-complete", requests: ctx.requestStats.count });
  } catch (error) {
    if (error instanceof StoppedError || error?.name === "StoppedError") throw error;
    currentDiagnostics.mediaBackfill = { error: error.message };
    log(`Media archive unavailable; continuing with the main timeline. ${error.message}`);
  }

  try {
    setPhase("Searching historical Community posts", "activity");
    setState({ statusText: "Checking independent chronological search cursors" });
    await saveScanJob("running", { phase: "searching-community-history" });
    const searchArchive = await backfillCommunitySearchAuthors(ctx.communityId, {
      signal: ctx.signal,
      requestStats: ctx.requestStats,
      log,
      limiter: ctx.limiter,
      maxPagesPerShard: 8,
      onProgress: ({ query, shard, shardCount, authors }) => {
        setState({
          requestsCount: ctx.requestStats.count,
          statusText: `Search ${shard} of ${shardCount} · “${query}” · ${authors.toLocaleString()} unique authors`,
        });
      },
    });
    ctx.searchAuthors = searchArchive.toJSON();
    currentDiagnostics.searchBackfill = {
      authors: searchArchive.size,
      complete: searchArchive.timelineComplete,
      shardCount: searchArchive.shards.length,
      completedShards: searchArchive.shards.filter((shard) => shard.complete).length,
    };
    await saveScanJob("running", { phase: "community-history-search-complete", requests: ctx.requestStats.count });
  } catch (error) {
    if (error instanceof StoppedError || error?.name === "StoppedError") throw error;
    currentDiagnostics.searchBackfill = { error: error.message };
    log(`Community search archive unavailable; continuing. ${error.message}`);
  }
}

async function mergeAuthorsAndVerifyMembership(ctx) {
  currentDiagnostics.activity = {
    ...(currentDiagnostics.activity || {}),
    pages: ctx.active.observationPages,
    activeAuthors: ctx.active.size,
    observedAuthors: ctx.active.observedAuthors?.length || ctx.active.size,
    windowComplete: ctx.active.activityWindowComplete === true,
    backfillComplete: ctx.active.observationComplete === true,
  };
  currentActivityState = {
    complete: ctx.active.activityWindowComplete === true,
    backfillComplete: ctx.active.observationComplete === true,
    reason: ctx.active.activityWindowComplete ? "selected-window-covered" : "page-limit-before-window-boundary",
  };
  const observedAuthors = [
    ...(ctx.active.observedAuthors || ctx.activeAuthors),
    ...ctx.timelineAuthors,
    ...ctx.mediaAuthors,
    ...ctx.searchAuthors,
  ];
  const recentAuthorMembers = ctx.activeAuthors.map(activeAuthorToMember);
  const beforeRecentAuthors = ctx.members.length;
  ctx.members = mergeMemberLists(ctx.members, recentAuthorMembers).merged;
  ctx.recentAuthorAdditions = ctx.members.length - beforeRecentAuthors;

  ctx.rememberedAuthors = await rememberCommunityAuthors(ctx.communityId, observedAuthors);
  // X's own analytics counts the distinct posters it saw in the same period,
  // so author discovery can state how much of that set it actually reached
  // instead of only reporting that a cursor ended.
  if (Number.isFinite(ctx.uniquePosters) && ctx.uniquePosters > 0) {
    const distinctObserved = new Set(
      observedAuthors.map((author) => String(author?.user_id || author?.username || "").toLowerCase()).filter(Boolean)
    ).size;
    currentDiagnostics.authorCoverage = { observed: distinctObserved, reportedUniquePosters: ctx.uniquePosters };
    log(
      `Author discovery reached ${distinctObserved.toLocaleString()} distinct author(s) ` +
      `against the ${ctx.uniquePosters.toLocaleString()} distinct poster(s) X reports ` +
      `for its current analytics period.`
    );
  }
  setPhase("Verifying discovered authors", "activity");
  setState({ statusText: "Checking current Community membership" });
  ctx.verifiedAuthorAdditions = 0;
  try {
    const verification = await verifyKnownCommunityMembers(ctx.communityId, ctx.rememberedAuthors, {
      signal: ctx.signal,
      requestStats: ctx.requestStats,
      log,
      maxCandidatesPerRun: 350,
      onProgress: ({ checked, queued, confirmed, scheduled }) => {
        setState({
          requestsCount: ctx.requestStats.count,
          statusText: `${checked.toLocaleString()} of ${scheduled.toLocaleString()} checked · ${confirmed.toLocaleString()} confirmed`,
        });
      },
    });
    const confirmedBeforeVerification = ctx.members.filter((member) => member.membershipEvidence === "x-roster").length;
    ctx.members = mergeMemberLists(ctx.members, verification.members).merged;
    ctx.confirmedRosterCount = ctx.members.filter((member) => member.membershipEvidence === "x-roster").length;
    ctx.verifiedAuthorAdditions = Math.max(0, ctx.confirmedRosterCount - confirmedBeforeVerification);
    currentRosterState = {
      ...currentRosterState,
      found: ctx.confirmedRosterCount,
      complete: currentRosterState.complete || Boolean(expectedMembers && ctx.confirmedRosterCount >= expectedMembers),
      reason: expectedMembers && ctx.confirmedRosterCount >= expectedMembers ? "expected-count-reached" : currentRosterState.reason,
    };
    updateMemberProgress(ctx.confirmedRosterCount);
    if (expectedMembers) {
      const verifiedCoverage = ctx.confirmedRosterCount / expectedMembers;
      setState({
        coverageMessage:
          `${(verifiedCoverage * 100).toFixed(1)}% confirmed roster coverage ` +
          `(${ctx.confirmedRosterCount.toLocaleString()} of ${expectedMembers.toLocaleString()}). ` +
          (currentRosterState.complete ? "Roster complete." : "Additional authors are being membership-verified across resumable scans."),
        coverageMessagePartial: !currentRosterState.complete,
      });
    }
    currentPrivateAccounts = mergeMemberLists(
      currentPrivateAccounts,
      verification.members.filter((member) => member.protected === true)
    ).merged;
    renderPrivateExportState();
    currentDiagnostics.membershipVerification = {
      checked: verification.checked,
      queued: verification.queued,
      remaining: verification.remaining,
      confirmed: verification.members.length,
      additions: ctx.verifiedAuthorAdditions,
      reason: verification.reason,
      scheduled: verification.scheduled,
      quota: verification.quota,
    };
    log(`Current-membership verification added ${ctx.verifiedAuthorAdditions.toLocaleString()} confirmed member(s) outside the returned roster window.`);
    if (verification.error) {
      log(`Membership verification paused: ${verification.error.message}`);
    }
  } catch (error) {
    if (error instanceof StoppedError || error?.name === "StoppedError") throw error;
    log(`Membership verification unavailable; preserving author evidence only. ${error.message}`);
  }
  const confirmedArchive = await rememberConfirmedMembers(
    ctx.communityId,
    ctx.members.filter((member) => member.membershipEvidence === "x-roster"),
    { expectedCount: expectedMembers, stopReason: ctx.rosterReason }
  );
  currentDiagnostics.confirmedMemberArchive = confirmedArchive;
  log(
    `Historical confirmed-member union now contains ${confirmedArchive.uniqueConfirmed.toLocaleString()} stable record(s)` +
    `${confirmedArchive.added ? ` (${confirmedArchive.added.toLocaleString()} new this snapshot)` : ""}.`
  );
  if (expectedMembers) {
    const archiveCoverage = confirmedArchive.uniqueConfirmed / expectedMembers;
    setState({
      coverageMessage:
        getState().coverageMessage +
        ` Sources: ${ctx.directRosterCount.toLocaleString()} direct, ` +
        `${ctx.verifiedAuthorAdditions.toLocaleString()} activity-verified. ` +
        `Historical union: ${confirmedArchive.uniqueConfirmed.toLocaleString()} ` +
        `(${(archiveCoverage * 100).toFixed(1)}%).`,
    });
  }
  const historicalAuthorMembers = ctx.rememberedAuthors.map(observedAuthorToMember);
  const beforeHistory = ctx.members.length;
  ctx.members = mergeMemberLists(ctx.members, historicalAuthorMembers).merged;
  ctx.historicalAdditions = ctx.members.length - beforeHistory;
  ctx.supplementalCount = ctx.members.length - ctx.confirmedRosterCount;

  if (ctx.supplementalCount) {
    log(
      `Supplemental author evidence added ${ctx.supplementalCount.toLocaleString()} record(s) outside ` +
      `X's returned roster (${ctx.recentAuthorAdditions.toLocaleString()} active now, ` +
      `${ctx.historicalAdditions.toLocaleString()} from earlier scans, ` +
      `${ctx.verifiedAuthorAdditions.toLocaleString()} membership-verified).`
    );
  }
  log(
    `Remembered ${ctx.rememberedAuthors.length.toLocaleString()} unique Community author(s) for future scans` +
    `${ctx.active.observationComplete ? "." : "; backfill will resume from its saved cursor."}`
  );
}

// Confirms every currently-flagged member with a direct, targeted search
// instead of trusting the broad crawl's inference. This is the reason a scan
// can flag someone as inactive despite them having genuinely posted: the
// crawl covers a bounded page budget and a handful of generic search words,
// neither of which is a guarantee of seeing every post from every member.
async function verifySearchActivityForFlagged(ctx) {
  setPhase("Confirming flagged members", "activity");
  const { sinceDate } = calendarActivityWindow(ctx.lookbackDays);
  setState({ statusText: `Directly checking ${currentResults.length.toLocaleString()} flagged member(s)` });
  await saveScanJob("running", { phase: "verifying-flagged-activity" });
  try {
    const verification = await verifyMemberActivityViaSearch(ctx.communityId, currentResults, {
      signal: ctx.signal,
      requestStats: ctx.requestStats,
      log,
      sinceDate,
      // Confirmed live: this operation's rate-limit bucket is separate from
      // everything else the scan uses, so this can run well above what a
      // shared budget would allow. See the matching comment in
      // verifyMemberActivityViaSearch for the exact math.
      maxCandidatesPerRun: 400,
      onProgress: ({ checked, queued }) => {
        setState({
          requestsCount: ctx.requestStats.count,
          statusText: `Direct search verification ${checked.toLocaleString()} of ${queued.toLocaleString()}`,
        });
      },
    });
    let cleared = 0;
    currentResults = currentResults.reduce((kept, member) => {
      const result = verification.results.get(activitySearchCandidateIdentity(member));
      const classified = classifySearchVerification(member, result);
      if (classified.cleared) {
        cleared++;
        return kept;
      }
      kept.push({ ...member, activityVerification: classified.activityVerification });
      return kept;
    }, []);
    currentDiagnostics.activitySearchVerification = {
      checked: verification.checked,
      queued: verification.queued,
      remaining: verification.remaining,
      cleared,
      reason: verification.reason,
    };
    log(
      `Direct search verification checked ${verification.checked.toLocaleString()} flagged ` +
      `member(s) and cleared ${cleared.toLocaleString()} whose activity the broad crawl missed` +
      (verification.remaining ? `; ${verification.remaining.toLocaleString()} remain queued for a later scan.` : ".")
    );
  } catch (error) {
    if (error instanceof StoppedError || error?.name === "StoppedError") throw error;
    log(`Direct search verification unavailable; the flagged list is unconfirmed. ${error.message}`);
  }
}

async function finalizeResultsAndSave(ctx) {
  ctx.analyzedMembers = ctx.members.map((member) => annotateMemberActivity(member, ctx.active));
  currentPrivateAccounts = mergeMemberLists(
    currentPrivateAccounts,
    ctx.analyzedMembers.filter((member) => member.protected === true && member.membershipEvidence === "x-roster")
  ).merged;
  renderPrivateExportState();
  const activityWindowCovered = currentActivityState.complete === true;
  currentResults = activityWindowCovered
    ? ctx.analyzedMembers.filter((member) => member.postsInWindow === 0).map((member) => classifyFlaggedMember(member, ctx.lookbackDays))
    : [];

  // The broad crawl above never covers a Community's full history and the
  // word-shard search only catches posts containing one of a handful of
  // common words, so a flagged member can simply be someone that crawl did
  // not happen to see post. A direct `(from:username)` search settles it
  // with certainty at one request per flagged member - proportionate
  // because only the flagged subset is checked, never the full roster.
  if (activityWindowCovered && currentResults.length) {
    await verifySearchActivityForFlagged(ctx);
  }

  setPhase(
    currentRosterState.complete && currentActivityState.complete ? "Complete" : "Analysis complete · partial evidence",
    "complete"
  );
  setState({
    statusText: activityWindowCovered
      ? `${currentResults.length.toLocaleString()} inactive${currentRosterState.complete ? "" : " (partial roster)"}`
      : currentActivityState.reason === "quota-paused"
        ? "Activity scan paused · timeline quota is low"
        : "Activity window incomplete · no members classified",
    requestsCount: ctx.requestStats.count,
    coveragePercent: 100,
  });
  const resultSummary =
    (activityWindowCovered
      ? `${currentResults.length.toLocaleString()} inactive from ` +
        `${ctx.confirmedRosterCount.toLocaleString()} X-roster record(s)` +
        (ctx.supplementalCount ? ` plus ${ctx.supplementalCount.toLocaleString()} evidence-based supplemental record(s)` : "") +
        `. Each inactive member had zero Community posts and zero Community replies ` +
        `during the last ${ctx.lookbackDays} calendar days.`
      : `No inactive members were classified because the scanner has not yet reached ` +
        `the start of the ${ctx.lookbackDays}-day activity window` +
        (currentActivityState.oldestSeenAt
          ? ` (reached ${activityCoverageProgressLabel(calendarActivityWindow(ctx.lookbackDays).sinceDate, currentActivityState.oldestSeenAt)})`
          : "") +
        (currentActivityState.reason === "quota-paused"
          ? `. X's timeline quota ran low, so this scan paused rather than spending it ` +
            `all in one run; progress is saved and the next scan continues from here.`
          : `. This scan reached its page budget before the window closed; the next scan ` +
            `continues from its saved activity cursor.`)) +
    (currentRosterState.complete ? "" : ` This is a partial-roster result: ${friendlyStopReason(currentRosterState.reason)}.`) +
    (currentDiagnostics?.activitySearchVerification
      ? ` Direct search confirmed ${currentDiagnostics.activitySearchVerification.checked.toLocaleString()} flagged member(s) this scan` +
        (currentDiagnostics.activitySearchVerification.remaining
          ? `; ${currentDiagnostics.activitySearchVerification.remaining.toLocaleString()} still rest on the ` +
            `broad crawl alone and will be checked on a later scan (see the CSV's activity_verification column).`
          : "; every flagged member in this export is directly confirmed.")
      : "");
  setState({ resultSummary });
  renderArchiveStatus(ctx);
  renderResults(currentResults);
  renderPrivateExportState();
  setState({ resultsPanelVisible: true });
  log(
    activityWindowCovered
      ? `Activity classification complete · ${currentResults.length.toLocaleString()} inactive account(s).`
      : "Activity classification deferred because the selected window is not fully covered."
  );
  await saveScanJob("complete", {
    phase: "complete",
    flagged: currentResults.length,
    requests: ctx.requestStats.count,
    activity: currentActivityState,
    results: currentResults,
  });
}

// The explicit order a scan runs its stages in. Each step still owns its own
// setPhase() calls and state updates; this list only names the sequence
// itself.
// resumePolicy is a claim about each step's *own* real side effects, checked
// by reading the step, not copied from a template:
//   - "checkpoint-resumable": the step's expensive work is itself backed by a
//     chrome.storage checkpoint or cache (roster cursor pages, activity's
//     stored scan cursor, the timeline/media/search backfill checkpoints,
//     verifyKnownCommunityMembers' and verifyMemberActivityViaSearch's own
//     caches) - re-entering the step after a restart continues from real
//     saved progress, not from zero.
//   - "idempotent-rerun": the step has no checkpoint of its own, but running
//     it again from scratch is safe and cheap - it only ever *overwrites*
//     derived state (annotate/filter/classify a fresh currentResults each
//     time, merge-dedupe via mergeMemberLists) rather than accumulating onto
//     whatever a previous run already added, so nothing doubles.
const SCAN_STEPS = [
  { name: "discover-community", resumePolicy: "idempotent-rerun", run: discoverActivityAndCommunityInfo },
  { name: "collect-native-roster", resumePolicy: "checkpoint-resumable", run: collectNativeRoster },
  { name: "collect-cursor-roster", resumePolicy: "checkpoint-resumable", run: collectCursorRoster },
  { name: "collect-dom-fallback", resumePolicy: "idempotent-rerun", run: collectDomFallbackOrReconcile },
  { name: "finalize-roster", resumePolicy: "idempotent-rerun", run: finalizeRosterAndAboutMembers },
  { name: "analyze-recent-activity", resumePolicy: "checkpoint-resumable", run: analyzeRecentActivity },
  { name: "archive-timeline-media-search", resumePolicy: "checkpoint-resumable", run: archiveTimelineMediaAndSearch },
  { name: "merge-and-verify-authors", resumePolicy: "checkpoint-resumable", run: mergeAuthorsAndVerifyMembership },
  { name: "finalize-results", resumePolicy: "idempotent-rerun", run: finalizeResultsAndSave },
];

// ---------------------------------------------------------------------------
// Public scan controls.

export async function startScan(settings) {
  const communityId = communityIdFrom(settings.communityId);
  if (!communityId) return { ok: false, message: "Paste a valid X Community URL or numeric ID." };
  const lookbackDays = Math.max(1, Number.parseInt(settings.lookbackDays, 10) || 30);
  const timelineBackfill = Boolean(settings.timelineBackfill);
  const lockForeground = Boolean(settings.focusLock);
  const seekResume = Boolean(settings.seekResume);

  setState({ communityId, lookbackDays, timelineBackfill, focusLock: lockForeground, seekResume });

  await chrome.storage.local.set({
    liteScanSettings: {
      communityId,
      lookbackDays,
      inactivityRule: "zero-community-posts-or-replies",
      timelineBackfill,
      focusLock: lockForeground,
      seekResume,
    },
  });

  let lease;
  try {
    lease = await acquireScanLease();
  } catch (error) {
    setState({ surfaceNotice: `Could not coordinate the scan interfaces: ${error.message}` });
    return { ok: false };
  }
  if (!lease?.acquired) {
    const mode = lease?.lease?.mode || "another interface";
    setState({ surfaceNotice: `A scan is already running in ${mode}. Stop it there before starting another.` });
    return { ok: false };
  }

  setState({
    surfaceNotice: "",
    resumeJob: null,
    busy: true,
    startLabel: "Scanning",
    progressVisible: true,
    resultsPanelVisible: false,
    archiveRows: [],
    exportEnabled: false,
    exportConfirmedEnabled: false,
    exportUsernamesEnabled: false,
    confirmedCount: 0,
    privatePanelVisible: false,
    coverageMessage: "",
    coverageMessagePartial: false,
    logLines: [],
    diagnosticsExportEnabled: true,
    membersFound: 0,
    expectedMembers: null,
    coveragePercent: null,
    requestsCount: 0,
  });
  logLines = [];
  currentResults = [];
  currentPrivateAccounts = [];
  privateRosterReady = false;
  currentDiagnostics = null;
  currentCompleteness = null;
  activityThroughputWindow = [];
  renderPrivateExportState();
  currentCommunityId = communityId;
  expectedMembers = null;
  currentRosterState = { complete: false, found: 0, expected: null, reason: "starting" };
  currentActivityState = { complete: false, backfillComplete: false, reason: "starting" };

  abortController = new AbortController();
  const { signal } = abortController;
  const requestStats = { count: 0, quotas: {}, operations: {}, network: [], rosterPages: [], steps: [], dom: null, activity: null };
  currentDiagnostics = requestStats;
  const limiter = new AdaptiveRateLimiter();

  const ctx = {
    communityId,
    lookbackDays,
    inactivityRule: "zero-community-posts-or-replies",
    timelineBackfill,
    lockForeground,
    seekResume,
    signal,
    requestStats,
    limiter,
    tab: null,
    dashboardTab: null,
    timelineOperation: null,
    members: [],
    cursorComplete: false,
    rosterReason: "cursor-unavailable",
    cursorReturnedMembers: false,
    directRosterCount: 0,
    confirmedRosterCount: 0,
    active: null,
    activeAuthors: [],
    timelineAuthors: [],
    mediaAuthors: [],
    searchAuthors: [],
    timelineArchiveState: null,
    rememberedAuthors: [],
    verifiedAuthorAdditions: 0,
    recentAuthorAdditions: 0,
    historicalAdditions: 0,
    supplementalCount: 0,
    analyzedMembers: [],
  };

  try {
    log("Scan initialized · settings validated locally.");
    await saveScanJob("running", { phase: "checking-access" });
    const coordinator = new ScanCoordinator(SCAN_STEPS);
    // A step interrupted mid-run (browser closed, service worker suspended)
    // previously left no trace at all in requestStats.steps - onStepEnd only
    // ever appended once a step finished, so "in progress when interrupted"
    // was indistinguishable from "never reached." Now a "running" entry is
    // recorded the instant a step starts and updated in place when it ends.
    let runningStepEntry = null;
    await coordinator.run(ctx, {
      onStepStart: (name) => {
        requestStats.steps ||= [];
        runningStepEntry = { name, durationMs: null, ok: null, status: "running" };
        requestStats.steps.push(runningStepEntry);
      },
      onStepEnd: (name, _ctx, { durationMs, error: stepError }) => {
        requestStats.steps ||= [];
        if (runningStepEntry?.name === name) {
          runningStepEntry.durationMs = durationMs;
          runningStepEntry.ok = !stepError;
          runningStepEntry.status = stepError ? "failed" : "complete";
        } else {
          requestStats.steps.push({ name, durationMs, ok: !stepError, status: stepError ? "failed" : "complete" });
        }
      },
    });
  } catch (error) {
    if (error instanceof StoppedError || error?.name === "StoppedError") {
      setPhase("Stopped", "stopped");
      setState({ statusText: "Scan stopped" });
      log("Stopped by user.");
      await saveScanJob("stopped", { phase: "stopped", requests: requestStats.count });
    } else {
      console.error(error);
      setPhase("Error", "error");
      setState({ statusText: error.message, coverageMessage: error.message, coverageMessagePartial: true });
      log(error.message);
      await saveScanJob("error", { phase: "error", error: error.message, requests: requestStats.count });
    }
  } finally {
    abortController = null;
    await releaseScanLease();
    setState({ busy: false, startLabel: "Scan again" });
    void refreshStorage();
  }
  return { ok: true };
}

export function stopScan() {
  abortController?.abort();
}

export function resumeScan() {
  setState({ resumeJob: null });
  return startScan(scanSettingsSnapshot());
}

// ---------------------------------------------------------------------------
// Diagnostics + exports.

async function collectSafeBrowserDiagnostics() {
  const tab = await activeTab().catch(() => null);
  if (!tab?.id) return { tab: null, page: null };
  const windowInfo = await chrome.windows.get(tab.windowId).catch(() => null);
  const safeTab = {
    active: tab.active,
    discarded: tab.discarded,
    frozen: tab.frozen,
    autoDiscardable: tab.autoDiscardable,
    status: tab.status,
    windowFocused: windowInfo?.focused,
    windowState: windowInfo?.state,
  };
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({
      visibilityState: document.visibilityState,
      hidden: document.hidden,
      focused: document.hasFocus(),
      renderedMemberRows: document.querySelectorAll('[data-testid="primaryColumn"] [data-testid="UserCell"]').length,
      renderedNonRosterUserRows: Math.max(
        0,
        document.querySelectorAll('[data-testid="UserCell"]').length -
          document.querySelectorAll('[data-testid="primaryColumn"] [data-testid="UserCell"]').length
      ),
      primaryColumnPresent: Boolean(document.querySelector('[data-testid="primaryColumn"]')),
      viewportHeight: window.innerHeight,
      scrollTop: (document.scrollingElement || document.documentElement)?.scrollTop || 0,
      scrollHeight: (document.scrollingElement || document.documentElement)?.scrollHeight || 0,
    }),
  }).catch(() => []);
  return { tab: safeTab, page: execution?.result || null };
}

export async function exportDiagnostics() {
  setState({ diagnosticsExportBusy: true });
  try {
    const [{ [SCAN_JOB_KEY]: storedJob }, browserState] = await Promise.all([
      chrome.storage.local.get(SCAN_JOB_KEY),
      collectSafeBrowserDiagnostics(),
    ]);
    const settings = scanSettingsSnapshot();
    const job = {
      ...(storedJob || {}),
      communityId: currentCommunityId || storedJob?.communityId || communityIdFrom(settings.communityId),
      diagnostics: currentDiagnostics || storedJob?.diagnostics || null,
      roster: currentRosterState,
      activity: currentActivityState,
      expectedMembers,
    };
    const report = buildDiagnosticReport({
      manifest: chrome.runtime.getManifest(),
      userAgent: navigator.userAgent,
      language: navigator.language,
      job,
      settings: {
        communityId: job.communityId,
        lookbackDays: Number.parseInt(settings.lookbackDays, 10) || null,
        inactivityRule: "zero-community-posts-or-replies",
        timelineBackfill: settings.timelineBackfill,
        focusLock: settings.focusLock,
        seekResume: settings.seekResume,
      },
      events: logLines,
      tab: browserState.tab,
      page: browserState.page,
    });
    downloadBlob(
      `${JSON.stringify(report, null, 2)}\n`,
      "application/json;charset=utf-8",
      `community_${job.communityId || "unknown"}_diagnostics_${new Date().toISOString().slice(0, 10)}.json`
    );
    log("Sanitized diagnostic report exported.");
  } catch (error) {
    console.error(error);
    log(`Diagnostic export failed. ${error.message}`);
  } finally {
    setState({ diagnosticsExportBusy: false });
  }
}

export function exportAllFlagged() {
  if (!currentResults.length) return;
  const rosterLabel = currentRosterState.complete ? "complete" : "partial";
  const activityLabel = currentActivityState.complete ? "activity-complete" : "activity-partial";
  downloadBlob(
    buildCsv(currentResults, currentRosterState, currentActivityState),
    "text/csv;charset=utf-8",
    `community_${currentCommunityId}_inactive_${rosterLabel}_${activityLabel}_${new Date().toISOString().slice(0, 10)}.csv`
  );
}

// A separate, narrower export: only rows a direct search actually confirmed.
// The main export mixes those with unverified and unverifiable-protected
// rows, which is the right default for review but the wrong list to act on
// directly when the export's purpose is picking accounts to remove.
export function exportConfirmedOnly() {
  const confirmed = currentResults.filter((row) => row.activityVerification === "confirmed-inactive");
  if (!confirmed.length) return;
  // Fail closed rather than export: this filter should make the invariant
  // true by construction, but this is the one export a moderator might act
  // on directly, so it is worth a real, thrown check rather than only a
  // trusted assumption.
  assertConfirmedOnlyRowsAreConfirmed(confirmed);
  const rosterLabel = currentRosterState.complete ? "complete" : "partial";
  downloadBlob(
    buildCsv(confirmed, currentRosterState, currentActivityState),
    "text/csv;charset=utf-8",
    `community_${currentCommunityId}_inactive_confirmed_${rosterLabel}_${new Date().toISOString().slice(0, 10)}.csv`
  );
}

// A plain @username list, members only (no moderators), for pasting directly
// into a moderation tool - same confirmed-inactive row set as
// exportConfirmedOnly, not the broader main export, for the same "wrong list
// to act on directly" reason.
export function exportUsernamesOnly() {
  const confirmed = currentResults.filter((row) => row.activityVerification === "confirmed-inactive");
  if (!confirmed.length) return;
  assertConfirmedOnlyRowsAreConfirmed(confirmed);
  const rosterLabel = currentRosterState.complete ? "complete" : "partial";
  downloadBlob(
    buildFlaggedUsernamesText(confirmed),
    "text/plain;charset=utf-8",
    `community_${currentCommunityId}_inactive_confirmed_usernames_${rosterLabel}_${new Date().toISOString().slice(0, 10)}.txt`
  );
}

export function exportPrivateCsv() {
  if (!currentPrivateAccounts.length) return;
  const rosterLabel = currentRosterState.complete ? "complete" : "partial";
  downloadBlob(
    buildPrivateAccountsCsv(currentPrivateAccounts),
    "text/csv;charset=utf-8",
    `community_${currentCommunityId}_private_accounts_${rosterLabel}_${new Date().toISOString().slice(0, 10)}.csv`
  );
}

export function exportPrivateText() {
  if (!currentPrivateAccounts.length) return;
  const rosterLabel = currentRosterState.complete ? "complete" : "partial";
  downloadBlob(
    buildPrivateAccountsText(currentPrivateAccounts),
    "text/plain;charset=utf-8",
    `community_${currentCommunityId}_private_accounts_${rosterLabel}_${new Date().toISOString().slice(0, 10)}.txt`
  );
}
