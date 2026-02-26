// js/domain/ppAdapter.js
// PP adapter for Abundant Shrine
// Source of truth: state.roster[].movePool[].pp / ppMax (NOT state.pp)

export const DEFAULT_MOVE_PP = 12;

function byId(arr, id){
  return (arr||[]).find(x => x && x.id === id);
}

function clampInt(v, lo, hi){
  const n = Number.parseInt(String(v), 10);
  const x = Number.isFinite(n) ? n : lo;
  return Math.max(lo, Math.min(hi, x));
}

export function ensurePPForRosterMon(state, rosterMon){
  // v16+ PP storage: each move lives on rosterMon.movePool as mv.pp / mv.ppMax.
  // This normalizes missing/invalid fields.
  if (!state || !rosterMon) return;
  const pool = (rosterMon.movePool||[]).filter(m => m && m.use !== false);
  for (const mv of pool){
    const pm = Number(mv.ppMax);
    mv.ppMax = (Number.isFinite(pm) && pm > 0) ? Math.floor(pm) : DEFAULT_MOVE_PP;
    const pc = Number(mv.pp);
    mv.pp = Number.isFinite(pc) ? clampInt(pc, 0, mv.ppMax) : mv.ppMax;
  }
}

export function getPP(state, rosterMonId, moveName){
  const mon = byId(state?.roster||[], rosterMonId);
  if (!mon) return {cur: DEFAULT_MOVE_PP, max: DEFAULT_MOVE_PP};
  const mv = (mon.movePool||[]).find(m=>m && m.use !== false && m.name === moveName);
  if (!mv) return {cur: DEFAULT_MOVE_PP, max: DEFAULT_MOVE_PP};
  ensurePPForRosterMon(state, mon);
  return {
    cur: Number(mv.pp ?? DEFAULT_MOVE_PP),
    max: Number(mv.ppMax ?? DEFAULT_MOVE_PP),
  };
}

export function setPP(state, rosterMonId, moveName, cur, max){
  // Signature intentionally matches legacy callers:
  // setPP(state, monId, moveName, nextCur)
  // and newer callers:
  // setPP(state, monId, moveName, cur, max)
  const mon = byId(state?.roster||[], rosterMonId);
  if (!mon) return;
  const mv = (mon.movePool||[]).find(m=>m && m.use !== false && m.name === moveName);
  if (!mv) return;
  ensurePPForRosterMon(state, mon);

  if (max !== undefined && max !== null){
    const nm = clampInt(max, 1, 999);
    mv.ppMax = nm;
  }
  if (cur !== undefined && cur !== null){
    mv.pp = clampInt(cur, 0, clampInt(mv.ppMax ?? DEFAULT_MOVE_PP, 1, 999));
  }
}

export function decPP(state, rosterMonId, moveName){
  const mon = byId(state?.roster||[], rosterMonId);
  if (!mon) return;
  const mv = (mon.movePool||[]).find(m=>m && m.use !== false && m.name === moveName);
  if (!mv) return;
  ensurePPForRosterMon(state, mon);
  mv.pp = Math.max(0, Number(mv.pp||0) - 1);
}

export function snapshotPP(state, rosterMonIds=null){
  // Returns a lightweight snapshot that can be restored later.
  // Shape: { [monId]: { [moveName]: {cur, max} } }
  const ids = Array.isArray(rosterMonIds)
    ? rosterMonIds
    : (state?.roster||[]).map(r=>r?.id).filter(Boolean);

  const snap = {};
  for (const id of ids){
    const mon = byId(state?.roster||[], id);
    if (!mon) continue;
    ensurePPForRosterMon(state, mon);
    const entry = {};
    for (const mv of (mon.movePool||[])){
      if (!mv || mv.use === false || !mv.name) continue;
      entry[mv.name] = {
        cur: Number(mv.pp ?? DEFAULT_MOVE_PP),
        max: Number(mv.ppMax ?? DEFAULT_MOVE_PP),
      };
    }
    snap[id] = entry;
  }
  return snap;
}

export function restorePP(state, snap){
  if (!state || !snap) return;
  for (const [id, moves] of Object.entries(snap||{})){
    const mon = byId(state?.roster||[], id);
    if (!mon) continue;
    ensurePPForRosterMon(state, mon);
    for (const [moveName, v] of Object.entries(moves||{})){
      if (!moveName) continue;
      const mv = (mon.movePool||[]).find(m=>m && m.use !== false && m.name === moveName);
      if (!mv) continue;
      const max = (v && v.max !== undefined && v.max !== null) ? v.max : mv.ppMax;
      const cur = (v && v.cur !== undefined && v.cur !== null) ? v.cur : mv.pp;
      setPP(state, id, moveName, cur, max);
    }
  }
}
