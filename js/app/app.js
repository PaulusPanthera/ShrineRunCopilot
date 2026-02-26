// js/app/app.js
// alpha_v1_sim v1.0.1
// Main single-page UI renderer and event wiring.

import { $, $$, el, pill, formatPct, clampInt, sprite, ensureFormFieldA11y } from '../ui/dom.js';
import { fixName } from '../data/nameFixes.js';
import {
  makeRosterEntryFromClaimedSet,
  makeRosterEntryFromClaimedSetWithFallback,
  applyCharmRulesSync,
  normalizeMovePool,
  defaultPrioForMove,
  isStarterSpecies,
} from '../domain/roster.js';
import {
  ensureWavePlan,
  settingsForWave,
  getWaveDefMods,
  enemyThreatForMatchup,
  assumedEnemyThreatForMatchup,
  phaseDefenderLimit,
  speciesListFromSlots,
} from '../domain/waves.js';
import {
  ITEM_CATALOG,
  TYPES_NO_FAIRY,
  plateName,
  gemName,
  lootBundle,
  normalizeBagKey,
  computeRosterUsage,
  availableCount,
  enforceBagConstraints,
  isGem,
  isPlate,
  priceOfItem,
  buyOffer,
} from '../domain/items.js';
import { initBattleForWave, stepBattleTurn, resetBattle, setManualAction, chooseReinforcement, ensurePPForRosterMon, setPP, battleLabelForRowKey, DEFAULT_MOVE_PP, isAoeMove, aoeHitsAlly, immuneFromAllyAbilityItem, spreadMult } from '../domain/battle.js';
import { applyMovesetOverrides, defaultNatureForSpecies } from '../domain/shrineRules.js';

// Static sprites (PNG) for wave tooling to keep the UI snappy.
// Roster stays animated (GIF) via sprite().
function spriteStatic(calcObj, name){
  try{
    if (calcObj && typeof calcObj.spriteUrlPokemonDbBWStatic === 'function'){
      return calcObj.spriteUrlPokemonDbBWStatic(name);
    }
  }catch(e){ /* ignore */ }
  return sprite(calcObj, name);
}


function byId(arr, id){
  return arr.find(x => x.id === id);
}

function groupBy(arr, fn){
  const out = {};
  for (const x of (arr||[])){
    const k = fn(x);
    out[k] = out[k] || [];
    out[k].push(x);
  }
  return out;
}

// Cached fight outcome previews for the Fight plan panel.
// Keyed by a compact signature so we don't re-simulate on every render.
const FIGHT_OUTCOME_PREVIEW_CACHE = new Map();

function uniq(arr){
  return Array.from(new Set((arr||[]).filter(Boolean)));
}

function rosterLabel(r){
  const eff = r.effectiveSpecies || r.baseSpecies;
  if (eff !== r.baseSpecies) return `${eff} (${r.baseSpecies})`;
  return eff;
}

// Defender "instance" keys allow duplicates, e.g. "P1W1S1#2".
function baseDefKey(k){
  return String(k || '').split('#')[0];
}

function defInstNum(k){
  const parts = String(k || '').split('#');
  const n = (parts.length > 1) ? Number(parts[1] || 1) : 1;
  return Number.isFinite(n) ? n : 1;
}

function formatPrioAvg(n){
  const x = Math.round(Number(n || 0) * 2) / 2;
  return Number.isInteger(x) ? String(x) : x.toFixed(1);
}

function waveOrderKey(wk){
  const m = /^P(\d+)W(\d+)$/.exec(wk);
  if (!m) return 999999;
  return (Number(m[1]) * 100) + Number(m[2]);
}

