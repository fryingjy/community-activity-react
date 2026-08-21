import { ResumePanel } from "./ResumePanel.jsx";

// Real evidence-tier distribution, not an invented risk score: every flagged
// row already carries activityVerification from the classification pipeline
// (see src/activity/classification.js and classifySearchVerification) - this
// is a truthful visualization of exactly that, nothing inferred beyond it.
function evidenceBreakdown(results) {
  const counts = { "confirmed-inactive": 0, unverified: 0, "unverifiable-protected": 0 };
  for (const row of results) {
    const tier = row.activityVerification || "unverified";
    counts[tier] = (counts[tier] || 0) + 1;
  }
  const total = results.length || 1;
  return [
    { key: "confirmed-inactive", label: "Confirmed inactive", tone: "success", count: counts["confirmed-inactive"] },
    { key: "unverified", label: "Unverified", tone: "warning", count: counts.unverified },
    { key: "unverifiable-protected", label: "Unverifiable (protected)", tone: "muted", count: counts["unverifiable-protected"] },
  ].map((row) => ({ ...row, pct: (row.count / total) * 100 }));
}

export function OverviewView({ state, onStartScan }) {
  const breakdown = evidenceBreakdown(state.results);
  const hasResults = state.results.length > 0 || state.resultsPanelVisible;
  const hasEverScanned = hasResults || state.progressVisible || state.resumeJob;

  return (
    <div className="view">
      <ResumePanel job={state.resumeJob} />

      {!hasEverScanned && (
        <section className="card empty-state">
          <span className="kicker">Overview</span>
          <h2>No scan yet</h2>
          <p>Point this at an X Community to find members with zero posts or replies in a chosen window - confirmed with a direct search, not just inferred from a broad crawl.</p>
          <button type="button" className="primary" onClick={onStartScan}>
            <span>Start a new scan</span>
            <i aria-hidden="true">→</i>
          </button>
        </section>
      )}

      {hasResults && (
        <section className="card scan-report-header">
          <div className="card-heading">
            <div>
              <span className="kicker">Community scan</span>
              <h2 title={state.contextTitle || undefined}>{state.contextLabel}</h2>
            </div>
            <span className={`live-badge${state.badgeClass ? ` ${state.badgeClass}` : ""}`}>
              <i aria-hidden="true" />
              {state.phaseStage === "complete" ? "Scan complete" : state.badgeLabel}
            </span>
          </div>

          <div className="report-stats">
            <div>
              <strong className="tabular">{state.expectedMembers?.toLocaleString() || state.membersFound.toLocaleString()}</strong>
              <span>Members</span>
            </div>
            <div>
              <strong className="tabular">{state.results.length.toLocaleString()}</strong>
              <span>Flagged</span>
            </div>
            <div>
              <strong className="tabular">{breakdown[0].count.toLocaleString()}</strong>
              <span>Confirmed</span>
            </div>
            <div className={state.coveragePercent != null && state.coveragePercent < 99.5 ? "is-coverage partial" : "is-coverage"}>
              <strong className="tabular">{state.coveragePercent == null ? "—" : `${state.coveragePercent.toFixed(1)}%`}</strong>
              <span>Coverage</span>
            </div>
          </div>

          {state.results.length > 0 && (
            <div className="evidence-distribution">
              <span className="kicker">Evidence distribution</span>
              <div className="evidence-bar" role="img" aria-label="Flagged member evidence tier distribution">
                {breakdown.filter((row) => row.count > 0).map((row) => (
                  <span key={row.key} className={`evidence-bar-seg tone-${row.tone}`} style={{ width: `${row.pct}%` }} />
                ))}
              </div>
              <ul className="evidence-legend">
                {breakdown.map((row) => (
                  <li key={row.key}>
                    <i className={`tone-${row.tone}`} aria-hidden="true" />
                    {row.label} <strong className="tabular">{row.count.toLocaleString()}</strong>
                    <span className="tabular">{row.pct.toFixed(0)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="report-summary">{state.resultSummary}</p>
        </section>
      )}
    </div>
  );
}
