// js/domain/party.js
// alpha v1
// Party layout mapping: UI-only roster arrangement (4 characters x 4 slots).
// IMPORTANT: This does NOT change roster semantics. Wave logic continues to use state.roster directly.

const DEFAULT_NAMES = ['Player 1','Player 2','Player 3','Player 4'];
const SLOT_COUNT = 16;

export function ensurePartyShape(state){
  state.party = state.party || {};
  const p = state.party;
  if (!Array.isArray(p.names)) p.names = [...DEFAULT_NAMES];
  if (p.names.length !== 4){
    const next = [...DEFAULT_NAMES];
    for (let i=0;i<4;i++) if (typeof p.names[i] === 'string' && p.names[i].trim()) next[i] = p.names[i].trim();
    p.names = next;
  }
  if (!Array.isArray(p.slots)) p.slots = Array.from({length:SLOT_COUNT}).map(()=>null);
  if (p.slots.length !== SLOT_COUNT){
    const next = Array.from({length:SLOT_COUNT}).map((_,i)=>p.slots[i] ?? null);
    p.slots = next;
  }
  return p;
}

// Place the 4 starters in the first slot of each character if possible.
// This is only used when we detect an entirely new/empty layout.
function seedStartersLike(startersIds){
  const slots = Array.from({length:SLOT_COUNT}).map(()=>null);
  const picks = (startersIds||[]).slice(0,4);
  const idxs = [0,4,8,12];
  for (let i=0;i<picks.length;i++) slots[idxs[i]] = picks[i];
  return slots;
}

export function normalizePartyLayout(state, {seedStarters=false} = {}){
  const p = ensurePartyShape(state);
  const roster = Array.isArray(state.roster) ? state.roster : [];
  const rosterIds = roster.map(r=>r?.id).filter(Boolean);
  const rosterIdSet = new Set(rosterIds);

  // Clean invalid ids + duplicates.
  const seen = new Set();
  for (let i=0;i<p.slots.length;i++){
    const id = p.slots[i];
    if (!id || !rosterIdSet.has(id) || seen.has(id)) p.slots[i] = null;
    else seen.add(id);
  }

  // If layout is fully empty and requested, seed starters across 4 characters.
  if (seedStarters && p.slots.every(x=>!x)){
    p.slots = seedStartersLike(rosterIds);
    seen.clear();
    for (const id of p.slots) if (id) seen.add(id);
  }

  // Fill remaining roster mons into empty slots, in roster order.
  const missing = rosterIds.filter(id=>!seen.has(id));
  if (missing.length){
    let mi = 0;
    for (let i=0;i<p.slots.length && mi<missing.length;i++){
      if (p.slots[i] == null){
        p.slots[i] = missing[mi++];
      }
    }
  }
  return p;
}

export function assignToFirstEmptySlot(state, rosterId){
  const p = ensurePartyShape(state);
  if (!rosterId) return null;
  const curIdx = p.slots.findIndex(x=>x === rosterId);
  if (curIdx >= 0) return curIdx;
  const idx = p.slots.findIndex(x=>!x);
  if (idx >= 0){
    p.slots[idx] = rosterId;
    return idx;
  }
  return null;
}

export function removeFromParty(state, rosterId){
  const p = ensurePartyShape(state);
  if (!rosterId) return;
  for (let i=0;i<p.slots.length;i++){
    if (p.slots[i] === rosterId) p.slots[i] = null;
  }
}

export function swapPartySlots(state, aIdx, bIdx){
  const p = ensurePartyShape(state);
  const a = Number(aIdx);
  const b = Number(bIdx);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return;
  if (a < 0 || a >= SLOT_COUNT || b < 0 || b >= SLOT_COUNT) return;
  const tmp = p.slots[a];
  p.slots[a] = p.slots[b];
  p.slots[b] = tmp;
}
