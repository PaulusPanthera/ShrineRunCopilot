// js/state/store.js
// alpha_v1_sim v1.0.0
// Project source file.

function deepClone(x){
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
      const next = deepClone(state);
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