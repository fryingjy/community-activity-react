import { useEffect, useState } from "react";
import { init } from "./scanEngine.js";
import { useScanState } from "./useScanState.js";
import { AppShell } from "./components/AppShell.jsx";
import { OverviewView } from "./components/OverviewView.jsx";
import { NewScanView } from "./components/NewScanView.jsx";
import { FlaggedMembersView } from "./components/FlaggedMembersView.jsx";
import { PrivacyView } from "./components/PrivacyView.jsx";
import { StorageView } from "./components/StorageView.jsx";

const VIEWS = {
  overview: OverviewView,
  "new-scan": NewScanView,
  flagged: FlaggedMembersView,
  privacy: PrivacyView,
  storage: StorageView,
};

export function App() {
  const state = useScanState();
  const [activeView, setActiveView] = useState("overview");

  useEffect(() => {
    document.documentElement.dataset.mode = state.dashboardMode ? "dashboard" : "lite";
    document.title = state.dashboardMode ? "Community Activity Dashboard" : "Community Activity Lite";
  }, [state.dashboardMode]);

  useEffect(() => {
    init();
    // Runs once on mount, matching the pre-React version's single
    // top-of-file initialize() call - the engine owns everything from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ViewComponent = VIEWS[activeView] || OverviewView;

  return (
    <AppShell state={state} activeView={activeView} onChangeView={setActiveView}>
      <ViewComponent state={state} onStartScan={() => setActiveView("new-scan")} />
    </AppShell>
  );
}
