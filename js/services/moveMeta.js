// js/services/moveMeta.js
// alpha v1
// Move metadata cache (PokéAPI) for mechanics like Sheer Force eligibility.

import { toApiSlug } from './pokeApi.js';

const LS_KEY = 'alpha_v1_move_meta_v1';

function safeJsonParse(s, fallback){
  try{ return JSON.parse(s); }catch{ return fallback; }
}

function withTimeout(promise, ms){
  const t = Number(ms)||0;
  if (!(t > 0)) return promise;
  return Promise.race([
    promise,
    new Promise((_, rej)=> setTimeout(()=> rej(new Error('Timeout')), t)),
  ]);
}

function loadCache(){
  try{
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(LS_KEY);
    return safeJsonParse(raw, {}) || {};
  }catch{
    return {};
  }
}

function saveCache(cache){
  if (typeof localStorage === 'undefined') return;
  try{ localStorage.setItem(LS_KEY, JSON.stringify(cache||{})); }catch{ /* ignore */ }
}

function deriveSheerForceEligible(moveJson){
  if (!moveJson) return false;
  // Only damaging moves qualify.
  const power = Number(moveJson.power);
  if (!Number.isFinite(power) || power <= 0) return false;

  const meta = moveJson.meta || null;
  if (!meta) return false;

  // Main heuristics from PokéAPI move meta.
  const ail = Number(meta.ailment_chance || 0);
  const fl = Number(meta.flinch_chance || 0);
  const st = Number(meta.stat_chance || 0);
  const ok = (ail > 0) || (fl > 0) || (st > 0);
  if (!ok) return false;

  // Exclude common self-drop / self-effect moves that PokéAPI still flags with stat_chance.
  // (This tool is Gen 5-ish; keep this list small and conservative.)
  const deny = new Set([
    'close-combat','superpower','overheat','draco-meteor','leaf-storm','psycho-boost','v-create',
    'hammer-arm',
  ]);
  if (deny.has(String(moveJson.name||''))) return false;

  return true;
}

async function fetchMoveJsonByName(moveName, {pokeApi=null, timeoutMs=6000}={}){
  const slug = toApiSlug(moveName);
  if (!slug) throw new Error('Missing move slug');

  // Prefer the canonical PokéAPI helper if provided (shared behavior + caching expectations).
  if (pokeApi && typeof pokeApi.fetchMove === 'function'){
    return await withTimeout(pokeApi.fetchMove(slug), timeoutMs);
  }

  // Fallback: direct fetch (best-effort).
  const url = `https://pokeapi.co/api/v2/move/${slug}`;
  const r = await withTimeout(fetch(url), timeoutMs);
  if (!r.ok) throw new Error(`Fetch failed: ${url}`);
  return await r.json();
}

async function asyncPool(items, concurrency, fn){
  const q = items.slice();
  const workers = Array.from({length: Math.max(1, concurrency||4)}, ()=> (async ()=>{
    while (q.length){
      const it = q.shift();
      if (it == null) continue;
      try{ await fn(it); }catch{ /* ignore */ }
    }
  })());
  await Promise.all(workers);
}

function shearForceMoveNamesFromData(data){
  const out = new Set();
  for (const obj of Object.values(data?.claimedSets || {})){
    if (!obj) continue;
    const ab = String(obj.ability||'').trim();
    if (ab !== 'Sheer Force') continue;
    for (const mv of (obj.moves || [])){
      if (mv) out.add(String(mv));
    }
  }
  return Array.from(out);
}

// Prime move meta cache for Sheer Force detection.
// - Keeps requests minimal by only fetching moves used by Sheer Force species.
// - Stores results in localStorage and exposes window.SHRINE_MOVE_META.
export async function primeMoveMetaCache(data, {concurrency=4, pokeApi=null, timeoutMs=6000}={}){
  const cache = loadCache();
  const names = shearForceMoveNamesFromData(data);
  const todo = names.filter(n => !(cache && cache[n] && typeof cache[n].sheerForce === 'boolean'));

  await asyncPool(todo, concurrency, async (moveName)=>{
    const js = await fetchMoveJsonByName(moveName, {pokeApi, timeoutMs});
    cache[moveName] = { sheerForce: deriveSheerForceEligible(js) };
  });

  saveCache(cache);
  try{
    window.SHRINE_MOVE_META = cache;
    window.__alphaMoveMeta = cache;
  }catch{ /* ignore */ }

  return cache;
}

export function loadMoveMetaCacheIntoWindow(){
  const cache = loadCache();
  try{
    window.SHRINE_MOVE_META = cache;
    window.__alphaMoveMeta = cache;
  }catch{ /* ignore */ }
  return cache;
}
