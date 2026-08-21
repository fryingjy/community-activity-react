import { exportPrivateCsv, exportPrivateText } from "../scanEngine.js";

export function PrivatePanel({ state }) {
  if (!state.privatePanelVisible) return null;
  return (
    <section className="card result-card">
      <div className="result-icon" aria-hidden="true">⌁</div>
      <span className="kicker">Privacy review</span>
      <div className="result-number">
        <strong className="tabular">{state.privateAccounts.length.toLocaleString()}</strong>
        <span>private accounts found</span>
      </div>
      <p>Privacy checking is independent of post activity and becomes available as soon as roster collection finishes.</p>
      <div className="export-grid">
        <button type="button" className="secondary" disabled={state.privateAccounts.length === 0} onClick={exportPrivateCsv}>
          Export CSV
        </button>
        <button type="button" className="secondary" disabled={state.privateAccounts.length === 0} onClick={exportPrivateText}>
          Export TXT
        </button>
      </div>
      <small>{state.privateNote}</small>
    </section>
  );
}
