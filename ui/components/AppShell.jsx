import { toggleDashboardMode, openCommunityTab } from "../scanEngine.js";
import { useState } from "react";

const VERSION = "5.17.3";

const NAV_ITEMS = [
  { key: "overview", label: "Overview", glyph: "⌂" },
  { key: "new-scan", label: "New scan", glyph: "◎" },
  { key: "flagged", label: "Flagged members", glyph: "⚑" },
  { key: "privacy", label: "Privacy review", glyph: "⌁" },
  { key: "storage", label: "Storage", glyph: "⛁" },
];

export function AppShell({ state, activeView, onChangeView, children }) {
  const [communityTabLabel, setCommunityTabLabel] = useState("Open X tab");
  const [modeToggleLabel, setModeToggleLabel] = useState(
    state.dashboardMode ? "Open Lite panel" : "Full dashboard"
  );

  async function handleOpenCommunityTab() {
    const result = await openCommunityTab();
    if (!result.ok) {
      setCommunityTabLabel(result.message);
      setTimeout(() => setCommunityTabLabel("Open X tab"), 3500);
    }
  }

  async function handleToggleMode() {
    const result = await toggleDashboardMode();
    if (!result.ok) {
      setModeToggleLabel(result.message);
      setTimeout(
        () => setModeToggleLabel(state.dashboardMode ? "Open Lite panel" : "Full dashboard"),
        3500
      );
    }
  }

  const flaggedCount = state.results.length;

  return (
    <div className="shell">
      <aside className="shell-nav">
        <div className="shell-brand">
          <div className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32">
              <path d="M9 8.5h14M9 16h10M9 23.5h6" />
              <circle cx="24" cy="23.5" r="3.5" />
            </svg>
          </div>
          <div className="shell-brand-copy">
            <div className="eyebrow">
              Community Activity <span>{VERSION}</span>
            </div>
            <p title={state.contextTitle || undefined}>{state.contextLabel}</p>
          </div>
        </div>

        <nav aria-label="Sections">
          <ul>
            {NAV_ITEMS.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  className={`nav-item${activeView === item.key ? " active" : ""}`}
                  onClick={() => onChangeView(item.key)}
                >
                  <i aria-hidden="true">{item.glyph}</i>
                  <span>{item.label}</span>
                  {item.key === "flagged" && flaggedCount > 0 && (
                    <em className="nav-badge tabular">{flaggedCount.toLocaleString()}</em>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="shell-nav-footer">
          <div className="app-status">
            <i aria-hidden="true" />
            <span>Local · no telemetry</span>
          </div>
          <div className="header-buttons">
            <button type="button" className="mode-toggle dashboard-only" onClick={handleOpenCommunityTab}>
              {communityTabLabel}
            </button>
            <button type="button" className="mode-toggle" onClick={handleToggleMode}>
              {modeToggleLabel}
            </button>
          </div>
        </div>
      </aside>

      <div className="shell-content">
        <p className="surface-notice" role="status" hidden={!state.surfaceNotice}>
          {state.surfaceNotice}
        </p>
        {children}
      </div>
    </div>
  );
}
