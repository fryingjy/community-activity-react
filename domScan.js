import { StoppedError } from "./liteScanner.js";

const MEMBERS_URL = (communityId) =>
  `https://x.com/i/communities/${encodeURIComponent(communityId)}/members`;
const POLL_MS = 850;
const MAX_IDLE_PASSES = 10;
const MAX_SCROLL_MS = 4 * 60 * 60 * 1000;

function stopped(signal) {
  if (signal?.aborted) throw new StoppedError();
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new StoppedError());
    }, { once: true });
  });
}

async function waitForTab(tabId, signal) {
  for (let attempt = 0; attempt < 60; attempt++) {
    stopped(signal);
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await delay(250, signal);
  }
  throw new Error("The X Members page did not finish loading.");
}

async function openForegroundMembersWindow(communityId) {
  // X's virtualized roster only advances reliably while Chromium is painting
  // it. Keep the collector honest: foreground it instead of pretending a
  // fully occluded popup can behave like a visible page.
  const currentWindow = await chrome.windows.getLastFocused().catch(() => null);
  const width = Math.max(560, Math.min(760, currentWindow?.width || 720));
  const height = Math.max(700, Math.min(960, currentWindow?.height || 860));
  const left = Number.isFinite(currentWindow?.left)
    ? currentWindow.left + Math.max(0, (currentWindow.width || width) - width)
    : undefined;
  const top = Number.isFinite(currentWindow?.top) ? currentWindow.top : undefined;
  const created = await chrome.windows.create({
    url: MEMBERS_URL(communityId),
    type: "popup",
    focused: true,
    width,
    height,
    ...(Number.isFinite(left) ? { left } : {}),
    ...(Number.isFinite(top) ? { top } : {}),
  });
  const tabId = created.tabs?.[0]?.id;
  if (created.id == null || tabId == null) {
    if (created.id != null) await chrome.windows.remove(created.id).catch(() => {});
    throw new Error("Could not open the X Members collector window.");
  }
  return { windowId: created.id, tabId };
}

async function keepTabForeground(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.discarded) throw new Error("Chrome discarded the X Members tab.");
  if (!tab.active) await chrome.tabs.update(tabId, { active: true });
  await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  const collectorWindow = await chrome.windows.get(tab.windowId);
  if (collectorWindow.state === "minimized") {
    await chrome.windows.update(tab.windowId, { state: "normal", focused: true });
  } else if (!collectorWindow.focused) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

// X pauses parts of its virtualized timelines when a tab becomes hidden.
// This runs in the page's MAIN world so X's own visibility checks continue
// to see an active document while the user works in another tab.
function keepMembersPageRunning() {
  if (globalThis.__communityActivityVisibilityShim) return;
  globalThis.__communityActivityVisibilityShim = true;
  try {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
  } catch (_) {
    // Some Chromium builds may expose non-configurable document properties.
  }
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
}

function resetMembersCollector() {
  globalThis.__communityActivityCollector?.observer?.disconnect?.();
  delete globalThis.__communityActivityCollector;
  window.scrollTo({ top: 0, behavior: "auto" });
  const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
  for (let node = primaryColumn; node && node !== document.body; node = node.parentElement) {
    if (node.scrollTop) node.scrollTop = 0;
  }
}

// Matches a GraphQL operation name found in an x.com request URL. When
// operationName is given, only that exact name matches (used for named
// operations like CommunityTweetsTimeline). When omitted, matches the
// members-roster cursor operation by exact name or by the same rotated shape
// X has used historically (member/slice/timeline, excluding lookalikes such
// as moderator or typeahead operations).
function matchesGraphqlOperation(operation, operationName) {
  if (operationName) return operation === operationName;
  const safeRotatedName =
    /member/i.test(operation) &&
    /(slice|timeline)/i.test(operation) &&
    !/(moderator|typeahead|relationship|search)/i.test(operation);
  return operation === "membersSliceTimeline_Query" || safeRotatedName;
}

