const ARCHIVE_SCHEMA = 1;
const MAX_SNAPSHOTS = 30;

function archiveKey(communityId) {
  return `confirmedMemberArchive:${communityId}`;
}

function discoverySource(member) {
  if (member?.source === "relationship-verification") return "activity_verification";
  if (member?.source === "moderator-surface") return "moderator_surface";
  if (member?.source === "about-surface") return "about_surface";
  if (member?.source === "import") return "import";
  return "direct_roster";
}

export function mergeConfirmedMemberArchive(
  existing = [],
  confirmedMembers = [],
  {
    observedAt = new Date().toISOString(),
    snapshotId = observedAt,
  } = {}
) {
  const records = [];
  const byId = new Map();
  const byUsername = new Map();

  const indexRecord = (record, index) => {
    if (record.user_id) byId.set(String(record.user_id), index);
    if (record.username) byUsername.set(record.username.toLowerCase(), index);
  };

  for (const record of existing || []) {
    if (!record?.username) continue;
    const next = {
      ...record,
      discoverySources: [...new Set(record.discoverySources || [])],
      sightings: Math.max(1, Number(record.sightings) || 1),
    };
    const index = records.length;
    records.push(next);
    indexRecord(next, index);
  }

  let added = 0;
  let updated = 0;
  for (const member of confirmedMembers || []) {
    if (!member?.username || member.membershipEvidence !== "x-roster") continue;
    const id = member.user_id ? String(member.user_id) : null;
    const usernameKey = member.username.toLowerCase();
    const index = (id && byId.get(id)) ?? byUsername.get(usernameKey);
    const source = discoverySource(member);
    if (index == null) {
      const record = {
        username: member.username,
        name: member.name || member.username,
        user_id: id,
        role: member.role || "Member",
        protected: typeof member.protected === "boolean" ? member.protected : null,
        firstConfirmedAt: observedAt,
        lastConfirmedAt: observedAt,
        lastSnapshotId: snapshotId,
        sightings: 1,
        discoverySources: [source],
      };
      const nextIndex = records.length;
      records.push(record);
      indexRecord(record, nextIndex);
      added++;
      continue;
    }

    const previous = records[index];
    const next = {
      ...previous,
      username: member.username,
      name: member.name || member.username,
      user_id: previous.user_id || id,
      role: member.role || previous.role || "Member",
      protected: typeof member.protected === "boolean"
        ? member.protected
        : previous.protected,
      lastConfirmedAt: observedAt,
      lastSnapshotId: snapshotId,
      sightings: Math.max(1, Number(previous.sightings) || 1) + 1,
      discoverySources: [...new Set([...(previous.discoverySources || []), source])],
    };
    records[index] = next;
    indexRecord(next, index);
    byUsername.set(usernameKey, index);
    updated++;
  }

  return { records, added, updated };
}

function pack(record) {
  return [
    record.username,
    record.name || record.username,
    record.user_id || null,
    record.role || "Member",
    record.protected === true ? 1 : record.protected === false ? 0 : null,
    record.firstConfirmedAt || null,
    record.lastConfirmedAt || null,
    record.lastSnapshotId || null,
    Number(record.sightings) || 1,
    record.discoverySources || [],
  ];
}

function unpack(row) {
  return {
    username: row[0],
    name: row[1] || row[0],
    user_id: row[2] || null,
    role: row[3] || "Member",
    protected: row[4] === 1 ? true : row[4] === 0 ? false : null,
    firstConfirmedAt: row[5] || null,
    lastConfirmedAt: row[6] || null,
    lastSnapshotId: row[7] || null,
    sightings: Number(row[8]) || 1,
    discoverySources: Array.isArray(row[9]) ? row[9] : [],
  };
}

export async function rememberConfirmedMembers(
  communityId,
  confirmedMembers,
  {
    expectedCount = null,
    stopReason = null,
    observedAt = new Date().toISOString(),
  } = {}
) {
  const key = archiveKey(communityId);
  const stored = (await chrome.storage.local.get(key))[key];
  const existing = stored?.schema === ARCHIVE_SCHEMA && Array.isArray(stored.rows)
    ? stored.rows.map(unpack)
    : [];
  const snapshotId = `${Date.parse(observedAt) || Date.now()}:${confirmedMembers.length}`;
  const merged = mergeConfirmedMemberArchive(existing, confirmedMembers, {
    observedAt,
    snapshotId,
  });
  const snapshots = [
    ...(Array.isArray(stored?.snapshots) ? stored.snapshots : []),
    {
      id: snapshotId,
      observedAt,
      confirmed: confirmedMembers.length,
      expected: Number.isFinite(expectedCount) ? expectedCount : null,
      stopReason: stopReason || null,
    },
  ].slice(-MAX_SNAPSHOTS);
  await chrome.storage.local.set({
    [key]: {
      schema: ARCHIVE_SCHEMA,
      updatedAt: Date.now(),
      rows: merged.records.map(pack),
      snapshots,
    },
  });
  const sourceCounts = {};
  for (const record of merged.records) {
    for (const source of record.discoverySources) {
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    }
  }
  return {
    uniqueConfirmed: merged.records.length,
    added: merged.added,
    updated: merged.updated,
    sourceCounts,
    snapshotCount: snapshots.length,
  };
}
