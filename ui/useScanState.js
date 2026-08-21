import { useSyncExternalStore } from "react";
import { store } from "./scanEngine.js";

// useSyncExternalStore is the API React ships specifically for "external
// mutable store, not owned by React" - exactly this seam. store.getState
// always returns the current snapshot by reference, and store.setState only
// ever produces a new object, so this is safe to call with no extra
// memoization.
export function useScanState() {
  return useSyncExternalStore(store.subscribe, store.getState);
}
