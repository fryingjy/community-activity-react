import { createMemberStore } from "./memberStore.js";
import { packMember, unpackMember } from "./memberCodec.js";

// Bumped to 3 in 5.10.1, when the collector could not read the native roster
// response and recorded "terminal, 0 members"; bumped to 4 in 5.12.1, when a
// broken seek-resume recorded "complete, 46,951 of 79,397". Both would be
// replayed on the next scan — a complete checkpoint for twelve hours — and so
// this schema bump exists purely to invalidate every checkpoint written before
// the fix, rather than to describe a real format change.
export const CURSOR_CHECKPOINT_SCHEMA = 4;
export const COMPLETE_CHECKPOINT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const PARTIAL_CHECKPOINT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function checkpointMetaKey(communityId, scope = "web") {
  return scope === "web"
    ? `cursorRoster:${communityId}:meta`
    : `cursorRoster:${scope}:${communityId}:meta`;
}

export function checkpointPageKey(communityId, generation, page, scope = "web") {
  return scope === "web"
    ? `cursorRoster:${communityId}:${generation}:page:${page}`
    : `cursorRoster:${scope}:${communityId}:${generation}:page:${page}`;
}

export async function removeCheckpointPages(communityId, meta, scope = "web") {
  if (!meta?.generation || !meta?.pageCount) return;
  const keys = Array.from(
    { length: meta.pageCount },
    (_, index) => checkpointPageKey(communityId, meta.generation, index + 1, scope)
  );
  if (keys.length) await chrome.storage.local.remove(keys);
}

export async function loadCursorCheckpoint(communityId, scope = "web") {
  const metaKey = checkpointMetaKey(communityId, scope);
  const stored = await chrome.storage.local.get(metaKey);
  const meta = stored[metaKey];
  if (!meta || meta.schema !== CURSOR_CHECKPOINT_SCHEMA) return null;
  const pageKeys = Array.from(
    { length: meta.pageCount || 0 },
    (_, index) => checkpointPageKey(communityId, meta.generation, index + 1, scope)
  );
  const pages = pageKeys.length ? await chrome.storage.local.get(pageKeys) : {};
  const store = createMemberStore();
  for (const key of pageKeys) {
    for (const row of pages[key]?.rows || []) {
      const member = unpackMember(row);
      store.upsert(member);
    }
  }
  return { meta, members: store.members };
}

export async function startFreshCursorCheckpoint(communityId, previousMeta, scope = "web") {
  await removeCheckpointPages(communityId, previousMeta, scope);
  return {
    schema: CURSOR_CHECKPOINT_SCHEMA,
    communityId,
    generation: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    pageCount: 0,
    nextCursor: null,
    complete: false,
    terminal: false,
    reason: null,
    updatedAt: Date.now(),
  };
}

export async function saveCursorPage(communityId, meta, cursorIn, nextCursor, members, scope = "web") {
  const page = meta.pageCount + 1;
  const pageKey = checkpointPageKey(communityId, meta.generation, page, scope);
  const nextMeta = {
    ...meta,
    pageCount: page,
    nextCursor,
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({
    [pageKey]: {
      cursorIn,
      nextCursor,
      rows: members.map(packMember),
    },
    [checkpointMetaKey(communityId, scope)]: nextMeta,
  });
  return nextMeta;
}
