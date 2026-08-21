import { Fragment } from "react";
import { exportDiagnostics } from "../scanEngine.js";
import { ScanLog } from "./ScanLog.jsx";

const STAGES = [
  { key: "roster", label: "Roster" },
  { key: "activity", label: "Activity" },
  { key: "results", label: "Results" },
];

function PhaseRail({ activeIndex }) {
  return (
    <ol className="phase-rail" aria-label="Scan stages">
      {STAGES.map((stage, index) => (
        <Fragment key={stage.key}>
          {index > 0 && <li className={`phase-line${index - 1 < activeIndex ? " done" : ""}`} aria-hidden="true" />}
          <li
            className={`phase-step${index < activeIndex ? " done" : ""}${index === activeIndex ? " active" : ""}`}
            data-stage={stage.key}
          >
            <i aria-hidden="true">{index + 1}</i>
            <span>{stage.label}</span>
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

export function ProgressPanel({ state }) {
  if (!state.progressVisible) return null;
  return (
    <section className="card" aria-live="polite">
      <div className="card-heading">
        <div>
          <span className="kicker">Live operation</span>
          <h2 data-stage={state.phaseStage}>{state.phaseLabel}</h2>
        </div>
        <span className={`live-badge${state.badgeClass ? ` ${state.badgeClass}` : ""}`}>
          <i aria-hidden="true" />
          {state.badgeLabel}
        </span>
      </div>

      <PhaseRail activeIndex={state.phaseActiveIndex} />

      <div className="status-line">
        <span>Current status</span>
        <strong className="tabular">{state.statusText}</strong>
      </div>

      <div
        className={`track${state.coveragePercent == null ? " indeterminate" : ""}`}
        role="progressbar"
        aria-label="Roster collection progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={state.coveragePercent == null ? undefined : Math.round(state.coveragePercent)}
      >
        <i style={state.coveragePercent == null ? undefined : { width: `${state.coveragePercent}%` }} />
      </div>

      <div className="stats">
        <div>
          <span>Discovered</span>
          <strong className="tabular">{state.membersFound.toLocaleString()}</strong>
        </div>
        <div>
          <span>Community</span>
          <strong className="tabular">{state.expectedMembers?.toLocaleString() || "—"}</strong>
        </div>
        <div className={`is-coverage${state.coveragePercent != null && state.coveragePercent < 99.5 ? " partial" : ""}`}>
          <span>Coverage</span>
          <strong className="tabular">{state.coveragePercent == null ? "—" : `${state.coveragePercent.toFixed(1)}%`}</strong>
        </div>
        <div>
          <span>Requests</span>
          <strong className="tabular">{state.requestsCount.toLocaleString()}</strong>
        </div>
      </div>

      {state.coverageMessage && (
        <p className={`coverage${state.coverageMessagePartial ? " partial" : ""}`}>{state.coverageMessage}</p>
      )}

      <ScanLog logLines={state.logLines} />

      <div className="diagnostic-export">
        <button
          type="button"
          className="secondary"
          disabled={!state.diagnosticsExportEnabled || state.diagnosticsExportBusy}
          onClick={() => void exportDiagnostics()}
        >
          Export sanitized diagnostics
        </button>
        <small>No cookies, tokens, usernames, member records, or response bodies.</small>
      </div>
    </section>
  );
}
