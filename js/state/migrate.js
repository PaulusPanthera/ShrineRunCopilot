// js/state/migrate.js
//
// alpha v1

import { fixName } from '../data/nameFixes.js';
import { fixMoveName } from '../data/moveFixes.js';
import { STARTERS, makeRosterEntryFromClaimedSet, applyCharmRulesSync, normalizeMovePool, defaultPrioForMove, isStarterSpecies } from '../domain/roster.js';
import { enforceBagConstraints } from '../domain/items.js';

function deepClone(x){
  return JSON.parse(JSON.stringify(x));
}

function byId(arr, id){
  return arr.find(x => x.id === id);
}

const DEFAULT_PP = 12;

// Legacy (v1.0.5) default prio mapping used only to avoid clobbering user-edited prios.
// If a move's prio still matches this legacy default, we can safely upgrade it to the new defaults.
function legacyDefaultPrioForMove(data, species, moveName){
  const mi = (data && data.moves) ? data.moves?.[moveName] : null;
  if (!mi || !mi.type || !mi.category || !mi.power) return 1;
  const cat = String(mi.category);
  const bp = Number(mi.power) || 0;
  if (!(cat === 'Physical' || cat === 'Special') || bp <= 0) return 1;

  const d = data?.dex?.[species];
  const stab = Array.isArray(d?.types) && d.types.includes(mi.type);
  const t = String(mi.type);
  if (stab && (t === 'Fighting' || t === 'Bug') && bp >= 80) return 3;
  if (stab && bp >= 70) return 2;
  if (!stab && bp >= 100) return 2;
  return 1;
}

