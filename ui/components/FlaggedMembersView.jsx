import { useMemo, useState } from "react";
import { exportAllFlagged, exportConfirmedOnly, exportUsernamesOnly } from "../scanEngine.js";
import { MemberInspector } from "./MemberInspector.jsx";

const TIER_LABEL = {
  "confirmed-inactive": "Confirmed",
  unverified: "Unverified",
  "unverifiable-protected": "Protected",
};
const PAGE_SIZE = 50;

function ArchiveStatus({ rows }) {
  if (!rows.length) return null;
  return (
    <div className="archive-status">
      <span className="kicker">Supplemental archive</span>
      <p className="archive-status-note">
        Separate from the flagged list above: none of this blocks or changes it, and it can keep going across later scans.
      </p>
      <ul className="archive-status-list">
        {rows.map((row) => (
          <li key={row.name} className={`archive-status-row is-${row.status}`}>
            <span className="archive-status-dot" aria-hidden="true" />
            <span className="archive-status-name">{row.name}</span>
            <span className="archive-status-detail">{row.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FlaggedMembersView({ state }) {
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState("all");
  const [sort, setSort] = useState({ key: "username", dir: 1 });
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(null);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    let rows = state.results;
    if (term) rows = rows.filter((row) => row.username.toLowerCase().includes(term));
    if (tierFilter !== "all") rows = rows.filter((row) => (row.activityVerification || "unverified") === tierFilter);
    const sorted = [...rows].sort((a, b) => {
      const va = sort.key === "username" ? a.username.toLowerCase() : a[sort.key] || 0;
      const vb = sort.key === "username" ? b.username.toLowerCase() : b[sort.key] || 0;
      if (va < vb) return -1 * sort.dir;
      if (va > vb) return 1 * sort.dir;
      return 0;
    });
    return sorted;
  }, [state.results, search, tierFilter, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

  function toggleSort(key) {
    setPage(0);
    setSort((prev) => (prev.key === key ? { key, dir: -prev.dir } : { key, dir: 1 }));
  }

  if (!state.resultsPanelVisible) {
    return (
      <div className="view">
        <section className="card empty-state">
          <span className="kicker">Flagged members</span>
          <h2>No results yet</h2>
          <p>Run a scan from New scan to see flagged members here.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="view">
      <section className="card">
        <div className="card-heading">
          <div>
            <span className="kicker">Flagged members</span>
            <h2>{state.results.length.toLocaleString()} of {state.membersFound.toLocaleString() || "?"}</h2>
          </div>
        </div>

        <button type="button" className="export-primary" disabled={!state.exportEnabled} onClick={exportAllFlagged}>
          Export all flagged <span>CSV</span>
        </button>
        <div className="export-grid">
          <button type="button" className="secondary" disabled={!state.exportConfirmedEnabled} onClick={exportConfirmedOnly}>
            Confirmed only <span>{state.confirmedCount.toLocaleString()}</span>
          </button>
          <button type="button" className="secondary" disabled={!state.exportUsernamesEnabled} onClick={exportUsernamesOnly}>
            Usernames only <span>TXT</span>
          </button>
        </div>

        <p className="notice caution">
          <i className="glyph" aria-hidden="true">!</i>
          <span>
            Only rows marked <strong>Confirmed</strong> were checked with a direct search. <strong>Unverified</strong> rows
            rest on the broad crawl alone; <strong>Protected</strong> rows are private accounts a search cannot see into
            either way — review both manually before acting on them.
          </span>
        </p>

        <ArchiveStatus rows={state.archiveRows} />
      </section>

      <section className="card table-card">
        <div className="table-toolbar">
          <input
            type="search"
            placeholder="Search username…"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(0); }}
          />
          <select value={tierFilter} onChange={(event) => { setTierFilter(event.target.value); setPage(0); }}>
            <option value="all">All evidence</option>
            <option value="confirmed-inactive">Confirmed</option>
            <option value="unverified">Unverified</option>
            <option value="unverifiable-protected">Protected</option>
          </select>
        </div>

        <div className="table-shell">
          <table className="members-table">
            <thead>
              <tr>
                <th onClick={() => toggleSort("username")} className="sortable">Username</th>
                <th onClick={() => toggleSort("role")} className="sortable">Role</th>
                <th onClick={() => toggleSort("communityPostsInWindow")} className="sortable">Posts</th>
                <th onClick={() => toggleSort("communityRepliesInWindow")} className="sortable">Replies</th>
                <th onClick={() => toggleSort("activityVerification")} className="sortable">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => (
                <tr
                  key={row.username}
                  className={selected?.username === row.username ? "is-selected" : ""}
                  onClick={() => setSelected(row)}
                >
                  <td>@{row.username}</td>
                  <td>{row.role || "Member"}</td>
                  <td className="tabular">{row.communityPostsInWindow || 0}</td>
                  <td className="tabular">{row.communityRepliesInWindow || 0}</td>
                  <td>
                    <span className={`tier-chip tone-${row.activityVerification === "confirmed-inactive" ? "success" : row.activityVerification === "unverifiable-protected" ? "muted" : "warning"}`}>
                      {TIER_LABEL[row.activityVerification] || "Unverified"}
                    </span>
                  </td>
                </tr>
              ))}
              {pageRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="table-empty">No members match this search/filter.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {pageCount > 1 && (
          <div className="table-pagination">
            <button type="button" className="secondary" disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}>← Prev</button>
            <span className="tabular">Page {clampedPage + 1} of {pageCount} · {filtered.length.toLocaleString()} rows</span>
            <button type="button" className="secondary" disabled={clampedPage >= pageCount - 1} onClick={() => setPage(clampedPage + 1)}>Next →</button>
          </div>
        )}
      </section>

      <MemberInspector member={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
