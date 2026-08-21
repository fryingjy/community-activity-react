import { useEffect, useRef } from "react";

// React's keyed reconciliation already solves "don't re-animate rows that
// didn't change" for free, as long as keys are stable (log entries carry a
// real incrementing id - see scanEngine.js's log()) - that was the whole
// reason a hand-rolled appendLogEntry() existed in the pre-React version.
// The one thing React doesn't do automatically is preserve scroll position
// when new rows arrive: this hook restores the "pinned to bottom unless the
// reader scrolled up to read something" behavior the original had.
function useLogAutoScroll(listRef, logLines) {
  const pinnedRef = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [logLines, listRef]);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  return handleScroll;
}

export function ScanLog({ logLines }) {
  const listRef = useRef(null);
  const handleScroll = useLogAutoScroll(listRef, logLines);

  return (
    <details className="activity-log">
      <summary>
        <span>Scan activity</span>
        <small>{logLines.length} {logLines.length === 1 ? "event" : "events"}</small>
      </summary>
      <ol ref={listRef} className="scan-log" role="log" aria-live="off" onScroll={handleScroll}>
        {logLines.map((entry) => (
          <li key={entry.id} className={`log-entry ${entry.level}`}>
            <span className="log-time">{entry.time}</span>
            <i className="log-dot" aria-hidden="true" />
            <span className="log-message">{entry.message}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
