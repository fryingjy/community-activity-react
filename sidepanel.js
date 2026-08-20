// Phase 2 of the React rebuild: a thin vanilla-DOM adapter over
// ui/scanEngine.js's store. Every function below only ever *reads* the
// store and writes DOM - none of the scan orchestration, chrome.storage
// logic, or export logic lives here anymore (see ui/scanEngine.js). This
// file exists to prove the state extraction is behaviorally correct against
// markup that's already known-good, before Phase 3 replaces it with React
// components reading from the same store.
import {
  store,
  init,
  startScan,
  stopScan,
  resumeScan,
  discardScan,
  refreshStorage,
  clearCommunityData,
  clearAllData,
  exportDiagnostics,
  exportAllFlagged,
  exportConfirmedOnly,
  exportUsernamesOnly,
  exportPrivateCsv,
  exportPrivateText,
  openCommunityTab,
  toggleDashboardMode,
} from "./ui/scanEngine.js";

const $ = (id) => document.getElementById(id);
const communityIdEl = $("communityId");
const lookbackDaysEl = $("lookbackDays");
const timelineBackfillEl = $("timelineBackfill");
const focusLockEl = $("focusLock");
const seekResumeEl = $("seekResume");
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const progressPanel = $("progressPanel");
const privatePanel = $("privatePanel");
const resultsPanel = $("resultsPanel");
const phaseValue = $("phaseValue");
const statusValue = $("statusValue");
const membersValue = $("membersValue");
const expectedValue = $("expectedValue");
const coverageValue = $("coverageValue");
const coverageStat = $("coverageStat");
const requestsValue = $("requestsValue");
const progressTrack = $("progressTrack");
const progressFill = $("progressFill");
const coverageMessage = $("coverageMessage");
const logEl = $("log");
const logCountEl = $("logCount");
const exportDiagnosticsBtn = $("exportDiagnosticsBtn");
const flaggedValue = $("flaggedValue");
const resultSummary = $("resultSummary");
const resultsBody = $("resultsBody");
const previewNote = $("previewNote");
const exportBtn = $("exportBtn");
const exportConfirmedBtn = $("exportConfirmedBtn");
const exportUsernamesBtn = $("exportUsernamesBtn");
const confirmedCountEl = $("confirmedCount");
const exportPrivateBtn = $("exportPrivateBtn");
const exportPrivateTextBtn = $("exportPrivateTextBtn");
const privateValue = $("privateValue");
const privateNote = $("privateNote");
const modeToggleBtn = $("modeToggleBtn");
const communityTabBtn = $("communityTabBtn");
const surfaceNoticeEl = $("surfaceNotice");
const resumePanel = $("resumePanel");
const resumeCommunityValue = $("resumeCommunityValue");
const resumeStatusText = $("resumeStatusText");
const resumeSummary = $("resumeSummary");
const resumeStageList = $("resumeStageList");
const resumeScanBtn = $("resumeScanBtn");
const discardScanBtn = $("discardScanBtn");
const scanForm = $("scanForm");
const archiveStatusPanel = $("archiveStatusPanel");
const archiveStatusList = $("archiveStatusList");
const storageCommunityCount = $("storageCommunityCount");
const storageBytesValue = $("storageBytesValue");
const clearCommunityBtn = $("clearCommunityBtn");
const clearAllDataBtn = $("clearAllDataBtn");
const contextEl = $("context");

const initialState = store.getState();
document.documentElement.dataset.mode = initialState.dashboardMode ? "dashboard" : "lite";
document.title = initialState.dashboardMode ? "Community Activity Dashboard" : "Community Activity Lite";
modeToggleBtn.textContent = initialState.dashboardMode ? "Open Lite panel" : "Full dashboard";

// ---------------------------------------------------------------------------
// Log rendering. The engine's logLines only ever resets to [] or grows by
// exactly one entry (dropping the oldest once past its 80-entry cap, see
// ui/scanEngine.js's log()) - a reference change is therefore always either
// a clear or a single append, never a reorder or bulk replace.

