export function createMemberStore(seed = []) {
  const members = [];
  const byId = new Map();
  const byUsername = new Map();
  const upsert = (member) => {
    if (!member?.username) return false;
    const idKey = member.user_id ? String(member.user_id) : null;
    const usernameKey = member.username.toLowerCase();
    const index = (idKey && byId.get(idKey)) ?? byUsername.get(usernameKey);
    if (index == null) {
      const nextIndex = members.length;
      members.push(member);
      if (idKey) byId.set(idKey, nextIndex);
      byUsername.set(usernameKey, nextIndex);
      return true;
    }
    const previous = members[index];
    // Unlike mergeMemberLists (which merges distinct sources of differing
    // trust and deliberately keeps the higher-trust side), this store only
    // ever merges pages of the same roster source across time — a resumed
    // checkpoint can be hours old, so the incoming page should win for any
    // field (e.g. protected, name) that may have changed since. user_id and
    // a confirmed role are still sticky once known.
    const replacement = {
      ...previous,
      ...member,
      user_id: previous.user_id || member.user_id || null,
      role: previous.role !== "Member" ? previous.role : member.role,
    };
    members[index] = replacement;
    if (replacement.user_id) byId.set(String(replacement.user_id), index);
    byUsername.set(replacement.username.toLowerCase(), index);
    byUsername.set(usernameKey, index);
    return false;
  };
  for (const member of seed) upsert(member);
  return { members, upsert };
}