// Runs in X's MAIN world. Self-contained: values from this module's scope
// (including matchesGraphqlOperation) are not available there, so the match
// logic is duplicated inline. The persisted-query hash rotates, but the
// operation name is visible in Performance resource URLs after the page loads.
// When operationName is omitted (members-roster mode), a match is memoized on
// globalThis so repeated polls skip re-scanning the performance buffer.
function readGraphqlOperationFromPerformance(operationName) {
  const isMatch = (operation) => {
    if (operationName) return operation === operationName;
    const safeRotatedName =
      /member/i.test(operation) &&
      /(slice|timeline)/i.test(operation) &&
      !/(moderator|typeahead|relationship|search)/i.test(operation);
    return operation === "membersSliceTimeline_Query" || safeRotatedName;
  };
  const names = performance.getEntriesByType("resource").map((entry) => entry.name);
  const stored = !operationName && globalThis.__communityActivityMembersOperation;
  if (stored) names.unshift(stored);
  for (const name of names) {
    let parsed;
    try {
      parsed = new URL(String(name), location.href);
    } catch (_) {
      continue;
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    const graphqlIndex = segments.findIndex((segment) => segment === "graphql");
    if (graphqlIndex < 0 || segments.length <= graphqlIndex + 2) continue;
    const documentId = segments[graphqlIndex + 1];
    const operation = segments[graphqlIndex + 2];
    if (!isMatch(operation)) continue;

    let variables = {};
    let features = {};
    try { variables = JSON.parse(parsed.searchParams.get("variables") || "{}"); } catch (_) {}
    try { features = JSON.parse(parsed.searchParams.get("features") || "{}"); } catch (_) {}
    if (!operationName) globalThis.__communityActivityMembersOperation = name;
    return { documentId, operation, url: name, variables, features };
  }
  return null;
}

function parseGraphqlOperationUrl(rawUrl, operationName) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch (_) {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const graphqlIndex = segments.findIndex((segment) => segment === "graphql");
  if (graphqlIndex < 0 || segments.length <= graphqlIndex + 2) return null;
  const documentId = segments[graphqlIndex + 1];
  const operation = segments[graphqlIndex + 2];
  if (!matchesGraphqlOperation(operation, operationName)) return null;

  let variables = {};
  let features = {};
  try { variables = JSON.parse(parsed.searchParams.get("variables") || "{}"); } catch (_) {}
  try { features = JSON.parse(parsed.searchParams.get("features") || "{}"); } catch (_) {}
  return { documentId, operation, url: parsed.href, variables, features };
}

function captureGraphqlOperationRequest(tabId, operationName, signal, timeoutMs = 12000) {
  if (!operationName && !chrome.webRequest?.onBeforeSendHeaders) {
    return { promise: Promise.resolve(null), cancel: () => {} };
  }
  let settled = false;
  let timer;
  let abortHandler;
  let resolveCapture;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    try { chrome.webRequest.onBeforeSendHeaders.removeListener(listener); } catch (_) {}
  };
  const finish = (value) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveCapture(value);
  };
  const listener = (details) => {
    if (details.tabId !== tabId) return;
    const operation = parseGraphqlOperationUrl(details.url, operationName);
    if (!operation) return;
    const transactionHeader = (details.requestHeaders || [])
      .find((header) => header.name?.toLowerCase() === "x-client-transaction-id");
    finish({
      ...operation,
      clientTransactionId: transactionHeader?.value || null,
    });
  };
  const promise = new Promise((resolve) => {
    resolveCapture = resolve;
    chrome.webRequest.onBeforeSendHeaders.addListener(
      listener,
      { urls: ["https://x.com/i/api/graphql/*"] },
      ["requestHeaders"]
    );
    timer = setTimeout(() => finish(null), timeoutMs);
    abortHandler = () => finish(null);
    signal?.addEventListener("abort", abortHandler, { once: true });
  });
  return { promise, cancel: () => finish(null) };
}

async function pollNamedGraphqlOperation(tabId, operationName, attempts, signal) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    stopped(signal);
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: readGraphqlOperationFromPerformance,
      args: [operationName],
    });
    if (execution?.error) throw new Error(execution.error.message || String(execution.error));
    if (execution?.result) return execution.result;
    await delay(250, signal);
  }
  return null;
}

