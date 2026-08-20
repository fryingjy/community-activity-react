// The toolbar button opens the complete lightweight scanner beside X.
// No network recorder, remote API token, or background collector is used.
async function configureExtension() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  // Scan checkpoints contain member data. Keep extension storage unavailable
  // to any content script that may be added in a future release.
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.storage.session?.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
}

chrome.runtime.onInstalled.addListener(() => {
  configureExtension().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  configureExtension().catch(() => {});
});

async function openDashboard() {
  const dashboardUrl = chrome.runtime.getURL("sidepanel.html?mode=dashboard");
  const existing = await chrome.tabs.query({});
  const dashboard = existing.find((tab) => String(tab.url || "").includes("mode=dashboard"));
  if (dashboard?.id != null && dashboard.windowId != null) {
    await chrome.windows.update(dashboard.windowId, { focused: true });
    await chrome.tabs.update(dashboard.id, { active: true });
    return { opened: true, reused: true };
  }
  await chrome.tabs.create({
    url: dashboardUrl,
    active: true,
  });
  return { opened: true, reused: false };
}

const SCAN_LEASE_KEY = "communityActivityScanLease";
let scanLeaseQueue = Promise.resolve();

function scanLeaseStore() {
  // The lease only coordinates live extension pages. Keeping it in session
  // storage avoids persisting transient ownership state alongside durable
  // scan checkpoints, while preserving a fallback for test doubles.
  return chrome.storage.session || chrome.storage.local;
}

async function handleScanLease(message) {
  const owner = String(message.owner || "");
  if (!owner) return { acquired: false, error: "Missing scan owner." };
  const now = Date.now();
  const ttl = Math.max(15_000, Math.min(Number(message.ttl) || 45_000, 120_000));
  const storage = scanLeaseStore();
  const stored = await storage.get(SCAN_LEASE_KEY);
  const lease = stored[SCAN_LEASE_KEY] || null;

  if (message.type === "ACQUIRE_SCAN_LEASE") {
    if (lease?.owner && lease.owner !== owner && lease.expiresAt > now) {
      return { acquired: false, lease: { mode: lease.mode, expiresAt: lease.expiresAt } };
    }
    const nextLease = {
      owner,
      mode: String(message.mode || "another interface"),
      startedAt: lease?.owner === owner ? lease.startedAt : now,
      expiresAt: now + ttl,
    };
    await storage.set({ [SCAN_LEASE_KEY]: nextLease });
    return { acquired: true, lease: nextLease };
  }

  if (message.type === "RENEW_SCAN_LEASE") {
    if (lease?.owner !== owner) return { renewed: false };
    const nextLease = { ...lease, expiresAt: now + ttl };
    await storage.set({ [SCAN_LEASE_KEY]: nextLease });
    return { renewed: true };
  }

  if (message.type === "RELEASE_SCAN_LEASE") {
    if (lease?.owner === owner) await storage.remove(SCAN_LEASE_KEY);
    return { released: lease?.owner === owner };
  }

  return null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const supported = new Set([
    "OPEN_DASHBOARD",
    "ACQUIRE_SCAN_LEASE",
    "RENEW_SCAN_LEASE",
    "RELEASE_SCAN_LEASE",
  ]);
  if (!supported.has(message?.type)) return false;
  const action = message.type === "OPEN_DASHBOARD"
    ? openDashboard()
    : (scanLeaseQueue = scanLeaseQueue
        .catch(() => {})
        .then(() => handleScanLease(message)));
  action.then(sendResponse, (error) => {
    sendResponse({ error: error?.message || "Extension action failed." });
  });
  return true;
});
