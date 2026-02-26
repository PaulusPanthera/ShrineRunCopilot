// js/state/migrate.js
// v13 — hydrate + migrate persisted state

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

export function hydrateState(raw, defaultState, data){
  let state = raw ? {...deepClone(defaultState), ...raw} : deepClone(defaultState);

  // Ensure defaults
  state.version = defaultState.version;
  state.settings = {...deepClone(defaultState.settings), ...(state.settings||{})};
  state.ui = {...deepClone(defaultState.ui), ...(state.ui||{})};

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
  if (!('simWaveKey' in state.ui)) state.ui.simWaveKey = null;

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

    // v13+: priorities must be 1/2/3
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

  // One-time fix-up: starters should have correct default move priorities and forced Strength.
  if (!state.ui._starterDefaultsApplied){
    for (const r of state.roster){
      if (!r) continue;
      if (!isStarterSpecies(r.baseSpecies)) continue;
      r.strength = true;
      for (const mv of (r.movePool||[])){
        mv.prio = defaultPrioForMove(data, r.baseSpecies, mv.name);
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