export function startApp(ctx){
  const { data, calc, store, pokeApi } = ctx;

  // DOM refs
  const tabWaves = $('#tabWaves');
  const tabRoster = $('#tabRoster');
  const tabBag = $('#tabBag');
  const tabSettings = $('#tabSettings');
  const tabSim = $('#tabSim');
  const tabUnlocked = $('#tabUnlocked');
  const unlockedCountEl = $('#unlockedCount');

  // ---------------- Phase completion rewards ----------------
  // Awarded once per phase when ALL waves in that phase have 4/4 fights logged.
  // (Extensible later — right now only Phase 1 is confirmed.)
  const PHASE_COMPLETION_REWARDS = {
    1: { gold: 10, items: { 'Revive': 1 } },
  };

  const waveKeysByPhase = (()=>{
    const m = new Map();
    for (const sl of (data.calcSlots||[])){
      const p = Number(sl.phase||0);
      const wk = String(sl.waveKey||'').trim();
      if (!p || !wk) continue;
      if (!m.has(p)) m.set(p, new Set());
      m.get(p).add(wk);
    }
    const out = new Map();
    for (const [p,set] of m.entries()) out.set(p, Array.from(set).sort((a,b)=>waveOrderKey(a)-waveOrderKey(b)));
    return out;
  })();

  const isWaveComplete = (st, wk)=>{
    const w = st.wavePlans?.[wk];
    return Array.isArray(w?.fightLog) && w.fightLog.length >= 4;
  };

  function maybeAwardPhaseReward(st, phase){
    const rew = PHASE_COMPLETION_REWARDS[Number(phase)];
    if (!rew) return;

    st.phaseRewardsClaimed = st.phaseRewardsClaimed || {};
    if (st.phaseRewardsClaimed[String(phase)]) return;

    const keys = waveKeysByPhase.get(Number(phase)) || [];
    if (!keys.length) return;
    if (!keys.every(wk=>isWaveComplete(st, wk))) return;

    // Award.
    st.shop = st.shop || {gold:0, ledger:[]};
    st.shop.gold = Math.max(0, Math.floor(Number(st.shop.gold||0) + Number(rew.gold||0)));
    st.bag = st.bag || {};
    for (const [item, qty0] of Object.entries(rew.items || {})){
      const qty = Math.max(0, Math.floor(Number(qty0||0)));
      if (!item || !qty) continue;
      st.bag[item] = Number(st.bag[item]||0) + qty;
    }
    st.phaseRewardsClaimed[String(phase)] = {ts: Date.now(), ...rew};
  }

  // If the user already completed phases in an older version, award immediately on load.
  store.update(st=>{
    for (const p of Object.keys(PHASE_COMPLETION_REWARDS)) maybeAwardPhaseReward(st, Number(p));
  });

  const ovPanel = $('#attackOverview');
  const ovSprite = $('#ovSprite');
  const ovTitle = $('#ovTitle');
  const ovMeta = $('#ovMeta');
  const ovHint = $('#ovHint');
  const ovBody = $('#ovBody');
  const ovToggle = $('#ovToggle');

  // Base-cache prefetch (best-effort)
  const baseInFlight = new Set();
  function prefetchBaseForSlots(slots){
    const state = store.getState();
    const baseCache = state.baseCache || {};
    const species = speciesListFromSlots(slots);
    for (const sp of species){
      const s = fixName(sp);
      if (baseCache[s] && data.dex?.[baseCache[s]]) continue;
      if (baseInFlight.has(s)) continue;
      baseInFlight.add(s);
      pokeApi.resolveBaseSpecies(s, baseCache)
        .then(({updates})=>{
          if (!updates) return;
          store.update(st => {
            st.baseCache = {...(st.baseCache||{}), ...updates};
          });
        })
        .catch(()=>{})
        .finally(()=> baseInFlight.delete(s));
    }
  }

  function prefetchBaseForSpeciesList(list){
    const state = store.getState();
    const baseCache = state.baseCache || {};
    for (const sp of (list||[])){
      const s = fixName(sp);
      if (baseCache[s] && data.dex?.[baseCache[s]]) continue;
      if (baseInFlight.has(s)) continue;
      baseInFlight.add(s);
      pokeApi.resolveBaseSpecies(s, baseCache)
        .then(({updates})=>{
          if (!updates) return;
          store.update(st => {
            st.baseCache = {...(st.baseCache||{}), ...updates};
          });
        })
        .catch(()=>{})
        .finally(()=> baseInFlight.delete(s));
    }
  }

  // ---- Pokédex meta/data cache (PokeAPI) ----
  const dexMetaInFlight = new Set();
  const dexApiInFlight = new Set();

  // ---- Pokédex grid resolver (bases + dex #) ----
  // We batch base resolving + species-id fetching into ONE store.update to prevent
  // "rows flipping" and lost clicks in the grid.
  let dexGridJobToken = 0;
  let dexGridJobRunning = false;
  let dexGridJobLastKey = '';

  async function runDexGridJob(speciesList, hintEl){
    if (dexGridJobRunning) return;
    const st0 = store.getState();
    if (st0.ui?.tab !== 'unlocked' || st0.ui?.dexDetailBase) return;

    const listLen = Array.from(new Set((speciesList||[]).map(s=>fixName(s)).filter(Boolean))).length;
    if (st0.ui?.dexGridReady && Number(st0.ui?.dexGridBuiltN) === Number(listLen)) return;

    const key = `n:${listLen}|b:${Object.keys(st0.baseCache||{}).length}|m:${Object.keys(st0.dexMetaCache||{}).length}`;
    if (key === dexGridJobLastKey) return;
    dexGridJobLastKey = key;

    dexGridJobRunning = true;
    const token = ++dexGridJobToken;

    const setHint = (txt)=>{
      if (!hintEl) return;
      if (token !== dexGridJobToken) return;
      hintEl.textContent = txt;
    };

    const baseCache0 = {...(st0.baseCache||{})};
    const updatesBase = {};

    // Resolve NON-BABY base (e.g. Igglybuff -> Jigglypuff).
    const list = Array.from(new Set((speciesList||[]).map(s=>fixName(s)).filter(Boolean)));
    let done = 0;
    const q = list.slice();
    const limit = 6;

    const worker = async ()=>{
      while(q.length){
        const sp = q.pop();
        const s = fixName(sp);
        if (!s){ done++; continue; }
        const cached0 = baseCache0[s];
        if (updatesBase[s] || (cached0 && cached0 !== s)){ done++; continue; }
        try{
          const { updates } = await pokeApi.resolveBaseNonBaby(s, {...baseCache0, ...updatesBase});
          if (updates) Object.assign(updatesBase, updates);
        }catch(e){ /* ignore */ }
        done++;
        if (done % 12 === 0) setHint(`Resolving base forms… ${done}/${list.length}`);
      }
    };

    if (list.length){
      setHint(`Resolving base forms… 0/${list.length}`);
      await Promise.all(Array.from({length:Math.min(limit, q.length||1)}).map(worker));
    }
    setHint('Resolving base forms… done.');

    // Build base list from merged mapping.
    const mergedBase = {...baseCache0, ...updatesBase};
    const bases = Array.from(new Set(list.map(s => mergedBase[s] || s)));


    // Fetch evo lines (non-baby) for bases so the grid can include endforms + relevant intermediates.
    const evo0 = {...(st0.evoLineCache||{})};
    const updatesEvo = {};
    const basesMissingLine = bases.filter(b => {
      const k = fixName(b);
      const line = evo0?.[k];
      return !(Array.isArray(line) && line.length);
    });

    let doneLine = 0;
    const qL = basesMissingLine.slice();
    const workerL = async ()=>{
      while(qL.length){
        const b = qL.pop();
        const k = fixName(b);
        if (!k){ doneLine++; continue; }
        if (updatesEvo[k] || (evo0[k] && Array.isArray(evo0[k]) && evo0[k].length)){ doneLine++; continue; }
        try{
          const { base, line, updates } = await pokeApi.resolveEvoLineNonBaby(k, {...baseCache0, ...updatesBase});
          const root = fixName(base || k);
          if (updates) Object.assign(updatesBase, updates);
          if (Array.isArray(line) && line.length){
            updatesEvo[root] = line;
          } else {
            updatesEvo[root] = [root];
          }
        }catch(e){ /* ignore */ }
        doneLine++;
        if (doneLine % 8 === 0) setHint(`Fetching evo lines… ${doneLine}/${basesMissingLine.length}`);
      }
    };

    if (basesMissingLine.length){
      setHint(`Fetching evo lines… 0/${basesMissingLine.length}`);
      await Promise.all(Array.from({length:Math.min(limit, qL.length||1)}).map(workerL));
      setHint('Fetching evo lines… done.');
    }

    // Determine which forms we want meta IDs for: all bases + all forms in evo lines + all direct speciesList entries.
    const mergedBase2 = {...baseCache0, ...updatesBase};
    const formSet = new Set();
    for (const s0 of list) formSet.add(mergedBase2[s0] || s0);
    for (const b of bases) formSet.add(b);
    for (const k of Object.keys(evo0||{})){
      const line = evo0[k];
      if (Array.isArray(line)) for (const nm of line) formSet.add(nm);
    }
    for (const k of Object.keys(updatesEvo||{})){
      const line = updatesEvo[k];
      if (Array.isArray(line)) for (const nm of line) formSet.add(nm);
    }
    const forms = Array.from(formSet).map(x=>fixName(x)).filter(Boolean);
    // Fetch Pokédex numbers (species id) for bases missing id.
    const meta0 = {...(st0.dexMetaCache||{})};
    const updatesMeta = {};
    const missing = forms.filter(b => {
      const k = fixName(b);
      const id = meta0?.[k]?.id;
      return !Number.isFinite(Number(id));
    });

    let done2 = 0;
    const q2 = missing.slice();
    const worker2 = async ()=>{
      while(q2.length){
        const b = q2.pop();
        const k = fixName(b);
        if (!k){ done2++; continue; }
        if (updatesMeta[k] || (meta0[k] && Number.isFinite(Number(meta0[k]?.id)))){ done2++; continue; }
        try{
          const spJson = await pokeApi.fetchSpecies(pokeApi.toApiSlug(k));
          const genusEn = (spJson?.genera||[]).find(g=>g.language?.name==='en')?.genus || '';
          const id = Number(spJson?.id);
          if (Number.isFinite(id)) updatesMeta[k] = { id, genus: genusEn };
        }catch(e){ /* ignore */ }
        done2++;
        if (done2 % 12 === 0) setHint(`Fetching Pokédex #… ${done2}/${missing.length}`);
      }
    };

    if (missing.length){
      setHint(`Fetching Pokédex #… 0/${missing.length}`);
      await Promise.all(Array.from({length:Math.min(limit, q2.length||1)}).map(worker2));
      setHint('Fetching Pokédex #… done.');
    }

    // Single store update to avoid grid jitter.
    if (token === dexGridJobToken){
      store.update(st=>{
        if (Object.keys(updatesBase).length){
          st.baseCache = {...(st.baseCache||{}), ...updatesBase};
        }

        if (Object.keys(updatesEvo).length){
          st.evoLineCache = {...(st.evoLineCache||{}), ...updatesEvo};
        }
        if (Object.keys(updatesMeta).length){
          st.dexMetaCache = {...(st.dexMetaCache||{}), ...updatesMeta};
        }
        st.ui = st.ui || {};
        st.ui.dexGridReady = true;
        st.ui.dexGridBuiltN = list.length;
      });
    }

    dexGridJobRunning = false;
    setHint('');
  }

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

  function typeMatchups(defTypes){
    const types = (defTypes||[]).filter(Boolean);
    const chart = data.typing?.chart || {};
    const atkTypes = data.typing?.types || [];
    const mults = [];
    for (const atk of atkTypes){
      let m = 1;
      for (const d of types){
        const x = chart?.[atk]?.[d];
        m *= (typeof x === 'number') ? x : 1;
      }
      mults.push({ atk, mult: m });
    }
    return {
      weak: mults.filter(x=>x.mult>1).sort((a,b)=>b.mult-a.mult),
      resist: mults.filter(x=>x.mult>0 && x.mult<1).sort((a,b)=>a.mult-b.mult),
      immune: mults.filter(x=>x.mult===0),
    };
  }

  function updateHeaderCounts(state){
    if (!unlockedCountEl) return;
    const n = Object.keys(state.unlocked||{}).filter(k => !!state.unlocked[k]).length;
    unlockedCountEl.textContent = String(n);
  }

  function renderTabs(state){
    $$('.tab').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === state.ui.tab);
    });
    tabWaves.classList.toggle('hidden', state.ui.tab !== 'waves');
    tabRoster.classList.toggle('hidden', state.ui.tab !== 'roster');
    tabBag.classList.toggle('hidden', state.ui.tab !== 'bag');
    tabSettings.classList.toggle('hidden', state.ui.tab !== 'settings');
    tabSim.classList.toggle('hidden', state.ui.tab !== 'sim');
    tabUnlocked.classList.toggle('hidden', state.ui.tab !== 'unlocked');
  }

  function attachTabHandlers(){
    $$('.tab').forEach(btn => {
      btn.addEventListener('click', ()=>{
        const t = btn.getAttribute('data-tab');
        store.update(s => {
          // Tab navigation should not leave the Pokédex "detail layer" stuck.
          // - Clicking Pokédex in the top nav always takes you to the Pokédex grid.
          // - Leaving Pokédex clears its detail-layer state.
          if (t === 'unlocked'){
            s.ui.tab = 'unlocked';
            s.ui.dexReturnTab = 'unlocked';
            s.ui.dexDetailBase = null;
            s.ui.dexSelectedForm = null;
            return;
          }

          // Any other tab: leave Pokédex entirely.
          s.ui.tab = t;
          s.ui.lastNonDexTab = t;
          s.ui.dexDetailBase = null;
          s.ui.dexSelectedForm = null;
          s.ui.dexReturnTab = null;
        });
      });
    });
  }

  function attachOverviewToggle(){
    if (!ovToggle) return;
    ovToggle.addEventListener('click', ()=>{
      store.update(s=>{ s.ui.overviewCollapsed = !s.ui.overviewCollapsed; });
    });

	  // Right click anywhere on the overview panel to fully dismiss it.
	  if (ovPanel){
	    ovPanel.addEventListener('contextmenu', (ev)=>{
	      ev.preventDefault();
	      store.update(s=>{ s.ui.attackOverview = null; });
	    });
	  }
  }

  // ---------------- Overview ----------------

  function showOverviewForSlot(slotObj){
    store.update(s => {
      s.ui.attackOverview = {
        defender: slotObj.defender,
        level: Number(slotObj.level),
        tags: slotObj.tags || [],
        source: 'wave',
      };
    });
  }

  function renderOverview(state){
    const ov = state.ui.attackOverview;
    // Only show overview on tabs where it’s useful (prevents it being “stuck” everywhere)
    const tab = state.ui.tab;
    const tabAllows = (tab === 'waves');
    if (!ov || !tabAllows){
      ovPanel?.classList.add('hidden');
      return;
    }
    ovPanel?.classList.remove('hidden');

    const collapsed = !!state.ui.overviewCollapsed;
    ovPanel?.classList.toggle('collapsed', collapsed);
    if (ovToggle) ovToggle.textContent = collapsed ? 'Show' : 'Hide';

    const defName = ov.defender;
    const level = Number(ov.level || 50);
    const tags = ov.tags || [];

    if (ovSprite){
      ovSprite.src = spriteStatic(calc, defName);
      ovSprite.onerror = ()=> ovSprite.style.opacity = '0.25';
    }
    if (ovTitle) ovTitle.textContent = defName;
    if (ovMeta) ovMeta.textContent = `Lv ${level}` + (tags.length ? ` · ${tags.join(', ')}` : '');
    if (ovHint) ovHint.textContent = 'One-shot info vs your active roster (best moves by priority).';

    const roster = state.roster.filter(r=>r.active);
    const defObj = {species:defName, level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};

    ovBody.innerHTML = '';
    if (collapsed) return;

    if (!roster.length){
      ovBody.appendChild(el('div', {class:'muted'}, 'No active roster Pokémon.'));
      return;
    }

    const rows = [];
    for (const r of roster){
      const atk = {species:(r.effectiveSpecies||r.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: r.strength ? state.settings.strengthEV : state.settings.claimedEV};
      const res = calc.chooseBestMove({
        data,
        attacker: atk,
        defender: defObj,
        movePool: r.movePool||[],
        settings: {...state.settings, attackerItem: r.item || null, defenderItem: null},
        tags,
      });
      if (!res?.best) continue;
      rows.push({r, best: res.best});
    }

    rows.sort((a,b)=>{
      const ao = a.best.oneShot?1:0;
      const bo = b.best.oneShot?1:0;
      if (ao !== bo) return bo-ao;
      const ap = a.best.prio ?? 9;
      const bp = b.best.prio ?? 9;
      if (ap !== bp) return ap-bp;
      return (b.best.minPct||0) - (a.best.minPct||0);
    });

    const tbl = el('table', {class:'table'});
    tbl.appendChild(el('thead', {}, el('tr', {}, [
      el('th', {}, 'Attacker'),
      el('th', {}, 'Best move'),
      el('th', {}, 'Prio'),
      el('th', {}, 'Min%'),
      el('th', {}, 'Speed'),
      el('th', {}, 'Result'),
    ])));
    const tbody = el('tbody');
    for (const row of rows.slice(0, 16)){
      const eff = row.r.effectiveSpecies || row.r.baseSpecies;
      const img = el('img', {class:'sprite sprite-sm', src:sprite(calc, eff), alt:eff});
      img.onerror = ()=> img.style.opacity='0.25';

      const attackerCell = el('div', {style:'display:flex; align-items:center; gap:10px'}, [
        img,
        el('div', {}, [
          el('div', {style:'font-weight:900'}, rosterLabel(row.r)),
          el('div', {class:'muted small'}, row.r.item ? `Item: ${row.r.item}` : ' '),
        ]),
      ]);

      const moveCell = el('div', {}, [
        el('div', {style:'font-weight:900'}, row.best.move),
        el('div', {class:'muted small'}, `${row.best.moveType} · ${row.best.category}` + (row.best.stab ? ' · STAB' : '') + (row.best.hh ? ' · HH' : '')),
      ]);

      const pr = `P${row.best.prio}`;
      const speedPill = row.best.slower ? pill('SLOW','warn danger') : pill('OK','good');
      const resPill = row.best.oneShot ? pill('OHKO','good') : pill('NO','bad');

      tbody.appendChild(el('tr', {}, [
        el('td', {}, attackerCell),
        el('td', {}, moveCell),
        el('td', {}, pr),
        el('td', {}, formatPct(row.best.minPct)),
        el('td', {}, speedPill),
        el('td', {}, resPill),
      ]));
    }
    tbl.appendChild(tbody);
    ovBody.appendChild(tbl);
  }

  // Build a one-shot table against a given defender using the LIVE active roster.
  // Used by the Pokédex detail view.
  function buildOneShotTable(state, defenderName, level, tags){
    const roster = state.roster.filter(r=>r.active).slice(0,16);
    if (!roster.length){
      return el('div', {class:'muted'}, 'No active roster Pokémon.');
    }

    const defObj = {species:defenderName, level:Number(level||50), ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
    const dummyWp = {monMods:{atk:{}, def:{}}};

    const rows = [];
    for (const r of roster){
      const atk = {
        species:(r.effectiveSpecies||r.baseSpecies),
        level: state.settings.claimedLevel,
        ivAll: state.settings.claimedIV,
        evAll: r.strength ? state.settings.strengthEV : state.settings.claimedEV,
      };
      const res = calc.chooseBestMove({
        data,
        attacker: atk,
        defender: defObj,
        movePool: r.movePool||[],
        settings: settingsForWave(state, dummyWp, r.id, null),
        tags: tags || [],
      });
      if (!res?.best) continue;
      rows.push({r, best: res.best});
    }

    rows.sort((a,b)=>{
      const ao = a.best.oneShot?1:0;
      const bo = b.best.oneShot?1:0;
      if (ao !== bo) return bo-ao;
      const ap = a.best.prio ?? 9;
      const bp = b.best.prio ?? 9;
      if (ap !== bp) return ap-bp;
      return (b.best.minPct||0) - (a.best.minPct||0);
    });

    const tbl = el('table', {class:'table'});
    tbl.appendChild(el('thead', {}, el('tr', {}, [
      el('th', {}, 'Attacker'),
      el('th', {}, 'Best move'),
      el('th', {}, 'Prio'),
      el('th', {}, 'Min%'),
      el('th', {}, 'Speed'),
      el('th', {}, 'Result'),
    ])));

    const tbody = el('tbody');
    for (const row of rows){
      const best = row.best;
      tbody.appendChild(el('tr', {}, [
        el('td', {}, rosterLabel(row.r)),
        el('td', {}, el('div', {}, [
          el('div', {class:'move'}, best.move),
          best.meta ? el('div', {class:'muted small'}, best.meta) : null,
        ])),
        el('td', {}, `P${best.prio}`),
        el('td', {}, formatPct(best.minPct)),
        el('td', {}, best.slower ? pill('SLOW','warn danger') : pill('OK','good')),
        el('td', {}, best.oneShot ? pill('OHKO','good') : pill('NO','bad')),
      ]));
    }
    tbl.appendChild(tbody);
    return tbl;
  }

  // ---------------- Battle simulator (Waves) ----------------

  function renderBattlePanel(state, waveKey, slots, wp){
    const battle = state.battles?.[waveKey] || null;
    const slotByKey = new Map((slots||[]).map(s=>[s.rowKey,s]));

    const header = el('div', {style:'display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap'}, [
      el('div', {class:'panel-title'}, 'Fight simulator'),
      el('div', {style:'display:flex; gap:8px; align-items:center; flex-wrap:wrap'}, [])
    ]);

    const btnRow = header.lastChild;

    const panel = el('div', {class:'panel battle-panel'}, [
      header,
      el('div', {class:'muted small'}, `Default PP: ${DEFAULT_MOVE_PP} for every move (temporary rule). Use Step turn to simulate; PP persists across waves.`),
    ]);

    const makeDefLabel = (rk)=>{
      const sl = slotByKey.get(rk);
      if (!sl) return rk;
      return battleLabelForRowKey({rowKey:rk, waveKey, defender:sl.defender, level:sl.level});
    };

    const makeAtkLabel = (id)=>{
      const r = byId(state.roster,id);
      if (!r) return id;
      return rosterLabel(r);
    };

    const statusPill = (st)=>{
      if (st === 'won') return pill('WON','good');
      if (st === 'lost') return pill('LOST','bad');
      if (st === 'active') return pill('ACTIVE','warn');
      return pill('IDLE','');
    };

    // Controls
    const fightBtn = el('button', {class:'btn-mini'}, battle ? 'Continue' : 'Fight');
    fightBtn.addEventListener('click', ()=>{
      store.update(s=>{
        ensureWavePlan(data, s, waveKey, slots);
        initBattleForWave({data, calc, state:s, waveKey, slots});
      });
    });

    const stepBtn = el('button', {class:'btn-mini'}, 'Step turn');
    stepBtn.addEventListener('click', ()=>{
      store.update(s=>{
        stepBattleTurn({data, calc, state:s, waveKey, slots});
      });
    });

    const resetBtn = el('button', {class:'btn-mini'}, 'Reset');
    resetBtn.addEventListener('click', ()=>{
      store.update(s=>{
        resetBattle(s, waveKey);
      });
    });

    btnRow.appendChild(statusPill(battle?.status || 'idle'));
    btnRow.appendChild(fightBtn);
    if (battle) btnRow.appendChild(stepBtn);
    if (battle) btnRow.appendChild(resetBtn);

    if (!battle){
      panel.appendChild(el('div', {class:'muted small', style:'margin-top:8px'}, 'Start a fight for this wave to simulate turns, track PP, and claim species.'));
      return panel;
    }

    // Reinforcement chooser
    if (battle.pending){
      const pending = battle.pending;
      const isAtk = pending.side === 'atk';
      const list = isAtk ? (battle.atk?.bench||[]) : (battle.def?.bench||[]);
      const sel = el('select', {class:'sel-mini', style:'min-width:260px'}, [
        el('option', {value:''}, '— choose —'),
        ...list.map(v=> el('option', {value:String(v)}, isAtk ? makeAtkLabel(v) : makeDefLabel(v))),
      ]);
      const btn = el('button', {class:'btn-mini'}, 'Send in');
      btn.addEventListener('click', ()=>{
        const val = sel.value;
        if (!val) return;
        store.update(s=>{
          chooseReinforcement(s, waveKey, pending.side, pending.slotIndex, isAtk ? val : val);
        });
      });
      panel.appendChild(el('div', {class:'battle-reinf'}, [
        pill('REINFORCEMENT','warn'),
        el('div', {class:'muted small'}, isAtk ? 'Choose next attacker to send in.' : 'Choose next defender to send in.'),
        el('div', {style:'display:flex; gap:8px; align-items:center; flex-wrap:wrap'}, [sel, btn]),
      ]));
    }

    const grid = el('div', {class:'battle-grid'});

    // Attackers
    const atkWrap = el('div', {class:'battle-side'}, [
      el('div', {class:'battle-side-title'}, 'Your side'),
    ]);

    for (const id of (battle.atk?.active||[])){
      if (!id) continue;
      const r = byId(state.roster,id);
      if (!r) continue;
      const hp = Number(battle.hpAtk?.[id] ?? 100);
      const moves = (r.movePool||[]).filter(m=>m && m.use !== false);

      // Manual controls
      const manual = battle.manual?.[id] || {};
      const activeTargets = (battle.def?.active||[]).filter(Boolean);

      const moveSel = el('select', {class:'sel-mini'}, [
        el('option', {value:''}, '— auto —'),
        ...moves.map(m=>{
          const p = state.pp?.[id]?.[m.name] || {cur:DEFAULT_MOVE_PP, max:DEFAULT_MOVE_PP};
          const disabled = Number(p.cur||0) <= 0;
          const label = `${m.name} (PP ${p.cur ?? DEFAULT_MOVE_PP}/${p.max ?? DEFAULT_MOVE_PP})`;
          return el('option', {value:m.name, selected: manual.move===m.name, disabled}, label);
        })
      ]);
      moveSel.addEventListener('change', ()=>{
        const v = moveSel.value || null;
        store.update(s=>{ setManualAction(s, waveKey, id, v ? {move:v} : {move:null}); });
      });

      const targetSel = el('select', {class:'sel-mini'}, [
        el('option', {value:''}, '— target —'),
        ...activeTargets.map(rk=> el('option', {value:rk, selected: manual.targetRowKey===rk}, makeDefLabel(rk))),
      ]);
      targetSel.addEventListener('change', ()=>{
        const v = targetSel.value || null;
        store.update(s=>{ setManualAction(s, waveKey, id, v ? {targetRowKey:v} : {targetRowKey:null}); });
      });

      const autoBtn = el('button', {class:'btn-mini'}, 'Auto');
      autoBtn.addEventListener('click', ()=>{
        store.update(s=>{ setManualAction(s, waveKey, id, null); });
      });

      // PP editor
      const ppList = el('div', {class:'pp-list'});
      for (const m of moves){
        const p = state.pp?.[id]?.[m.name] || {cur:DEFAULT_MOVE_PP, max:DEFAULT_MOVE_PP};
        const inp = el('input', {type:'number', min:'0', max:String(p.max ?? DEFAULT_MOVE_PP), step:'1', value:String(p.cur ?? DEFAULT_MOVE_PP), class:'inp-mini'});
        inp.addEventListener('change', ()=>{
          store.update(s=>{ setPP(s, id, m.name, clampInt(inp.value, 0, Number(p.max ?? DEFAULT_MOVE_PP))); });
        });
        ppList.appendChild(el('div', {class:'pp-row'}, [
          el('div', {class:'pp-move'}, m.name),
          el('div', {class:'pp-box'}, [inp, el('span', {class:'muted small'}, ` / ${p.max ?? DEFAULT_MOVE_PP}`)]),
        ]));
      }

      const card = el('div', {class:'battle-card'}, [
        el('div', {class:'battle-card-head'}, [
          el('div', {style:'display:flex; align-items:center; gap:10px'}, [
            el('img', {class:'sprite sprite-md', src:sprite(calc, r.effectiveSpecies||r.baseSpecies), alt:rosterLabel(r)}),
            el('div', {}, [
              el('div', {style:'font-weight:900'}, rosterLabel(r)),
              el('div', {class:'muted small'}, `HP ${hp.toFixed(1)}%`),
            ]),
          ]),
          pill(hp<=0 ? 'FAINT' : 'OK', hp<=0 ? 'bad' : 'good'),
        ]),
        el('div', {class:'battle-controls'}, [
          el('div', {class:'muted small'}, 'Manual action (optional):'),
          el('div', {style:'display:flex; gap:8px; flex-wrap:wrap; align-items:center'}, [moveSel, targetSel, autoBtn]),
        ]),
        el('div', {class:'battle-pp'}, [
          el('div', {class:'muted small'}, 'PP'),
          ppList,
        ]),
      ]);

      atkWrap.appendChild(card);
    }

    // Defenders
    const defWrap = el('div', {class:'battle-side'}, [
      el('div', {class:'battle-side-title'}, 'Enemy side'),
    ]);

    for (const rk of (battle.def?.active||[])){
      if (!rk) continue;
      const sl = slotByKey.get(rk);
      if (!sl) continue;
      const hp = Number(battle.hpDef?.[rk] ?? 100);
      const last = battle.lastActions?.def?.[rk] || null;
      const incoming = last ? el('div', {class:'muted small'}, [
        el('span', {}, `Incoming: ${last.move || '—'} → ${makeAtkLabel(last.target)}`),
      ]) : el('div', {class:'muted small'}, 'Incoming: —');
      if (last && last.move){
        incoming.title = `${last.move} · ${last.minPct?.toFixed?.(1) ?? last.minPct}% min` + (last.chosenReason ? ` · chosen: ${last.chosenReason}` : '');
      }

      const card = el('div', {class:'battle-card'}, [
        el('div', {class:'battle-card-head'}, [
          el('div', {style:'display:flex; align-items:center; gap:10px'}, [
            el('img', {class:'sprite sprite-md', src:spriteStatic(calc, sl.defender), alt:sl.defender}),
            el('div', {}, [
              el('div', {style:'font-weight:900'}, `${sl.defender} · ${rk.startsWith(waveKey) ? rk.slice(waveKey.length) : rk}`),
              el('div', {class:'muted small'}, `HP ${hp.toFixed(1)}% · Lv ${sl.level}`),
            ]),
          ]),
          pill(hp<=0 ? 'FAINT' : 'OK', hp<=0 ? 'bad' : 'good'),
        ]),
        incoming,
      ]);
      defWrap.appendChild(card);
    }

    grid.appendChild(atkWrap);
    grid.appendChild(defWrap);
    panel.appendChild(grid);

    // Claiming
    if (battle.status === 'won' && !battle.claimed){
      const claimBtn = el('button', {class:'btn'}, 'Claim defeated species');
      claimBtn.addEventListener('click', ()=>{
        store.update(s=>{
          const w = s.wavePlans?.[waveKey];
          if (!w) return;
          const sbk = new Map((slots||[]).map(ss=>[ss.rowKey, ss]));
          for (const rk of (w.defenders||[])){
            const sl = sbk.get(rk);
            if (!sl) continue;
            const base = pokeApi.baseOfSync(sl.defender, s.baseCache||{});
            s.unlocked[base] = true;
            s.cleared[rk] = true;
          }
          s.battles[waveKey].claimed = true;
        });
      });
      panel.appendChild(el('div', {style:'margin-top:10px; display:flex; justify-content:flex-end'}, [claimBtn]));
    }

    // Log
    const log = el('div', {class:'battle-log'}, (battle.log||[]).slice(-10).map(line=> el('div', {class:'battle-log-line'}, line)));
    panel.appendChild(el('div', {class:'panel-subtitle'}, 'Recent log'));
    panel.appendChild(log);

    return panel;
  }

  // ---------------- Waves ----------------

  function renderWaves(state){
    tabWaves.innerHTML = '';

    const waves = groupBy(data.calcSlots, s => s.waveKey);

    // Rotate wave display order within each phase based on chosen start animal (Goat default).
    const startAnimal = (state.settings && state.settings.startAnimal) ? state.settings.startAnimal : 'Goat';
    const phase1Animals = Array.from({length:12}).map((_,i)=>{
      const wk = `P1W${i+1}`;
      return waves[wk]?.[0]?.animal || null;
    });
    const startIdx = Math.max(0, phase1Animals.indexOf(startAnimal));
    const waveNums = Array.from({length:12}).map((_,i)=>i+1);
    const rotatedNums = waveNums.slice(startIdx).concat(waveNums.slice(0,startIdx));

    const phaseWaveKeys = (phase)=> rotatedNums.map(n=>`P${phase}W${n}`).filter(k=>waves[k]);

    const phase1 = phaseWaveKeys(1);
    const phase2 = phaseWaveKeys(2);
    const phase3 = phaseWaveKeys(3);
    const phase4 = phaseWaveKeys(4);

    // Run order control (moved from Settings → Waves for better discoverability).
    (function(){
      const animals = phase1Animals.filter(Boolean);
      const cur = startAnimal;
      const sel = el('select', {style:'min-width:220px'}, animals.map(a=>el('option', {value:a, selected:a===cur}, a)));
      sel.addEventListener('change', ()=> store.update(st=>{ st.settings.startAnimal = sel.value; }));

      tabWaves.appendChild(el('div', {class:'panel'}, [
        el('div', {class:'panel-title'}, 'Run order'),
        el('div', {class:'muted small'}, 'Pick which animal wave shows first. This rotates wave order within each phase (data unchanged).'),
        el('div', {style:'display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap; margin-top:10px'}, [
          el('div', {class:'field', style:'margin:0'}, [el('label', {}, 'Start wave'), sel]),
          (function(){
            const b = el('button', {class:'btn-mini'}, 'Reset to Goat');
            b.addEventListener('click', ()=> store.update(st=>{ st.settings.startAnimal = 'Goat'; }));
            return b;
          })(),
        ]),
      ]));
    })();

    const sections = [
      {title:'Phase 1', phase:1, keys: phase1, bossAfter:true},
      {title:'Phase 2 — Part 1', phase:2, keys: phase2.slice(0,6), bossAfter:true},
      {title:'Phase 2 — Part 2', phase:2, keys: phase2.slice(6), bossAfter:true},
      {title:'Phase 3 — Part 1', phase:3, keys: phase3.slice(0,6), bossAfter:true},
      {title:'Phase 3 — Part 2', phase:3, keys: phase3.slice(6), bossAfter:true},
      {title:'Phase 4 — Part 1', phase:4, keys: phase4.slice(0,6), bossAfter:true},
      {title:'Phase 4 — Part 2', phase:4, keys: phase4.slice(6), bossAfter:true},
    ];

    for (const sec of sections){
      tabWaves.appendChild(el('div', {}, [
        el('div', {class:'section-title'}, [
          el('div', {}, [
            el('div', {}, sec.title),
            el('div', {class:'section-sub'}, `Order rotated (start: ${startAnimal})`),
          ]),
        ]),
      ]));

      for (const wk of (sec.keys||[])){
        tabWaves.appendChild(renderWaveCard(state, wk, waves[wk]));
      }

      if (sec.bossAfter){
        tabWaves.appendChild(el('div', {class:'boss'}, [
          el('div', {}, [
            el('div', {class:'title'}, 'NIAN BOSS'),
            el('div', {class:'hint'}, 'Checkpoint — after this section'),
          ]),
          el('div', {class:'pill warn'}, 'prep / heal / items'),
        ]));
      }
    }
  }

  function renderWaveCard(state, waveKey, slots){
    const expanded = !!state.ui.waveExpanded[waveKey];
    const first = slots[0];
    const title = `${waveKey} • ${first.animal} • Lv ${first.level}`;

    const btn = el('button', {class:'btn-mini'}, expanded ? 'Collapse' : 'Expand');
    btn.addEventListener('click', ()=>{
      store.update(s => { s.ui.waveExpanded[waveKey] = !expanded; });
    });



    const lootInline = (()=>{
      const fixedLoot = (data.waveLoot && data.waveLoot[waveKey]) ? data.waveLoot[waveKey] : null;
      const fixedName = (fixedLoot && typeof fixedLoot === 'string') ? fixedLoot : null;

      const applyLootDelta = (s, itemName, dir)=>{
        const b = lootBundle(itemName);
        if (!b) return;
        s.bag = s.bag || {};
        const cur = Number(s.bag[b.key]||0) + (dir * b.qty);
        if (cur <= 0) delete s.bag[b.key];
        else s.bag[b.key] = cur;
      };

      function updateLootInState(nextItem){
        store.update(s=>{
          ensureWavePlan(data, s, waveKey, slots);
          const w = s.wavePlans[waveKey];
          const prevItem = w.waveItem || null;
          if (prevItem) applyLootDelta(s, prevItem, -1);
          w.waveItem = nextItem;
          if (w.waveItem) applyLootDelta(s, w.waveItem, +1);
          enforceBagConstraints(data, s, applyCharmRulesSync);
        });
      }

      const curLoot = state.wavePlans?.[waveKey]?.waveItem || null;

      // Fixed loot (no picker needed)
      if (fixedName){
        const sel = el('select', {class:'sel-mini wave-loot-sel', title:'Selecting adds it to the shared Bag.'}, [
          el('option', {value:''}, '— claim loot —'),
          (function(){
            const b = lootBundle(fixedName);
            const label = b ? `${b.key}${b.qty>1 ? ` (x${b.qty})` : ''}` : fixedName;
            return el('option', {value:fixedName, selected:curLoot===fixedName}, label);
          })(),
        ]);
        sel.addEventListener('change', ()=> updateLootInState(sel.value || null));
        return el('div', {class:'wave-loot'}, [
          el('span', {class:'lbl'}, 'Loot'),
          sel,
        ]);
      }

      // Split the huge list into compact selectors (gems/plates are type-based)
      const bundles = ['Air Balloon x5', 'Copper Coin x5'];

      const otherItems = uniq(ITEM_CATALOG.slice())
        .filter(n=>!isGem(n))
        .filter(n=>!isPlate(n))
        .filter(n=>!String(n).startsWith('Rare Candy'))
        .filter(n=>!bundles.includes(n))
        .sort((a,b)=>a.localeCompare(b));

      const typeFromGemItem = (name)=>{
        for (const t of TYPES_NO_FAIRY) if (gemName(t) === name) return t;
        return null;
      };
      const typeFromPlateItem = (name)=>{
        for (const t of TYPES_NO_FAIRY) if (plateName(t) === name) return t;
        return null;
      };
      const rareQtyFromItem = (name)=>{
        const s = String(name||'');
        if (s === 'Rare Candy') return 1;
        if (s === 'Rare Candy x2') return 2;
        if (s === 'Rare Candy x3') return 3;
        return null;
      };

      function detectCategory(itemName){
        const n = String(itemName||'');
        if (!n) return {cat:'', val:''};
        if (isGem(n)) return {cat:'gem', val: typeFromGemItem(n) || TYPES_NO_FAIRY[0]};
        if (isPlate(n)) return {cat:'plate', val: typeFromPlateItem(n) || TYPES_NO_FAIRY[0]};
        if (String(n).startsWith('Rare Candy')) return {cat:'rare', val: String(rareQtyFromItem(n) || 1)};
        if (bundles.includes(n)) return {cat:'bundle', val:n};
        return {cat:'other', val:n};
      }

      function resolveItem(cat, val){
        if (!cat) return null;
        if (cat === 'gem') return gemName(val);
        if (cat === 'plate') return plateName(val);
        if (cat === 'rare'){
          const q = Number(val||1);
          if (q === 1) return 'Rare Candy';
          if (q === 2) return 'Rare Candy x2';
          if (q === 3) return 'Rare Candy x3';
          return 'Rare Candy';
        }
        if (cat === 'bundle') return val || null;
        if (cat === 'other') return val || null;
        return null;
      }

      const init = detectCategory(curLoot);
      const catSel = el('select', {class:'sel-mini wave-loot-cat', title:'Wave loot adds to the shared Bag.'}, [
        el('option', {value:''}, '— loot —'),
        el('option', {value:'gem', selected:init.cat==='gem'}, 'Gem (x5)'),
        el('option', {value:'plate', selected:init.cat==='plate'}, 'Plate'),
        el('option', {value:'rare', selected:init.cat==='rare'}, 'Rare Candy'),
        el('option', {value:'bundle', selected:init.cat==='bundle'}, 'Bundles'),
        el('option', {value:'other', selected:init.cat==='other'}, 'Other items'),
      ]);

      const itemSel = el('select', {class:'sel-mini wave-loot-item'});

      function fillItemOptions(cat, curVal){
        itemSel.innerHTML = '';
        itemSel.disabled = !cat;
        if (!cat) return;

        if (cat === 'gem' || cat === 'plate'){
          for (const t of TYPES_NO_FAIRY){
            itemSel.appendChild(el('option', {value:t, selected:String(curVal||'')===String(t)}, t));
          }
          return;
        }
        if (cat === 'rare'){
          const qs = [1,2,3];
          for (const q of qs){
            itemSel.appendChild(el('option', {value:String(q), selected:String(curVal||'')===String(q)}, `x${q}`));
          }
          return;
        }
        if (cat === 'bundle'){
          for (const b of bundles){
            const lbl = (function(){
              const bb = lootBundle(b);
              return bb ? `${bb.key} (x${bb.qty})` : b;
            })();
            itemSel.appendChild(el('option', {value:b, selected:String(curVal||'')===String(b)}, lbl));
          }
          return;
        }
        if (cat === 'other'){
          itemSel.appendChild(el('option', {value:''}, '— select —'));
          for (const n of otherItems){
            const bb = lootBundle(n);
            const lbl = bb ? `${bb.key}${bb.qty>1 ? ` (x${bb.qty})` : ''}` : n;
            itemSel.appendChild(el('option', {value:n, selected:String(curVal||'')===String(n)}, lbl));
          }
          return;
        }
      }

      function commitFromSelectors(){
        const cat = catSel.value || '';
        const val = itemSel.value || '';
        const next = resolveItem(cat, val);
        updateLootInState(next);
      }

      fillItemOptions(init.cat, init.val);
      if (init.cat) itemSel.value = String(init.val||'');

      catSel.addEventListener('change', ()=>{
        const cat = catSel.value || '';
        // Set a safe default value per category
        const defVal = (cat === 'gem' || cat === 'plate') ? TYPES_NO_FAIRY[0]
          : (cat === 'rare') ? '1'
          : (cat === 'bundle') ? (bundles[0] || '')
          : (cat === 'other') ? ''
          : '';
        fillItemOptions(cat, defVal);
        if (cat) itemSel.value = String(defVal||'');
        commitFromSelectors();
      });
      itemSel.addEventListener('change', commitFromSelectors);

      // Layout: compact and wrap-friendly without needing CSS changes.
      return el('div', {class:'wave-loot'}, [
        el('span', {class:'lbl'}, 'Loot'),
        el('span', {style:'display:flex; gap:6px; align-items:center; flex-wrap:wrap'}, [
          catSel,
          itemSel,
        ]),
      ]);
    })();

    const head = el('div', {class:'wave-head'}, [
      el('div', {class:'wave-left'}, [
        el('div', {}, [
          el('div', {class:'wave-title'}, title),
          el('div', {class:'wave-meta'}, `Phase ${first.phase} · Wave ${first.wave} · ${slots.length} defenders`),
        ]),
      ]),
      el('div', {class:'wave-actions'}, [lootInline, btn]),
    ]);

    const body = el('div', {class:'wave-body ' + (expanded ? '' : 'hidden')});

    if (expanded){
      prefetchBaseForSlots(slots);
      const wp = state.wavePlans?.[waveKey] || null;
      body.appendChild(renderWavePlanner(state, waveKey, slots, wp));
    }

    return el('div', {class:'wave-card' + (expanded ? ' expanded' : '')}, [head, body]);
  }

  

  // Simple per-wave fight tracker (4 fights per wave).
  // Uses the same auto move selection logic as the fight plan.
  function renderWaveFightsPanel(state, waveKey, slots, wp){
    const phase = Number(slots[0]?.phase || 1);
    const defLimit = phaseDefenderLimit(phase);
    const slotByKey = new Map(slots.map(s=>[s.rowKey,s]));

	    const planAttackers = (wp.attackerOrder || wp.attackerStart || []).slice(0,2);

    const fights = Array.isArray(wp.fights) ? wp.fights : [];
    const doneCount = fights.filter(f=>f && f.done).length;

    const panel = el('div', {class:'panel'}, [
      el('div', {class:'panel-title'}, `Wave fights — ${doneCount}/4 done`),
      el('div', {class:'muted small'}, 'Quick tracker for the 4 in-game fights on this wave. Moves are auto-picked from your roster priorities. Use the Sim tab for full PP + turn-by-turn simulation.'),
    ]);

    // Map rowKey -> base species (global) for claim revert checks.
    const baseByRowKey = (()=>{
      const m = new Map();
      const baseCache = state.baseCache || {};
      for (const x of (data.calcSlots||[])){
        const rk = String(x.rowKey || x.key || '');
        if (!rk) continue;
        const sp = fixName(x.defender || x.species || x.name || '');
        if (!sp) continue;
        const b = pokeApi.baseOfSync(sp, baseCache);
        m.set(rk, b);
      }
      return m;
    })();

    const baseStillClearedAnywhere = (s, base)=>{
      for (const rk of Object.keys(s.cleared||{})){
        if (!s.cleared[rk]) continue;
        if (baseByRowKey.get(String(rk)) === base) return true;
      }
      return false;
    };

    const clearWaveClaims = (s)=>{
      const waveRowKeys = (slots||[]).map(sl=>String(sl.rowKey||'')).filter(Boolean);
      const affectedBases = new Set();
      for (const rk of waveRowKeys){
        if (s.cleared?.[rk]){
          delete s.cleared[rk];
          const b = baseByRowKey.get(rk);
          if (b) affectedBases.add(b);
        }
      }
      for (const b of affectedBases){
        if (!baseStillClearedAnywhere(s, b)){
          if (s.unlocked) delete s.unlocked[b];
        }
      }
    };

    const clearClaimsForRowKeys = (s, rowKeys)=>{
      const affectedBases = new Set();
      for (const rkRaw of (rowKeys||[])){
        const rk = String(rkRaw||'');
        if (!rk) continue;
        if (s.cleared?.[rk]){
          delete s.cleared[rk];
          const b = baseByRowKey.get(rk);
          if (b) affectedBases.add(b);
        }
      }
      for (const b of affectedBases){
        if (!baseStillClearedAnywhere(s, b)){
          if (s.unlocked) delete s.unlocked[b];
        }
      }
    };

    const resetAll = el('button', {class:'btn-mini'}, 'Reset fights');
    resetAll.addEventListener('click', ()=>{
      store.update(s=>{
        const w = s.wavePlans?.[waveKey];
        if (!w || !Array.isArray(w.fights)) return;
        for (const f of w.fights){
          if (!f) continue;
          f.done = false;
          f.summary = null;
          f.lockToPlan = true;
        }
        clearWaveClaims(s);
      });
    });
    const fullSolveBtn = el('button', {class:'btn-mini'}, 'Full solve');
    const fullFightBtn = el('button', {class:'btn-mini'}, 'Full fight');
    const altMeta = wp.solve;
    const altHintText = (altMeta && Array.isArray(altMeta.alts) && altMeta.alts.length > 1)
      ? `Alt ${(Number(altMeta.idx||0)+1)}/${altMeta.alts.length} (click Full solve to cycle)`
      : '';
    const altHint = el('span', {class:'muted small', style:'margin-left:6px'}, altHintText);

    panel.appendChild(el('div', {style:'margin-top:10px; display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap'}, [
      el('div', {class:'muted small', style:'align-self:center'}, 'Auto-fill 4 fights to cover as many species as possible with low prio OHKOs.'),
      el('div', {style:'display:flex; gap:8px; align-items:center; flex-wrap:wrap'}, [fullFightBtn, fullSolveBtn, altHint, resetAll]),
    ]));

    const activeRoster = (state.roster||[]).filter(r=>r.active);
    if (activeRoster.length < 2){
      panel.appendChild(el('div', {class:'muted small', style:'margin-top:10px'}, 'Need at least 2 active roster mons to simulate fights.'));
      return panel;
    }

    const rosterOpts = activeRoster
      .map(r=>({id:r.id, label:rosterLabel(r)}))
      .sort((a,b)=>a.label.localeCompare(b.label));

    const bestMoveFor = (attId, defSlot)=>{
      const r = byId(state.roster, attId);
      if (!r || !defSlot) return null;
      const atk = {
        species:(r.effectiveSpecies||r.baseSpecies),
        level: state.settings.claimedLevel,
        ivAll: state.settings.claimedIV,
        evAll: r.strength ? state.settings.strengthEV : state.settings.claimedEV,
      };
      const def = {species:defSlot.defender, level:defSlot.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
      const res = calc.chooseBestMove({
        data,
        attacker: atk,
        defender: def,
        movePool: r.movePool||[],
        settings: settingsForWave(state, wp, attId, defSlot.rowKey),
        tags: defSlot.tags||[],
      });
      return res?.best || null;
    };

    const scoreTuple = (m0, m1)=>{
      const ohko = (m0?.oneShot ? 1 : 0) + (m1?.oneShot ? 1 : 0);
      const worstPrio = Math.max(m0?.prio ?? 9, m1?.prio ?? 9);
      const avgPrio = ((m0?.prio ?? 9) + (m1?.prio ?? 9)) / 2;
      const overkill = Math.abs((m0?.minPct ?? 0) - 100) + Math.abs((m1?.minPct ?? 0) - 100);
      return {ohko, worstPrio, avgPrio, overkill};
    };

    const better = (a,b)=>{
      if (a.ohko !== b.ohko) return a.ohko > b.ohko;
      if (a.worstPrio !== b.worstPrio) return a.worstPrio < b.worstPrio;
      if (a.avgPrio !== b.avgPrio) return a.avgPrio < b.avgPrio;
      return a.overkill <= b.overkill;
    };

    // Auto-fill 4 fights for this wave.
    // Goal: cover as many unique base species as possible (up to 8 slots), prefer low-prio OHKOs.
    // If multiple equivalent best solutions exist, each press cycles through them.
    fullSolveBtn.addEventListener('click', ()=>{
      const st = store.getState();
      const baseCache = st.baseCache || {};
      const act = (st.roster||[]).filter(r=>r.active);
      if (act.length < 2){
        alert('Need at least 2 active roster mons to solve.');
        return;
      }

      const baseOfSlot = (sl)=> pokeApi.baseOfSync(sl.defender, baseCache);
      const slotForBase = new Map();
      for (const sl of slots){
        const b = baseOfSlot(sl);
        if (!slotForBase.has(b)) slotForBase.set(b, sl);
      }
      const waveBases = Array.from(slotForBase.keys());

      const maxFuturePhase = Math.min(3, phase + 2);
      const futureCount = (base)=>{
        let c = 0;
        for (const x of (data.calcSlots || [])){
          const ph = Number(x.phase || x.Phase || 0);
          if (!(ph > phase && ph <= maxFuturePhase)) continue;
          const sp = fixName(x.defender || x.species || x.name || '');
          const b = pokeApi.baseOfSync(sp, baseCache);
          if (b === base) c++;
        }
        return c;
      };

      // Choose up to 8 bases.
      let chosenBases = waveBases.slice().sort((a,b)=>{
        const fa = futureCount(a);
        const fb = futureCount(b);
        if (fa !== fb) return fa - fb; // less reclaimable first
        return String(a).localeCompare(String(b));
      }).slice(0, 8);

      // Local best-move helper using current state.
      const bestMoveFor2 = (attId, defSlot)=>{
        const r = byId(st.roster, attId);
        if (!r || !defSlot) return null;
        const atk = {
          species:(r.effectiveSpecies||r.baseSpecies),
          level: st.settings.claimedLevel,
          ivAll: st.settings.claimedIV,
          evAll: r.strength ? st.settings.strengthEV : st.settings.claimedEV,
        };
        const def = {species:defSlot.defender, level:defSlot.level, ivAll: st.settings.wildIV, evAll: st.settings.wildEV};
        const res = calc.chooseBestMove({
          data,
          attacker: atk,
          defender: def,
          movePool: r.movePool||[],
          settings: settingsForWave(st, st.wavePlans?.[waveKey] || {}, attId, defSlot.rowKey),
          tags: defSlot.tags||[],
        });
        return res?.best || null;
      };

      const attIds = act.map(r=>r.id);
      const attPairs = [];
      for (let i=0;i<attIds.length;i++){
        for (let j=i+1;j<attIds.length;j++) attPairs.push([attIds[i], attIds[j]]);
      }

      const easePrio = (base)=>{
        const sl = slotForBase.get(base);
        if (!sl) return 9;
        let best = 9;
        for (const r of act){
          const m = bestMoveFor2(r.id, sl);
          if (m && m.oneShot) best = Math.min(best, (m.prio ?? 9));
        }
        return best;
      };

      // Pick a "filler" base when fewer than 8 bases exist.
      // We want a filler that stays low-prio *when paired with other bases*, not just solo ease.
      const fillScore = (fillBase)=>{
        const dFill = slotForBase.get(fillBase);
        if (!dFill) return 9;
        let sum = 0;
        let n = 0;
        for (const other of chosenBases){
          const dOther = slotForBase.get(other);
          if (!dOther) continue;
          // For this pair, find the best attacker pair (by our scoring tuple).
          let bestRec = null;
          for (const [aId,bId] of attPairs){
            const a0 = bestMoveFor2(aId, dFill);
            const a1 = bestMoveFor2(aId, dOther);
            const b0 = bestMoveFor2(bId, dFill);
            const b1 = bestMoveFor2(bId, dOther);
            const opt1 = {tuple: scoreTuple(a0,b1)}; // a->fill, b->other
            const opt2 = {tuple: scoreTuple(a1,b0)}; // a->other, b->fill
            const chosen = better(opt1.tuple, opt2.tuple) ? opt1 : opt2;
            const rec = {tuple: chosen.tuple};
            if (!bestRec || better(rec.tuple, bestRec.tuple)) bestRec = rec;
          }
          const t = bestRec?.tuple;
          if (!t) continue;
          sum += (t.avgPrio ?? 9);
          n++;
        }
        return n ? (sum / n) : 9;
      };

      if (chosenBases.length && chosenBases.length < 8){
        // Consider all bases as potential fillers; prefer lowest fillScore, then easePrio.
        const candidates = chosenBases.slice();
        candidates.sort((a,b)=>{
          const sa = fillScore(a);
          const sb = fillScore(b);
          if (sa !== sb) return sa - sb;
          const ea = easePrio(a);
          const eb = easePrio(b);
          if (ea !== eb) return ea - eb;
          return String(a).localeCompare(String(b));
        });
        const fillBase = candidates[0];
        while (chosenBases.length < 8) chosenBases.push(fillBase);
      }

      if (!chosenBases.length){
        alert('No defenders found for this wave.');
        return;
      }

      // Build 8 defender keys. Allow duplicates by repeating the same base rowKey.
      const defKeys = [];
      for (const b of chosenBases){
        const sl = slotForBase.get(b);
        if (!sl) continue;
        defKeys.push(sl.rowKey);
      }
      while (defKeys.length < 8) defKeys.push(defKeys[defKeys.length-1]);
      defKeys.length = 8;

      // If we already computed alternatives for the same roster+wave, just cycle.
      const sig = `${waveKey}|${act.map(r=>r.id).join(',')}|${defKeys.join(',')}`;
      const existing = st.wavePlans?.[waveKey]?.solve;
      if (existing && existing.sig === sig && Array.isArray(existing.alts) && existing.alts.length){
        const nextIdx = (Number(existing.idx || 0) + 1) % existing.alts.length;
        const alt = existing.alts[nextIdx];
        store.update(s=>{
          const w = s.wavePlans?.[waveKey];
          if (!w) return;
          w.solve = w.solve || {};
          w.solve.sig = sig;
          w.solve.idx = nextIdx;
          w.solve.alts = existing.alts;
          w.fights = Array.isArray(w.fights) ? w.fights : [];
          while (w.fights.length < 4) w.fights.push({done:false, summary:null, lockToPlan:true, defenders:[], attackers:[]});
          for (let fi=0;fi<4;fi++){
            const spec = alt.fights?.[fi];
            const f = w.fights[fi];
            if (!spec || !f) continue;
            f.defenders = [spec.d0, spec.d1];
            f.attackers = [spec.aId, spec.bId];
            f.lockToPlan = false;
            f.done = false;
            f.summary = null;
          }
        });
        return;
      }

      // Precompute best attacker pair for each defender pair.
      const pairBest = Array.from({length:8}, ()=> Array.from({length:8}, ()=> null));

      const bestForDefPair = (d0, d1)=>{
        let bestRec = null;
        for (const [aId,bId] of attPairs){
          const a0 = bestMoveFor2(aId, d0);
          const a1 = bestMoveFor2(aId, d1);
          const b0 = bestMoveFor2(bId, d0);
          const b1 = bestMoveFor2(bId, d1);
          const opt1 = {tuple: scoreTuple(a0,b1), aId, bId};
          const opt2 = {tuple: scoreTuple(a1,b0), aId, bId};
          const chosen = better(opt1.tuple, opt2.tuple) ? opt1 : opt2;
          const rec = {aId: chosen.aId, bId: chosen.bId, tuple: chosen.tuple};
          if (!bestRec || better(rec.tuple, bestRec.tuple)) bestRec = rec;
        }
        return bestRec;
      };

      for (let i=0;i<8;i++){
        for (let j=i+1;j<8;j++){
          const d0 = slotByKey.get(baseDefKey(defKeys[i]));
          const d1 = slotByKey.get(baseDefKey(defKeys[j]));
          if (!d0 || !d1) continue;
          pairBest[i][j] = bestForDefPair(d0,d1);
          pairBest[j][i] = pairBest[i][j];
        }
      }

      const scoreSchedule = (pairs)=>{
        let totalOhko = 0;
        let worstWorstPrio = 0;
        let sumAvg = 0;
        let highFights = 0;
        let totalOverkill = 0;
        for (const p of pairs){
          const t = p.best?.tuple || {ohko:0, worstPrio:9, avgPrio:9, overkill:999};
          totalOhko += t.ohko;
          worstWorstPrio = Math.max(worstWorstPrio, t.worstPrio);
          sumAvg += t.avgPrio;
          if ((t.avgPrio ?? 9) > 1.000001) highFights++;
          totalOverkill += t.overkill;
        }
        return { totalOhko, worstWorstPrio, highFights, sumAvgPrio: sumAvg, totalOverkill };
      };

      const cmpScore = (A,B)=>{
        if (A.totalOhko !== B.totalOhko) return B.totalOhko - A.totalOhko;
        if (A.worstWorstPrio !== B.worstWorstPrio) return A.worstWorstPrio - B.worstWorstPrio;
        if (A.highFights !== B.highFights) return A.highFights - B.highFights;
        if (A.sumAvgPrio !== B.sumAvgPrio) return A.sumAvgPrio - B.sumAvgPrio;
        if (A.totalOverkill !== B.totalOverkill) return A.totalOverkill - B.totalOverkill;
        return 0;
      };

      // Enumerate all perfect matchings of 8 indices (105 total) and keep top alternatives.
      const schedules = [];
      const recMatch = (mask, pairs)=>{
        if (mask === 0){
          const sc = scoreSchedule(pairs);
          schedules.push({pairs, score: sc});
          return;
        }
        let i = 0;
        while (i < 8 && ((mask & (1<<i)) === 0)) i++;
        for (let j=i+1;j<8;j++){
          if ((mask & (1<<j)) === 0) continue;
          const b = pairBest[i][j];
					if (!b || !b.length) continue;
					recMatch(mask & ~(1<<i) & ~(1<<j), pairs.concat([{i,j,choices:b, best:b[0]}]));
				}
      };
      recMatch((1<<8)-1, []);
      if (!schedules.length){
        alert('Could not solve this wave with current roster/moves.');
        return;
      }
      schedules.sort((x,y)=> cmpScore(x.score,y.score));

      // Keep up to 5 unique alternatives (different defender pairing layouts).
      const alts = [];
      const seen = new Set();
      for (const sch of schedules){
        const key = sch.pairs
          .map(p=>[Math.min(p.i,p.j),Math.max(p.i,p.j)].join('-'))
          .sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const fights = sch.pairs.slice(0,4).map(p=>({
          d0: defKeys[p.i],
          d1: defKeys[p.j],
          aId: p.best.aId,
          bId: p.best.bId,
          tuple: p.best.tuple,
        }));
        alts.push({fights, score: sch.score});
        if (alts.length >= 5) break;
      }

      const alt0 = alts[0];
      store.update(s=>{
        const w = s.wavePlans?.[waveKey];
        if (!w) return;
        w.solve = {sig, idx:0, alts};
        w.fights = Array.isArray(w.fights) ? w.fights : [];
        while (w.fights.length < 4) w.fights.push({done:false, summary:null, lockToPlan:true, defenders:[], attackers:[]});
        for (let fi=0;fi<4;fi++){
          const spec = alt0.fights?.[fi];
          const f = w.fights[fi];
          if (!spec || !f) continue;
          f.defenders = [spec.d0, spec.d1];
          f.attackers = [spec.aId, spec.bId];
          f.lockToPlan = false;
          f.done = false;
          f.summary = null;
        }
      });
    });

    // Full fight = clear existing fights/claims, run Full solve, then simulate all 4 fights.
    fullFightBtn.addEventListener('click', ()=>{
      // Clear fights + claims first (explicitly requested behavior).
      store.update(s=>{
        const w = s.wavePlans?.[waveKey];
        if (w && Array.isArray(w.fights)){
          for (const f of w.fights){
            if (!f) continue;
            f.done = false;
            f.summary = null;
            f.lockToPlan = true;
          }
        }
        clearWaveClaims(s);
      });

      // Fill fights.
      fullSolveBtn.click();

      // Simulate all 4 fights.
      const st = store.getState();
      const w = st.wavePlans?.[waveKey];
      if (!w || !Array.isArray(w.fights)) return;

      for (let fi=0;fi<Math.min(4, w.fights.length);fi++){
        const f = w.fights[fi];
        if (!f) continue;
        const aId = f.attackers?.[0] || planAttackers[0] || rosterOpts[0]?.id;
        const bId = f.attackers?.[1] || planAttackers[1] || rosterOpts[1]?.id;
        const rawDefKeys = (f.defenders && f.defenders.length) ? f.defenders : (w.defenders||[]);
        const defKeys = (rawDefKeys||[]).filter(Boolean).slice(0,2);
        const defSlots = defKeys.map(rk=>slotByKey.get(baseDefKey(rk))).filter(Boolean);
        if (!aId || !bId || aId === bId) continue;
        if (defSlots.length < 2) continue;

        const d0 = defSlots[0];
        const d1 = defSlots[1];
        const a0 = bestMoveFor(aId, d0);
        const a1 = bestMoveFor(aId, d1);
        const b0 = bestMoveFor(bId, d0);
        const b1 = bestMoveFor(bId, d1);
        const opt1 = {a:{target:d0, best:a0}, b:{target:d1, best:b1}, tuple: scoreTuple(a0,b1)};
        const opt2 = {a:{target:d1, best:a1}, b:{target:d0, best:b0}, tuple: scoreTuple(a1,b0)};
        const chosen = better(opt1.tuple, opt2.tuple) ? opt1 : opt2;
        const leadOk = !!(chosen.a.best?.oneShot && chosen.b.best?.oneShot);
        const prAvg = ((chosen.a.best?.prio ?? 9) + (chosen.b.best?.prio ?? 9)) / 2;
        const ok = leadOk;
        const text = [
          `A → ${chosen.a.target.defender}: ${chosen.a.best?.move||'—'} (P${chosen.a.best?.prio||'?'} ${formatPct(chosen.a.best?.minPct||0)})`,
          `B → ${chosen.b.target.defender}: ${chosen.b.best?.move||'—'} (P${chosen.b.best?.prio||'?'} ${formatPct(chosen.b.best?.minPct||0)})`,
          `prioØ ${formatPrioAvg(prAvg)}`,
        ].join(' | ');

        store.update(s=>{
          const ww = s.wavePlans?.[waveKey];
          if (!ww || !Array.isArray(ww.fights)) return;
          const ff = ww.fights[fi];
          if (!ff) return;
          ff.attackers = [aId,bId];
          ff.lockToPlan = false;
          ff.done = true;
          ff.summary = {ok, text};
          // Claim the 2 enemies fought.
          const baseCache = s.baseCache || {};
          for (const rk of defKeys){
            const sl = slotByKey.get(baseDefKey(rk));
            if (!sl) continue;
            const base = pokeApi.baseOfSync(sl.defender, baseCache);
            s.unlocked[base] = true;
            s.cleared[baseDefKey(rk)] = true;
          }
        });
      }
    });

	    const fightRow = (i, fight)=>{
      const row = el('div', {class:'fight-row'}, []);

      const title = el('div', {style:'font-weight:900'}, `Fight ${i+1}`);

	      // By default, fights follow the wave-level "Fight plan" starters.
	      // If the user manually changes attackers for a fight, we lock that fight to its own pair.
	      const lockedToPlan = (fight.lockToPlan !== false);
	      const fallbackA = planAttackers[0] || rosterOpts[0]?.id || '';
	      const fallbackB = planAttackers[1] || rosterOpts[1]?.id || rosterOpts[0]?.id || '';
	      const curA = lockedToPlan ? (fallbackA) : (fight.attackers?.[0] || fallbackA);
	      const curB = lockedToPlan ? (fallbackB) : (fight.attackers?.[1] || fallbackB);

	      const aSel = el('select', {class:'sel-mini'}, rosterOpts.map(o=>el('option', {value:o.id, selected: String(curA)===String(o.id), disabled:String(o.id)===String(curB)}, o.label)));
	      const bSel = el('select', {class:'sel-mini'}, rosterOpts.map(o=>el('option', {value:o.id, selected: String(curB)===String(o.id), disabled:String(o.id)===String(curA)}, o.label)));
	      // Ensure the value is applied (browser may choose first enabled option otherwise)
	      aSel.value = String(curA);
	      bSel.value = String(curB);

      const pairWrap = el('div', {style:'display:flex; gap:8px; flex-wrap:wrap; align-items:center'}, [
        el('div', {class:'muted small'}, 'Attackers:'),
        aSel,
        el('span', {class:'muted small'}, '+'),
        bSel,
      ]);

      const defKeyLabel = (rk)=>{
        const sl = slotByKey.get(baseDefKey(rk));
        if (!sl) return String(rk||'');
        const suf = (String(sl.rowKey||'').startsWith(waveKey) ? String(sl.rowKey).slice(waveKey.length) : String(sl.rowKey));
        return `${sl.defender} ${suf}`;
      };

      // Options for per-fight enemy selectors.
      // We allow up to 8 instances because a wave can schedule the same species in all 8 enemy slots across 4 fights.
      const defOptions = (function(){
        const opts = [];
        for (const sl of slots){
          const suf = (String(sl.rowKey||'').startsWith(waveKey) ? String(sl.rowKey).slice(waveKey.length) : String(sl.rowKey));
          const baseLabel = `${sl.defender} ${suf}`;
          for (let n=1;n<=8;n++){
            const key = (n===1) ? String(sl.rowKey) : `${String(sl.rowKey)}#${n}`;
            const label = (n===1) ? baseLabel : `${baseLabel} #${n}`;
            opts.push({key, label});
          }
        }
        opts.sort((a,b)=> String(a.label).localeCompare(String(b.label)));
        return opts;
      })();

      // Enemy selectors per fight (supports duplicates via #2/#3/#4 instance keys).
      const makeEnemySel = (value, otherValue, onPick)=>{
        const sel = el('select', {class:'sel-mini'}, [
          el('option', {value:''}, '—'),
          ...defOptions.map(o=>
            el('option', {value:o.key, selected:String(o.key)===String(value), disabled:String(o.key)===String(otherValue)}, o.label)
          ),
        ]);
        sel.value = String(value||'');
        sel.addEventListener('change', ()=> onPick(sel.value));
        return sel;
      };

      const baseSelected = (store.getState().wavePlans?.[waveKey]?.defenders || []).filter(Boolean).slice(0,2);
      const fallbackD0 = (baseSelected[0] || slots[0]?.rowKey || '');
      const fallbackD1 = (baseSelected[1] || slots[1]?.rowKey || slots[0]?.rowKey || '');

      const curDefKeys = (fight.defenders||[]).filter(Boolean).slice(0,2);
      const curD0 = curDefKeys[0] || fallbackD0;
      const curD1 = curDefKeys[1] || fallbackD1;

      const normalizeDistinct = (a,b)=>{
        if (!a || !b) return [a,b];
        if (String(a) !== String(b)) return [a,b];
        // If same key, auto bump second to next instance.
        const base = baseDefKey(a);
        for (let n=2;n<=8;n++){
          const cand = `${base}#${n}`;
          if (String(cand) !== String(a)) return [a,cand];
        }
        return [a,b];
      };

      const enemiesWrap = el('div', {style:'display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:4px'}, [
        el('div', {class:'muted small'}, 'Enemies:'),
      ]);

      let dSel0 = null;
      let dSel1 = null;
      dSel0 = makeEnemySel(curD0, curD1, (val)=>{
        const [a,b] = normalizeDistinct(val, dSel1?.value);
        if (dSel1) dSel1.value = String(b||'');
        store.update(s=>{
          const w = s.wavePlans?.[waveKey];
          if (!w || !Array.isArray(w.fights)) return;
          const f = w.fights[i];
          if (!f) return;
          f.defenders = [a,b].filter(Boolean);
          f.done = false;
          f.summary = null;
        });
      });
      dSel1 = makeEnemySel(curD1, curD0, (val)=>{
        const [a,b] = normalizeDistinct(dSel0?.value, val);
        if (dSel0) dSel0.value = String(a||'');
        store.update(s=>{
          const w = s.wavePlans?.[waveKey];
          if (!w || !Array.isArray(w.fights)) return;
          const f = w.fights[i];
          if (!f) return;
          f.defenders = [a,b].filter(Boolean);
          f.done = false;
          f.summary = null;
        });
      });
      enemiesWrap.appendChild(dSel0);
      enemiesWrap.appendChild(el('span', {class:'muted small'}, '+'));
      enemiesWrap.appendChild(dSel1);

      const plannedText = (()=>{
        const aId = aSel.value;
        const bId = bSel.value;
        const dk0 = dSel0.value;
        const dk1 = dSel1.value;
        const d0 = slotByKey.get(baseDefKey(dk0));
        const d1 = slotByKey.get(baseDefKey(dk1));
        if (!aId || !bId || !d0 || !d1) return null;
        if (String(aId) === String(bId)) return null;
        const a0 = bestMoveFor(aId, d0);
        const a1 = bestMoveFor(aId, d1);
        const b0 = bestMoveFor(bId, d0);
        const b1 = bestMoveFor(bId, d1);
        const opt1 = {a:{target:d0, best:a0}, b:{target:d1, best:b1}, tuple: scoreTuple(a0,b1)};
        const opt2 = {a:{target:d1, best:a1}, b:{target:d0, best:b0}, tuple: scoreTuple(a1,b0)};
        const chosen = better(opt1.tuple, opt2.tuple) ? opt1 : opt2;
        const prAvg = ((chosen.a.best?.prio ?? 9) + (chosen.b.best?.prio ?? 9)) / 2;
        return `Planned: A → ${chosen.a.target.defender}: ${chosen.a.best?.move||'—'} (P${chosen.a.best?.prio||'?'} ${formatPct(chosen.a.best?.minPct||0)}) | `+
               `B → ${chosen.b.target.defender}: ${chosen.b.best?.move||'—'} (P${chosen.b.best?.prio||'?'} ${formatPct(chosen.b.best?.minPct||0)}) | prioØ ${formatPrioAvg(prAvg)}`;
      })();

      const summaryWrap = el('div', {class:'muted small', style:'margin-top:6px'}, fight.summary ? fight.summary.text : (plannedText || 'Not simulated yet.'));

      const simulateBtn = el('button', {class:'btn-mini'}, fight.done ? 'Re-sim' : 'Simulate');
      const resetBtn = el('button', {class:'btn-mini'}, 'Reset');

      const pillEl = fight.done
        ? pill(fight.summary?.ok ? 'OK' : 'RISK', fight.summary?.ok ? 'good' : 'warn')
        : pill('PENDING','');

	      const onSim = ()=>{
	        const aId = aSel.value;
	        const bId = bSel.value;
        if (!aId || !bId || aId === bId){
          alert('Choose two different attackers.');
          return;
        }

        const curState = store.getState();
        const curW = curState.wavePlans?.[waveKey];
        const curF = (curW && Array.isArray(curW.fights)) ? (curW.fights[i] || {}) : {};
        const rawDefKeys = (curF.defenders && curF.defenders.length)
          ? curF.defenders
          : (curW?.defenders || []);
        const defKeys = (rawDefKeys||[]).filter(Boolean).slice(0, 2);
        const defSlots = defKeys.map(rk=>slotByKey.get(baseDefKey(rk))).filter(Boolean);
        if (defSlots.length < 2){
          alert('Pick 2 enemies for this fight (or use Selected enemies above).');
          return;
        }

        const d0 = defSlots[0];
        const d1 = defSlots[1];

        const a0 = bestMoveFor(aId, d0);
        const a1 = bestMoveFor(aId, d1);
        const b0 = bestMoveFor(bId, d0);
        const b1 = bestMoveFor(bId, d1);

        const opt1 = {a:{target:d0, best:a0}, b:{target:d1, best:b1}, tuple: scoreTuple(a0,b1)};
        const opt2 = {a:{target:d1, best:a1}, b:{target:d0, best:b0}, tuple: scoreTuple(a1,b0)};
        const chosen = better(opt1.tuple, opt2.tuple) ? opt1 : opt2;

        // Bench coverage (3rd/4th)
        let benchOk = true;
        const benchLines = [];
        for (const ds of defSlots.slice(2)){
          const am = bestMoveFor(aId, ds);
          const bm = bestMoveFor(bId, ds);
          const ok = (am && am.oneShot) || (bm && bm.oneShot);
          if (!ok) benchOk = false;
          const who = (am && am.oneShot && (!bm || !bm.oneShot || (am.prio??9) <= (bm.prio??9))) ? 'A' : 'B';
          const pick = who==='A' ? am : bm;
          benchLines.push(`${ds.defender}: ${who} ${pick?.move||'—'} (P${pick?.prio||'?'} ${formatPct(pick?.minPct||0)})`);
        }

        const leadOk = !!(chosen.a.best?.oneShot && chosen.b.best?.oneShot);
        const ok = leadOk && benchOk;

        const prAvg = ((chosen.a.best?.prio ?? 9) + (chosen.b.best?.prio ?? 9)) / 2;

        const text = [
          `A → ${chosen.a.target.defender}: ${chosen.a.best?.move||'—'} (P${chosen.a.best?.prio||'?'} ${formatPct(chosen.a.best?.minPct||0)})`,
          `B → ${chosen.b.target.defender}: ${chosen.b.best?.move||'—'} (P${chosen.b.best?.prio||'?'} ${formatPct(chosen.b.best?.minPct||0)})`,
          `prioØ ${formatPrioAvg(prAvg)}`,
          benchLines.length ? `Bench: ${benchLines.join(' · ')}` : null,
        ].filter(Boolean).join(' | ');

	        store.update(s=>{
          const w = s.wavePlans?.[waveKey];
          if (!w || !Array.isArray(w.fights)) return;
          const f = w.fights[i];
          if (!f) return;
          f.attackers = [aId,bId];
	          f.lockToPlan = false;
          f.done = true;
          f.summary = {ok, text};

          // Auto-claim: simulating a fight means you will do it in-game; claim the enemies fought.
          const baseCache = s.baseCache || {};
          const fought = (f.defenders && f.defenders.length) ? f.defenders : (w.defenders||[]);
          for (const rk of (fought||[]).filter(Boolean).slice(0,2)){
            const sl = slotByKey.get(baseDefKey(rk));
            if (!sl) continue;
            const base = pokeApi.baseOfSync(sl.defender, baseCache);
            s.unlocked[base] = true;
            s.cleared[baseDefKey(rk)] = true;
          }
        });
      };

      simulateBtn.addEventListener('click', onSim);
	      resetBtn.addEventListener('click', ()=>{
        store.update(s=>{
          const w = s.wavePlans?.[waveKey];
          if (!w || !Array.isArray(w.fights)) return;
          const f = w.fights[i];
          if (!f) return;
          // Undo claims from this fight (only the enemies fought in this fight).
          const fought = (f.defenders && f.defenders.length) ? f.defenders : (w.defenders||[]);
          const keys = (fought||[]).filter(Boolean).slice(0,2).map(k=>baseDefKey(k));
          clearClaimsForRowKeys(s, keys);
          f.done = false;
          f.summary = null;
	          // Reset back to plan-linked attackers.
	          f.lockToPlan = true;
        });
      });

	      aSel.addEventListener('change', ()=>{
        store.update(s=>{
          const w = s.wavePlans?.[waveKey];
          if (!w || !Array.isArray(w.fights)) return;
          const f = w.fights[i];
          if (!f) return;
	          f.attackers = [aSel.value, bSel.value];
	          f.lockToPlan = false;
        });
      });
	      bSel.addEventListener('change', ()=>{
        store.update(s=>{
          const w = s.wavePlans?.[waveKey];
          if (!w || !Array.isArray(w.fights)) return;
          const f = w.fights[i];
          if (!f) return;
	          f.attackers = [aSel.value, bSel.value];
	          f.lockToPlan = false;
        });
      });

      row.appendChild(el('div', {style:'display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap'}, [
        el('div', {}, [title, pillEl]),
        el('div', {style:'display:flex; gap:8px; align-items:center; flex-wrap:wrap'}, [simulateBtn, resetBtn]),
      ]));
      row.appendChild(pairWrap);
      row.appendChild(enemiesWrap);
      row.appendChild(summaryWrap);
      return row;
    };

    for (let i=0;i<4;i++){
      const f = fights[i] || {attackers:(wp.attackerStart||[]).slice(0,2), done:false, summary:null};
      panel.appendChild(fightRow(i,f));
      if (i<3) panel.appendChild(el('div', {class:'hr'}));
    }

    return panel;
  }

function renderWavePlanner(state, waveKey, slots, wp){
    if (!wp){
      // Rare: if wavePlans missing, normalize once
      store.update(s => { ensureWavePlan(data, s, waveKey, slots); });
      state = store.getState();
      wp = state.wavePlans[waveKey];
    }

    const phase = Number(slots[0]?.phase || 1);
    const defLimit = phaseDefenderLimit(phase);

    const slotByKey = new Map(slots.map(s=>[s.rowKey, s]));

    const selectedDef = new Set((wp.defenders||[]).slice(0, defLimit));


    function commitSelected(){
      store.update(s => {
        ensureWavePlan(data, s, waveKey, slots);
        const w = s.wavePlans[waveKey];
        w.defenders = Array.from(selectedDef).slice(0, defLimit);
        w.defenderStart = w.defenders.slice(0,2);
        // Attackers are global (active roster). Keep existing starter picks if valid.
        w.manualOrder = false;
        ensureWavePlan(data, s, waveKey, slots);
      });
    }

    // helper UI controls
    const stageSel = (cur, onChange)=>{
      const sel = el('select', {class:'sel-mini'}, Array.from({length:13}).map((_,i)=>{
        const v = i-6;
        return el('option', {value:String(v), selected:Number(cur)===v}, (v>=0?`+${v}`:`${v}`));
      }));
      sel.addEventListener('change', ()=> onChange(Number(sel.value)||0));
      return sel;
    };
    const hpPctInput = (cur, onChange)=>{
      const inp = el('input', {type:'number', min:'1', max:'100', step:'1', value:String(cur ?? 100), class:'inp-mini'});
      inp.addEventListener('change', ()=> onChange(clampInt(inp.value,1,100)));
      return inp;
    };
    const chip = (label, node)=> el('div', {class:'modchip'}, [el('span', {class:'lbl'}, label), node]);

    // Mod patchers (defenders only; attacker mods are global from Roster tab)
    function patchDefMods(rowKey, patch){
      store.update(s => {
        const w = s.wavePlans[waveKey];
        w.monMods = w.monMods || {atk:{}, def:{}};
        w.monMods.def = w.monMods.def || {};
        const cur = w.monMods.def[rowKey] || {};
        w.monMods.def[rowKey] = {...cur, ...(patch||{})};
      });
    }

    const getDefMods = (rowKey)=> getWaveDefMods(state.settings, wp, rowKey);

    function buildDefModRow(slotObj){
      const dm = getDefMods(slotObj.rowKey);
      const wrap = el('div', {class:'modrow'}, [
        chip('HP%', hpPctInput(dm.hpPct, v=>patchDefMods(slotObj.rowKey,{hpPct:v}))),
        chip('Atk', stageSel(dm.atkStage, v=>patchDefMods(slotObj.rowKey,{atkStage:v}))),
        chip('SpA', stageSel(dm.spaStage, v=>patchDefMods(slotObj.rowKey,{spaStage:v}))),
        chip('Def', stageSel(dm.defStage, v=>patchDefMods(slotObj.rowKey,{defStage:v}))),
        chip('SpD', stageSel(dm.spdStage, v=>patchDefMods(slotObj.rowKey,{spdStage:v}))),
        chip('Spe', stageSel(dm.speStage, v=>patchDefMods(slotObj.rowKey,{speStage:v}))),
      ]);

      // Prevent modifier interactions from toggling enemy selection (row click handler).
      const stop = (ev)=>{ ev.stopPropagation(); };
      wrap.addEventListener('click', stop);
      wrap.addEventListener('mousedown', stop);
      wrap.addEventListener('pointerdown', stop);
      wrap.addEventListener('contextmenu', stop);

      return wrap;
    }

    // attacker mods are edited on the Roster tab

    // Enemy picker (lead pair + optional reinforcements)
    // Phase 1: limit is 2, swapping should be effortless. Duplicates are supported by rowKey.
    // Phase 2/3: allow picking up to the phase limit (3/4) so the fight simulator can model reinforcements.
    const enemyList = el('div', {class:'pick-grid'});

	    const selected = Array.from({length:defLimit}).map((_,i)=> (wp.defenders||[])[i] || null);
	    const selectedKeys = selected.filter(Boolean);
	    // rowKey -> list of slot positions (#1..#N)
	    const selectedSlotsByKey = {};
	    for (let i=0;i<selected.length;i++){
	      const k = selected[i];
	      if (!k) continue;
	      selectedSlotsByKey[k] = selectedSlotsByKey[k] || [];
	      selectedSlotsByKey[k].push(i+1);
	    }
	    const selectedBaseSet = new Set(Object.keys(selectedSlotsByKey));

    function setSelectedArr(next){
      const arr = Array.isArray(next) ? next.slice(0, defLimit) : [];
      // Keep order, allow duplicates, but pack slots left (remove gaps)
      const compact = arr.filter(Boolean).slice(0, defLimit);
      while (compact.length < defLimit) compact.push(null);

      store.update(s=>{
        ensureWavePlan(data, s, waveKey, slots);
        const w = s.wavePlans[waveKey];
        w.defenders = compact.filter(Boolean);
        w.defenderStart = w.defenders.slice(0,2);
        w.manualOrder = false;
        ensureWavePlan(data, s, waveKey, slots);
      });
    }

    // Dropdowns: show each species row ONCE (no duplicate instance numbering in the dropdown).
    const optionEls = [];
    for (const sl of slots){
      const label = `${sl.defender} · Lv ${sl.level}`;
      optionEls.push(el('option', {value:sl.rowKey}, label));
    }

    const slotLabelFor = (i)=>{
      return `#${i+1}`;
    };

    const makeSlot = (idx, curKey)=>{
      const sel = el('select', {class:'sel-mini', style:'min-width:270px'}, [
        el('option', {value:''}, '— empty —'),
        ...optionEls.map(o=>{
          const clone = o.cloneNode(true);
          const rk = clone.getAttribute('value');
          if (rk === curKey) clone.setAttribute('selected','selected');
          return clone;
        })
      ]);
      sel.addEventListener('change', ()=>{
        const next = selected.slice();
        next[idx] = sel.value || null;
        setSelectedArr(next);
      });
      const clearBtn = el('button', {class:'btn-mini'}, 'Clear');
      clearBtn.addEventListener('click', ()=>{
        const next = selected.slice();
        next[idx] = null;
        setSelectedArr(next);
      });
      return el('div', {style:'display:flex; gap:8px; align-items:center; flex-wrap:wrap'}, [
        el('span', {class:'muted small', style:'min-width:70px'}, slotLabelFor(idx)),
        sel,
        clearBtn,
      ]);
    };

    const clearAll = el('button', {class:'btn-mini'}, 'Clear all');
    clearAll.addEventListener('click', ()=> setSelectedArr(new Array(defLimit).fill(null)));

	    const selectionSummary = selectedKeys.length
	      ? el('div', {class:'muted small', style:'margin-top:6px'},
	          'Order: ' + selected
	            .map((rk, i)=> rk ? `#${i+1} ${slotByKey.get(rk)?.defender || rk}` : null)
	            .filter(Boolean)
	            .join(' · ')
	        )
	      : null;

    const slotControls = el('div', {class:'panel'}, [
      el('div', {class:'panel-title'}, 'Selected enemies'),
      el('div', {class:'muted small'}, `Pick up to ${defLimit} defenders for this wave (first two are the lead pair). Left click adds, right click removes. Click the same row twice to add it twice.`),
      ...Array.from({length:defLimit}).map((_,i)=> makeSlot(i, selected[i] || null)),
      selectionSummary,
      el('div', {style:'margin-top:8px; display:flex; justify-content:flex-end'}, [clearAll]),
    ].filter(Boolean));

	    // Right click the selection panel to clear all (quick "select nothing").
	    slotControls.addEventListener('contextmenu', (ev)=>{
	      ev.preventDefault();
	      ev.stopPropagation();
	      setSelectedArr(new Array(defLimit).fill(null));
	    });

	    for (const s of slots){
	      const positions = selectedSlotsByKey[s.rowKey] || [];
	      const isSelected = positions.length > 0;

      const base = pokeApi.baseOfSync(s.defender, state.baseCache||{});
      const isUnlocked = !!state.unlocked?.[base];
      const isClaimed = !!state.cleared?.[baseDefKey(s.rowKey)];

      // In the wave list, show defenders a bit larger (static PNG) for readability.
      const sp = el('img', {class:'sprite sprite-md', src:spriteStatic(calc, s.defender), alt:s.defender});
      sp.onerror = ()=> sp.style.opacity='0.25';

      const statusPill = isClaimed
        ? pill('CLAIMED','good')
        : (isUnlocked ? pill('UNLOCKED','warn') : pill('LOCKED','bad'));

	      const selPills = positions.length ? positions.slice(0,4).map(n=>pill(`#${n}`,'info')) : [];

	      const titleLine = el('div', {style:'display:flex; justify-content:space-between; align-items:center; gap:8px'}, [
	        el('div', {class:'pick-title'}, `${s.defender}`),
	        el('div', {style:'display:flex; gap:6px; align-items:center'}, [
	          ...selPills,
	          statusPill,
	        ].filter(Boolean)),
	      ]);

      const row = el('div', {class:'pick-item' + (isUnlocked ? ' unlocked':'' ) + (isClaimed ? ' cleared':'' ) + (isSelected ? ' selected':'' )}, [
        sp,
        el('div', {class:'pick-meta'}, [
          titleLine,
          el('div', {class:'pick-sub'}, `Lv ${s.level}` + ((s.tags||[]).length ? ` · ${s.tags.join(',')}` : '')),
          buildDefModRow(s),
        ]),
      ]);

	      // Left click = add/select (duplicates allowed). Right click = remove/unselect.
	      row.addEventListener('click', (ev)=>{
        if (ev?.target?.closest && ev.target.closest('.modrow')) return;
        const cur = (store.getState().wavePlans?.[waveKey]?.defenders || []).slice(0, defLimit);
        const arr = Array.from({length:defLimit}).map((_,i)=> cur[i] || null);
        const base = s.rowKey;
        const empty = arr.indexOf(null);
	      if (empty !== -1){
	        arr[empty] = base;
	        return setSelectedArr(arr);
	      }
	      // Full: FIFO overwrite
	      for (let i=0;i<defLimit-1;i++) arr[i] = arr[i+1];
	      arr[defLimit-1] = base;
	      return setSelectedArr(arr);
      });

      row.addEventListener('contextmenu', (ev)=>{
        ev.preventDefault();
        if (ev?.target?.closest && ev.target.closest('.modrow')) return;
        const cur = (store.getState().wavePlans?.[waveKey]?.defenders || []).slice(0, defLimit);
        const arr = Array.from({length:defLimit}).map((_,i)=> cur[i] || null);
        const base = s.rowKey;
        // remove the most recent occurrence
        for (let i=arr.length-1;i>=0;i--){
          if (arr[i] === base){
            arr[i] = null;
            break;
          }
        }
        return setSelectedArr(arr);
      });

      sp.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        showOverviewForSlot(s);
      });

      enemyList.appendChild(row);
    }

    const activeRoster = state.roster.filter(r=>r.active).slice(0,16);

    // Fight plan + suggestions (same as current v13 feature set)
    const planEl = el('div', {class:'panel'}, [
      el('div', {class:'panel-title'}, 'Fight plan'),
      el('div', {class:'muted small'}, 'Uses your ACTIVE roster from the Roster tab. Auto-match is always enabled. Use suggested lead pairs to quickly set starters.'),
    ]);

    // Starter pickers (optional manual override)
    const starterIds = (wp.attackerStart||[]).slice(0,2);
    const starterA = starterIds[0] || (activeRoster[0]?.id ?? null);
    const starterB = starterIds[1] || (activeRoster[1]?.id ?? null);

    const makeStarterSel = (value, otherValue, onPick)=>{
      const sel = el('select', {class:'sel-mini'}, [
        ...activeRoster.map(r=>el('option', {value:r.id, selected:r.id===value, disabled:r.id===otherValue}, rosterLabel(r))),
      ]);
      sel.addEventListener('change', ()=> onPick(sel.value));
      return sel;
    };

    let selA = null;
    let selB = null;
    const row = el('div', {style:'display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:8px'}, [
      el('span', {class:'muted small'}, 'Starters:'),
    ]);

    selA = makeStarterSel(starterA, starterB, (id)=>{
      store.update(s=>{
        const w = s.wavePlans[waveKey];
        w.attackerStart = [id, (w.attackerStart||[])[1] || starterB].slice(0,2);
        // ensure distinct
        if (w.attackerStart[0] === w.attackerStart[1]){
          const alt = activeRoster.find(r=>r.id!==w.attackerStart[0]);
          if (alt) w.attackerStart[1] = alt.id;
        }
        w.attackerOrder = w.attackerStart.slice(0,2);
        w.manualStarters = true;
        w.manualOrder = false;
        ensureWavePlan(data, s, waveKey, slots);
      });
    });
    selB = makeStarterSel(starterB, starterA, (id)=>{
      store.update(s=>{
        const w = s.wavePlans[waveKey];
        w.attackerStart = [(w.attackerStart||[])[0] || starterA, id].slice(0,2);
        if (w.attackerStart[0] === w.attackerStart[1]){
          const alt = activeRoster.find(r=>r.id!==w.attackerStart[0]);
          if (alt) w.attackerStart[0] = alt.id;
        }
        w.attackerOrder = w.attackerStart.slice(0,2);
        w.manualStarters = true;
        w.manualOrder = false;
        ensureWavePlan(data, s, waveKey, slots);
      });
    });

    const autoBtn = el('button', {class:'btn-mini'}, 'Auto');
    autoBtn.addEventListener('click', ()=>{
      store.update(s=>{
        const w = s.wavePlans[waveKey];
        w.manualStarters = false;
        w.manualOrder = false;
        ensureWavePlan(data, s, waveKey, slots);
      });
    });

    row.appendChild(selA);
    row.appendChild(el('span', {class:'muted small'}, '+'));
    row.appendChild(selB);
    row.appendChild(autoBtn);
    planEl.appendChild(row);

    // Move override pickers (optional)
    const makeMoveOverrideSel = (attId)=>{
      const mon = byId(state.roster||[], attId);
      if (!mon) return el('span', {class:'muted small'}, '—');
      const cur = (wp.attackMoveOverride||{})[attId] || '';
      const opts = [el('option', {value:'', selected: !cur}, 'Auto')];
      for (const mv of (mon.movePool||[])){
        if (!mv || mv.use === false || !mv.name) continue;
        opts.push(el('option', {value: mv.name, selected: cur === mv.name}, mv.name));
      }
      const sel = el('select', {class:'sel-mini'}, opts);
      sel.addEventListener('change', ()=>{
        const v = String(sel.value||'');
        store.update(s=>{
          const w = s.wavePlans[waveKey];
          w.attackMoveOverride = w.attackMoveOverride || {};
          if (!v) delete w.attackMoveOverride[attId];
          else w.attackMoveOverride[attId] = v;
          ensureWavePlan(data, s, waveKey, slots);
        });
      });
      return sel;
    };

    const clearMoveOverridesBtn = el('button', {class:'btn-mini'}, 'Clear');
    clearMoveOverridesBtn.addEventListener('click', ()=>{
      store.update(s=>{
        const w = s.wavePlans[waveKey];
        if (!w.attackMoveOverride) return;
        delete w.attackMoveOverride[starterA];
        delete w.attackMoveOverride[starterB];
        ensureWavePlan(data, s, waveKey, slots);
      });
    });

    const moveRow = el('div', {style:'display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:6px'}, [
      el('span', {class:'muted small'}, 'Moves:'),
      makeMoveOverrideSel(starterA),
      el('span', {class:'muted small'}, '+'),
      makeMoveOverrideSel(starterB),
      clearMoveOverridesBtn,
    ]);
    planEl.appendChild(moveRow);

    const slotByKey2 = new Map(slots.map(s=>[s.rowKey,s]));
    const selectedPlanKeys = (wp.defenders||[]).slice(0, defLimit);
    const picked = selectedPlanKeys
      .map(k=>({key:k, slot:slotByKey2.get(baseDefKey(k))}))
      .filter(x=>x.slot);
    const allDef = picked.map(x=>x.slot);

    const startersOrdered = (wp.attackerOrder||wp.attackerStart||[]).slice(0,2).map(id=>byId(state.roster,id)).filter(Boolean);
    const a0 = startersOrdered[0] || null;
    const a1 = startersOrdered[1] || null;

    const bestMoveForMon = (att, defSlot)=>{
      if (!att || !defSlot) return null;
      const atk = {species:(att.effectiveSpecies||att.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: att.strength?state.settings.strengthEV:state.settings.claimedEV};
      const def = {species:defSlot.defender, level:defSlot.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};

      const forced = (wp && wp.attackMoveOverride) ? (wp.attackMoveOverride[att.id] || null) : null;
      let pool = att.movePool||[];
      if (forced){
        const filtered = pool.filter(m => m && m.use !== false && m.name === forced);
        if (filtered.length) pool = filtered;
      }

      return calc.chooseBestMove({
        data,
        attacker: atk,
        defender: def,
        movePool: pool,
        settings: settingsForWave(state, wp, att.id, defSlot.rowKey),
        tags: defSlot.tags||[],
      }).best;
    };

    const attackerActsFirst = (best)=>{
      if (!best) return false;
      const aSpe = Number(best.attackerSpe ?? 0);
      const dSpe = Number(best.defenderSpe ?? 0);
      if (aSpe > dSpe) return true;
      if (aSpe < dSpe) return false;
      // tie
      return !(state.settings?.enemySpeedTieActsFirst ?? true);
    };

    const chooseLeadAssignment = (mA0,mA1,mB0,mB1)=>{
      const tuple = (m0,m1)=>{
        const ohko = (m0?.oneShot ? 1 : 0) + (m1?.oneShot ? 1 : 0);
        const worstPrio = Math.max(m0?.prio ?? 9, m1?.prio ?? 9);
        const avgPrio = ((m0?.prio ?? 9) + (m1?.prio ?? 9)) / 2;
        const overkill = Math.abs((m0?.minPct ?? 0) - 100) + Math.abs((m1?.minPct ?? 0) - 100);
        return {ohko, worstPrio, avgPrio, overkill};
      };
      const better = (x,y)=>{
        if (x.ohko !== y.ohko) return x.ohko > y.ohko;
        if (x.worstPrio !== y.worstPrio) return x.worstPrio < y.worstPrio;
        if (x.avgPrio !== y.avgPrio) return x.avgPrio < y.avgPrio;
        return x.overkill <= y.overkill;
      };
      const t1 = tuple(mA0,mB1);
      const t2 = tuple(mA1,mB0);
      return better(t1,t2) ? {swap:false, tuple:t1} : {swap:true, tuple:t2};
    };

    let startersClear = 0;
    for (const ds of allDef){
      const m0 = bestMoveForMon(a0, ds);
      const m1 = bestMoveForMon(a1, ds);
      if ((m0 && m0.oneShot) || (m1 && m1.oneShot)) startersClear += 1;
    }

    const planTable = el('div', {class:'plan'});

    const lead0 = picked[0]?.slot || null;
    const lead1 = picked[1]?.slot || null;

    if (a0 && a1 && lead0 && lead1){
      const mA0 = bestMoveForMon(a0, lead0);
      const mA1 = bestMoveForMon(a0, lead1);
      const mB0 = bestMoveForMon(a1, lead0);
      const mB1 = bestMoveForMon(a1, lead1);
      const chosen = chooseLeadAssignment(mA0,mA1,mB0,mB1);
      const left = chosen.swap ? {att:a0, def:lead1, best:mA1} : {att:a0, def:lead0, best:mA0};
      const right = chosen.swap ? {att:a1, def:lead0, best:mB0} : {att:a1, def:lead1, best:mB1};
      const prAvg = ((left.best?.prio ?? 9) + (right.best?.prio ?? 9)) / 2;

      // Deterministic 1-turn min-roll sim for the chosen lead assignment.
      // Purpose: make Fight plan headline lines match the battle engine in STU-break → AoE sweep cases.
      // Example: partner chips STU first (prio) and then EQ should show full damage on the STU target.
      const planSim = (()=>{
        try{
          if (!(left?.best?.move && right?.best?.move)) return null;

          const defByKey = new Map([[lead0.rowKey, lead0],[lead1.rowKey, lead1]]);
          const hpDef = {[lead0.rowKey]: 1, [lead1.rowKey]: 1};
          const hpAtk = {[a0.id]: 1, [a1.id]: 1};

          const atkObj = (rm, s)=>({
            species:(rm.effectiveSpecies||rm.baseSpecies),
            level: s.claimedLevel,
            ivAll: s.claimedIV,
            evAll: rm.strength ? s.strengthEV : s.claimedEV,
          });
          const defObj = (slot)=>({
            species:(slot.baseSpecies || slot.defender),
            level: slot.level,
            ivAll: (slot.ivAll ?? state.settings.wildIV ?? 0),
            evAll: (slot.evAll ?? state.settings.wildEV ?? 0),
          });

          const rrVsDef = (attMon, moveName, defSlot, curFrac)=>{
            const s0 = settingsForWave(state, wp, attMon.id, defSlot.rowKey);
            const s = {...s0, defenderCurHpFrac: (curFrac ?? 1)};
            const rr = calc.computeDamageRange({data, attacker: atkObj(attMon, s), defender: defObj(defSlot), moveName, settings: s, tags: defSlot.tags || []});
            return (rr && rr.ok) ? rr : null;
          };

          const rrVsAlly = (attMon, moveName, allyMon, curFrac)=>{
            const s0 = settingsForWave(state, wp, attMon.id, null);
            const s = {...s0, defenderItem: allyMon.item || null, defenderHpFrac: 1, defenderCurHpFrac: (curFrac ?? 1), applyINT: false, applySTU: false};
            const rr = calc.computeDamageRange({data, attacker: atkObj(attMon, s), defender: atkObj(allyMon, s), moveName, settings: s, tags: []});
            return (rr && rr.ok) ? rr : null;
          };

          const actions = [
            {att: left.att, move: left.best.move, prio: (left.best.prio ?? 9), spe: Number(left.best.attackerSpe ?? 0), targetKey: left.def.rowKey},
            {att: right.att, move: right.best.move, prio: (right.best.prio ?? 9), spe: Number(right.best.attackerSpe ?? 0), targetKey: right.def.rowKey},
          ];
          actions.sort((x,y)=>{
            if ((x.prio??9) !== (y.prio??9)) return (x.prio??9) - (y.prio??9);
            if ((y.spe??0) !== (x.spe??0)) return (y.spe??0) - (x.spe??0);
            return String(x.att.id||'').localeCompare(String(y.att.id||''));
          });

          const out = {};
          for (const act of actions){
            const aoe = isAoeMove(act.move);
            const hitsAlly = aoe && aoeHitsAlly(act.move);
            const ally = (act.att.id === a0.id) ? a1 : a0;

            const targets = [];
            if (aoe){
              for (const ds of [lead0, lead1]){
                if (!ds) continue;
                if ((hpDef[ds.rowKey] ?? 0) > 0) targets.push({kind:'def', slot: ds});
              }
              if (hitsAlly && ally && (hpAtk[ally.id] ?? 0) > 0) targets.push({kind:'ally', mon: ally});
            } else {
              const ds = defByKey.get(act.targetKey);
              if (ds && (hpDef[ds.rowKey] ?? 0) > 0) targets.push({kind:'def', slot: ds});
            }
            if (!targets.length) continue;

            const per = [];
            for (const t of targets){
              if (t.kind === 'def'){
                const cur = hpDef[t.slot.rowKey] ?? 1;
                const rr = rrVsDef(act.att, act.move, t.slot, cur);
                if (rr) per.push({kind:'def', key: t.slot.rowKey, name: t.slot.defender, rr});
              } else {
                const cur = hpAtk[t.mon.id] ?? 1;
                const rr = rrVsAlly(act.att, act.move, t.mon, cur);
                if (rr){
                  const immune = immuneFromAllyAbilityItem(t.mon, rr.moveType);
                  per.push({kind:'ally', id: t.mon.id, name: rosterLabel(t.mon), immune, rr});
                }
              }
            }
            if (!per.length) continue;

            let damaged = 0;
            for (const o of per){
              if (o.kind === 'ally' && o.immune) continue;
              if (Number(o.rr?.minPct || 0) > 0) damaged += 1;
            }
            const mult = aoe ? spreadMult(damaged) : 1.0;

            const main = per.find(o=>o.kind==='def' && o.key===act.targetKey) || per.find(o=>o.kind==='def') || null;
            const side = aoe ? (per.find(o=>o.kind==='def' && o.key!==act.targetKey) || null) : null;
            const ff = per.find(o=>o.kind==='ally') || null;

            out[act.att.id] = {
              mult,
              main: main ? {key: main.key, defender: main.name, minPct: Number(main.rr.minPct||0), maxPct: Number(main.rr.maxPct ?? main.rr.minPct ?? 0)} : null,
              side: side ? {key: side.key, defender: side.name, minPct: Number(side.rr.minPct||0), maxPct: Number(side.rr.maxPct ?? side.rr.minPct ?? 0)} : null,
              ff: ff ? {allyName: ff.name, moveType: ff.rr.moveType, immune: !!ff.immune, minPct: ff.immune?0:Number(ff.rr.minPct||0), maxPct: ff.immune?0:Number(ff.rr.maxPct ?? ff.rr.minPct ?? 0)} : null,
            };

            // Apply deterministic min-roll damage to advance HP fractions.
            for (const o of per){
              const rawMin = Number(o.rr?.minPct || 0);
              const finalMin = (o.kind === 'ally' && o.immune) ? 0 : (rawMin * mult);
              if (finalMin <= 0) continue;
              if (o.kind === 'def') hpDef[o.key] = Math.max(0, (hpDef[o.key] ?? 1) - (finalMin / 100));
              else hpAtk[o.id] = Math.max(0, (hpAtk[o.id] ?? 1) - (finalMin / 100));
            }
          }

          return out;
        }catch(e){
          return null;
        }
      })();

      const line = (x)=>{
        const best = x.best || null;
        const sim = (planSim && x.att) ? (planSim[x.att.id] || null) : null;
        const slower = !!(best && !attackerActsFirst(best));

        const aoe = !!(best && isAoeMove(best.move));
        const hitsAlly = !!(best && aoeHitsAlly(best.move));
        const enemyCount = (aoe && lead0 && lead1) ? 2 : 1;
        const ally = (a0 && a1 && x.att) ? (x.att.id === a0.id ? a1 : a0) : null;

        // AOE side-hit preview (other defender) for the fight plan display.
        // Use deterministic 1-turn sim when available so STU-break ordering is reflected.
        let aoeSide = null;
        if (sim && sim.side){
          aoeSide = {
            defender: sim.side.defender,
            minPct: Number(sim.side.minPct||0),
            maxPct: Number(sim.side.maxPct ?? sim.side.minPct ?? 0),
          };
        } else if (best && aoe && lead0 && lead1){
          const otherDef = (x.def && lead0 && x.def.rowKey === lead0.rowKey) ? lead1 : lead0;
          if (otherDef && otherDef.rowKey !== x.def.rowKey){
            try{
              const atk = {species:(x.att.effectiveSpecies||x.att.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: x.att.strength?state.settings.strengthEV:state.settings.claimedEV};
              // NOTE: wave defender slots may omit ivAll/evAll; fall back to wild defaults to avoid NaN→0% previews.
              const defOther = {
                species: (otherDef.baseSpecies || otherDef.defender),
                level: otherDef.level,
                ivAll: (otherDef.ivAll ?? state.settings.wildIV ?? 0),
                evAll: (otherDef.evAll ?? state.settings.wildEV ?? 0),
              };
              const s0 = settingsForWave(state, wp, x.att.id, otherDef.rowKey);
              const s = {...s0, defenderCurHpFrac: 1};
              const rr = calc.computeDamageRange({data, attacker: atk, defender: defOther, moveName: best.move, settings: s, tags: otherDef.tags || []});
              if (rr && rr.ok && Number.isFinite(rr.minPct)){
                aoeSide = {
                  defender: otherDef.defender,
                  minPct: Number(rr.minPct||0),
                  maxPct: Number(rr.maxPct ?? rr.minPct ?? 0),
                };
              }
            }catch(e){ aoeSide = null; }
          }
        }

        // Friendly-fire preview (ally hit) + spread multiplier.
        let ff = null;
        if (sim && sim.ff){
          ff = {allyName: sim.ff.allyName, moveType: sim.ff.moveType, immune: !!sim.ff.immune, minPct: Number(sim.ff.minPct||0), maxPct: Number(sim.ff.maxPct ?? sim.ff.minPct ?? 0)};
        } else if (best && hitsAlly && ally){
          try{
            const atk = {species:(x.att.effectiveSpecies||x.att.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: x.att.strength?state.settings.strengthEV:state.settings.claimedEV};
            const defAlly = {species:(ally.effectiveSpecies||ally.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: ally.strength?state.settings.strengthEV:state.settings.claimedEV};
            const sFF0 = settingsForWave(state, wp, x.att.id, x.def.rowKey);
            const sFF = {...sFF0, defenderItem: ally.item || null, defenderHpFrac: 1, applyINT: false, applySTU: false};
            const rr = calc.computeDamageRange({data, attacker: atk, defender: defAlly, moveName: best.move, settings: sFF, tags: []});
            if (rr && rr.ok){
              const immune = immuneFromAllyAbilityItem(ally, rr.moveType);
              ff = {
                allyName: rosterLabel(ally),
                moveType: rr.moveType,
                immune,
                minPct: immune ? 0 : Number(rr.minPct||0),
                maxPct: immune ? 0 : Number(rr.maxPct||rr.minPct||0),
              };
            }
          }catch(e){ /* ignore */ }
        }

        // Spread penalty should be based on how many targets are actually damaged (immunity matters).
        // This mirrors the battle engine so Fight plan lines match Outcome preview.
        const targetsDamaged = aoe
          ? (
              ((Number((sim?.main?.minPct ?? best?.minPct) || 0) > 0) ? 1 : 0)
              + ((aoeSide && Number(aoeSide.minPct || 0) > 0) ? 1 : 0)
              + ((hitsAlly && ff && !ff.immune && Number(ff.minPct || 0) > 0) ? 1 : 0)
            )
          : 1;
        const mult = aoe ? (Number(sim?.mult) || spreadMult(targetsDamaged)) : 1.0;

        const baseMin = best ? Number((sim?.main?.minPct ?? best.minPct) || 0) : 0;
        const baseMax = best ? Number((sim?.main?.maxPct ?? best.maxPct ?? best.minPct) || 0) : 0;
        const adjMin = baseMin * mult;
        const adjMax = baseMax * mult;
        const oneShotAdj = best ? (adjMin >= 100) : false;

        // Apply spread mult to friendly fire preview too (same mult as the move use).
        if (ff && !ff.immune){
          ff = {...ff, minAdj: ff.minPct * mult, maxAdj: ff.maxPct * mult, couldKO: (ff.maxPct * mult) >= 100};
        } else if (ff) {
          ff = {...ff, minAdj: 0, maxAdj: 0, couldKO: false};
        }

        const sideTxt = (aoeSide && aoe) ? ` · also ${aoeSide.defender}: ${formatPct((aoeSide.minPct||0)*mult)} min` : '';
        const out = best
          ? `${rosterLabel(x.att)} → ${x.def.defender}: ${best.move} (P${best.prio} · ${formatPct(adjMin)} min${aoe ? ` · AOE×${mult===1? '1.00':'0.75'}` : ''}${sideTxt})`
          : `${rosterLabel(x.att)} → ${x.def.defender}: —`;

        const speNote = (best)=>{
          if (!best) return '';
          const aSpe = Number(best.attackerSpe ?? 0);
          const dSpe = Number(best.defenderSpe ?? 0);
          const tieFirst = (state.settings?.enemySpeedTieActsFirst ?? true);
          if (aSpe === dSpe) return tieFirst ? `Speed tie (${aSpe} vs ${dSpe}) · enemy acts first on tie` : `Speed tie (${aSpe} vs ${dSpe}) · you act first on tie`;
          return `Speed: you ${aSpe} vs enemy ${dSpe}`;
        };

        const pills = [];
        if (best){
          pills.push(oneShotAdj ? pill('OHKO','good') : pill('NO','bad'));
          if (aoe){
            const p = pill('AOE','warn');
            const allyTxt = hitsAlly ? ' + may hit partner' : '';
            p.title = `AOE move: hits ${enemyCount} defender(s)${allyTxt}. Spread penalty applies when >1 target: ×0.75.`;
            pills.push(p);
          }
          if (hitsAlly && ally){
            const kindBase = (ff && ff.couldKO && !(state.settings?.allowFriendlyFire)) ? 'bad' : 'warn';
            const p = pill('FF', `${kindBase} danger`);
            if (!ff){
              p.title = `Friendly fire: ${best.move} can hit your partner (${rosterLabel(ally)}).`;
            } else if (ff.immune){
              p.title = `Friendly fire: partner ${ff.allyName} is immune to ${ff.moveType} (ability/item).`;
            } else {
              const koTxt = ff.couldKO ? 'RISK: could KO partner. ' : '';
              const settingTxt = ff.couldKO && !(state.settings?.allowFriendlyFire) ? 'Auto will avoid this if possible (setting OFF).' : (ff.couldKO ? 'Allowed (setting ON).' : '');
              p.title = `Friendly fire: hits partner ${ff.allyName} for ${formatPct(ff.minAdj)}–${formatPct(ff.maxAdj)} (AOE×${mult===1? '1.00':'0.75'}). ${koTxt}${settingTxt}`.trim();
            }
            pills.push(p);
          }
          if (slower){
            const p = pill('SLOW','warn danger');
            p.title = `Enemy may act first. ${speNote(best)}`;
            pills.push(p);
          }
        }

        return el('div', {class:'plan-line'}, [
          el('div', {class:'plan-left'}, [el('strong', {}, x.def.defender), el('span', {class:'muted'}, ` · Lv ${x.def.level}`)]),
          el('div', {class:'plan-right'}, [
            el('span', {}, out),
            ...pills,
          ])
        ]);
      };

      planTable.appendChild(el('div', {class:'muted small', style:'margin:6px 0 10px'}, `Lead pair plan · prioØ ${formatPrioAvg(prAvg)}`));
      planTable.appendChild(line(left));
      planTable.appendChild(line(right));

    // Incoming preview: show the predicted enemy move even if it would not land in reality
    // (e.g. you act first and OHKO). This helps verify logic and catch misplays.
    const incomingRow = (defSlot, myAttack)=>{
      if (!defSlot) return null;
      const best = myAttack?.best || null;
      const prevented = !!(best && best.oneShot && attackerActsFirst(best));

        const t0 = enemyThreatForMatchup(data, state, wp, a0, defSlot) || assumedEnemyThreatForMatchup(data, state, wp, a0, defSlot);
        const t1 = enemyThreatForMatchup(data, state, wp, a1, defSlot) || assumedEnemyThreatForMatchup(data, state, wp, a1, defSlot);
        const pick = (x,y)=>{
          if (!x && !y) return null;
          if (x && !y) return {th:x, target: rosterLabel(a0)};
          if (!x && y) return {th:y, target: rosterLabel(a1)};
          const dx = Number(x.minPct||0);
          const dy = Number(y.minPct||0);
          if (dx !== dy){
            return dx > dy ? {th:x, target: rosterLabel(a0)} : {th:y, target: rosterLabel(a1)};
          }
          const cx = Number(x.ohkoChance||0);
          const cy = Number(y.ohkoChance||0);
          if (cx !== cy){
            return cx > cy ? {th:x, target: rosterLabel(a0)} : {th:y, target: rosterLabel(a1)};
          }
          return {th:x, target: rosterLabel(a0)};
        };
        const pickRes = pick(t0,t1);
        if (!pickRes) return null;
        const th = pickRes.th;
        // AoE moves (e.g. Electroweb) hit BOTH active attackers.
        const aoe = !!th.aoe;
        const other = aoe ? (pickRes.target === rosterLabel(a0) ? t1 : t0) : null;
        const minA = Number(th.minPct||0);
        const minB = aoe ? Number((other && other.move === th.move ? other.minPct : th.minPct) || 0) : 0;
        const displayMin = aoe ? Math.max(minA, minB) : minA;
        const target = aoe ? 'BOTH' : pickRes.target;

        const p = pill(th.oneShot ? 'IN OHKO' : `IN ${formatPct(displayMin)}`, th.oneShot ? 'bad' : 'warn');
        if (prevented) p.style.opacity = '0.55';
        const why = th.chosenReason === 'ohkoChance' ? 'chosen: OHKO chance' : (th.chosenReason === 'maxDamage' ? 'chosen: max damage' : '');
        p.title = `Incoming: ${th.move}${aoe ? ' (AOE → BOTH)' : ''} · ${th.moveType} · ${th.category} · ${formatPct(displayMin)} min`
          + (why ? ` · ${why}` : '')
          + (th.assumed ? ' (assumed)' : '')
          + (prevented ? ' · NOTE: this would be prevented by your faster OHKO' : '');
        return el('div', {class:'muted small', style:'margin-top:6px'}, [`${defSlot.defender} incoming → ${target}: `, p]);
      };

      const inc0 = incomingRow(left.def, left);
      const inc1 = incomingRow(right.def, right);
      if (inc0) planTable.appendChild(inc0);
      if (inc1) planTable.appendChild(inc1);

      const slowAny = (!!left.best && !attackerActsFirst(left.best)) || (!!right.best && !attackerActsFirst(right.best));
      if (slowAny){
        planTable.appendChild(el('div', {class:'muted small', style:'margin-top:6px'}, '⚠️ Speed warning: at least one matchup has the enemy acting first (SLOW).'));
      }

      // Bench coverage
      const bench = picked.slice(2).map(x=>x.slot);
      if (bench.length){
        const benchLines = [];
        for (const ds of bench){
          const am = bestMoveForMon(a0, ds);
          const bm = bestMoveForMon(a1, ds);
          const pick = (am && am.oneShot && (!bm || !bm.oneShot || (am.prio??9) <= (bm.prio??9))) ? {who:rosterLabel(a0), m:am} : {who:rosterLabel(a1), m:bm};
          benchLines.push(`${ds.defender}: ${pick.who} ${pick.m?.move||'—'} (P${pick.m?.prio||'?'} ${formatPct(pick.m?.minPct||0)})`);
        }
        planTable.appendChild(el('div', {class:'muted small', style:'margin-top:8px'}, `Bench: ${benchLines.join(' · ')}`));
      }
    } else {
      planTable.appendChild(el('div', {class:'muted small'}, 'Select 2 enemies and ensure 2 active starters are available to build a lead-pair plan.'));
    }

    planEl.appendChild(el('div', {class:'muted small'}, `Starters have OHKO coverage on ${startersClear}/${allDef.length} selected defenders.`));
    planEl.appendChild(planTable);

	    // Outcome preview (always uses the REAL battle engine logic):
	    // This makes Auto behavior explainable and ensures the Fight plan display matches
	    // what will happen when you click Fight.
	    const outcomePreviewEl = (()=>{
	      if (!a0 || !a1) return null;
	      const defs = (wp.defenders || []).slice(0, defLimit);
	      if (defs.length < 2) return null;
	      const aId = a0.id;
	      const bId = a1.id;
	      if (!aId || !bId || String(aId) === String(bId)) return null;

	      const ovr = wp.attackMoveOverride || {};
	      const okeys = Object.keys(ovr).slice().sort((x,y)=>String(x).localeCompare(String(y)));
	      const oBits = okeys.map(k => `${k}:${ovr[k]}`).join('|');

	      const ppSig = (id)=>{
	        const mon = byId(state.roster||[], id);
	        const moves = (mon?.movePool||[]).filter(m=>m && m.use !== false && m.name).map(m=>m.name).slice().sort((x,y)=>String(x).localeCompare(String(y)));
	        const bits = moves.map(mn => String(state.pp?.[id]?.[mn]?.cur ?? DEFAULT_MOVE_PP)).join('/');
	        return `${id}:${bits}`;
	      };

	      const sig = [
	        `wave:${waveKey}|phase:${phase}|defLimit:${defLimit}`,
	        `defs:${defs.join(',')}`,
	        `atk:${aId},${bId}`,
	        `ovr:${oBits}`,
	        `ff:${state.settings?.allowFriendlyFire?1:0}`,
	        `stu:${state.settings?.applySTU?1:0}`,
	        `stuaoe:${state.settings?.sturdyAoeSolve?1:0}`,
	        `pp:${ppSig(aId)}|${ppSig(bId)}`,
	      ].join('~');

	      // Tiny LRU-ish cap.
	      if (FIGHT_OUTCOME_PREVIEW_CACHE.size > 250) FIGHT_OUTCOME_PREVIEW_CACHE.clear();
	      const cached = FIGHT_OUTCOME_PREVIEW_CACHE.get(sig);
	      const preview = cached || (()=>{
	        const ra = byId(state.roster||[], aId);
	        const rb = byId(state.roster||[], bId);
	        if (!ra || !rb) return null;

	        // Minimal isolated state for preview (no PP / log mutation on real state).
	        const sPrev = {
	          settings: state.settings,
	          roster: [JSON.parse(JSON.stringify(ra)), JSON.parse(JSON.stringify(rb))],
	          pp: JSON.parse(JSON.stringify(state.pp || {})),
	          wavePlans: {},
	          battles: {},
	        };

	        // Ensure PP exists for the two attackers and snapshot.
	        const aMon = byId(sPrev.roster, aId);
	        const bMon = byId(sPrev.roster, bId);
	        ensurePPForRosterMon(sPrev, aMon);
	        ensurePPForRosterMon(sPrev, bMon);
	        const ppBefore = {
	          [aId]: JSON.parse(JSON.stringify(sPrev.pp?.[aId] || {})),
	          [bId]: JSON.parse(JSON.stringify(sPrev.pp?.[bId] || {})),
	        };

	        const tmpKey = `${waveKey}__preview_${Date.now()}_${Math.random().toString(16).slice(2)}`;
	        sPrev.wavePlans[tmpKey] = {
	          ...(wp||{}),
	          defenders: defs.slice(),
	          defenderStart: defs.slice(0,2),
	          attackerOrder: [aId,bId],
	          attackerStart: [aId,bId],
	        };

	        const b = initBattleForWave({data, calc, state:sPrev, waveKey: tmpKey, slots});
	        if (!b){
	          delete sPrev.wavePlans[tmpKey];
	          return null;
	        }

	        let guard = 0;
	        while (guard++ < 60 && sPrev.battles?.[tmpKey]?.status === 'active'){
	          const bb = sPrev.battles[tmpKey];
	          if (bb.pending){
	            if (bb.pending.side === 'def'){
	              const choice = bb.def.bench[0];
	              if (choice) chooseReinforcement(sPrev, tmpKey, 'def', bb.pending.slotIndex, choice);
	              else bb.pending = null;
	            } else {
	              const choice = bb.atk.bench[0];
	              if (choice) chooseReinforcement(sPrev, tmpKey, 'atk', bb.pending.slotIndex, choice);
	              else bb.pending = null;
	            }
	            continue;
	          }
	          stepBattleTurn({data, calc, state:sPrev, waveKey: tmpKey, slots});
	        }

	        const bb = sPrev.battles?.[tmpKey];
	        const status = bb?.status || 'active';
	        const turnCount = Number(bb?.turnCount || 0);
	        const logLines = (bb?.log || []).slice(1); // skip "Fight started"
	        const atkHist = (bb?.history || []).filter(x=>x.side==='atk');
	        const prioAvg = atkHist.length ? (atkHist.reduce((sum,x)=>sum + (Number(x.prio)||9), 0) / atkHist.length) : 9;
	        const prioWorst = atkHist.length ? (atkHist.reduce((mx,x)=>Math.max(mx, (Number(x.prio)||9)), 0)) : 9;

	        const ppDelta = [];
	        for (const monId of [aId,bId]){
	          const before = ppBefore[monId] || {};
	          const after = sPrev.pp?.[monId] || {};
	          for (const [mv, obj] of Object.entries(after)){
	            const prevCur = Number(before?.[mv]?.cur ?? obj.cur ?? DEFAULT_MOVE_PP);
	            const nextCur = Number(obj.cur ?? DEFAULT_MOVE_PP);
	            if (prevCur !== nextCur) ppDelta.push({monId, move: mv, prevCur, nextCur});
	          }
	        }

	        delete sPrev.battles[tmpKey];
	        delete sPrev.wavePlans[tmpKey];

	        return {status, turnCount, prioAvg, prioWorst, logLines, ppDelta, attackers:[aId,bId]};
	      })();

	      if (!cached && preview) FIGHT_OUTCOME_PREVIEW_CACHE.set(sig, preview);
	      if (!preview) return null;

	      const statusKind = (preview.status === 'won') ? 'good' : (preview.status === 'lost' ? 'bad' : 'warn');
	      const statusTxt = (preview.status === 'won') ? 'WON' : (preview.status === 'lost' ? 'LOST' : String(preview.status).toUpperCase());
	      const turnsTxt = preview.turnCount ? `${preview.turnCount} turn${preview.turnCount===1?'':'s'}` : '—';

	      const used = (preview.ppDelta||[])
	        .map(d=>({
	          ...d,
	          used: Number(d.prevCur||0) - Number(d.nextCur||0),
	          name: rosterLabel(byId(state.roster||[], d.monId) || {baseSpecies:String(d.monId)}),
	        }))
	        .filter(d => d.used > 0)
	        .sort((a,b)=>String(a.name).localeCompare(String(b.name)) || String(a.move).localeCompare(String(b.move)));
	      const ppTxt = used.length ? used.map(d=>`${d.name} ${d.move} -${d.used}`).join(' · ') : '—';

	      const summaryRow = el('div', {style:'display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.06)'}, [
	        el('div', {}, [pill(statusTxt, statusKind)]),
	        el('div', {class:'muted small'}, `Outcome preview: ${turnsTxt} · prioØ ${formatPrioAvg(preview.prioAvg)} · worst P${formatPrioAvg(preview.prioWorst)} · PP: ${ppTxt}`),
	      ]);

	      const logBox = el('div', {class:'preview-log'}, (preview.logLines||[]).map(l=>el('div', {}, l)));
	      const details = el('details', {style:'margin-top:8px'}, [
	        el('summary', {class:'muted small'}, 'Show simulated battle log'),
	        logBox,
	      ]);

	      return el('div', {class:'plan-outcome'}, [summaryRow, details]);
	    })();
	    if (outcomePreviewEl) planEl.appendChild(outcomePreviewEl);

	    // ---------------- Fight controls + fight log (compact) ----------------
	    // This replaces the older "Wave fights" tracker. It models the 4 in-game fights for this wave.
	    // Entries are undoable individually (claims + PP deltas).
	    const baseCache = state.baseCache || {};
	    const baseByRowKey = (()=>{
	      const m = new Map();
	      for (const x of (data.calcSlots||[])){
	        const rk = String(x.rowKey || x.key || '');
	        if (!rk) continue;
	        const sp = fixName(x.defender || x.species || x.name || '');
	        if (!sp) continue;
	        m.set(rk, pokeApi.baseOfSync(sp, baseCache));
	      }
	      return m;
	    })();
	    const baseStillClearedAnywhere = (s, base)=>{
	      for (const rk of Object.keys(s.cleared||{})){
	        if (!s.cleared[rk]) continue;
	        const b = baseByRowKey.get(baseDefKey(rk)) || baseByRowKey.get(String(rk));
	        if (b === base) return true;
	      }
	      return false;
	    };

	    const getFightLog = ()=> (store.getState().wavePlans?.[waveKey]?.fightLog || []);

	    const ensurePP = (s, monId)=>{
	      const rm = byId(s.roster||[], monId);
	      if (!rm) return;
	      ensurePPForRosterMon(s, rm);
	    };

	    const applyPPCost = (s, monId, moveName)=>{
	      if (!monId || !moveName) return null;
	      ensurePP(s, monId);
	      s.pp = s.pp || {};
	      s.pp[monId] = s.pp[monId] || {};
	      const entry = s.pp[monId][moveName];
	      if (!entry) return null;
	      const prevCur = Number(entry.cur ?? entry.max ?? DEFAULT_MOVE_PP);
	      entry.cur = Math.max(0, prevCur - 1);
	      return {monId, move: moveName, prevCur};
	    };

	    const pickEnemyThreat = (s, wpLocal, defSlot, att0, att1)=>{
	      const t0 = enemyThreatForMatchup(data, s, wpLocal, att0, defSlot) || assumedEnemyThreatForMatchup(data, s, wpLocal, att0, defSlot);
	      const t1 = enemyThreatForMatchup(data, s, wpLocal, att1, defSlot) || assumedEnemyThreatForMatchup(data, s, wpLocal, att1, defSlot);
	      if (!t0 && !t1) return null;
	      if (t0 && !t1) return {th:t0, target:'A'};
	      if (!t0 && t1) return {th:t1, target:'B'};
	      // Prefer higher OHKO chance, else higher damage.
	      const c0 = Number(t0.ohkoChance||0);
	      const c1 = Number(t1.ohkoChance||0);
	      if (c0 !== c1) return c0 > c1 ? {th:t0, target:'A'} : {th:t1, target:'B'};
	      const d0 = Number(t0.minPct||0);
	      const d1 = Number(t1.minPct||0);
	      if (d0 !== d1) return d0 > d1 ? {th:t0, target:'A'} : {th:t1, target:'B'};
	      return {th:t0, target:'A'};
	    };

	    const makeFightEntry = (s, wpLocal, aId, bId, defKeys)=>{
	      const aMon = byId(s.roster||[], aId);
	      const bMon = byId(s.roster||[], bId);
	      const defs = (defKeys||[]).filter(Boolean);
	      if (!aMon || !bMon) return null;
	      if (String(aId) === String(bId)) return null;
	      if (defs.length < 2) return null;

	      // Seed PP for the two attackers and snapshot before.
	      ensurePPForRosterMon(s, aMon);
	      ensurePPForRosterMon(s, bMon);
	      const ppBefore = {
	        [aId]: JSON.parse(JSON.stringify(s.pp?.[aId] || {})),
	        [bId]: JSON.parse(JSON.stringify(s.pp?.[bId] || {})),
	      };

	      const tmpKey = `${waveKey}__log_${Date.now()}_${Math.random().toString(16).slice(2)}`;
	      s.wavePlans = s.wavePlans || {};
	      s.battles = s.battles || {};
	      // Temporary wave plan used only for deterministic simulation.
	      s.wavePlans[tmpKey] = {
	        ...(wpLocal||{}),
	        defenders: defs.slice(),
	        defenderStart: defs.slice(0,2),
	        attackerOrder: [aId,bId],
	        attackerStart: [aId,bId],
	      };

	      const b = initBattleForWave({data, calc, state:s, waveKey: tmpKey, slots});
	      if (!b){
	        delete s.wavePlans[tmpKey];
	        return null;
	      }

	      // Auto-run until won/lost, auto-picking reinforcements in the given order.
	      let guard = 0;
	      while (guard++ < 60 && s.battles?.[tmpKey]?.status === 'active'){
	        const bb = s.battles[tmpKey];
	        if (bb.pending){
	          if (bb.pending.side === 'def'){
	            const choice = bb.def.bench[0];
	            if (choice) chooseReinforcement(s, tmpKey, 'def', bb.pending.slotIndex, choice);
	            else bb.pending = null;
	          } else {
	            const choice = bb.atk.bench[0];
	            if (choice) chooseReinforcement(s, tmpKey, 'atk', bb.pending.slotIndex, choice);
	            else bb.pending = null;
	          }
	          continue;
	        }
	        stepBattleTurn({data, calc, state:s, waveKey: tmpKey, slots});
	      }

	      const bb = s.battles?.[tmpKey];
	      const status = bb?.status || 'active';
	      const logLines = (bb?.log || []).slice(1); // skip "Fight started"
	      const atkHist = (bb?.history || []).filter(x=>x.side==='atk');
		      const prioAvg = atkHist.length ? (atkHist.reduce((sum,x)=>sum + (Number(x.prio)||9), 0) / atkHist.length) : 9;
		      const prioWorst = atkHist.length ? (atkHist.reduce((mx,x)=>Math.max(mx, (Number(x.prio)||9)), 0)) : 9;
		      const turnCount = Number(bb?.turnCount || 0);

	      // Compute ppDelta based on snapshot.
	      const ppDelta = [];
	      for (const monId of [aId,bId]){
	        const before = ppBefore[monId] || {};
	        const after = s.pp?.[monId] || {};
	        for (const [mv, obj] of Object.entries(after)){
	          const prevCur = Number(before?.[mv]?.cur ?? obj.cur ?? DEFAULT_MOVE_PP);
	          const nextCur = Number(obj.cur ?? DEFAULT_MOVE_PP);
	          if (prevCur !== nextCur){
	            ppDelta.push({monId, move: mv, prevCur, nextCur});
	          }
	        }
	      }

	      // Claims (applied when entry is pushed): all selected defenders by base rowKey.
	      const claimRowKeys = Array.from(new Set(defs.map(k=>baseDefKey(k))));
	      const claimBases = claimRowKeys.map(rk=>{
	        const sl = slotByKey2.get(rk);
	        return sl ? pokeApi.baseOfSync(sl.defender, baseCache) : rk;
	      });

	      // Cleanup temp battle
	      delete s.battles[tmpKey];
	      delete s.wavePlans[tmpKey];

	      const lines = [
	        `ATTACKERS: ${rosterLabel(aMon)} + ${rosterLabel(bMon)} · DEFENDERS: ${defs.map((rk,i)=>`#${i+1} ${(slotByKey2.get(rk)?.defender || rk)}`).join(' · ')}`,
	        ...logLines,
	        status === 'won' ? 'Result: WON' : (status === 'lost' ? 'Result: LOST' : `Result: ${status}`),
	      ];

	      return {
	        id: `f${Date.now()}_${Math.random().toString(16).slice(2)}`,
	        ts: Date.now(),
	        attackers: [aId,bId],
	        defenders: defs.slice(),
	        prioAvg,
		        prioWorst,
		        turnCount,
		        status,
	        lines,
	        claimRowKeys,
	        claimBases,
	        ppDelta,
	      };
	    };

	    const undoEntryById = (entryId)=>{
	      store.update(s=>{
	        const w = s.wavePlans?.[waveKey];
	        if (!w || !Array.isArray(w.fightLog)) return;
	        const idx = w.fightLog.findIndex(e=>e.id===entryId);
	        if (idx < 0) return;
	        const entry = w.fightLog[idx];
	        w.fightLog.splice(idx,1);
	
	        // Restore PP.
	        for (const d of (entry.ppDelta||[])){
	          if (!s.pp?.[d.monId]?.[d.move]) continue;
	          s.pp[d.monId][d.move].cur = d.prevCur;
	        }
	
	        // Revert claims for this entry if no other remaining log entry still claims them.
	        const stillClaimed = new Set();
	        for (const e of (w.fightLog||[])) for (const rk of (e.claimRowKeys||[])) stillClaimed.add(rk);
	
	        const affectedBases = new Set(entry.claimBases||[]);
	        for (const rk of (entry.claimRowKeys||[])){
	          if (stillClaimed.has(rk)) continue;
	          if (s.cleared) delete s.cleared[rk];
	        }
	        for (const b of affectedBases){
	          if (!baseStillClearedAnywhere(s, b)){
	            if (s.unlocked) delete s.unlocked[b];
	          }
	        }
	      });
	    };

	    const clearAllLog = ()=>{
	      const ids = (getFightLog()||[]).map(e=>e.id).slice().reverse();
	      // Undo all entries newest-first.
	      for (const id of ids) undoEntryById(id);
	    };

	    const fightBtn = el('button', {class:'btn-mini'}, 'Fight');
	    const undoBtn = el('button', {class:'btn-mini'}, 'Undo');
	    const auto4Btn = el('button', {class:'btn-mini'}, 'Auto x4');
	    const countLabel = el('div', {class:'muted small', style:'margin-right:auto'}, `Fights: ${(wp.fightLog||[]).length}/4`);
	
	    const pushEntry = (s, w, entry)=>{
	      if (!entry) return;
	      w.fightLog = Array.isArray(w.fightLog) ? w.fightLog : [];
	      if (w.fightLog.length >= 4) return; // enforce 4 fights
	      // PP is already spent by the battle sim that produced this entry.

	      // Apply claims.
	      s.unlocked = s.unlocked || {};
	      s.cleared = s.cleared || {};
	      for (const b of (entry.claimBases||[])) s.unlocked[b] = true;
	      for (const rk of (entry.claimRowKeys||[])) s.cleared[rk] = true;

	      // Add to bottom (oldest first).
	      w.fightLog.push(entry);

        // If this wave just completed, check phase completion rewards.
        if (w.fightLog.length >= 4){
          maybeAwardPhaseReward(s, phase);
        }
	    };

	    fightBtn.addEventListener('click', ()=>{
	      const cur = store.getState();
	      const w = cur.wavePlans?.[waveKey];
	      const logLen = (w?.fightLog||[]).length;
	      if (logLen >= 4){
	        alert('Already have 4 fights logged. Undo one to re-sim.');
	        return;
	      }
	      const defs = (w?.defenders||[]).slice(0, defLimit);
	      if (defs.length < 2){
	        alert('Select at least 2 enemies first.');
	        return;
	      }
	      const atks = (w?.attackerStart||w?.attackerOrder||[]).slice(0,2);
	      if (atks.length < 2){
	        alert('Need 2 starters.');
	        return;
	      }
	      store.update(s=>{
	        const ww = s.wavePlans?.[waveKey];
	        if (!ww) return;
	        ensureWavePlan(data, s, waveKey, slots);
	        const entry = makeFightEntry(s, ww, atks[0], atks[1], defs);
	        pushEntry(s, ww, entry);
	      });
	    });

	    undoBtn.addEventListener('click', ()=>{
	      const w = store.getState().wavePlans?.[waveKey];
	      const list = (w?.fightLog||[]);
	      const last = list.length ? list[list.length-1] : null;
	      if (last) undoEntryById(last.id);
	    });

	    // Auto x4 uses the evolved solver logic (ported from previous full solve) and then simulates 4 fights.
	    auto4Btn.addEventListener('click', ()=>{
	      const st = store.getState();
	      const act = (st.roster||[]).filter(r=>r.active);
	      if (act.length < 2){
	        alert('Need at least 2 active roster mons.');
	        return;
	      }

	      const curW = st.wavePlans?.[waveKey] || {};

	      // Compute PP signature as if this wave's current fight log was undone (so repeated clicks can cycle alts).
	      const ppAfterClear = (()=>{
	        // IMPORTANT: undo deltas newest-first, otherwise repeated usage of the same move
	        // across multiple fights will not rewind back to the true baseline.
	        const pp = JSON.parse(JSON.stringify(st.pp || {}));
	        const log = (curW.fightLog || []).slice().reverse();
	        for (const e of log){
	          for (const d of (e.ppDelta || [])){
	            if (!pp?.[d.monId]?.[d.move]) continue;
	            pp[d.monId][d.move].cur = d.prevCur;
	          }
	        }
	        return pp;
	      })();

	      const signature = (()=>{
	        const parts = [];
	        parts.push(`wave:${waveKey}|phase:${phase}|defLimit:${defLimit}`);
		        parts.push(`altslack:${Number(st.settings?.autoAltAvgSlack ?? 0)}`);
	        parts.push(`altlim:${Number(st.settings?.variationLimit ?? 8)}`);
	        parts.push(`altcap:${Number(st.settings?.variationGenCap ?? 5000)}`);
        const ovr = curW.attackMoveOverride || {};
        const okeys = Object.keys(ovr).slice().sort((a,b)=>String(a).localeCompare(String(b)));
        const oBits = okeys.map(k => `${k}:${ovr[k]}`).join('|');
        parts.push(`ovr:${oBits}`);
        parts.push(`ff:${st.settings?.allowFriendlyFire?1:0}`);
	        const ids = act.map(r=>r.id).slice().sort((a,b)=>String(a).localeCompare(String(b)));
	        for (const id of ids){
	          const r = byId(st.roster||[], id);
	          if (!r) continue;
	          const sp = (r.effectiveSpecies||r.baseSpecies||'');
	          const item = r.item || '';
	          const evo = r.evo ? 1 : 0;
	          const str = r.strength ? 1 : 0;
	          const moves = (r.movePool||[])
	            .filter(m=>m && m.use !== false && m.name)
	            .map(m=>m.name)
	            .slice().sort((a,b)=>String(a).localeCompare(String(b)));
	          const ppBits = moves.map(mn => String(ppAfterClear?.[id]?.[mn]?.cur ?? DEFAULT_MOVE_PP)).join('/');
	          parts.push(`${id}:${sp}:${item}:${evo}:${str}:${moves.join('|')}:${ppBits}`);
	        }
	        return parts.join('~');
	      })();

	      const reuse = (curW.solve && curW.solve.signature === signature && Array.isArray(curW.solve.alts) && curW.solve.alts.length);
	      let alts = null;
	      let idx = 0;
	      let bestPatternKey = null;
	      let altsAllBest = null;
	      let altsAllBestTotal = 0;
	      let altsAllBestTruncated = false;
	      let genCapped = false;
	      let genCap = 0;

	      if (reuse){
	        alts = curW.solve.alts;
	        idx = ((Number(curW.solve.idx)||0) + 1) % alts.length;
	        bestPatternKey = curW.solve.bestPatternKey || null;
	        altsAllBest = Array.isArray(curW.solve.altsAllBest) ? curW.solve.altsAllBest : null;
	        altsAllBestTotal = Number(curW.solve.altsAllBestTotal || 0);
	        altsAllBestTruncated = !!curW.solve.altsAllBestTruncated;
	        genCapped = !!curW.solve.genCapped;
	        genCap = Number(curW.solve.genCap || 0);
	      } else {
	        // Compute fresh alternatives.
	        const computed = (function(){
	          // Build rowKey -> slot map (keep duplicates by rowKey).
	          const slotByKey = new Map();
	          for (const sl of (slots||[])){
	            const rk = String(sl.rowKey || sl.key || '');
	            if (!rk) continue;
	            slotByKey.set(rk, sl);
	          }

	          // Detect defenders that have Sturdy in this wave (via STU tag).
	          // Simple ground logic: avoid selecting STU defenders as "padding" targets or filler unless unavoidable.
	          const isSturdyKey = (rk)=>{
	            const sl = slotByKey.get(String(rk));
	            return Array.isArray(sl?.tags) && sl.tags.includes('STU');
	          };
	          const waveKeys = Array.from(slotByKey.keys());
	          if (!waveKeys.length) return null;

	                    // Auto x4 is a global solver and does NOT depend on Selected enemies (lead pair).
          // (Lead pair remains meaningful for the manual Fight button + Fight plan preview.)
          const leadPair = null;

          const maxFuturePhase = Math.min(3, phase + 2);
	          const futureCount = (rowKey)=>{
	            const sl = slotByKey.get(String(rowKey));
	            const base = sl ? pokeApi.baseOfSync(sl.defender, st.baseCache||{}) : String(rowKey);
	            let c = 0;
	            for (const x of (data.calcSlots || [])){
	              const ph = Number(x.phase || x.Phase || 0);
	              if (!(ph > phase && ph <= maxFuturePhase)) continue;
	              const sp = fixName(x.defender || x.species || x.name || '');
	              const b = pokeApi.baseOfSync(sp, st.baseCache||{});
	              if (b === base) c++;
	            }
	            return c;
	          };

	          // Pick up to 8 defender rowKeys to consider for padding (future-light first).
	          // Ensure the selected lead pair is included.
	          let chosenKeys = waveKeys.slice().sort((a,b)=>{
	            const fa = futureCount(a);
	            const fb = futureCount(b);
	            if (fa !== fb) return fa - fb;
	            return String(a).localeCompare(String(b));
	          });
	          if (leadPair){
	            const { lead0, lead1 } = leadPair;
	            chosenKeys = [lead0, lead1, ...chosenKeys.filter(k=>k!==lead0 && k!==lead1)];
	          }
	          chosenKeys = chosenKeys.slice(0, 8);
	          if (chosenKeys.length < 2) return null;

	          const attIds = act.map(r=>r.id);
	          const attPairs = [];
	          for (let i=0;i<attIds.length;i++) for (let j=i+1;j<attIds.length;j++) attPairs.push([attIds[i],attIds[j]]);

	          // Cache best move calc per (attId,rowKey) to keep enumeration fast.
	          const moveCache = new Map();
	          const bestMoveFor2 = (attId, defKey)=>{
	            const key = `${attId}||${defKey}`;
	            if (moveCache.has(key)) return moveCache.get(key);
	            const r = byId(st.roster, attId);
	            const defSlot = slotByKey.get(String(defKey));
	            if (!r || !defSlot){
	              moveCache.set(key, null);
	              return null;
	            }
	            const atk = {species:(r.effectiveSpecies||r.baseSpecies), level: st.settings.claimedLevel, ivAll: st.settings.claimedIV, evAll: r.strength?st.settings.strengthEV:st.settings.claimedEV};
	            const def = {species:defSlot.defender, level:defSlot.level, ivAll: st.settings.wildIV, evAll: st.settings.wildEV};
	            let mp = r.movePool||[];
	            const forced = (st.wavePlans?.[waveKey]?.attackMoveOverride||{})[attId] || null;
	            if (forced){
	              const filtered = mp.filter(m=>m && m.use !== false && m.name===forced);
	              if (filtered.length) mp = filtered;
	            }
	            const res = calc.chooseBestMove({data, attacker:atk, defender:def, movePool:mp, settings: settingsForWave(st, st.wavePlans?.[waveKey]||{}, attId, defSlot.rowKey), tags: defSlot.tags||[]});
	            const best = res?.best || null;
	            moveCache.set(key, best);
	            return best;
	          };

	          const scoreTuple = (m0, m1)=>{
	            const ohko = (m0?.oneShot ? 1 : 0) + (m1?.oneShot ? 1 : 0);
	            const worstPrio = Math.max(m0?.prio ?? 9, m1?.prio ?? 9);
	            const avgPrio = ((m0?.prio ?? 9) + (m1?.prio ?? 9)) / 2;
	            const overkill = Math.abs((m0?.minPct ?? 0) - 100) + Math.abs((m1?.minPct ?? 0) - 100);
	            return {ohko, worstPrio, avgPrio, overkill};
	          };
	          const betterT = (a,b)=>{
	            if (a.ohko !== b.ohko) return a.ohko > b.ohko;
	            if (a.worstPrio !== b.worstPrio) return a.worstPrio < b.worstPrio;
	            if (a.avgPrio !== b.avgPrio) return a.avgPrio < b.avgPrio;
	            return a.overkill <= b.overkill;
	          };

	          // --- Auto x4: STU AoE 1-turn clear detection (schedule scoring parity with battle engine) ---
	          // The schedule generator uses a fast (per-target) tuple score. That under-values STU+add pairs
	          // when a 1-turn plan exists (chip STU then AoE sweeps, or AoE leaves STU at 1 HP then finisher).
	          // We detect that deterministic 1-turn clear and upgrade the tuple to OHKO=2 so these plans
	          // are not pruned/ignored during schedule generation.

	          const clampHpPctLocal = (x)=>{
	            const n = Number(x);
	            if (!Number.isFinite(n)) return 0;
	            return Math.max(0, Math.min(100, n));
	          };
	          const clampDmgPctLocal = (x)=>{
	            const n = Number(x);
	            if (!Number.isFinite(n)) return 0;
	            return Math.max(0, Math.min(9999, n));
	          };

	          const canUseMoveName = (monId, moveName)=>{
	            if (!monId || !moveName) return false;
	            const cur = Number(ppAfterClear?.[monId]?.[moveName]?.cur ?? DEFAULT_MOVE_PP);
	            return cur > 0;
	          };

	          const atkObjFromId = (monId)=>{
	            const rm = byId(st.roster, monId);
	            if (!rm) return null;
	            return {
	              species:(rm.effectiveSpecies||rm.baseSpecies),
	              level: st.settings.claimedLevel,
	              ivAll: st.settings.claimedIV,
	              evAll: rm.strength?st.settings.strengthEV:st.settings.claimedEV,
	            };
	          };

	          const defObjFromKey = (rowKey)=>{
	            const sl = slotByKey.get(String(rowKey));
	            if (!sl) return null;
	            return {
	              species: sl.defender,
	              level: sl.level,
	              ivAll: st.settings.wildIV,
	              evAll: st.settings.wildEV,
	            };
	          };

	          const movePoolForAuto4 = (monId)=>{
	            const rm = byId(st.roster, monId);
	            if (!rm) return [];
	            let pool = (rm.movePool||[]).filter(m=>m && m.use !== false && m.name && canUseMoveName(monId, m.name));
	            const forced = (st.wavePlans?.[waveKey]?.attackMoveOverride||{})[monId] || null;
	            if (forced){
	              const f = pool.filter(m=>m.name===forced);
	              if (f.length) pool = f;
	              else pool = []; // forced but no PP
	            }
	            return pool;
	          };

	          const rrVsDef = (attId, moveName, defKey, curHpFrac)=>{
	            const atk = atkObjFromId(attId);
	            const def = defObjFromKey(defKey);
	            const sl = slotByKey.get(String(defKey));
	            if (!atk || !def || !sl) return null;
	            const wpSolve = st.wavePlans?.[waveKey] || {};
	            const s0 = settingsForWave(st, wpSolve, attId, sl.rowKey);
	            const s = {...s0, defenderCurHpFrac: (Number.isFinite(Number(curHpFrac)) ? Number(curHpFrac) : 1)};
	            try{
	              const rr = calc.computeDamageRange({data, attacker: atk, defender: def, moveName, settings: s, tags: sl.tags||[]});
	              return (rr && rr.ok) ? rr : null;
	            }catch(e){
	              return null;
	            }
	          };

	          const wouldFriendlyFireKOPartnerLocal = (aoeUserId, moveName, allyId)=>{
	            if (!aoeUserId || !moveName || !allyId) return false;
	            if (!!st.settings?.allowFriendlyFire) return false;
	            if (!isAoeMove(moveName) || !aoeHitsAlly(moveName)) return false;
	            const allyMon = byId(st.roster, allyId);
	            if (!allyMon) return false;
	            const atk = atkObjFromId(aoeUserId);
	            const def = atkObjFromId(allyId);
	            if (!atk || !def) return false;
	            const wpSolve = st.wavePlans?.[waveKey] || {};
	            const s0 = settingsForWave(st, wpSolve, aoeUserId, null);
	            const s = {...s0, defenderHpFrac: 1, defenderCurHpFrac: 1, defenderItem: allyMon.item || null, applySTU: false, applyINT: false};
	            try{
	              const rr = calc.computeDamageRange({data, attacker: atk, defender: def, moveName, settings: s, tags: []});
	              if (!rr || !rr.ok) return false;
	              const immune = immuneFromAllyAbilityItem(allyMon, rr.moveType);
	              if (immune) return false;
	              const maxPct = clampDmgPctLocal(Number(rr.maxPct ?? rr.minPct ?? 0));
	              // Conservative: ignore spread reduction and assume full damage.
	              return maxPct >= 100;
	            }catch(e){
	              return false;
	            }
	          };

	          const simulateTwoAtkActionsLocal = (defKeys, actions)=>{
	            // Deterministic min% sim for the two attacker actions only (mirrors battle engine order: speed desc).
	            const hp = {};
	            for (const k of defKeys) hp[k] = 100;

	            const withSpe = (actions||[]).map(a=>{
	              const sampleKey = a.sampleTargetKey || a.targetKey || defKeys[0];
	              const rr = rrVsDef(a.attackerId, a.move, sampleKey, (hp[sampleKey] ?? 100) / 100);
	              const pr = Number.isFinite(Number(a.prio)) ? Number(a.prio) : defaultPrioForMove(a.move);
              return {...a, actorSpe: Number(rr?.attackerSpe)||0, actorPrio: pr};
	            });
	            withSpe.sort((a,b)=>{
  const pa = Number.isFinite(Number(a.actorPrio)) ? Number(a.actorPrio) : 9;
  const pb = Number.isFinite(Number(b.actorPrio)) ? Number(b.actorPrio) : 9;
  if (pa !== pb) return pa - pb;
  const sa = Number(a.actorSpe)||0;
  const sb = Number(b.actorSpe)||0;
  if (sb !== sa) return sb - sa;
  return String(a.attackerId||'').localeCompare(String(b.attackerId||''));
});
for (const act of withSpe){
	              if (!act || !act.attackerId || !act.move) continue;
	              if (isAoeMove(act.move)){
	                const alive = defKeys.filter(k => (hp[k] ?? 0) > 0);
	                const hits = [];
	                for (const dk of alive){
	                  const rr = rrVsDef(act.attackerId, act.move, dk, (hp[dk] ?? 100) / 100);
	                  if (!rr) continue;
	                  hits.push({dk, min: clampDmgPctLocal(Number(rr.minPct)||0)});
	                }
	                const targetsDamaged = hits.filter(h => (h.min||0) > 0).length;
	                const mult = spreadMult(targetsDamaged);
	                for (const h of hits){
	                  const dmg = clampDmgPctLocal((h.min||0) * mult);
	                  hp[h.dk] = clampHpPctLocal((hp[h.dk] ?? 0) - dmg);
	                }
	              } else {
	                // single target; redirect if target already fainted
	                let tk = act.targetKey;
	                if (!tk || (hp[tk] ?? 0) <= 0){
	                  tk = defKeys.find(k => (hp[k] ?? 0) > 0) || null;
	                }
	                if (!tk) continue;
	                const rr = rrVsDef(act.attackerId, act.move, tk, (hp[tk] ?? 100) / 100);
	                if (!rr) continue;
	                const dmg = clampDmgPctLocal(Number(rr.minPct)||0);
	                hp[tk] = clampHpPctLocal((hp[tk] ?? 0) - dmg);
	              }
	            }
	            return hp;
	          };
const sturdyAoeSolveScore = (aId, bId, stuKey, otherKey)=>{
  if (!(st.settings?.sturdyAoeSolve ?? true)) return null;
  if (!stuKey || !otherKey) return null;

  const defKeys = [String(stuKey), String(otherKey)];
  const poolA0 = movePoolForAuto4(aId) || [];
  const poolB0 = movePoolForAuto4(bId) || [];
  const poolA = poolA0.filter(m=>m && m.name && canUseMoveName(aId, m.name));
  const poolB = poolB0.filter(m=>m && m.name && canUseMoveName(bId, m.name));
  if (!poolA.length || !poolB.length) return null;

  let best = null;
  const prioOf = (m)=> (Number.isFinite(Number(m?.prio)) ? Number(m.prio) : defaultPrioForMove(m?.name));

  for (const mA of poolA){
    const isAoeA = isAoeMove(mA.name);
    if (isAoeA && wouldFriendlyFireKOPartnerLocal(aId, mA.name, bId)) continue;

    for (const mB of poolB){
      const isAoeB = isAoeMove(mB.name);
      if (!isAoeA && !isAoeB) continue; // need at least one AoE to count as STU AoE solve
      if (isAoeB && wouldFriendlyFireKOPartnerLocal(bId, mB.name, aId)) continue;

      const pA = prioOf(mA);
      const pB = prioOf(mB);

      const tgtsA = isAoeA ? [String(otherKey)] : [String(stuKey), String(otherKey)];
      const tgtsB = isAoeB ? [String(otherKey)] : [String(stuKey), String(otherKey)];

      for (const tA of tgtsA){
        for (const tB of tgtsB){
          const hpNext = simulateTwoAtkActionsLocal(defKeys, [
            {attackerId: aId, move: mA.name, prio: pA, targetKey: tA, sampleTargetKey: tA},
            {attackerId: bId, move: mB.name, prio: pB, targetKey: tB, sampleTargetKey: tB},
          ]);
          const stuAlive = (hpNext[String(stuKey)] ?? 0) > 0;
          const otherAlive = (hpNext[String(otherKey)] ?? 0) > 0;
          if (stuAlive || otherAlive) continue;

          const worstPrio = Math.max(pA, pB);
          const avgPrio = (pA + pB) / 2;
          const cand = {worstPrio, avgPrio};

          if (!best) best = cand;
          else {
            if (cand.worstPrio < best.worstPrio) best = cand;
            else if (cand.worstPrio === best.worstPrio && cand.avgPrio < best.avgPrio) best = cand;
          }
        }
      }
    }
  }
  return best;
};


	          // Enumerate all ways to pad n unique defenders to 8 slots (stars-and-bars).
	          // Preference: do NOT duplicate STU defenders (we still fight them once to claim them, but don't waste fights repeating them).
	          // If this constraint makes it impossible (e.g., all defenders are STU), fall back to unconstrained enumeration.
	          const enumerateDistributions = (keys)=>{
	            const n = keys.length;
	            const extra = Math.max(0, 8 - n);
	            const out = [];
	            if (extra === 0){
	              out.push(keys.slice());
	              return out;
	            }
	            const parts = new Array(n).fill(0);

	            const build = ()=>{
	              const expanded = [];
	              for (let i=0;i<n;i++){
	                const cnt = 1 + parts[i];
	                for (let k=0;k<cnt;k++) expanded.push(keys[i]);
	              }
	              out.push(expanded);
	            };

	            const recNoStu = (idx, rem)=>{
	              if (idx === n - 1){
	                if (isSturdyKey(keys[idx]) && rem > 0) return;
	                parts[idx] = rem;
	                build();
	                return;
	              }
	              const maxX = (isSturdyKey(keys[idx])) ? 0 : rem;
	              for (let x=0;x<=maxX;x++){
	                parts[idx] = x;
	                recNoStu(idx+1, rem-x);
	              }
	            };
	            recNoStu(0, extra);

	            if (out.length) return out;

	            // Fallback: unconstrained enumeration.
	            const out2 = [];
	            const parts2 = new Array(n).fill(0);
	            const build2 = ()=>{
	              const expanded = [];
	              for (let i=0;i<n;i++){
	                const cnt = 1 + parts2[i];
	                for (let k=0;k<cnt;k++) expanded.push(keys[i]);
	              }
	              out2.push(expanded);
	            };
	            const rec2 = (idx, rem)=>{
	              if (idx === n - 1){
	                parts2[idx] = rem;
	                build2();
	                return;
	              }
	              for (let x=0;x<=rem;x++){
	                parts2[idx] = x;
	                rec2(idx+1, rem-x);
	              }
	            };
	            rec2(0, extra);
	            return out2;
	          };

	          // Cache best attacker-pair CHOICES for a defender-pair (by rowKey).
	          // We keep *tie-best* attacker pairs (same OHKO + prio quality) so the "All combos"
	          // explorer can show real alternatives that v16 exposed.
	          const pairBestCache = new Map();
	          const TIE_CAP = 10; // safety: keep at most N tie-best attacker pairs per defender-pair
	          const getPairChoicesByKeys = (k0, k1)=>{
	            const a = String(k0);
	            const b = String(k1);
	            const kk = (a < b) ? `${a}||${b}` : `${b}||${a}`;
	            if (pairBestCache.has(kk)) return pairBestCache.get(kk);

	            // STU+add defender pair? If so, we can detect a deterministic 1-turn AoE solve
	            // (chip STU then AoE sweep, or AoE leaves STU at 1 HP then finisher) and upgrade
	            // the tuple score to OHKO=2 so schedule generation doesn't avoid this pairing.
	            const isStuPair = (st.settings?.sturdyAoeSolve ?? true) && (isSturdyKey(a) !== isSturdyKey(b));
	            const stuKey = isStuPair ? (isSturdyKey(a) ? a : b) : null;
	            const addKey = isStuPair ? (isSturdyKey(a) ? b : a) : null;

	            const cands = [];
	            for (const [aId0, bId0] of attPairs){
	              const mA0 = bestMoveFor2(aId0, a);
	              const mA1 = bestMoveFor2(aId0, b);
	              const mB0 = bestMoveFor2(bId0, a);
	              const mB1 = bestMoveFor2(bId0, b);

	              // Try both assignments and keep the better.
	              const t01 = scoreTuple(mA0, mB1);
	              const t10 = scoreTuple(mA1, mB0);
	              let tuple = t01;
	              if (!betterT(t01, t10)) tuple = t10;

	            // STU AoE parity: if this attacker pair can fully clear (STU+add) in 1 turn deterministically,
	            // upgrade the tuple so schedules pairing STU with the correct add are not pruned.
	            // NOTE: This must happen BEFORE pruning; some valid STU AoE solves have 0 immediate OHKOs
	            // under the simple per-target tuple (e.g., chip + AoE sweep).
	            if (isStuPair && stuKey && addKey){
	              const sc = sturdyAoeSolveScore(aId0, bId0, stuKey, addKey);
	              if (sc){
	                tuple = {...tuple, ohko: 2, worstPrio: sc.worstPrio, avgPrio: sc.avgPrio};
	              }
	            }

	            // Drop hopeless pairs (no OHKO at all) to prune.
	            if (tuple.ohko <= 0) continue;

	              // Canonicalize attacker pair order to avoid duplicates.
	              const pair = [aId0, bId0].slice().sort((x,y)=>String(x).localeCompare(String(y)));
	              const cand = {aId: pair[0], bId: pair[1], score: tuple};
	              cands.push(cand);
	            }

	            // Sort best-first using the same tuple comparator.
	            cands.sort((x,y)=>{
	              if (betterT(x.score, y.score)) return -1;
	              if (betterT(y.score, x.score)) return 1;
	              // stable-ish: by ids
	              const ax = `${x.aId}+${x.bId}`;
	              const ay = `${y.aId}+${y.bId}`;
	              return ax.localeCompare(ay);
	            });

	            const best = cands[0] || null;
	            if (!best){
	              pairBestCache.set(kk, null);
	              return null;
	            }


	            // Keep tie-best by core prio quality (ignore overkill so we keep meaningful roster alternatives).
	            const sameCore = (x,y)=>(
	              x.ohko === y.ohko &&
	              x.worstPrio === y.worstPrio &&
	              Math.abs(x.avgPrio - y.avgPrio) <= 1e-9
	            );
	            const ties = [];
	            for (const cand of cands){
	              if (!sameCore(cand.score, best.score)) break;
	              ties.push(cand);
	              if (ties.length >= TIE_CAP) break;
	            }

	            // STU+add special-case: keep a couple of AoE-capable attacker pairs even if their
	            // single-target tuple score is slightly worse. This prevents early pruning from
	            // hiding valid STU AoE solves (e.g., Earthquake) during Auto x4 schedule generation.
	            if (isStuPair && ties.length < TIE_CAP){
	              const stuKey = isSturdyKey(a) ? a : b;
	              const addKey = isSturdyKey(a) ? b : a;
	              const wpSolve = st.wavePlans?.[waveKey] || {};
	              const slotAdd = slotByKey.get(String(addKey));
	              const slotStu = slotByKey.get(String(stuKey));

	              const canUseMove = (monId, moveName)=>{
	                const cur = Number(ppAfterClear?.[monId]?.[moveName]?.cur ?? DEFAULT_MOVE_PP);
	                return cur > 0;
	              };

	              const atkObjFromRoster = (rm)=>({
	                species:(rm.effectiveSpecies||rm.baseSpecies),
	                level: st.settings.claimedLevel,
	                ivAll: st.settings.claimedIV,
	                evAll: rm.strength?st.settings.strengthEV:st.settings.claimedEV,
	              });
	              const defObjFromRoster = (rm)=>({
	                species:(rm.effectiveSpecies||rm.baseSpecies),
	                level: st.settings.claimedLevel,
	                ivAll: st.settings.claimedIV,
	                evAll: rm.strength?st.settings.strengthEV:st.settings.claimedEV,
	              });

	              const hasSturdyAoeKillAdd = (aoeUserId, allyId)=>{
	                if (!slotAdd || !slotStu) return false;
	                const rm = byId(st.roster, aoeUserId);
	                const ally = byId(st.roster, allyId);
	                if (!rm || !ally) return false;

	                let mp = (rm.movePool||[]).filter(m=>m && m.use !== false && m.name);
	                const forced = (st.wavePlans?.[waveKey]?.attackMoveOverride||{})[aoeUserId] || null;
	                if (forced){
	                  const filtered = mp.filter(m=>m.name===forced);
	                  if (filtered.length) mp = filtered;
	                }
	                mp = mp.filter(m=>canUseMove(aoeUserId, m.name));
	                const aoeMoves = mp.filter(m=>isAoeMove(m.name));
	                if (!aoeMoves.length) return false;

	                const atk = atkObjFromRoster(rm);
	                const defAdd = {species: slotAdd.defender, level: slotAdd.level, ivAll: st.settings.wildIV, evAll: st.settings.wildEV};
	                const defStu = {species: slotStu.defender, level: slotStu.level, ivAll: st.settings.wildIV, evAll: st.settings.wildEV};

	                for (const mv of aoeMoves){
	                  // Respect FF disallow only when the AoE could KO the partner at full HP.
	                  if (aoeHitsAlly(mv.name) && !(st.settings?.allowFriendlyFire)){
	                    try{
	                      const rrA = calc.computeDamageRange({
	                        data,
	                        attacker: atk,
	                        defender: defObjFromRoster(ally),
	                        moveName: mv.name,
	                        settings: settingsForWave(st, wpSolve, aoeUserId, null),
	                        tags: [],
	                      });
	                      if (rrA && rrA.ok){
	                        const immune = immuneFromAllyAbilityItem(ally, rrA.moveType);
	                        if (!immune){
	                          const maxAdj = Number(rrA.maxPct ?? rrA.minPct ?? 0) * spreadMult(3);
	                          if (maxAdj >= 100) continue;
	                        }
	                      }
	                    }catch(e){ /* ignore */ }
	                  }

	                  let rrAdd = null;
	                  let rrStu = null;
	                  try{
	                    rrAdd = calc.computeDamageRange({
	                      data,
	                      attacker: atk,
	                      defender: defAdd,
	                      moveName: mv.name,
	                      settings: settingsForWave(st, wpSolve, aoeUserId, slotAdd.rowKey),
	                      tags: slotAdd.tags||[],
	                    });
	                    rrStu = calc.computeDamageRange({
	                      data,
	                      attacker: atk,
	                      defender: defStu,
	                      moveName: mv.name,
	                      settings: settingsForWave(st, wpSolve, aoeUserId, slotStu.rowKey),
	                      tags: slotStu.tags||[],
	                    });
	                  }catch(e){ rrAdd = null; rrStu = null; }
	                  if (!rrAdd || !rrAdd.ok || !rrStu || !rrStu.ok) continue;

	                  // Deterministic: min-roll; spread applies once when 2 defenders are hit.
	                  const mult = spreadMult(2);
	                  const minAdjAdd = Number(rrAdd.minPct||0) * mult;
	                  const minAdjStu = Number(rrStu.minPct||0) * mult;
	                  if (minAdjAdd >= 100 && minAdjStu > 0) return true;
	                }
	                return false;
	              };

	              const have = new Set(ties.map(x=>`${x.aId}+${x.bId}`));
	              const extras = [];
	              for (const cand of cands){
	                if (extras.length >= 3) break;
	                const key2 = `${cand.aId}+${cand.bId}`;
	                if (have.has(key2)) continue;
	                const ok = hasSturdyAoeKillAdd(cand.aId, cand.bId) || hasSturdyAoeKillAdd(cand.bId, cand.aId);
	                if (ok){
	                  extras.push(cand);
	                  have.add(key2);
	                }
	              }
	              for (const ex of extras){
	                if (ties.length >= TIE_CAP) break;
	                ties.push(ex);
	              }
	            }

	            pairBestCache.set(kk, ties);
	            return ties;
	          };

	          const scoreSchedule = (pairs)=>{
	            let totalOhko = 0;
	            let worstWorstPrio = 0;
	            let sumAvgPrio = 0;
	            let sumOverkill = 0;
	            for (const p of pairs){
	              const sc = p.best.score;
	              totalOhko += sc.ohko;
	              worstWorstPrio = Math.max(worstWorstPrio, sc.worstPrio);
	              sumAvgPrio += sc.avgPrio;
	              sumOverkill += sc.overkill;
	            }
	            return {totalOhko, worstWorstPrio, sumAvgPrio, sumOverkill};
	          };
	          const cmpScore = (a,b)=>{
	            if (a.totalOhko !== b.totalOhko) return b.totalOhko - a.totalOhko;
	            if (a.worstWorstPrio !== b.worstWorstPrio) return a.worstWorstPrio - b.worstWorstPrio;
	            if (a.sumAvgPrio !== b.sumAvgPrio) return a.sumAvgPrio - b.sumAvgPrio;
	            return a.sumOverkill - b.sumOverkill;
	          };

	          const bestSingleTargetMove = (mA, mB)=>{
	            const cands = [mA, mB].filter(Boolean);
	            if (!cands.length) return null;
	            cands.sort((x,y)=>{
	              const xo = x.oneShot?1:0;
	              const yo = y.oneShot?1:0;
	              if (xo !== yo) return yo-xo;
	              const xp = x.prio ?? 9;
	              const yp = y.prio ?? 9;
	              if (xp !== yp) return xp-yp;
	              if (x.oneShot && y.oneShot){
	                const xk = Math.abs((x.minPct||0)-100);
	                const yk = Math.abs((y.minPct||0)-100);
	                if (xk !== yk) return xk-yk;
	              }
	              return (y.minPct||0) - (x.minPct||0);
	            });
	            return cands[0];
	          };

	          const pickFillKey = (aId, bId)=>{
	            let best = null;
	            let bestNonStu = null;
	            for (const rk of chosenKeys){
	              const sl = slotByKey.get(String(rk));
	              if (!sl) continue;
	              const mA = bestMoveFor2(aId, rk);
	              const mB = bestMoveFor2(bId, rk);
	              const m = bestSingleTargetMove(mA, mB);
	              if (!m) continue;
	              const tuple = {
	                ohko: m.oneShot ? 1 : 0,
	                prio: m.prio ?? 9,
	                over: Math.abs((m.minPct||0)-100),
	                minPct: m.minPct || 0,
	              };
	              const better = (x,y)=>{
	                if (!y) return true;
	                if (x.ohko !== y.ohko) return x.ohko > y.ohko;
	                if (x.prio !== y.prio) return x.prio < y.prio;
	                if (x.over !== y.over) return x.over < y.over;
	                return x.minPct >= y.minPct;
	              };
	              if (better(tuple, best?.tuple)) best = {rowKey: sl.rowKey, tuple};
	              if (!isSturdyKey(rk)){
	                if (better(tuple, bestNonStu?.tuple)) bestNonStu = {rowKey: sl.rowKey, tuple};
	              }
	            }
	            // Prefer non-sturdy filler. Only fall back to sturdy if there is no other option.
	            return bestNonStu?.rowKey || best?.rowKey || chosenKeys[0];
	          };

	          const fightKey = (f)=>{
	            const pair = [f.aId, f.bId].slice().sort((x,y)=>String(x).localeCompare(String(y))).join('+');
	            const defs = (f.defs||[]).slice().sort((x,y)=>String(x).localeCompare(String(y))).join('|');
	            return `${pair}@${defs}`;
	          };
	          const altKeyFromFights = (fights)=> fights.map(fightKey).slice().sort().join('||');

	          // Variation limits (global setting)
	          const cycleLimit = Math.max(1, Math.min(50, Math.floor(Number(st.settings?.variationLimit ?? 8) || 8)));
	          // Generation cap: protect against blow-ups on huge waves, but allow deeper search on
	          // normal (<=8 defender) waves so Auto x4 can reliably find the best schedule.
	          const genCapSetting = Math.max(200, Math.min(50000, Math.floor(Number(st.settings?.variationGenCap ?? 5000) || 5000)));
	          const genCap = (chosenKeys.length <= 8) ? Math.max(genCapSetting, 20000) : genCapSetting;

	          // Generate ALL unique candidates across ALL padding distributions.
	          // NOTE: We still apply a safety cap (genCap) to avoid pathological blow-ups on huge waves.
	          const candidates = [];
	          const seen = new Set();
	          let genCapped = false;

	          const paddedLists = enumerateDistributions(chosenKeys);

	          for (const defKeys of paddedLists){
	            if (genCapped) break;
	            if (!Array.isArray(defKeys) || defKeys.length !== 8) continue;

	            // Build best defender-pair -> attacker-pair mapping for this padded list.
	            const pairBest = Array.from({length:8}, ()=>Array(8).fill(null));
	            for (let i=0;i<8;i++){
	              for (let j=i+1;j<8;j++){
	                pairBest[i][j] = getPairChoicesByKeys(defKeys[i], defKeys[j]);
	              }
	            }

	            let schedules = [];
	            const recMatch = (mask, pairs)=>{
	              if (mask === 0){
	                schedules.push({pairs, score: scoreSchedule(pairs)});
	                return;
	              }
	              let i = 0;
	              while (i < 8 && ((mask & (1<<i)) === 0)) i++;
	              for (let j=i+1;j<8;j++){
	                if ((mask & (1<<j)) === 0) continue;
	                const b = pairBest[i][j];
					if (!b || !b.length) continue;
					recMatch(mask & ~(1<<i) & ~(1<<j), pairs.concat([{i,j,choices:b, best:b[0]}]));
				}
	            };
	            recMatch((1<<8)-1, []);

	            // If the user selected a lead pair, try to keep schedules that pair them together.
	            // This makes Auto x4 align with the current Fight plan selection when possible.
	            if (leadPair){
	              const leadOnly = schedules.filter(sch => (sch?.pairs||[]).some(p=>{
	                const a = baseDefKey(String(defKeys[p.i]));
	                const b = baseDefKey(String(defKeys[p.j]));
	                return (a === leadPair.lead0 && b === leadPair.lead1) || (a === leadPair.lead1 && b === leadPair.lead0);
	              }));
	              if (leadOnly.length) schedules = leadOnly;
	            }

	            // Sort schedules so we scan good ones first (helps stability), but we still keep ALL unique keys.
	            schedules.sort((x,y)=> cmpScore(x.score, y.score));

	            const fightBasesForSchedule = (sch)=> (sch.pairs||[]).slice(0,4).map(p=>{
	              const d0 = String(defKeys[p.i]);
	              const d1 = String(defKeys[p.j]);
	              const defsBase = [d0, d1].slice().sort((x,y)=>String(x).localeCompare(String(y)));
	              const choices = Array.isArray(p.choices) ? p.choices : (p.best ? [p.best] : []);
	              return {defsBase, choices};
	            });

	            const cloneFights = (arr)=> (arr||[]).map(f=>({aId:f.aId, bId:f.bId, defs:(f.defs||[]).slice()}));

	            const fightHasLeadPair = (defs)=>{
	              if (!leadPair) return false;
	              const set = new Set((defs||[]).map(k=>baseDefKey(String(k))));
	              return set.has(leadPair.lead0) && set.has(leadPair.lead1);
	            };
	            const orderFightsForLead = (fights)=>{
	              if (!leadPair) return fights;
	              const idx = fights.findIndex(f=>fightHasLeadPair(f.defs));
	              if (idx <= 0) return fights;
	              return [fights[idx], ...fights.slice(0,idx), ...fights.slice(idx+1)];
	            };

	            // Build candidate alts from a given defender-pairing schedule.
	            // IMPORTANT: Cap per-schedule expansion so we don't exhaust genCap on the first few
	            // high-branch schedules (e.g., many tie-best attacker pairs). This improves breadth
	            // and prevents missing globally-better schedules like STU-break → AoE clears.
	            const addCandidatesFromSchedule = (sch, perScheduleCap)=>{
	              const bases = fightBasesForSchedule(sch);
	              if (!bases.length) return;
	              const fights = [];
	              let addedHere = 0;
	              const rec = (idx)=>{
	                if (genCapped) return;
	                if (Number.isFinite(Number(perScheduleCap)) && addedHere >= perScheduleCap) return;
	                if (idx >= bases.length){
	                  const leadOk = !leadPair || fights.some(f=>fightHasLeadPair(f.defs));
	                  const fightsOrdered = orderFightsForLead(fights);
	                  const key = altKeyFromFights(fightsOrdered);
	                  if (!seen.has(key)){
	                    seen.add(key);
	                    candidates.push({fights: cloneFights(fightsOrdered), key, leadOk});
	                    addedHere++;
	                    if (candidates.length >= genCap){
	                      genCapped = true;
	                    }
	                  }
	                  return;
	                }
	                const base = bases[idx];
	                const opts = (base.choices||[]);
	                for (const opt of opts){
	                  if (genCapped) break;
	                  const aId = opt.aId;
	                  const bId = opt.bId;
	                  const isLeadFight = !!(leadPair && Array.isArray(base.defsBase) && base.defsBase.includes(leadPair.lead0) && base.defsBase.includes(leadPair.lead1));
	                  let defs = isLeadFight ? [leadPair.lead0, leadPair.lead1] : (base.defsBase||[]).slice();
	                  const fill = (defLimit > 2) ? pickFillKey(aId, bId) : null;
	                  while (defs.length < defLimit && fill) defs.push(String(fill));
	                  if (!isLeadFight){
	                    defs = defs.slice().sort((x,y)=>String(x).localeCompare(String(y)));
	                  }
	                  fights.push({defs, aId, bId});
	                  rec(idx+1);
	                  fights.pop();
	                }
	              };
	              rec(0);
	            };

	            // Round-robin-ish breadth: cap expansion per schedule so we sample across many
	            // defender matchings instead of fully expanding the earliest one.
	            const perSchCap = Math.max(
	              10,
	              Math.min(200, Math.floor(genCap / Math.max(1, schedules.length * 4)))
	            );
	            for (const sch of schedules){
	              if (genCapped) break;
	              addCandidatesFromSchedule(sch, perSchCap);
	            }
	          }

	          if (!candidates.length) return null;

	          // If the user picked a lead pair, prefer schedules that actually include that pairing.
	          // (When available, this makes Auto x4 align with the Fight plan selection instead of
	          // "solving around" it by pairing one lead with a different filler.)
	          const candidatesToScore = (leadPair && candidates.some(c=>c.leadOk))
	            ? candidates.filter(c=>c.leadOk)
	            : candidates;

	          // Sim-score ALL candidates once, then:
	          // - altsCycle: bestAvg + slack (then bestWorst), capped to MAX_OUT
	          // - altsAllBest: ALL candidates matching the single best prio pattern (avg then worst)
	          const scored = [];
	          const simState = JSON.parse(JSON.stringify(st));
	          const EPS = 1e-9;

	          const patternKeyFromPrios = (prios)=>{
	            const nums = (prios||[]).map(x=>Math.round(Number(x||0)*2)/2).sort((a,b)=>a-b);
	            return nums.map(n=>`P${formatPrioAvg(n)}`).join(' · ');
	          };

	          // Prefer solutions that do NOT keep Sturdy mons on the field across many segments.
	          // This is a *tie-breaker* after (avg prioØ, worst prioØ).
	          const sturdyCountFromFights = (fights)=>{
	            let n = 0;
	            for (const f of (fights||[])){
	              for (const rk of (f?.defs||[])){
	                if (isSturdyKey(rk)) n++;
	              }
	            }
	            return n;
	          };

	          const lexKey = (alt)=>{
	            const parts = (alt?.fights||[]).map(fightKey).slice().sort();
	            return parts.join('||');
	          };

	          for (const cand of candidatesToScore){
	            // Re-init sim state to baseline (PP is ppAfterClear) for this candidate.
	            simState.pp = JSON.parse(JSON.stringify(ppAfterClear || {}));
	            simState.battles = {};
	            simState.wavePlans = JSON.parse(JSON.stringify(st.wavePlans || {}));
	            const wTmp = simState.wavePlans?.[waveKey] || JSON.parse(JSON.stringify(curW || {}));
	            simState.wavePlans[waveKey] = wTmp;

	            const prios = [];
	            const turns = [];
	            let ppSpent = 0;
	            let allWon = true;
	            for (const spec of (cand.fights||[])){
	              const e = makeFightEntry(simState, wTmp, spec?.aId, spec?.bId, spec?.defs);
	              if (!e || e.status !== 'won'){
	                allWon = false;
	                break;
	              }
	              prios.push(Number.isFinite(Number(e?.prioAvg)) ? Number(e.prioAvg) : 9);
	              turns.push(Number.isFinite(Number(e?.turnCount)) ? Number(e.turnCount) : 99);
	              for (const d of (e.ppDelta || [])){
	                const used = Number(d.prevCur||0) - Number(d.nextCur||0);
	                if (used > 0) ppSpent += used;
	              }
	            }
	            if (!allWon) continue;

	            // Auto x4 selection: prioØ-first (lower is better), then turns, then PP usage.
	            const avgPrio = prios.length ? (prios.reduce((s,x)=>s+x,0) / prios.length) : 9;
	            const maxPrio = prios.length ? Math.max(...prios) : 9;
	            const avgTurns = turns.length ? (turns.reduce((s,x)=>s+x,0) / turns.length) : 99;
	            const maxTurns = turns.length ? Math.max(...turns) : 99;
	            const stu = sturdyCountFromFights(cand.fights);
	            scored.push({
	              alt:{fights:cand.fights},
	              avgPrio,
	              maxPrio,
	              avgTurns,
	              maxTurns,
	              ppSpent,
	              stu,
	              pat: patternKeyFromPrios(prios),
	              key: cand.key,
	              lex: lexKey({fights:cand.fights})
	            });
	          }

	          if (!scored.length) return null;

	          // Find the single best schedule by (min avg prioØ, then min worst prioØ),
	          // then fewer turns, then lower PP usage, then fewer STU defenders, then stable tie-break by lex.
	          let bestAvg = Math.min(...scored.map(x=>x.avgPrio));
	          const bestAvgSet = scored.filter(x=> Math.abs((x.avgPrio||9) - bestAvg) <= EPS);
	          let bestWorst = Math.min(...bestAvgSet.map(x=>x.maxPrio));
	          const bestSet = bestAvgSet.filter(x=> Math.abs((x.maxPrio||9) - bestWorst) <= EPS);
	          bestSet.sort((a,b)=>{
	            if ((a.avgTurns||99) !== (b.avgTurns||99)) return (a.avgTurns||99) - (b.avgTurns||99);
	            if ((a.maxTurns||99) !== (b.maxTurns||99)) return (a.maxTurns||99) - (b.maxTurns||99);
	            if ((a.ppSpent||0) !== (b.ppSpent||0)) return (a.ppSpent||0) - (b.ppSpent||0);
	            if ((a.stu||0) !== (b.stu||0)) return (a.stu||0) - (b.stu||0);
	            return String(a.lex).localeCompare(String(b.lex));
	          });
	          const bestPatternKey = bestSet[0]?.pat || '—';

	          // Build the "best pattern" list (this is what the modal should show by default).
	          const bestMatches = scored.filter(x=> x.pat === bestPatternKey);
	          bestMatches.sort((a,b)=>{
	            if ((a.avgTurns||99) !== (b.avgTurns||99)) return (a.avgTurns||99) - (b.avgTurns||99);
	            if ((a.maxTurns||99) !== (b.maxTurns||99)) return (a.maxTurns||99) - (b.maxTurns||99);
	            if ((a.ppSpent||0) !== (b.ppSpent||0)) return (a.ppSpent||0) - (b.ppSpent||0);
	            if ((a.stu||0) !== (b.stu||0)) return (a.stu||0) - (b.stu||0);
	            return String(a.lex).localeCompare(String(b.lex));
	          });
	          const MAX_BEST = cycleLimit;
	          const altsAllBest = bestMatches.slice(0, MAX_BEST).map(x=>x.alt);
	          const altsAllBestTotal = bestMatches.length;
	          const altsAllBestTruncated = bestMatches.length > MAX_BEST;

	          // Cycle list: within bestAvg + slack (avg prioØ), cap.
	          const slack = Math.max(0, Number(st.settings?.autoAltAvgSlack ?? 0));
	          const cutoff = bestAvg + slack + EPS;
	          const kept = scored.filter(x=> (x.avgPrio ?? 9) <= cutoff);
	          kept.sort((a,b)=>{
	            if ((a.avgPrio||9) !== (b.avgPrio||9)) return (a.avgPrio||9) - (b.avgPrio||9);
	            if ((a.maxPrio||9) !== (b.maxPrio||9)) return (a.maxPrio||9) - (b.maxPrio||9);
	            if ((a.avgTurns||99) !== (b.avgTurns||99)) return (a.avgTurns||99) - (b.avgTurns||99);
	            if ((a.maxTurns||99) !== (b.maxTurns||99)) return (a.maxTurns||99) - (b.maxTurns||99);
	            if ((a.ppSpent||0) !== (b.ppSpent||0)) return (a.ppSpent||0) - (b.ppSpent||0);
	            if ((a.stu||0) !== (b.stu||0)) return (a.stu||0) - (b.stu||0);
	            return String(a.lex).localeCompare(String(b.lex));
	          });
	          const altsCycle = kept.slice(0, cycleLimit).map(x=>x.alt);

	          return {altsCycle, bestPatternKey, altsAllBest, altsAllBestTotal, altsAllBestTruncated, genCapped, genCap};
	        })();

	        if (computed && computed.altsCycle && computed.altsCycle.length){
	          alts = computed.altsCycle;
	          idx = 0;
	          bestPatternKey = computed.bestPatternKey || null;
	          altsAllBest = computed.altsAllBest || null;
	          altsAllBestTotal = Number(computed.altsAllBestTotal || 0);
	          altsAllBestTruncated = !!computed.altsAllBestTruncated;
	          genCapped = !!computed.genCapped;
	          genCap = Number(computed.genCap || 0);
	        }
	      }

	      if (!alts || !alts.length){
	        alert('Could not auto-solve this wave with current roster/moves.');
	        return;
	      }

	      // Clear current log and re-simulate.
	      clearAllLog();
	      store.update(s=>{
	        const w = s.wavePlans?.[waveKey];
	        if (!w) return;
	        ensureWavePlan(data, s, waveKey, slots);
	        w.solve = {alts, idx, signature, bestPatternKey, altsAllBest, altsAllBestTotal, altsAllBestTruncated, genCapped: !!genCapped, genCap: Number(genCap||0)};
	        const chosen = alts[idx] || alts[0];
	        for (const spec of (chosen.fights||[])){
	          const entry = makeFightEntry(s, w, spec.aId, spec.bId, spec.defs);
	          pushEntry(s, w, entry);
	        }
	      });
	    });

	
    // Auto-solve cycling hint (when multiple alternatives exist)
    const altHint = el('div', {class:'muted small', style:'white-space:nowrap'}, '');
    const altsLen = (wp.solve?.alts || []).length;
    if (altsLen > 1){
      const curIdx = ((Number(wp.solve?.idx) || 0) % altsLen + altsLen) % altsLen;
      altHint.textContent = `Alt ${curIdx+1}/${altsLen} (click Auto x4 to cycle)`;
      altHint.style.display = '';
    } else {
      altHint.style.display = 'none';
    }



    // Explorer: show ALL auto-solve alternatives (battle combinations) with their prio patterns.
    // This is a read-only layer; selecting one applies it like Auto x4 (clears and re-sims 4 fights once).
    const viewCombosBtn = el('button', {class:'btn-mini'}, 'All combos');
    viewCombosBtn.title = 'Show all auto-solve alternatives for this wave';
    {
      const has = (wp.solve?.altsAllBest || wp.solve?.alts || []).length > 0;
      viewCombosBtn.disabled = !has;
    }

    const openCombosModal = ()=>{
      const stBase = store.getState();
      const wBase = stBase.wavePlans?.[waveKey];
      const solve = wBase?.solve || {};
      const alts = (solve.altsAllBest || solve.alts || []);
      const bestPatternKey = solve.bestPatternKey || null;
      const bestTotal = Number(solve.altsAllBestTotal || 0);
      const bestTrunc = !!solve.altsAllBestTruncated;

      // Global variation limit (used for cycling + default combo displays)
      const lim = Math.max(1, Math.min(50, Math.floor(Number(stBase.settings?.variationLimit ?? 8) || 8)));
      const genCapped = !!solve.genCapped;
      const genCap = Number(solve.genCap || 0);
      if (!alts.length){
        alert('No alternatives yet. Click Auto x4 first.');
        return;
      }

      // PP baseline = current PP with THIS wave's fight log rewound, so previews match cycling behavior.
      const ppBaseline = (function(){
        const pp = JSON.parse(JSON.stringify(stBase.pp || {}));
        const log = (wBase.fightLog || []).slice().reverse();
        for (const e of log){
          for (const d of (e.ppDelta || [])){
            if (!pp?.[d.monId]?.[d.move]) continue;
            pp[d.monId][d.move].cur = d.prevCur;
          }
        }
        return pp;
      })();

      const simAlt = (alt)=>{
        const sim = JSON.parse(JSON.stringify(stBase));
        sim.pp = JSON.parse(JSON.stringify(ppBaseline));
        sim.battles = {};
        sim.wavePlans = JSON.parse(JSON.stringify(stBase.wavePlans || {}));
        sim.wavePlans[waveKey] = sim.wavePlans[waveKey] || {};
        const wSim = sim.wavePlans[waveKey];

        const entries = [];
        const prios = [];
        for (const spec of (alt?.fights || [])){
          const e = makeFightEntry(sim, wSim, spec?.aId, spec?.bId, spec?.defs);
          if (!e) continue;
          entries.push(e);
          prios.push(Number.isFinite(Number(e.prioAvg)) ? Number(e.prioAvg) : 9);
        }
        const avg = prios.length ? (prios.reduce((s,x)=>s+x,0) / prios.length) : 9;
        const max = prios.length ? Math.max(...prios) : 9;
        // Pattern key is order-insensitive (sorted), so equivalent schedules group together.
        const pat = (prios||[])
          .map(x=>Math.round(Number(x||0)*2)/2)
          .sort((a,b)=>a-b)
          .map(p=>`P${formatPrioAvg(p)}`)
          .join(' · ');
        return {entries, prios, avg, max, pat};
      };

      const metas = alts.map((alt, idx)=>{
        const sim = simAlt(alt);
        return {idx, alt, ...sim};
      });
      metas.sort((a,b)=>{
        if (a.avg != b.avg) return a.avg - b.avg;
        if (a.max != b.max) return a.max - b.max;
        return a.idx - b.idx;
      });

      // Group by prio pattern for quick scanning (e.g., P1 · P1 · P1 · P1.5)
      const groups = new Map();
      for (const m of metas){
        const k = m.pat || '—';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(m);
      }
      const groupKeys = Array.from(groups.keys()).sort((a,b)=>{
        // Sort groups by their best avg.
        const ma = groups.get(a)[0]?.avg ?? 9;
        const mb = groups.get(b)[0]?.avg ?? 9;
        if (ma != mb) return ma - mb;
        return String(a).localeCompare(String(b));
      });

      const close = ()=>{
        modal.remove();
        document.removeEventListener('keydown', onKey);
      };
      const onKey = (ev)=>{ if (ev.key === 'Escape') close(); };

            const altLexKey = (alt)=>{
              const parts = (alt?.fights||[]).map(f=>{
                const pair = [f?.aId, f?.bId].filter(Boolean).slice().sort((x,y)=>String(x).localeCompare(String(y))).join('+');
                const defs = (f?.defs||[]).filter(Boolean).slice().sort((x,y)=>String(x).localeCompare(String(y))).join('|');
                return `${pair}@${defs}`;
              }).slice().sort();
              return parts.join('||');
            };

            const applyAlt = (alt)=>{
              close();
              // Apply like Auto x4: clear current log, then simulate chosen fights once.
              clearAllLog();
              store.update(s=>{
                const w = s.wavePlans?.[waveKey];
                if (!w) return;
                ensureWavePlan(data, s, waveKey, slots);
                w.solve = w.solve || {};
                w.solve.alts = Array.isArray(w.solve.alts) ? w.solve.alts : [];
                const k = altLexKey(alt);
                let idx = w.solve.alts.findIndex(a => altLexKey(a) === k);
                if (idx < 0){
                  w.solve.alts.unshift(alt);
                  idx = 0;
                }
                // Keep alt list bounded by the global variation limit.
                if (Array.isArray(w.solve.alts) && w.solve.alts.length > lim){
                  w.solve.alts = w.solve.alts.slice(0, lim);
                  if (idx >= w.solve.alts.length) idx = 0;
                }
                w.solve.idx = idx;

                const chosen = alt;
                if (!chosen) return;
                for (const spec of (chosen.fights||[])){
                  const entry = makeFightEntry(s, w, spec.aId, spec.bId, spec.defs);
                  pushEntry(s, w, entry);
                }
              });
            };

	            const subtitle = bestPatternKey
	              ? (
	                `Best prio combo: ${bestPatternKey}` +
	                (bestTotal ? (` · showing ${alts.length} of ${bestTotal}${bestTrunc ? ' (limited)' : ''}`) : (` · showing ${alts.length}`)) +
	                ` · limit ${lim}` +
	                (genCapped && genCap ? ` · gen cap hit (${genCap})` : '')
	              )
	              : 'Grouped by prio pattern (P1 / P1.5 / …). Click an entry to expand. Choose one to apply it.';

const headLeft = el('div', {}, [
        el('div', {class:'modal-title'}, 'All battle combinations'),
        el('div', {class:'muted small'}, subtitle),
      ]);
      const btnClose = el('button', {class:'btn btn-mini'}, 'Close');
      btnClose.addEventListener('click', close);

      const list = el('div', {class:'alts-list'}, []);

      for (const gk of groupKeys){
        const arr = groups.get(gk) || [];
        const bestAvg = arr[0]?.avg ?? 9;
        const groupHead = el('div', {class:'alts-grouphead'}, [
          el('div', {style:'display:flex; gap:10px; align-items:center; flex-wrap:wrap'}, [
            el('strong', {}, gk),
            pill(`avg ${formatPrioAvg(bestAvg)}`, 'info'),
            el('span', {class:'muted small'}, `${arr.length} alt${arr.length===1?'':'s'}`),
          ]),
        ]);
        list.appendChild(groupHead);

        for (const m of arr){
          const patPills = (m.prios||[]).map(p=>pill(`P${formatPrioAvg(p)}`, 'info'));

          const btnUse = el('button', {class:'btn-mini'}, 'Use');
          btnUse.addEventListener('click', (ev)=>{ ev.preventDefault(); ev.stopPropagation(); applyAlt(m.alt); });

          const sumLeft = el('div', {style:'display:flex; flex-direction:column; gap:6px'}, [
            el('div', {style:'display:flex; gap:8px; align-items:center; flex-wrap:wrap'}, [
              el('strong', {}, `Alt ${m.idx+1}`),
              pill(`avg ${formatPrioAvg(m.avg)}`, 'warn'),
              pill(`worst ${formatPrioAvg(m.max)}`, 'warn'),
            ]),
            el('div', {style:'display:flex; gap:6px; flex-wrap:wrap'}, patPills),
          ]);

          const summary = el('summary', {class:'altcombo-summary'}, [sumLeft, btnUse]);

          const fights = el('div', {class:'altcombo-fights'}, (m.alt?.fights||[]).map((spec, i)=>{
            const a = byId(stBase.roster||[], spec.aId);
            const b = byId(stBase.roster||[], spec.bId);
            const defs = (spec.defs||[]).map((rk, di)=>`#${di+1} ${(slotByKey2.get(rk)?.defender || rk)}`).join(' · ');
            const pr = Number.isFinite(Number(m.entries?.[i]?.prioAvg)) ? formatPrioAvg(m.entries[i].prioAvg) : '—';
            return el('div', {class:'altcombo-fight'}, [
              el('div', {class:'muted small'}, `Fight ${i+1} · prioØ ${pr}`),
              el('div', {class:'small'}, `${rosterLabel(a)} + ${rosterLabel(b)}  →  ${defs}`),
            ]);
          }));

          const details = el('details', {class:'altcombo'}, [summary, fights]);
          list.appendChild(details);
        }
      }

      const modalCard = el('div', {class:'modal-card modal-wide'}, [
        el('div', {class:'modal-head'}, [headLeft, btnClose]),
        el('div', {class:'modal-body'}, [list]),
      ]);

      const modal = el('div', {class:'modal alts-modal', role:'dialog', 'aria-modal':'true'}, [modalCard]);
      modal.addEventListener('click', (ev)=>{ if (ev.target === modal) close(); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(modal);
    };

    viewCombosBtn.addEventListener('click', openCombosModal);
    const controlsRow = el('div', {style:'display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:8px'}, [
      countLabel,
      fightBtn,
      undoBtn,
      auto4Btn,
      viewCombosBtn,
      altHint,
    ]);

    const expandAll = !!(state.ui && state.ui.wavesLogExpandAll);
    const toggleExpandBtn = el('button', {class:'btn-mini'}, expandAll ? 'Collapse all' : 'Expand all');
    toggleExpandBtn.title = 'Toggle expanding all fight log entries';
    toggleExpandBtn.addEventListener('click', ()=>{
      store.update(s=>{
        s.ui = s.ui || {};
        s.ui.wavesLogExpandAll = !s.ui.wavesLogExpandAll;
      });
    });

    const fightHead = el('div', {style:'display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap'}, [
      el('div', {class:'panel-title', style:'margin-bottom:0'}, 'Fight log'),
      toggleExpandBtn,
    ]);

    const fightPanel = el('div', {class:'panel fightlog-panel'}, [
      fightHead,
      el('div', {class:'muted small', style:'margin-top:6px'}, 'Sorted by prioØ (best first). Click an entry to expand.'),
    ]);
    fightPanel.appendChild(controlsRow);

    const fightLog = (wp.fightLog||[]);
    const fightLogView = fightLog.slice().sort((a,b)=>{
      const ap = Number.isFinite(Number(a?.prioAvg)) ? Number(a.prioAvg) : 9;
      const bp = Number.isFinite(Number(b?.prioAvg)) ? Number(b.prioAvg) : 9;
      if (ap !== bp) return ap - bp;
      return Number(a?.ts||0) - Number(b?.ts||0);
    });
    if (fightLogView.length){
      const list = el('div', {class:'fightlog-list'}, []);
      for (const e of fightLogView){
        const pr = `prioØ ${formatPrioAvg(e.prioAvg)}`;

        const sumLeft = el('div', {class:'fightlog-sumleft'}, [
          el('div', {class:'fightlog-prio'}, pr),
          (e.summary ? el('div', {class:'muted small'}, e.summary) : null),
        ].filter(Boolean));

        const undoEntryBtn = el('button', {class:'btn-mini'}, 'Undo');
        undoEntryBtn.addEventListener('click', (ev)=>{
          ev.preventDefault();
          ev.stopPropagation();
          undoEntryById(e.id);
        });

        const summary = el('summary', {class:'fightlog-summary'}, [sumLeft, undoEntryBtn]);
        const lines = el('div', {class:'muted small fightlog-lines'}, (e.lines||[]).map(t=>el('div', {class:'battle-log-line'}, t)));

        const details = el('details', {class:'fightlog-entry'}, [summary, lines]);
        if (expandAll) details.open = true;
        list.appendChild(details);
      }
      fightPanel.appendChild(list);
    } else {
      fightPanel.appendChild(el('div', {class:'muted small', style:'margin-top:8px'}, 'No fights yet.'));
    }

// Suggested lead pairs
    const suggWrap = el('div', {class:'panel'}, [
      el('div', {class:'panel-title'}, 'Suggested lead pairs'),
    ]);

    const suggList = el('div', {class:'suggestions'});
    const atkMons = activeRoster.map(r=>r).filter(Boolean);
    const defStarters = (wp.defenderStart||[]).slice(0,2).map(k=>slotByKey2.get(baseDefKey(k))).filter(Boolean);
    const d0 = defStarters[0];
    const d1 = defStarters[1];

    if (atkMons.length >= 2 && d0 && d1){
      const pairs = [];
      for (let i=0;i<atkMons.length;i++){
        for (let j=i+1;j<atkMons.length;j++){
          const a = atkMons[i];
          const b = atkMons[j];

          const defLeft = {species:d0.defender, level:d0.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
          const defRight = {species:d1.defender, level:d1.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};

          // Targeting assumption: either starter can hit either lead defender.
          const bestA0 = calc.chooseBestMove({
            data,
            attacker:{species:(a.effectiveSpecies||a.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: a.strength?state.settings.strengthEV:state.settings.claimedEV},
            defender:defLeft,
            movePool: ((wp && wp.attackMoveOverride && wp.attackMoveOverride[a.id]) ? (a.movePool||[]).filter(m=>m && m.use !== false && m.name === wp.attackMoveOverride[a.id]) : (a.movePool||[])),
            settings: settingsForWave(state, wp, a.id, d0.rowKey),
            tags: d0.tags||[],
          }).best;
          const bestA1 = calc.chooseBestMove({
            data,
            attacker:{species:(a.effectiveSpecies||a.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: a.strength?state.settings.strengthEV:state.settings.claimedEV},
            defender:defRight,
            movePool: ((wp && wp.attackMoveOverride && wp.attackMoveOverride[a.id]) ? (a.movePool||[]).filter(m=>m && m.use !== false && m.name === wp.attackMoveOverride[a.id]) : (a.movePool||[])),
            settings: settingsForWave(state, wp, a.id, d1.rowKey),
            tags: d1.tags||[],
          }).best;
          const bestB0 = calc.chooseBestMove({
            data,
            attacker:{species:(b.effectiveSpecies||b.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: b.strength?state.settings.strengthEV:state.settings.claimedEV},
            defender:defLeft,
            movePool: ((wp && wp.attackMoveOverride && wp.attackMoveOverride[b.id]) ? (b.movePool||[]).filter(m=>m && m.use !== false && m.name === wp.attackMoveOverride[b.id]) : (b.movePool||[])),
            settings: settingsForWave(state, wp, b.id, d0.rowKey),
            tags: d0.tags||[],
          }).best;
          const bestB1 = calc.chooseBestMove({
            data,
            attacker:{species:(b.effectiveSpecies||b.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: b.strength?state.settings.strengthEV:state.settings.claimedEV},
            defender:defRight,
            movePool: ((wp && wp.attackMoveOverride && wp.attackMoveOverride[b.id]) ? (b.movePool||[]).filter(m=>m && m.use !== false && m.name === wp.attackMoveOverride[b.id]) : (b.movePool||[])),
            settings: settingsForWave(state, wp, b.id, d1.rowKey),
            tags: d1.tags||[],
          }).best;

          const tuple = (m0,m1)=>{
            const bothOhko = (m0?.oneShot && m1?.oneShot) ? 2 : ((m0?.oneShot || m1?.oneShot) ? 1 : 0);
            const worstPrio = Math.max(m0?.prio ?? 9, m1?.prio ?? 9);
            const prioAvg = ((m0?.prio ?? 9) + (m1?.prio ?? 9)) / 2;
            const overkill = Math.abs((m0?.minPct ?? 0) - 100) + Math.abs((m1?.minPct ?? 0) - 100);
            return {bothOhko, worstPrio, prioAvg, overkill};
          };
          const t1 = tuple(bestA0, bestB1);
          const t2 = tuple(bestA1, bestB0);
          const better = (x,y)=>{
            if (x.bothOhko !== y.bothOhko) return x.bothOhko > y.bothOhko;
            if (x.worstPrio !== y.worstPrio) return x.worstPrio < y.worstPrio;
            if (x.prioAvg !== y.prioAvg) return x.prioAvg < y.prioAvg;
            return x.overkill <= y.overkill;
          };
          const lead = better(t1,t2) ? t1 : t2;

          const ohkoPairs = lead.bothOhko;
          const prioAvg = lead.prioAvg;
          let clearAll = 0;
          for (const ds of allDef){
            const defObj = {species:ds.defender, level:ds.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
            const b0 = calc.chooseBestMove({data, attacker:{species:(a.effectiveSpecies||a.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: a.strength?state.settings.strengthEV:state.settings.claimedEV}, defender:defObj, movePool: ((wp && wp.attackMoveOverride && wp.attackMoveOverride[a.id]) ? (a.movePool||[]).filter(m=>m && m.use !== false && m.name === wp.attackMoveOverride[a.id]) : (a.movePool||[])), settings: settingsForWave(state, wp, a.id, ds.rowKey), tags: ds.tags||[]}).best;
            const b1 = calc.chooseBestMove({data, attacker:{species:(b.effectiveSpecies||b.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: b.strength?state.settings.strengthEV:state.settings.claimedEV}, defender:defObj, movePool: ((wp && wp.attackMoveOverride && wp.attackMoveOverride[b.id]) ? (b.movePool||[]).filter(m=>m && m.use !== false && m.name === wp.attackMoveOverride[b.id]) : (b.movePool||[])), settings: settingsForWave(state, wp, b.id, ds.rowKey), tags: ds.tags||[]}).best;
            if ((b0 && b0.oneShot) || (b1 && b1.oneShot)) clearAll += 1;
          }

          pairs.push({a,b, ohkoPairs, prioAvg, clearAll});
        }
      }

      pairs.sort((x,y)=>{
        if (x.clearAll !== y.clearAll) return y.clearAll - x.clearAll;
        if (x.ohkoPairs !== y.ohkoPairs) return y.ohkoPairs - x.ohkoPairs;
        return x.prioAvg - y.prioAvg;
      });

      for (const p of pairs.slice(0,12)){
        const chipEl = el('div', {class:'chip'}, [
          el('strong', {}, `${rosterLabel(p.a)} + ${rosterLabel(p.b)}`),
          el('span', {class:'muted'}, ` · OHKO ${p.ohkoPairs}/2`),
          el('span', {class:'muted'}, ` · clear ${p.clearAll}/${allDef.length}`),
          el('span', {class:'muted'}, ` · prioØ ${formatPrioAvg(p.prioAvg)}`),
        ]);
        chipEl.addEventListener('click', ()=>{
          store.update(st=>{
            const w = st.wavePlans[waveKey];
            w.attackerStart = [p.a.id, p.b.id];
            w.attackerOrder = [p.a.id, p.b.id];
            w.manualStarters = true;
            w.manualOrder = false;
            ensureWavePlan(data, st, waveKey, slots);
          });
        });
        suggList.appendChild(chipEl);
      }
    } else {
      suggList.appendChild(el('div', {class:'muted small'}, 'Need at least 2 ACTIVE roster mons and 2 selected defenders to see suggestions.'));
    }

    
    suggWrap.appendChild(suggList);

    const enemyListPanel = el('div', {class:'panel'}, [
      el('div', {class:'panel-title'}, `Enemies (Phase ${phase})`),
      enemyList,
    ]);

    // Layout: decouple the right side from the left column height.
    // Left column stacks (Selected enemies + Enemies list). Right side is its own grid:
    // Row 1: Fight plan (mid) + Suggested lead pairs (right)
    // Row 2: Fight log spanning both.
    const leftCol = el('div', {class:'planner-stack planner-left'}, [
      slotControls,
      enemyListPanel,
    ]);

    const midCol = el('div', {class:'planner-stack planner-mid'}, [planEl]);
    const rightCol = el('div', {class:'planner-stack planner-right'}, [suggWrap]);
    const logCol = el('div', {class:'planner-stack planner-log'}, [fightPanel]);

    const rightGrid = el('div', {class:'planner-rightgrid'}, [
      midCol,
      rightCol,
      logCol,
    ]);

    return el('div', {class:'wave-planner'}, [
      el('div', {class:'planner-outer'}, [
        leftCol,
        rightGrid,
      ]),
    ]);
}

  // ---------------- Bag ----------------

  function renderBag(state){
    tabBag.innerHTML = '';

    const used0 = computeRosterUsage(state);
    const bag = state.bag || {};
    const bagNames = Object.keys(bag).sort((a,b)=>a.localeCompare(b));

    const isPlate = (n)=> typeof n === 'string' && n.endsWith(' Plate');
    const isGem = (n)=> typeof n === 'string' && n.endsWith(' Gem');
    const isCharm = (n)=> n === 'Evo Charm' || n === 'Strength Charm';

    // Shop state
    const shop = state.shop || {gold:0, ledger:[]};
    const gold = Math.max(0, Math.floor(Number(shop.gold||0)));
    const ledger = Array.isArray(shop.ledger) ? shop.ledger : [];

    const canUseItem = (name)=>{
      // "Use" = consume 1 from bag (undoable). For held items, we also clear it from one current holder.
      if (!name) return false;
      if (isCharm(name)) return false;
      return true;
    };

    const bagPanel = el('div', {class:'panel'}, [
      el('div', {style:'display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap'}, [
        el('div', {}, [
          el('div', {class:'panel-title'}, 'Bag'),
          el('div', {class:'muted small'}, 'Shared team bag. Wave loot adds here. Charms + held items consume from shared totals.'),
        ]),
        el('div', {style:'display:flex; align-items:center; gap:10px; flex-wrap:wrap'}, [
          el('div', {class:'shop-balance'}, ['Gold: ', el('span', {class:'pill good'}, String(gold))]),
          (function(){
            const b = el('button', {class:'btn-mini', disabled: ledger.length===0}, 'Undo');
            b.title = 'Undo last shop/bag action (buy/sell/use)';
            b.addEventListener('click', ()=>{
              store.update(s=>{
                s.shop = s.shop || {gold:0, ledger:[]};
                const led = Array.isArray(s.shop.ledger) ? s.shop.ledger : (s.shop.ledger=[]);
                const tx = led.pop();
                if (!tx) return;

                // Undo gold
                s.shop.gold = Math.max(0, Math.floor(Number(s.shop.gold||0) - Number(tx.goldDelta||0)));

                // Undo bag delta
                s.bag = s.bag || {};
                const item = String(tx.item||'');
                const qty = Math.max(1, Number(tx.qty||1));
                let inv = 0;
                if (tx.type === 'buy') inv = -qty;
                else if (tx.type === 'sell' || tx.type === 'use') inv = +qty;

                if (item && inv !== 0){
                  const cur = Number(s.bag[item]||0);
                  const next = cur + inv;
                  if (next <= 0) delete s.bag[item];
                  else s.bag[item] = next;
                }

                // Restore roster items cleared by a "use" action
                if (Array.isArray(tx.rosterRestore)){
                  for (const rr of tx.rosterRestore){
                    const mon = byId(s.roster||[], rr.id);
                    if (!mon) continue;
                    if (!mon.item) mon.item = rr.prevItem || null;
                  }
                }

                enforceBagConstraints(data, s, applyCharmRulesSync);
              });
            });
            return b;
          })(),
        ]),
      ]),
    ]);

    // Bag table
    const tbl = el('table', {class:'bag-table', style:'margin-top:10px'}, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, 'Item'),
        el('th', {}, 'Total'),
        el('th', {}, 'Used'),
        el('th', {}, 'Avail'),
        el('th', {}, 'Use'),
        el('th', {}, 'Sell'),
      ])),
      el('tbody'),
    ]);

    const tbody = tbl.querySelector('tbody');

    const sections = [
      {title:'Charms', filter:isCharm},
      {title:'Hold items', filter:(n)=>!isCharm(n) && !isPlate(n) && !isGem(n)},
      {title:'Plates', filter:isPlate},
      {title:'Gems', filter:isGem},
    ];

    const addSectionRow = (title)=>{
      tbody.appendChild(el('tr', {}, [
        el('td', {colspan:'6', class:'muted small', style:'padding-top:14px; font-weight:900; letter-spacing:.02em;'}, title),
      ]));
    };

    const makeItemRow = (name)=>{
      const qty = Number(state.bag?.[name]) || 0;
      const u = Number(used0[name]||0);
      const avail = qty - u;
      const price = priceOfItem(name);

      const useBtn = el('button', {class:'btn-mini'}, 'Use 1');
      useBtn.disabled = (!canUseItem(name) || qty <= 0);
      useBtn.title = canUseItem(name)
        ? 'Consume 1 from Bag (undoable). If equipped, clears it from one holder.'
        : 'Not usable';

      useBtn.addEventListener('click', ()=>{
        if (!canUseItem(name)) return;
        store.update(s=>{
          s.bag = s.bag || {};
          const have = Number(s.bag?.[name]||0);
          if (have <= 0) return;

          // If equipped anywhere, clear from ONE holder so we don't keep a ghost-equipped item.
          const rosterRestore = [];
          const holder = (s.roster||[]).find(r=>r && r.item === name);
          if (holder){
            rosterRestore.push({id: holder.id, prevItem: name});
            holder.item = null;
          }

          const next = have - 1;
          if (next <= 0) delete s.bag[name];
          else s.bag[name] = next;

          s.shop = s.shop || {gold:0, ledger:[]};
          s.shop.ledger = Array.isArray(s.shop.ledger) ? s.shop.ledger : [];
          s.shop.ledger.push({ts:Date.now(), type:'use', item:name, qty:1, goldDelta:0, rosterRestore});
          if (s.shop.ledger.length > 80) s.shop.ledger.splice(0, s.shop.ledger.length - 80);

          enforceBagConstraints(data, s, applyCharmRulesSync);
        });
      });

      const sellBtn = el('button', {class:'btn-mini'}, 'Sell 1');
      sellBtn.disabled = !(price > 0) || avail <= 0;
      sellBtn.title = (price > 0) ? `${price} gold (only AVAILABLE can be sold)` : 'Not sellable';

      sellBtn.addEventListener('click', ()=>{
        if (!(price > 0)) return;
        store.update(s=>{
          s.bag = s.bag || {};
          const used2 = computeRosterUsage(s);
          const have = Number(s.bag?.[name]||0);
          const u2 = Number(used2?.[name]||0);
          const a2 = have - u2;
          if (a2 <= 0) return;

          const next = have - 1;
          if (next <= 0) delete s.bag[name];
          else s.bag[name] = next;

          s.shop = s.shop || {gold:0, ledger:[]};
          s.shop.gold = Math.max(0, Math.floor(Number(s.shop.gold||0) + price));
          s.shop.ledger = Array.isArray(s.shop.ledger) ? s.shop.ledger : [];
          s.shop.ledger.push({ts:Date.now(), type:'sell', item:name, qty:1, goldDelta:+price});
          if (s.shop.ledger.length > 80) s.shop.ledger.splice(0, s.shop.ledger.length - 80);

          enforceBagConstraints(data, s, applyCharmRulesSync);
        });
      });

      return el('tr', {}, [
        el('td', {}, name),
        el('td', {style:'text-align:right'}, String(qty)),
        el('td', {style:'text-align:right'}, String(u)),
        el('td', {style:'text-align:right'}, el('span', {class: avail < 0 ? 'pill bad' : 'pill good'}, avail < 0 ? `-${Math.abs(avail)}` : String(avail))),
        el('td', {style:'text-align:right'}, useBtn),
        el('td', {style:'text-align:right'}, sellBtn),
      ]);
    };

    if (!bagNames.length){
      tbody.appendChild(el('tr', {}, [
        el('td', {colspan:'6', class:'muted'}, 'No items yet.'),
      ]));
    } else {
      for (const sec of sections){
        const list = bagNames.filter(sec.filter);
        if (!list.length) continue;
        addSectionRow(sec.title);
        for (const n of list){
          tbody.appendChild(makeItemRow(n));
        }
      }
    }

    bagPanel.appendChild(tbl);

    
    // Politoed shop (buy)
    const shopPanel = el('div', {class:'panel', style:'margin-top:12px'}, [
      el('div', {class:'panel-title'}, "Politoed's Shop"),
      el('div', {class:'muted small'}, 'Shop sells Plates as singles, Gems as bundles (x5), and Rare Candy as a bundle (x1/x2/x3). Selling via the table above is always 1 unit. Coins are loot-only.'),
    ]);

    const buyOfferFor = (itemName)=> buyOffer(itemName);

    const doBuyOffer = (off)=>{
      if (!off) return;
      store.update(s=>{
        s.shop = s.shop || {gold:0, ledger:[]};
        const g = Math.max(0, Math.floor(Number(s.shop.gold||0)));
        const cost = Math.max(0, Math.floor(Number(off.cost||0)));
        const qty = Math.max(1, Math.floor(Number(off.qty||1)));
        if (!(cost > 0)) return;
        if (g < cost){
          alert('Not enough gold.');
          return;
        }

        s.shop.gold = g - cost;
        s.shop.ledger = Array.isArray(s.shop.ledger) ? s.shop.ledger : [];
        s.shop.ledger.push({ts:Date.now(), type:'buy', item:off.item, qty, goldDelta:-cost});
        if (s.shop.ledger.length > 80) s.shop.ledger.splice(0, s.shop.ledger.length - 80);

        s.bag = s.bag || {};
        const k = normalizeBagKey ? normalizeBagKey(off.item) : off.item;
        s.bag[k] = Number(s.bag[k]||0) + qty;

        // keep wallet in sync if it exists
        if (s.wallet && typeof s.wallet === 'object'){
          s.wallet.gold = Math.max(0, Math.floor(Number(s.shop.gold||0)));
        }

        enforceBagConstraints(data, s, applyCharmRulesSync);
      });
    };

    const doBuy = (itemName)=>{
      const off = buyOfferFor(itemName);
      if (!off) return;
      doBuyOffer(off);
    };

    const grid = el('div', {class:'shop-grid'});

    // --- Smart selectors (reduce 80+ variations) ---

    // Gems (bundle x5)
    (function(){
      const sel = el('select', {class:'sel-mini'}, TYPES_NO_FAIRY.map(t=> el('option', {value:t}, t)));
      const getItem = ()=> gemName(sel.value);
      const buyBtn = el('button', {class:'btn-mini'}, 'Buy');
      const priceLine = el('div', {class:'shop-price'});

      const sync = ()=>{
        const off = buyOfferFor(getItem());
        const can = off && (gold >= (off.cost||0));
        buyBtn.disabled = !can;
        priceLine.textContent = off ? `price: ${off.cost}g · +${off.qty}` : 'price: —';
      };
      sel.addEventListener('change', sync);
      buyBtn.addEventListener('click', ()=> doBuy(getItem()));
      sync();

      grid.appendChild(el('div', {class:'shop-card'}, [
        el('div', {class:'shop-meta'}, [
          el('div', {class:'shop-name'}, ['Gem (x5) · ', sel]),
          priceLine,
        ]),
        buyBtn,
      ]));
    })();

    // Plates (single)
    (function(){
      const sel = el('select', {class:'sel-mini'}, TYPES_NO_FAIRY.map(t=> el('option', {value:t}, t)));
      const getItem = ()=> plateName(sel.value);
      const buyBtn = el('button', {class:'btn-mini'}, 'Buy');
      const priceLine = el('div', {class:'shop-price'});

      const sync = ()=>{
        const off = buyOfferFor(getItem());
        const can = off && (gold >= (off.cost||0));
        buyBtn.disabled = !can;
        priceLine.textContent = off ? `price: ${off.cost}g` : 'price: —';
      };
      sel.addEventListener('change', sync);
      buyBtn.addEventListener('click', ()=> doBuy(getItem()));
      sync();

      grid.appendChild(el('div', {class:'shop-card'}, [
        el('div', {class:'shop-meta'}, [
          el('div', {class:'shop-name'}, ['Plate · ', sel]),
          priceLine,
        ]),
        buyBtn,
      ]));
    })();

    // Rare Candy (x1/x2/x3)
    (function(){
      const sel = el('select', {class:'sel-mini'}, [1,2,3].map(n=> el('option', {value:String(n)}, `x${n}`)));
      const buyBtn = el('button', {class:'btn-mini'}, 'Buy');
      const priceLine = el('div', {class:'shop-price'});

      const sync = ()=>{
        const qty = Number(sel.value||1);
        const cost = qty * 16;
        buyBtn.disabled = gold < cost;
        priceLine.textContent = `price: ${cost}g · +${qty}`;
      };
      sel.addEventListener('change', sync);
      buyBtn.addEventListener('click', ()=>{
        const qty = Number(sel.value||1);
        const cost = qty * 16;
        doBuyOffer({item:'Rare Candy', qty, cost, label:`Rare Candy x${qty}`});
      });
      sync();

      grid.appendChild(el('div', {class:'shop-card'}, [
        el('div', {class:'shop-meta'}, [
          el('div', {class:'shop-name'}, ['Rare Candy · ', sel]),
          priceLine,
        ]),
        buyBtn,
      ]));
    })();

    // --- Remaining singles (no type variations) ---
    const shopSingles = uniq(ITEM_CATALOG
      .map(n=>lootBundle(n))
      .filter(Boolean)
      .map(b=>b.key)
      .filter(Boolean)
    )
      .filter(n=>!isGem(n) && !isPlate(n))
      .filter(n=>n !== 'Copper Coin')
      .filter(n=>n !== 'Air Balloon')
      .filter(n=>n !== 'Rare Candy')
      .filter(n=>!!buyOfferFor(n))
      .sort((a,b)=>a.localeCompare(b));

    for (const name of shopSingles){
      const off = buyOfferFor(name);
      if (!off) continue;
      const buyBtn = el('button', {class:'btn-mini'}, 'Buy');
      if (gold < (off.cost||0)) buyBtn.disabled = true;
      buyBtn.addEventListener('click', ()=> doBuy(name));
      grid.appendChild(el('div', {class:'shop-card'}, [
        el('div', {class:'shop-meta'}, [
          el('div', {class:'shop-name'}, name),
          el('div', {class:'shop-price'}, `price: ${off.cost}g${(off.qty||1) > 1 ? ` · +${off.qty}` : ''}`),
        ]),
        buyBtn,
      ]));
    }

    shopPanel.appendChild(grid);
// Recent transactions (compact)
    const recent = ledger.slice(-10).reverse();
    const ledgerBox = el('div', {class:'shop-ledger'}, []);
    if (!recent.length){
      ledgerBox.appendChild(el('div', {class:'muted small'}, 'No transactions yet.'));
    } else {
      for (const tx of recent){
        const sign = tx.goldDelta >= 0 ? '+' : '';
        ledgerBox.appendChild(el('div', {class:'shop-ledger-row'}, `${tx.type.toUpperCase()} ${tx.item} x${tx.qty} (${sign}${tx.goldDelta}g)`));
      }
    }
    shopPanel.appendChild(el('div', {class:'panel-subtitle', style:'margin-top:12px'}, 'Recent transactions'));
    shopPanel.appendChild(ledgerBox);

    tabBag.appendChild(el('div', {}, [bagPanel, shopPanel]));
  }

  // ---------------- Roster ----------------

  function openAddRosterModal(state){
    const unlockedSpecies = Object.keys(state.unlocked).filter(k=>state.unlocked[k]).sort((a,b)=>a.localeCompare(b));
    const existing = new Set(state.roster.map(r=>r.baseSpecies));
    const candidates = unlockedSpecies.filter(s=>!existing.has(s));
    const pendingBases = new Set();

    const overlay = el('div', {style:`position:fixed; inset:0; background: rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; z-index:1000;`});
    const modal = el('div', {class:'panel', style:'width:820px; max-width:95vw; max-height:85vh; overflow:hidden'}, [
      el('div', {style:'display:flex; align-items:center; justify-content:space-between; gap:10px'}, [
        el('div', {class:'panel-title'}, 'Add to roster (from unlocked)'),
        el('button', {class:'btn-mini'}, 'Close'),
      ]),
      el('div', {class:'field'}, [
        el('label', {}, 'Search'),
        el('input', {type:'text', id:'addSearch', placeholder:'Search species…'}),
      ]),
      el('div', {class:'list', style:'max-height:60vh'}, [
        el('div', {class:'list-body', id:'addList', style:'max-height:60vh'}),
      ]),
      el('div', {class:'muted small'}, 'Tip: Evolutions inherit the base form\'s set automatically unless you explicitly override them.'),
    ]);

    modal.querySelector('button').addEventListener('click', ()=> overlay.remove());
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const listBody = $('#addList', modal);
    const search = $('#addSearch', modal);

    function render(){
      listBody.innerHTML = '';
      const q = search.value.toLowerCase().trim();
      const rows = candidates.filter(s => !q || s.toLowerCase().includes(q));
      for (const sp of rows){
        const img = el('img', {class:'sprite', src:sprite(calc, sp), alt:sp});
        img.onerror = ()=> img.style.opacity='0.25';

        const stNow = store.getState();
        const base = pokeApi.baseOfSync(sp, stNow.baseCache||{});
        const cs = data.claimedSets?.[sp] || data.claimedSets?.[base] || null;
        const inheritedFrom = (!data.claimedSets?.[sp] && cs && base && base !== sp) ? base : null;

        // If we don't have a base mapping yet, resolve it in the background for better inheritance.
        if (!data.claimedSets?.[sp] && (!base || base === sp) && !pendingBases.has(sp)){
          pendingBases.add(sp);
          pokeApi.resolveBaseNonBaby(sp, stNow.baseCache||{})
            .then(({base:resolved, updates})=>{
              store.update(st=>{
                st.baseCache = {...(st.baseCache||{}), ...(updates||{})};
              });
              // Re-render once cache updated.
              try{ render(); }catch{}
            })
            .catch(()=>{ pendingBases.delete(sp); });
        }

        const btn = el('button', {class:'btn-mini'}, 'Add');
        if (!cs) btn.disabled = true;

        btn.addEventListener('click', ()=>{
          if (!cs) return;
          store.update(s=>{
            const base2 = pokeApi.baseOfSync(sp, s.baseCache||{});
            const entry = makeRosterEntryFromClaimedSetWithFallback(data, sp, base2);
            normalizeMovePool(entry);
            s.roster.push(entry);
            s.unlocked[sp] = true;
            s.ui.selectedRosterId = entry.id;
            const res = applyCharmRulesSync(data, s, entry);
            if (res.needsEvoResolve && res.evoBase){
              pokeApi.resolveEvoTarget(res.evoBase, s.evoCache||{})
                .then(({target, updates})=>{
                  store.update(st=>{
                    st.evoCache = {...(st.evoCache||{}), ...(updates||{})};
                    const cur = byId(st.roster, entry.id);
                    if (cur && cur.evo) cur.effectiveSpecies = target || cur.baseSpecies;
                  });
                })
                .catch(()=>{});
            }
          });
          overlay.remove();
        });

        const sub = cs
          ? `Ability: ${cs.ability || '—'} · Moves: ${(cs.moves||[]).slice(0,4).join(', ')}${inheritedFrom ? ` (inherit: ${inheritedFrom})` : ''}`
          : 'No baseline set yet (add it to ClaimedSets).';

        listBody.appendChild(el('div', {class:'row'}, [
          el('div', {class:'row-left'}, [
            img,
            el('div', {}, [
              el('div', {class:'row-title'}, sp),
              el('div', {class:'row-sub'}, sub),
            ]),
          ]),
          el('div', {class:'row-right'}, [btn]),
        ]));
      }
      if (!rows.length){
        listBody.appendChild(el('div', {class:'row'}, el('div', {class:'muted'}, 'No matches.')));
      }
    }

    search.addEventListener('input', render);
    render();
  }

  function renderRosterDetails(state, r, container){
    container.innerHTML = '';
    const eff = r.effectiveSpecies || r.baseSpecies;

    const spImg = el('img', {class:'sprite sprite-lg', src:sprite(calc, eff), alt:eff});
    spImg.onerror = ()=> spImg.style.opacity = '0.25';

    const openDex = ()=>{
      const base = r.baseSpecies;
      store.update(s=>{
        s.ui.tab = 'unlocked';
        // Remember where we came from so the Dex back button can return.
        s.ui.dexReturnTab = 'roster';
        s.ui.lastNonDexTab = 'roster';
        s.ui.dexReturnRosterId = r.id;
        s.ui.dexDetailBase = base;
        s.ui.dexSelectedForm = base;
      });
      pokeApi.resolveEvoLine(base, store.getState().baseCache||{})
        .then(({base:resolved, line, updates})=>{
          store.update(st=>{
            st.baseCache = {...(st.baseCache||{}), ...(updates||{})};
            st.evoLineCache = st.evoLineCache || {};
            st.evoLineCache[resolved] = Array.isArray(line) && line.length ? line : [resolved];
            if (st.ui.dexDetailBase === base) st.ui.dexDetailBase = resolved;
            if (!st.ui.dexSelectedForm || st.ui.dexSelectedForm === base) st.ui.dexSelectedForm = resolved;
          });
        })
        .catch(()=>{});
    };

    spImg.addEventListener('click', openDex);

    const dexBtn = el('button', {class:'btn-mini'}, 'Dex');
    dexBtn.addEventListener('click', openDex);

    const removeBtn = el('button', {class:'btn-mini btn-danger'}, 'Remove');

    const title = el('div', {style:'display:flex; align-items:center; justify-content:space-between; gap:10px'}, [
      el('div', {style:'display:flex; align-items:center; gap:12px'}, [
        spImg,
        el('div', {}, [
          el('div', {class:'ov-title'}, rosterLabel(r)),
          el('div', {class:'muted small'}, `Ability: ${r.ability || '—'} · Moves: ${(r.movePool||[]).length}`),
        ]),
      ]),
      el('div', {style:'display:flex; gap:8px; align-items:center'}, [
        dexBtn,
        removeBtn,
      ]),
    ]);

    removeBtn.addEventListener('click', ()=>{
      if (!confirm(`Remove ${rosterLabel(r)} from roster?`)) return;
      store.update(s=>{
        const removedId = r.id;
        s.roster = s.roster.filter(x=>x.id !== removedId);
        if (s.ui.selectedRosterId === removedId) s.ui.selectedRosterId = s.roster[0]?.id || null;

        // Clean up wave plans that referenced this roster mon
        const waves = groupBy(data.calcSlots, x => x.waveKey);
        for (const [wk, wp] of Object.entries(s.wavePlans||{})){
          if (!wp) continue;
          wp.attackers = (wp.attackers||[]).filter(id=>id!==removedId);
          wp.attackerStart = (wp.attackerStart||[]).filter(id=>id!==removedId);
          wp.attackerOrder = (wp.attackerOrder||[]).filter(id=>id!==removedId);
          if (wp.monMods?.atk) delete wp.monMods.atk[removedId];
          // Re-normalize with current slots (fills starters if needed)
          const slots = waves[wk];
          if (slots) ensureWavePlan(data, s, wk, slots);
        }
      });
    });

    const starter = isStarterSpecies(r.baseSpecies);
    const evoAvail = availableCount(state, 'Evo Charm') + (r.evo ? 1 : 0);
    // Starters: Strength is forced/free (does not consume bag), so availability gating is only for non-starters.
    const strAvail = starter ? 9999 : (availableCount(state, 'Strength Charm') + (r.strength ? 1 : 0));

    const charms = el('div', {}, [
      el('div', {class:'panel-subtitle'}, 'Charms (consume from shared Bag)'),
      el('label', {class:'check'}, [
        el('input', {type:'checkbox', checked: !!r.evo, disabled: (starter || (!r.evo && evoAvail <= 0)), 'data-charm':'evo'}),
        el('span', {}, starter
          ? 'Evo (unavailable for starters)'
          : `Evo (auto) — available: ${Math.max(0, evoAvail)}`),
      ]),
      el('label', {class:'check'}, [
        el('input', {type:'checkbox', checked: !!r.strength || starter, disabled: (starter || (!r.strength && strAvail <= 0)), 'data-charm':'str'}),
        el('span', {}, starter
          ? `Strength (forced for starters) — EVs=${state.settings.strengthEV} all`
          : `Strength (EVs=${state.settings.strengthEV} all) — available: ${Math.max(0, strAvail)}`),
      ]),
    ]);

    const evoChk = charms.querySelector('input[data-charm="evo"]');
    const strChk = charms.querySelector('input[data-charm="str"]');

    if (evoChk){
      evoChk.addEventListener('change', ()=>{
        const want = !!evoChk.checked;
        if (want){
          const st = store.getState();
          const cur = byId(st.roster, r.id);
          if (cur && !cur.evo && availableCount(st, 'Evo Charm') <= 0){
            alert('No Evo Charms available in the shared Bag.');
            evoChk.checked = false;
            return;
          }
        }
        store.update(s=>{
          const cur = byId(s.roster, r.id);
          if (!cur) return;
          cur.evo = want;
          const res = applyCharmRulesSync(data, s, cur);
          if (res.needsEvoResolve && res.evoBase){
            pokeApi.resolveEvoTarget(res.evoBase, s.evoCache||{})
              .then(({target, updates})=>{
                store.update(st=>{
                  st.evoCache = {...(st.evoCache||{}), ...(updates||{})};
                  const rr = byId(st.roster, r.id);
                  if (rr && rr.evo) rr.effectiveSpecies = target || rr.baseSpecies;
                });
              })
              .catch(()=>{});
          }
        });
      });
    }

    // Starters: Strength is forced ON.
    if (!starter) strChk?.addEventListener('change', ()=>{
      const want = !!strChk.checked;
      if (want){
        const st = store.getState();
        const cur = byId(st.roster, r.id);
        if (cur && !cur.strength && availableCount(st, 'Strength Charm') <= 0){
          alert('No Strength Charms available in the shared Bag.');
          strChk.checked = false;
          return;
        }
      }
      store.update(s=>{
        const cur = byId(s.roster, r.id);
        if (!cur) return;
        cur.strength = want;
        // Charm rules may affect effectiveSpecies for evo
        applyCharmRulesSync(data, s, cur);
      });
    });

    // Held item
    const itemSec = el('div', {}, [
      el('div', {class:'panel-subtitle'}, 'Held item'),
      el('div', {class:'muted small'}, 'Held items consume from the shared Bag totals. If none are available, they cannot be equipped.'),
      (function(){
        const used = computeRosterUsage(state);
        const bagNames = Object.keys(state.bag||{}).sort((a,b)=>a.localeCompare(b));
        const sel = el('select', {}, [
          el('option', {value:''}, '— none —'),
          ...bagNames.map(n=>{
            const total = Number(state.bag[n]||0);
            const u = Number(used[n]||0);
            const avail = total - u + (r.item === n ? 1 : 0);
            const label = `${n} (avail ${Math.max(0, avail)}/${total})`;
            return el('option', {value:n, selected:r.item===n, disabled: (!r.item || r.item!==n) && avail<=0}, label);
          }),
        ]);
        sel.addEventListener('change', ()=>{
          const v = sel.value || null;
          if (v){
            const st = store.getState();
            const cur = byId(st.roster, r.id);
            if (cur && cur.item !== v && availableCount(st, v) <= 0){
              alert('That item is not available in the shared Bag.');
              sel.value = cur.item || '';
              return;
            }
          }
          store.update(s=>{
            const cur = byId(s.roster, r.id);
            if (cur) cur.item = v;
          });
        });
        return el('div', {class:'field'}, [sel]);
      })(),
    ]);

    // Global battle modifiers (apply in every wave)
    const mods = r.mods || {};
    const stageSelect = (cur, onChange)=>{
      const sel = el('select', {class:'sel-mini'}, Array.from({length:13}).map((_,i)=>{
        const v = i-6;
        return el('option', {value:String(v), selected:Number(cur||0)===v}, (v>=0?`+${v}`:`${v}`));
      }));
      sel.addEventListener('change', ()=> onChange(Number(sel.value)||0));
      return sel;
    };
    const hpInput = (cur, onChange)=>{
      const inp = el('input', {type:'number', min:'1', max:'100', step:'1', value:String(cur ?? 100), class:'inp-mini'});
      inp.addEventListener('change', ()=> onChange(clampInt(inp.value,1,100)));
      return inp;
    };
    const modChip = (label, node)=> el('div', {class:'modchip'}, [el('span', {class:'lbl'}, label), node]);

    const modsSec = el('div', {}, [
      el('div', {class:'panel-subtitle'}, 'Battle modifiers (global)'),
      el('div', {class:'muted small'}, 'Applies to this roster mon in every wave. Defender modifiers (enemy HP/stages) are set per-wave in the wave planner.'),
    ]);

    const rowMods = el('div', {class:'modrow'}, [
      modChip('HP%', hpInput(mods.hpPct, v=>store.update(s=>{ const cur=byId(s.roster,r.id); if(cur){ cur.mods={...(cur.mods||{}), hpPct:v}; }}))),
      modChip('Atk', stageSelect(mods.atkStage, v=>store.update(s=>{ const cur=byId(s.roster,r.id); if(cur){ cur.mods={...(cur.mods||{}), atkStage:v}; }}))),
      modChip('SpA', stageSelect(mods.spaStage, v=>store.update(s=>{ const cur=byId(s.roster,r.id); if(cur){ cur.mods={...(cur.mods||{}), spaStage:v}; }}))),
      modChip('Def', stageSelect(mods.defStage, v=>store.update(s=>{ const cur=byId(s.roster,r.id); if(cur){ cur.mods={...(cur.mods||{}), defStage:v}; }}))),
      modChip('SpD', stageSelect(mods.spdStage, v=>store.update(s=>{ const cur=byId(s.roster,r.id); if(cur){ cur.mods={...(cur.mods||{}), spdStage:v}; }}))),
      modChip('Spe', stageSelect(mods.speStage, v=>store.update(s=>{ const cur=byId(s.roster,r.id); if(cur){ cur.mods={...(cur.mods||{}), speStage:v}; }}))),
    ]);

    modsSec.appendChild(rowMods);
    // (Reset modifiers removed — users can adjust chips directly.)

    // Move pool list
    const mp = el('div', {}, [
      el('div', {class:'panel-subtitle'}, 'Move pool (set priority + enable moves)'),
      el('div', {class:'muted small'}, 'Priority: P1 preferred, then P2. P3 only if P1/P2 cannot OHKO.'),
      el('div', {id:'movePoolList'}),
    ]);

    const mpList = $('#movePoolList', mp);

    const list = (r.movePool||[]).slice().sort((a,b)=>(Number(a.prio)-Number(b.prio))||a.name.localeCompare(b.name));
    for (const m of list){
      const mv = data.moves[m.name];
      const meta = mv ? `${mv.type} · ${mv.category} · ${mv.power}` : '—';
      const ppObj = state.pp?.[r.id]?.[m.name];
      const ppCur = Number(ppObj?.cur ?? DEFAULT_MOVE_PP);
      const ppMax = Number(ppObj?.max ?? DEFAULT_MOVE_PP);
      const ppMeta = `PP ${ppCur}/${ppMax}`;

      const useChk = el('input', {type:'checkbox', checked: !!m.use});
      useChk.addEventListener('change', ()=>{
        store.update(s=>{
          const cur = byId(s.roster, r.id);
          if (!cur) return;
          const mm = (cur.movePool||[]).find(x=>x.name===m.name);
          if (mm) mm.use = useChk.checked;
        });
      });

      const prioSel = el('select', {}, [1,2,3].map(p=>el('option',{value:String(p), selected:Number(m.prio)===p}, `prio ${p}`)));
      prioSel.addEventListener('change', ()=>{
        store.update(s=>{
          const cur = byId(s.roster, r.id);
          if (!cur) return;
          const mm = (cur.movePool||[]).find(x=>x.name===m.name);
          if (mm) mm.prio = Number(prioSel.value) || 2;
        });
      });

      const rmBtn = el('button', {class:'btn-mini'}, 'Remove');
      rmBtn.addEventListener('click', ()=>{
        store.update(s=>{
          const cur = byId(s.roster, r.id);
          if (!cur) return;
          cur.movePool = (cur.movePool||[]).filter(x=>x.name !== m.name);
        });
      });

      mpList.appendChild(el('div', {class:'row'}, [
        el('div', {class:'row-left'}, [
          el('div', {}, [
            el('div', {class:'row-title'}, m.name),
            el('div', {class:'row-sub'}, meta + ` · ${ppMeta}` + (m.source ? ` · ${m.source}` : '')),
          ]),
        ]),
        el('div', {class:'row-right'}, [
          prioSel,
          el('label', {class:'check', style:'margin:0'}, [useChk, el('span', {}, 'use')]),
          rmBtn,
        ]),
      ]));
    }

    // Add TM move
    const damaging = Object.values(data.moves)
      .filter(m=>m && (m.category==='Physical' || m.category==='Special') && m.power)
      .map(m=>m.name)
      .sort((a,b)=>a.localeCompare(b));

    const moveSel = el('select', {}, [
      el('option', {value:''}, '— choose a move —'),
      ...damaging.map(m=>el('option', {value:m}, m)),
    ]);

    const addMoveBtn = el('button', {class:'btn-mini'}, 'Add');
    addMoveBtn.addEventListener('click', ()=>{
      const mv = moveSel.value;
      if (!mv) return;
      store.update(s=>{
        const cur = byId(s.roster, r.id);
        if (!cur) return;
        if ((cur.movePool||[]).some(x=>x.name===mv)) return;
        const species = cur.effectiveSpecies || cur.baseSpecies;
        const prio = defaultPrioForMove(data, species, mv);
        cur.movePool.push({name: mv, prio, use:true, source:'tm'});
      });
    });

    const addMove = el('div', {class:'field'}, [
      el('label', {}, 'Add TM move'),
      el('div', {style:'display:flex; gap:8px'}, [moveSel, addMoveBtn]),
      el('div', {class:'muted small'}, 'Move data is fixed from the sheet. You can add + enable/disable moves.'),
    ]);

    container.appendChild(title);
    container.appendChild(el('div', {class:'hr'}));
    container.appendChild(charms);
    container.appendChild(el('div', {class:'hr'}));
    container.appendChild(itemSec);
    container.appendChild(el('div', {class:'hr'}));
    container.appendChild(modsSec);
    container.appendChild(el('div', {class:'hr'}));
    container.appendChild(mp);
    container.appendChild(addMove);
  }

  function renderRoster(state){
    tabRoster.innerHTML = '';

    const left = el('div', {class:'list'}, [
      el('div', {class:'list-head'}, [
        el('button', {class:'btn-mini', id:'btnAddRoster'}, 'Add'),
        el('input', {id:'searchRoster', type:'text', placeholder:'Search roster…', value: state.ui.searchRoster || ''}),
      ]),
      el('div', {class:'list-body', id:'rosterList'}),
    ]);

    const right = el('div', {class:'panel'}, [
      el('div', {class:'panel-title'}, 'Roster details'),
      el('div', {id:'rosterDetails', class:'muted'}, 'Select a roster Pokémon.'),
    ]);

    tabRoster.appendChild(el('div', {class:'roster-layout'}, [left, right]));

    const listBody = $('#rosterList', tabRoster);
    const q = (state.ui.searchRoster || '').toLowerCase().trim();
    const roster = state.roster.slice().sort((a,b)=>rosterLabel(a).localeCompare(rosterLabel(b)));

    for (const r of roster){
      const label = rosterLabel(r);
      if (q && !label.toLowerCase().includes(q)) continue;

      const img = el('img', {class:'sprite', src:sprite(calc, r.effectiveSpecies||r.baseSpecies), alt:label});
      img.onerror = ()=> img.style.opacity='0.25';

      const activeChk = el('input', {type:'checkbox', checked: !!r.active});
      activeChk.addEventListener('change', ()=>{
        store.update(s=>{
          const cur = byId(s.roster, r.id);
          if (cur) cur.active = activeChk.checked;
        });
      });

      const editBtn = el('button', {class:'btn-mini'}, 'Edit');

      const dexBtnRow = el('button', {class:'btn-mini'}, 'Dex');
      dexBtnRow.addEventListener('click', (ev)=>{ ev.stopPropagation(); openDex(); });
      editBtn.addEventListener('click', ()=>{
        store.update(s=>{ s.ui.selectedRosterId = r.id; });
      });

      const openDex = ()=>{
        const base = r.baseSpecies;
        store.update(s=>{
          s.ui.tab = 'unlocked';
          // Remember where we came from so the Dex back button can return to Roster.
          s.ui.dexReturnTab = 'roster';
          s.ui.lastNonDexTab = 'roster';
          s.ui.dexReturnRosterId = r.id;
          // Ensure the starter row opens the same details when returning.
          s.ui.selectedRosterId = r.id;
          s.ui.dexDetailBase = base;
          s.ui.dexSelectedForm = base;
        });
        pokeApi.resolveEvoLine(base, store.getState().baseCache||{})
          .then(({base:resolved, line, updates})=>{
            store.update(st=>{
              st.baseCache = {...(st.baseCache||{}), ...(updates||{})};
              st.evoLineCache = st.evoLineCache || {};
              st.evoLineCache[resolved] = Array.isArray(line) && line.length ? line : [resolved];
              if (st.ui.dexDetailBase === base) st.ui.dexDetailBase = resolved;
              if (!st.ui.dexSelectedForm || st.ui.dexSelectedForm === base) st.ui.dexSelectedForm = resolved;
            });
          })
          .catch(()=>{});
      };
      img.addEventListener('click', openDex);

      const rowEl = el('div', {class:'row'}, [
        el('div', {class:'row-left'}, [
          img,
          el('div', {}, [
            el('div', {class:'row-title', style:'cursor:pointer'}, label),
            el('div', {class:'row-sub'}, r.ability ? `Ability: ${r.ability}` : 'Ability: —'),
          ]),
        ]),
        el('div', {class:'row-right'}, [
          el('label', {class:'check', style:'margin:0'}, [activeChk, el('span', {}, 'active')]),
          dexBtnRow,
          editBtn,
        ]),
      ]);

      rowEl.querySelector('.row-title')?.addEventListener('click', openDex);

      listBody.appendChild(rowEl);
    }

    const selected = byId(state.roster, state.ui.selectedRosterId);
    if (selected){
      renderRosterDetails(state, selected, $('#rosterDetails', tabRoster));
    }

    $('#searchRoster', tabRoster).addEventListener('input', (ev)=>{
      store.update(s=>{ s.ui.searchRoster = ev.target.value; });
    });

    $('#btnAddRoster', tabRoster).addEventListener('click', ()=> openAddRosterModal(state));
  }


  function typeClass(t){
    return 'type-' + String(t||'').replace(/[^A-Za-z0-9]/g,'');
  }
  function renderTypeChips(types){
    const arr = Array.isArray(types) ? types : (types ? String(types).split('/').map(s=>s.trim()).filter(Boolean) : []);
    const wrap = el('div', {class:'typechips'});
    for (const t of arr){
      wrap.appendChild(el('span', {class:'typechip ' + typeClass(t)}, t));
    }
    return wrap;
  }

  // ---- Pokédex helpers (ported from alpha_v35_dex_entry_layout_final_align_v3) ----

  function shortMoveLabel(name){
    const s = String(name||'').trim();
    if (!s || s === '—') return '—';
    return s
      .replace(/^Hidden Power\s*\(/i, 'HP (')
      .replace(/^Protective Aura$/i, 'Prot. Aura')
      .replace(/^Mending Prayer$/i, 'Mending')
      .replace(/^Joyous Cheer$/i, 'Joyous');
  }

  function renderAbilityPlate(ability){
    const a = String(ability||'').trim();
    return el('span', {class:'dex-plate dex-ability', title: a || '—'}, a || '—');
  }

  function renderDexTypePlate(t){
    const s = String(t||'').trim();
    if (!s){
      return el('span', {class:'dex-plate dex-type dex-placeholder', 'aria-hidden':'true'}, '');
    }
    return el('span', {class:`dex-plate dex-type ${typeClass(s)}`, title: s}, s);
  }

  function moveMetaForGrid(rawName){
    const raw = String(rawName||'').trim();
    if (!raw || raw === '—') return {type:'', cat:''};

    let type = '';
    let cat = '';

    // Hidden Power / HP (Type) — infer type from the parenthesis.
    const hpMatch = /\(\s*([A-Za-z]+)\s*\)/.exec(raw);
    if (/^(Hidden Power|HP)\s*\(/i.test(raw) && hpMatch){
      type = hpMatch[1] || '';
      cat = 'Special';
    }

    // Try to resolve move meta from local move data (exact and a few normalizations).
    const tryKeys = [
      raw,
      raw.replace(/\s+/g,' '),
      raw.replace(/^HP\s*\(/i,'Hidden Power ('),
    ];

    let mv = null;
    for (const k of tryKeys){
      if (data.moves && data.moves[k]){ mv = data.moves[k]; break; }
    }

    if (mv){
      if (!type && mv.type) type = mv.type;
      if (!cat && mv.category) cat = mv.category;
    }

    return {type, cat};
  }

  function catClass(c){
    return String(c||'').replace(/[^A-Za-z0-9]/g,'');
  }

  function renderDexPlateGrid(types, ability, moves){
    const tarr = Array.isArray(types)
      ? types.slice(0,2)
      : (types ? String(types).split('/').map(s=>s.trim()).filter(Boolean).slice(0,2) : []);
    while (tarr.length < 2) tarr.push('');

    const marr = Array.isArray(moves) ? moves.slice(0,4) : [];
    while (marr.length < 4) marr.push('—');

    const grid = el('div', {class:'dex-plategrid'});

    // Layout: Ability (spans 2 rows) on the LEFT, Types stacked on the RIGHT.
    // Row 1: Ability | Type1
    const abilEl = renderAbilityPlate(ability);
    grid.appendChild(abilEl);
    grid.appendChild(renderDexTypePlate(tarr[0]));

    // Row 2: (Ability continues) | Type2
    grid.appendChild(renderDexTypePlate(tarr[1]));

    // Rows 3–4: Moves (2x2)
    for (const m of marr){
      const full = String(m||'').trim();
      const label = shortMoveLabel(full);

      const meta = moveMetaForGrid(full);
      const cls = ['dex-plate','dex-move'];
      if (meta.type) cls.push(`type-${meta.type}`);
      if (meta.cat) cls.push(`cat-${catClass(meta.cat)}`);

      grid.appendChild(el('span', {class: cls.join(' '), title: full || label}, label));
    }

    return grid;
  }

  // ---------------- Unlocked (Pokédex) ----------------

    function renderUnlocked(state){
    tabUnlocked.innerHTML = '';

    // Pokédex should at least include everything that appears in the shrine waves.
    const claimable = uniq([
      ...Object.keys(data.claimedSets || {}),
      ...speciesListFromSlots(data.calcSlots || []),
    ]);

    const q = (state.ui.searchUnlocked || '').toLowerCase().trim();

    // Detail view (layer/page)
    if (state.ui.dexDetailBase){
      const base = state.ui.dexDetailBase;
      const locked = !state.unlocked?.[base];
      const cachedLine = (state.evoLineCache && state.evoLineCache[base]) ? state.evoLineCache[base] : null;
      const line = cachedLine || [base];
      const selected = state.ui.dexSelectedForm || line[0] || base;

      // Ensure non-baby evo line exists (includes stages not in waves).
      if (!cachedLine || (Array.isArray(cachedLine) && cachedLine.length < 2)){
          pokeApi.resolveEvoLineNonBaby(base, state.baseCache||{})
          .then(({base:resolvedBase, line:resolvedLine, updates})=>{
            store.update(s=>{
              if (updates) s.baseCache = {...(s.baseCache||{}), ...updates};
              s.evoLineCache = s.evoLineCache || {};
              s.evoLineCache[resolvedBase] = Array.isArray(resolvedLine) && resolvedLine.length ? resolvedLine : [resolvedBase];
              if (fixName(s.ui.dexDetailBase) === fixName(base)){
                s.ui.dexDetailBase = resolvedBase;
                if (!s.ui.dexSelectedForm) s.ui.dexSelectedForm = (resolvedLine && resolvedLine[0]) ? resolvedLine[0] : resolvedBase;
              }
            });
          })
          .catch(()=>{});
      }

      // Prefetch API data for selected + visible evo chips
      ensureDexMeta(base);
      ensureDexApi(selected);
      for (const sp of line) ensureDexApi(sp);

      // Defender levels should come from where this species appears in waves.
      const rawLvls = (data.calcSlots||[])
        .filter(s => fixName(s.defender) === fixName(selected) || fixName(s.defender) === fixName(base))
        .map(s => Number(s.level))
        .filter(v => Number.isFinite(v) && v > 0);
      const levels = uniq(rawLvls).sort((a,b)=>a-b);
      const fallbackLvl = Number(state.settings.claimedLevel || 50);
      const preferred = Number(state.ui.dexDefenderLevelByBase?.[base]);
      const lvl = (levels.length && levels.includes(preferred))
        ? preferred
        : (levels.length ? levels[levels.length-1] : fallbackLvl);

      // Claimed set move/ability inheritance:
      // If an evolution has no explicit entry in claimedSets.json, inherit base's entry.
      const resolveClaimedSet = (b, sp)=>{
        const s = fixName(sp);
        const bb = fixName(b);
        return data.claimedSets?.[s] || data.claimedSets?.[bb] || null;
      };

      const api = state.dexApiCache?.[fixName(selected)] || null;
      const meta = state.dexMetaCache?.[fixName(selected)] || state.dexMetaCache?.[fixName(base)] || null;
      const dexObj = data.dex?.[selected] || null;

      // Shrine rule: typings follow the Gen 5 sheet (no Fairy). Prefer local dex.json,
      // fall back to Gen5-derived PokéAPI typing only if we don't have the entry.
      const typesArr = (dexObj && Array.isArray(dexObj.types) && dexObj.types.length)
        ? dexObj.types
        : ((api?.typesGen5 && Array.isArray(api.typesGen5) && api.typesGen5.length) ? api.typesGen5 : []);
      const typesStr = typesArr.length ? typesArr.join(' / ') : '—';
      const baseStats = (api?.stats && Object.keys(api.stats||{}).length) ? api.stats : (dexObj?.base || null);
      const bst = baseStats ? (baseStats.hp||0)+(baseStats.atk||0)+(baseStats.def||0)+(baseStats.spa||0)+(baseStats.spd||0)+(baseStats.spe||0) : 0;

      const claimed = resolveClaimedSet(base, selected);
      const ability = claimed?.ability || '—';
      const nature = defaultNatureForSpecies(selected);

      const fixedMovesRaw = (claimed?.moves && Array.isArray(claimed.moves) && claimed.moves.length)
        ? claimed.moves.slice(0,4)
        : null;
      const fixedMoves = fixedMovesRaw ? applyMovesetOverrides(selected, fixedMovesRaw) : null;

      const mu = typeMatchups(typesArr);
      const heightM = api?.heightDm ? (api.heightDm/10) : null;
      const weightKg = api?.weightHg ? (api.weightHg/10) : null;

      const fmtHeight = (m)=>{
        if (!(typeof m === 'number' && Number.isFinite(m))) return '—';
        const inchesTotal = m * 39.3700787;
        const ft = Math.floor(inchesTotal / 12);
        const inch = Math.round(inchesTotal - ft * 12);
        return `${m.toFixed(1)} m (${ft}′${inch}″)`;
      };
      const fmtWeight = (kg)=>{
        if (!(typeof kg === 'number' && Number.isFinite(kg))) return '—';
        const lb = kg * 2.20462262;
        return `${kg.toFixed(1)} kg (${lb.toFixed(1)} lb)`;
      };

      // Move info helpers (type/BP/category + short description).
      const canonicalMoveName = (mv)=>{
        const raw = String(mv||'').trim();
        if (!raw) return raw;
        const m1 = raw.match(/^HP\s+(\w+)/i);
        if (m1){
          const t = m1[1].toLowerCase();
          const T = t[0].toUpperCase()+t.slice(1);
          return `Hidden Power (${T})`;
        }
        if (/^HP\s*Fly/i.test(raw) || /^HP\s*Flying/i.test(raw) || /^Hidden\s*Power\s*Flying/i.test(raw)){
          return 'Hidden Power (Flying)';
        }
        return raw;
      };
      const moveSlug = (mv)=>{
        const raw = String(mv||'').trim();
        if (!raw) return '';
        // Hidden Power variants all share the same PokeAPI move endpoint.
        if (/^Hidden Power\s*\(/i.test(raw) || /^HP\s+/i.test(raw)) return 'hidden-power';
        // Insert spaces for CamelCase like ThunderPunch -> Thunder Punch
        const spaced = raw.replace(/([a-z])([A-Z])/g, '$1 $2');
        return spaced
          .toLowerCase()
          .replace(/['.:%()]/g,'')
          .replace(/\s+/g,'-')
          .replace(/[^a-z0-9-]/g,'');
      };

      const ensureMoveDesc = (mv)=>{
        const canon = canonicalMoveName(mv);
        const key = fixName(canon);
        if (state.dexMoveCache?.[key]) return;
        const slug = moveSlug(canon);
        if (!slug) return;
        fetch(`https://pokeapi.co/api/v2/move/${slug}`)
          .then(r => r.ok ? r.json() : null)
          .then(j => {
            const eff = j?.effect_entries?.find(e => e.language?.name === 'en');
            const shortEff = eff?.short_effect || eff?.effect || null;
            if (!shortEff) return;
            store.update(s=>{
              s.dexMoveCache = s.dexMoveCache || {};
              // Keep it short in UI.
              s.dexMoveCache[key] = String(shortEff).replace(/\s+/g,' ').trim();
            });
          })
          .catch(()=>{});
      };

      const backLabel = (state.ui?.dexReturnTab === 'roster') ? '← Back to Roster' : '← Back to Pokédex';
      const backBtn = el('button', {class:'btn-mini'}, backLabel);
      backBtn.addEventListener('click', (ev)=>{
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        store.update(s=>{
          const ret = s.ui.dexReturnTab || s.ui.lastNonDexTab || 'unlocked';
          s.ui.dexDetailBase = null;
          s.ui.dexSelectedForm = null;
          s.ui.dexReturnTab = null;
          if (ret === 'roster' && s.ui.dexReturnRosterId){
            s.ui.selectedRosterId = s.ui.dexReturnRosterId;
          }
          s.ui.dexReturnRosterId = null;
          if (ret) s.ui.tab = ret;
        });
      });

      const lvlSel = (levels.length > 1) ? (function(){
        const sel = el('select', {class:'sel-mini'}, levels.map(v => el('option', {value:String(v), selected:Number(v)===Number(lvl)}, String(v))));
        sel.addEventListener('change', ()=>{
          const v = Number(sel.value);
          store.update(s=>{
            s.ui.dexDefenderLevelByBase = s.ui.dexDefenderLevelByBase || {};
            s.ui.dexDefenderLevelByBase[base] = Number.isFinite(v) ? v : null;
          });
        });
        return sel;
      })() : null;

      // Compact evolution strip (less prominent than the full evo row).
      const evoInline = el('div', {class:'dex-evo-inline'});

      const head = el('div', {class:'dex-detail-head'}, [
        el('div', {class:'dex-detail-head-left'}, [
          backBtn,
          el('div', {class:'panel-title'}, base),
          evoInline,
        ]),
        el('div', {style:'display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end;'}, [
          el('div', {class:'muted small'}, 'Defender level:'),
          lvlSel || el('div', {class:'muted small'}, String(lvl)),
        ]),
      ]);

      for (const sp of line){
        // Header chip
        const chip = el('button', {class:'dex-evo-chip' + (sp===selected ? ' active' : ''), title: sp, 'aria-label': sp}, [
          (function(){
            const img = el('img', {
              class:'sprite sprite-md',
              loading:'lazy',
              decoding:'async',
              src:(calc.spriteUrlPokemonDbBWStatic ? calc.spriteUrlPokemonDbBWStatic(sp) : sprite(calc, sp)),
              alt: sp
            });
            // Prefer static in header for perf; fall back to GIF if missing.
            img.dataset.fallbackTried = '0';
            img.onerror = ()=>{
              if (img.dataset.fallbackTried !== '1'){
                img.dataset.fallbackTried = '1';
                img.src = sprite(calc, sp);
              }
            };
            return img;
          })(),
        ]);
        chip.addEventListener('click', ()=>{
          store.update(s=>{ s.ui.dexSelectedForm = sp; });
        });
        evoInline.appendChild(chip);
      }

      const statGrid = (function(){
        const order = [
          ['HP','hp'],
          ['Atk','atk'],
          ['Def','def'],
          ['SpA','spa'],
          ['SpD','spd'],
          ['Spe','spe'],
        ];
        const g = el('div', {class:'dex-stats'});
        for (const [lab,key] of order){
          g.appendChild(el('div', {class:`dex-stat dex-stat-${key}`}, [
            el('div', {class:'dex-stat-k'}, lab),
            el('div', {class:'dex-stat-v'}, baseStats ? String(baseStats[key] ?? '—') : '—'),
          ]));
        }
        return g;
      })();

      const moveList = (function(){
        if (!fixedMoves || !fixedMoves.length) return el('div', {class:'muted'}, '—');
        const wrap = el('div', {class:'dex-move-list'});
        for (const rawName of fixedMoves){
          const canon = canonicalMoveName(rawName);
          const mv = data.moves?.[canon] || data.moves?.[rawName] || null;
          const type = mv?.type || '—';
          const cat = mv?.category || '—';
          const bp = (typeof mv?.power === 'number' && Number.isFinite(mv.power)) ? String(Math.round(mv.power)) : '—';

          ensureMoveDesc(rawName);
          const desc = state.dexMoveCache?.[fixName(canon)] || mv?.notes || '';

          wrap.appendChild(el('div', {class:'dex-move-card'}, [
            el('div', {class:'dex-move-main'}, [
              el('div', {class:'dex-move-top'}, [
                el('div', {class:'dex-move-name'}, rawName),
                el('div', {class:'dex-move-tags'}, [
                  (type && type !== '—')
                    ? el('span', {class:`dex-plate dex-type ${typeClass(type)}`}, type)
                    : el('span', {class:'dex-plate'}, '—'),
                  el('span', {class:`dex-plate dex-move cat-${catClass(cat)}`}, cat),
                  el('span', {class:'dex-plate dex-bp'}, `BP ${bp}`),
                ]),
              ]),
              desc ? el('div', {class:'dex-move-desc'}, desc) : el('div', {class:'dex-move-desc muted'}, '—'),
            ]),
          ]));
        }
        return wrap;
      })();

      const heroState = el('span', {class:`dex-state-inline ${locked ? 'locked' : 'unlocked'}`, title: locked ? 'Locked' : 'Unlocked', 'aria-label': locked ? 'Locked' : 'Unlocked'});
      const hero = el('div', {class:'dex-entry-hero dex-area-hero'}, [
        el('div', {class:'dex-entry-spritewrap'}, [
          el('img', {class:'sprite sprite-xxl', src:sprite(calc, selected), alt:selected}),
        ]),
        el('div', {class:'dex-entry-main'}, [
          el('div', {class:'dex-entry-titleRow'}, [
            heroState,
            el('div', {class:'dex-entry-title'}, selected),
          ]),
          el('div', {class:'dex-entry-sub'}, [
            el('span', {class:'muted'}, `#${meta?.id || api?.id || '—'}`),
            (api?.genus || meta?.genus) ? el('span', {class:'muted'}, ` · ${api?.genus || meta?.genus}`) : el('span', {class:'muted'}, ''),
            (selected !== base) ? el('span', {class:'muted'}, ` · Base: ${base}`) : el('span', {class:'muted'}, ''),
          ]),
          el('div', {class:'dex-entry-plates'}, [
            renderDexPlateGrid(typesArr, ability, fixedMoves || []),
          ]),
        ]),
      ]);

      const profilePanel = el('div', {class:'panel dex-side-panel'}, [
        el('div', {class:'dex-side-title'}, 'Profile'),
        el('div', {class:'dex-profile-grid'}, [
          // User preference: BST should sit on the far-left of the profile row.
          el('div', {class:'dex-profile-tile dex-profile-bst'}, [
            el('div', {class:'dex-profile-k'}, 'BST'),
            el('div', {class:'dex-profile-v'}, String(bst || '—')),
          ]),
          el('div', {class:'dex-profile-tile'}, [
            el('div', {class:'dex-profile-k'}, 'Nature'),
            el('div', {class:'dex-profile-v'}, nature || '—'),
          ]),
          el('div', {class:'dex-profile-tile'}, [
            el('div', {class:'dex-profile-k'}, 'Height'),
            el('div', {class:'dex-profile-v'}, fmtHeight(heightM)),
          ]),
          el('div', {class:'dex-profile-tile'}, [
            el('div', {class:'dex-profile-k'}, 'Weight'),
            el('div', {class:'dex-profile-v'}, fmtWeight(weightKg)),
          ]),
        ]),
      ]);

      const hasResist = !!(mu.resist && mu.resist.length);
      const hasImmune = !!(mu.immune && mu.immune.length);
      const matchupsPanel = el('div', {class:'panel dex-side-panel'}, [
        el('div', {class:'dex-side-title'}, 'Type matchups'),
        el('div', {class:`dex-matchups ${hasImmune ? 'has-immune' : 'no-immune'} ${hasResist ? 'has-resist' : 'no-resist'}`}, [
          el('div', {class:'dex-mu mu-good'}, [
            el('div', {class:'dex-mu-head'}, [
              el('span', {class:'dex-mu-tag good'}, 'WEAK'),
            ]),
            el('div', {class:'dex-mu-plates'}, mu.weak.length
              ? mu.weak.map(x=> el('span', {class:`dex-plate ${typeClass(x.atk)}`}, `${x.atk} x${x.mult}`))
              : el('span', {class:'dex-plate'}, '—')),
          ]),
          ...(hasResist ? [el('div', {class:'dex-mu mu-bad'}, [
            el('div', {class:'dex-mu-head'}, [
              el('span', {class:'dex-mu-tag bad'}, 'RESIST'),
            ]),
            el('div', {class:'dex-mu-plates'}, mu.resist.map(x=> el('span', {class:`dex-plate ${typeClass(x.atk)}`}, `${x.atk} x${x.mult}`))),
          ])] : []),
          ...(hasImmune ? [el('div', {class:'dex-mu mu-danger'}, [
            el('div', {class:'dex-mu-head'}, [
              el('span', {class:'dex-mu-tag danger'}, 'IMMUNE'),
            ]),
            el('div', {class:'dex-mu-plates'}, mu.immune.map(x=> el('span', {class:`dex-plate ${typeClass(x.atk)}`}, x.atk))),
          ])] : []),
        ]),
      ]);

      const statsPanel = el('div', {class:'panel dex-side-panel'}, [
        el('div', {class:'dex-side-title'}, 'Base stats'),
        statGrid,
      ]);

      // Compact info stack: Profile on top, then Base stats + Type matchups side-by-side.
      // (User preference: Base stats on the LEFT, Matchups on the RIGHT.)
      const sideSplit = el('div', {class:'dex-side-split'}, [statsPanel, matchupsPanel]);
      const sideStack = el('div', {class:'dex-side-stack'}, [profilePanel, sideSplit]);

      const movesPanel = el('div', {class:'panel dex-bottom-panel'}, [
        el('div', {class:'panel-title'}, 'Moveset (fixed 4)'),
        moveList,
      ]);

      // One-shot is the ONLY section allowed to expand/scroll.
      // Wrap the table so we can make it scroll inside the panel without changing table markup.
      const tablePanel = el('div', {class:'panel dex-bottom-panel dex-oneshot-panel'}, [
        el('div', {class:'panel-title'}, `One-shot vs active roster — ${selected}`),
        el('div', {class:'dex-oneshot-scroll'}, [
          buildOneShotTable(state, selected, lvl, []),
        ]),
      ]);

      // Column stacks (NO shared grid-rows): prevents the "dead band" gaps.
      // Layout (per user):
      //   LEFT  (top→down): Hero → Profile → Type matchups (+ base stats) → Moveset
      //   RIGHT (top→down): One-shot (the only section that may expand/scroll)
      const leftCol = el('div', {class:'dex-entry-col dex-entry-left'}, [hero, sideStack, movesPanel]);
      const rightCol = el('div', {class:'dex-entry-col dex-entry-right'}, [tablePanel]);
      const grid = el('div', {class:'dex-entry-shell'}, [leftCol, rightCol]);

      const headPanel = el('div', {class:'panel'}, [head]);
      const all = el('div', {class:'dex-detail-wrap'}, [headPanel, grid]);

      tabUnlocked.appendChild(all);

      // Visual snap: keep the One-shot panel height aligned to the LEFT stack.
      // This prevents page scrolling in normal cases and ensures scrolling only
      // happens INSIDE the One-shot table when the roster grows.
      try{
        if (window.__dexDetailRO){ window.__dexDetailRO.disconnect(); }
        const sync = ()=>{
          const h = Math.round(leftCol.getBoundingClientRect().height || 0);
          if (h > 0){ rightCol.style.height = `${h}px`; }
        };
        const ro = new ResizeObserver(sync);
        ro.observe(leftCol);
        window.__dexDetailRO = ro;
        requestAnimationFrame(sync);
      } catch(_e) {}

      return;
    }

    // Base-species grid view
    // If we leave a detail view, clean up the height sync observer.
    try{ if (window.__dexDetailRO){ window.__dexDetailRO.disconnect(); window.__dexDetailRO = null; } } catch(_e) {}
    const wrap = el('div', {class:'panel'}, [
      el('div', {class:'panel-title'}, 'Pokédex'),
      el('div', {class:'muted small'}, 'Shows whether a BASE species is unlocked (claiming is done from Waves). Click a base species to open its evolution line.'),
      el('div', {class:'muted small', id:'dexResolveHint'}, ''),
      el('div', {class:'field'}, [
        el('label', {}, 'Search'),
        el('input', {type:'text', id:'searchUnlocked', placeholder:'Search…', value: state.ui.searchUnlocked || ''}),
      ]),
      el('div', {class:'dex-grid', id:'dexGrid'}),
    ]);

    tabUnlocked.appendChild(wrap);

    const grid = $('#dexGrid', wrap);
    const search = $('#searchUnlocked', wrap);
    const resolveHint = $('#dexResolveHint', wrap);

    const filtered = claimable.filter(sp => !q || String(sp).toLowerCase().includes(q));

    // Ensure Pokédex order + evo lines are ready (single batched job, no jitter).
    const wantN = Array.from(new Set((claimable||[]).map(s=>fixName(s)).filter(Boolean))).length;
    const gridReady = !!(state.ui?.dexGridReady && Number(state.ui?.dexGridBuiltN) === Number(wantN));

    if (resolveHint){
      // Always (re)kick the background job if needed.
      if (!gridReady){
        resolveHint.textContent = 'Resolving Pokédex order…';
        setTimeout(()=> runDexGridJob(claimable, resolveHint), 0);
      } else {
        resolveHint.textContent = '';
      }
    }

    // IMPORTANT UX NOTE (mobile):
    // The Pokédex grid must remain stable and clickable.
    // Large background prefetching (base resolving + meta/api fetches) can trigger
    // a constant stream of store updates → re-renders → "rows flipping" and
    // taps not registering. We therefore avoid bulk prefetching in the grid.
    // Base resolving happens on-demand when opening a detail page.


    if (!gridReady){
      grid.innerHTML = '';
      grid.appendChild(el('div', {class:'muted small', style:'padding:10px'}, 'Resolving Pokédex order…'));
    } else {
    // BASE-ONLY Pokédex grid:
    // - grid shows only the non-baby BASE species (claiming any evo form claims the species)
    // - clicking opens detail view to see relevant forms (base + endforms + any wave intermediates)

    const baseCache = state.baseCache || {};
    const unlockedBases = new Set();
    for (const k of Object.keys(state.unlocked||{})){
      if (!state.unlocked[k]) continue;
      const kk = fixName(k);
      const b = baseCache[kk] || kk;
      unlockedBases.add(b);
    }

    const filtered = claimable.filter(sp => !q || String(sp).toLowerCase().includes(q));

    const baseSet = new Set();
    for (const sp of filtered){
      const norm = fixName(sp);
      const base = pokeApi.baseOfSync(norm, baseCache);
      if (base) baseSet.add(base);
    }

    const dexIdOf = (sp)=>{
      const k = fixName(sp);
      const id = state.dexMetaCache?.[k]?.id ?? state.dexApiCache?.[k]?.id;
      return Number.isFinite(Number(id)) ? Number(id) : Infinity;
    };

    const baseList = Array.from(baseSet).sort((a,b)=>{
      const da = dexIdOf(a);
      const db = dexIdOf(b);
      if (da !== db) return da - db;
      return String(a).localeCompare(String(b));
    });

    grid.innerHTML = '';
    for (const base of baseList){
      const locked = !unlockedBases.has(base);
      const d = data.dex?.[base] || null;
      const dexNo = dexIdOf(base);

      // Prefer local sheet typings.
      const types = (d && Array.isArray(d.types) && d.types.length) ? d.types : [];

      const img = el('img', {
        class:'sprite sprite-lg',
        loading:'lazy',
        decoding:'async',
        src:(calc.spriteUrlPokemonDbBWStatic ? calc.spriteUrlPokemonDbBWStatic(base) : sprite(calc, base)),
        alt:base
      });

      // Prefer static PNG in the grid; fall back to animated GIF if the PNG is missing.
      img.dataset.fallbackTried = '0';
      img.onerror = ()=>{
        if (img.dataset.fallbackTried !== '1'){
          img.dataset.fallbackTried = '1';
          img.src = sprite(calc, base);
          return;
        }
        img.style.opacity='0.25';
      };

      const dexLabel = (Number.isFinite(dexNo) && dexNo !== Infinity)
        ? `#${String(dexNo).padStart(3,'0')}`
        : '';

      const cs = data.claimedSets?.[base] || null;
      const ability = cs?.ability || '';
      const moves4 = Array.isArray(cs?.moves) ? cs.moves : [];

      const card = el('button', {
        class:'dex-card' + (locked ? ' locked' : ' unlocked'),
        title: base,
      }, [
        el('div', {class:'dex-spritewrap'}, [
          el('div', {class:'dex-state', 'aria-hidden':'true'}),
          img,
        ]),
        el('div', {class:'dex-plates'}, [
          renderDexPlateGrid(types, ability, moves4),
        ]),
      ]);

      card.addEventListener('click', ()=>{
        store.update(s=>{ s.ui.dexReturnTab = 'unlocked'; s.ui.dexDetailBase = base; s.ui.dexSelectedForm = base; });
        pokeApi.resolveEvoLineNonBaby(base, store.getState().baseCache||{})
          .then(({base:resolved, line, updates})=>{
            store.update(st=>{
              st.baseCache = {...(st.baseCache||{}), ...(updates||{})};
              st.evoLineCache = st.evoLineCache || {};
              st.evoLineCache[resolved] = Array.isArray(line) && line.length ? line : [resolved];
              if (st.ui.dexDetailBase === base) st.ui.dexDetailBase = resolved;
              if (!st.ui.dexSelectedForm) st.ui.dexSelectedForm = resolved;
            });
          })
          .catch(()=>{});
      });

      grid.appendChild(card);
    }


    }
    search.addEventListener('input', ()=>{
      store.update(s=>{ s.ui.searchUnlocked = search.value; });
    });
  }


  // ---------------- Sim (full battle simulator) ----------------

  function renderSim(state){
    tabSim.innerHTML = '';

    const wavesByKey = groupBy(data.calcSlots, s=>s.waveKey);
    const waveKeys = Object.keys(wavesByKey).sort((a,b)=>waveOrderKey(a)-waveOrderKey(b));

    const curKey = state.ui.simWaveKey && wavesByKey[state.ui.simWaveKey] ? state.ui.simWaveKey : (waveKeys[0] || null);

    const sel = el('select', {style:'min-width:220px'}, [
      ...waveKeys.map(k=>{
        const first = wavesByKey[k]?.[0];
        const label = first ? `${k} • ${first.animal} • Lv ${first.level}` : k;
        return el('option', {value:k, selected:k===curKey}, label);
      })
    ]);

    sel.addEventListener('change', ()=>{
      store.update(s=>{ s.ui.simWaveKey = sel.value; });
    });

    const head = el('div', {class:'panel'}, [
      el('div', {class:'panel-title'}, 'Simulator'),
      el('div', {class:'muted small'}, 'Full step-by-step simulator (PP + manual moves/targets). In Waves, keep it simple — here you can deep-dive any matchup.'),
      el('div', {style:'display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-top:10px'}, [
        el('div', {class:'field', style:'margin:0'}, [el('label', {}, 'Wave'), sel]),
        (function(){
          const b = el('button', {class:'btn-mini'}, 'Open in Waves');
          b.addEventListener('click', ()=>{
            store.update(s=>{ s.ui.tab='waves'; s.ui.waveExpanded[curKey]=true; });
          });
          return b;
        })(),
      ]),
    ]);

    tabSim.appendChild(head);

    if (!curKey){
      tabSim.appendChild(el('div', {class:'muted'}, 'No wave data.'));
      return;
    }

    const slots = wavesByKey[curKey] || [];
    ensureWavePlan(data, state, curKey, slots);
    const wp = store.getState().wavePlans?.[curKey];

    // Reuse the existing detailed battle panel
    tabSim.appendChild(renderBattlePanel(store.getState(), curKey, slots, wp));
  }

  // ---------------- Settings ----------------

  function renderSettings(state){
    tabSettings.innerHTML = '';

    const s = state.settings || {};

    const fieldNum = (label, value, opts, onChange)=>{
      const o = opts || {};
      const inp = el('input', {type:'number', value:String(value ?? ''), min:o.min, max:o.max, step:o.step ?? '1'});
      inp.addEventListener('change', ()=>{
        const v = (o.isFloat ? Number(inp.value) : clampInt(inp.value, Number(o.min ?? -999999), Number(o.max ?? 999999)));
        onChange(v);
      });
      return el('div', {class:'field'}, [el('label', {}, label), inp]);
    };

    const fieldCheck = (label, checked, onChange)=>{
      const inp = el('input', {type:'checkbox', checked:!!checked});
      inp.addEventListener('change', ()=> onChange(!!inp.checked));
      return el('label', {class:'check'}, [inp, el('span', {}, label)]);
    };

    const fieldSelect = (label, value, options, onChange)=>{
      const sel = el('select', {}, (options||[]).map(o=>{
        const v = (o && o.value !== undefined) ? o.value : o;
        const t = (o && o.label !== undefined) ? o.label : String(v);
        return el('option', {value:String(v), selected:String(v)===String(value)}, t);
      }));
      sel.addEventListener('change', ()=> onChange(Number(sel.value)));
      return el('div', {class:'field'}, [el('label', {}, label), sel]);
    };

    const stageSel = (cur, onChange)=>{
      const sel = el('select', {}, Array.from({length:13}).map((_,i)=>{
        const v = i-6;
        return el('option', {value:String(v), selected:Number(cur)===v}, (v>=0?`+${v}`:`${v}`));
      }));
      sel.addEventListener('change', ()=> onChange(Number(sel.value)||0));
      return sel;
    };

    const hpSel = (cur, onChange)=>{
      const inp = el('input', {type:'number', min:'1', max:'100', step:'1', value:String(cur ?? 100)});
      inp.addEventListener('change', ()=> onChange(clampInt(inp.value,1,100)));
      return inp;
    };

    const panel = (title, children)=> el('div', {class:'panel'}, [
      el('div', {class:'panel-title'}, title),
      ...children,
    ]);

    // Core constants + move scoring (merged into one panel to reduce "empty compartment" feel)
    const pCore = panel('Core settings', [
      el('div', {class:'panel-subtitle'}, 'Global calc constants'),
      el('div', {class:'muted small'}, 'These affect damage calcs everywhere (Waves + Overview).'),
      el('div', {class:'core-fields'}, [
        fieldNum('Claimed level', s.claimedLevel, {min:1,max:100,step:1}, v=>store.update(st=>{st.settings.claimedLevel=v;})),
        fieldNum('Claimed IV (all stats)', s.claimedIV, {min:0,max:31,step:1}, v=>store.update(st=>{st.settings.claimedIV=v;})),
        fieldNum('Claimed EV (all stats)', s.claimedEV, {min:0,max:252,step:1}, v=>store.update(st=>{st.settings.claimedEV=v;})),
        fieldNum('Strength charm EV (all stats)', s.strengthEV, {min:0,max:252,step:1}, v=>store.update(st=>{st.settings.strengthEV=v;})),
      ]),
      el('hr'),
      el('div', {class:'core-fields'}, [
        fieldNum('Wild IV default', s.wildIV, {min:0,max:31,step:1}, v=>store.update(st=>{st.settings.wildIV=v;})),
        fieldNum('Wild EV default', s.wildEV, {min:0,max:252,step:1}, v=>store.update(st=>{st.settings.wildEV=v;})),
      ]),
      el('hr'),
      el('div', {class:'panel-subtitle'}, 'Move selection behavior'),
      el('div', {class:'muted small'}, 'Priority is fixed: P1 preferred, P3 only if P1/P2 cannot OHKO.'),
      fieldCheck('Conserve power (prefer closest-to-100% OHKO)', s.conservePower, v=>store.update(st=>{st.settings.conservePower=v;})),
      el('div', {class:'core-fields'}, [
        fieldNum('STAB preference bonus (adds to score)', s.stabBonus, {min:0,max:50,step:1}, v=>store.update(st=>{st.settings.stabBonus=v;})),
        fieldNum('Other multiplier (damage)', s.otherMult, {min:0,max:10,step:0.05,isFloat:true}, v=>store.update(st=>{st.settings.otherMult=v;})),
      ]),
      fieldCheck('Apply Intimidate (INT tag)', s.applyINT, v=>store.update(st=>{st.settings.applyINT=v;})),
      fieldCheck('Apply Sturdy (STU tag at full HP)', s.applySTU, v=>store.update(st=>{st.settings.applySTU=v;})),
      fieldCheck('Sturdy AoE solve (auto): prefer AoE OHKO + finish STU', s.sturdyAoeSolve, v=>store.update(st=>{st.settings.sturdyAoeSolve=v;})),
      fieldCheck('Allow friendly fire (dangerous)', s.allowFriendlyFire, v=>store.update(st=>{st.settings.allowFriendlyFire=v;})),

      el('hr'),
      el('div', {class:'panel-subtitle'}, 'Auto solver (alts)'),
	  el('div', {class:'muted small'}, 'When cycling Auto x4, include solutions up to bestAvg + slack (avg prioØ, then turns). 0 = best-only.'),
      el('div', {class:'core-fields'}, [
	    fieldSelect('Avg prioØ slack', (s.autoAltAvgSlack ?? 0), [
          {value:0, label:'0 (best only)'},
          {value:0.25, label:'0.25'},
          {value:0.5, label:'0.5'},
          {value:1, label:'1.0'},
          {value:1.5, label:'1.5'},
          {value:2, label:'2.0'},
        ], v=>store.update(st=>{ st.settings.autoAltAvgSlack = Math.max(0, Number(v)||0); })),
        fieldSelect('Max variations (cycle + combos)', (s.variationLimit ?? 8), [
          {value:6, label:'6'},
          {value:8, label:'8 (recommended)'},
          {value:10, label:'10'},
          {value:12, label:'12'},
          {value:16, label:'16'},
          {value:24, label:'24'},
        ], v=>store.update(st=>{ st.settings.variationLimit = Math.max(1, Math.min(50, Math.floor(Number(v)||8))); })),
      ]),
      fieldNum('Max combos generated (safety cap)', (s.variationGenCap ?? 5000), {min:200,max:50000,step:100}, v=>store.update(st=>{ st.settings.variationGenCap = Math.max(200, Math.min(50000, Math.floor(Number(v)||5000))); })),
    ]);

    // Threat model settings
    const pThreat = panel('Threat model (enemy hits you)', [
      el('div', {class:'muted small'}, 'Used for incoming damage (IN xx%) + DIES warnings + auto-match penalties. Uses the defender\'s real species moveset when available (same source as attackers). Falls back to an assumed STAB hit only if a moveset is missing.'),
      fieldCheck('Enable threat model', s.threatModelEnabled, v=>store.update(st=>{st.settings.threatModelEnabled=v;})),
      fieldNum('Fallback: assumed move power', s.enemyAssumedPower, {min:1,max:250,step:1}, v=>store.update(st=>{st.settings.enemyAssumedPower=v;})),
      fieldCheck('Enemy acts first on speed tie', s.enemySpeedTieActsFirst, v=>store.update(st=>{st.settings.enemySpeedTieActsFirst=v;})),
    ]);

    // Defaults for per-mon wave modifiers
    const defAtk = s.defaultAtkMods || {hpPct:100, atkStage:0, spaStage:0, defStage:0, spdStage:0, speStage:0};
    const defDef = s.defaultDefMods || {hpPct:100, atkStage:0, spaStage:0, defStage:0, spdStage:0, speStage:0};

    const renderDefaultModsInline = (cur, onPatch)=>{
      return el('div', {class:'settings-inline'}, [
        el('div', {style:'display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end'}, [
          el('div', {class:'field', style:'width:82px'}, [el('label', {}, 'HP%'), hpSel(cur.hpPct, v=>onPatch({hpPct:v}))]),
          el('div', {class:'field', style:'width:82px'}, [el('label', {}, 'Atk'), stageSel(cur.atkStage, v=>onPatch({atkStage:v}))]),
          el('div', {class:'field', style:'width:82px'}, [el('label', {}, 'SpA'), stageSel(cur.spaStage, v=>onPatch({spaStage:v}))]),
          el('div', {class:'field', style:'width:82px'}, [el('label', {}, 'Def'), stageSel(cur.defStage, v=>onPatch({defStage:v}))]),
          el('div', {class:'field', style:'width:82px'}, [el('label', {}, 'SpD'), stageSel(cur.spdStage, v=>onPatch({spdStage:v}))]),
          el('div', {class:'field', style:'width:82px'}, [el('label', {}, 'Spe'), stageSel(cur.speStage, v=>onPatch({speStage:v}))]),
        ]),
        el('div', {style:'margin-top:8px; display:flex; gap:8px; flex-wrap:wrap'}, [
          (function(){
            const b = el('button', {class:'btn-mini'}, 'Reset to neutral');
            b.addEventListener('click', ()=> onPatch({hpPct:100, atkStage:0, spaStage:0, defStage:0, spdStage:0, speStage:0}, true));
            return b;
          })(),
        ]),
      ]);
    };

    // Default wave modifiers can get tall; use a tiny tab switch so the Settings layout stays balanced.
    const defaultsTab = state.ui?.settingsDefaultsTab || 'atk'; // 'atk' | 'def'
    const pDefaults = panel('Default wave modifiers', [
      el('div', {class:'muted small'}, 'Applied when a wave/mon has no custom modifier set yet.'),
      el('div', {class:'seg-toggle', style:'margin-top:8px'}, [
        (function(){
          const b = el('button', {class:'btn-mini' + (defaultsTab==='atk' ? ' active' : '')}, 'Attackers');
          b.addEventListener('click', ()=> store.update(st=>{ st.ui.settingsDefaultsTab = 'atk'; }));
          return b;
        })(),
        (function(){
          const b = el('button', {class:'btn-mini' + (defaultsTab==='def' ? ' active' : '')}, 'Defenders');
          b.addEventListener('click', ()=> store.update(st=>{ st.ui.settingsDefaultsTab = 'def'; }));
          return b;
        })(),
      ]),
      defaultsTab === 'atk'
        ? el('div', {}, [
            el('div', {class:'panel-subtitle', style:'margin-top:10px'}, 'Attackers'),
            renderDefaultModsInline(defAtk, (patch, replace)=>{
              store.update(st=>{
                st.settings.defaultAtkMods = replace ? {...patch} : {...(st.settings.defaultAtkMods||defAtk), ...patch};
              });
            }),
          ])
        : el('div', {}, [
            el('div', {class:'panel-subtitle', style:'margin-top:10px'}, 'Defenders'),
            renderDefaultModsInline(defDef, (patch, replace)=>{
              store.update(st=>{
                st.settings.defaultDefMods = replace ? {...patch} : {...(st.settings.defaultDefMods||defDef), ...patch};
              });
            }),
          ]),
    ]);

    const pTools = panel('Maintenance tools', [
      el('div', {class:'muted small'}, 'Useful when you want to rebase plans after changing global defaults.'),
      (function(){
        const b = el('button', {class:'btn'}, 'Clear ALL per-wave modifiers');
        b.addEventListener('click', ()=>{
          if (!confirm('Clear ALL per-wave modifiers (HP%/stages) across all waves?')) return;
          store.update(st=>{
            for (const wp of Object.values(st.wavePlans||{})){
              if (wp && wp.monMods) wp.monMods = {atk:{}, def:{}};
            }
          });
        });
        return b;
      })(),
      (function(){
        const b = el('button', {class:'btn btn-danger'}, 'Reset UI tab to Waves');
        b.addEventListener('click', ()=> store.update(st=>{ st.ui.tab='waves'; }));
        return b;
      })(),
    ]);
    const pAbout = panel('Credits & Impressum', [
      el('div', {class:'panel-subtitle'}, 'Credits'),
      el('div', {class:'muted small'}, 'Damage calc reference: c4vv’s PokeMMO Damage Calc (Gen 5) — link.'),
      el('div', {class:'muted small'}, [
        el('a', {href:'https://c4vv.github.io/pokemmo-damage-calc/?gen=5', target:'_blank', rel:'noreferrer'}, 'c4vv.github.io/pokemmo-damage-calc'),
      ]),
      el('div', {class:'muted small'}, 'Data contributions: [MÜSH] Alphy, [MÜSH] KaoZPrime.'),
      el('div', {class:'muted small'}, 'Groundwork: [MÜSH] TTVxSenseiNESS and RuthlessZ (LNY Event 2024 & 2025).'),
      el('div', {class:'muted small'}, 'Sprites: Pokémon Database (pokemondb.net / img.pokemondb.net).'),
      el('div', {class:'muted small'}, 'Pokédex / evolutions: PokéAPI.'),
      el('div', {class:'muted small'}, 'Pokémon is © Nintendo / Creatures Inc. / GAME FREAK inc. This is an unofficial fan tool.'),
      el('hr'),
      el('div', {class:'panel-subtitle'}, 'Impressum'),
      el('div', {class:'muted small'}, 'Private community tool for Team MÜSH. Non-commercial. No affiliation with Nintendo / GAME FREAK / Creatures.'),
      el('div', {class:'muted small'}, 'Contact: PaulusTFT (update as needed).'),
    ]);

    // Layout tags (CSS grid areas)
    pAbout.classList.add('settings-about');
    pCore.classList.add('settings-core');
    pThreat.classList.add('settings-threat');
    pDefaults.classList.add('settings-defaults');
    pTools.classList.add('settings-tools');

    // Cleaner layout: grid flow + fewer compartments.
    // Layout: three columns (left/about+tools, middle/core, right/threat+defaults)
    // This avoids CSS-grid row stretching gaps on wide screens and keeps the page feeling "placed".
    tabSettings.appendChild(el('div', {class:'settings-layout'}, [
      el('div', {class:'settings-col settings-col-left'}, [pAbout, pTools]),
      el('div', {class:'settings-col settings-col-mid'}, [pCore]),
      el('div', {class:'settings-col settings-col-right'}, [pThreat, pDefaults]),
    ]));
  }

  // ---------------- Render orchestrator ----------------

  // Chrome DevTools "Issues" will otherwise report hundreds of unlabeled/id-less fields.
  // We generate hidden labels + ids/names after each render pass.
  let __a11yQueued = false;
  function scheduleA11y(){
    if (__a11yQueued) return;
    __a11yQueued = true;
    requestAnimationFrame(()=>{
      __a11yQueued = false;
      ensureFormFieldA11y(document);
    });
  }


  function render(){
    const state = store.getState();

    renderTabs(state);
    updateHeaderCounts(state);
    renderOverview(state);

    if (state.ui.tab === 'waves') renderWaves(state);
    else if (state.ui.tab === 'roster') renderRoster(state);
    else if (state.ui.tab === 'bag') renderBag(state);
    else if (state.ui.tab === 'settings') renderSettings(state);
    else if (state.ui.tab === 'sim') renderSim(state);
    else if (state.ui.tab === 'unlocked') renderUnlocked(state);
    scheduleA11y();
  }

  attachTabHandlers();
  attachOverviewToggle();

  return { render };
}