export async function discoverCommunityTimelineOperation(
  communityId,
  tabId,
  { signal, log, lockForeground = true } = {}
) {
  const operationName = "CommunityTweetsTimeline";
  let operation = await pollNamedGraphqlOperation(tabId, operationName, 4, signal);
  if (operation) {
    operation.communityQuery =
      await pollNamedGraphqlOperation(tabId, "CommunityQuery", 2, signal);
    return operation;
  }

  const capture = captureGraphqlOperationRequest(tabId, operationName, signal);
  try {
    await chrome.tabs.update(tabId, {
      url: `https://x.com/i/communities/${encodeURIComponent(communityId)}`,
      active: true,
      autoDiscardable: false,
    });
    await waitForTab(tabId, signal);
    if (lockForeground) await keepTabForeground(tabId);
    operation = await pollNamedGraphqlOperation(tabId, operationName, 24, signal);
    operation ||= await capture.promise;
  } finally {
    capture.cancel();
  }
  if (operation) {
    operation.communityQuery =
      await pollNamedGraphqlOperation(tabId, "CommunityQuery", 4, signal);
    log?.("Detected X's current Community activity operation.");
    return operation;
  }
  log?.("Could not detect X's live activity operation; using the bundled fallback.");
  return null;
}

async function pollMembersOperation(tabId, attempts, signal) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    stopped(signal);
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: readGraphqlOperationFromPerformance,
    });
    if (execution?.error) throw new Error(execution.error.message || String(execution.error));
    if (execution?.result) return execution.result;
    if (attempt === 8) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.scrollBy({ top: Math.max(500, window.innerHeight * 0.8), behavior: "auto" }),
      });
    }
    await delay(250, signal);
  }
  return null;
}

export async function discoverCommunityMembersOperation(
  communityId,
  tabId,
  { signal, log, lockForeground = true } = {}
) {
  stopped(signal);
  const expectedPath = `/i/communities/${communityId}/members`;
  const tab = await chrome.tabs.get(tabId);
  if (!String(tab.url || "").includes(expectedPath)) {
    await chrome.tabs.update(tabId, {
      url: MEMBERS_URL(communityId),
      active: true,
      autoDiscardable: false,
    });
  }
  await waitForTab(tabId, signal);
  if (lockForeground) await keepTabForeground(tabId);

  log?.("Watching the Members page for X's live cursor operation...");
  let operation = await pollMembersOperation(tabId, 16, signal);
  if (!operation) {
    log?.(
      "The original Members request was not in Chrome's resource buffer; " +
      "capturing the next x.com GraphQL request during one page reload."
    );
    const requestCapture = captureGraphqlOperationRequest(tabId, undefined, signal, 18000);
    try {
      await chrome.tabs.reload(tabId);
      await delay(350, signal);
      await waitForTab(tabId, signal);
      if (lockForeground) await keepTabForeground(tabId);
      const performanceOperation = await pollMembersOperation(tabId, 48, signal);
      operation = performanceOperation || await requestCapture.promise;
    } finally {
      requestCapture.cancel();
    }
  }
  if (operation) {
    log?.(`Detected live ${operation.operation} operation.`);
    return operation;
  }
  throw new Error("X did not expose membersSliceTimeline_Query on the visible Members page.");
}

