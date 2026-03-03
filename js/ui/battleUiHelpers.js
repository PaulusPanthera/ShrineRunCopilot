// js/ui/battleUiHelpers.js
// alpha v1
// Shared UI helpers used by Waves tab and Attack Overview.

import { sprite } from './dom.js';
import { fixName } from '../data/nameFixes.js';
import { DEFAULT_MOVE_PP } from '../domain/battle.js';

// Static sprites (PNG) for wave tooling to keep the UI snappy.
// Roster stays animated (GIF) via sprite().
export function spriteStatic(calcObj, name){
  try{
    if (calcObj && typeof calcObj.spriteUrlPokemonDbBWStatic === 'function'){
      return calcObj.spriteUrlPokemonDbBWStatic(name);
    }
  }catch(e){ /* ignore */ }
  return sprite(calcObj, name);
}

export function rosterLabel(r){
  const eff = r?.effectiveSpecies || r?.baseSpecies;
  return eff || (r?.baseSpecies || '');
}

// PP-aware move pool helpers (used by previews/solvers so PP=0 moves are never suggested).
function ppCurFor(ppMap, monId, moveName){
  const n = Number(ppMap?.[monId]?.[moveName]?.cur);
  return Number.isFinite(n) ? n : DEFAULT_MOVE_PP;
}

export function filterMovePoolForCalc({ppMap, monId, movePool, forcedMoveName=null}){
  const base = (movePool||[]).filter(m => m && m.use !== false && m.name && ppCurFor(ppMap, monId, m.name) > 0);
  if (forcedMoveName){
    // Only enforce a forced move if it still has PP.
    if (ppCurFor(ppMap, monId, forcedMoveName) > 0){
      const forced = base.filter(m => m.name === forcedMoveName);
      if (forced.length) return forced;
    }
  }
  return base;
}

// Weather helpers (UI preview + solver parity with sim).
function weatherFromAbilityName(ab){
  const a = String(ab||'').trim().toLowerCase();
  if (a === 'drizzle') return 'rain';
  if (a === 'drought') return 'sun';
  if (a === 'sand stream') return 'sand';
  if (a === 'snow warning') return 'hail';
  return null;
}
function statOtherNeutral(base, level, iv, ev){
  const evq = Math.floor(Number(ev||0)/4);
  return Math.floor(((2*Number(base||0) + Number(iv||0) + evq) * Number(level||0))/100) + 5;
}

export function enemyAbilityForSpecies(data, species){
  const s = fixName(species);
  return String(data?.claimedSets?.[s]?.ability || '').trim();
}

function speedForRosterEntry(data, state, r){
  if (!r) return 0;
  const sp = fixName(r.effectiveSpecies || r.baseSpecies);
  const mon = data?.dex?.[sp];
  const base = Number(mon?.base?.spe || 0);
  const L = Number(state?.settings?.claimedLevel || 50);
  const iv = Number(state?.settings?.claimedIV || 0);
  const ev = Number(r.strength ? state?.settings?.strengthEV : state?.settings?.claimedEV) || 0;
  return statOtherNeutral(base, L, iv, ev);
}
function speedForDefSlot(data, state, defSlot){
  if (!defSlot) return 0;
  const sp = fixName(defSlot.defender);
  const mon = data?.dex?.[sp];
  const base = Number(mon?.base?.spe || 0);
  const L = Number(defSlot.level || 50);
  const iv = Number(state?.settings?.wildIV || 0);
  const ev = Number(state?.settings?.wildEV || 0);
  return statOtherNeutral(base, L, iv, ev);
}

// Gen 5 start-of-battle weather: fastest setter activates first; slowest setter remains.
// Deterministic tie-break: defenders win ties (stable for planning).
export function inferBattleWeatherFromLeads(data, state, atkEntries, defSlots){
  const cands = [];
  for (const r of (atkEntries||[])){
    if (!r) continue;
    const w = weatherFromAbilityName(r.ability);
    if (!w) continue;
    cands.push({weather:w, side:'atk', spe:speedForRosterEntry(data, state, r)});
  }
  for (const ds of (defSlots||[])){
    if (!ds) continue;
    const ab = enemyAbilityForSpecies(data, ds.defender);
    const w = weatherFromAbilityName(ab);
    if (!w) continue;
    cands.push({weather:w, side:'def', spe:speedForDefSlot(data, state, ds)});
  }
  if (!cands.length) return null;
  cands.sort((a,b)=>{
    if (a.spe !== b.spe) return b.spe - a.spe; // slowest last
    // tie: attacker first, defender last
    if (a.side !== b.side) return a.side === 'atk' ? -1 : 1;
    return 0;
  });
  return cands[cands.length - 1]?.weather || null;
}

export function withWeatherSettings(settings, weather){
  if (!weather) return settings;
  const s = {...settings};
  s.weather = weather;
  // Make sure terrain doesn't get accidentally set here.
  return s;
}
