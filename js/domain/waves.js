// js/domain/waves.js
// v2.0.0-beta
// Wave planning domain logic (enemy selection, auto-match scoring, threat model helpers)

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
    // - always chooses the move that deals the MOST damage (avg%),
    //   tie-break: max% then min%, then name.
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
      const avgPct = (minPct + maxPct) / 2;
      all.push({...r, prio: Number(m.prio)||2, ohkoChance, oneShot, avgPct});
    }

    if (!all.length) return null;

    all.sort((a,b)=>{
      const aa = Number(a.avgPct)||0;
      const ba = Number(b.avgPct)||0;
      if (aa !== ba) return ba - aa;
      const ax = Number(a.maxPct)||0;
      const bx = Number(b.maxPct)||0;
      if (ax !== bx) return bx - ax;
      const am = Number(a.minPct)||0;
      const bm = Number(b.minPct)||0;
      if (am !== bm) return bm - am;
      return String(a.move||'').localeCompare(String(b.move||''));
    });

    const best = all[0];
    const pickReason = 'chosen for max dmg';

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
      assumed: false,
      reason: pickReason,
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

    const pickReason = best.oneShot ? 'chosen for OHKO chance' : 'chosen for max dmg';

    return {
      ...best,
      move: `Assumed ${best.moveType} ${best.category}`,
      prio: 2,
      enemyFaster,
      speedTie: tie,
      enemyActsFirst,
      diesBeforeMove,
      assumed: true,
      reason: pickReason,
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
  const slotByKey = new Map(slots.map(s=>[s.rowKey, s]));
  ensureWaveMods(wp);

  // Enemy slots (duplicates allowed). Prefer wp.enemySlots if present; fall back to legacy wp.defenders.
  const rawEnemySlots = Array.isArray(wp.enemySlots)
    ? wp.enemySlots
    : (Array.isArray(wp.defenders) ? wp.defenders : []);

  wp.enemySlots = rawEnemySlots
    .slice(0, limit)
    .map(rk => (rk && slotByKey.has(rk)) ? rk : null);
  while (wp.enemySlots.length < limit) wp.enemySlots.push(null);

  // Legacy field kept for compatibility (now derived from enemySlots)
  wp.defenders = wp.enemySlots.filter(Boolean).slice(0, limit);

  // If the user explicitly managed defender selection, allow an empty selection.
  if (!wp.defenders.length && !wp.manualDefenders){
    const prefer = slots.filter(s=>!state.cleared[s.rowKey]);
    const base = prefer.length ? prefer : slots;
    const picks = base.slice(0, limit).map(s=>s.rowKey);
    wp.enemySlots = picks.slice(0, limit);
    while (wp.enemySlots.length < limit) wp.enemySlots.push(null);
    wp.defenders = picks.slice(0, limit);
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

  state.wavePlans[waveKey] = wp;
  return wp;
}

// Choose the best 2 starters from wp.attackers (active roster pool), then also choose favorable left/right orders.
export function autoPickStartersAndOrdersForWave(data, state, wp, slotByKey){
  const pool = (wp.attackers||[]).slice(0,16);
  const defKeys = (wp.defenderStart||[]).slice(0,2);
  if (pool.length < 2 || defKeys.length < 2) return;

  const defA = slotByKey.get(defKeys[0]);
  const defB = slotByKey.get(defKeys[1]);
  if (!defA || !defB) return;

  let best = null;
  for (let i=0;i<pool.length;i++){
    for (let j=i+1;j<pool.length;j++){
      const a0 = byId(state.roster, pool[i]);
      const a1 = byId(state.roster, pool[j]);
      if (!a0 || !a1) continue;

      const plan = bestAssignmentForWavePair(data, state, wp, a0, a1, defA, defB);
      if (!plan) continue;

      if (!best || betterAssignmentMeta(plan.meta, best.meta)){
        best = {atk:[a0.id,a1.id], meta: plan.meta};
      }
    }
  }

  if (best){
    wp.attackerStart = best.atk.slice(0,2);
    wp.attackerOrder = best.atk.slice(0,2);
    wp.defenderOrder = (wp.defenderStart||[]).slice(0,2);
  }
}

export function autoPickOrdersForWave(data, state, wp, slotByKey){
  // With free targeting in 2v2, left/right order does not affect the plan.
  // Keep a stable, normalized order.
  wp.attackerOrder = normalizeOrder(wp.attackerOrder, (wp.attackerStart||[]).slice(0,2));
  wp.defenderOrder = normalizeOrder(wp.defenderOrder, (wp.defenderStart||[]).slice(0,2));
}

// --- 2v2 targeting helpers ---

function moveDistanceTo100(best){
  const m = Number(best?.minPct);
  if (!Number.isFinite(m)) return 9999;
  return Math.abs(m - 100);
}

function bestMoveForWave(data, state, wp, attackerRosterMon, defSlot){
  if (!attackerRosterMon || !defSlot) return null;
  const attacker = {
    species: attackerRosterMon.effectiveSpecies || attackerRosterMon.baseSpecies,
    level: state.settings.claimedLevel,
    ivAll: state.settings.claimedIV,
    evAll: attackerRosterMon.strength ? state.settings.strengthEV : state.settings.claimedEV,
  };
  const defender = {
    species: defSlot.defender,
    level: defSlot.level,
    ivAll: state.settings.wildIV,
    evAll: state.settings.wildEV,
  };
  const res = window.SHRINE_CALC.chooseBestMove({
    data,
    attacker,
    defender,
    movePool: attackerRosterMon.movePool || attackerRosterMon.moves || [],
    settings: settingsForWave(state, wp, attackerRosterMon.id, defSlot.rowKey),
    tags: defSlot.tags || [],
  });
  return res?.best || null;
}

function defenderPreferredThreat(data, state, wp, defSlot, attackers){
  const pool = (attackers||[]).filter(Boolean);
  if (!defSlot || pool.length === 0) return null;

  let best = null;
  for (const a of pool){
    const t = enemyThreatForMatchup(data, state, wp, a, defSlot) || assumedEnemyThreatForMatchup(data, state, wp, a, defSlot);
    if (!t) continue;
    if (!best){
      best = {attacker:a, threat:t};
      continue;
    }
    const am = Number(t.minPct)||0;
    const bm = Number(best.threat.minPct)||0;
    if (am !== bm){
      if (am > bm) best = {attacker:a, threat:t};
      continue;
    }
    const ax = Number(t.maxPct)||am;
    const bx = Number(best.threat.maxPct)||bm;
    if (ax !== bx){
      if (ax > bx) best = {attacker:a, threat:t};
      continue;
    }
  }
  return best;
}

function scoreAssignment({data, state, wp, assign}){
  let ohko = 0;
  let prioSum = 0;
  let prioWorst = 0;
  let distSum = 0;
  let slowerCount = 0;
  let stabCount = 0;
  let minPctSum = 0;
  let deathPenalty = 0;

  for (const x of (assign||[])){
    const b = x.best;
    if (b?.oneShot) ohko += 1;
    const p = Number.isFinite(b?.prio) ? b.prio : 3;
    prioSum += p;
    prioWorst = Math.max(prioWorst, p);
    distSum += moveDistanceTo100(b);
    if (b?.slower) slowerCount += 1;
    if (b?.stab) stabCount += 1;
    minPctSum += Number(b?.minPct) || 0;

  }

  // Defender targeting (focus-fire): each defender aims at the attacker it can hit hardest.
  // This can cause both defenders to target the same attacker.
  const attackers = uniq((assign||[]).map(x=>x.attacker).filter(Boolean));
  const defenders = (assign||[]).map(x=>x.defSlot).filter(Boolean);
  const focusMinSums = new Map(); // attackerId -> sum(minPct) from enemies that act before
  let diesBeforeMoveCount = 0;
  for (const d of defenders){
    const pick = defenderPreferredThreat(data, state, wp, d, attackers);
    if (!pick || !pick.threat) continue;
    const t = pick.threat;
    if (t.diesBeforeMove) diesBeforeMoveCount += 1;
    if (t.enemyActsFirst){
      const id = pick.attacker.id;
      focusMinSums.set(id, (focusMinSums.get(id)||0) + (Number(t.minPct)||0));
    }
  }

  let focusKOs = 0;
  for (const v of focusMinSums.values()){
    if (v >= 100) focusKOs += 1;
  }

  deathPenalty = diesBeforeMoveCount + focusKOs;

  return {ohko, prioWorst, prioSum, distSum, deathPenalty, slowerCount, stabCount, minPctSum};
}

function betterAssignmentMeta(a, b){
  if (!b) return true;
  if (!a) return false;

  // Scoring order (lexicographic):
  // maximize #OHKOs, then lower prio tier (P1>P2>P3), then lowest overkill (closest-to-100),
  // then speed safety, then STAB preference.
  if (a.ohko !== b.ohko) return a.ohko > b.ohko;
  if (a.prioWorst !== b.prioWorst) return a.prioWorst < b.prioWorst;
  if (a.prioSum !== b.prioSum) return a.prioSum < b.prioSum;
  if (a.distSum !== b.distSum) return a.distSum < b.distSum;
  if (a.deathPenalty !== b.deathPenalty) return a.deathPenalty < b.deathPenalty;
  if (a.slowerCount !== b.slowerCount) return a.slowerCount < b.slowerCount;
  if (a.stabCount !== b.stabCount) return a.stabCount > b.stabCount;
  if (a.minPctSum !== b.minPctSum) return a.minPctSum > b.minPctSum;
  return false;
}

// Any active battler can target any enemy in 2v2.
// Compute the better of the two possible 2v2 target assignments.
export function bestAssignmentForWavePair(data, state, wp, attackerA, attackerB, defSlotA, defSlotB){
  if (!attackerA || !attackerB || !defSlotA || !defSlotB) return null;

  const a_vs_A = bestMoveForWave(data, state, wp, attackerA, defSlotA);
  const a_vs_B = bestMoveForWave(data, state, wp, attackerA, defSlotB);
  const b_vs_A = bestMoveForWave(data, state, wp, attackerB, defSlotA);
  const b_vs_B = bestMoveForWave(data, state, wp, attackerB, defSlotB);

  const assign1 = [
    {attacker: attackerA, defSlot: defSlotA, best: a_vs_A},
    {attacker: attackerB, defSlot: defSlotB, best: b_vs_B},
  ];
  const assign2 = [
    {attacker: attackerA, defSlot: defSlotB, best: a_vs_B},
    {attacker: attackerB, defSlot: defSlotA, best: b_vs_A},
  ];

  const meta1 = scoreAssignment({data, state, wp, assign: assign1});
  const meta2 = scoreAssignment({data, state, wp, assign: assign2});

  const pick1 = betterAssignmentMeta(meta1, meta2);
  return {
    assign: pick1 ? assign1 : assign2,
    meta: pick1 ? meta1 : meta2,
    altMeta: pick1 ? meta2 : meta1,
  };
}

// Best-effort base prefetch utility (use in UI effect)
export function speciesListFromSlots(slots){
  return uniq((slots||[]).map(s=>fixName(s.defender)).filter(Boolean));
}
