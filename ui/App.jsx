import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
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
  const pendingTransition = useRef(null);

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

  // Chrome 111+ (this extension's floor is 114 - see manifest.json) ships
  // the View Transitions API, so a section switch gets a real cross-fade
  // instead of an instant swap. The API needs the DOM actually updated by
  // the time its callback returns, not just scheduled - React's setState is
  // async by default, so this must go through flushSync or the transition
  // captures a stale "after" frame. And a still-in-flight transition must
  // be skipped *explicitly* before starting the next one: leaving two
  // transitions racing each other (nav clicked faster than the ~0.28s
  // animation) surfaced as an uncaught InvalidStateError even though the
  // final view still ended up correct - skipTransition() is the documented
  // way to hand off cleanly instead of relying on the browser's implicit
  // handling of the overlap.
  function changeView(key) {
    if (document.startViewTransition) {
      pendingTransition.current?.skipTransition();
      const transition = document.startViewTransition(() => flushSync(() => setActiveView(key)));
      pendingTransition.current = transition;
      // A skipped/aborted transition can reject any of its three promises
      // depending on which phase it was in when the newer one preempted
      // it - catch all three so an interrupted transition never surfaces
      // as an unhandled rejection, only .finished gates clearing the ref.
      transition.ready.catch(() => {});
      transition.updateCallbackDone.catch(() => {});
      transition.finished.catch(() => {}).finally(() => {
        if (pendingTransition.current === transition) pendingTransition.current = null;
      });
    } else {
      setActiveView(key);
    }
  }

  const ViewComponent = VIEWS[activeView] || OverviewView;

  return (
    <AppShell state={state} activeView={activeView} onChangeView={changeView}>
      <ViewComponent state={state} onStartScan={() => changeView("new-scan")} />
    </AppShell>
  );
}
