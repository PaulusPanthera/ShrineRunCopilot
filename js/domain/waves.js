// js/domain/waves.js
// v13 — wave planning domain logic

import { fixName } from '../data/nameFixes.js';
import { buildDefaultMovePool } from './roster.js';

function clampInt(v, lo, hi){
  const n = Number.parseInt(String(v), 10);
  const x = Number.isFinite(n) ? n : lo;
  return Math.max(lo, Math.min(hi, x));
}

function uniq(arr){
  return Array.from(new Set(arr));
}

function byId(arr, id){
  return arr.find(x => x.id === id);
}

// Optional forced move override (set in Fight plan).
// If a wave plan sets wp.attackMoveOverride[attackerId] = moveName,
// calculations will restrict that attacker to the selected move.
function movePoolForWave(wp, attacker){
  const pool = (attacker && attacker.movePool) ? attacker.movePool : [];
  const id = attacker ? attacker.id : null;
  const forced = (wp && wp.attackMoveOverride && id) ? (wp.attackMoveOverride[id] || null) : null;
  if (!forced) return pool;
  const filtered = (pool||[]).filter(m => m && m.use !== false && m.name === forced);
  return filtered.length ? filtered : pool;
}


export function phaseDefenderLimit(phase){
  if (phase === 1) return 2;
  if (phase === 2) return 3;
  return 4;
}

export function ensureWaveMods(wp){
  wp.monMods = wp.monMods || {atk:{}, def:{}};
  wp.monMods.atk = wp.monMods.atk || {};
  wp.monMods.def = wp.monMods.def || {};
  return wp.monMods;
}

export const WAVE_DEF_DEFAULT = {hpPct:100, atkStage:0, spaStage:0, defStage:0, spdStage:0, speStage:0};
export const WAVE_ATK_DEFAULT = {hpPct:100, atkStage:0, spaStage:0, defStage:0, spdStage:0, speStage:0};

export function defaultWaveAtkMods(settings){
  const d = (settings && settings.defaultAtkMods) ? settings.defaultAtkMods : {};
  return {...WAVE_ATK_DEFAULT, ...(d||{})};
}

export function defaultWaveDefMods(settings){
  const d = (settings && settings.defaultDefMods) ? settings.defaultDefMods : {};
  return {...WAVE_DEF_DEFAULT, ...(d||{})};
}

export function getWaveDefMods(settings, wp, rowKey){
  ensureWaveMods(wp);
  return {...defaultWaveDefMods(settings), ...((wp.monMods?.def && wp.monMods.def[rowKey]) || {})};
}

export function getWaveAtkMods(settings, wp, attackerId){
  ensureWaveMods(wp);
  return {...defaultWaveAtkMods(settings), ...((wp.monMods?.atk && wp.monMods.atk[attackerId]) || {})};
}

export function settingsForWave(state, wp, attackerId, defenderRowKey){
  const rosterMon = attackerId ? byId(state.roster||[], attackerId) : null;
  const attackerItem = rosterMon?.item || null;

  // Attacker mods are GLOBAL (stored on the roster mon), with optional per-wave overrides.
  const globalAm = (rosterMon && rosterMon.mods) ? rosterMon.mods : {};
  const waveAm = (wp && wp.monMods && wp.monMods.atk && attackerId) ? (wp.monMods.atk[attackerId] || {}) : {};
  const am = attackerId
    ? ({...defaultWaveAtkMods(state.settings), ...(globalAm||{}), ...(waveAm||{})})
    : defaultWaveAtkMods(state.settings);
  const dm = defenderRowKey ? getWaveDefMods(state.settings, wp, defenderRowKey) : defaultWaveDefMods(state.settings);

  const hpPct = clampInt((dm.hpPct ?? 100), 1, 100);

  return {
    ...state.settings,

    // Held items
    attackerItem,
    defenderItem: null,

    // Attacker modifiers (per-mon)
    atkStage: clampInt((am.atkStage ?? 0), -6, 6),
    spaStage: clampInt((am.spaStage ?? 0), -6, 6),
    speStage: clampInt((am.speStage ?? 0), -6, 6),
    defStage: clampInt((am.defStage ?? 0), -6, 6),
    spdStage: clampInt((am.spdStage ?? 0), -6, 6),

    // Defender modifiers (per-mon)
    enemyDefStage: clampInt((dm.defStage ?? 0), -6, 6),
    enemySpdStage: clampInt((dm.spdStage ?? 0), -6, 6),
    enemySpeStage: clampInt((dm.speStage ?? 0), -6, 6),

    // Defender offensive stages (used for threat model)
    enemyAtkStage: clampInt((dm.atkStage ?? 0), -6, 6),
    enemySpaStage: clampInt((dm.spaStage ?? 0), -6, 6),

    defenderHpFrac: hpPct / 100,
  };
}