// This function is serialized by chrome.scripting and runs in the Members tab.
// Keep it self-contained: values from this module's scope are not available there.
async function readVisibleMembersAndScroll() {
  const state = globalThis.__communityActivityCollector ||= {
    members: {},
    pending: {},
    memberCount: 0,
    mutations: 0,
    installedAt: Date.now(),
  };
  state.pending ||= {};

  const rosterRows = () => {
    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
    return [...(primaryColumn || document).querySelectorAll('[data-testid="UserCell"]')];
  };

  const collect = () => rosterRows().forEach((row) => {
    const links = [...row.querySelectorAll('a[href^="/"]')];
    let username = "";
    for (const link of links) {
      const match = link.getAttribute("href")?.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
      if (match && !["i", "home", "explore", "notifications", "messages", "settings"].includes(match[1])) {
        username = match[1];
        break;
      }
    }
    if (!username) {
      username = [...row.querySelectorAll("span")]
        .map((node) => node.textContent?.trim())
        .find((text) => /^@[A-Za-z0-9_]{1,15}$/.test(text || ""))
        ?.slice(1) || "";
    }

    const text = row.textContent || "";
    const role = /\badmin\b/i.test(text)
      ? "Admin"
      : /\bmoderator\b|\bmod\b/i.test(text)
      ? "Moderator"
      : "Member";
    const name = row.querySelector('a[href^="/"] span')?.textContent?.trim() || username;
    const protectedIndicator = row.querySelector(
      '[aria-label*="Protected" i],[aria-label*="Private" i],[data-testid*="lock" i]'
    );
    if (username) {
      const key = username.toLowerCase();
      const member = {
        username,
        name,
        user_id: null,
        role,
        protected: protectedIndicator ? true : null,
        roleConfidence: role === "Member" ? "low" : "medium",
        source: "dom",
      };
      const previous = state.members[key];
      if (!previous || previous.role !== member.role || previous.protected !== member.protected) {
        if (!previous) state.memberCount++;
        state.members[key] = member;
        state.pending[key] = member;
      }
    }
  });

  if (!state.observer) {
    state.observer = new MutationObserver(() => {
      state.mutations++;
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }
  collect();

  const pageText = document.body?.innerText || "";
  const blocked = /log in to x|sign in to x|verify you are human|unusual activity/i.test(pageText);
  const transientError = /something went wrong|try reloading/i.test(pageText);
  if (transientError && Date.now() - (state.lastRetryAt || 0) > 4000) {
    const retryButton = [...document.querySelectorAll('button,[role="button"]')]
      .find((node) => /^(retry|reload|try again)$/i.test(node.textContent?.trim() || ""));
    if (retryButton) {
      state.lastRetryAt = Date.now();
      retryButton.click();
    }
  }
  const rows = rosterRows();
  const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
  const lastRow = rows.at(-1) || null;
  const rowAncestors = [];
  for (let node = lastRow?.parentElement; node && node !== document.body; node = node.parentElement) {
    rowAncestors.push(node);
  }
  const canScroll = (node) => {
    if (!node || node.scrollHeight <= node.clientHeight + 40) return false;
    if (node === document.scrollingElement || node === document.documentElement || node === document.body) return true;
    const overflowY = getComputedStyle(node).overflowY;
    return ["auto", "scroll", "overlay"].includes(overflowY);
  };
  const timelineScroller = rowAncestors.find(canScroll);
  const primaryScroller = (() => {
    for (let node = primaryColumn; node && node !== document.body; node = node.parentElement) {
      if (canScroll(node)) return node;
    }
    return null;
  })();
  const documentScroller = document.scrollingElement || document.documentElement;
  const scroller = timelineScroller || primaryScroller || documentScroller;
  const scrollTargets = [...new Set([timelineScroller, primaryScroller, documentScroller].filter(canScroll))];

  const before = scroller.scrollTop;
  // X loads the next virtualized slice when the last rendered row approaches
  // the viewport. Drive both that sentinel and the actual scroll container;
  // the redundant signals are intentional because X has used both window and
  // nested timeline scrollers across different responsive bundles.
  lastRow?.scrollIntoView({ block: "end", inline: "nearest", behavior: "auto" });
  const distance = Math.max(scroller.clientHeight * 0.9, window.innerHeight * 0.9, 600);
  for (const target of scrollTargets) {
    const targetDistance = Math.max(target.clientHeight * 0.9, distance);
    if (
      target === document.scrollingElement ||
      target === document.documentElement ||
      target === document.body
    ) {
      window.scrollBy({ top: targetDistance, behavior: "auto" });
      window.scrollTo({ top: documentScroller.scrollHeight, behavior: "auto" });
    } else {
      target.scrollBy({ top: targetDistance, behavior: "auto" });
      target.scrollTop = Math.min(target.scrollHeight, target.scrollTop + targetDistance);
    }
    target.dispatchEvent(new Event("scroll", { bubbles: true }));
  }
  window.dispatchEvent(new Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 80));
  // Collect once after X has had a chance to render the next virtualized slice.
  // Avoid querying the entire roster on every MutationObserver callback; X can
  // emit hundreds of unrelated mutations per second.
  collect();
  const pendingMembers = Object.values(state.pending);
  state.pending = {};
  return {
    members: pendingMembers,
    collectedTotal: state.memberCount,
    before,
    after: scroller.scrollTop,
    height: scroller.scrollHeight,
    atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8,
    ready: rows.length > 0,
    visibleRows: rows.length,
    blocked,
    transientError,
    mutations: state.mutations,
    visibilityState: document.visibilityState,
    documentHidden: document.hidden,
    documentFocused: document.hasFocus(),
    viewportHeight: window.innerHeight,
    scrollerTag: scroller?.tagName || null,
    scrollerRole: timelineScroller
      ? "row-ancestor"
      : primaryScroller
        ? "primary-ancestor"
        : "document",
    targetCount: scrollTargets.length,
  };
}

async function fetchMembersViaDom(
  communityId,
  {
    signal,
    log,
    onProgress,
    resumeMembers,
    onCheckpoint,
    expectedCount,
    existingTabId = null,
    lockForeground = false,
    maxPasses = Infinity,
    maxIdlePasses = MAX_IDLE_PASSES,
  } = {}
) {
  stopped(signal);
  let collected = mergeMemberLists([], resumeMembers || []).merged;
  let tabId;
  let windowId;
  let ownsCollector = false;

  try {
    if (existingTabId != null) {
      tabId = existingTabId;
      const tab = await chrome.tabs.get(tabId);
      windowId = tab.windowId;
      await chrome.tabs.update(tabId, {
        url: MEMBERS_URL(communityId),
        autoDiscardable: false,
        ...(lockForeground ? { active: true } : {}),
      });
      if (lockForeground) await keepTabForeground(tabId);
      log?.("Using the visible X tab as the Members collector. Keep the side panel open while the roster loads.");
    } else {
      const collector = await openForegroundMembersWindow(communityId);
      tabId = collector.tabId;
      windowId = collector.windowId;
      ownsCollector = true;
      lockForeground = true;
      log?.("Members collector opened in the foreground. It will stay focused until member collection finishes.");
    }
    await waitForTab(tabId, signal);
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: resetMembersCollector,
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: keepMembersPageRunning,
    });

    let idlePasses = 0;
    let noNewMemberPasses = 0;
    let pass = 0;
    let lastMutationCount = -1;
    let transientErrors = 0;
    let backgroundIdlePasses = 0;
    let stopReason = null;
    const startedAt = Date.now();
    while (idlePasses < maxIdlePasses && pass < maxPasses) {
      stopped(signal);
      if (lockForeground && (pass === 0 || pass % 5 === 0)) {
        await keepTabForeground(tabId);
      }
      if (Date.now() - startedAt > MAX_SCROLL_MS) {
        log?.("Browser scroll reached its 4-hour safety limit; keeping all members found so far.");
        stopReason = "dom-time-limit";
        break;
      }
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId },
        func: readVisibleMembersAndScroll,
      });
      if (execution?.error) throw new Error(execution.error.message || String(execution.error));
      const result = execution?.result;
      if (!result) throw new Error("Could not read the X Members page.");
      if (result.blocked) throw new Error("The X Members page shows a login or human-verification challenge.");
      if (result.transientError) {
        transientErrors++;
        if (transientErrors === 1 || transientErrors % 3 === 0) {
          log?.(`X showed a temporary Members-page error; retrying (${transientErrors}/12)…`);
        }
        if (transientErrors >= 12) {
          throw new Error(
            "X’s Members page kept returning ‘Something went wrong’ after 12 automatic retries. " +
            "Try GraphQL mode, or retry Browser Scroll later."
          );
        }
        await delay(POLL_MS * 2, signal);
        continue;
      }
      transientErrors = 0;

      const merged = mergeMemberLists(collected, result.members);
      collected = merged.merged;
      const added = merged.added;
      pass++;
      noNewMemberPasses = added === 0 ? noNewMemberPasses + 1 : 0;
      const noMovement = result.after === result.before && result.atBottom;
      const noMutation = result.mutations === lastMutationCount;
      idlePasses = added === 0 && noMovement && noMutation ? idlePasses + 1 : 0;
      if (!lockForeground && added === 0) {
        const liveTab = await chrome.tabs.get(tabId);
        const liveWindow = await chrome.windows.get(liveTab.windowId);
        if (liveTab.frozen === true) {
          stopReason = "tab-frozen";
          log?.("Chrome froze the Members tab; activate it before resuming DOM collection.");
          break;
        }
        const backgrounded = !liveTab.active || !liveWindow.focused || liveWindow.state === "minimized";
        backgroundIdlePasses = backgrounded ? backgroundIdlePasses + 1 : 0;
      } else {
        backgroundIdlePasses = 0;
      }
      lastMutationCount = result.mutations;
      onProgress?.({ type: "members-dom", count: collected.length, atBottom: result.atBottom });
      if (expectedCount && collected.length >= expectedCount) {
        log?.(`Known member total reached (${expectedCount.toLocaleString()}).`);
        stopReason = "expected-count-reached";
        break;
      }
      if (backgroundIdlePasses >= 3) {
        stopReason = "tab-throttled";
        log?.("The Members tab stopped advancing while backgrounded; keep it visible for DOM collection.");
        break;
      }
      if (noNewMemberPasses >= 30) {
        stopReason = "dom-stalled";
        log?.(
          "The visible Members roster produced no new usernames for 30 scroll passes; " +
          "stopping instead of looping indefinitely."
        );
        break;
      }
      if (pass % 5 === 0) {
        log?.(
          `Browser scroll ${pass}: ${collected.length.toLocaleString()} unique member(s); ` +
          `${result.scrollerRole || "unknown"} ${Math.round(result.before)}→${Math.round(result.after)} ` +
          `of ${Math.round(result.height)}px, ${result.visibleRows} row(s), ` +
          `${result.targetCount || 1} target(s).`
        );
        await onCheckpoint?.({ members: collected, complete: false, reason: "dom-in-progress" });
      }
      await delay(result.ready ? POLL_MS : POLL_MS * 2, signal);
    }

    if (!stopReason) {
      if (pass >= maxPasses) stopReason = "dom-reconciliation-limit";
      else if (idlePasses >= maxIdlePasses) stopReason = "dom-stalled";
      else stopReason = "dom-stopped";
    }
    const complete = stopReason === "expected-count-reached";
    await onCheckpoint?.({ members: collected, complete, reason: stopReason });
    log?.(`Browser scroll stopped (${stopReason}): ${collected.length.toLocaleString()} unique member(s).`);
    return {
      members: collected,
      complete,
      reason: stopReason,
      passes: pass,
    };
  } finally {
    if (ownsCollector && windowId != null) {
      try { await chrome.windows.remove(windowId); } catch (_) { /* already closed */ }
    }
  }
}

