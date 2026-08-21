import { useRef } from "react";
import { store, startScan, stopScan, refreshStorage } from "../scanEngine.js";
import { PlatformStatusNotice } from "./PlatformStatusNotice.jsx";

export function SetupForm({ state }) {
  const communityIdRef = useRef(null);

  function handleSubmit(event) {
    event.preventDefault();
    if (!state.communityId.trim()) {
      communityIdRef.current?.setCustomValidity("Paste a valid X Community URL or numeric ID.");
      communityIdRef.current?.reportValidity();
      return;
    }
    communityIdRef.current?.setCustomValidity("");
    void startScan(state);
  }

  return (
    <form className="card" onSubmit={handleSubmit}>
      <div className="card-heading">
        <div>
          <span className="kicker">New analysis</span>
          <h2>Configure scan</h2>
        </div>
        <span className="step-badge">01</span>
      </div>

      <PlatformStatusNotice />

      <label className="field">
        <span>Community URL or ID</span>
        <input
          ref={communityIdRef}
          autoComplete="off"
          placeholder="Paste the Community URL"
          disabled={state.busy}
          value={state.communityId}
          onChange={(event) => store.setState({ communityId: event.target.value })}
          onBlur={() => void refreshStorage()}
        />
      </label>

      <div className="two-col">
        <label className="field">
          <span>Lookback window</span>
          <select
            disabled={state.busy}
            value={String(state.lookbackDays)}
            onChange={(event) => store.setState({ lookbackDays: Number.parseInt(event.target.value, 10) || 30 })}
          >
            <option value="2">2 calendar days</option>
            <option value="7">7 calendar days</option>
            <option value="30">30 calendar days</option>
            <option value="90">90 calendar days</option>
          </select>
        </label>
        <div className="rule-field">
          <span>Inactive when</span>
          <strong>0 Community posts or replies</strong>
        </div>
      </div>
      <p className="notice">
        <i className="glyph" aria-hidden="true">0</i>
        <span>
          Original posts and replies created inside this Community both count as activity.
          Likes, reposts, profile posts outside the Community, and quoted authors do not.
        </span>
      </p>

      <label className="check">
        <input
          type="checkbox"
          disabled={state.busy}
          checked={state.timelineBackfill}
          onChange={(event) => store.setState({ timelineBackfill: event.target.checked })}
        />
        <span>Archive all accessible Community post surfaces</span>
      </label>
      <p className="notice">
        <i className="glyph" aria-hidden="true">↳</i>
        <span>
          Pages Latest, Media, and chronological search cursors from newest to oldest in the
          background. The visible X page will not physically scroll. Unique authors become
          supplemental roster evidence.
        </span>
      </p>

      <label className="check">
        <input
          type="checkbox"
          disabled={state.busy}
          checked={state.seekResume}
          onChange={(event) => store.setState({ seekResume: event.target.checked })}
        />
        <span>Continue past X's roster page cap (advanced)</span>
      </label>
      <p className="notice">
        <i className="glyph" aria-hidden="true">!</i>
        <span>
          X caps one roster cursor chain at 500 pages, which stops a large Community short
          with the last page still full. This resumes from the last position to reach every
          member X will serve. It issues many more requests and relies on X's current cursor
          layout, so leave it off unless a scan is ending well below the member count.
        </span>
      </p>

      <label className="check">
        <input
          type="checkbox"
          disabled={state.busy}
          checked={state.focusLock}
          onChange={(event) => store.setState({ focusLock: event.target.checked })}
        />
        <span>Keep the X Members tab visible during fallback collection</span>
      </label>
      <p className="notice">
        <i className="glyph" aria-hidden="true">i</i>
        <span>Direct scans run without continuous scrolling. The visible tab is needed only for connection and fallback collection.</span>
      </p>

      <div className="actions">
        <button type="submit" disabled={state.busy}>
          <span>{state.startLabel}</span>
          <i aria-hidden="true">→</i>
        </button>
        <button type="button" className="secondary" disabled={!state.busy} onClick={stopScan}>
          Stop
        </button>
      </div>
    </form>
  );
}