// Incoming damage model (defender -> your attacker)
// Default: use the defender's real, hardcoded species moves (same source as attackers).
// Fallback: assumed generic STAB hit (only if moveset is missing).
export const ENEMY_ASSUMED_POWER = 80; // fallback

// Simple AoE move detection for battle sim + incoming previews.
// Treat these as hitting BOTH opponents (double battles) unless proven otherwise.
const AOE_MOVES = new Set([
  'Electroweb','Rock Slide','Earthquake','Surf','Heat Wave','Discharge','Icy Wind','Bulldoze','Muddy Water',
  'Dazzling Gleam','Sludge Wave','Lava Plume',
  'Air Cutter',
]);

function isAoeMove(name){
  return AOE_MOVES.has(String(name||''));
}

function enemyMovePoolForSpecies(data, species){
  const set = data.claimedSets?.[species];
  const moves = (set && Array.isArray(set.moves)) ? set.moves : [];
  if (!moves.length) return null;
  return buildDefaultMovePool(data, species, moves, 'base');
}

// Compute best incoming hit from the defender to the chosen attacker using real species moves.
export function enemyThreatForMatchup(data, state, wp, attackerRosterMon, defSlot){
  try{
    if (!(state.settings?.threatModelEnabled ?? true)) return null;
    if (!attackerRosterMon || !defSlot) return null;

    const enemySpecies = defSlot.defender;
    const mySpecies = attackerRosterMon.effectiveSpecies || attackerRosterMon.baseSpecies;
    if (!data.dex?.[enemySpecies] || !data.dex?.[mySpecies]) return null;

    const pool = enemyMovePoolForSpecies(data, enemySpecies);
    if (!pool || !pool.length) return null;

    const dm = getWaveDefMods(state.settings, wp, defSlot.rowKey);
    const globalAm = (attackerRosterMon && attackerRosterMon.mods) ? attackerRosterMon.mods : {};
    const waveAm = (wp && wp.monMods && wp.monMods.atk) ? (wp.monMods.atk[attackerRosterMon.id] || {}) : {};
    const am = {...defaultWaveAtkMods(state.settings), ...(globalAm||{}), ...(waveAm||{})};

    const enemy = {
      species: enemySpecies,
      level: defSlot.level,
      ivAll: state.settings.wildIV,
      evAll: state.settings.wildEV,
    };
    const me = {
      species: mySpecies,
      level: state.settings.claimedLevel,
      ivAll: state.settings.claimedIV,
      evAll: attackerRosterMon.strength ? state.settings.strengthEV : state.settings.claimedEV,
    };

    const hpFrac = clampInt((am.hpPct ?? 100), 1, 100) / 100;

    // Swap roles: enemy is attacker, you are defender.
    // Use defender offensive stages (Atk/SpA/Spe) and your defensive stages (Def/SpD/Spe).
    const s = {
      ...state.settings,
      defenderHpFrac: hpFrac,

      // Items: enemy has none (for now). Your held item can affect defense (e.g., Assault Vest) and speed.
      attackerItem: null,
      defenderItem: attackerRosterMon.item || null,

      // enemy offense stages
      atkStage: clampInt(dm.atkStage ?? 0, -6, 6),
      spaStage: clampInt(dm.spaStage ?? 0, -6, 6),
      speStage: clampInt(dm.speStage ?? 0, -6, 6),

      // your bulk stages
      enemyDefStage: clampInt(am.defStage ?? 0, -6, 6),
      enemySpdStage: clampInt(am.spdStage ?? 0, -6, 6),
      enemySpeStage: clampInt(am.speStage ?? 0, -6, 6),

      // INT/STU tags are used mainly for your outgoing planning. Keep them off for incoming.
      applyINT: false,
      applySTU: false,
    };

    // Enemy move selection rule:
    // - prefers the move with the highest OHKO chance (if any can OHKO)
    // - otherwise, chooses the move that deals the most damage (highest min%)
    const candidates = (pool||[]).filter(m => m && m.use !== false);
    const all = [];
    for (const m of candidates){
      const r = window.SHRINE_CALC.computeDamageRange({
        data,
        attacker: enemy,
        defender: me,
        moveName: m.name,
        settings: s,
        tags: defSlot.tags || [],
      });
      if (!r || !r.ok) continue;

      const minPct = Number(r.minPct)||0;
      const maxPct = Number(r.maxPct)||minPct;
      const oneShot = !!r.oneShot;
      let ohkoChance = 0;
      if (maxPct >= 100){
        if (minPct >= 100) ohkoChance = 1;
        else {
          const denom = (maxPct - minPct);
          ohkoChance = denom > 0 ? (maxPct - 100) / denom : 0;
          ohkoChance = Math.max(0, Math.min(1, ohkoChance));
        }
      }
    all.push({...r, prio: Number(m.prio)||2, ohkoChance, oneShot, aoe: isAoeMove(r.move)});
    }

    if (!all.length) return null;

    const anyChance = all.some(x => x.ohkoChance > 0);
    all.sort((a,b)=>{
      if (anyChance){
        if (a.ohkoChance !== b.ohkoChance) return b.ohkoChance - a.ohkoChance;
      }
      if (a.minPct !== b.minPct) return b.minPct - a.minPct;
      if ((a.maxPct||0) !== (b.maxPct||0)) return (b.maxPct||0) - (a.maxPct||0);
      return String(a.move||'').localeCompare(String(b.move||''));
    });

    const best = all[0];

    const enemySpe = best.attackerSpe ?? 0;
    const mySpe = best.defenderSpe ?? 0;
    const enemyFaster = enemySpe > mySpe;
    const tie = enemySpe === mySpe;
    const tieActsFirst = (state.settings?.enemySpeedTieActsFirst ?? true);
    const enemyActsFirst = enemyFaster || (tie && tieActsFirst);
    const diesBeforeMove = enemyActsFirst && !!best.oneShot;

    return {
      ...best,
      enemyFaster,
      speedTie: tie,
      enemyActsFirst,
      diesBeforeMove,
      aoe: !!best.aoe,
      assumed: false,
    };
  }catch(e){
    return null;
  }
}

