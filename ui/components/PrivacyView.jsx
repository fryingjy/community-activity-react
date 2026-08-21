import { PrivatePanel } from "./PrivatePanel.jsx";

export function PrivacyView({ state }) {
  return (
    <div className="view">
      {state.privatePanelVisible ? (
        <PrivatePanel state={state} />
      ) : (
        <section className="card empty-state">
          <span className="kicker">Privacy review</span>
          <h2>Not available yet</h2>
          <p>Becomes available as soon as a scan's roster collection finishes - independent of activity results.</p>
        </section>
      )}
    </div>
  );
}
