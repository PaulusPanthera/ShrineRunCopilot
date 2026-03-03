// js/ui/dexApi.js
// alpha v1
// Shared helpers for maintaining a lightweight PokéAPI cache in state.
//
// Used by multiple UI tabs (e.g. Unlocked/Dex grid and Waves picker) so we don't
// rely on cross-tab globals after extracting modules.

import { fixName } from '../data/nameFixes.js';

export function createDexApiHelpers({ store, pokeApi }){
  const dexMetaInFlight = new Set();
  const dexApiInFlight = new Set();
  const dexEvoInFlight = new Set();


  function ensureDexMeta(species){
    const s = fixName(species);
    const st = store.getState();
    if (st.dexMetaCache?.[s]) return;
    if (dexMetaInFlight.has(s)) return;
    dexMetaInFlight.add(s);

    pokeApi.fetchSpecies(pokeApi.toApiSlug(s))
      .then(spJson=>{
        if (!spJson) return;
        const genusEn = (spJson.genera||[]).find(g=>g.language?.name==='en')?.genus || '';
        store.update(x=>{
          x.dexMetaCache = x.dexMetaCache || {};
          x.dexMetaCache[s] = { id: spJson.id, genus: genusEn };
        });
      })
      .catch(()=>{})
      .finally(()=> dexMetaInFlight.delete(s));
  }

  function ensureDexApi(species){
    const s = fixName(species);
    const st = store.getState();
    if (st.dexApiCache?.[s]) return;
    if (dexApiInFlight.has(s)) return;
    dexApiInFlight.add(s);

    const slug = pokeApi.toApiSlug(s);
    Promise.all([
      pokeApi.fetchPokemon(slug).catch(()=>null),
      pokeApi.fetchSpecies(slug).catch(()=>null),
    ]).then(([pJson, sJson])=>{
      if (!pJson) return;

      // Gen 5 typing (important: PokéAPI reflects modern typings, incl. Fairy).
      // We derive "types as-of Gen 5" by applying the earliest past_types entry
      // AFTER gen5 (e.g. generation-vi) which contains the types *before* that gen.
      const genNum = (g)=>{
        const n = String(g||'');
        const m = n.match(/generation-([ivx]+)/i);
        if (!m) return NaN;
        const r = m[1].toUpperCase();
        const map = {I:1,II:2,III:3,IV:4,V:5,VI:6,VII:7,VIII:8,IX:9};
        return map[r] ?? NaN;
      };

      const pickPastTypesForGen5 = ()=>{
        const pts = Array.isArray(pJson?.past_types) ? pJson.past_types : [];
        let best = null;
        let bestGen = Infinity;
        for (const pt of pts){
          const g = genNum(pt?.generation?.name);
          if (!Number.isFinite(g) || g <= 5) continue;
          if (g < bestGen){
            bestGen = g;
            best = pt;
          }
        }
        const src = best?.types || null;
        if (Array.isArray(src) && src.length) return src;
        return pJson?.types || [];
      };

      const typesGen5 = pickPastTypesForGen5()
        .sort((a,b)=>Number(a.slot)-Number(b.slot))
        .map(t=>t.type?.name)
        .filter(Boolean)
        .map(x=>x[0].toUpperCase()+x.slice(1));

      const stats = {};
      for (const st0 of (pJson.stats||[])){
        const k = st0?.stat?.name;
        const v = Number(st0?.base_stat);
        if (!k || !Number.isFinite(v)) continue;
        if (k === 'hp') stats.hp = v;
        else if (k === 'attack') stats.atk = v;
        else if (k === 'defense') stats.def = v;
        else if (k === 'special-attack') stats.spa = v;
        else if (k === 'special-defense') stats.spd = v;
        else if (k === 'speed') stats.spe = v;
      }

      const genusEn = (sJson?.genera||[]).find(g=>g.language?.name==='en')?.genus || '';
      const dexId = Number(sJson?.id || pJson?.id);

      store.update(x=>{
        x.dexApiCache = x.dexApiCache || {};
        x.dexApiCache[s] = {
          id: Number.isFinite(dexId) ? dexId : null,
          genus: genusEn,
          heightDm: Number(pJson?.height)||null,
          weightHg: Number(pJson?.weight)||null,
          typesGen5,
          stats,
          sprite: pJson?.sprites?.front_default || null,
        };
      });
    }).catch(()=>{})
      .finally(()=> dexApiInFlight.delete(s));
  }


  function ensureDexEvo(species){
    const s = fixName(species);
    const st = store.getState();
    const cur = st.dexMetaCache?.[s];
    if (cur && typeof cur.canEvolve === "boolean") return;
    if (dexEvoInFlight.has(s)) return;
    dexEvoInFlight.add(s);

    const slug = pokeApi.toApiSlug(s);
    pokeApi.fetchSpecies(slug)
      .then(async (spJson)=>{
        if (!spJson?.evolution_chain?.url) return;
        try{
          const r = await fetch(spJson.evolution_chain.url);
          if (!r.ok) return;
          const chJson = await r.json();
          const want = String(slug||"" ).trim().toLowerCase();

          const findNode = (node)=>{
            if (!node) return null;
            const nm = String(node?.species?.name || "").trim().toLowerCase();
            if (nm && nm === want) return node;
            const kids = Array.isArray(node?.evolves_to) ? node.evolves_to : [];
            for (const k of kids){
              const hit = findNode(k);
              if (hit) return hit;
            }
            return null;
          };

          const hit = findNode(chJson?.chain);
          const canEvolve = !!(hit && Array.isArray(hit.evolves_to) && hit.evolves_to.length > 0);

          store.update(x=>{
            x.dexMetaCache = x.dexMetaCache || {};
            const prev = x.dexMetaCache[s] || {};
            x.dexMetaCache[s] = { ...prev, canEvolve };
          });
        }catch(e){}
      })
      .catch(()=>{})
      .finally(()=> dexEvoInFlight.delete(s));
  }


  return { ensureDexMeta, ensureDexApi, ensureDexEvo };
}