// Fallback if defender move pool is unknown.
export function assumedEnemyThreatForMatchup(data, state, wp, attackerRosterMon, defSlot){
  try{
    if (!(state.settings?.threatModelEnabled ?? true)) return null;
    if (!attackerRosterMon || !defSlot) return null;
    const enemyDex = data.dex[defSlot.defender];
    const myDex = data.dex[attackerRosterMon.effectiveSpecies || attackerRosterMon.baseSpecies];
    if (!enemyDex || !myDex) return null;

    const dm = getWaveDefMods(state.settings, wp, defSlot.rowKey);
    const globalAm = (attackerRosterMon && attackerRosterMon.mods) ? attackerRosterMon.mods : {};
    const waveAm = (wp && wp.monMods && wp.monMods.atk) ? (wp.monMods.atk[attackerRosterMon.id] || {}) : {};
    const am = {...defaultWaveAtkMods(state.settings), ...(globalAm||{}), ...(waveAm||{})};

    const enemy = {
      species: defSlot.defender,
      level: defSlot.level,
      ivAll: state.settings.wildIV,
      evAll: state.settings.wildEV,
    };
    const me = {
      species: attackerRosterMon.effectiveSpecies || attackerRosterMon.baseSpecies,
      level: state.settings.claimedLevel,
      ivAll: state.settings.claimedIV,
      evAll: attackerRosterMon.strength ? state.settings.strengthEV : state.settings.claimedEV,
    };

    const hpFrac = clampInt((am.hpPct ?? 100), 1, 100) / 100;

    const s = {
      ...state.settings,
      defenderHpFrac: hpFrac,
      attackerItem: null,
      defenderItem: attackerRosterMon.item || null,
      // enemy offense stages (as attacker)
      atkStage: clampInt(dm.atkStage ?? 0, -6, 6),
      spaStage: clampInt(dm.spaStage ?? 0, -6, 6),
      speStage: clampInt(dm.speStage ?? 0, -6, 6),
      // your bulk stages (as defender)
      enemyDefStage: clampInt(am.defStage ?? 0, -6, 6),
      enemySpdStage: clampInt(am.spdStage ?? 0, -6, 6),
      enemySpeStage: clampInt(am.speStage ?? 0, -6, 6),
      // don't apply intimidate/sturdy in this approximation
      applyINT: false,
      applySTU: false,
    };

    const types = Array.isArray(enemyDex.types) && enemyDex.types.length ? enemyDex.types : ['Normal'];
    const cats = ['Physical','Special'];

    const assumedPower = Number(state.settings?.enemyAssumedPower);
    const power = (Number.isFinite(assumedPower) && assumedPower > 0) ? assumedPower : ENEMY_ASSUMED_POWER;

    let best = null;
    for (const type of types){
      for (const category of cats){
        const r = window.SHRINE_CALC.computeGenericDamageRange({
          data,
          attacker: enemy,
          defender: me,
          profile: {type, category, power},
          settings: s,
          tags: [],
        });
        if (!r || !r.ok) continue;
        if (!best) { best = r; continue; }
        const aOHKO = !!r.oneShot;
        const bOHKO = !!best.oneShot;
        if (aOHKO !== bOHKO) { if (aOHKO) best = r; continue; }
        if ((r.minPct ?? 0) > (best.minPct ?? 0)) best = r;
      }
    }

    if (!best) return null;

    const enemyFaster = (best.attackerSpe ?? 0) > (best.defenderSpe ?? 0);
    const tie = (best.attackerSpe ?? 0) === (best.defenderSpe ?? 0);
    const tieActsFirst = (state.settings?.enemySpeedTieActsFirst ?? true);
    const enemyActsFirst = enemyFaster || (tie && tieActsFirst);
    const diesBeforeMove = enemyActsFirst && !!best.oneShot;

    return {
      ...best,
      enemyFaster,
      speedTie: tie,
      enemyActsFirst,
      diesBeforeMove,
      assumed: true,
    };
  }catch(e){
    return null;
  }
}

