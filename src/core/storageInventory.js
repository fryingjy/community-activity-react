// Every chrome.storage.local key this extension writes embeds the
// Community ID as one full colon-delimited segment of the key itself -
// cursorRoster:<id>:meta, activityScan:<id>:<since>:<obsSince>:<until>,
// communityTimelineBackfill:<id>, communitySearchBackfill:<id>:<shard>,
// membershipVerification:<id>, activitySearchVerification:<id>,
// confirmedMemberArchive:<id>, observedCommunityAuthors:<id>, and the
// roster checkpoint's page keys - verified against every checkpoint/cache
// module's own key-builder function (rosterCheckpoint.js,
// timelineCollector.js, timelineBackfill.js, mediaCollector.js,
// searchDiscovery.js, membershipVerification.js, directVerification.js,
// memberArchive.js, observedAuthors.js). That makes "which keys belong to
// this Community" one general rule instead of a hand-maintained prefix list
// that silently falls out of sync the next time a module adds a new key
// shape.
//
// The one exception is liteScanJob: a single global key (no Community ID in
// the key name itself, only as a field inside its value), because only one
// scan job is ever remembered at a time regardless of Community.
// liteScanSettings is also global (form preferences) and never
// Community-specific data to begin with.

const GLOBAL_ONLY_KEYS = new Set(["liteScanSettings"]);

export function keyBelongsToCommunity(key, communityId) {
  if (!key || !communityId) return false;
  return key.split(":").includes(String(communityId));
}

// `allEntries` is the plain object chrome.storage.local.get(null) returns.
// Pure by design: the caller does the actual chrome.storage.local calls,
// this only decides which keys those calls should target.
export function computeCommunityStorageKeys(allEntries, communityId) {
  const keys = [];
  for (const key of Object.keys(allEntries || {})) {
    if (GLOBAL_ONLY_KEYS.has(key)) continue;
    if (key === "liteScanJob") {
      if (allEntries[key]?.communityId === String(communityId)) keys.push(key);
      continue;
    }
    if (keyBelongsToCommunity(key, communityId)) keys.push(key);
  }
  return keys;
}

function entryByteSize(key, value) {
  return key.length + JSON.stringify(value ?? null).length;
}

// A deterministic, testable fallback estimate for when the real
// chrome.storage.local.getBytesInUse() figure isn't being shown alongside
// it - chrome.storage's actual on-disk accounting isn't just
// JSON.stringify's length, so this is a lower bound, not a promise of
// byte-exact agreement with Chrome's own number.
export function estimateStorageBytes(allEntries) {
  let bytes = 0;
  for (const [key, value] of Object.entries(allEntries || {})) {
    bytes += entryByteSize(key, value);
  }
  return bytes;
}

// Discovers which Communities have saved data at all, without being told
// one up front - for the "Saved Communities: 4" overview. Community IDs are
// always purely numeric and no other segment in any key shape here is, so
// "the first all-digit segment" reliably identifies it without needing a
// second, separately-maintained parser per key shape.
export function summarizeStorageByCommunity(allEntries) {
  const byCommunity = new Map();
  for (const [key, value] of Object.entries(allEntries || {})) {
    let communityId = null;
    if (key === "liteScanJob") {
      communityId = value?.communityId || null;
    } else if (!GLOBAL_ONLY_KEYS.has(key)) {
      communityId = key.split(":").find((segment) => /^\d+$/.test(segment)) || null;
    }
    if (!communityId) continue;
    const entry = byCommunity.get(communityId) || { communityId, keys: 0, bytes: 0 };
    entry.keys += 1;
    entry.bytes += entryByteSize(key, value);
    byCommunity.set(communityId, entry);
  }
  return [...byCommunity.values()].sort((left, right) => right.bytes - left.bytes);
}
