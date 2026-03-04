// js/domain/phaseRewards.js
// alpha v1
// Phase completion rewards (awarded once per phase when ALL waves in that phase have 4/4 fights logged).

export const PHASE_COMPLETION_REWARDS = {
  // NOTE: Phase 1 reward moved to Nian Boss Checkpoint 1 (see Waves tab checkpoint panel).
};

function waveOrderKey(wk){
  const m = /^P(\d+)W(\d+)$/.exec(String(wk||''));
  if (!m) return 999999;
  return (Number(m[1]) * 100) + Number(m[2]);
}

const _waveKeysByPhaseCache = new WeakMap();

function getWaveKeysByPhase(data){
  if (data && _waveKeysByPhaseCache.has(data)) return _waveKeysByPhaseCache.get(data);
  const m = new Map();
  for (const sl of (data?.calcSlots || [])){
    const p = Number(sl.phase || 0);
    const wk = String(sl.waveKey || '').trim();
    if (!p || !wk) continue;
    if (!m.has(p)) m.set(p, new Set());
    m.get(p).add(wk);
  }
  const out = new Map();
  for (const [p, set] of m.entries()){
    out.set(p, Array.from(set).sort((a,b)=>waveOrderKey(a)-waveOrderKey(b)));
  }
  if (data) _waveKeysByPhaseCache.set(data, out);
  return out;
}

function isWaveComplete(st, wk){
  const w = st?.wavePlans?.[wk];
  return Array.isArray(w?.fightLog) && w.fightLog.length >= 4;
}

/**
 * Award a phase reward if:
 * - reward exists for the phase
 * - not already claimed
 * - all waves in that phase have 4/4 fights logged
 */
export function maybeAwardPhaseReward(data, st, phase){
  const p = Number(phase);
  const rew = PHASE_COMPLETION_REWARDS[p];
  if (!rew) return;

  st.phaseRewardsClaimed = st.phaseRewardsClaimed || {};
  if (st.phaseRewardsClaimed[String(p)]) return;

  const keys = getWaveKeysByPhase(data).get(p) || [];
  if (!keys.length) return;
  if (!keys.every(wk => isWaveComplete(st, wk))) return;

  // Award.
  st.shop = st.shop || {gold:0, ledger:[]};
  st.shop.gold = Math.max(0, Math.floor(Number(st.shop.gold||0) + Number(rew.gold||0)));

  st.bag = st.bag || {};
  for (const [item, qty0] of Object.entries(rew.items || {})){
    const qty = Math.max(0, Math.floor(Number(qty0 || 0)));
    if (!item || !qty) continue;
    st.bag[item] = Number(st.bag[item] || 0) + qty;
  }

  st.phaseRewardsClaimed[String(p)] = {ts: Date.now(), ...rew};
}

/** Award rewards for already-completed phases (used on load/import). */
export function awardCompletedPhasesOnLoad(data, st){
  for (const p of Object.keys(PHASE_COMPLETION_REWARDS)){
    maybeAwardPhaseReward(data, st, Number(p));
  }
}
