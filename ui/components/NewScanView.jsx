import { SetupForm } from "./SetupForm.jsx";
import { ProgressPanel } from "./ProgressPanel.jsx";

export function NewScanView({ state }) {
  return (
    <div className="view">
      <SetupForm state={state} />
      <ProgressPanel state={state} />
    </div>
  );
}
