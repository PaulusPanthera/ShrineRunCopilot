// js/services/pokeApi.js
// alpha_v1_sim v1.0.0
// Project source file.

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

// Tool overrides: restrict certain multi-branch evo lines for the Pokédex UI.
const EVO_LINE_OVERRIDES = {
  Eevee: ['Eevee','Espeon'],
};

function normName(s){
  return String(s||'')
    .toLowerCase()
    // IMPORTANT: keep Nidoran♀/♂ distinct.
    .replace(/♀/g,'-f')
    .replace(/♂/g,'-m')
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

  // --- Public PokeAPI fetch helpers (used by Pokédex UI)
  async function fetchSpecies(slugOrId){
    const slug = String(slugOrId||'').trim();
    if (!slug) throw new Error('fetchSpecies: missing slug');
    return await fetchJson(`https://pokeapi.co/api/v2/pokemon-species/${slug}`);
  }

  async function fetchPokemon(slugOrId){
    const slug = String(slugOrId||'').trim();
    if (!slug) throw new Error('fetchPokemon: missing slug');
    return await fetchJson(`https://pokeapi.co/api/v2/pokemon/${slug}`);
  }

  function titleCaseName(apiName){
    const raw = String(apiName||'').trim();
    if (!raw) return raw;
    // PokeAPI uses "mr-mime" etc; keep hyphens, capitalize each segment.
    return raw.split('-').map(s => s ? (s[0].toUpperCase()+s.slice(1)) : s).join('-');
  }

  function bestDexKeyForApiName(apiName){
    // Only return names that exist in our local dex.json (Gen 5 scope).
    return apiNameToDexKey(apiName) || null;
  }

  function flattenEvoChainNonBaby(chain){
    // Returns [{apiName,is_baby}...] in a stable traversal order.
    const out = [];
    const walk = (node)=>{
      if (!node) return;
      const apiName = node?.species?.name || null;
      if (apiName) out.push({ apiName, is_baby: !!node.is_baby });
      if (Array.isArray(node.evolves_to)) for (const c of node.evolves_to) walk(c);
    };
    walk(chain);
    return out;
  }

  function findFirstNonBabyApiName(chainRoot){
    // BFS by depth: pick the first node that isn't marked as baby.
    const q = [];
    if (chainRoot) q.push(chainRoot);
    while (q.length){
      const n = q.shift();
      if (!n) continue;
      if (!n.is_baby && n?.species?.name) return n.species.name;
      if (Array.isArray(n.evolves_to)) q.push(...n.evolves_to);
    }
    return chainRoot?.species?.name || null;
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

  // Resolve base, but skipping baby forms (Igglybuff -> Jigglypuff, etc).
  // Returns { base, line:[dexOrDisplayNames...], updates:{[speciesOrLineName]:base} }
  async function resolveBaseNonBaby(species, baseCache={}){
    const s = fixName(species);
    const o = BASE_OVERRIDES[s];
    if (o && data.dex[o]){
      return { base: o, line: [o], updates: { [s]: o } };
    }

    const cached = baseCache[s];
    if (cached && data.dex[cached]){
      return { base: cached, line: [cached], updates: { [s]: cached } };
    }

    const updates = {};
    const cacheSelf = (base)=>{
      updates[s] = base;
      return { base, line: [base], updates };
    };

    try{
      const slug = toApiSlug(s);
      const spJson = await fetchSpecies(slug);
      if (!spJson?.evolution_chain?.url) return cacheSelf(s);
      const chJson = await fetchJson(spJson.evolution_chain.url);

      const baseApi = findFirstNonBabyApiName(chJson.chain);
      const baseName = bestDexKeyForApiName(baseApi) || s;

      // Build non-baby line from chain
      const flat = flattenEvoChainNonBaby(chJson.chain)
        .filter(x => !x.is_baby)
        .map(x => bestDexKeyForApiName(x.apiName))
        .filter(Boolean);
      const line = Array.from(new Set(flat.length ? flat : [baseName]));

      // Update mapping for all known names in this chain to the non-baby base.
      for (const nm of line){
        updates[fixName(nm)] = baseName;
      }
      updates[s] = baseName;

      return { base: baseName, line, updates };
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

      // Tool overrides: restrict certain multi-branch lines.
      const ovLine = EVO_LINE_OVERRIDES[root];
      if (Array.isArray(ovLine) && ovLine.length){
        const filtered = ovLine.filter(nm => data.dex?.[nm]);
        if (filtered.length) return { base: root, line: filtered, updates: updates || { [s]: root } };
      }

      return { base: root, line: uniqLine, updates: updates || { [s]: root } };
    }catch(e){
      return { base: root, line: [root], updates: updates || { [s]: root } };
    }
  }

  // Full evo line (non-baby) for any species, plus non-baby base.
  // Returns { base, line:[names...], updates }
  async function resolveEvoLineNonBaby(species, baseCache={}){
    const s = fixName(species);

    // First: resolve non-baby base (fast path uses cache/overrides).
    const { base, updates } = await resolveBaseNonBaby(s, baseCache);
    const root = base || s;

    // Second: always attempt to fetch the full non-baby line for the resolved base.
    // This avoids the "cached base => line [base]" pitfall.
    try{
      const slug = toApiSlug(root);
      const spJson = await fetchSpecies(slug);
      if (!spJson?.evolution_chain?.url){
        return { base: root, line: [root], updates: updates || { [s]: root } };
      }
      const chJson = await fetchJson(spJson.evolution_chain.url);

      const flat = flattenEvoChainNonBaby(chJson.chain)
        .filter(x => !x.is_baby)
        .map(x => bestDexKeyForApiName(x.apiName))
        .filter(Boolean);
      let line = Array.from(new Set(flat.length ? flat : [root]));

      // Tool overrides: restrict certain multi-branch lines.
      const ovLine = EVO_LINE_OVERRIDES[root];
      if (Array.isArray(ovLine) && ovLine.length){
        const filtered = ovLine.filter(nm => data.dex?.[nm]);
        if (filtered.length) line = filtered;
      }

      // Ensure base mapping for everything we discovered.
      const upd = updates || {};
      for (const nm of line) upd[fixName(nm)] = root;
      upd[s] = root;

      return { base: root, line, updates: upd };
    }catch(e){
      return { base: root, line: [root], updates: updates || { [s]: root } };
    }
  }

  return {
    toApiSlug,
    baseOfSync,
    resolveBaseSpecies,
    resolveBaseNonBaby,
    resolveEvoTarget,
    resolveEvoLine,
    resolveEvoLineNonBaby,
    fetchSpecies,
    fetchPokemon,
  };
}