function logEntryElement(entry, isNew) {
  const item = document.createElement("li");
  item.className = `log-entry ${entry.level}${isNew ? " is-new" : ""}`;
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = entry.time;
  const dot = document.createElement("i");
  dot.className = "log-dot";
  dot.setAttribute("aria-hidden", "true");
  const message = document.createElement("span");
  message.className = "log-message";
  message.textContent = entry.message;
  item.append(time, dot, message);
  return item;
}

function renderLogFull(logLines) {
  logEl.replaceChildren(...logLines.map((entry) => logEntryElement(entry, false)));
  logCountEl.textContent = `${logLines.length} ${logLines.length === 1 ? "event" : "events"}`;
  logEl.scrollTop = logEl.scrollHeight;
}

// A scan emits hundreds of events. Rebuilding all 80 retained rows for each
// one re-ran every row's entrance animation, which read as the list
// flickering, and discarded the user's scroll position mid-read.
function appendLogEntry(logLines) {
  const pinnedToBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  logEl.append(logEntryElement(logLines[logLines.length - 1], true));
  while (logEl.childElementCount > logLines.length) logEl.firstElementChild?.remove();
  logCountEl.textContent = `${logLines.length} ${logLines.length === 1 ? "event" : "events"}`;
  if (pinnedToBottom) logEl.scrollTop = logEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Results table - a full rebuild on every call, matching the original: results
// only change once per scan completion or on initial restore, never per-event.

function renderResultsTable(rows) {
  resultsBody.replaceChildren();
  for (const row of rows.slice(0, 100)) {
    const tr = document.createElement("tr");
    const username = document.createElement("td");
    const posts = document.createElement("td");
    const replies = document.createElement("td");
    username.textContent = `@${row.username}`;
    posts.textContent = String(row.communityPostsInWindow || 0);
    replies.textContent = String(row.communityRepliesInWindow || 0);
    tr.append(username, posts, replies);
    resultsBody.append(tr);
  }
}

function renderArchiveList(rows) {
  archiveStatusList.replaceChildren();
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = `archive-status-row is-${row.status}`;
    const dot = document.createElement("span");
    dot.className = "archive-status-dot";
    dot.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "archive-status-name";
    name.textContent = row.name;
    const detail = document.createElement("span");
    detail.className = "archive-status-detail";
    detail.textContent = row.detail;
    li.append(dot, name, detail);
    archiveStatusList.append(li);
  }
  archiveStatusPanel.hidden = rows.length === 0;
}

function renderResumePanel(job) {
  if (!job) {
    resumePanel.hidden = true;
    return;
  }
  resumeCommunityValue.textContent = `Community ${job.communityId}`;
  resumeStatusText.textContent = job.statusLabel;
  resumeSummary.textContent = job.summaryText;
  resumeStageList.replaceChildren();
  for (const stage of job.stages) {
    const li = document.createElement("li");
    li.className = `resume-stage is-${stage.status}`;
    li.title = stage.resumeHint;
    const dot = document.createElement("span");
    dot.className = "resume-stage-dot";
    dot.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "resume-stage-name";
    name.textContent = stage.label;
    const status = document.createElement("span");
    status.className = "resume-stage-status";
    status.textContent = stage.statusText;
    li.append(dot, name, status);
    resumeStageList.append(li);
  }
  resumePanel.hidden = false;
}

// Drives the phase rail + live badge from the engine's already-derived
// phaseActiveIndex/badge fields - no MutationObserver needed once the active
// step is state instead of a DOM side effect to watch.
function renderPhaseRail(state) {
  const stages = [...document.querySelectorAll(".phase-step")];
  const lines = [...document.querySelectorAll(".phase-line")];
  stages.forEach((step, index) => {
    step.classList.toggle("done", index < state.phaseActiveIndex);
    step.classList.toggle("active", index === state.phaseActiveIndex);
  });
  lines.forEach((line, index) => line.classList.toggle("done", index < state.phaseActiveIndex));
  const badge = document.querySelector(".live-badge");
  badge.className = `live-badge${state.badgeClass ? ` ${state.badgeClass}` : ""}`;
  badge.lastChild.textContent = state.badgeLabel;
}

