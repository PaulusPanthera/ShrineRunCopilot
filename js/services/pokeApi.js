// js/services/pokeApi.js
// v13 — PokeAPI lookups + evo/base mapping helpers

import { fixName } from '../data/nameFixes.js';

// Hard overrides for alpha (branch evolutions / special cases)
export const EVO_OVERRIDES = {
  Eevee: 'Espeon',
  Slowpoke: 'Slowking',
};

// Fast-path presets (avoid network)
export const EVO_PRESET = {
  Mareep: 'Ampharos',
  Cottonee: 'Whimsicott',
};

// Base-species overrides
export const BASE_OVERRIDES = {
  Espeon: 'Eevee',
  Slowking: 'Slowpoke',
  Whimsicott: 'Cottonee',
  Ampharos: 'Mareep',
};

function normName(s){
  return String(s||'')
    .toLowerCase()
    .replace(/['.:%]/g,'')
    .replace(/\s+/g,'')
    .replace(/[^a-z0-9-]/g,'')
    .replace(/-/g,'');
}

export function toApiSlug(name){
  return String(name||'')
    .toLowerCase()
    .replace(/♀/g,'-f')
    .replace(/♂/g,'-m')
    .replace(/'/g,'')
    .replace(/\./g,'')
    .replace(/:/g,'')
    .replace(/é/g,'e')
    .replace(/\s+/g,'-')
    .replace(/[^a-z0-9-]/g,'');
}

export function createPokeApi(data){
  const dexKeyByNorm = new Map();
  for (const k of Object.keys(data.dex||{})) dexKeyByNorm.set(normName(k), k);

  const apiNameToDexKey = (apiName)=> dexKeyByNorm.get(normName(apiName)) || null;

  const bstOf = (species)=>{
    const d = data.dex?.[species];
    if (!d) return 0;
    if (typeof d.bst === 'number') return d.bst;
    const b = d.base || {};
    return (b.hp||0)+(b.atk||0)+(b.def||0)+(b.spa||0)+(b.spd||0)+(b.spe||0);
  };

  async function fetchJson(url){
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Fetch failed: ${url}`);
    return await r.json();
  }

  // Pure sync base mapping if cached/overridden.
  function baseOfSync(species, baseCache){
    const s = fixName(species);
    const o = BASE_OVERRIDES[s];
    if (o && data.dex[o]) return o;
    const cached = baseCache?.[s];
    if (cached && data.dex[cached]) return cached;
    return s;
  }

  // Resolve base (root of evo chain), returning updates for ALL forms in that chain.
  async function resolveBaseSpecies(species, baseCache={}){
    const s = fixName(species);
    const o = BASE_OVERRIDES[s];
    if (o && data.dex[o]){
      return { base: o, updates: { [s]: o } };
    }

    const cached = baseCache[s];
    if (cached && data.dex[cached]){
      return { base: cached, updates: { [s]: cached } };
    }

    const updates = {};
    const cacheSelf = (base)=>{
      updates[s] = base;
      return { base, updates };
    };

    try{
      const slug = toApiSlug(s);
      const spJson = await fetchJson(`https://pokeapi.co/api/v2/pokemon-species/${slug}`);
      if (!spJson?.evolution_chain?.url) return cacheSelf(s);
      const chJson = await fetchJson(spJson.evolution_chain.url);

      const apiNames = [];
      const walk = (node)=>{
        if (!node) return;
        if (node.species?.name) apiNames.push(node.species.name);
        if (Array.isArray(node.evolves_to)) for (const c of node.evolves_to) walk(c);
      };
      walk(chJson.chain);

      const rootApi = chJson?.chain?.species?.name;
      const rootDex = apiNameToDexKey(rootApi) || s;

      for (const an of apiNames){
        const dk = apiNameToDexKey(an);
        if (dk) updates[dk] = rootDex;
      }
      updates[s] = rootDex;
      return { base: rootDex, updates };
    }catch(e){
      return cacheSelf(s);
    }
  }

  // Resolve "best" evolved form for planning.
  // Returns {target, updates:{[base]:targetOrNull}}
  async function resolveEvoTarget(base, evoCache={}){
    const b = fixName(base);
    if (!b) return {target:null, updates:{}};

    // overrides > preset > cached
    const override = EVO_OVERRIDES[b];
    if (override && data.dex[override]) return {target: override, updates: {[b]: override}};
    const preset = EVO_PRESET[b];
    if (preset && data.dex[preset]) return {target: preset, updates: {[b]: preset}};

    const cached = evoCache[b];
    if (cached && data.dex[cached]) return {target: cached, updates: {[b]: cached}};

    const updates = {};
    try{
      const slug = toApiSlug(b);
      const spJson = await fetchJson(`https://pokeapi.co/api/v2/pokemon-species/${slug}`);
      if (!spJson?.evolution_chain?.url){
        updates[b] = null;
        return {target: null, updates};
      }
      const chJson = await fetchJson(spJson.evolution_chain.url);

      // collect species names (api), map to dex keys, pick highest BST
      const names = [];
      const walk = (node)=>{
        if (!node) return;
        if (node.species?.name) names.push(node.species.name);
        if (Array.isArray(node.evolves_to)) for (const c of node.evolves_to) walk(c);
      };
      walk(chJson.chain);

      const candidates = [];
      for (const n of names){
        const key = apiNameToDexKey(n);
        if (key && data.dex[key]) candidates.push(key);
      }

      if (!candidates.length){
        updates[b] = null;
        return {target: null, updates};
      }

      // branch override re-check (if base matches)
      if (EVO_OVERRIDES[b] && data.dex[EVO_OVERRIDES[b]]){
        updates[b] = EVO_OVERRIDES[b];
        return {target: EVO_OVERRIDES[b], updates};
      }

      candidates.sort((a,c)=>bstOf(c)-bstOf(a));
      const chosen = candidates[0] || null;
      updates[b] = chosen;
      return {target: chosen, updates};
    }catch(e){
      updates[b] = evoCache[b] ?? null;
      return {target: updates[b], updates};
    }
  }

  // Resolve the full evolution line for a base species.
  // Returns {base, line:[dexKeys...], updates:{[species]:base}}
  async function resolveEvoLine(species, baseCache={}){
    const s = fixName(species);

    // First resolve the true base/root (also gives chain-wide base updates).
    const { base, updates } = await resolveBaseSpecies(s, baseCache);
    const root = base || s;

    try{
      const slug = toApiSlug(root);
      const spJson = await fetchJson(`https://pokeapi.co/api/v2/pokemon-species/${slug}`);
      if (!spJson?.evolution_chain?.url){
        return { base: root, line: [root], updates: updates || { [s]: root } };
      }
      const chJson = await fetchJson(spJson.evolution_chain.url);

      const out = [];
      const walk = (node)=>{
        if (!node) return;
        if (node.species?.name){
          const dk = apiNameToDexKey(node.species.name);
          if (dk && data.dex?.[dk]) out.push(dk);
        }
        if (Array.isArray(node.evolves_to)){
          for (const c of node.evolves_to) walk(c);
        }
      };
      walk(chJson.chain);

      const uniqLine = Array.from(new Set(out));
      if (!uniqLine.length) uniqLine.push(root);

      return { base: root, line: uniqLine, updates: updates || { [s]: root } };
    }catch(e){
      return { base: root, line: [root], updates: updates || { [s]: root } };
    }
  }

  return {
    baseOfSync,
    resolveBaseSpecies,
    resolveEvoTarget,
    resolveEvoLine,
  };
}
