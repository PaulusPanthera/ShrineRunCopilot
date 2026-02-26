// js/domain/battle.js
// alpha_v1_sim v1.0.0
// Project source file.

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

function baseDefKey(k){
  return String(k || '').split('#')[0];
}

// Percent helpers
// - HP% is always clamped to [0, 100]
// - Damage% must NOT be clamped to 100 (AoE spread is applied after computing % damage,
//   and overkill values like 150% are needed so 150%×0.75 still correctly OHKOs).
function clampHpPct(x){
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}
function clampDmgPct(x){
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  // Keep overkill (e.g., 180%) for correct spread math; cap to avoid runaway UI/log values.
  return Math.max(0, Math.min(9999, n));
}

function normPrio(x){
  const n = Number(x);
  if (!Number.isFinite(n)) return 2;
  return clampInt(n, 1, 3);
}


// Doubles AoE helpers (Gen 5): spread moves deal 0.75× when they actually hit 2+ targets.
const AOE_OPPONENTS_ONLY = new Set([
  'Electroweb','Rock Slide','Heat Wave','Icy Wind','Muddy Water','Dazzling Gleam','Air Cutter',
  'Hyper Voice','Blizzard','Eruption','Snarl',
]);
const AOE_HITS_ALL = new Set([
  'Earthquake','Surf','Discharge','Bulldoze','Sludge Wave','Lava Plume',
]);

