// js/domain/battle.js
// Battle simulator for Abundant Shrine — simple deterministic turn engine.
// - Default PP is 12 for every move (until proven otherwise).
// - Uses SHRINE_CALC computeDamageRange for min% damage and speed.
// - Supports manual move + target selection and reinforcement choice.

import { settingsForWave, enemyThreatForMatchup, assumedEnemyThreatForMatchup } from './waves.js';

export const DEFAULT_MOVE_PP = 12;

function byId(arr, id){
  return (arr||[]).find(x => x && x.id === id);
}

function uniq(arr){
  const out = [];
  for (const x of (arr||[])) if (x != null && !out.includes(x)) out.push(x);
  return out;
}

function clampPct(x){
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

export function ensurePPForRosterMon(state, rosterMon){
  if (!state || !rosterMon) return;
  state.pp = state.pp || {};
  const id = rosterMon.id;
  state.pp[id] = state.pp[id] || {};

  const pool = (rosterMon.movePool||[]).filter(m => m && m.use !== false);
  for (const m of pool){
    const name = m.name;
    if (!name) continue;
    const cur = state.pp[id][name];
    if (!cur || typeof cur !== 'object'){
      state.pp[id][name] = {cur: DEFAULT_MOVE_PP, max: DEFAULT_MOVE_PP};
    } else {
      if (!('max' in cur)) cur.max = DEFAULT_MOVE_PP;
      if (!('cur' in cur)) cur.cur = cur.max;
      if (!Number.isFinite(Number(cur.max)) || Number(cur.max) <= 0) cur.max = DEFAULT_MOVE_PP;
      if (!Number.isFinite(Number(cur.cur))) cur.cur = cur.max;
      cur.max = Number(cur.max);
      cur.cur = clampInt(cur.cur, 0, cur.max);
    }
  }
}

function clampInt(v, lo, hi){
  const n = Number.parseInt(String(v), 10);
  const x = Number.isFinite(n) ? n : lo;
  return Math.max(lo, Math.min(hi, x));
}

export function setPP(state, rosterMonId, moveName, nextCur){
  if (!state) return;
  state.pp = state.pp || {};
  state.pp[rosterMonId] = state.pp[rosterMonId] || {};
  const cur = state.pp[rosterMonId][moveName] || {cur: DEFAULT_MOVE_PP, max: DEFAULT_MOVE_PP};
  cur.max = Number.isFinite(Number(cur.max)) ? Number(cur.max) : DEFAULT_MOVE_PP;
  cur.cur = clampInt(nextCur, 0, cur.max);
  state.pp[rosterMonId][moveName] = cur;
}

function getPP(state, rosterMonId, moveName){
  const o = state.pp?.[rosterMonId]?.[moveName];
  if (!o) return {cur: DEFAULT_MOVE_PP, max: DEFAULT_MOVE_PP};
  return {cur: Number(o.cur ?? DEFAULT_MOVE_PP), max: Number(o.max ?? DEFAULT_MOVE_PP)};
}

function hasPP(state, rosterMonId, moveName){
  const p = getPP(state, rosterMonId, moveName);
  return (p.cur ?? 0) > 0;
}

function decPP(state, rosterMonId, moveName){
  const p = getPP(state, rosterMonId, moveName);
  const next = Math.max(0, (p.cur ?? 0) - 1);
  setPP(state, rosterMonId, moveName, next);
}

function attackerObj(state, rosterMon){
  return {
    species: rosterMon.effectiveSpecies || rosterMon.baseSpecies,
    level: state.settings.claimedLevel,
    ivAll: state.settings.claimedIV,
    evAll: rosterMon.strength ? state.settings.strengthEV : state.settings.claimedEV,
  };
}

function defenderObj(state, defSlot){
  return {
    species: defSlot.defender,
    level: defSlot.level,
    ivAll: state.settings.wildIV,
    evAll: state.settings.wildEV,
  };
}

function slotSuffix(rowKey, waveKey){
  if (!rowKey) return '';
  if (waveKey && rowKey.startsWith(waveKey)) return rowKey.slice(waveKey.length);
  const m = /S\d+$/.exec(rowKey);
  return m ? m[0] : rowKey;
}

function pickAutoActionForAttacker({data, calc, state, wp, waveKey, attackerId, activeDefSlots}){
  const r = byId(state.roster, attackerId);
  if (!r) return null;

  // Candidate moves: enabled + have PP
  const pool = (r.movePool||[]).filter(m => m && m.use !== false && hasPP(state, attackerId, m.name));
  if (!pool.length) return null;

  // Try every target, take best move per target, then pick best overall.
  const candidates = [];
  for (const ds of (activeDefSlots||[])){
    const defObj = defenderObj(state, ds);
    const sW = settingsForWave(state, wp, attackerId, ds.rowKey);
    const atk = attackerObj(state, r);

    const res = calc.chooseBestMove({
      data,
      attacker: atk,
      defender: defObj,
      movePool: pool,
      settings: sW,
      tags: ds.tags||[],
    });
    if (!res?.best) continue;
    const b = res.best;
    candidates.push({
      attackerId,
      targetRowKey: ds.rowKey,
      move: b.move,
      prio: b.prio ?? 9,
      minPct: Number(b.minPct)||0,
      oneShot: !!b.oneShot,
      slower: !!b.slower,
    });
  }
  if (!candidates.length) return null;

  // Choose: maximize OHKO, then prefer lower prio tier, then OHKO closest to 100, then higher min%.
  candidates.sort((a,b)=>{
    const ao = a.oneShot?1:0;
    const bo = b.oneShot?1:0;
    if (ao !== bo) return bo-ao;
    const ap = a.prio ?? 9;
    const bp = b.prio ?? 9;
    if (ap !== bp) return ap-bp;
    if (a.oneShot && b.oneShot){
      const ak = Math.abs((a.minPct||0)-100);
      const bk = Math.abs((b.minPct||0)-100);
      if (ak !== bk) return ak-bk;
    }
    return (b.minPct||0) - (a.minPct||0);
  });

  return candidates[0];
}

function computeRangeForAttack({data, calc, state, wp, attackerId, defSlot, moveName}){
  const r = byId(state.roster, attackerId);
  if (!r) return null;
  const atk = attackerObj(state, r);
  const def = defenderObj(state, defSlot);
  const sW = settingsForWave(state, wp, attackerId, defSlot.rowKey);

  const rr = calc.computeDamageRange({
    data,
    attacker: atk,
    defender: def,
    moveName,
    settings: sW,
    tags: defSlot.tags || [],
  });
  if (!rr?.ok) return null;
  return rr;
}

function computeRangeForThreat({data, calc, state, wp, attackerId, defSlot, threatMoveName}){
  // defender (enemy) attacks attacker
  const attackerMon = byId(state.roster, attackerId);
  if (!attackerMon) return null;

  // Use the same threat model settings; easiest is to call enemyThreatForMatchup and then
  // (optionally) re-compute damage range for the chosen move for consistency.
  const threat = enemyThreatForMatchup(data, state, wp, attackerMon, defSlot) || assumedEnemyThreatForMatchup(data, state, wp, attackerMon, defSlot);
  if (!threat) return null;
  return {threat};
}

function pickEnemyAction({data, state, wp, attackerIds, defSlot}){
  const choices = [];
  for (const atkId of attackerIds){
    const attackerMon = byId(state.roster, atkId);
    if (!attackerMon) continue;
    const t = enemyThreatForMatchup(data, state, wp, attackerMon, defSlot) || assumedEnemyThreatForMatchup(data, state, wp, attackerMon, defSlot);
    if (!t) continue;
    choices.push({
      targetId: atkId,
      move: t.move,
      moveType: t.moveType,
      category: t.category,
      minPct: Number(t.minPct)||0,
      maxPct: Number(t.maxPct)||Number(t.minPct)||0,
      oneShot: !!t.oneShot,
      ohkoChance: Number(t.ohkoChance)||0,
      enemyActsFirst: !!t.enemyActsFirst,
      enemySpe: Number(t.attackerSpe)||0,
      targetSpe: Number(t.defenderSpe)||0,
      chosenReason: t.chosenReason || ( (t.ohkoChance||0)>0 ? 'ohkoChance' : 'maxDamage'),
      assumed: !!t.assumed,
    });
  }
  if (!choices.length) return null;

  const anyChance = choices.some(c => (c.ohkoChance||0) > 0);
  choices.sort((a,b)=>{
    if (anyChance){
      if ((a.ohkoChance||0) !== (b.ohkoChance||0)) return (b.ohkoChance||0) - (a.ohkoChance||0);
    }
    if ((a.minPct||0) !== (b.minPct||0)) return (b.minPct||0) - (a.minPct||0);
    if ((a.maxPct||0) !== (b.maxPct||0)) return (b.maxPct||0) - (a.maxPct||0);
    return String(a.move||'').localeCompare(String(b.move||''));
  });

  const best = choices[0];
  return best;
}

export function initBattleForWave({data, calc, state, waveKey, slots}){
  state.battles = state.battles || {};
  const wp = state.wavePlans?.[waveKey];
  if (!wp) return null;

  const slotByKey = new Map((slots||[]).map(s=>[s.rowKey,s]));
  const defSlots = (wp.defenders||[]).map(k=>slotByKey.get(k)).filter(Boolean);
  const defActive = defSlots.slice(0,2).map(s=>s.rowKey);
  const defBench = defSlots.slice(2).map(s=>s.rowKey);

  const attackerIds = (wp.attackerOrder||wp.attackerStart||wp.attackers||[]).slice(0,16).filter(Boolean);
  const atkActive = uniq(attackerIds.slice(0,2));
  const atkBench = attackerIds.filter(id=>!atkActive.includes(id));

  // Ensure PP seeded
  for (const id of attackerIds){
    const r = byId(state.roster,id);
    if (r) ensurePPForRosterMon(state, r);
  }

  const hpAtk = {};
  const hpDef = {};
  for (const id of atkActive){ hpAtk[id] = 100; }
  for (const rk of defActive){ hpDef[rk] = 100; }

  const battle = {
    status: 'active',
    waveKey,
    atk: {active: atkActive, bench: atkBench},
    def: {active: defActive, bench: defBench},
    hpAtk,
    hpDef,
    manual: {}, // attackerId -> {move,targetRowKey}
    lastActions: {atk:{}, def:{}},
    log: [`Fight started (${waveKey}).`],
    pending: null, // {side:'atk'|'def', slotIndex:number}
    claimed: false,
  };

  state.battles[waveKey] = battle;
  return battle;
}

export function resetBattle(state, waveKey){
  if (!state?.battles) return;
  delete state.battles[waveKey];
}

export function setManualAction(state, waveKey, attackerId, patch){
  const b = state.battles?.[waveKey];
  if (!b) return;
  b.manual = b.manual || {};
  if (!patch){
    delete b.manual[attackerId];
    return;
  }
  const cur = b.manual[attackerId] || {};
  b.manual[attackerId] = {...cur, ...patch};
}

export function chooseReinforcement(state, waveKey, side, slotIndex, chosen){
  const b = state.battles?.[waveKey];
  if (!b) return;
  if (!b.pending) return;
  if (b.pending.side !== side || b.pending.slotIndex !== slotIndex) return;

  if (side === 'atk'){
    const idx = b.atk.bench.indexOf(chosen);
    if (idx === -1) return;
    b.atk.bench.splice(idx,1);
    b.atk.active[slotIndex] = chosen;
    b.hpAtk[chosen] = 100;
  } else {
    const idx = b.def.bench.indexOf(chosen);
    if (idx === -1) return;
    b.def.bench.splice(idx,1);
    b.def.active[slotIndex] = chosen;
    b.hpDef[chosen] = 100;
  }
  b.pending = null;
}

function ensurePending(battle){
  // Find first empty slot caused by a faint.
  // Prefer defenders first (so you pick enemy reinforcements), then attackers.
  for (let i=0;i<2;i++){
    const rk = battle.def.active[i];
    if (!rk){
      if (battle.def.bench.length){
        battle.pending = {side:'def', slotIndex:i};
        return true;
      }
    }
  }
  for (let i=0;i<2;i++){
    const id = battle.atk.active[i];
    if (!id){
      if (battle.atk.bench.length){
        battle.pending = {side:'atk', slotIndex:i};
        return true;
      }
    }
  }
  return false;
}

export function stepBattleTurn({data, calc, state, waveKey, slots}){
  const battle = state.battles?.[waveKey];
  if (!battle) return;
  if (battle.status !== 'active') return;
  if (battle.pending) return; // waiting for reinforcement

  const wp = state.wavePlans?.[waveKey];
  if (!wp) return;
  const slotByKey = new Map((slots||[]).map(s=>[s.rowKey,s]));

  const activeAtkIds = (battle.atk.active||[]).filter(Boolean).filter(id => (battle.hpAtk[id] ?? 0) > 0);
  const activeDefKeys = (battle.def.active||[]).filter(Boolean).filter(rk => (battle.hpDef[rk] ?? 0) > 0);
  const activeDefSlots = activeDefKeys.map(rk=>slotByKey.get(rk)).filter(Boolean);

  // Victory checks
  if (!activeDefKeys.length){
    battle.status = 'won';
    battle.log.push('All defenders fainted.');
    return;
  }
  if (!activeAtkIds.length){
    battle.status = 'lost';
    battle.log.push('All attackers fainted.');
    return;
  }

  const actions = [];

  // Attacker actions
  for (const id of activeAtkIds){
    const manual = battle.manual?.[id];
    let pick = null;
    if (manual && manual.move && manual.targetRowKey){
      // Respect manual unless move has no PP.
      if (hasPP(state, id, manual.move) && activeDefKeys.includes(manual.targetRowKey)){
        pick = {attackerId:id, targetRowKey:manual.targetRowKey, move:manual.move, source:'manual'};
      }
    }
    if (!pick){
      const auto = pickAutoActionForAttacker({data, calc, state, wp, waveKey, attackerId:id, activeDefSlots});
      if (auto){
        pick = {...auto, source:'auto'};
      }
    }
    if (!pick) continue;

    const defSlot = slotByKey.get(pick.targetRowKey);
    if (!defSlot) continue;

    const rr = computeRangeForAttack({data, calc, state, wp, attackerId:id, defSlot, moveName:pick.move});
    if (!rr) continue;

    actions.push({
      side:'atk',
      actorId:id,
      targetKey: pick.targetRowKey,
      move: pick.move,
      minPct: Number(rr.minPct)||0,
      moveType: rr.moveType,
      category: rr.category,
      actorSpe: Number(rr.attackerSpe)||0,
      targetSpe: Number(rr.defenderSpe)||0,
    });

    battle.lastActions.atk[id] = {move: pick.move, target: pick.targetRowKey, minPct: Number(rr.minPct)||0, source: pick.source};
  }

  // Defender actions (enemy hits you): choose best target across active attackers.
  for (const rk of activeDefKeys){
    const defSlot = slotByKey.get(rk);
    if (!defSlot) continue;

    const enemyPick = pickEnemyAction({data, state, wp, attackerIds: activeAtkIds, defSlot});
    if (!enemyPick) continue;

    // We don't compute full damage range here again; threat model already computed minPct.
    actions.push({
      side:'def',
      actorKey: rk,
      targetId: enemyPick.targetId,
      move: enemyPick.move,
      minPct: enemyPick.minPct,
      moveType: enemyPick.moveType,
      category: enemyPick.category,
      actorSpe: enemyPick.enemySpe,
      targetSpe: enemyPick.targetSpe,
      chosenReason: enemyPick.chosenReason,
      ohkoChance: enemyPick.ohkoChance,
    });

    battle.lastActions.def[rk] = {move: enemyPick.move, target: enemyPick.targetId, minPct: enemyPick.minPct, chosenReason: enemyPick.chosenReason};
  }

  // Sort actions by speed desc. On tie between atk/def, enemy may act first.
  const enemyFirstOnTie = !!state.settings?.enemySpeedTieActsFirst;
  actions.sort((a,b)=>{
    const as = Number(a.actorSpe)||0;
    const bs = Number(b.actorSpe)||0;
    if (as !== bs) return bs - as;
    if (a.side !== b.side){
      if (enemyFirstOnTie) return (a.side === 'def') ? -1 : 1;
    }
    return 0;
  });

  // Execute actions
  const turnLog = [];
  for (const act of actions){
    if (act.side === 'atk'){
      const id = act.actorId;
      const rk = act.targetKey;
      if (!id || !rk) continue;
      if ((battle.hpAtk[id] ?? 0) <= 0) continue; // fainted before acting
      if ((battle.hpDef[rk] ?? 0) <= 0) continue;

      const dmg = clampPct(act.minPct);
      battle.hpDef[rk] = clampPct((battle.hpDef[rk] ?? 0) - dmg);
      decPP(state, id, act.move);
      turnLog.push(`${byId(state.roster,id)?.baseSpecies || 'Attacker'} used ${act.move} → ${slotByKey.get(rk)?.defender || rk} (${dmg.toFixed(1)}%).`);
      if ((battle.hpDef[rk] ?? 0) <= 0){
        // remove from active slot
        const idx = battle.def.active.indexOf(rk);
        if (idx !== -1) battle.def.active[idx] = null;
        turnLog.push(`${slotByKey.get(rk)?.defender || rk} fainted.`);
      }
    } else {
      const rk = act.actorKey;
      const id = act.targetId;
      if (!rk || !id) continue;
      if ((battle.hpDef[rk] ?? 0) <= 0) continue;
      if ((battle.hpAtk[id] ?? 0) <= 0) continue;

      const dmg = clampPct(act.minPct);
      battle.hpAtk[id] = clampPct((battle.hpAtk[id] ?? 0) - dmg);
      turnLog.push(`${slotByKey.get(rk)?.defender || rk} used ${act.move} → ${byId(state.roster,id)?.baseSpecies || id} (${dmg.toFixed(1)}%).`);
      if ((battle.hpAtk[id] ?? 0) <= 0){
        const idx = battle.atk.active.indexOf(id);
        if (idx !== -1) battle.atk.active[idx] = null;
        turnLog.push(`${byId(state.roster,id)?.baseSpecies || id} fainted.`);
      }
    }
  }

  // Append logs (keep last ~80 lines)
  battle.log.push(...turnLog);
  if (battle.log.length > 80) battle.log = battle.log.slice(-80);

  // Win/loss checks
  const aliveDef = (battle.def.active||[]).filter(Boolean).filter(k => (battle.hpDef[k] ?? 0) > 0).length + (battle.def.bench||[]).filter(k => (battle.hpDef[k] ?? 100) > 0).length;
  const aliveAtk = (battle.atk.active||[]).filter(Boolean).filter(id => (battle.hpAtk[id] ?? 0) > 0).length + (battle.atk.bench||[]).filter(id => (battle.hpAtk[id] ?? 100) > 0).length;

  if (aliveDef <= 0){
    battle.status = 'won';
    battle.log.push('Wave won.');
    return;
  }
  if (aliveAtk <= 0){
    battle.status = 'lost';
    battle.log.push('Wave lost.');
    return;
  }

  // Reinforcement selection if needed
  ensurePending(battle);
}

export function battleLabelForRowKey({rowKey, waveKey, defender, level}){
  const suf = slotSuffix(rowKey, waveKey);
  return `${defender} · Lv ${level}` + (suf ? ` · ${suf}` : '');
}
