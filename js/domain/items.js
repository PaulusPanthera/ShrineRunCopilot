// js/domain/items.js
// v2.0.0-beta
// Shared item catalog + simple effect helpers (PokeMMO / Gen5-ish)

// Starters have Strength Charm forced ON, but it does NOT consume the shared bag.
import { isStarterSpecies } from './roster.js';

export const TYPES_NO_FAIRY = [
  'Normal','Fire','Water','Electric','Grass','Ice','Fighting','Poison','Ground','Flying',
  'Psychic','Bug','Rock','Ghost','Dragon','Dark','Steel',
];

// Simple “obvious” competitive items. (Extend later as needed.)
export const CORE_ITEMS = [
  'Leftovers',
  'Life Orb',
  'Muscle Band',
  'Wise Glasses',
  'Expert Belt',
  'Choice Band',
  'Choice Specs',
  'Choice Scarf',
  'Assault Vest',
  'Focus Sash',
  'Air Balloon',
];

export function plateName(type){
  return `${type} Plate`;
}

export function gemName(type){
  return `${type} Gem`;
}

export function buildItemCatalog(){
  const plates = TYPES_NO_FAIRY.map(plateName);
  const gems = TYPES_NO_FAIRY.map(gemName);
  const charms = ['Evo Charm','Strength Charm'];
  const rareCandy = ['Rare Candy','Rare Candy x2'];
  const currency = ['Copper Coin'];
  const utility = ['Revive'];

  // Default “wave loot” pool.
  return [
    ...gems,                  // supports all types (no Fairy)
    ...plates,                // all type plates
    ...charms,
    ...CORE_ITEMS,
    ...rareCandy,
    ...utility,
    ...currency,
  ];
}

export const ITEM_CATALOG = buildItemCatalog();

export function isPlate(item){
  return typeof item === 'string' && item.endsWith(' Plate');
}

export function isGem(item){
  return typeof item === 'string' && item.endsWith(' Gem');
}

export function plateType(item){
  if (!isPlate(item)) return null;
  return item.replace(/ Plate$/, '');
}

export function gemType(item){
  if (!isGem(item)) return null;
  return item.replace(/ Gem$/, '');
}

// --- Quantities / bundles ---

// Wave loot comes in fixed bundles:
// - Gems: always found as a set of 5
// - Rare Candy: 1 or 2
// - Everything else: 1
export function lootBundle(itemName){
  const name = String(itemName || '').trim();
  if (!name) return null;

  // Fixed bundles
  if (name === 'Rare Candy x2') return {key:'Rare Candy', qty:2};
  if (name === 'Rare Candy') return {key:'Rare Candy', qty:1};

  // Loot bundles
  if (isGem(name)) return {key:name, qty:5};
  // Copper Coins are found like gems (bundle of 5)
  if (name === 'Copper Coin') return {key:name, qty:5};
  // Air Balloon can be found as a bundle of 5
  if (name === 'Air Balloon') return {key:name, qty:5};

  return {key:name, qty:1};
}

export function normalizeBagKey(itemName){
  const b = lootBundle(itemName);
  return b ? b.key : null;
}

// --- Shared bag consumption (charms + held items) ---

// NOTE: Starters have Strength Charm forced ON, but it does NOT consume the shared bag.

export function computeRosterUsage(state){
  const used = {};
  for (const r of (state.roster||[])){
    if (!r) continue;
    if (r.evo) used['Evo Charm'] = (used['Evo Charm']||0) + 1;
    // Starters: Strength is forced/free (ignore for bag usage).
    if (r.strength && !isStarterSpecies(r.baseSpecies)) used['Strength Charm'] = (used['Strength Charm']||0) + 1;
    if (r.item){
      used[r.item] = (used[r.item]||0) + 1;
    }
  }
  return used;
}

export function availableCount(state, itemName){
  const bag = state.bag || {};
  const used = computeRosterUsage(state);
  const total = Number(bag[itemName]||0);
  const u = Number(used[itemName]||0);
  return total - u;
}

// Enforce that assigned items/charms do not exceed what exists in the bag.
// Mutates state.
export function enforceBagConstraints(data, state, applyCharmRulesSync){
  const bag = state.bag || {};
  const used = computeRosterUsage(state);

  const over = (key)=> (Number(used[key]||0) - Number(bag[key]||0));

  const dropFromRoster = (predicate, patchFn, key)=>{
    let need = over(key);
    if (need <= 0) return;
    // Prefer de-allocating from inactive mons first, then from the end.
    const roster = (state.roster||[]).slice();
    roster.sort((a,b)=>{
      const ai = a.active ? 1 : 0;
      const bi = b.active ? 1 : 0;
      if (ai !== bi) return ai - bi;
      return String(a.id).localeCompare(String(b.id));
    });
    for (const r of roster){
      if (need <= 0) break;
      if (!predicate(r)) continue;
      patchFn(r);
      if (applyCharmRulesSync) applyCharmRulesSync(data, state, r);
      need -= 1;
    }
  };

  // Held items
  for (const k of Object.keys(used)){
    if (k === 'Evo Charm' || k === 'Strength Charm') continue;
    dropFromRoster((r)=>r.item===k, (r)=>{ r.item = null; }, k);
  }
  // Charms
  dropFromRoster((r)=>!!r.evo, (r)=>{ r.evo = false; }, 'Evo Charm');
  dropFromRoster((r)=>!!r.strength && !isStarterSpecies(r.baseSpecies), (r)=>{ r.strength = false; }, 'Strength Charm');
}
