// js/domain/roster.js
// v13 — roster entry construction + charm rules

import { EVO_OVERRIDES, EVO_PRESET } from '../services/pokeApi.js';
import { applyMovesetOverrides } from './shrineRules.js';

export const STARTERS = new Set(['Cobalion','Keldeo','Terrakion','Virizion']);

export function isStarterSpecies(species){
  return STARTERS.has(species);
}

function uniq(arr){
  return Array.from(new Set(arr));
}

export function moveInfo(data, moveName){
  if (!moveName) return null;
  return data.moves?.[moveName] || null;
}

export function isStabMove(data, species, moveName){
  const d = data.dex?.[species];
  const mi = moveInfo(data, moveName);
  if (!d || !mi) return false;
  return Array.isArray(d.types) && d.types.includes(mi.type);
}

// Priority tiers:
//   P1 = preferred (weak filler; low BP, usually non-STAB)
//   P2 = normal
//   P3 = "nukes" (only used if P1/P2 can't OHKO)
export function defaultPrioForMove(data, species, moveName){
  const mi = moveInfo(data, moveName);
  // Missing/unknown move data in the sheet (custom shrine moves) => treat as utility.
  if (!mi || !mi.type || !mi.category || !mi.power) return 1;

  const cat = String(mi.category);
  const bp = Number(mi.power) || 0;
  if (!(cat === 'Physical' || cat === 'Special') || bp <= 0) return 1;

  const stab = isStabMove(data, species, moveName);
  const t = String(mi.type);

  // Ground rule (requested):
  // - P3 ONLY for strong STAB Fighting/Bug moves
  // - P2 for most remaining STAB and strong coverage
  // - P1 for utility + weakest + most non-STAB filler
  if (stab && (t === 'Fighting' || t === 'Bug') && bp >= 80) return 3;

  // "Main" STAB moves
  if (stab && bp >= 70) return 2;

  // Strong non-STAB coverage (e.g. Megahorn on Virizion)
  if (!stab && bp >= 100) return 2;

  // Everything else (weak / utility / niche coverage)
  return 1;
}

export function buildDefaultMovePool(data, species, moveNames, source='base'){
  const uniqueMoves = uniq((moveNames||[]).filter(Boolean));
  return uniqueMoves.map(m => ({
    name: m,
    prio: defaultPrioForMove(data, species, m),
    use: true,
    // Shrine run planner PP: default all moves to 12 until proven otherwise.
    ppMax: 12,
    pp: 12,
    source,
  }));
}

export function makeRosterEntryFromClaimedSet(data, species){
  const set = data.claimedSets?.[species] || {ability:'', moves:[]};
  const fixedMoves = applyMovesetOverrides(species, Array.isArray(set.moves) ? set.moves : []);
  const id = `r_${species}_${Math.random().toString(16).slice(2,9)}`;
  const entry = {
    id,
    baseSpecies: species,
    effectiveSpecies: species,
    active: true,
    evo: false,
    // Starters: Strength charm is forced ON by default.
    strength: isStarterSpecies(species) ? true : false,
    ability: set.ability || '',
    movePool: buildDefaultMovePool(data, species, fixedMoves || [], 'base'),
    item: null,
  };
  return entry;
}

export function getEvoTarget(data, base, evoCache){
  if (!base || isStarterSpecies(base)) return null;

  const override = EVO_OVERRIDES[base];
  if (override && data.dex?.[override]) return override;

  const preset = EVO_PRESET[base];
  if (preset && data.dex?.[preset]) return preset;

  const cached = evoCache?.[base];
  if (cached && data.dex?.[cached]) return cached;

  return null;
}

// Apply alpha charm rules synchronously.
// Returns {needsEvoResolve:boolean, evoBase:string|null}
export function applyCharmRulesSync(data, state, entry){
  const base = entry.baseSpecies;

  // Apply rare, explicit moveset exceptions based on the *effective* species.
  // This keeps the "4 hardcoded moves" rule intact when Evo charm changes species.
  const applyEffectiveMoveset = ()=>{
    const eff = entry.effectiveSpecies || entry.baseSpecies;
    entry.movePool = entry.movePool || [];
    const names = entry.movePool.map(m => m.name);
    const overridden = applyMovesetOverrides(eff, names);
    const isSetOverride = Array.isArray(overridden) && overridden.length && overridden.join('|') !== names.slice(0, overridden.length).join('|');

    // If the override is a full 4-move set, only enforce it when the pool still looks "base".
    const looksBase = entry.movePool.length <= 4 && entry.movePool.every(m => (m.source || 'base') === 'base');
    if (looksBase && overridden && overridden.length === 4 && !overridden.every((v,i)=>v===names[i])){
      const prev = new Map(entry.movePool.map(m => [m.name, m]));
      const rebuilt = buildDefaultMovePool(data, eff, overridden, 'base');
      // Preserve PP + use when the same move name exists.
      for (const mv of rebuilt){
        const old = prev.get(mv.name);
        if (old){
          mv.use = old.use;
          mv.ppMax = Number.isFinite(Number(old.ppMax)) ? Number(old.ppMax) : mv.ppMax;
          mv.pp = Number.isFinite(Number(old.pp)) ? Number(old.pp) : mv.pp;
          mv.prio = Number.isFinite(Number(old.prio)) ? Number(old.prio) : mv.prio;
        }
      }
      entry.movePool = rebuilt;
      return;
    }

    // Otherwise, do safe in-place replacements (preserve PP/use) and recompute default prio.
    if (overridden && overridden.length === names.length){
      for (let i = 0; i < entry.movePool.length; i++){
        const oldName = entry.movePool[i].name;
        const newName = overridden[i];
        if (newName && newName !== oldName){
          entry.movePool[i].name = newName;
          // Recompute default priority since move identity changed.
          entry.movePool[i].prio = defaultPrioForMove(data, eff, newName);
        }
      }
    }
  };

  // Starters: Evo unavailable; Strength is forced ON (does NOT consume the shared bag).
  if (isStarterSpecies(base)){
    entry.evo = false;
    entry.strength = true;
    entry.effectiveSpecies = base;
    applyEffectiveMoveset();
    return {needsEvoResolve:false, evoBase:null};
  }

  // Strength charm toggles EV rule only; doesn't change species
  const evoCache = state.evoCache || {};

  if (entry.evo){
    const t = getEvoTarget(data, base, evoCache);
    if (t){
      entry.effectiveSpecies = t;
      applyEffectiveMoveset();
      return {needsEvoResolve:false, evoBase:null};
    }
    entry.effectiveSpecies = base;
    applyEffectiveMoveset();
    return {needsEvoResolve:true, evoBase: base};
  }

  entry.effectiveSpecies = base;
  applyEffectiveMoveset();
  return {needsEvoResolve:false, evoBase:null};
}

// Ensure movePool priorities are exactly 1/2/3.
export function normalizeMovePool(entry){
  entry.movePool = entry.movePool || [];
  for (const mv of entry.movePool){
    const p = Number(mv.prio);
    if (p === 1 || p === 2 || p === 3) mv.prio = p;
    else if (p === 3.0) mv.prio = 1;
    else if (p === 2.5) mv.prio = 2;
    else mv.prio = 2;

    // PP defaults
    const pm = Number(mv.ppMax);
    mv.ppMax = Number.isFinite(pm) && pm > 0 ? Math.floor(pm) : 12;
    const pp = Number(mv.pp);
    mv.pp = Number.isFinite(pp) ? Math.max(0, Math.min(mv.ppMax, Math.floor(pp))) : mv.ppMax;
  }
}
