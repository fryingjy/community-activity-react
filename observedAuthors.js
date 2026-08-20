const SCHEMA = 1;

function storageKey(communityId) {
  return `observedCommunityAuthors:${communityId}`;
}

function identity(record) {
  return {
    id: record?.user_id ? String(record.user_id) : null,
    username: String(record?.username || "").toLowerCase(),
  };
}

export function mergeObservedAuthorRecords(existing = [], recent = []) {
  const records = [];
  const byId = new Map();
  const byUsername = new Map();

  const upsert = (record, isRecent) => {
    if (!record?.username) return;
    const key = identity(record);
    const index = (key.id && byId.get(key.id)) ?? byUsername.get(key.username);
    const seenAt = record.lastSeenCommunityPost || record.lastSeenAt || null;

    if (index == null) {
      const next = {
        username: record.username,
        name: record.name || record.username,
        user_id: key.id,
        protected: typeof record.protected === "boolean" ? record.protected : null,
        firstSeenAt: record.firstSeenAt || seenAt,
        lastSeenAt: seenAt,
        observedPosts: Math.max(0, Number(record.observedPosts ?? record.count) || 0),
      };
      const nextIndex = records.length;
      records.push(next);
      if (key.id) byId.set(key.id, nextIndex);
      byUsername.set(key.username, nextIndex);
      return;
    }

    const previous = records[index];
    const previousLast = previous.lastSeenAt ? Date.parse(previous.lastSeenAt) : 0;
    const incomingLast = seenAt ? Date.parse(seenAt) : 0;
    const useIncomingProfile = isRecent || incomingLast >= previousLast;
    const next = {
      ...previous,
      username: useIncomingProfile ? record.username : previous.username,
      name: useIncomingProfile ? (record.name || record.username) : previous.name,
      user_id: previous.user_id || key.id,
      protected: typeof record.protected === "boolean" && useIncomingProfile
        ? record.protected
        : previous.protected,
      firstSeenAt: [previous.firstSeenAt, record.firstSeenAt || seenAt]
        .filter(Boolean)
        .sort()[0] || null,
      lastSeenAt: [previous.lastSeenAt, seenAt]
        .filter(Boolean)
        .sort()
        .at(-1) || null,
      // Lookback windows overlap, so summing counts would count the same posts
      // repeatedly. Keep the largest directly observed window count instead.
      observedPosts: Math.max(
        Number(previous.observedPosts) || 0,
        isRecent ? Math.max(0, Number(record.count) || 0) : 0
      ),
    };
    records[index] = next;
    if (next.user_id) byId.set(String(next.user_id), index);
    byUsername.set(next.username.toLowerCase(), index);
    byUsername.set(key.username, index);
  };

  for (const record of existing) upsert(record, false);
  for (const record of recent) upsert(record, true);
  return records;
}

function pack(record) {
  return [
    record.username,
    record.name || record.username,
    record.user_id || null,
    record.protected === true ? 1 : record.protected === false ? 0 : null,
    record.firstSeenAt || null,
    record.lastSeenAt || null,
    Number(record.observedPosts) || 0,
  ];
}

function unpack(row) {
  return {
    username: row[0],
    name: row[1] || row[0],
    user_id: row[2] || null,
    protected: row[3] === 1 ? true : row[3] === 0 ? false : null,
    firstSeenAt: row[4] || null,
    lastSeenAt: row[5] || null,
    observedPosts: Number(row[6]) || 0,
  };
}

async function loadObservedCommunityAuthors(communityId) {
  const key = storageKey(communityId);
  const stored = await chrome.storage.local.get(key);
  const value = stored[key];
  if (!value || value.schema !== SCHEMA || !Array.isArray(value.rows)) return [];
  return value.rows.map(unpack).filter((record) => record.username);
}

export async function rememberCommunityAuthors(communityId, recentAuthors) {
  const existing = await loadObservedCommunityAuthors(communityId);
  const merged = mergeObservedAuthorRecords(existing, recentAuthors);
  await chrome.storage.local.set({
    [storageKey(communityId)]: {
      schema: SCHEMA,
      updatedAt: Date.now(),
      rows: merged.map(pack),
    },
  });
  return merged;
}

export function observedAuthorToMember(record) {
  return {
    username: record.username,
    name: record.name || record.username,
    user_id: record.user_id || null,
    role: "Member",
    protected: typeof record.protected === "boolean" ? record.protected : null,
    roleConfidence: "low",
    source: "community-post-history",
    membershipEvidence: "historical-community-post",
    lastSeenCommunityPost: record.lastSeenAt || null,
  };
}

export function activeAuthorToMember(record) {
  return {
    username: record.username,
    name: record.name || record.username,
    user_id: record.user_id || null,
    role: "Member",
    protected: typeof record.protected === "boolean" ? record.protected : null,
    roleConfidence: "medium",
    source: "community-post",
    membershipEvidence: "recent-community-post",
    lastSeenCommunityPost: record.lastSeenCommunityPost || null,
  };
}