export function hydrateState(raw, defaultState, data){
  let state = raw ? {...deepClone(defaultState), ...raw} : deepClone(defaultState);

  // Ensure defaults
  state.version = defaultState.version;
  state.settings = {...deepClone(defaultState.settings), ...(state.settings||{})};
  state.ui = {...deepClone(defaultState.ui), ...(state.ui||{})};

  // Removed Sim tab: legacy saves may still point to it.
  if (state.ui.tab === 'sim') state.ui.tab = 'waves';
  if (state.ui.lastNonDexTab === 'sim') state.ui.lastNonDexTab = 'waves';


  // Deep-merge nested defaults
  state.settings.defaultAtkMods = {
    ...(deepClone(defaultState.settings.defaultAtkMods)||{}),
    ...((state.settings.defaultAtkMods)||{}),
  };
  state.settings.defaultDefMods = {
    ...(deepClone(defaultState.settings.defaultDefMods)||{}),
    ...((state.settings.defaultDefMods)||{}),
  };

  // Force auto-match always ON
  state.settings.autoMatch = true;

  if (!('startAnimal' in state.settings)) state.settings.startAnimal = defaultState.settings.startAnimal || 'Goat';

  // v20: AoE friendly-fire safety toggle
  if (!('allowFriendlyFire' in state.settings)) state.settings.allowFriendlyFire = false;

  // Manual PP editing (debug / convenience) — default OFF.
  if (!('allowManualPPEdit' in state.settings)) state.settings.allowManualPPEdit = false;

  // Lazy conserve mode (default ON): when PP<=5, bump prio tier by +1 once for auto-managed moves.
  if (!('autoBumpPrioLowPP' in state.settings)) state.settings.autoBumpPrioLowPP = true;

  state.unlocked = state.unlocked || {};
  state.cleared = state.cleared || {};
  state.roster = Array.isArray(state.roster) ? state.roster : [];
  state.bag = state.bag || {};
  // Ensure shared team starting items exist (do not overwrite existing counts)
  if (!('Evo Charm' in state.bag)) state.bag['Evo Charm'] = (defaultState.bag && defaultState.bag['Evo Charm']) ? defaultState.bag['Evo Charm'] : 2;
  if (!('Strength Charm' in state.bag)) state.bag['Strength Charm'] = (defaultState.bag && defaultState.bag['Strength Charm']) ? defaultState.bag['Strength Charm'] : 2;
  // Legacy default used 8 each; normalize to team-run default (2 each) unless user has already edited.
  if (state.bag['Evo Charm'] === 8) state.bag['Evo Charm'] = 2;
  if (state.bag['Strength Charm'] === 8) state.bag['Strength Charm'] = 2;
  state.wavePlans = state.wavePlans || {};
  state.evoCache = state.evoCache || {};
  state.baseCache = state.baseCache || {};
  state.evoLineCache = state.evoLineCache || {};

  // Pokédex live caches (PokeAPI)
  state.dexMetaCache = state.dexMetaCache || {};
  state.dexApiCache = state.dexApiCache || {};
  state.dexMoveCache = state.dexMoveCache || {};

  // Battle sim + PP
  state.battles = state.battles || {};
  state.pp = state.pp || {};
  if (!state.ui.dexDefenderLevelByBase) state.ui.dexDefenderLevelByBase = {};
  if (!('dexReturnTab' in state.ui)) state.ui.dexReturnTab = null;
  if (!('lastNonDexTab' in state.ui)) state.ui.lastNonDexTab = (state.ui.tab && state.ui.tab !== 'unlocked') ? state.ui.tab : 'waves';
// Politoed shop
  state.shop = state.shop || {gold:0, ledger:[]};
  if (!('gold' in state.shop)) state.shop.gold = 0;
  if (!Array.isArray(state.shop.ledger)) state.shop.ledger = [];


  // Seed roster if empty
  if (state.roster.length === 0){
    const starterList = Array.from(STARTERS).filter(s => data.claimedSets?.[s]);
    for (const sp of starterList){
      state.unlocked[sp] = true;
      const entry = makeRosterEntryFromClaimedSet(data, sp);
      // Apply charm rules (starters enforced)
      applyCharmRulesSync(data, state, entry);
      normalizeMovePool(entry);
      state.roster.push(entry);
    }
    state.ui.selectedRosterId = state.roster[0]?.id || null;
  }

  // Ensure roster species are unlocked + normalize roster entries
  for (const r of state.roster){
    if (!r || typeof r !== 'object') continue;

    r.baseSpecies = fixName(r.baseSpecies);
    state.unlocked[r.baseSpecies] = true;

    // Clean legacy fields
    if ('evolveTo' in r) delete r.evolveTo;

    if (!Array.isArray(r.movePool)) r.movePool = [];
    if (!('item' in r)) r.item = null;

    // v1.0.5+: priorities must be 1..5
    normalizeMovePool(r);
    // Canonicalize move names (remove legacy aliases/typos) and keep PP map consistent.
    if (Array.isArray(r.movePool)){
      const oldToNew = new Map();
      for (const mv of r.movePool){
        if (!mv || !mv.name) continue;
        const old = String(mv.name);
        const neu = fixMoveName(old);
        if (neu && neu !== old){
          mv.name = neu;
          oldToNew.set(old, neu);
        }
      }
      // Rename stored PP keys for this mon.
      if (state.pp && state.pp[r.id] && oldToNew.size){
        const ppObj = state.pp[r.id];
        for (const [old, neu] of oldToNew.entries()){
          if (ppObj[old] && !ppObj[neu]) ppObj[neu] = ppObj[old];
          if (ppObj[old] && ppObj[neu] && old !== neu) delete ppObj[old];
        }
      }
    }


    // If movePool empty, rebuild
    if (r.movePool.length === 0 && data.claimedSets?.[r.baseSpecies]){
      const fresh = makeRosterEntryFromClaimedSet(data, r.baseSpecies);
      r.ability = r.ability || fresh.ability;
      r.movePool = fresh.movePool;
    }

    // Charm rules + effectiveSpecies
    applyCharmRulesSync(data, state, r);

    // Seed default PP (12 each) for enabled moves
    state.pp = state.pp || {};
    state.pp[r.id] = state.pp[r.id] || {};
    for (const mv of ((r.movePool||[]).filter(m=>m && m.use !== false))){
      const name = mv.name;
      if (!name) continue;
      const cur = state.pp[r.id][name];
      if (!cur || typeof cur !== "object"){
        state.pp[r.id][name] = {cur: DEFAULT_PP, max: DEFAULT_PP};
      } else {
        if (!("max" in cur)) cur.max = DEFAULT_PP;
        if (!("cur" in cur)) cur.cur = cur.max;
        cur.max = Number(cur.max)||DEFAULT_PP;
        cur.cur = Number.isFinite(Number(cur.cur)) ? Number(cur.cur) : cur.max;
        if (cur.max <= 0) cur.max = DEFAULT_PP;
        if (cur.cur < 0) cur.cur = 0;
        if (cur.cur > cur.max) cur.cur = cur.max;
      }
    }
  }

  // One-time upgrade: apply new default move priorities (1..5) while preserving user edits.
  // Rule: only update a move when its current prio still matches the legacy (v1.0.5) default.
  if (!state.ui._prioDefaultsV106Applied){
    for (const r of state.roster){
      if (!r) continue;
      const eff = r.effectiveSpecies || r.baseSpecies;
      for (const mv of (r.movePool||[])){
        if (!mv || !mv.name) continue;
        const cur = Number(mv.prio);
        const legacy = legacyDefaultPrioForMove(data, eff, mv.name);
        const next = defaultPrioForMove(data, eff, mv.name, r.ability || '', {state, entry:r});

        if (!(cur === 1 || cur === 2 || cur === 3 || cur === 4 || cur === 5)) mv.prio = next;
        else if (cur === legacy) mv.prio = next;
      }
      normalizeMovePool(r);
    }
    state.ui._prioDefaultsV106Applied = true;
  }

  // One-time upgrade (v1.0.7): recompute default move priorities (1..5) using the new tiering rules.
  // This is only applied to "auto" priorities; manual changes will set mv.prioAuto=false in the UI going forward.
  if (!state.ui._prioDefaultsV107Applied){
    for (const r of state.roster){
      if (!r) continue;
      const eff = r.effectiveSpecies || r.baseSpecies;
      for (const mv of (r.movePool||[])){
        if (!mv || !mv.name) continue;
        if (mv.prioAuto === false) continue;
        mv.prio = defaultPrioForMove(data, eff, mv.name, r.ability || '', {state, entry:r});
        mv.prioAuto = true;
      }
      normalizeMovePool(r);
    }
    state.ui._prioDefaultsV107Applied = true;
  }


  // One-time upgrade (v1.0.12): refresh auto priorities after default rule tweaks (e.g., strong Bug coverage tier).
  // Only applies to mv.prioAuto=true; manual edits are preserved.
  if (!state.ui._prioDefaultsV112Applied){
    for (const r of state.roster){
      if (!r) continue;
      const eff = r.effectiveSpecies || r.baseSpecies;
      for (const mv of (r.movePool||[])){
        if (!mv || !mv.name) continue;
        if (mv.prioAuto === false) continue;
        mv.prio = defaultPrioForMove(data, eff, mv.name, r.ability || '', {state, entry:r});
        mv.prioAuto = true;
      }
      normalizeMovePool(r);
    }
    state.ui._prioDefaultsV112Applied = true;
  }


  // One-time upgrade (v1.0.13): refresh auto priorities after strength-based tiering tweak.
  // Only applies to mv.prioAuto=true; manual edits are preserved.
  if (!state.ui._prioDefaultsV113Applied){
    for (const r of state.roster){
      if (!r) continue;
      const eff = r.effectiveSpecies || r.baseSpecies;
      for (const mv of (r.movePool||[])){
        if (!mv || !mv.name) continue;
        if (mv.prioAuto === false) continue;
        mv.prio = defaultPrioForMove(data, eff, mv.name, r.ability || '', {state, entry:r});
        mv.prioAuto = true;
      }
      normalizeMovePool(r);
    }
    state.ui._prioDefaultsV113Applied = true;
  }


  // One-time upgrade (prio AoE×0.75 classification): refresh auto priorities after AoE strength tweak.
  // Only applies to mv.prioAuto=true; manual edits are preserved.
  if (!state.ui._prioDefaultsAoe075Applied){
    for (const r of state.roster){
      if (!r) continue;
      const eff = r.effectiveSpecies || r.baseSpecies;
      for (const mv of (r.movePool||[])){
        if (!mv || !mv.name) continue;
        if (mv.prioAuto === false) continue;
        if (mv.lowPpBumped === true) continue;
        mv.prio = defaultPrioForMove(data, eff, mv.name, r.ability || '', {state, entry:r});
        mv.prioAuto = true;
      }
      normalizeMovePool(r);
    }
    state.ui._prioDefaultsAoe075Applied = true;
  }


  // One-time upgrade (prio STAB math): fold STAB (×1.5) into strength-based tiering.
  // Only applies to mv.prioAuto=true; manual edits are preserved.
  if (!state.ui._prioDefaultsStabMathApplied){
    for (const r of state.roster){
      if (!r) continue;
      const eff = r.effectiveSpecies || r.baseSpecies;
      for (const mv of (r.movePool||[])){
        if (!mv || !mv.name) continue;
        if (mv.prioAuto === false) continue;
        if (mv.lowPpBumped === true) continue;
        mv.prio = defaultPrioForMove(data, eff, mv.name, r.ability || '', {state, entry:r});
        mv.prioAuto = true;
      }
      normalizeMovePool(r);
    }
    state.ui._prioDefaultsStabMathApplied = true;
  }


  // One-time upgrade (prio strength thresholds v2): adjust tiers to
  // P1<85, P2<100, P3<115, P4<130, P5>=130, while keeping Bug/Fighting reserve rules.
  // Only applies to mv.prioAuto=true and not already low-PP bumped.
  if (!state.ui._prioDefaultsStrengthThresholdsV2Applied){
    for (const r of state.roster){
      if (!r) continue;
      const eff = r.effectiveSpecies || r.baseSpecies;
      for (const mv of (r.movePool||[])){
        if (!mv || !mv.name) continue;
        if (mv.prioAuto === false) continue;
        if (mv.lowPpBumped === true) continue;
        mv.prio = defaultPrioForMove(data, eff, mv.name, r.ability || '', {state, entry:r});
        mv.prioAuto = true;
      }
      normalizeMovePool(r);
    }
    state.ui._prioDefaultsStrengthThresholdsV2Applied = true;
  }


  // One-time upgrade (prio effective L50 stats): default prio strength now uses the actual
  // Level/IV/EV/nature-based offensive stat (plus limited ability multipliers), instead of base stats.
  // Only applies to mv.prioAuto=true and not already low-PP bumped.
  if (!state.ui._prioDefaultsEffectiveL50Applied){
    for (const r of state.roster){
      if (!r) continue;
      const eff = r.effectiveSpecies || r.baseSpecies;
      for (const mv of (r.movePool||[])){
        if (!mv || !mv.name) continue;
        if (mv.prioAuto === false) continue;
        if (mv.lowPpBumped === true) continue;
        mv.prio = defaultPrioForMove(data, eff, mv.name, r.ability || '', {state, entry:r});
        mv.prioAuto = true;
      }
      normalizeMovePool(r);
    }
    state.ui._prioDefaultsEffectiveL50Applied = true;
  }


  // One-time upgrade (prio meta bands): update default prio thresholds to
  // P1<75, P2<105, P3<140, P4<190, P5>=190; refresh Bug/Fight reserve rules; and
  // shift Normal-type attacking moves 1 tier earlier for stronger bands (P3–P5 → P2–P4).
  // Only applies to mv.prioAuto=true and not already low-PP bumped.
  if (!state.ui._prioDefaultsMetaBandsApplied){
    for (const r of state.roster){
      if (!r) continue;
      const eff = r.effectiveSpecies || r.baseSpecies;
      for (const mv of (r.movePool||[])){
        if (!mv || !mv.name) continue;
        if (mv.prioAuto === false) continue;
        if (mv.lowPpBumped === true) continue;
        mv.prio = defaultPrioForMove(data, eff, mv.name, r.ability || '', {state, entry:r});
        mv.prioAuto = true;
      }
      normalizeMovePool(r);
    }
    state.ui._prioDefaultsMetaBandsApplied = true;
  }


  // One-time upgrade (prio meta bands v2): retune default strength thresholds to
  // P1<75, P2<110, P3<160, P4<220, P5>=220 ("very strong" often >=260); keep Bug/Fight reserve rules; and
  // keep Normal-type attacking moves shifted 1 tier earlier for stronger bands (P3–P5 → P2–P4).
  // Only applies to mv.prioAuto=true and not already low-PP bumped.
  if (!state.ui._prioDefaultsMetaBandsAppliedV2){
    for (const r of state.roster){
      if (!r) continue;
      const eff = r.effectiveSpecies || r.baseSpecies;
      for (const mv of (r.movePool||[])){
        if (!mv || !mv.name) continue;
        if (mv.prioAuto === false) continue;
        if (mv.lowPpBumped === true) continue;
        mv.prio = defaultPrioForMove(data, eff, mv.name, r.ability || '', {state, entry:r});
        mv.prioAuto = true;
      }
      normalizeMovePool(r);
    }
    state.ui._prioDefaultsMetaBandsAppliedV2 = true;
  }


  // One-time fix-up: starters should have correct default move priorities and forced Strength.
  if (!state.ui._starterDefaultsApplied){
    for (const r of state.roster){
      if (!r) continue;
      if (!isStarterSpecies(r.baseSpecies)) continue;
      r.strength = true;
      for (const mv of (r.movePool||[])){
        mv.prio = defaultPrioForMove(data, r.baseSpecies, mv.name, r.ability || '', {state, entry:r});
      }
      normalizeMovePool(r);
    }
    state.ui._starterDefaultsApplied = true;
  }

  // Ensure roster assignments do not exceed shared bag totals.
  try{ enforceBagConstraints(data, state, applyCharmRulesSync); }catch(e){ /* ignore */ }

  // Ensure UI flags exist
  if (!('overviewCollapsed' in state.ui)) state.ui.overviewCollapsed = true;

  // Migrate legacy waveTeams -> wavePlans
  if (state.waveTeams){
    for (const [wk,obj] of Object.entries(state.waveTeams||{})){
      if (!state.wavePlans[wk]){
        const team2 = (obj && obj.team) ? obj.team.filter(id => !!byId(state.roster, id)) : [];
        state.wavePlans[wk] = {
          attackers: team2.slice(0,16),
          attackerStart: team2.slice(0,2),
          defenders: [],
          defenderStart: [],
        };
      }
    }
    delete state.waveTeams;
  }

  // Prune invalid wave plan selections (roster edits)
  for (const [wk,wp] of Object.entries(state.wavePlans||{})){
    const activeIds = new Set(state.roster.filter(r=>r.active).map(r=>r.id));
    const attackers = (wp.attackers||[]).filter(id => activeIds.has(id)).slice(0,16);
    const attackerStart = (wp.attackerStart||[]).filter(id => attackers.includes(id)).slice(0,2);

    // Prune invalid defender rowKeys (data changed / removed slots)
    const waveRowKeys = new Set((data.calcSlots||[]).filter(sl=>String(sl.waveKey||'')===String(wk)).map(sl=>String(sl.rowKey||sl.key||'')));
    const defenders = (wp.defenders||[]).map(x=>String(x||'')).filter(rk => waveRowKeys.has(rk));
    const defenderStart = (wp.defenderStart||[]).map(x=>String(x||'')).filter(rk => waveRowKeys.has(rk)).slice(0,2);
    // Canonicalize any forced-move overrides.
    let attackMoveOverride = wp.attackMoveOverride || null;
    if (attackMoveOverride && typeof attackMoveOverride === 'object'){
      const o2 = {};
      for (const [rid, mv] of Object.entries(attackMoveOverride)){
        o2[rid] = fixMoveName(mv);
      }
      attackMoveOverride = o2;
    }

    state.wavePlans[wk] = {
      ...wp,
      attackers,
      attackerStart: attackerStart.length ? attackerStart : attackers.slice(0,2),
      defenders,
      defenderStart,
      fightLog: Array.isArray(wp.fightLog) ? wp.fightLog : [],
      attackMoveOverride,
    };
  }

  return state;
}
