// Turns a sliding window of progress samples from the activity scan into a
// throughput/ETA estimate - kept as a pure function of the sample window
// (not a stateful class holding the window itself) so the actual state
// management stays in sidepanel.js, next to the rest of its scan-progress
// bookkeeping, and this stays trivially testable.
//
// The estimate is deliberately based on a moving average over the window
// (recommended: the last 25-50 samples), not a single most-recent sample:
// posting density varies a lot across a real Community's history (a quiet
// stretch, then a burst), so one page's rate is a poor predictor of the
// pages still needed to reach the target boundary.

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// `samples` is an array of { atMs, pages, oldestSeenAtMs }, oldest first -
// atMs is wall-clock time the sample was recorded, pages is the
// cumulative page count so far, oldestSeenAtMs is fetchActiveAuthors'
// oldestSeenAt at that point. `targetSinceMs` is the requested window
// boundary (calendarActivityWindow's sinceDate).
export function estimateActivityThroughput(samples, targetSinceMs) {
  const clean = (samples || []).filter(
    (sample) => Number.isFinite(sample?.atMs) && Number.isFinite(sample?.pages) && Number.isFinite(sample?.oldestSeenAtMs)
  );
  if (clean.length < 2) return null;

  const first = clean[0];
  const last = clean[clean.length - 1];
  const elapsedMs = last.atMs - first.atMs;
  const pagesInWindow = last.pages - first.pages;
  // The walk moves backward in time as it pages, so this is normally
  // negative or zero; a positive value (the walk somehow moved forward)
  // means the window can't be trusted for an estimate.
  const daysMovedBack = (first.oldestSeenAtMs - last.oldestSeenAtMs) / MS_PER_DAY;

  if (elapsedMs <= 0 || pagesInWindow <= 0 || daysMovedBack <= 0) return null;

  const pagesPerMinute = pagesInWindow / (elapsedMs / MS_PER_MINUTE);
  const daysCoveredPerPage = daysMovedBack / pagesInWindow;
  const daysRemaining = Math.max(0, (last.oldestSeenAtMs - targetSinceMs) / MS_PER_DAY);

  if (daysRemaining === 0) {
    return { pagesPerMinute, daysCoveredPerPage, daysRemaining: 0, estimatedPagesRemaining: 0, estimatedMinutesRemaining: 0 };
  }

  const estimatedPagesRemaining = daysRemaining / daysCoveredPerPage;
  const estimatedMinutesRemaining = pagesPerMinute > 0 ? estimatedPagesRemaining / pagesPerMinute : null;

  return {
    pagesPerMinute,
    daysCoveredPerPage,
    daysRemaining,
    estimatedPagesRemaining,
    estimatedMinutesRemaining,
  };
}

// A fixed-size FIFO the caller pushes samples into - the "last 25-50
// samples" moving-average window, as a tiny reusable structure instead of
// hand-rolled array-splicing at every call site.
export function pushSample(window, sample, maxSamples = 40) {
  const next = [...window, sample];
  return next.length > maxSamples ? next.slice(next.length - maxSamples) : next;
}
