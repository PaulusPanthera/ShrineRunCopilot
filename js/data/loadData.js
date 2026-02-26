// js/data/loadData.js
// v2.0.0-beta
// Load static JSON data and normalize names, moves, and calc tags.

import { fixName } from './nameFixes.js';
import { fixMoveName } from './moveFixes.js';

const DERIVED_CALC_TAGS = new Set(['HH', 'INT', 'STU']);

function deriveCalcTagsForSpecies(claimedSet){
  const out = [];
  const ability = String(claimedSet?.ability || '').trim();
  const moves = Array.isArray(claimedSet?.moves) ? claimedSet.moves : [];

  // Calc-relevant tags (must be truthy for damage logic).
  if (ability === 'Intimidate') out.push('INT');
  if (ability === 'Sturdy') out.push('STU');
  if (moves.includes('Helping Hand')) out.push('HH');

  return out;
}

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


  // Normalize move names inside claimedSets so the app uses canonical names everywhere.
  for (const [sp, obj] of Object.entries(claimedSets||{})){
    if (!obj || typeof obj !== 'object') continue;
    if (Array.isArray(obj.moves)) obj.moves = obj.moves.map(fixMoveName);
    if (typeof obj.ability === 'string') obj.ability = obj.ability.trim();
  }

  // Apply name fixes to calc slots + dynamically derive calc-relevant tags
  // from the locked claimedSets (so tags stay correct if movesets change).
  const fixedSlots = (calcSlots || []).map(x => {
    const defender = fixName(x.defender);
    const baseTags = Array.isArray(x.tags) ? x.tags.filter(Boolean) : [];
    const kept = baseTags.filter(t => !DERIVED_CALC_TAGS.has(t));
    const derived = deriveCalcTagsForSpecies(claimedSets?.[defender]);
    const tags = Array.from(new Set([...kept, ...derived]));

    return {
      ...x,
      defender,
      tags,
      animal: x.animal ? String(x.animal) : x.animal,
      rowKey: x.rowKey,
    };
  });

  return { dex, moves, typing, rules, stages, calcSlots: fixedSlots, claimedSets, waveLoot: waveLoot || {} };
}
