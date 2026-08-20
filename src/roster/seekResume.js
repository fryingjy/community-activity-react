// A page that adds nothing is not on its own proof that the roster ended: X
// serves overlapping pages, and the measured native walk averaged about 91
// unique records per 100-record page. Ending the crawl on the first such page
// discards the remaining roster and caches the truncation as terminal, so
// duplicate-only pages are tolerated while the server cursor keeps advancing.
export const MAX_IDLE_ROSTER_PAGES = 3;

// Re-seeking lands slightly behind the last position so a member sitting exactly
// on the boundary is not stepped over. The overlap costs a fraction of a page.
export const SEEK_RESUME_OVERLAP_MS = 2000;
export const SEEK_RESUME_MAX_SEGMENTS = 240;
// A resumed segment opens inside the overlap window above, so its first pages
// legitimately return members already held. Judging a segment before it clears
// that window ends the walk at the very cap seek-resume exists to defeat.
export const SEEK_RESUME_MIN_SEGMENT_PAGES = 5;
// Only consecutive fully-tried segments that find nobody mean the roster is
// genuinely saturated. A dead zone is crossed by doubling the skip below, so
// this many idle segments spans months, not hours.
export const SEEK_RESUME_MAX_IDLE_SEGMENTS = 9;
// A duplicate-only run is the expected cost of re-entering collected ground on
// the way to ground that is not collected yet, so during a seek-resume walk it
// must not end the chain: crossing a re-walked region took about 350 pages in a
// modelled roster, and the plain three-page limit stops the walk partway across
// and strands everyone beyond it.
//
// The bound is deliberate rather than infinite. X caps one chain at 500 pages,
// so a chain can never contain more than 500 idle pages; anything above that is
// provably enough to cross any re-walked region, while still stopping a
// pathological chain that keeps serving duplicates from spending the whole
// 10,000-page budget on the signed-in account.
export const SEEK_RESUME_IDLE_PAGE_LIMIT = 600;

// A chain can stall three ways and all three mean the chain ended, not the
// roster: X withholds the next cursor at its page cap, the walk re-enters
// ground it already holds and stops adding, or the cursor repeats. Treating
// only the first as resumable is what left a seek-resume run stranded far below
// the advertised count, because the first duplicate-heavy stretch after a
// re-seek ended the whole walk.
export function shouldResumeChain({
  seekResume = false,
  cursorEnded = false,
  reason = null,
  memberCount = 0,
  expectedCount = null,
  lastTimestamp = null,
} = {}) {
  if (!seekResume || lastTimestamp == null) return false;
  const stalled = cursorEnded ||
    reason === "no-new-members" ||
    reason === "repeated-cursor";
  if (!stalled) return false;
  // An unknown total is a reason to keep going, not to stop: requiring one let
  // a failed analytics call (50 requests per window) disable seek-resume.
  return !expectedCount || memberCount < expectedCount;
}

export function resolveRosterStopReason({
  idlePages = 0,
  idleLimit = MAX_IDLE_ROSTER_PAGES,
  repeatedCursor = false,
  cursorEnded = false,
  memberCount = 0,
  expectedCount = null,
} = {}) {
  if (idlePages >= idleLimit) return "no-new-members";
  if (repeatedCursor) return "repeated-cursor";
  if (expectedCount && memberCount >= expectedCount) return "expected-count-reached";
  if (cursorEnded) {
    return expectedCount && memberCount < expectedCount
      ? "cursor-ended-before-count"
      : "cursor-ended";
  }
  return null;
}
