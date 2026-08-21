import { clearCommunityData, clearAllData } from "../scanEngine.js";

function communityIdFromField(value) {
  const text = String(value || "").trim();
  return text.match(/\/communities\/(\d+)/i)?.[1] || (/^\d+$/.test(text) ? text : "");
}

export function StoragePanel({ state }) {
  async function handleClearCommunity() {
    const communityId = communityIdFromField(state.communityId);
    if (!communityId) return;
    const confirmed = confirm(
      `Clear all saved roster, activity, verification, and archive data for Community ${communityId}? ` +
      `This does not affect X and does not delete anything already exported.`
    );
    if (!confirmed) return;
    await clearCommunityData(communityId);
  }

  async function handleClearAll() {
    const confirmed = confirm(
      "Clear ALL Community Activity data saved in this browser - every Community's roster, " +
      "activity, verification, and archive checkpoints, plus saved settings? This cannot be undone " +
      "and does not affect X or anything already exported."
    );
    if (!confirmed) return;
    await clearAllData();
  }

  return (
    <section className="card">
      <div className="card-heading">
        <div>
          <span className="kicker">Storage</span>
          <h2>Saved scan data</h2>
        </div>
      </div>
      <div className="stats">
        <div>
          <span>Communities</span>
          <strong className="tabular">{state.storageCommunityCount?.toLocaleString() ?? "—"}</strong>
        </div>
        <div>
          <span>Data stored</span>
          <strong className="tabular">{state.storageBytesLabel ?? "—"}</strong>
        </div>
      </div>
      <div className="actions">
        <button type="button" className="secondary" disabled={!state.clearCommunityEnabled} onClick={handleClearCommunity}>
          Clear this Community
        </button>
        <button type="button" className="secondary" disabled={!state.clearAllEnabled} onClick={handleClearAll}>
          Clear all Community Activity data
        </button>
      </div>
      <small>
        Removes this browser's roster, activity, verification, and archive checkpoints only — it does
        not affect X, and it does not delete anything already exported. This is separate from{" "}
        <strong>Discard resume</strong> above, which only forgets an incomplete-scan notice and leaves
        every checkpoint in place.
      </small>
    </section>
  );
}
