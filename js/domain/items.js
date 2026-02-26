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
  'Light Ball',
  'Bright Powder',
  'Wide Lens',
  'Scope Lens',
  'Eviolite',
  'Metronome',
  'Thick Club',
  'Loaded Dice',
  'Choice Band',
  'Choice Specs',
  'Choice Scarf',
  'Assault Vest',
  'Focus Sash',
  // NOTE: Air Balloon / Copper Coin are tracked in the Bag as SINGLE units,
  // but the shrine/shop often awards/sells them in bundles. Those bundle SKUs
  // exist as separate strings (e.g. 'Air Balloon x5').
  'Air Balloon',
  'Copper Coin',
  'Revive',
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
  // Keep bundle SKUs in the catalog so wave loot + shop can show them explicitly.
  // (The Bag key stays the base item name.)
  const coins = ['Copper Coin x5'];
  const bundles = ['Air Balloon x5'];

  // Default “wave loot” pool.
  return [
    ...gems,                  // supports all types (no Fairy)
    ...plates,                // all type plates
    ...charms,
    ...CORE_ITEMS,
    ...rareCandy,
    ...bundles,
    ...coins,
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
  if (name === 'Rare Candy x3') return {key:'Rare Candy', qty:3};
  if (name === 'Rare Candy') return {key:'Rare Candy', qty:1};

  // Explicit coin bundle
  if (name === 'Copper Coin x5') return {key:'Copper Coin', qty:5};

  // Explicit Air Balloon bundle
  if (name === 'Air Balloon x5') return {key:'Air Balloon', qty:5};

  // Loot bundles
  if (isGem(name)) return {key:name, qty:5};

  // Legacy behavior: older builds sometimes stored bundle SKUs without the suffix.
  // Keep for backward-compat with existing saves.
  if (name === 'Copper Coin') return {key:name, qty:5};
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

// --- Politoed shop economy (gold model) ---
// We separate SELL value (shop buys from you) from BUY offers (shop sells to you).
// User economy notation: "8s 16b" => sell=8, buy=16 (prices in gold).
// Invariant:
// - Shop BUYS from you as SINGLE units.
// - Some items are only SOLD by the shop as bundles (e.g. Gems x5, Air Balloon x5).

const SELL_DISABLED = new Set([
  // Shrine economy notes list these as buy-only.
  'Revive',
]);

// Explicit per-single SELL values.
// (Bundle SKUs still sell as singles; their bundle sell is derived.)
const SELL_EXPLICIT = {
  'Copper Coin': 1,
  'Evo Charm': 8,
  'Strength Charm': 6,
  'Rare Candy': 8,
  'Life Orb': 12,
  'Wide Lens': 8,
  'Light Ball': 8,
  'Assault Vest': 12,
  'Eviolite': 12,
  'Bright Powder': 8,
  'Expert Belt': 8,
  'Leftovers': 12,
  'Metronome': 8,
  'Thick Club': 8,
};

// Explicit per-single BUY values.
// Bundle-only SKUs (Gems/Air Balloons) are handled in buyOffer() with fixed bundle costs.
const BUY_EXPLICIT = {
  'Evo Charm': 16,
  'Strength Charm': 12,
  'Revive': 16,
  'Scope Lens': 16,
  // Rare Candy per-single buy is implied by pack pricing (x3 for 48b)
  'Rare Candy': 16,
};

function sellExplicitOf(name){
  if (!name) return 0;
  if (isGem(name)) return 1;
  if (name === 'Air Balloon') return 1;
  if (isPlate(name)) return 5;
  return Number(SELL_EXPLICIT[name] || 0);
}

function buyExplicitOf(name){
  if (!name) return 0;
  if (isPlate(name)) return 10;
  return Number(BUY_EXPLICIT[name] || 0);
}

// SELL value per SINGLE unit (what you get when you sell 1).
// NOTE: For bundle-only shop SKUs (Gems/Air Balloons), sell values are still per-single.
export function priceOfItem(item){
  const name = String(item||'').trim();
  if (!name) return 0;

  const s = sellExplicitOf(name);
  if (s > 0) return s;
  if (SELL_DISABLED.has(name)) return 0;

  // If only a buy price exists, default sell = floor(buy/2).
  const b = buyExplicitOf(name);
  if (b > 0) return Math.floor(b / 2);
  return 0;
}

// BUY price per SINGLE unit (what you pay when the shop sells 1).
// For bundle-only SKUs, this is per-single and buyOffer() will convert to the bundle.
export function buyPriceOfItem(item){
  const name = String(item||'').trim();
  if (!name) return 0;

  // Not sold by shop.
  if (name === 'Copper Coin') return 0;

  // Bundled consumables (per-single buy is derived from bundle offers)
  if (isGem(name)) return 0;          // bundle-only handled in buyOffer
  if (name === 'Air Balloon') return 0; // bundle-only handled in buyOffer

  const b = buyExplicitOf(name);
  if (b > 0) return b;

  // If a sell price is known, default buy = sell*2.
  const s = sellExplicitOf(name);
  if (s > 0) return s * 2;

  return 0;
}

// BUY offers (what the shop sells to you).
// Returns { item, qty, cost, label } or null for not sold.
export function buyOffer(item){
  const name = String(item||'').trim();
  if (!name) return null;

  // Coins are not sold in the shop (loot/economy only).
  if (name === 'Copper Coin') return null;

  // Bundles
  if (isGem(name)){
    return {item: name, qty: 5, cost: 6, label: `${name} x5`};
  }
  if (name === 'Air Balloon'){
    return {item: name, qty: 5, cost: 6, label: 'Air Balloon x5'};
  }

  // Rare Candy pack (shop sells as a bundle)
  if (name === 'Rare Candy'){
    return {item: name, qty: 3, cost: 48, label: 'Rare Candy x3'};
  }

  // Plates sold as single.
  if (isPlate(name)){
    return {item: name, qty: 1, cost: 10, label: name};
  }

  // Default: single item at nominal price.
  const cost = buyPriceOfItem(name);
  if (!(cost > 0)) return null;
  return {item: name, qty: 1, cost, label: name};
}
