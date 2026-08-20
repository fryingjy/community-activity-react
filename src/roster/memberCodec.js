// Compact array-tuple encoding for member records in chrome.storage.local, used
// both by roster checkpoint pages and the membership-verification pending
// queue. An array is smaller on disk than a repeated-key object per row.
export function packMember(member) {
  return [
    member.username,
    member.name || member.username,
    member.user_id || null,
    member.role || "Member",
    member.protected === true ? 1 : member.protected === false ? 0 : null,
  ];
}

export function unpackMember(row) {
  return {
    username: row[0],
    name: row[1] || row[0],
    user_id: row[2] || null,
    role: row[3] || "Member",
    protected: row[4] === 1 ? true : row[4] === 0 ? false : null,
    roleConfidence: "high",
    source: "cursor-checkpoint",
  };
}
