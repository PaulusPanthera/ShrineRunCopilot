// js/state/migrate.js
// v13 — hydrate + migrate persisted state

import { fixName } from '../data/nameFixes.js';
import { STARTERS, makeRosterEntryFromClaimedSet, applyCharmRulesSync, normalizeMovePool, defaultPrioForMove, isStarterSpecies } from '../domain/roster.js';
import { enforceBagConstraints } from '../domain/items.js';

function deepClone(x){
  return JSON.parse(JSON.stringify(x));
}

function byId(arr, id){
  return arr.find(x => x.id === id);
}

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

  // ---- Settings key migration (waves builds) ----
  // Some branches store startAnimal instead of startWaveAnimal.
  if (!('startWaveAnimal' in state.settings) && ('startAnimal' in state.settings)){
    state.settings.startWaveAnimal = state.settings.startAnimal || 'Goat';
  }
  if (!('startAnimal' in state.settings) && ('startWaveAnimal' in state.settings)){
    state.settings.startAnimal = state.settings.startWaveAnimal || 'Goat';
  }
  if (!('sturdyAoeSolve' in state.settings)) state.settings.sturdyAoeSolve = true;
  if (!('allowFriendlyFire' in state.settings)) state.settings.allowFriendlyFire = false;
  if (!('variationLimit' in state.settings)) state.settings.variationLimit = 8;
  if (!('variationGenCap' in state.settings)) state.settings.variationGenCap = 5000;

  state.unlocked = state.unlocked || {};
  state.cleared = state.cleared || {};
  state.roster = Array.isArray(state.roster) ? state.roster : [];
  state.bag = state.bag || {};
  state.wallet = state.wallet || {};
  if (!('gold' in state.wallet)) state.wallet.gold = (defaultState.wallet && Number(defaultState.wallet.gold)) ? Number(defaultState.wallet.gold) : 0;

  // Politoed shop migration: newer bag UI uses state.shop.{gold,ledger}.
  // - If a legacy build stored wallet.gold, move it into shop.gold (non-destructive).
  // - If a legacy build stored ui.bagUndo, convert it into shop.ledger for the new Undo button.
  state.shop = state.shop || {gold:0, ledger:[]};
  if (!('gold' in state.shop)) state.shop.gold = 0;
  if (!Array.isArray(state.shop.ledger)) state.shop.ledger = [];

  // If shop gold is empty but wallet has gold, seed shop from wallet.
  if (!(Number(state.shop.gold)||0) && (Number(state.wallet.gold)||0)){
    state.shop.gold = Math.max(0, Math.floor(Number(state.wallet.gold)||0));
  }

  // Convert legacy bagUndo -> shop ledger (best-effort)
  if (Array.isArray(state.ui?.bagUndo) && state.ui.bagUndo.length && (!state.shop.ledger || !state.shop.ledger.length)){
    try{
      state.shop.ledger = state.ui.bagUndo.map(rec=>({
        ts: rec.at || Date.now(),
        type: rec.type || 'tx',
        item: rec.item,
        qty: rec.qty || 1,
        goldDelta: rec.goldDelta || 0,
        rosterRestore: rec.rosterRestore,
      })).slice(-80);
    }catch(e){ /* ignore */ }
  }
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
  state.dexMetaCache = state.dexMetaCache || {};
  state.dexApiCache = state.dexApiCache || {};
  state.dexMoveCache = state.dexMoveCache || {};

  // Dex API cache shape migration: older builds stored "types" (modern typings).
  // New builds store "typesGen5" only; copy forward to avoid blank UI until refetch.
  for (const [k,v] of Object.entries(state.dexApiCache||{})){
    if (!v || typeof v !== 'object') continue;
    if (!('typesGen5' in v) && Array.isArray(v.types) && v.types.length){
      v.typesGen5 = v.types.slice();
    }
  }

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

    // If movePool empty, rebuild
    if (r.movePool.length === 0 && data.claimedSets?.[r.baseSpecies]){
      const fresh = makeRosterEntryFromClaimedSet(data, r.baseSpecies);
      r.ability = r.ability || fresh.ability;
      r.movePool = fresh.movePool;
    }

    // Charm rules + effectiveSpecies
    applyCharmRulesSync(data, state, r);
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
  if (!Array.isArray(state.ui.bagUndo)) state.ui.bagUndo = [];
  if (!('settingsDefaultsTab' in state.ui)) state.ui.settingsDefaultsTab = 'atk';

  // Pokédex navigation migration (v32 dex UI): map legacy dexReturn -> dexReturnTab/rosterId
  if (state.ui.dexReturn && !state.ui.dexReturnTab){
    try{
      const r0 = state.ui.dexReturn;
      if (r0 && typeof r0 === 'object'){
        if (r0.tab) state.ui.dexReturnTab = r0.tab;
        if (r0.selectedRosterId) state.ui.dexReturnRosterId = r0.selectedRosterId;
      }
    }catch(e){ /* ignore */ }
  }
  if (!state.ui.lastNonDexTab){
    const t = state.ui.tab;
    state.ui.lastNonDexTab = (t && t !== 'unlocked') ? t : 'waves';
  }
  if (!state.ui.dexDefenderLevelByBase) state.ui.dexDefenderLevelByBase = {};
  // If an old build stored a single defender level, seed it for the currently open base.
  if (state.ui.dexDefenderLevel && state.ui.dexDetailBase){
    const b = fixName(state.ui.dexDetailBase);
    if (b && !(b in state.ui.dexDefenderLevelByBase)) state.ui.dexDefenderLevelByBase[b] = state.ui.dexDefenderLevel;
  }
  // Grid resolve flags
  if (!('dexGridReady' in state.ui)) state.ui.dexGridReady = false;
  if (!('dexGridBuiltN' in state.ui)) state.ui.dexGridBuiltN = 0;

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
    state.wavePlans[wk] = {
      ...wp,
      attackers,
      attackerStart: attackerStart.length ? attackerStart : attackers.slice(0,2),
    };
  }

  return state;
}