export function fetchMembersFromActiveTab(communityId, tabId, options = {}) {
  return fetchMembersViaDom(communityId, {
    ...options,
    existingTabId: tabId,
    lockForeground: options.lockForeground !== false,
  });
}

export function mergeMemberLists(primary = [], supplemental = []) {
  const merged = [];
  const byId = new Map();
  const byUsername = new Map();
  for (const member of [...primary, ...supplemental]) {
    if (!member?.username) continue;
    const idKey = member.user_id ? String(member.user_id) : null;
    const usernameKey = member.username.toLowerCase();
    const existingIndex = (idKey && byId.get(idKey)) ?? byUsername.get(usernameKey);
    if (existingIndex == null) {
      const index = merged.length;
      merged.push(member);
      if (idKey) byId.set(idKey, index);
      byUsername.set(usernameKey, index);
      continue;
    }
    const existing = merged[existingIndex];
    // Prefer GraphQL metadata (notably user_id), filling only missing values.
    const evidenceRank = {
      "historical-community-post": 1,
      "recent-community-post": 2,
      "x-roster": 3,
    };
    const existingEvidence = existing.membershipEvidence || null;
    const incomingEvidence = member.membershipEvidence || null;
    const incomingEvidenceIsStronger =
      (evidenceRank[incomingEvidence] || 0) > (evidenceRank[existingEvidence] || 0);
    const membershipEvidence =
      incomingEvidenceIsStronger
        ? incomingEvidence
        : existingEvidence;
    const replacement = {
      ...member,
      ...existing,
      user_id: existing.user_id || member.user_id || null,
      role: existing.role !== "Member" ? existing.role : member.role || existing.role,
      roleConfidence: existing.roleConfidence === "high" ? "high" : member.roleConfidence || existing.roleConfidence,
      source: "hybrid",
      membershipEvidence,
      protected: typeof member.protected === "boolean" &&
        (incomingEvidenceIsStronger || typeof existing.protected !== "boolean")
        ? member.protected
        : existing.protected,
    };
    merged[existingIndex] = replacement;
    if (replacement.user_id) byId.set(String(replacement.user_id), existingIndex);
    byUsername.set(replacement.username.toLowerCase(), existingIndex);
    byUsername.set(usernameKey, existingIndex);
  }
  const primarySize = mergeMemberListsUniqueCount(primary);
  return { merged, added: Math.max(0, merged.length - primarySize) };
}

function mergeMemberListsUniqueCount(members) {
  const ids = new Set();
  const usernames = new Set();
  let count = 0;
  for (const member of members) {
    if (!member?.username) continue;
    const idKey = member.user_id ? String(member.user_id) : null;
    const usernameKey = member.username.toLowerCase();
    if ((idKey && ids.has(idKey)) || usernames.has(usernameKey)) continue;
    if (idKey) ids.add(idKey);
    usernames.add(usernameKey);
    count++;
  }
  return count;
}
