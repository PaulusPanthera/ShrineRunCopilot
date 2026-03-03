// js/state/validate.js
// alpha v1
// Non-fatal sanity checks to catch broken saves during refactors.

function uniq(arr){
  return Array.from(new Set((arr||[]).filter(Boolean)));
}

export function validateState(state){
  const warnings = [];
  if (!state || typeof state !== 'object'){
    warnings.push('State is not an object');
    return warnings;
  }

  const roster = Array.isArray(state.roster) ? state.roster : [];
  if (roster.length > 16) warnings.push(`Roster length > 16 (${roster.length})`);

  const ids = roster.map(r=>r?.id).filter(Boolean);
  const uniqueIds = uniq(ids);
  if (uniqueIds.length !== ids.length) warnings.push('Duplicate roster IDs detected');

  const party = state.party;
  if (party){
    const slots = Array.isArray(party.slots) ? party.slots : [];
    if (slots.length && slots.length !== 16) warnings.push(`Party slots length != 16 (${slots.length})`);
    const bad = slots.filter(id=>id && !ids.includes(id));
    if (bad.length) warnings.push(`Party has ${bad.length} slot(s) referencing missing roster IDs`);
    const dup = uniq(slots.filter(Boolean));
    if (dup.length !== slots.filter(Boolean).length) warnings.push('Party slots contain duplicate roster IDs');
  }

  // Wave plans should only reference existing roster IDs.
  const wps = state.wavePlans || {};
  for (const [wk, wp] of Object.entries(wps)){
    if (!wp || typeof wp !== 'object') continue;
    const atk = (wp.attackers || []).filter(Boolean);
    const badAtk = atk.filter(id=>!ids.includes(id));
    if (badAtk.length) warnings.push(`WavePlan ${wk}: attackers contain missing roster IDs (${badAtk.join(', ')})`);
  }

  // Bag counts should not be negative.
  const bag = state.bag || {};
  for (const [k,v] of Object.entries(bag)){
    if (typeof v === 'number' && v < 0) warnings.push(`Bag item "${k}" has negative count (${v})`);
  }

  return warnings;
}