// ---------------------------------------------------------------------------
// Single subscriber: re-renders whatever changed since the last state. Scalar
// fields are cheap to re-set unconditionally (idempotent, no visible churn);
// the log list and phase rail get the special-cased handling above because
// the original code specifically called out the regressions naive full
// rebuilds caused for those two.

let previousState = null;

function render(state) {
  const prev = previousState;
  previousState = state;

  if (!prev || state.logLines !== prev.logLines) {
    if (state.logLines.length === 0) renderLogFull(state.logLines);
    else if (!prev) renderLogFull(state.logLines);
    else appendLogEntry(state.logLines);
  }

  surfaceNoticeEl.textContent = state.surfaceNotice;
  surfaceNoticeEl.hidden = !state.surfaceNotice;

  contextEl.textContent = state.contextLabel;
  if (state.contextTitle) contextEl.title = state.contextTitle;

  renderResumePanel(state.resumeJob);

  startBtn.disabled = state.busy;
  stopBtn.disabled = !state.busy;
  communityIdEl.disabled = state.busy;
  lookbackDaysEl.disabled = state.busy;
  timelineBackfillEl.disabled = state.busy;
  focusLockEl.disabled = state.busy;
  seekResumeEl.disabled = state.busy;
  const startLabelEl = startBtn.querySelector("span");
  if (startLabelEl) startLabelEl.textContent = state.startLabel;

  progressPanel.hidden = !state.progressVisible;
  phaseValue.textContent = state.phaseLabel;
  phaseValue.dataset.stage = state.phaseStage;
  renderPhaseRail(state);
  statusValue.textContent = state.statusText;
  membersValue.textContent = state.membersFound.toLocaleString();
  expectedValue.textContent = state.expectedMembers?.toLocaleString() || "—";
  if (state.coveragePercent == null) {
    progressTrack.classList.add("indeterminate");
    progressTrack.removeAttribute("aria-valuenow");
    coverageValue.textContent = "—";
    coverageStat.classList.remove("partial");
  } else {
    progressTrack.classList.remove("indeterminate");
    progressFill.style.width = `${state.coveragePercent}%`;
    progressTrack.setAttribute("aria-valuenow", String(Math.round(state.coveragePercent)));
    coverageValue.textContent = `${state.coveragePercent.toFixed(1)}%`;
    coverageStat.classList.toggle("partial", state.coveragePercent < 99.5);
  }
  requestsValue.textContent = state.requestsCount.toLocaleString();
  coverageMessage.textContent = state.coverageMessage;
  coverageMessage.className = `coverage${state.coverageMessagePartial ? " partial" : ""}`;
  exportDiagnosticsBtn.disabled = !state.diagnosticsExportEnabled || state.diagnosticsExportBusy;

  archiveStatusList && renderArchiveList(state.archiveRows);

  privatePanel.hidden = !state.privatePanelVisible;
  privateValue.textContent = state.privateAccounts.length.toLocaleString();
  exportPrivateBtn.disabled = state.privateAccounts.length === 0;
  exportPrivateTextBtn.disabled = state.privateAccounts.length === 0;
  if (state.privateNote != null) privateNote.textContent = state.privateNote;

  resultsPanel.hidden = !state.resultsPanelVisible;
  flaggedValue.textContent = state.results.length.toLocaleString();
  resultSummary.textContent = state.resultSummary;
  if (!prev || state.results !== prev.results) renderResultsTable(state.results);
  previewNote.textContent = state.previewNote;
  exportBtn.disabled = !state.exportEnabled;
  confirmedCountEl.textContent = state.confirmedCount.toLocaleString();
  exportConfirmedBtn.disabled = !state.exportConfirmedEnabled;
  exportUsernamesBtn.disabled = !state.exportUsernamesEnabled;

  storageCommunityCount.textContent = state.storageCommunityCount?.toLocaleString() ?? "—";
  storageBytesValue.textContent = state.storageBytesLabel ?? "—";
  clearCommunityBtn.disabled = !state.clearCommunityEnabled;
  clearAllDataBtn.disabled = !state.clearAllEnabled;

  // Controlled-input mirroring: only write a value back into the DOM when it
  // actually differs, so a user mid-keystroke is never fought with their own
  // input being overwritten by its own state round-trip.
  if (communityIdEl.value !== state.communityId) communityIdEl.value = state.communityId;
  if (lookbackDaysEl.value !== String(state.lookbackDays)) lookbackDaysEl.value = String(state.lookbackDays);
  if (timelineBackfillEl.checked !== state.timelineBackfill) timelineBackfillEl.checked = state.timelineBackfill;
  if (focusLockEl.checked !== state.focusLock) focusLockEl.checked = state.focusLock;
  if (seekResumeEl.checked !== state.seekResume) seekResumeEl.checked = state.seekResume;
}

