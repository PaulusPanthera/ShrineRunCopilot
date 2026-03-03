// js/state/store.js
// alpha v1
// State store: update/apply + persistence wiring.

function cloneState(x){
  // Prefer structuredClone when available (keeps Dates/Maps/etc), fall back to JSON.
  // State is designed to be JSON-safe, so the fallback is acceptable.
  if (typeof structuredClone === 'function') return structuredClone(x);
  return JSON.parse(JSON.stringify(x));
}

export function createStore(initialState){
  let state = initialState;
  const subs = new Set();

  const api = {
    getState: ()=>state,
    setState: (next)=>{
      state = next;
      subs.forEach(fn => fn(state));
    },
    update: (mutator)=>{
      const next = cloneState(state);
      mutator(next);
      api.setState(next);
    },
    subscribe: (fn)=>{
      subs.add(fn);
      return ()=>subs.delete(fn);
    },
  };

  return api;
}
