// js/data/loadData.js
// v13 — load static json data (no build step)

import { fixName } from './nameFixes.js';

async function fetchJson(path){
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Failed to fetch ${path}: ${r.status}`);
  return await r.json();
}

async function fetchJsonOptional(path, fallback){
  try{
    const r = await fetch(path);
    if (!r.ok) return fallback;
    return await r.json();
  }catch{
    return fallback;
  }
}

export async function loadData(){
  const [dex, moves, typing, rules, stages, calcSlots, claimedSets, waveLoot] = await Promise.all([
    fetchJson('data/dex.json'),
    fetchJson('data/moves.json'),
    fetchJson('data/typing.json'),
    fetchJson('data/rules.json'),
    fetchJson('data/stages.json'),
    fetchJson('data/calcSlots.json'),
    fetchJson('data/claimedSets.json'),
    fetchJsonOptional('data/waveLoot.json', {}),
  ]);

  // Apply name fixes to calc slots
  const fixedSlots = (calcSlots || []).map(x => ({
    ...x,
    defender: fixName(x.defender),
    animal: x.animal ? String(x.animal) : x.animal,
    rowKey: x.rowKey,
  }));

  return { dex, moves, typing, rules, stages, calcSlots: fixedSlots, claimedSets, waveLoot: waveLoot || {} };
}
