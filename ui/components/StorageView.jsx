import { StoragePanel } from "./StoragePanel.jsx";

export function StorageView({ state }) {
  return (
    <div className="view">
      <StoragePanel state={state} />
    </div>
  );
}