export function isAoeMove(name){
  const n = String(name||'');
  return AOE_OPPONENTS_ONLY.has(n) || AOE_HITS_ALL.has(n);
}
export function aoeHitsAlly(name){
  return AOE_HITS_ALL.has(String(name||''));
}
export function spreadMult(targetsDamaged){
  return (targetsDamaged > 1) ? 0.75 : 1.0;
}
function rosterDefObj(state, rosterMon){
  return {
    species: rosterMon.effectiveSpecies || rosterMon.baseSpecies,
    level: state.settings.claimedLevel,
    ivAll: state.settings.claimedIV,
    evAll: rosterMon.strength ? state.settings.strengthEV : state.settings.claimedEV,
  };
}
export function immuneFromAllyAbilityItem(allyRosterMon, moveType){
  if (!allyRosterMon) return false;
  const type = String(moveType||'');
  const ab = String(allyRosterMon.ability || '').trim();
  const item = String(allyRosterMon.item || '').trim();
  if (ab === 'Telepathy') return true;
  if (type === 'Ground'){
    if (ab === 'Levitate') return true;
    if (item === 'Air Balloon') return true;
  }
  if (type === 'Electric'){
    if (ab === 'Lightning Rod' || ab === 'Motor Drive' || ab === 'Volt Absorb') return true;
  }
  if (type === 'Fire'){
    if (ab === 'Flash Fire') return true;
  }
  if (type === 'Water'){
    if (ab === 'Water Absorb' || ab === 'Storm Drain' || ab === 'Dry Skin') return true;
  }
  if (type === 'Grass'){
    if (ab === 'Sap Sipper') return true;
  }
  return false;
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

function pickAutoActionForAttacker({data, calc, state, wp, waveKey, attackerId, activeDefSlots, excludeInstKeys, allyId, battle}){
  const r = byId(state.roster, attackerId);
  if (!r) return null;

  const exclude = new Set((excludeInstKeys||[]).filter(Boolean));

  // Candidate moves: enabled + have PP
  let pool = (r.movePool||[]).filter(m => m && m.use !== false && hasPP(state, attackerId, m.name));

  // Optional forced move override (set in Fight plan).
  const forcedName = (wp && wp.attackMoveOverride) ? (wp.attackMoveOverride[attackerId] || null) : null;
  if (forcedName){
    const forcedPool = pool.filter(m => m && m.name === forcedName);
    if (forcedPool.length) pool = forcedPool;
  }

  if (!pool.length) return null;

  // Try every target, take best move per target, then pick best overall.
  const candidates = [];
  const defList = (activeDefSlots||[]);
  const filtered = exclude.size ? defList.filter(ds => !exclude.has(ds?._instKey || ds?.rowKey)) : defList;
  const targets = (filtered.length ? filtered : defList);

  for (const ds of targets){
    const defObj = defenderObj(state, ds);
    const instKey = ds._instKey || ds.rowKey;
    const curFrac = clampHpPct(battle?.hpDef?.[instKey] ?? 100) / 100;
    const sW0 = settingsForWave(state, wp, attackerId, ds.rowKey);
    const sW = {...sW0, defenderCurHpFrac: curFrac};
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

    // Friendly-fire safety: for spread moves that also hit your partner (e.g. Earthquake/Surf/Discharge),
    // avoid picking the move in AUTO if it could KO the ally, unless the user explicitly allows it.
    const allowFF = !!state.settings?.allowFriendlyFire;
    const isFF = aoeHitsAlly(b.move) && isAoeMove(b.move) && !!allyId && !!battle;
    if (isFF && !allowFF && !forcedName){
      const allyMon = byId(state.roster, allyId);
      const allyHp = Number(battle?.hpAtk?.[allyId] ?? 100);
      if (allyMon && allyHp > 0){
        // If ally has an ability/item immunity (Telepathy/Levitate/Air Balloon/etc.), it's safe.
        let immune = false;
        // Compute move type vs the current defender matchup first (approx); if missing, compute directly.
        let moveType = null;
        try{
          const rr2 = calc.computeDamageRange({
            data,
            attacker: atk,
            defender: rosterDefObj(state, allyMon),
            moveName: b.move,
            settings: settingsForWave(state, wp, attackerId, null),
            tags: [],
          });
          if (rr2?.ok){
            moveType = rr2.moveType;
            immune = immuneFromAllyAbilityItem(allyMon, moveType);
            const maxPct = Number(rr2.maxPct ?? rr2.minPct ?? 0) || 0;
            const effMax = immune ? 0 : clampDmgPct(maxPct);
            if (effMax >= allyHp){
              // Reject this candidate; it could KO the partner.
              continue;
            }
          }
        }catch(e){ /* ignore */ }
      }
    }
    candidates.push({
      attackerId,
      // targetRowKey must reference the active instance key (base#N) so HP tracking stays correct.
      targetRowKey: ds._instKey || ds.rowKey,
      targetBaseRowKey: ds._baseRowKey || ds.rowKey,
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

function hasTag(defSlot, tag){
  const t = String(tag||'').trim();
  if (!t) return false;
  return (defSlot?.tags || []).includes(t);
}

function canUseMove(state, attackerId, moveObj){
  if (!moveObj || !moveObj.name) return false;
  if (moveObj.use === false) return false;
  return hasPP(state, attackerId, moveObj.name);
}

function getAutoMovePool(state, attackerId, rosterMon, wp){
  let pool = (rosterMon?.movePool || []).filter(m => canUseMove(state, attackerId, m));
  const forcedName = (wp && wp.attackMoveOverride) ? (wp.attackMoveOverride[attackerId] || null) : null;
  if (forcedName){
    const forced = pool.filter(m => m && m.name === forcedName);
    if (forced.length) pool = forced;
    else pool = []; // forced but no PP
  }
  return pool;
}

function wouldFriendlyFireKOPartner({data, calc, state, wp, attackerId, moveName, allyId, battle}){
  if (!allyId) return false;
  if (!battle) return false;
  const allowFF = !!state.settings?.allowFriendlyFire;
  if (allowFF) return false;
  if (!aoeHitsAlly(moveName) || !isAoeMove(moveName)) return false;

  const atkMon = byId(state.roster, attackerId);
  const allyMon = byId(state.roster, allyId);
  if (!atkMon || !allyMon) return false;
  const allyHp = Number(battle?.hpAtk?.[allyId] ?? 100);
  if (allyHp <= 0) return false;

  let rr2 = null;
  try{
    rr2 = calc.computeDamageRange({
      data,
      attacker: attackerObj(state, atkMon),
      defender: rosterDefObj(state, allyMon),
      moveName,
      settings: settingsForWave(state, wp, attackerId, null),
      tags: [],
    });
  }catch(e){ rr2 = null; }
  if (!rr2?.ok) return false;
  const immune = immuneFromAllyAbilityItem(allyMon, rr2.moveType);
  const maxPct = immune ? 0 : clampDmgPct(Number(rr2.maxPct ?? rr2.minPct ?? 0) || 0);
  // Conservative: ignore spread reduction and assume full damage.
  return maxPct >= allyHp;
}

function simulateTwoAtkActions({data, calc, state, wp, slotByKey, battle, actions}){
  // Deterministic min% sim for the two attacker actions only.
  // Returns {hpDefNext, faintedKeys:Set}
  const hp = {};
  const defKeys = (battle.def.active||[]).filter(Boolean);
  for (const k of defKeys) hp[k] = clampHpPct(battle.hpDef?.[k] ?? 100);

  // Determine order by speed (matching engine sort). Use a sample target to obtain attackerSpe.
  const withSpe = actions.map(a=>{
    const sampleKey = a.sampleTargetKey || a.targetKey || defKeys[0];
    const baseKey = baseDefKey(sampleKey);
    const defSlot = slotByKey.get(baseKey);
    if (!defSlot) return {...a, actorSpe:0};
    const rr = computeRangeForAttack({
      data, calc, state, wp,
      attackerId: a.attackerId,
      defSlot,
      moveName: a.move,
      defenderCurHpFrac: clampHpPct(hp[sampleKey] ?? 100) / 100,
    });
    return {...a, actorSpe: Number(rr?.attackerSpe)||0};
  });

  withSpe.sort((a,b)=> (Number(b.actorSpe)||0) - (Number(a.actorSpe)||0));

  for (const act of withSpe){
    if (!act || !act.attackerId || !act.move) continue;
    if (isAoeMove(act.move)){
      const alive = defKeys.filter(k => (hp[k] ?? 0) > 0);
      const hits = [];
      for (const dk of alive){
        const baseKey = baseDefKey(dk);
        const defSlot = slotByKey.get(baseKey);
        if (!defSlot) continue;
        const rr = computeRangeForAttack({
          data, calc, state, wp,
          attackerId: act.attackerId,
          defSlot,
          moveName: act.move,
          defenderCurHpFrac: clampHpPct(hp[dk] ?? 100) / 100,
        });
        if (!rr) continue;
        hits.push({dk, min: clampDmgPct(Number(rr.minPct)||0)});
      }
      const targetsDamaged = hits.filter(h => (h.min||0) > 0).length;
      const mult = spreadMult(targetsDamaged);
      for (const h of hits){
        const dmg = clampDmgPct((h.min||0) * mult);
        hp[h.dk] = clampHpPct((hp[h.dk] ?? 0) - dmg);
      }
    } else {
      // single target; redirect if target already fainted
      const want = act.targetKey;
      let tk = want;
      if (!tk || (hp[tk] ?? 0) <= 0){
        tk = defKeys.find(k => (hp[k] ?? 0) > 0) || null;
      }
      if (!tk) continue;
      const baseKey = baseDefKey(tk);
      const defSlot = slotByKey.get(baseKey);
      if (!defSlot) continue;
      const rr = computeRangeForAttack({
        data, calc, state, wp,
        attackerId: act.attackerId,
        defSlot,
        moveName: act.move,
      defenderCurHpFrac: clampHpPct(hp[tk] ?? 100) / 100,
      });
      if (!rr) continue;
      const dmg = clampDmgPct(Number(rr.minPct)||0);
      hp[tk] = clampHpPct((hp[tk] ?? 0) - dmg);
    }
  }

  const fainted = new Set(defKeys.filter(k => (hp[k] ?? 0) <= 0));
  return {hpDefNext: hp, faintedKeys: fainted};
}

function pickSturdyAoePlan({data, calc, state, wp, waveKey, slots, slotByKey, battle, activeAtkIds, activeDefSlots}){
  if (!state.settings?.applySTU) return null;
  if (!state.settings?.sturdyAoeSolve) return null;
  if ((activeAtkIds||[]).length < 2) return null;
  if ((activeDefSlots||[]).length !== 2) return null;

  // Only when both attackers are AUTO (no manual move/target locked).
  for (const id of activeAtkIds){
    const m = battle.manual?.[id];
    if (m && m.move && m.targetRowKey) return null;
  }

  const d0 = activeDefSlots[0];
  const d1 = activeDefSlots[1];
  const k0 = d0?._instKey;
  const k1 = d1?._instKey;
  if (!k0 || !k1) return null;

  const hp0 = clampHpPct(battle.hpDef?.[k0] ?? 100);
  const hp1 = clampHpPct(battle.hpDef?.[k1] ?? 100);

  // Identify exactly one STU target at full HP.
  const d0Stu = hasTag(d0,'STU') && hp0 >= 99.9;
  const d1Stu = hasTag(d1,'STU') && hp1 >= 99.9;
  if ((d0Stu && d1Stu) || (!d0Stu && !d1Stu)) return null;

  const stuKey = d0Stu ? k0 : k1;
  const otherKey = d0Stu ? k1 : k0;
  const allyA = activeAtkIds[0];
  const allyB = activeAtkIds[1];

  const rosterA = byId(state.roster, allyA);
  const rosterB = byId(state.roster, allyB);
  if (!rosterA || !rosterB) return null;

  const poolA = getAutoMovePool(state, allyA, rosterA, wp);
  const poolB = getAutoMovePool(state, allyB, rosterB, wp);
  if (!poolA.length || !poolB.length) return null;

  const aoeA = poolA.filter(m => isAoeMove(m.name));
  const aoeB = poolB.filter(m => isAoeMove(m.name));
  if (!aoeA.length && !aoeB.length) return null;

  const consider = [];

  const hpOtherNow = clampHpPct(battle.hpDef?.[otherKey] ?? 100);

  function aoeKillsNonStuNow({attackerId, moveName}){
    // Determine if the AoE alone is a guaranteed kill on the non-STU target at current HP.
    // Use the battle engine's spread reduction model (×0.75 when hitting 2 defenders).
    const baseKey = baseDefKey(otherKey);
    const defSlot = slotByKey.get(baseKey);
    if (!defSlot) return false;
    const rr = computeRangeForAttack({
      data, calc, state, wp,
      attackerId,
      defSlot,
      moveName,
      defenderCurHpFrac: clampHpPct(battle.hpDef?.[otherKey] ?? 100) / 100,
    });
    if (!rr) return false;
    const mult = spreadMult(2); // exactly 2 defenders alive in this rule
    const minAdj = clampDmgPct(Number(rr.minPct||0) * mult);
    return minAdj >= hpOtherNow;
  }

  function addCombos(aoeUserId, aoePool, finUserId, finPool){
    const allyId = finUserId;
    for (const mAoe of aoePool){
      if (wouldFriendlyFireKOPartner({data, calc, state, wp, attackerId: aoeUserId, moveName: mAoe.name, allyId, battle})) continue;
      const aoeKillsNonStu = aoeKillsNonStuNow({attackerId: aoeUserId, moveName: mAoe.name});
      for (const mFin of finPool){
        // Prefer aiming at STU, but also try aiming at the other to allow redirects.
        for (const tgt of [stuKey, otherKey]){
          if (aoeKillsNonStu && tgt === otherKey) continue;
          const sim = simulateTwoAtkActions({
            data, calc, state, wp, slotByKey, battle,
            actions: [
              {attackerId: aoeUserId, move: mAoe.name, targetKey: otherKey, sampleTargetKey: otherKey},
              {attackerId: finUserId, move: mFin.name, targetKey: tgt, sampleTargetKey: tgt},
            ]
          });
          const hpNext = sim.hpDefNext;
          const otherAlive = (hpNext[otherKey] ?? 0) > 0;
          const stuAlive = (hpNext[stuKey] ?? 0) > 0;
          const win = !otherAlive && !stuAlive;
          const nonStuDead = !otherAlive;
          const stuDead = !stuAlive;
          const prA = normPrio(mAoe.prio);
          const prF = normPrio(mFin.prio);
          const sumPr = prA + prF;
          const remStu = clampHpPct(hpNext[stuKey] ?? 0);
          const remOther = clampHpPct(hpNext[otherKey] ?? 0);
          consider.push({
            win,
            aoeKillsNonStu,
            nonStuDead,
            stuDead,
            finHitsStu: (tgt === stuKey),
            sumPr,
            remStu,
            remOther,
            aoeUserId,
            aoeMove: mAoe.name,
            aoePrio: prA,
            finUserId,
            finMove: mFin.name,
            finPrio: prF,
            finTarget: tgt,
          });
        }
      }
    }
  }

  if (aoeA.length) addCombos(allyA, aoeA, allyB, poolB);
  if (aoeB.length) addCombos(allyB, aoeB, allyA, poolA);

  if (!consider.length) return null;

  // Rank:
  // 1) Win this turn if possible
  // 2) Prefer AoE that can solo-kill the non-STU add (so the other attacker can focus STU)
  // 2) Otherwise: kill non-STU + minimize STU remaining (set up for next turn)
  // 3) Prefer lower sum prio tiers
  consider.sort((x,y)=>{
    const wx = x.win ? 1 : 0;
    const wy = y.win ? 1 : 0;
    if (wx !== wy) return wy - wx;

    const ax = x.aoeKillsNonStu ? 1 : 0;
    const ay = y.aoeKillsNonStu ? 1 : 0;
    if (ax !== ay) return ay - ax;

    const nx = x.nonStuDead ? 1 : 0;
    const ny = y.nonStuDead ? 1 : 0;
    if (nx !== ny) return ny - nx;

    // If the add is dead, prefer plans that spend the 2nd attacker on STU (not redundantly on the add).
    const fx = x.finHitsStu ? 1 : 0;
    const fy = y.finHitsStu ? 1 : 0;
    if (fx !== fy) return fy - fx;

    const sx = x.stuDead ? 1 : 0;
    const sy = y.stuDead ? 1 : 0;
    if (sx !== sy) return sy - sx;
    if ((x.remStu||0) !== (y.remStu||0)) return (x.remStu||0) - (y.remStu||0);
    if ((x.sumPr||0) !== (y.sumPr||0)) return (x.sumPr||0) - (y.sumPr||0);
    if ((x.remOther||0) !== (y.remOther||0)) return (x.remOther||0) - (y.remOther||0);
    return String(x.aoeMove||'').localeCompare(String(y.aoeMove||''));
  });

  const best = consider[0];
  if (!best) return null;
  return {
    stuKey,
    otherKey,
    picks: [
      {attackerId: best.aoeUserId, move: best.aoeMove, prio: best.aoePrio, targetKey: otherKey},
      {attackerId: best.finUserId, move: best.finMove, prio: best.finPrio, targetKey: best.finTarget},
    ]
  };
}

function pickSturdyBasePlan({data, calc, state, wp, slotByKey, battle, activeAtkIds, activeDefSlots}){
  // "Simple ground logic" fallback for STU:
  // - Ensure the non-STU target dies this turn (one attacker)
  // - The other attacker chips STU with a P1 move (prefer) to set up a clean finish next turn.
  if (!state.settings?.applySTU) return null;
  if ((activeAtkIds||[]).length < 2) return null;
  if ((activeDefSlots||[]).length !== 2) return null;

  const d0 = activeDefSlots[0];
  const d1 = activeDefSlots[1];
  const k0 = d0?._instKey;
  const k1 = d1?._instKey;
  if (!k0 || !k1) return null;

  const hp0 = clampHpPct(battle.hpDef?.[k0] ?? 100);
  const hp1 = clampHpPct(battle.hpDef?.[k1] ?? 100);

  const d0Stu = hasTag(d0,'STU') && hp0 >= 99.9;
  const d1Stu = hasTag(d1,'STU') && hp1 >= 99.9;
  if ((d0Stu && d1Stu) || (!d0Stu && !d1Stu)) return null;

  const stuKey = d0Stu ? k0 : k1;
  const otherKey = d0Stu ? k1 : k0;

  // Only when both attackers are AUTO (no manual lock).
  for (const id of activeAtkIds){
    const m = battle.manual?.[id];
    if (m && m.move && m.targetRowKey) return null;
  }

  const a0 = activeAtkIds[0];
  const a1 = activeAtkIds[1];
  const r0 = byId(state.roster, a0);
  const r1 = byId(state.roster, a1);
  if (!r0 || !r1) return null;

  const pool0 = getAutoMovePool(state, a0, r0, wp);
  const pool1 = getAutoMovePool(state, a1, r1, wp);
  if (!pool0.length || !pool1.length) return null;

  const otherHpNow = clampHpPct(battle.hpDef?.[otherKey] ?? 100);
  const baseOther = slotByKey.get(baseDefKey(otherKey));
  const baseStu = slotByKey.get(baseDefKey(stuKey));
  if (!baseOther || !baseStu) return null;

  const bestKill = [];
  const evalKill = (attackerId, pool)=>{
    for (const m of pool){
      const rr = computeRangeForAttack({
        data, calc, state, wp,
        attackerId,
        defSlot: baseOther,
        moveName: m.name,
        defenderCurHpFrac: clampHpPct(battle.hpDef?.[otherKey] ?? 100) / 100,
      });
      if (!rr) continue;
      const aoe = isAoeMove(m.name);
      const mult = aoe ? spreadMult(2) : 1.0;
      const minAdj = clampDmgPct(Number(rr.minPct||0) * mult);
      const pr = normPrio(m.prio);
      const ok = minAdj >= otherHpNow;
      bestKill.push({ok, attackerId, move:m.name, prio:pr, aoe, minAdj});
    }
  };
  evalKill(a0, pool0);
  evalKill(a1, pool1);

  // pick the best guaranteed kill for the non-STU target
  const killers = bestKill.filter(x=>x.ok);
  if (!killers.length) return null;
  killers.sort((x,y)=>{
    if ((x.prio||0) !== (y.prio||0)) return (x.prio||0) - (y.prio||0);
    if ((y.minAdj||0) !== (x.minAdj||0)) return (y.minAdj||0) - (x.minAdj||0);
    return String(x.move||'').localeCompare(String(y.move||''));
  });
  const killPick = killers[0];
  const chipId = (killPick.attackerId === a0) ? a1 : a0;
  const chipPool = (chipId === a0) ? pool0 : pool1;

  // Pick a chip move into STU: prefer P1, then maximize min damage (but any >0 is fine).
  const chips = [];
  for (const m of chipPool){
    if (wouldFriendlyFireKOPartner({data, calc, state, wp, attackerId: chipId, moveName: m.name, allyId: killPick.attackerId, battle})) continue;
    const rr = computeRangeForAttack({
      data, calc, state, wp,
      attackerId: chipId,
      defSlot: baseStu,
      moveName: m.name,
      defenderCurHpFrac: clampHpPct(battle.hpDef?.[stuKey] ?? 100) / 100,
    });
    if (!rr) continue;
    const aoe = isAoeMove(m.name);
    const mult = aoe ? spreadMult(2) : 1.0;
    const minAdj = clampDmgPct(Number(rr.minPct||0) * mult);
    const pr = normPrio(m.prio);
    if (minAdj <= 0) continue;
    chips.push({attackerId: chipId, move:m.name, prio:pr, minAdj});
  }
  if (!chips.length) return null;
  chips.sort((x,y)=>{
    if ((x.prio||0) !== (y.prio||0)) return (x.prio||0) - (y.prio||0);
    if ((y.minAdj||0) !== (x.minAdj||0)) return (y.minAdj||0) - (x.minAdj||0);
    return String(x.move||'').localeCompare(String(y.move||''));
  });
  const chipPick = chips[0];

  return {
    stuKey,
    otherKey,
    picks: [
      {attackerId: killPick.attackerId, move: killPick.move, prio: killPick.prio, targetKey: otherKey},
      {attackerId: chipPick.attackerId, move: chipPick.move, prio: chipPick.prio, targetKey: stuKey},
    ]
  };
}

function computeRangeForAttack({data, calc, state, wp, attackerId, defSlot, moveName, defenderCurHpFrac}){
  const r = byId(state.roster, attackerId);
  if (!r) return null;
  const atk = attackerObj(state, r);
  const def = defenderObj(state, defSlot);
  const sW0 = settingsForWave(state, wp, attackerId, defSlot.rowKey);
  const sW = {...sW0, defenderCurHpFrac: (defenderCurHpFrac ?? 1)};

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
      aoe: !!t.aoe,
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

  // Allow duplicate defenders by expanding repeated base rowKeys into instance keys (#2/#3/...)
  // while still resolving stats/moves off the base rowKey.
  const baseCounts = {};
  const defKeys = (wp.defenders||[])
    .filter(Boolean)
    .map(raw=>{
      const base = baseDefKey(raw);
      baseCounts[base] = (baseCounts[base] || 0) + 1;
      const n = baseCounts[base];
      return n === 1 ? base : `${base}#${n}`;
    });

  const defSlots = defKeys.map(k=>slotByKey.get(baseDefKey(k))).filter(Boolean);
  // We keep battle keys as the expanded instance keys (base#N).
  const defActive = defKeys.slice(0,2);
  const defBench = defKeys.slice(2);

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
    history: [], // list of {side:'atk'|'def', actorId?, actorKey?, move, prio?, aoe?, target?}
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
  const activeDefSlots = activeDefKeys.map(rk=>{
    const baseKey = baseDefKey(rk);
    const sl = slotByKey.get(baseKey);
    if (!sl) return null;
    // Keep instance key separate from base rowKey so we can track HP per-instance (#1/#2/...).
    return {...sl, _instKey: rk, _baseRowKey: baseKey};
  }).filter(Boolean);

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

  // Hard safety cap to avoid infinite loops when targeting/PP gets weird.
  battle.turnCount = (battle.turnCount || 0) + 1;
  const turnCap = Number(state.settings?.battleTurnCap) || 50;
  if (battle.turnCount > turnCap){
    battle.status = 'stalled';
    battle.log.push(`Turn limit reached (${turnCap}).`);
    return;
  }

  const actions = [];

  // Attacker actions
  // If only 1 enemy is alive, only one attacker needs to spend PP (the best one), unless the other is manual.
  const onlyOneEnemy = (activeDefSlots.length === 1);
  const attackerChoices = [];

  // In 2v2, avoid wasting the second attacker on the same already-targeted defender when another defender is alive.
  // We treat instance keys (base#N) as unique targets.
  const reservedTargets = new Set();

  // Coordinated STU (Sturdy) rule: if one defender has STU at full HP and the other does not,
  // try to use AoE (if available) to OHKO the non-STU and chip STU, then finish STU with the other attacker.
  // This keeps "simple ground logic" clean until full setup/cheese logic exists.
  const stuPlan = (!onlyOneEnemy && activeAtkIds.length >= 2 && activeDefSlots.length === 2)
    ? (pickSturdyAoePlan({data, calc, state, wp, waveKey, slots, slotByKey, battle, activeAtkIds: activeAtkIds.slice(0,2), activeDefSlots})
        || pickSturdyBasePlan({data, calc, state, wp, slotByKey, battle, activeAtkIds: activeAtkIds.slice(0,2), activeDefSlots}))
    : null;

  if (stuPlan && stuPlan.picks?.length){
    for (const pick of stuPlan.picks){
      const id = pick.attackerId;
      const r = byId(state.roster, id);
      if (!r) continue;
      const targetKey = (pick.targetKey && activeDefKeys.includes(pick.targetKey)) ? pick.targetKey : (activeDefKeys[0] || null);
      if (!targetKey) continue;
      const targetBaseRowKey = baseDefKey(targetKey);
      const defSlot = slotByKey.get(targetBaseRowKey);
      if (!defSlot) continue;

      const rr = computeRangeForAttack({
        data, calc, state, wp,
        attackerId: id,
        defSlot,
        moveName: pick.move,
        defenderCurHpFrac: clampHpPct(battle.hpDef?.[targetKey] ?? 100) / 100,
      });
      if (!rr) continue;

      const actObj = {
        side:'atk',
        actorId:id,
        targetKey,
        targetBaseRowKey,
        move: pick.move,
        prio: pick.prio ?? 9,
        minPct: Number(rr.minPct)||0,
        maxPct: Number(rr.maxPct ?? rr.minPct)||0,
        aoe: isAoeMove(pick.move),
        hitsAlly: aoeHitsAlly(pick.move),
        moveType: rr.moveType,
        category: rr.category,
        actorSpe: Number(rr.attackerSpe)||0,
        targetSpe: Number(rr.defenderSpe)||0,
        source: 'auto',
      };
      actions.push(actObj);
      battle.lastActions.atk[id] = {
        move: pick.move,
        target: targetKey,
        prio: pick.prio ?? 9,
        minPct: Number(rr.minPct)||0,
        maxPct: Number(rr.maxPct ?? rr.minPct)||0,
        aoe: isAoeMove(pick.move),
        hitsAlly: aoeHitsAlly(pick.move),
        source: 'auto',
      };
    }
  }

  if (!actions.length){
  for (const id of activeAtkIds){
    const manual = battle.manual?.[id];
    let pick = null;
    if (manual && manual.move && manual.targetRowKey){
      // Respect manual unless move has no PP.
      // Manual targets may be base rowKeys; resolve to the currently-active instance key (base#N).
      let targetInst = null;
      if (activeDefKeys.includes(manual.targetRowKey)){
        targetInst = manual.targetRowKey;
      } else {
        const wantBase = baseDefKey(manual.targetRowKey);
        targetInst = activeDefKeys.find(k => baseDefKey(k) === wantBase) || null;
      }
      if (targetInst && hasPP(state, id, manual.move)){
        pick = {attackerId:id, targetRowKey:targetInst, targetBaseRowKey: baseDefKey(targetInst), move:manual.move, source:'manual'};
      }
    }
    if (!pick){
      const allyId = activeAtkIds.find(x => x !== id) || null;
      const auto = pickAutoActionForAttacker({data, calc, state, wp, waveKey, attackerId:id, activeDefSlots, allyId, battle});
      if (auto){
        pick = {...auto, source:'auto'};
      }
    }
    if (!pick) continue;

    // If this is an auto pick and we have multiple defenders alive, try to pick an untargeted defender.
    // This prevents the common case where both attackers choose defender #1 when the matchup is identical.
    if (pick.source === 'auto' && !onlyOneEnemy && activeDefSlots.length > 1){
      const instKey = pick.targetRowKey;
      if (instKey && reservedTargets.has(instKey)){
        const alt = pickAutoActionForAttacker({
          data, calc, state, wp, waveKey,
          attackerId: id,
          activeDefSlots,
          excludeInstKeys: [...reservedTargets],
          allyId: (activeAtkIds.find(x => x !== id) || null),
          battle,
        });
        if (alt){
          pick = {...alt, source:'auto'};
        }
      }
    }

    const targetKey = pick.targetRowKey; // instance key (base#N)
    const targetBaseRowKey = pick.targetBaseRowKey || baseDefKey(targetKey);
    const defSlot = slotByKey.get(targetBaseRowKey);
    if (!defSlot) continue;

    const rr = computeRangeForAttack({
      data, calc, state, wp,
      attackerId: id,
      defSlot,
      moveName: pick.move,
      defenderCurHpFrac: clampHpPct(battle.hpDef?.[targetKey] ?? 100) / 100,
    });
    if (!rr) continue;

    const actObj = {
      side:'atk',
      actorId:id,
      targetKey,
      targetBaseRowKey,
      move: pick.move,
      prio: pick.prio ?? 9,
      minPct: Number(rr.minPct)||0,
      maxPct: Number(rr.maxPct ?? rr.minPct)||0,
      aoe: isAoeMove(pick.move),
      hitsAlly: aoeHitsAlly(pick.move),
      moveType: rr.moveType,
      category: rr.category,
      actorSpe: Number(rr.attackerSpe)||0,
      targetSpe: Number(rr.defenderSpe)||0,
      source: pick.source,
    };

    if (onlyOneEnemy && pick.source !== 'manual'){
      attackerChoices.push(actObj);
    } else {
      actions.push(actObj);
    }

    if (!onlyOneEnemy && actObj.targetKey){
      reservedTargets.add(actObj.targetKey);
    }

    battle.lastActions.atk[id] = {move: pick.move, target: pick.targetRowKey, prio: pick.prio ?? 9, minPct: Number(rr.minPct)||0,
      maxPct: Number(rr.maxPct ?? rr.minPct)||0,
      aoe: isAoeMove(pick.move),
      hitsAlly: aoeHitsAlly(pick.move), source: pick.source};
  }

  }

  if (onlyOneEnemy && attackerChoices.length){
    // Choose best action among attackers: OHKO, then lower prio, then closer-to-100 for OHKO.
    attackerChoices.sort((a,b)=>{
      const ao = ((a.minPct||0) >= (battle.hpDef[a.targetKey] ?? 100)) ? 1 : 0;
      const bo = ((b.minPct||0) >= (battle.hpDef[b.targetKey] ?? 100)) ? 1 : 0;
      if (ao !== bo) return bo-ao;
      if ((a.prio??9) !== (b.prio??9)) return (a.prio??9) - (b.prio??9);
      if (ao && bo){
        const ak = Math.abs((a.minPct||0)-100);
        const bk = Math.abs((b.minPct||0)-100);
        if (ak !== bk) return ak-bk;
      }
      return (b.minPct||0) - (a.minPct||0);
    });
    actions.push(attackerChoices[0]);
  }

  // Defender actions (enemy hits you): choose best target across active attackers.
  for (const rk of activeDefKeys){
    const defSlot = slotByKey.get(baseDefKey(rk));
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
      aoe: !!enemyPick.aoe,
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
let rk = act.targetKey;
if (!id || !rk) continue;
if ((battle.hpAtk[id] ?? 0) <= 0) continue; // fainted before acting

const atkMon = byId(state.roster, id);
const atkName = atkMon?.baseSpecies || 'Attacker';

// AoE (spread) attacker moves: hit both defenders, and sometimes the ally.
if (act.aoe){
  const defKeys = (battle.def.active||[]).filter(Boolean).filter(k => (battle.hpDef[k] ?? 0) > 0);
  const hit = [];

  // Potential ally hit (Earthquake/Surf/Discharge/etc)
  const allyId = (battle.atk.active||[]).filter(Boolean).find(x => x !== id) || null;
  let allyInfo = null;

  // Compute per-target damages (min/max), then apply spread multiplier if 2+ targets are actually damaged.
  for (const dk of defKeys){
    const baseKey = baseDefKey(dk);
    const defSlot = slotByKey.get(baseKey);
    if (!defSlot) continue;
    const rr = computeRangeForAttack({
      data, calc, state, wp,
      attackerId: id,
      defSlot,
      moveName: act.move,
      defenderCurHpFrac: clampHpPct(battle.hpDef?.[dk] ?? 100) / 100,
    });
    if (!rr) continue;
    hit.push({
      kind:'def',
      key: dk,
      name: defSlot.defender || baseKey,
      min: clampDmgPct(Number(rr.minPct)||0),
      max: clampDmgPct(Number(rr.maxPct ?? rr.minPct)||0),
    });
  }

  if (act.hitsAlly && allyId){
    const allyMon = byId(state.roster, allyId);
    const allyHp = Number(battle.hpAtk?.[allyId] ?? 0);
    if (allyMon && allyHp > 0){
      let rrA = null;
      try{
        rrA = calc.computeDamageRange({
          data,
          attacker: attackerObj(state, atkMon),
          defender: rosterDefObj(state, allyMon),
          moveName: act.move,
          settings: settingsForWave(state, wp, id, null),
          tags: [],
        });
      }catch(e){ rrA = null; }
      if (rrA && rrA.ok){
        const moveType = rrA.moveType;
        const immune = immuneFromAllyAbilityItem(allyMon, moveType);
        const minA = immune ? 0 : clampDmgPct(Number(rrA.minPct)||0);
        const maxA = immune ? 0 : clampDmgPct(Number(rrA.maxPct ?? rrA.minPct)||0);
        allyInfo = {
          kind:'ally',
          id: allyId,
          name: allyMon.baseSpecies || String(allyId),
          min: minA,
          max: maxA,
          immune,
        };
      }
    }
  }

  const targetsDamaged = hit.filter(h => (h.min||0) > 0).length + (allyInfo && (allyInfo.min||0) > 0 ? 1 : 0);
  const mult = spreadMult(targetsDamaged);

  // Spend PP once
  const ppBefore = getPP(state, id, act.move);
  decPP(state, id, act.move);
  const ppAfter = getPP(state, id, act.move);

  // Apply damage to defenders
  const parts = [];
  const faintedDefs = [];
  for (const h of hit){
    const dmg = clampDmgPct((h.min||0) * mult);
    battle.hpDef[h.key] = clampHpPct((battle.hpDef[h.key] ?? 0) - dmg);
    parts.push(`${h.name} (${dmg.toFixed(1)}%)`);
    battle.history.push({side:'atk', actorId:id, move: act.move, prio: act.prio ?? 9, targetKey: h.key, aoe:true});
    if ((battle.hpDef[h.key] ?? 0) <= 0){
      const idx = battle.def.active.indexOf(h.key);
      if (idx !== -1) battle.def.active[idx] = null;
      faintedDefs.push(h.name);
    }
  }

  turnLog.push(`${atkName} used ${act.move} (P${act.prio ?? '?'}) (AOE×${mult === 1 ? '1.00' : '0.75'}) → ${parts.join(', ')} · PP ${ppAfter.cur}/${ppAfter.max}.`);
  for (const name of faintedDefs) turnLog.push(`${name} fainted.`);

  // Apply damage to ally if applicable
  if (allyInfo && (allyInfo.min||0) > 0){
    const allyDmg = clampDmgPct((allyInfo.min||0) * mult);
    const allyHp = Number(battle.hpAtk?.[allyInfo.id] ?? 0);
    const nextHp = clampHpPct(allyHp - allyDmg);
    battle.hpAtk[allyInfo.id] = nextHp;

    const riskKO = (clampDmgPct((allyInfo.max||0) * mult) >= allyHp);
    turnLog.push(`⚠ ${atkName}'s ${act.move} hit partner ${allyInfo.name} (${allyDmg.toFixed(1)}%)${riskKO ? ' — RISK: could KO partner' : ''}.`);

    if (nextHp <= 0){
      const idx = battle.atk.active.indexOf(allyInfo.id);
      if (idx !== -1) battle.atk.active[idx] = null;
      turnLog.push(`${allyInfo.name} fainted.`);
    }
  }

  // If friendly-fire would KO and the user has not allowed it, mark the battle with a warning.
  if (allyInfo && (allyInfo.min||0) > 0){
    const allyHp = Number(battle.hpAtk?.[allyInfo.id] ?? 0) + clampDmgPct((allyInfo.min||0) * mult); // previous
    const riskKO = (clampDmgPct((allyInfo.max||0) * mult) >= allyHp);
    if (riskKO && !state.settings?.allowFriendlyFire){
      battle.warnings = battle.warnings || [];
      battle.warnings.push('Friendly fire risk (could KO partner). Enable "Allow friendly fire" to permit.');
    }
  }

  continue;
}

// Single-target attacker move
// If the chosen target fainted earlier in the same turn, redirect to a remaining alive defender.
if ((battle.hpDef[rk] ?? 0) <= 0){
  const altKey = (battle.def.active||[]).filter(Boolean).find(k => (battle.hpDef[k] ?? 0) > 0);
  if (!altKey) continue;
  rk = altKey;
  const baseKey = baseDefKey(rk);
  const defSlot = slotByKey.get(baseKey);
  if (!defSlot) continue;
  const rr = computeRangeForAttack({
    data, calc, state, wp,
    attackerId: id,
    defSlot,
    moveName: act.move,
    defenderCurHpFrac: clampHpPct(battle.hpDef?.[rk] ?? 100) / 100,
  });
  if (!rr) continue;
  act.minPct = Number(rr.minPct)||0;
  act.maxPct = Number(rr.maxPct ?? rr.minPct)||0;
  act.targetKey = rk;
  act.targetBaseRowKey = baseKey;
}

const dmg = clampDmgPct(act.minPct);
battle.hpDef[rk] = clampHpPct((battle.hpDef[rk] ?? 0) - dmg);
const ppBefore = getPP(state, id, act.move);
decPP(state, id, act.move);
const ppAfter = getPP(state, id, act.move);
const defName = slotByKey.get(baseDefKey(rk))?.defender || rk;
turnLog.push(`${atkName} used ${act.move} (P${act.prio ?? '?'}) → ${defName} (${dmg.toFixed(1)}% · PP ${ppAfter.cur}/${ppAfter.max}).`);
battle.history.push({side:'atk', actorId:id, move: act.move, prio: act.prio ?? 9, targetKey: rk});
if ((battle.hpDef[rk] ?? 0) <= 0){
  const idx = battle.def.active.indexOf(rk);
  if (idx !== -1) battle.def.active[idx] = null;
  turnLog.push(`${defName} fainted.`);
}
    } else {

const rk = act.actorKey;
const id = act.targetId;
if (!rk || !id) continue;
if ((battle.hpDef[rk] ?? 0) <= 0) continue;

const defSlot = slotByKey.get(baseDefKey(rk));
const defName = defSlot?.defender || rk;

// Enemy AoE: recompute damage per target (typing differs) + apply 0.75× spread when >1 target is damaged.
const targetIds = act.aoe ? (battle.atk.active||[]).filter(Boolean) : [id];
const hits = [];
for (const tid of targetIds){
  const tmon = byId(state.roster, tid);
  if (!tmon) continue;
  if ((battle.hpAtk[tid] ?? 0) <= 0) continue;

  let rr = null;
  try{
    rr = calc.computeDamageRange({
      data,
      attacker: defenderObj(state, defSlot),
      defender: rosterDefObj(state, tmon),
      moveName: act.move,
      settings: settingsForWave(state, wp, null, defSlot.rowKey),
      tags: defSlot.tags || [],
    });
  }catch(e){ rr = null; }
  if (!rr || !rr.ok){
    // fallback to stored minPct if range missing
    hits.push({tid, name: tmon.baseSpecies || String(tid), min: clampDmgPct(act.minPct||0), max: clampDmgPct(act.maxPct||act.minPct||0)});
  } else {
    hits.push({tid, name: tmon.baseSpecies || String(tid), min: clampDmgPct(Number(rr.minPct)||0), max: clampDmgPct(Number(rr.maxPct ?? rr.minPct)||0)});
  }
}

const targetsDamaged = hits.filter(h => (h.min||0) > 0).length;
const mult = spreadMult(targetsDamaged);

for (const h of hits){
  const dmg = clampDmgPct((h.min||0) * mult);
  if (dmg <= 0) continue;
  battle.hpAtk[h.tid] = clampHpPct((battle.hpAtk[h.tid] ?? 0) - dmg);
  turnLog.push(`${defName} used ${act.move}${act.aoe ? ` (AOE×${mult === 1 ? '1.00' : '0.75'})` : ''} → ${h.name} (${dmg.toFixed(1)}%).`);
  battle.history.push({side:'def', actorKey: rk, move: act.move, aoe: !!act.aoe, targetId: h.tid});
  if ((battle.hpAtk[h.tid] ?? 0) <= 0){
    const idx = battle.atk.active.indexOf(h.tid);
    if (idx !== -1) battle.atk.active[idx] = null;
    turnLog.push(`${h.name} fainted.`);
  }
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
  // UI label for defender instance keys.
  // Display as a simple instance number (#1/#2/...) instead of raw rowKey suffixes.
  const parts = String(rowKey || '').split('#');
  const n = (parts.length > 1) ? Number(parts[1] || 1) : 1;
  const inst = Number.isFinite(n) ? n : 1;
  return `${defender} · Lv ${level} · #${inst}`;
}