function normalizeOrder(order, starters){
  const s = (starters||[]).slice(0,2);
  if (s.length < 2) return s;
  const o = (order||[]).filter(x=>s.includes(x));
  if (o.length === 2) return o;
  if (o.length === 1) return [o[0], s.find(x=>x!==o[0])];
  return s;
}

export function ensureWavePlan(data, state, waveKey, slots){
  state.wavePlans = state.wavePlans || {};
  const phase = Number(slots[0]?.phase || 1);
  const limit = phaseDefenderLimit(phase);

  let wp = state.wavePlans[waveKey];
  if (!wp){
    wp = state.wavePlans[waveKey] = {attackers:[], attackerStart:[], defenders:[], defenderStart:[]};
  }

  // Defenders from this wave
  // NOTE: we allow instance keys like "P1W1S1#2" to represent duplicate encounters.
  // The base rowKey is the part before '#'.
  const slotByKey = new Map(slots.map(s=>[s.rowKey, s]));
  const baseKey = (k)=> String(k||'').split('#')[0];
  ensureWaveMods(wp);
  wp.defenders = (wp.defenders||[]).filter(rk => slotByKey.has(baseKey(rk))).slice(0, limit);

  if (!wp.defenders.length){
    const prefer = slots.filter(s=>!state.cleared[s.rowKey]);
    const base = prefer.length ? prefer : slots;
    wp.defenders = base.slice(0, limit).map(s=>s.rowKey);
  }

  wp.defenderStart = (wp.defenderStart||[]).filter(rk => wp.defenders.includes(rk)).slice(0,2);
  if (wp.defenderStart.length < 2) wp.defenderStart = wp.defenders.slice(0,2);
  wp.defenderOrder = normalizeOrder(wp.defenderOrder, wp.defenderStart);

  // Attackers from active roster
  const activeRoster = (state.roster||[]).filter(r=>r.active);
  const validIds = new Set(activeRoster.map(r=>r.id));
  // Global pool: always derived from active roster (up to 16).
  wp.attackers = activeRoster.slice(0,16).map(r=>r.id);
  if (wp.attackers.length < 2) wp.attackers = activeRoster.slice(0,2).map(r=>r.id);

  wp.attackerStart = (wp.attackerStart||[]).filter(id=>wp.attackers.includes(id)).slice(0,2);
  if (wp.attackerStart.length < 2) wp.attackerStart = wp.attackers.slice(0,2);
  wp.attackerOrder = normalizeOrder(wp.attackerOrder, wp.attackerStart);

  // Per-mon battle modifiers
  wp.monMods = wp.monMods || {atk:{}, def:{}};
  wp.monMods.atk = wp.monMods.atk || {};
  wp.monMods.def = wp.monMods.def || {};

  // Auto-match always ON unless manual override
  state.settings.autoMatch = true;
  if (state.settings.autoMatch && !wp.manualOrder){
    try{
      // If starters are not manually pinned, auto-pick the best pair from the active roster pool.
      if (!wp.manualStarters){
        autoPickStartersAndOrdersForWave(data, state, wp, slotByKey);
      } else {
        autoPickOrdersForWave(data, state, wp, slotByKey);
      }
    }catch(e){ /* ignore */ }
  }



  // Wave fights (4 players): store per-wave progress
  if (!Array.isArray(wp.fights) || wp.fights.length !== 4){
    const basePair = (wp.attackerStart||[]).slice(0,2);
    wp.fights = Array.from({length:4}).map(()=>({
      attackers: basePair.length===2 ? basePair.slice() : [null,null],
      done: false,
      summary: null,
    }));
  }

  // Per-wave fight log (replaces Wave fights UI). Newest first.
  if (!Array.isArray(wp.fightLog)) wp.fightLog = [];

  state.wavePlans[waveKey] = wp;
  return wp;
}