store.subscribe(() => render(store.getState()));

// ---------------------------------------------------------------------------
// Event wiring - every handler just reads the form / calls the engine.

communityIdEl.addEventListener("input", () => {
  store.setState({ communityId: communityIdEl.value });
});
communityIdEl.addEventListener("change", () => {
  void refreshStorage();
});
lookbackDaysEl.addEventListener("change", () => {
  store.setState({ lookbackDays: Number.parseInt(lookbackDaysEl.value, 10) || 30 });
});
timelineBackfillEl.addEventListener("change", () => {
  store.setState({ timelineBackfill: timelineBackfillEl.checked });
});
focusLockEl.addEventListener("change", () => {
  store.setState({ focusLock: focusLockEl.checked });
});
seekResumeEl.addEventListener("change", () => {
  store.setState({ seekResume: seekResumeEl.checked });
});

communityTabBtn.addEventListener("click", async () => {
  const result = await openCommunityTab();
  if (!result.ok) {
    communityTabBtn.textContent = result.message;
    setTimeout(() => {
      communityTabBtn.textContent = "Open X tab";
    }, 3500);
  }
});

modeToggleBtn.addEventListener("click", async () => {
  const result = await toggleDashboardMode();
  if (!result.ok) {
    modeToggleBtn.textContent = result.message;
    setTimeout(() => {
      modeToggleBtn.textContent = store.getState().dashboardMode ? "Open Lite panel" : "Full dashboard";
    }, 3500);
  }
});

resumeScanBtn.addEventListener("click", () => {
  void resumeScan();
});
discardScanBtn.addEventListener("click", () => {
  void discardScan();
});

clearCommunityBtn.addEventListener("click", async () => {
  const communityId = store.getState().communityId.match(/\/communities\/(\d+)/i)?.[1] ||
    (/^\d+$/.test(store.getState().communityId.trim()) ? store.getState().communityId.trim() : "");
  if (!communityId) return;
  const confirmed = confirm(
    `Clear all saved roster, activity, verification, and archive data for Community ${communityId}? ` +
    `This does not affect X and does not delete anything already exported.`
  );
  if (!confirmed) return;
  await clearCommunityData(communityId);
});

clearAllDataBtn.addEventListener("click", async () => {
  const confirmed = confirm(
    "Clear ALL Community Activity data saved in this browser - every Community's roster, " +
    "activity, verification, and archive checkpoints, plus saved settings? This cannot be undone " +
    "and does not affect X or anything already exported."
  );
  if (!confirmed) return;
  await clearAllData();
});

scanForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const state = store.getState();
  if (!state.communityId.trim()) {
    communityIdEl.setCustomValidity("Paste a valid X Community URL or numeric ID.");
    communityIdEl.reportValidity();
    return;
  }
  communityIdEl.setCustomValidity("");
  void startScan(state);
});

stopBtn.addEventListener("click", () => stopScan());

exportDiagnosticsBtn.addEventListener("click", () => {
  void exportDiagnostics();
});
exportBtn.addEventListener("click", () => exportAllFlagged());
exportConfirmedBtn.addEventListener("click", () => exportConfirmedOnly());
exportUsernamesBtn.addEventListener("click", () => exportUsernamesOnly());
exportPrivateBtn.addEventListener("click", () => exportPrivateCsv());
exportPrivateTextBtn.addEventListener("click", () => exportPrivateText());

// ---------------------------------------------------------------------------
// Boot.

render(store.getState());
init();
