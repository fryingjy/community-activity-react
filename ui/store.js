// A minimal external-store primitive with no scan-domain knowledge: getState/
// setState/subscribe, the exact shape React's useSyncExternalStore expects
// (see https://react.dev/reference/react/useSyncExternalStore). setState
// always produces a new object so referential-equality checks - React's and
// this file's own adapters alike - see every update.
export function createStore(initialState) {
  let state = initialState;
  const listeners = new Set();

  function getState() {
    return state;
  }

  function setState(patch) {
    state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
    for (const listener of listeners) listener();
    return state;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { getState, setState, subscribe };
}