// Choose the best 2 starters from wp.attackers (active roster pool), then also choose favorable left/right orders.
export function autoPickStartersAndOrdersForWave(data, state, wp, slotByKey){
  const pool = (wp.attackers||[]).slice(0,16);
  const defKeys = (wp.defenderStart||[]).slice(0,2);
  if (pool.length < 2 || defKeys.length < 2) return;

  const baseKey = (k)=> String(k||'').split('#')[0];
  const def0 = slotByKey.get(baseKey(defKeys[0]));
  const def1 = slotByKey.get(baseKey(defKeys[1]));
  if (!def0 || !def1) return;

  const allDefSlots = (wp.defenders||[]).map(k=>slotByKey.get(baseKey(k))).filter(Boolean);

  // Targeting assumption: any active battler can target any enemy.
  // For lead-pair scoring we try both assignments (A->left/B->right and swap) and pick the better tuple.
  const scoreFor = (aL, aR, defOrder)=>{
    const dA = slotByKey.get(baseKey(defOrder[0]));
    const dB = slotByKey.get(baseKey(defOrder[1]));
    if (!dA || !dB) return {score:-Infinity};

    const defA = {species:dA.defender, level:dA.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
    const defB = {species:dB.defender, level:dB.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};

    const atkObj = (r, s)=>({
      species:(r.effectiveSpecies||r.baseSpecies),
      level: s.claimedLevel,
      ivAll: s.claimedIV,
      evAll: r.strength ? s.strengthEV : s.claimedEV,
    });

    const bestVs = (att, def, defSlot)=>{
      const sW = settingsForWave(state, wp, att.id, defSlot.rowKey);
      return window.SHRINE_CALC.chooseBestMove({
        data,
        attacker: atkObj(att, sW),
        defender: def,
        movePool: movePoolForWave(wp, att),
        settings: sW,
        tags: defSlot.tags||[],
      }).best;
    };

    const a_vs_A = bestVs(aL, defA, dA);
    const a_vs_B = bestVs(aL, defB, dB);
    const b_vs_A = bestVs(aR, defA, dA);
    const b_vs_B = bestVs(aR, defB, dB);

    const tuple = (m0, m1)=>{
      // Primary: minimize worst-case (ensure both starters have OHKO coverage)
      const bothOhko = (m0?.oneShot && m1?.oneShot) ? 2 : ((m0?.oneShot || m1?.oneShot) ? 1 : 0);
      const worstPrio = Math.max(m0?.prio ?? 9, m1?.prio ?? 9);
      const prioSum = (m0?.prio ?? 9) + (m1?.prio ?? 9);
      const overkillSum = Math.abs((m0?.minPct ?? 0) - 100) + Math.abs((m1?.minPct ?? 0) - 100);
      return {bothOhko, worstPrio, prioSum, overkillSum};
    };

    const t1 = tuple(a_vs_A, b_vs_B);
    const t2 = tuple(a_vs_B, b_vs_A);

    const betterTuple = (x,y)=>{
      if (x.bothOhko !== y.bothOhko) return x.bothOhko > y.bothOhko;
      if (x.worstPrio !== y.worstPrio) return x.worstPrio < y.worstPrio;
      if (x.prioSum !== y.prioSum) return x.prioSum < y.prioSum;
      return x.overkillSum <= y.overkillSum;
    };

    const lead = betterTuple(t1,t2) ? t1 : t2;

    // Starters-only clear all selected defenders (3/4): at least one can OHKO each.
    let startersClear = 0;
    for (const ds of allDefSlots){
      const defObj = {species:ds.defender, level:ds.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
      const b0 = window.SHRINE_CALC.chooseBestMove({
        data,
        attacker:{species:(aL.effectiveSpecies||aL.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: aL.strength?state.settings.strengthEV:state.settings.claimedEV},
        defender:defObj,
        movePool: movePoolForWave(wp, aL),
        settings: settingsForWave(state, wp, aL.id, ds.rowKey),
        tags: ds.tags||[],
      }).best;
      const b1 = window.SHRINE_CALC.chooseBestMove({
        data,
        attacker:{species:(aR.effectiveSpecies||aR.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: aR.strength?state.settings.strengthEV:state.settings.claimedEV},
        defender:defObj,
        movePool: movePoolForWave(wp, aR),
        settings: settingsForWave(state, wp, aR.id, ds.rowKey),
        tags: ds.tags||[],
      }).best;
      if ((b0 && b0.oneShot) || (b1 && b1.oneShot)) startersClear += 1;
    }

    // Survival penalty
    let deathPenalty = 0;
    const t0 = enemyThreatForMatchup(data, state, wp, aL, dA) || assumedEnemyThreatForMatchup(data, state, wp, aL, dA);
    const t1t = enemyThreatForMatchup(data, state, wp, aR, dB) || assumedEnemyThreatForMatchup(data, state, wp, aR, dB);
    if (t0?.diesBeforeMove) deathPenalty += 1;
    if (t1t?.diesBeforeMove) deathPenalty += 1;

    const score = (startersClear * 1_000_000)
      + (lead.bothOhko * 10_000)
      - (lead.worstPrio * 1_000)
      - (lead.prioSum * 100)
      - (lead.overkillSum)
      - (deathPenalty * 50_000);

    return {score};
  };

  let best = null;
  for (let i=0;i<pool.length;i++){
    for (let j=i+1;j<pool.length;j++){
      const a0 = byId(state.roster, pool[i]);
      const a1 = byId(state.roster, pool[j]);
      if (!a0 || !a1) continue;

      const atkOrders = [[a0,a1],[a1,a0]];
      const defOrders = [[def0.rowKey, def1.rowKey],[def1.rowKey, def0.rowKey]];
      for (const [aL,aR] of atkOrders){
        for (const dOrd of defOrders){
          const sc = scoreFor(aL,aR,dOrd);
          if (!best || sc.score > best.score){
            best = {score: sc.score, atk:[aL.id,aR.id], def:dOrd};
          }
        }
      }
    }
  }

  if (best){
    wp.attackerStart = best.atk.slice(0,2);
    wp.attackerOrder = best.atk.slice(0,2);
    wp.defenderOrder = best.def.slice(0,2);
  }
}

export function autoPickOrdersForWave(data, state, wp, slotByKey){
  const atkIds = (wp.attackerStart||[]).slice(0,2);
  const defKeys = (wp.defenderStart||[]).slice(0,2);
  if (atkIds.length < 2 || defKeys.length < 2) return;

  const baseKey = (k)=> String(k||'').split('#')[0];

  const atk0 = byId(state.roster, atkIds[0]);
  const atk1 = byId(state.roster, atkIds[1]);
  const def0 = slotByKey.get(baseKey(defKeys[0]));
  const def1 = slotByKey.get(baseKey(defKeys[1]));
  if (!atk0 || !atk1 || !def0 || !def1) return;

  const atkOrders = [[atk0.id, atk1.id],[atk1.id, atk0.id]];
  const defOrders = [[def0.rowKey, def1.rowKey],[def1.rowKey, def0.rowKey]];

  const allDefSlots = (wp.defenders||[]).map(k=>slotByKey.get(baseKey(k))).filter(Boolean);

  const scorePlan = (atkOrder, defOrder)=>{
    const aL = byId(state.roster, atkOrder[0]);
    const aR = byId(state.roster, atkOrder[1]);
    const dL = slotByKey.get(defOrder[0]);
    const dR = slotByKey.get(defOrder[1]);
    if (!aL || !aR || !dL || !dR) return {score:-Infinity};

    const defLeft = {species:dL.defender, level:dL.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
    const defRight = {species:dR.defender, level:dR.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};

    const bestL = window.SHRINE_CALC.chooseBestMove({
      data,
      attacker:{species:(aL.effectiveSpecies||aL.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: aL.strength?state.settings.strengthEV:state.settings.claimedEV},
      defender:defLeft,
      movePool: movePoolForWave(wp, aL),
      settings: settingsForWave(state, wp, aL.id, dL.rowKey),
      tags: dL.tags||[],
    }).best;
    const bestR = window.SHRINE_CALC.chooseBestMove({
      data,
      attacker:{species:(aR.effectiveSpecies||aR.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: aR.strength?state.settings.strengthEV:state.settings.claimedEV},
      defender:defRight,
      movePool: movePoolForWave(wp, aR),
      settings: settingsForWave(state, wp, aR.id, dR.rowKey),
      tags: dR.tags||[],
    }).best;

    const bothOhko = (bestL?.oneShot && bestR?.oneShot) ? 2 : ((bestL?.oneShot || bestR?.oneShot) ? 1 : 0);
    const worstPrio = Math.max(bestL?.prio ?? 9, bestR?.prio ?? 9);
    const prioSum = (bestL?.prio ?? 9) + (bestR?.prio ?? 9);
    const overkillSum = Math.abs((bestL?.minPct ?? 0) - 100) + Math.abs((bestR?.minPct ?? 0) - 100);

    // Primary: starters-only clear all selected defenders (3/4)
    let startersClear = 0;
    for (const ds of allDefSlots){
      const defObj = {species:ds.defender, level:ds.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
      const b0 = window.SHRINE_CALC.chooseBestMove({
        data,
        attacker:{species:(aL.effectiveSpecies||aL.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: aL.strength?state.settings.strengthEV:state.settings.claimedEV},
        defender:defObj,
        movePool: movePoolForWave(wp, aL),
        settings: settingsForWave(state, wp, aL.id, ds.rowKey),
        tags: ds.tags||[],
      }).best;
      const b1 = window.SHRINE_CALC.chooseBestMove({
        data,
        attacker:{species:(aR.effectiveSpecies||aR.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: aR.strength?state.settings.strengthEV:state.settings.claimedEV},
        defender:defObj,
        movePool: movePoolForWave(wp, aR),
        settings: settingsForWave(state, wp, aR.id, ds.rowKey),
        tags: ds.tags||[],
      }).best;
      if ((b0 && b0.oneShot) || (b1 && b1.oneShot)) startersClear += 1;
    }

    // Survival penalty (enemy acts first + OHKOs you)
    let deathPenalty = 0;
    const t0 = enemyThreatForMatchup(data, state, wp, aL, dL) || assumedEnemyThreatForMatchup(data, state, wp, aL, dL);
    const t1 = enemyThreatForMatchup(data, state, wp, aR, dR) || assumedEnemyThreatForMatchup(data, state, wp, aR, dR);
    if (t0?.diesBeforeMove) deathPenalty += 1;
    if (t1?.diesBeforeMove) deathPenalty += 1;

    const score = (startersClear * 1_000_000)
      + (bothOhko * 10_000)
      - (worstPrio * 1_000)
      - (prioSum * 100)
      - (overkillSum)
      - (deathPenalty * 50_000);

    return {score};
  };

  let best = null;
  for (const ao of atkOrders){
    for (const do2 of defOrders){
      const sc = scorePlan(ao, do2);
      if (!best || sc.score > best.score){
        best = {...sc, atkOrder: ao, defOrder: do2};
      }
    }
  }

  if (best){
    wp.attackerOrder = best.atkOrder;
    wp.defenderOrder = best.defOrder;
  }
}

// Best-effort base prefetch utility (use in UI effect)
export function speciesListFromSlots(slots){
  return uniq((slots||[]).map(s=>fixName(s.defender)).filter(Boolean));
}
