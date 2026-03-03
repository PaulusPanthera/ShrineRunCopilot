// js/ui/dexNav.js
// alpha v1
// Shared Pokédex navigation helpers (used by app router + dex tab).

import { fixName } from '../data/nameFixes.js';

function byId(arr, id){
  return (arr||[]).find(x => x && x.id === id);
}

// Resolve which roster entry should be re-selected when returning from Pokédex.
// Primary: stored roster id. Fallback: stored base species name.
export function resolveDexReturnRosterId(state){
  const id = state?.ui?.dexOriginRosterId || state?.ui?.dexReturnRosterId;
  if (id && byId(state.roster||[], id)) return id;
  const base = state?.ui?.dexOriginRosterBase || state?.ui?.dexReturnRosterBase;
  if (base){
    const b = fixName(base);
    const hit = (state.roster||[]).find(r=>{
      const rs = fixName(r?.baseSpecies);
      const eff = fixName(r?.effectiveSpecies || r?.baseSpecies);
      return rs === b || eff === b;
    });
    if (hit && hit.id) return hit.id;
  }
  return null;
}
