// js/app/app.js
// v2.0.0-beta
// Abundant Shrine — Roster Planner UI + orchestration (Waves tab planner UX + auto-match display)

import { $, $$, el, pill, formatPct, clampInt, sprite, spriteAnim } from '../ui/dom.js';
import { fixName } from '../data/nameFixes.js';
import {
  makeRosterEntryFromClaimedSet,
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
  bestAssignmentForWavePair,
  phaseDefenderLimit,
  speciesListFromSlots,
} from '../domain/waves.js';
import { initBattleForWave, stepBattleTurn, resetBattle, setManualAction, chooseReinforcement, ensurePPForRosterMon, setPP, battleLabelForRowKey, DEFAULT_MOVE_PP } from '../domain/battle.js';
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
import { applyMovesetOverrides, defaultNatureForSpecies } from '../domain/shrineRules.js';

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

function uniq(arr){
  return Array.from(new Set((arr||[]).filter(Boolean)));
}

function rosterLabel(r){
  const eff = r.effectiveSpecies || r.baseSpecies;
  if (eff !== r.baseSpecies) return `${eff} (${r.baseSpecies})`;
  return eff;
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
  const tabUnlocked = $('#tabUnlocked');
  const unlockedCountEl = $('#unlockedCount');

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
      if (baseCache[s]) continue;
      if (baseInFlight.has(s)) continue;
      baseInFlight.add(s);
      pokeApi.resolveBaseNonBaby(s, baseCache)
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
      if (baseCache[s]) continue;
      if (baseInFlight.has(s)) continue;
      baseInFlight.add(s);
      pokeApi.resolveBaseNonBaby(s, baseCache)
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

    // Fetch evo lines (non-baby) for bases.
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
          if (Array.isArray(line) && line.length) updatesEvo[root] = line;
          else updatesEvo[root] = [root];
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

  function parseLevelUpMovesBW(pokeJson){
    const out = [];
    for (const mv of (pokeJson?.moves||[])){
      const name = mv?.move?.name;
      if (!name) continue;
      for (const d of (mv?.version_group_details||[])){
        const vg = d?.version_group?.name || '';
        const meth = d?.move_learn_method?.name || '';
        const lvl = Number(d?.level_learned_at);
        if (meth !== 'level-up') continue;
        if (vg !== 'black-white' && vg !== 'black-2-white-2') continue;
        if (!Number.isFinite(lvl)) continue;
        out.push({ level: lvl, move: name });
      }
    }
    out.sort((a,b)=>a.level-b.level || a.move.localeCompare(b.move));
    const seen = new Set();
    return out.filter(x=>{
      const k = `${x.level}|${x.move}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
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

      // NOTE: We intentionally do NOT surface PokéAPI abilities/movesets in the UI.
      // Shrine rules: each species has a fixed 4-move set + fixed ability unless the
      // user provides an explicit exception.

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
            s.ui.dexReturnRosterId = null;
            s.ui.dexReturn = null; // legacy
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
          s.ui.dexReturnRosterId = null;
          s.ui.dexReturn = null; // legacy
        });
      });
    });
  }

  function attachOverviewToggle(){
    if (!ovToggle) return;
    ovToggle.addEventListener('click', ()=>{
      store.update(s=>{ s.ui.overviewCollapsed = !s.ui.overviewCollapsed; });
    });
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
      ovSprite.dataset.fallbackTried = '0';
      ovSprite.src = sprite(calc, defName);
      ovSprite.onerror = ()=>{
        if (ovSprite.dataset.fallbackTried !== '1'){
          ovSprite.dataset.fallbackTried = '1';
          ovSprite.src = spriteAnim(calc, defName);
          return;
        }
        ovSprite.style.opacity = '0.25';
      };
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
      img.dataset.fallbackTried = '0';
      img.onerror = ()=>{
        if (img.dataset.fallbackTried !== '1'){
          img.dataset.fallbackTried = '1';
          img.src = spriteAnim(calc, eff);
          return;
        }
        img.style.opacity='0.25';
      };

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
      const speedPill = row.best.slower ? pill('SLOW','warn') : pill('OK','good');
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
        el('td', {}, best.slower ? pill('SLOW','warn') : pill('OK','good')),
        el('td', {}, best.oneShot ? pill('OHKO','good') : pill('NO','bad')),
      ]));
    }
    tbl.appendChild(tbody);
    return tbl;
  }

  // ---------------- Waves ----------------

  function renderWaves(state){
    tabWaves.innerHTML = '';

    const waves = groupBy(data.calcSlots, s => s.waveKey);
    const waveKeys = Object.keys(waves).sort((a,b)=>waveOrderKey(a)-waveOrderKey(b));

    const startAnimal = state.settings?.startWaveAnimal || state.settings?.startAnimal || 'Goat';

    const byPhase = {1:[],2:[],3:[]};
    for (const wk of waveKeys){
      const m = /^P(\d+)W(\d+)$/.exec(wk);
      if (!m) continue;
      const p = Number(m[1]);
      if (byPhase[p]) byPhase[p].push(wk);
    }
    for (const p of [1,2,3]){
      byPhase[p].sort((a,b)=>waveOrderKey(a)-waveOrderKey(b));
    }

    function rotateToAnimal(list){
      if (!Array.isArray(list) || !list.length) return [];
      const idx = list.findIndex(wk => (waves[wk]?.[0]?.animal) === startAnimal);
      if (idx <= 0) return list.slice();
      return list.slice(idx).concat(list.slice(0, idx));
    }

    const phaseOrder = {
      1: rotateToAnimal(byPhase[1]),
      2: rotateToAnimal(byPhase[2]),
      3: rotateToAnimal(byPhase[3]),
    };

    const sections = [
      {title:'Phase 1', phase:1, startIdx:0, count:12, bossAfter:true},
      {title:'Phase 2 — Part 1', phase:2, startIdx:0, count:6, bossAfter:true},
      {title:'Phase 2 — Part 2', phase:2, startIdx:6, count:6, bossAfter:true},
      {title:'Phase 3 — Part 1', phase:3, startIdx:0, count:6, bossAfter:true},
      {title:'Phase 3 — Part 2', phase:3, startIdx:6, count:6, bossAfter:true},
    ];

    for (const sec of sections){
      const list = phaseOrder[sec.phase] || [];
      const inSec = list.slice(sec.startIdx, sec.startIdx + sec.count);

      tabWaves.appendChild(el('div', {}, [
        el('div', {class:'section-title'}, [
          el('div', {}, [
            el('div', {}, sec.title),
            el('div', {class:'section-sub'}, `Run waves ${sec.startIdx+1}–${sec.startIdx+sec.count} · start: ${startAnimal}`),
          ]),
        ]),
      ]));

      for (let i=0;i<inSec.length;i++){
        const wk = inSec[i];
        const runWave = sec.startIdx + i + 1;
        tabWaves.appendChild(renderWaveCard(state, wk, waves[wk], {runWave}));
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

  function renderWaveCard(state, waveKey, slots, meta){
    const expanded = !!state.ui.waveExpanded[waveKey];
    const first = slots[0];
    const runWave = Number(meta?.runWave) || Number(first.wave) || 1;
    const title = `P${first.phase} • Wave ${runWave} • ${first.animal} • Lv ${first.level}`;

    const btn = el('button', {class:'btn-mini'}, expanded ? 'Collapse' : 'Expand');
    btn.addEventListener('click', ()=>{
      store.update(s => { s.ui.waveExpanded[waveKey] = !expanded; });
    });

    const head = el('div', {class:'wave-head'}, [
      el('div', {class:'wave-left'}, [
        el('div', {}, [
          el('div', {class:'wave-title'}, title),
          el('div', {class:'wave-meta'}, `Phase ${first.phase} · Wave ${runWave} · ${slots.length} defenders · key ${waveKey}`),
        ]),
      ]),
      el('div', {class:'wave-actions'}, [btn]),
    ]);

    const body = el('div', {class:'wave-body ' + (expanded ? '' : 'hidden')});

    if (expanded){
      prefetchBaseForSlots(slots);
      const wp = state.wavePlans?.[waveKey] || null;
      body.appendChild(renderWavePlanner(state, waveKey, slots, wp));
    }

    return el('div', {class:'wave-card' + (expanded ? ' expanded' : '')}, [head, body]);
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

    // Enemy slots (duplicates allowed): the shrine can roll the same species multiple times in a fight.
    const enemyKeys = (function(){
      const raw = Array.isArray(wp.enemySlots)
        ? wp.enemySlots
        : (Array.isArray(wp.defenders) ? wp.defenders : []);
      const out = raw.slice(0, defLimit).map(x=>x||null);
      while (out.length < defLimit) out.push(null);
      for (let i=0;i<out.length;i++){
        if (out[i] && !slotByKey.has(out[i])) out[i] = null;
      }
      return out;
    })();

    // Wave loot: fixed bundles. Selecting a loot item immediately adds it to the shared Bag.
    const lootPanel = el('div', {class:'panel', style:'margin-bottom:10px'}, [
      el('div', {class:'panel-title'}, 'Wave loot')
    ]);

    const fixedLoot = (data.waveLoot && data.waveLoot[waveKey]) ? data.waveLoot[waveKey] : null;
    const fixedName = (fixedLoot && typeof fixedLoot === 'string') ? fixedLoot : null;

    // Avoid duplicate-looking bundle entries in the loot dropdown.
    // Keep legacy values if they are already selected in an existing save.
    const curWaveItem = wp.waveItem || null;
    let lootOptions = fixedName
      ? [fixedName]
      : ITEM_CATALOG.slice()
        // Prefer explicit bundle SKUs for loot.
        .filter(n => n !== 'Air Balloon' && n !== 'Copper Coin');
    if (curWaveItem && !lootOptions.includes(curWaveItem)) lootOptions = [curWaveItem, ...lootOptions];

    const lootSel = el('select', {style:'min-width:320px'}, [
      el('option', {value:''}, fixedName ? '— claim loot —' : '— not set —'),
      ...lootOptions.map(name => {
        const b = lootBundle(name);
        const label = b ? `${b.key}${b.qty>1 ? ` (x${b.qty})` : ''}` : name;
        return el('option', {value:name, selected:(wp.waveItem===name)}, label);
      }),
    ]);

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
        const w = s.wavePlans[waveKey];
        const prevItem = w.waveItem || null;

        // Bag reflects current wave selection: remove previous, add next.
        if (prevItem) applyLootDelta(s, prevItem, -1);
        w.waveItem = nextItem;
        if (w.waveItem) applyLootDelta(s, w.waveItem, +1);

        // Enforce shared bag constraints (charms/items can't exceed totals)
        enforceBagConstraints(data, s, applyCharmRulesSync);
      });
    }

    lootSel.addEventListener('change', ()=>{
      const next = lootSel.value || null;
      updateLootInState(next);
    });

    lootPanel.appendChild(el('div', {class:'muted small'}, fixedName
      ? 'This wave has fixed loot. Selecting it adds it to the shared Bag (gems are x5, Rare Candy can be x1/x2).'
      : 'Pick the loot for this wave. Selecting it adds it to the shared Bag (gems are x5, Rare Candy can be x1/x2).'
    ));
    lootPanel.appendChild(el('div', {style:'display:flex; gap:10px; flex-wrap:wrap; align-items:center'}, [
      el('div', {class:'field', style:'margin:0'}, [el('label', {}, 'Loot'), lootSel]),
    ]));

    function commitSelected(){
      store.update(s => {
        ensureWavePlan(data, s, waveKey, slots);
        const w = s.wavePlans[waveKey];
        w.manualDefenders = true;

        // Persist slots exactly as chosen (duplicates allowed).
        w.enemySlots = enemyKeys.slice(0, defLimit);
        w.defenders = w.enemySlots.filter(Boolean).slice(0, defLimit);

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
      inp.addEventListener('pointerdown', (e)=> e.stopPropagation());
      inp.addEventListener('click', (e)=> e.stopPropagation());
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
      return el('div', {class:'modrow'}, [
        chip('HP%', hpPctInput(dm.hpPct, v=>patchDefMods(slotObj.rowKey,{hpPct:v}))),
        chip('Atk', stageSel(dm.atkStage, v=>patchDefMods(slotObj.rowKey,{atkStage:v}))),
        chip('SpA', stageSel(dm.spaStage, v=>patchDefMods(slotObj.rowKey,{spaStage:v}))),
        chip('Def', stageSel(dm.defStage, v=>patchDefMods(slotObj.rowKey,{defStage:v}))),
        chip('SpD', stageSel(dm.spdStage, v=>patchDefMods(slotObj.rowKey,{spdStage:v}))),
        chip('Spe', stageSel(dm.speStage, v=>patchDefMods(slotObj.rowKey,{speStage:v}))),
      ]);
    }

    // attacker mods are edited on the Roster tab

    // Enemy picker
    const enemyList = el('div', {class:'pick-grid'});

    function enemyOptionLabel(s){
      return `${s.defender} • Lv ${s.level} • #${s.slot}`;
    }

    function slotTag(i){
      if (defLimit === 2) return i === 0 ? 'A' : 'B';
      return String(i + 1);
    }

    function tagsForRow(rowKey){
      const tags = [];
      for (let i=0;i<enemyKeys.length;i++){
        if (enemyKeys[i] === rowKey) tags.push(slotTag(i));
      }
      return tags;
    }

    function setEnemySlot(idx, rowKey){
      enemyKeys[idx] = rowKey || null;
      commitSelected();
    }

    function fillNextEnemySlot(rowKey){
      const empty = enemyKeys.findIndex(x=>!x);
      const idx = (empty >= 0) ? empty : (enemyKeys.length - 1);
      enemyKeys[idx] = rowKey;
      commitSelected();
    }

    const selectedEnemiesPanel = (()=>{
      const makeEnemySel = (idx)=>{
        const value = enemyKeys[idx] || '';
        const sel = el('select', {class:'sel-mini'}, [
          el('option', {value:'', selected: !value}, '— empty —'),
          ...slots.map(s=>el('option', {
            value:s.rowKey,
            selected:s.rowKey===value,
          }, enemyOptionLabel(s))),
        ]);
        sel.addEventListener('change', ()=> setEnemySlot(idx, sel.value || null));
        sel.addEventListener('pointerdown', (e)=> e.stopPropagation());
        sel.addEventListener('click', (e)=> e.stopPropagation());
        return sel;
      };

      const rows = [];
      for (let i=0;i<defLimit;i++){
        const label = (defLimit === 2) ? (i===0 ? 'Enemy A' : 'Enemy B') : `Enemy ${i+1}`;
        const btn = el('button', {class:'btn-mini'}, 'Clear slot');
        btn.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); setEnemySlot(i, null); });
        rows.push(el('div', {class:'enemy-slot-row'}, [
          el('div', {class:'lbl'}, label),
          makeEnemySel(i),
          btn,
        ]));
      }

      const clearAll = el('button', {class:'btn-mini'}, 'Clear all');
      clearAll.addEventListener('click', (e)=>{
        e.preventDefault(); e.stopPropagation();
        for (let i=0;i<enemyKeys.length;i++) enemyKeys[i] = null;
        commitSelected();
      });

      return el('div', {class:'enemy-slots'}, [
        el('div', {class:'muted small'}, `Selected enemies (${defLimit} slot${defLimit===1?'':'s'}). Duplicates are allowed. Click a row to fill the next empty slot.`),
        ...rows,
        el('div', {style:'display:flex; justify-content:flex-end;'}, [clearAll]),
      ]);
    })();

    for (const s of slots){
      const tags = tagsForRow(s.rowKey);
      const checked = tags.length > 0;

      const base = pokeApi.baseOfSync(s.defender, state.baseCache||{});
      const isUnlocked = !!state.unlocked?.[base];


      const sp = el('img', {class:'sprite sprite-lg', src:sprite(calc, s.defender), alt:s.defender});
      sp.dataset.fallbackTried = '0';
      sp.onerror = ()=>{
        if (sp.dataset.fallbackTried !== '1'){
          sp.dataset.fallbackTried = '1';
          sp.src = spriteAnim(calc, s.defender);
          return;
        }
        sp.style.opacity='0.25';
      };
      sp.addEventListener('pointerdown', (e)=> e.stopPropagation());
      sp.addEventListener('click', (e)=>{ e.stopPropagation(); showOverviewForSlot(s); });

      const tagText = tags.join(',');
      const leftControl = el('div', {class:'slotbadge' + (tagText ? ' on' : '')}, tagText || '');

      const rowEl = el('div', {class:'pick-item' + (checked ? ' selected' : '') + (isUnlocked ? ' unlocked':'' )}, [
        leftControl,
        sp,
        el('div', {class:'pick-meta'}, [
          el('div', {class:'pick-title'}, s.defender),
          el('div', {class:'pick-sub'}, `Lv ${s.level}` + ((s.tags||[]).length ? ` · ${s.tags.join(',')}` : '')),
          buildDefModRow(s),
        ]),
        (isUnlocked ? pill('Unlocked','good') : null),
      ]);

      rowEl.addEventListener('click', ()=> fillNextEnemySlot(s.rowKey));
      // Right click: unselect this defender from the chosen enemy slots (convenience for duplicates).
      rowEl.addEventListener('contextmenu', (e)=>{
        e.preventDefault();
        e.stopPropagation();
        // Remove the last occurrence of this rowKey from the enemy slot selection.
        const idx = enemyKeys.lastIndexOf(s.rowKey);
        if (idx >= 0){
          enemyKeys[idx] = null;
          commitSelected();
        }
      });

      enemyList.appendChild(rowEl);
    }

    const activeRoster = state.roster.filter(r=>r.active).slice(0,16);

    const MAX_FIGHTS_PER_WAVE = 4;
    const fightCount = Array.isArray(wp.fightLog) ? wp.fightLog.length : 0;

    // Fight plan + suggestions
    const fightBtn = el('button', {class:'btn-mini'}, 'Fight');
    fightBtn.title = 'Simulate this wave fight: consumes PP, marks slots cleared, and unlocks base species.';
    if (fightCount >= MAX_FIGHTS_PER_WAVE) fightBtn.disabled = true;

    const undoBtn = el('button', {class:'btn-mini'}, 'Undo');
    undoBtn.title = 'Undo the last Fight for this wave (restores PP, cleared flags, unlocks, and fight log).';
    if (fightCount <= 0) undoBtn.disabled = true;

    const autoFightBtn = el('button', {class:'btn-mini'}, 'Auto x4');
    autoFightBtn.title = 'Automatically runs fights for this wave (up to the remaining cap). Tries to cover as many species as possible and maximize P1 OHKOs.';
    autoFightBtn.disabled = (activeRoster.length < 2);

    const countLabel = el('span', {class:'muted small'}, `Fights: ${fightCount}/${MAX_FIGHTS_PER_WAVE}`);

    // Auto-solve cycling hint (when multiple alternatives exist)
    const altHint = el('span', {class:'muted small', style:'white-space:nowrap'}, '');
    const altsLen = (wp.solve?.alts || []).length;
    if (altsLen > 1){
      const curIdx = ((Number(wp.solve?.idx) || 0) % altsLen + altsLen) % altsLen;
      altHint.textContent = `Alt ${curIdx+1}/${altsLen}`;
      altHint.title = 'Click Auto x4 to cycle alternatives.';
    } else {
      altHint.textContent = '';
    }

    const planEl = el('div', {class:'panel'}, [
      el('div', {style:'display:flex; align-items:center; justify-content:space-between; gap:10px'}, [
        el('div', {class:'panel-title'}, 'Fight plan'),
        el('div', {style:'display:flex; align-items:center; gap:8px'}, [countLabel, fightBtn, undoBtn, autoFightBtn, altHint]),
      ]),
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
    // If a move is forced here, Auto x4 + battle sim will only use that move for that attacker in this wave.
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

    const clearMoveOverridesBtn = el('button', {class:'btn-mini'}, 'Clear moves');
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

    const allDef = (wp.enemySlots || wp.defenders || [])
      .slice(0, defLimit)
      .map(k=>{
        const o = slotByKey2.get(k);
        return o ? {...o} : null;
      })
      .filter(Boolean);

    const startersOrdered = (wp.attackerOrder||wp.attackerStart||[])
      .slice(0,2)
      .map(id=>byId(state.roster,id))
      .filter(Boolean);

    const showThreat = (state.settings?.threatModelEnabled ?? true);

    function threatTooltip(threat){
      if (!threat) return '';
      const mv = threat.move || '—';
      const type = threat.moveType || '—';
      const cat = threat.category || '—';
      const min = formatPct(threat.minPct);
      const reason = threat.reason || '';
      const assumed = threat.assumed ? ' (assumed)' : '';
      return `${mv}${assumed}
${type} · ${cat}
min: ${min}
${reason}`;
    }

    function defenderTargetPick(ds){
      const a0 = startersOrdered[0] || null;
      const a1 = startersOrdered[1] || null;
      const t0 = a0 ? (enemyThreatForMatchup(data, state, wp, a0, ds) || assumedEnemyThreatForMatchup(data, state, wp, a0, ds)) : null;
      const t1 = a1 ? (enemyThreatForMatchup(data, state, wp, a1, ds) || assumedEnemyThreatForMatchup(data, state, wp, a1, ds)) : null;

      if (t0 && !t1) return {attacker:a0, threat:t0};
      if (!t0 && t1) return {attacker:a1, threat:t1};
      if (!t0 && !t1) return {attacker:null, threat:null};

      const aMin = Number(t0.minPct)||0;
      const bMin = Number(t1.minPct)||0;
      const aMax = Number.isFinite(Number(t0.maxPct)) ? Number(t0.maxPct) : aMin;
      const bMax = Number.isFinite(Number(t1.maxPct)) ? Number(t1.maxPct) : bMin;
      const aAvg = (aMin + aMax) / 2;
      const bAvg = (bMin + bMax) / 2;

      // Defender targets the attacker it can damage the most: avg% → max% → min%.
      if (aAvg !== bAvg) return aAvg > bAvg ? {attacker:a0, threat:t0} : {attacker:a1, threat:t1};
      if (aMax !== bMax) return aMax > bMax ? {attacker:a0, threat:t0} : {attacker:a1, threat:t1};
      if (aMin !== bMin) return aMin > bMin ? {attacker:a0, threat:t0} : {attacker:a1, threat:t1};
      return {attacker:a0, threat:t0};
    }
	function bestMoveFor(attackerMon, ds){
      if (!attackerMon || !ds) return null;
      const defObj = {species:ds.defender, level:ds.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
	      // Respect PP: moves at 0 PP are treated as unusable.
	      let pool = (attackerMon.movePool||[]).filter(m=>{
        if (!m || m.use === false) return false;
        const pp = Number.isFinite(Number(m.pp)) ? Number(m.pp) : 12;
        return pp > 0;
      });
      const forced = (wp && wp.attackMoveOverride) ? (wp.attackMoveOverride[attackerMon.id] || null) : null;
      if (forced){
        const filtered = pool.filter(m=>m && m.name === forced);
        if (filtered.length) pool = filtered;
      }
      return calc.chooseBestMove({
        data,
        attacker:{
          species:(attackerMon.effectiveSpecies||attackerMon.baseSpecies),
          level: state.settings.claimedLevel,
          ivAll: state.settings.claimedIV,
          evAll: attackerMon.strength ? state.settings.strengthEV : state.settings.claimedEV,
        },
        defender:defObj,
	        movePool: pool,
        settings: settingsForWave(state, wp, attackerMon.id, ds.rowKey),
        tags: ds.tags||[],
      }).best;
    }

    function betterPick(aMon, aBest, bMon, bBest){
      if (!aBest && !bBest) return {attacker:null, best:null};
      if (aBest && !bBest) return {attacker:aMon, best:aBest};
      if (!aBest && bBest) return {attacker:bMon, best:bBest};

      const ao = aBest.oneShot ? 1 : 0;
      const bo = bBest.oneShot ? 1 : 0;
      if (ao !== bo) return ao > bo ? {attacker:aMon, best:aBest} : {attacker:bMon, best:bBest};

      const ap = Number.isFinite(aBest.prio) ? aBest.prio : 3;
      const bp = Number.isFinite(bBest.prio) ? bBest.prio : 3;
      if (ap !== bp) return ap < bp ? {attacker:aMon, best:aBest} : {attacker:bMon, best:bBest};

      const da = Math.abs((Number(aBest.minPct)||0) - 100);
      const db = Math.abs((Number(bBest.minPct)||0) - 100);
      if (da !== db) return da < db ? {attacker:aMon, best:aBest} : {attacker:bMon, best:bBest};

      if (!!aBest.slower !== !!bBest.slower) return aBest.slower ? {attacker:bMon, best:bBest} : {attacker:aMon, best:aBest};
      if (!!aBest.stab !== !!bBest.stab) return aBest.stab ? {attacker:aMon, best:aBest} : {attacker:bMon, best:bBest};

      const am = Number(aBest.minPct)||0;
      const bm = Number(bBest.minPct)||0;
      if (am !== bm) return am > bm ? {attacker:aMon, best:aBest} : {attacker:bMon, best:bBest};

      return String(aBest.move||'').localeCompare(String(bBest.move||'')) <= 0
        ? {attacker:aMon, best:aBest}
        : {attacker:bMon, best:bBest};
    }


    

    // ---------------- Fight controls + fight log (battle sim) ----------------
    // Models the 4 in-game fights for this wave. Each entry is undoable individually (claims + PP deltas).

    function baseDefKey(k){
      return String(k || '').split('#')[0];
    }
    function formatPrioAvg(x){
      const n = Number(x);
      if (!Number.isFinite(n) || n >= 9) return '—';
      return n.toFixed(1);
    }

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
      for (const rkRaw of Object.keys(s.cleared||{})){
        if (!s.cleared[rkRaw]) continue;
        const rk = String(rkRaw);
        const b = baseByRowKey.get(baseDefKey(rk)) || baseByRowKey.get(rk);
        if (b === base) return true;
      }
      return false;
    };

    const getFightLog = ()=> (store.getState().wavePlans?.[waveKey]?.fightLog || []);

    const undoEntryById = (entryId)=>{
      store.update(s=>{
        const w = s.wavePlans?.[waveKey];
        if (!w || !Array.isArray(w.fightLog)) return;
        const idx = w.fightLog.findIndex(e=>e.id===entryId);
        if (idx < 0) return;
        const entry = w.fightLog[idx];
        w.fightLog.splice(idx, 1);

        // Restore PP on movePool.
        for (const d of (entry.ppDelta||[])){
          const mon = byId(s.roster||[], d.monId);
          if (!mon) continue;
          const mv = (mon.movePool||[]).find(m=>m && m.use !== false && m.name === d.move);
          if (!mv) continue;
          mv.ppMax = Number.isFinite(Number(mv.ppMax)) ? Math.max(1, Math.floor(Number(mv.ppMax))) : (Number(d.prevMax)||12);
          mv.pp = Number.isFinite(Number(d.prevCur)) ? Math.max(0, Math.floor(Number(d.prevCur))) : mv.pp;
        }

        // Restore Bag + held items (for consumables like Gems) if this entry changed them.
        if (Array.isArray(entry.bagDelta)){
          s.bag = s.bag || {};
          for (const bd of entry.bagDelta){
            const key = String(bd?.item || '');
            if (!key) continue;
            const prev = Number(bd?.prevQty || 0);
            if (!(prev > 0)) delete s.bag[key];
            else s.bag[key] = prev;
          }
        }
        if (Array.isArray(entry.itemDelta)){
          for (const idd of entry.itemDelta){
            const mon = byId(s.roster||[], idd.monId);
            if (!mon) continue;
            mon.item = idd.prevItem || null;
          }
        }

        // Revert claims for this entry if no other remaining log entry still claims them.
        const stillClaimed = new Set();
        for (const e of (w.fightLog||[])) for (const rk of (e.claimRowKeys||[])) stillClaimed.add(String(rk));

        const affectedBases = new Set(entry.claimBases||[]);
        for (const rkRaw of (entry.claimRowKeys||[])){
          const rk = String(rkRaw||'');
          if (!rk) continue;
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
      for (const id of ids) undoEntryById(id);
    };

    const pushEntry = (s, w, entry)=>{
      if (!entry) return;
      w.fightLog = Array.isArray(w.fightLog) ? w.fightLog : [];
      if (w.fightLog.length >= 4) return;

      // Apply claims.
      s.unlocked = s.unlocked || {};
      s.cleared = s.cleared || {};
      for (const b of (entry.claimBases||[])) s.unlocked[b] = true;
      for (const rk of (entry.claimRowKeys||[])) s.cleared[rk] = true;

      // Add to bottom (oldest first).
      w.fightLog.push(entry);
    };

    const snapshotPP = (s, monId)=>{
      const mon = byId(s.roster||[], monId);
      if (!mon) return {};
      ensurePPForRosterMon(s, mon);
      const out = {};
      for (const mv of (mon.movePool||[])){
        if (!mv || mv.use === false || !mv.name) continue;
        out[mv.name] = {cur: Number(mv.pp ?? mv.ppMax ?? 12), max: Number(mv.ppMax ?? 12)};
      }
      return out;
    };

    const makeFightEntry = (s, wpLocal, aId, bId, defKeys)=>{
      const aMon = byId(s.roster||[], aId);
      const bMon = byId(s.roster||[], bId);
      const defs = (defKeys||[]).filter(Boolean);
      if (!aMon || !bMon) return null;
      if (String(aId) === String(bId)) return null;
      if (defs.length < 2) return null;

      // Snapshot bag + held items (gems / consumables can be consumed during sim).
      const bagBefore = {...(s.bag||{})};
      const itemsBefore = (s.roster||[]).map(r=>({monId:r.id, item:r.item || null}));

      // Snapshot PP before
      const ppBeforeA = snapshotPP(s, aId);
      const ppBeforeB = snapshotPP(s, bId);

      const tmpKey = `${waveKey}__log_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      s.wavePlans = s.wavePlans || {};
      s.battles = s.battles || {};
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

      // Auto-run until won/lost, auto-picking reinforcements in order.
      let guard = 0;
      while (guard++ < 80 && s.battles?.[tmpKey]?.status === 'active'){
        const bb = s.battles[tmpKey];
        if (bb.pending){
          const side = bb.pending.side;
          const slotIndex = bb.pending.slotIndex;
          const choice = (side === 'def') ? bb.def.bench?.[0] : bb.atk.bench?.[0];
          if (choice) chooseReinforcement(s, tmpKey, side, slotIndex, choice);
          else bb.pending = null;
          continue;
        }
        stepBattleTurn({data, calc, state:s, waveKey: tmpKey, slots});
      }

      const bb = s.battles?.[tmpKey];
      const status = bb?.status || 'active';
      const logLines = (bb?.log || []).slice(1);
      const atkHist = (bb?.history || []).filter(x=>x.side==='atk');
      const prioAvg = atkHist.length ? (atkHist.reduce((sum,x)=>sum + (Number(x.prio)||9), 0) / atkHist.length) : 9;

      // Snapshot bag + held items after
      const bagAfter = {...(s.bag||{})};
      const itemsAfter = (s.roster||[]).map(r=>({monId:r.id, item:r.item || null}));

      // Snapshot PP after and compute delta
      const ppAfterA = snapshotPP(s, aId);
      const ppAfterB = snapshotPP(s, bId);
      const ppDelta = [];
      // Claims: selected defenders by BASE rowKey
      const claimRowKeys = Array.from(new Set(defs.map(k=>baseDefKey(k))));
      const claimBases = claimRowKeys.map(rk=>{
        const sl = slotByKey2.get(rk);
        return sl ? pokeApi.baseOfSync(sl.defender, baseCache) : rk;
      });

      delete s.battles[tmpKey];
      delete s.wavePlans[tmpKey];

      const lines = [
        `ATTACKERS: ${rosterLabel(aMon)} + ${rosterLabel(bMon)} · DEFENDERS: ${defs.map((rk,i)=>`#${i+1} ${(slotByKey2.get(baseDefKey(rk))?.defender || rk)}`).join(' · ')}`,
        ...logLines,
        status === 'won' ? 'Result: WON' : (status === 'lost' ? 'Result: LOST' : `Result: ${status}`),
      ];

      return {
        id: `f${Date.now()}_${Math.random().toString(16).slice(2)}`,
        ts: Date.now(),
        attackers: [aId,bId],
        defenders: defs.slice(),
        prioAvg,
        lines,
        claimRowKeys,
        claimBases,
        ppDelta,
        bagDelta: [],
        itemDelta: [],
        __ppBeforeA: ppBeforeA,
        __ppBeforeB: ppBeforeB,
        __ppAfterA: ppAfterA,
        __ppAfterB: ppAfterB,
        __bagBefore: bagBefore,
        __bagAfter: bagAfter,
        __itemsBefore: itemsBefore,
        __itemsAfter: itemsAfter,
      };
    };

    // Fix ppDelta in the returned entry (JS diff) and drop private fields.
    const finalizeEntry = (entry, aId, bId)=>{
      if (!entry) return null;
      const ppDelta = [];
      const diff = (before, after, monId)=>{
        for (const [mv, a] of Object.entries(after||{})){
          const b = before?.[mv];
          const prevCur = Number(b?.cur ?? a?.cur ?? 12);
          const prevMax = Number(b?.max ?? a?.max ?? 12);
          const nextCur = Number(a?.cur ?? prevCur);
          if (prevCur !== nextCur){
            ppDelta.push({monId, move: mv, prevCur, prevMax, nextCur});
          }
        }
      };
      diff(entry.__ppBeforeA, entry.__ppAfterA, aId);
      diff(entry.__ppBeforeB, entry.__ppAfterB, bId);
      entry.ppDelta = ppDelta;

      // Bag delta (consumables / bundles)
      const bagDelta = [];
      const bb = entry.__bagBefore || {};
      const ba = entry.__bagAfter || {};
      const bagKeys = new Set([...Object.keys(bb), ...Object.keys(ba)]);
      for (const k of bagKeys){
        const prevQty = Number(bb[k] || 0);
        const nextQty = Number(ba[k] || 0);
        if (prevQty !== nextQty){
          bagDelta.push({item:k, prevQty, nextQty});
        }
      }
      entry.bagDelta = bagDelta;

      // Held item delta (e.g. gem consumed clears the held slot)
      const itemDelta = [];
      const ib = new Map((entry.__itemsBefore||[]).map(x=>[String(x.monId), x.item || null]));
      const ia = (entry.__itemsAfter||[]);
      for (const row of ia){
        const id = String(row.monId);
        const prevItem = ib.has(id) ? (ib.get(id) || null) : null;
        const nextItem = row.item || null;
        if (prevItem !== nextItem){
          itemDelta.push({monId: row.monId, prevItem, nextItem});
        }
      }
      entry.itemDelta = itemDelta;

      delete entry.__ppBeforeA; delete entry.__ppBeforeB; delete entry.__ppAfterA; delete entry.__ppAfterB;
      delete entry.__bagBefore; delete entry.__bagAfter; delete entry.__itemsBefore; delete entry.__itemsAfter;
      return entry;
    };

    // Buttons
    const fightBtn2 = fightBtn; // reuse existing button instances
    const undoBtn2 = undoBtn;
    const auto4Btn2 = autoFightBtn;

    fightBtn2.disabled = (fightCount >= 4);
    undoBtn2.disabled = (fightCount <= 0);
    auto4Btn2.disabled = (activeRoster.length < 2);

    fightBtn2.addEventListener('click', ()=>{
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
        let entry = makeFightEntry(s, ww, atks[0], atks[1], defs);
        entry = finalizeEntry(entry, atks[0], atks[1]);
        pushEntry(s, ww, entry);
      });
    });

    undoBtn2.addEventListener('click', ()=>{
      const w = store.getState().wavePlans?.[waveKey];
      const list = (w?.fightLog||[]);
      const last = list.length ? list[list.length-1] : null;
      if (last) undoEntryById(last.id);
    });

auto4Btn2.addEventListener('click', ()=>{
  const st = store.getState();
  const actNow = (st.roster||[]).filter(r=>r.active);
  if (actNow.length < 2){
    alert('Need at least 2 active roster mons.');
    return;
  }

  const curW = st.wavePlans?.[waveKey] || {};

  // Build a baseline state where THIS wave's fight log is undone.
  // This ensures the solver scores moves using the true PP baseline (not the already-spent PP).
  const stBase = JSON.parse(JSON.stringify(st));
  const wBase = stBase.wavePlans?.[waveKey];
  if (wBase && Array.isArray(wBase.fightLog) && wBase.fightLog.length){
    // fightLog is oldest-first; unwind newest-first so repeated usage rewinds correctly.
    for (const e of (wBase.fightLog||[]).slice().reverse()){
      // Rewind consumables / held items (e.g. gem consumption) to the true baseline.
      if (Array.isArray(e.bagDelta)){
        stBase.bag = stBase.bag || {};
        for (const bd of e.bagDelta){
          const key = String(bd?.item || '');
          if (!key) continue;
          const prev = Number(bd?.prevQty || 0);
          if (!(prev > 0)) delete stBase.bag[key];
          else stBase.bag[key] = prev;
        }
      }
      if (Array.isArray(e.itemDelta)){
        for (const idd of e.itemDelta){
          const mon = byId(stBase.roster||[], idd.monId);
          if (!mon) continue;
          mon.item = idd.prevItem || null;
        }
      }
      for (const d of (e.ppDelta||[])){
        const mon = byId(stBase.roster||[], d.monId);
        if (!mon) continue;
        const mv = (mon.movePool||[]).find(m=>m && m.use !== false && m.name === d.move);
        if (!mv) continue;
        if (Number.isFinite(Number(d.prevMax))) mv.ppMax = Math.max(1, Math.floor(Number(d.prevMax)));
        if (Number.isFinite(Number(d.prevCur))) mv.pp = Math.max(0, Math.floor(Number(d.prevCur)));
      }
    }
  }

  const act = (stBase.roster||[]).filter(r=>r.active);
  if (act.length < 2){
    alert('Need at least 2 active roster mons.');
    return;
  }

  // Signature: wave + selection + active roster + their usable move names + baseline PP.
  const signature = (()=>{
    const parts = [];
    parts.push(`wave:${waveKey}|phase:${phase}|defLimit:${defLimit}`);
    parts.push(`sel:${(curW.defenders||[]).join(',')}`);
    parts.push(`altslack:${Number(stBase.settings?.autoAltAvgSlack ?? 0)}`);
    const ovr = curW.attackMoveOverride || {};
    const okeys = Object.keys(ovr).slice().sort((a,b)=>String(a).localeCompare(String(b)));
    const oBits = okeys.map(k => `${k}:${ovr[k]}`).join('|');
    parts.push(`ovr:${oBits}`);
    const ids = act.map(r=>r.id).slice().sort((a,b)=>String(a).localeCompare(String(b)));
    for (const id of ids){
      const r = byId(stBase.roster||[], id);
      if (!r) continue;
      ensurePPForRosterMon(stBase, r);
      const sp = (r.effectiveSpecies||r.baseSpecies||'');
      const item = r.item || '';
      const evo = r.evo ? 1 : 0;
      const str = r.strength ? 1 : 0;
      const moves = (r.movePool||[])
        .filter(m=>m && m.use !== false && m.name)
        .map(m=>m.name)
        .slice().sort((a,b)=>String(a).localeCompare(String(b)));
      const ppBits = moves.map(mn=>{
        const mv = (r.movePool||[]).find(m=>m && m.use !== false && m.name === mn);
        const cur = (mv && mv.pp !== undefined && mv.pp !== null) ? Number(mv.pp) : DEFAULT_MOVE_PP;
        return String(Number.isFinite(cur) ? cur : DEFAULT_MOVE_PP);
      }).join('/');
      parts.push(`${id}:${sp}:${item}:${evo}:${str}:${moves.join('|')}:${ppBits}`);
    }
    return parts.join('~');
  })();

  const reuse = (curW.solve && curW.solve.signature === signature && Array.isArray(curW.solve.alts) && curW.solve.alts.length);
  let alts = null;
  let idx = 0;

  if (reuse){
    alts = curW.solve.alts;
    idx = ((Number(curW.solve.idx)||0) + 1) % alts.length;
  } else {
    // Compute fresh alternatives (ported from the newer v19 solver).
    const computed = (function(){
	      const slackLocal = Math.max(0, Number(stBase.settings?.autoAltAvgSlack ?? 0));
      // Build base->slot map (we keep the first instance for each base).
      const slotForBase = new Map();
      for (const sl of slots){
        const b = pokeApi.baseOfSync(sl.defender, stBase.baseCache||{});
        if (!slotForBase.has(b)) slotForBase.set(b, sl);
      }
      const waveBases = Array.from(slotForBase.keys());
      if (!waveBases.length) return null;

      const maxFuturePhase = Math.min(3, phase + 2);
      const futureCount = (base)=>{
        let c = 0;
        for (const x of (data.calcSlots || [])){
          const ph = Number(x.phase || x.Phase || 0);
          if (!(ph > phase && ph <= maxFuturePhase)) continue;
          const sp = fixName(x.defender || x.species || x.name || '');
          const b = pokeApi.baseOfSync(sp, stBase.baseCache||{});
          if (b === base) c++;
        }
        return c;
      };

      let chosenBases = waveBases.slice().sort((a,b)=>{
        const fa = futureCount(a);
        const fb = futureCount(b);
        if (fa !== fb) return fa - fb;
        return String(a).localeCompare(String(b));
      }).slice(0, 8);

      const attIds = act.map(r=>r.id);
      const attPairs = [];
      for (let i=0;i<attIds.length;i++) for (let j=i+1;j<attIds.length;j++) attPairs.push([attIds[i],attIds[j]]);

      const bestMoveFor2 = (attId, defSlot)=>{
        const r = byId(stBase.roster, attId);
        if (!r || !defSlot) return null;
        ensurePPForRosterMon(stBase, r);
        const atk = {species:(r.effectiveSpecies||r.baseSpecies), level: stBase.settings.claimedLevel, ivAll: stBase.settings.claimedIV, evAll: r.strength?stBase.settings.strengthEV:stBase.settings.claimedEV};
        const def = {species:defSlot.defender, level:defSlot.level, ivAll: stBase.settings.wildIV, evAll: stBase.settings.wildEV};
        let mp = (r.movePool||[]).filter(m=>{
          if (!m || m.use === false || !m.name) return false;
          const pp = (m.pp !== undefined && m.pp !== null) ? Number(m.pp) : DEFAULT_MOVE_PP;
          return Number.isFinite(pp) ? pp > 0 : true;
        });
        const forced = (stBase.wavePlans?.[waveKey]?.attackMoveOverride||{})[attId] || null;
        if (forced){
          const filtered = mp.filter(m=>m && m.name === forced);
          if (filtered.length) mp = filtered;
        }
        const res = calc.chooseBestMove({data, attacker:atk, defender:def, movePool:mp, settings: settingsForWave(stBase, stBase.wavePlans?.[waveKey]||{}, attId, defSlot.rowKey), tags: defSlot.tags||[]});
        return res?.best || null;
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
      const fillScore = (fillBase)=>{
        const dFill = slotForBase.get(fillBase);
        if (!dFill) return 9;
        let sum = 0; let n = 0;
        for (const other of chosenBases){
          const dOther = slotForBase.get(other);
          if (!dOther) continue;
          let bestRec = null;
          for (const [aId,bId] of attPairs){
            const a0 = bestMoveFor2(aId, dFill);
            const a1 = bestMoveFor2(aId, dOther);
            const b0 = bestMoveFor2(bId, dFill);
            const b1 = bestMoveFor2(bId, dOther);
            const opt1 = {tuple: scoreTuple(a0,b1)};
            const opt2 = {tuple: scoreTuple(a1,b0)};
            const t = betterT(opt1.tuple, opt2.tuple) ? opt1.tuple : opt2.tuple;
            if (!bestRec || betterT(t, bestRec)) bestRec = t;
          }
          if (!bestRec) continue;
          sum += (bestRec.avgPrio ?? 9);
          n++;
        }
        return n ? (sum / n) : 9;
      };

// --- Padding + solver ---
// Problem we fix here:
// 1) With <8 defenders, the old padding could force silly repeats (e.g., Cottonee everywhere) and hide optimal low-prio schedules.
// 2) We also want to surface *all* optimal (lowest avg prio) combinations, not just 1–2.
const chosenBasesUnique = chosenBases.slice();
const need = Math.max(0, 8 - chosenBasesUnique.length);

// Cache bestMove lookups during solve (PP baseline is fixed for this solve run).
const __bmCache = new Map();
const bestMove2 = (attId, defSlot)=>{
  const k = `${attId}@@${defSlot?.rowKey||''}`;
  if (__bmCache.has(k)) return __bmCache.get(k);
  const v = bestMoveFor2(attId, defSlot);
  __bmCache.set(k, v);
  return v;
};

// Generate defender keys (rowKeys) from an expanded base multiset (length 8).
const basesToDefKeys = (bases)=>{
  const out = [];
  for (const b of (bases||[])){
    const sl = slotForBase.get(b);
    if (sl) out.push(sl.rowKey);
  }
  while (out.length < 8 && out.length) out.push(out[out.length-1]);
  out.length = 8;
  return out;
};

// Ensure defenders inside a single fight have unique instance keys (rk, rk#2, rk#3, ...).
const makeInstanceDefs = (defs)=>{
  const used = new Map();
  const out = [];
  for (const k0 of (defs||[])){
    const b = baseDefKey(k0);
    const n = (used.get(b) || 0) + 1;
    used.set(b, n);
    out.push(n === 1 ? b : `${b}#${n}`);
  }
  return out;
};

const computeAltsForDefKeys = (defKeys)=>{
  const slotByKey2 = new Map((slots||[]).map(s=>[s.rowKey,s]));

  // Build best attacker-pair options for each defender pair.
  const pairBest = Array.from({length:8}, ()=> Array.from({length:8}, ()=> null));

  const bestForDefPair = (d0,d1)=>{
    let bestRec = null;
    let opts = [];

    // Treat as tie if (OHKO, worstPrio, avgPrio) match.
    // We intentionally IGNORE overkill differences here to surface more "same-prio" combinations.
    const sameT = (x,y)=>{
      if (!x || !y) return false;
      return (x.ohko === y.ohko) &&
             (x.worstPrio === y.worstPrio) &&
             (Math.abs((Number(x.avgPrio)||0) - (Number(y.avgPrio)||0)) < 1e-9);
    };

    for (const [aId,bId] of attPairs){
      const a0 = bestMove2(aId, d0);
      const a1 = bestMove2(aId, d1);
      const b0 = bestMove2(bId, d0);
      const b1 = bestMove2(bId, d1);
      const opt1 = {tuple: scoreTuple(a0,b1), aId, bId};
      const opt2 = {tuple: scoreTuple(a1,b0), aId, bId};
      const chosen = betterT(opt1.tuple, opt2.tuple) ? opt1 : opt2;
      const rec = {aId: chosen.aId, bId: chosen.bId, tuple: chosen.tuple};

      if (!bestRec || betterT(rec.tuple, bestRec.tuple)){
        bestRec = rec;
        opts = [rec];
      } else if (sameT(rec.tuple, bestRec.tuple)){
        const key = `${rec.aId}+${rec.bId}`;
        if (!opts.some(o => `${o.aId}+${o.bId}` === key)) opts.push(rec);
      }
    }
    if (!bestRec) return null;
    bestRec.opts = opts.slice(0, 12);
    return bestRec;
  };

  for (let i=0;i<8;i++){
    for (let j=i+1;j<8;j++){
      const d0 = slotByKey2.get(baseDefKey(defKeys[i]));
      const d1 = slotByKey2.get(baseDefKey(defKeys[j]));
      if (!d0 || !d1) continue;
      pairBest[i][j] = bestForDefPair(d0,d1);
      pairBest[j][i] = pairBest[i][j];
    }
  }

  // Enumerate all perfect matchings over 8 defender nodes -> 4 fights.
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

  const schedules = [];
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
      if (!b) continue;
      recMatch(mask & ~(1<<i) & ~(1<<j), pairs.concat([{i,j,best:b}]));
    }
  };
  recMatch((1<<8)-1, []);
  if (!schedules.length) return {alts:[], bestAvg: Infinity};
  schedules.sort((x,y)=> cmpScore(x.score, y.score));

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
    for (const base of chosenBasesUnique){
      const sl = slotForBase.get(base);
      if (!sl) continue;
      const mA = bestMove2(aId, sl);
      const mB = bestMove2(bId, sl);
      const m = bestSingleTargetMove(mA, mB);
      if (!m) continue;
      const tuple = { ohko: m.oneShot ? 1 : 0, prio: m.prio ?? 9, over: Math.abs((m.minPct||0)-100), minPct: m.minPct || 0 };
      const better = (x,y)=>{
        if (!y) return true;
        if (x.ohko !== y.ohko) return x.ohko > y.ohko;
        if (x.prio !== y.prio) return x.prio < y.prio;
        if (x.over !== y.over) return x.over < y.over;
        return x.minPct >= y.minPct;
      };
      if (better(tuple, best?.tuple)) best = {rowKey: sl.rowKey, tuple};
    }
    return best?.rowKey || slotForBase.get(chosenBasesUnique[0])?.rowKey;
  };

  const fightsForSchedule = (sch, optPick)=> {
    const fights = sch.pairs.slice(0,4).map((p,pi)=>{
      const d0 = defKeys[p.i];
      const d1 = defKeys[p.j];

      const opts = (p.best && Array.isArray(p.best.opts) && p.best.opts.length) ? p.best.opts : [p.best];
      const pickedIdx = (Array.isArray(optPick) && Number.isFinite(Number(optPick[pi])))
        ? clampInt(optPick[pi], 0, Math.max(0, opts.length - 1))
        : 0;
      const picked = opts[pickedIdx] || opts[0] || p.best;

      const aId = picked.aId;
      const bId = picked.bId;
      const defs0 = makeInstanceDefs([d0, d1]);
      const defs = defs0.slice();
      const fill = (defLimit > 2) ? pickFillKey(aId, bId) : null;
      while (defs.length < defLimit && fill) defs.push(fill);

      const expAvg = Number(picked?.tuple?.avgPrio ?? 9);
      const expWorst = Number(picked?.tuple?.worstPrio ?? 9);
      return {defs, aId, bId, expAvg, expWorst};
    });

    fights.sort((x,y)=>{
      const ax = Number.isFinite(Number(x.expAvg)) ? Number(x.expAvg) : 9;
      const ay = Number.isFinite(Number(y.expAvg)) ? Number(y.expAvg) : 9;
      if (ax !== ay) return ax - ay;
      const wx = Number.isFinite(Number(x.expWorst)) ? Number(x.expWorst) : 9;
      const wy = Number.isFinite(Number(y.expWorst)) ? Number(y.expWorst) : 9;
      if (wx !== wy) return wx - wy;
      return `${x.aId}+${x.bId}`.localeCompare(`${y.aId}+${y.bId}`);
    });

    return fights;
  };

	  // Collect unique alternatives; compute bestAvg for this padding, and keep solutions up to bestAvg + slack.
  const all = [];
  const seen = new Set();
  let bestAvg = Infinity;
  const EPS = 1e-9;

  for (const sch of schedules){
    const pairsN = Math.max(1, (sch?.pairs || []).slice(0,4).length || 4);
    const prioAvg = Number((sch?.score?.sumAvgPrio ?? 9 * pairsN) / pairsN);
    if (prioAvg < bestAvg) bestAvg = prioAvg;

    const optsByFight = (sch?.pairs || []).slice(0,4).map(p=>{
      const opts = (p?.best && Array.isArray(p.best.opts)) ? p.best.opts : null;
      return (opts && opts.length) ? opts : [p.best];
    });

    const maxPickPerFight = 3; // try up to 3 tie-best attacker pairs per fight
    const rad = optsByFight.map(o => Math.max(1, Math.min(maxPickPerFight, (o||[]).length || 1)));

    // Deterministic cartesian product over first few options per fight (capped).
    const VAR_CAP = 60;
    let emitted = 0;

    for (let i0=0;i0<rad[0] && emitted<VAR_CAP;i0++){
      for (let i1=0;i1<(rad[1]||1) && emitted<VAR_CAP;i1++){
        for (let i2=0;i2<(rad[2]||1) && emitted<VAR_CAP;i2++){
          for (let i3=0;i3<(rad[3]||1) && emitted<VAR_CAP;i3++){
            const pick = [i0,i1,i2,i3];
            const fights = fightsForSchedule(sch, pick);

            const fightKeys = fights.map(f=>{
              const pair = [f.aId, f.bId].slice().sort((a,b)=>String(a).localeCompare(String(b))).join('+');
              const defs = (f.defs||[]).join('|');
              return `${pair}@${defs}`;
            }).sort();
            const key = fightKeys.join('||');
            if (seen.has(key)) continue;
            seen.add(key);

            all.push({ fights, prioAvg });
            emitted++;
          }
        }
      }
    }
  }

  if (!all.length || !Number.isFinite(bestAvg)) return {alts:[], bestAvg: Infinity};

	  const picked = all.filter(a => a.prioAvg <= bestAvg + slackLocal + EPS);

  // Deterministic ordering for cycling: sort by defender keys then attacker ids.
  picked.sort((x,y)=>{
    const kx = x.fights.map(f=>`${(f.defs||[]).join('|')}@${[f.aId,f.bId].sort().join('+')}`).sort().join('||');
    const ky = y.fights.map(f=>`${(f.defs||[]).join('|')}@${[f.aId,f.bId].sort().join('+')}`).sort().join('||');
    return String(kx).localeCompare(String(ky));
  });

	  const MAX_ALTS = 120;
  const alts = picked.slice(0, MAX_ALTS).map(a => ({
    fights: (a.fights||[]).map(f => ({defs: f.defs, aId: f.aId, bId: f.bId})),
  }));

  return {alts, bestAvg};
};

// Enumerate all ways to distribute "need" duplicates across N bases.
const genComps = (n, need)=>{
  const out = [];
  const rec = (i, left, cur)=>{
    if (i === n-1){
      out.push(cur.concat([left]));
      return;
    }
    for (let x=0;x<=left;x++){
      rec(i+1, left-x, cur.concat([x]));
    }
  };
  rec(0, need, []);
  return out;
};

// Try each expanded base multiset (padding distribution) and merge into a global candidate list.
const resultsByPad = [];

// Build + merge across all padding distributions (for <8 defenders).
if (need <= 0){
  const defKeys0 = basesToDefKeys(chosenBasesUnique.slice(0,8));
  const res0 = computeAltsForDefKeys(defKeys0);
  resultsByPad.push(res0);
} else {
  const comps = genComps(chosenBasesUnique.length, need);
  for (const add of comps){
    const exp = chosenBasesUnique.slice();
    for (let i=0;i<add.length;i++){
      for (let k=0;k<add[i];k++) exp.push(chosenBasesUnique[i]);
    }
    // If we somehow overshoot, clamp.
    exp.length = 8;
    const defKeysX = basesToDefKeys(exp);
    const resX = computeAltsForDefKeys(defKeysX);
    resultsByPad.push(resX);
  }
}

if (!resultsByPad.length) return {alts:[]};

// Keep padding distributions whose bestAvg is within global best + slack.
const bestAvgGlobal = Math.min(...resultsByPad.map(r=>Number.isFinite(Number(r?.bestAvg)) ? Number(r.bestAvg) : Infinity));
if (!Number.isFinite(bestAvgGlobal)) return {alts:[]};
const padCutoff = bestAvgGlobal + slackLocal + 1e-9;

const merged = [];
const seenGlobal = new Set();
for (const r of resultsByPad){
  const b = Number.isFinite(Number(r?.bestAvg)) ? Number(r.bestAvg) : Infinity;
  if (b > padCutoff) continue;
  for (const a of (r?.alts||[])){
    const fights = a?.fights || [];
    const fightKeys = fights.map(f=>{
      const pair = [f.aId, f.bId].slice().sort((x,y)=>String(x).localeCompare(String(y))).join('+');
      const defs = (f.defs||[]).join('|');
      return `${pair}@${defs}`;
    }).sort();
    const key = fightKeys.join('||');
    if (seenGlobal.has(key)) continue;
    seenGlobal.add(key);
    merged.push(a);
  }
}

if (!merged.length) return {alts:[]};

const MAX_OUT = 200;
return {alts: merged.slice(0, MAX_OUT)};
    })();

    if (!computed?.alts?.length){
      alts = null;
    } else {
	    // Rank + filter alts using *actual simulated prioØ* (not just heuristic pairing scores).
	    // This fixes cases where the solver generates many alts, but the best avg-prio ones
	    // are not surfaced first (or the heuristic bestAvg misses the true best schedule).
	    const rankFilterBySim = (altsIn)=>{
	      const scored = [];
	      const EPS = 1e-6;
	      const safeNum = (x, d=9)=> (Number.isFinite(Number(x)) ? Number(x) : d);
	      const lexKey = (alt)=>{
	        const fights = (alt?.fights||[]).map(f=>{
	          const defs = (f?.defs||[]).join('|');
	          const pair = [f?.aId, f?.bId].filter(Boolean).slice().sort((a,b)=>String(a).localeCompare(String(b))).join('+');
	          return `${defs}@${pair}`;
	        }).sort();
	        return fights.join('||');
	      };

	      // Score each alt by actually simulating the 4 fights on a cloned baseline state.
	      for (const alt of (altsIn||[])){
	        const tmp = JSON.parse(JSON.stringify(stBase));
	        tmp.wavePlans = tmp.wavePlans || {};
	        tmp.wavePlans[waveKey] = tmp.wavePlans[waveKey] || {};
	        ensureWavePlan(data, tmp, waveKey, slots);
	        const wTmp = tmp.wavePlans[waveKey];
	        wTmp.fightLog = [];

	        const prios = [];
	        for (const spec of (alt?.fights||[])){
	          let e = makeFightEntry(tmp, wTmp, spec?.aId, spec?.bId, spec?.defs);
	          e = finalizeEntry(e, spec?.aId, spec?.bId);
	          prios.push(safeNum(e?.prioAvg, 9));
	        }
	        const avg = prios.length ? (prios.reduce((s,x)=>s+safeNum(x,9),0) / prios.length) : 9;
	        const max = prios.length ? Math.max(...prios.map(x=>safeNum(x,9))) : 9;
	        scored.push({alt, avg, max, key: lexKey(alt)});
	      }

	      if (!scored.length) return [];
	      const bestAvg = Math.min(...scored.map(x=>x.avg));
	      const slack = Math.max(0, Number(stBase.settings?.autoAltAvgSlack ?? 0));
	      const cutoff = bestAvg + slack + EPS;
	      const best = scored.filter(x=> x.avg <= cutoff);

	      best.sort((a,b)=>{
	        if (a.avg !== b.avg) return a.avg - b.avg;
	        if (a.max !== b.max) return a.max - b.max;
	        return String(a.key).localeCompare(String(b.key));
	      });
	      return best.map(x=>x.alt);
	    };

	    alts = rankFilterBySim(computed.alts);
	    idx = 0;
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
    w.solve = {alts, idx, signature};
    const chosen = alts[idx] || alts[0];
    for (const spec of (chosen.fights||[])){
      let entry = makeFightEntry(s, w, spec.aId, spec.bId, spec.defs);
      entry = finalizeEntry(entry, spec.aId, spec.bId);
      pushEntry(s, w, entry);
    }
  });
});

    // Replace old fight-log rendering with per-entry cards.
    const logWrap = el('div', {style:'margin-top:10px'}, []);
    const fightLog = (wp.fightLog||[]);
    const fightLogView = fightLog.slice().sort((a,b)=>{
      const ap = Number.isFinite(Number(a?.prioAvg)) ? Number(a.prioAvg) : 9;
      const bp = Number.isFinite(Number(b?.prioAvg)) ? Number(b.prioAvg) : 9;
      if (ap !== bp) return ap - bp;
      // tie-break by timestamp (older first)
      return Number(a?.ts||0) - Number(b?.ts||0);
    });
    if (fightLogView.length){
      logWrap.appendChild(el('div', {class:'panel-subtitle'}, 'Fight log'));
      logWrap.appendChild(el('div', {class:'muted small'}, 'Oldest first (top→bottom). Each entry can be undone.'));
      for (const e of fightLogView){
        const header = el('div', {style:'display:flex; justify-content:space-between; gap:8px; align-items:center'}, [
          el('div', {style:'font-weight:800'}, `prioØ ${formatPrioAvg(e.prioAvg)}`),
        ]);
        const undoEntryBtn = el('button', {class:'btn-mini'}, 'Undo');
        undoEntryBtn.addEventListener('click', ()=> undoEntryById(e.id));
        header.appendChild(undoEntryBtn);
        const lines = el('div', {class:'muted small', style:'margin-top:6px'}, (e.lines||[]).map(t=>el('div', {class:'battle-log-line'}, t)));
        const card = el('div', {class:'panel', style:'margin-top:8px'}, [header, lines]);
        logWrap.appendChild(card);
      }
      planEl.appendChild(logWrap);
    }

// Suggested lead pairs

    const suggWrap = el('div', {class:'panel'}, [
      el('div', {class:'panel-title'}, 'Suggested lead pairs'),
    ]);

    const suggList = el('div', {class:'suggestions'});
    const atkMons = activeRoster.map(r=>r).filter(Boolean);

    // Suggestions are based on the two active enemies (2v2). With free targeting, we score both target assignments.
    const d0 = allDef[0] || null;
    const d1 = allDef[1] || null;

    if (atkMons.length >= 2 && d0 && d1){
      const pairs = [];
      for (let i=0;i<atkMons.length;i++){
        for (let j=i+1;j<atkMons.length;j++){
          const a = atkMons[i];
          const b = atkMons[j];

          const plan = bestAssignmentForWavePair(data, state, wp, a, b, d0, d1);
          if (!plan) continue;

          // How many selected defenders can be OHKO'd by at least one of the two starters?
          let clearAll = 0;
          for (const ds of allDef){
            const b0 = bestMoveFor(a, ds);
            const b1 = bestMoveFor(b, ds);
            if ((b0 && b0.oneShot) || (b1 && b1.oneShot)) clearAll += 1;
          }

          pairs.push({a, b, meta: plan.meta, assign: plan.assign, clearAll});
        }
      }

      pairs.sort((x,y)=>{
        const a = x.meta || {};
        const b = y.meta || {};
        if ((a.ohko||0) !== (b.ohko||0)) return (b.ohko||0) - (a.ohko||0);
        if ((a.prioWorst||9) !== (b.prioWorst||9)) return (a.prioWorst||9) - (b.prioWorst||9);
        if ((a.prioSum||999) !== (b.prioSum||999)) return (a.prioSum||999) - (b.prioSum||999);
        if ((a.distSum||9999) !== (b.distSum||9999)) return (a.distSum||9999) - (b.distSum||9999);
        if ((a.deathPenalty||0) !== (b.deathPenalty||0)) return (a.deathPenalty||0) - (b.deathPenalty||0);
        if ((a.slowerCount||0) !== (b.slowerCount||0)) return (a.slowerCount||0) - (b.slowerCount||0);
        if ((a.stabCount||0) !== (b.stabCount||0)) return (b.stabCount||0) - (a.stabCount||0);
        if (x.clearAll !== y.clearAll) return y.clearAll - x.clearAll;
        return `${rosterLabel(x.a)}+${rosterLabel(x.b)}`.localeCompare(`${rosterLabel(y.a)}+${rosterLabel(y.b)}`);
      });

      for (const p of pairs.slice(0,12)){
        const meta = p.meta || {};
        const avgPrio = Number.isFinite(Number(meta.prioSum)) ? (Number(meta.prioSum) / 2).toFixed(1) : null;
        const chipEl = el('div', {class:'chip'}, [
          el('strong', {}, `${rosterLabel(p.a)} + ${rosterLabel(p.b)}`),
          el('span', {class:'muted'}, ` · OHKO ${meta.ohko ?? 0}/2`),
          el('span', {class:'muted'}, ` · prio P${meta.prioWorst ?? '?'}`),
          (avgPrio ? el('span', {class:'muted'}, ` · avg P${avgPrio}`) : null),
          el('span', {class:'muted'}, ` · clear ${p.clearAll}/${allDef.length}`),
        ]);

        // Hover details: show chosen target assignment + move details.
        const lines = [];
        for (const x of (p.assign || [])){
          const mv = x.best ? `${x.best.move} (P${x.best.prio}) · ${formatPct(x.best.minPct)} min` : '—';
          lines.push(`${rosterLabel(x.attacker)} → ${x.defSlot?.defender || '—'}: ${mv}`);
        }
        lines.push(`OHKO: ${meta.ohko ?? 0}/2 · prioWorst: P${meta.prioWorst ?? '?'} · overkill: ${Number(meta.distSum||0).toFixed(1)}`);
        chipEl.title = lines.join('\n');

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
      suggList.appendChild(el('div', {class:'muted small'}, 'Need at least 2 ACTIVE roster mons and 2 selected enemies to see suggestions.'));
    }

    suggWrap.appendChild(suggList);

    const enemyPanelChildren = [
      el('div', {class:'panel-title'}, `Enemies (${defLimit} slot${defLimit===1?'':'s'} · duplicates allowed)`),
    ];
    if (selectedEnemiesPanel) enemyPanelChildren.push(selectedEnemiesPanel);
    enemyPanelChildren.push(enemyList);

    const enemyPanel = el('div', {class:'panel'}, enemyPanelChildren);

    const rightCol = el('div', {class:'planner-stack'}, [
      planEl,
      suggWrap,
    ]);

    return el('div', {}, [
      lootPanel,
      el('div', {class:'planner-grid'}, [
        enemyPanel,
        rightCol,
      ]),
    ]);
  }

  // ---------------- Roster ----------------

  function openAddRosterModal(state){
    const unlockedSpecies = Object.keys(state.unlocked).filter(k=>state.unlocked[k]).sort((a,b)=>a.localeCompare(b));
    const existing = new Set(state.roster.map(r=>r.baseSpecies));
    const candidates = unlockedSpecies.filter(s=>!existing.has(s) && data.claimedSets[s]);

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
      el('div', {class:'muted small'}, 'Only species that have a baseline set in your sheet (ClaimedSets) can be added right now.'),
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
        // Keep roster sprites animated (GIF). Use static only as fallback.
        const img = el('img', {class:'sprite sprite-md', src:spriteAnim(calc, sp), alt:sp});
        img.dataset.fallbackTried = '0';
        img.onerror = ()=>{
          if (img.dataset.fallbackTried !== '1'){
            img.dataset.fallbackTried = '1';
            img.src = sprite(calc, sp);
            return;
          }
          img.style.opacity='0.25';
        };
        const btn = el('button', {class:'btn-mini'}, 'Add');
        btn.addEventListener('click', ()=>{
          store.update(s=>{
            const entry = makeRosterEntryFromClaimedSet(data, sp);
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

        listBody.appendChild(el('div', {class:'row'}, [
          el('div', {class:'row-left'}, [
            img,
            el('div', {}, [
              el('div', {class:'row-title'}, sp),
              el('div', {class:'row-sub'}, `Ability: ${data.claimedSets[sp]?.ability || '—'} · Moves: ${(data.claimedSets[sp]?.moves||[]).join(', ')}`),
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

    // Roster details: animated sprite and a bit larger.
    const spImg = el('img', {class:'sprite sprite-xl', src:spriteAnim(calc, eff), alt:eff});
    spImg.dataset.fallbackTried = '0';
    spImg.onerror = ()=>{
      if (spImg.dataset.fallbackTried !== '1'){
        spImg.dataset.fallbackTried = '1';
        spImg.src = sprite(calc, eff);
        return;
      }
      spImg.style.opacity = '0.25';
    };

    const title = el('div', {style:'display:flex; align-items:center; justify-content:space-between; gap:10px'}, [
      el('div', {style:'display:flex; align-items:center; gap:12px'}, [
        spImg,
        el('div', {}, [
          el('div', {class:'ov-title'}, rosterLabel(r)),
          el('div', {class:'muted small'}, `Ability: ${r.ability || '—'} · Moves: ${(r.movePool||[]).length}`),
        ]),
      ]),
      el('div', {style:'display:flex; gap:8px'}, [
        el('button', {class:'btn-mini'}, 'Dex'),
        el('button', {class:'btn-mini'}, 'Remove'),
      ]),
    ]);

    // Dex shortcut
    title.querySelectorAll('button')[0].addEventListener('click', ()=>{
      const base = pokeApi.baseOfSync(r.baseSpecies, store.getState().baseCache||{});
      store.update(s=>{
        s.ui.tab = 'unlocked';
        s.ui.dexReturnTab = 'roster';
        s.ui.dexReturnRosterId = r.id;
        s.ui.dexReturn = {tab:'roster', selectedRosterId: r.id}; // legacy
        s.ui.dexDetailBase = base;
        s.ui.dexSelectedForm = eff;
        s.ui.dexDefenderLevel = null;
      });
      // Fill evo line async
      pokeApi.resolveEvoLineNonBaby(base, store.getState().baseCache||{})
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
    });

    // Remove
    title.querySelectorAll('button')[1].addEventListener('click', ()=>{
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
    const evoAvail = availableCount(state, 'Evo Charm');
    // Starters: Strength is forced/free (does not consume bag), so availability gating is only for non-starters.
    const strAvail = starter ? 9999 : availableCount(state, 'Strength Charm');

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
        const allBag = Object.keys(state.bag||{}).sort((a,b)=>a.localeCompare(b));
        // Held items should not include charms or consumables.
        const bagNames = allBag.filter(n => n !== 'Evo Charm' && n !== 'Strength Charm' && n !== 'Rare Candy' && n !== 'Copper Coin' && n !== 'Revive');
        // Ensure current item is selectable even if it isn't in the normal held-item list.
        if (r.item && !bagNames.includes(r.item)) bagNames.unshift(r.item);
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

      const ppMax = Number.isFinite(Number(m.ppMax)) ? Math.max(1, Math.floor(Number(m.ppMax))) : 12;
      const ppInp = el('input', {type:'number', min:'0', max:String(ppMax), step:'1', value:String(Number.isFinite(Number(m.pp)) ? Number(m.pp) : ppMax), class:'inp-mini', style:'width:76px'});
      ppInp.title = 'PP remaining';
      ppInp.addEventListener('change', ()=>{
        const next = clampInt(ppInp.value, 0, ppMax);
        store.update(s=>{
          const cur = byId(s.roster, r.id);
          if (!cur) return;
          const mm = (cur.movePool||[]).find(x=>x.name===m.name);
          if (!mm) return;
          mm.ppMax = ppMax;
          mm.pp = next;
        });
      });

      mpList.appendChild(el('div', {class:'row'}, [
        el('div', {class:'row-left'}, [
          el('div', {}, [
            el('div', {class:'row-title'}, m.name),
            el('div', {class:'row-sub'}, meta + (m.source ? ` · ${m.source}` : '')),
          ]),
        ]),
        el('div', {class:'row-right'}, [
          prioSel,
          ppInp,
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
        cur.movePool.push({name: mv, prio, use:true, ppMax:12, pp:12, source:'tm'});
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

      // Roster should keep animated sprites (GIF) for readability.
      const _sp = (r.effectiveSpecies||r.baseSpecies);
      const img = el('img', {class:'sprite sprite-md', src:spriteAnim(calc, _sp), alt:label});
      img.dataset.fallbackTried = '0';
      img.onerror = ()=>{
        // If the GIF is missing (edge forms), fall back to the static PNG.
        if (img.dataset.fallbackTried !== '1'){
          img.dataset.fallbackTried = '1';
          img.src = sprite(calc, _sp);
          return;
        }
        img.style.opacity='0.25';
      };

      const activeChk = el('input', {type:'checkbox', checked: !!r.active});
      activeChk.addEventListener('change', ()=>{
        store.update(s=>{
          const cur = byId(s.roster, r.id);
          if (cur) cur.active = activeChk.checked;
        });
      });

      const editBtn = el('button', {class:'btn-mini'}, 'Edit');
      editBtn.addEventListener('click', ()=>{
        store.update(s=>{ s.ui.selectedRosterId = r.id; });
      });

      const rowEl = el('div', {class:'row'}, [
        el('div', {class:'row-left'}, [
          img,
          el('div', {}, [
            el('div', {class:'row-title'}, label),
            el('div', {class:'row-sub'}, r.ability ? `Ability: ${r.ability}` : 'Ability: —'),
          ]),
        ]),
        el('div', {class:'row-right'}, [
          el('label', {class:'check', style:'margin:0'}, [activeChk, el('span', {}, 'active')]),
          editBtn,
        ]),
      ]);

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

// ---------------- Bag ----------------
  function renderBag(state){
    tabBag.innerHTML = '';

    const used0 = computeRosterUsage(state);
    const bag = state.bag || {};
    const bagNames = Object.keys(bag).sort((a,b)=>a.localeCompare(b));

    const isCharm = (n)=> n === 'Evo Charm' || n === 'Strength Charm';

    // Shop state (gold + undoable ledger)
    const shop = state.shop || {gold:0, ledger:[]};
    const gold = Math.max(0, Math.floor(Number(shop.gold||0)));
    const ledger = Array.isArray(shop.ledger) ? shop.ledger : [];

    const canUseItem = (name)=>{
      // "Use" = consume 1 from bag (undoable). For held items, we also clear it from one current holder.
      // Keep it conservative: only obvious consumables + coins.
      if (!name) return false;
      if (isCharm(name)) return false;
      // Coins are economy-only (sellable), no "use" action.
      if (name === 'Copper Coin') return false;
      if (name === 'Air Balloon') return true;
      if (name === 'Revive') return true;
      if (isGem(name)) return true;
      return false;
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

                // Keep legacy wallet (if present) in sync for backward compat.
                if (s.wallet && typeof s.wallet === 'object'){
                  s.wallet.gold = Math.max(0, Math.floor(Number(s.shop.gold||0)));
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

      // Placeholder: shop uses priceOfItem; selling uses the same nominal price (easy/undoable).
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

          // keep wallet in sync if it exists
          if (s.wallet && typeof s.wallet === 'object'){
            s.wallet.gold = Math.max(0, Math.floor(Number(s.shop.gold||0)));
          }

          enforceBagConstraints(data, s, applyCharmRulesSync);
        });
      });

      const sellBtn = el('button', {class:'btn-mini'}, 'Sell 1');
      // Only AVAILABLE can be sold.
      sellBtn.disabled = !(price > 0) || avail <= 0;
      sellBtn.title = (price > 0)
        ? `${price} gold (only AVAILABLE can be sold)`
        : 'Not sellable';

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

          // keep wallet in sync if it exists
          if (s.wallet && typeof s.wallet === 'object'){
            s.wallet.gold = Math.max(0, Math.floor(Number(s.shop.gold||0)));
          }

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
      el('div', {class:'muted small'}, 'Shop sells most items as singles. Gems + Air Balloons are sold as bundles (x5). Rare Candy is sold as a bundle (x3). Selling via the table above is always 1 unit.'),
    ]);

    const buyOfferFor = (itemName)=> buyOffer(itemName);

    const doBuy = (itemName)=>{
      const off = buyOfferFor(itemName);
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
        s.bag[off.item] = Number(s.bag[off.item]||0) + qty;

        // keep wallet in sync if it exists
        if (s.wallet && typeof s.wallet === 'object'){
          s.wallet.gold = Math.max(0, Math.floor(Number(s.shop.gold||0)));
        }

        enforceBagConstraints(data, s, applyCharmRulesSync);
      });
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

    // Air Balloon (bundle x5)
    (function(){
      const item = 'Air Balloon';
      const off = buyOfferFor(item);
      const buyBtn = el('button', {class:'btn-mini'}, 'Buy');
      if (!off || gold < (off.cost||0)) buyBtn.disabled = true;
      buyBtn.addEventListener('click', ()=> doBuy(item));
      grid.appendChild(el('div', {class:'shop-card'}, [
        el('div', {class:'shop-meta'}, [
          el('div', {class:'shop-name'}, 'Air Balloon (x5)'),
          el('div', {class:'shop-price'}, off ? `price: ${off.cost}g · +${off.qty}` : 'price: —'),
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
        ledgerBox.appendChild(el('div', {class:'shop-ledger-row'}, `${String(tx.type||'tx').toUpperCase()} ${tx.item} x${tx.qty} (${sign}${tx.goldDelta}g)`));
      }
    }
    shopPanel.appendChild(el('div', {class:'panel-subtitle', style:'margin-top:12px'}, 'Recent transactions'));
    shopPanel.appendChild(ledgerBox);

    tabBag.appendChild(el('div', {}, [bagPanel, shopPanel]));
  }
  function renderSettings(state){
    tabSettings.innerHTML = '';

    const s = state.settings || {};
    const animals = uniq((data.calcSlots||[]).map(x=>x.animal)).sort((a,b)=>String(a).localeCompare(String(b)));

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

    const fieldSelectNum = (label, value, options, onChange)=>{
      const sel = el('select', {}, (options||[]).map(o=>{
        const v = (o && o.value !== undefined) ? o.value : o;
        const t = (o && o.label !== undefined) ? o.label : String(v);
        return el('option', {value:String(v), selected:String(v)===String(value)}, t);
      }));
      sel.addEventListener('change', ()=> onChange(Number(sel.value)));
      return el('div', {class:'field'}, [el('label', {}, label), sel]);
    };

    const fieldSelectStr = (label, value, options, onChange)=>{
      const sel = el('select', {}, (options||[]).map(o=>{
        const v = (o && o.value !== undefined) ? o.value : o;
        const t = (o && o.label !== undefined) ? o.label : String(v);
        return el('option', {value:String(v), selected:String(v)===String(value)}, t);
      }));
      sel.addEventListener('change', ()=> onChange(sel.value));
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

    // Core constants + move scoring (merged into one panel)
    const pCore = panel('Core settings', [
      el('div', {class:'panel-subtitle'}, 'Global calc constants'),
      el('div', {class:'muted small'}, 'These affect damage calcs everywhere (Waves + Overview).'),
      el('div', {class:'core-fields'}, [
        fieldSelectStr('Start wave type', s.startWaveAnimal || s.startAnimal || 'Goat', animals.length ? animals : ['Goat'], v=>store.update(st=>{
          st.settings.startWaveAnimal = v;
          st.settings.startAnimal = v; // alias for compatibility with other builds
        })),
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
      el('div', {class:'muted small'}, 'When cycling Auto x4, include solutions up to bestAvg + slack (avg prioØ). 0 = best-only.'),
      el('div', {class:'core-fields'}, [
        fieldSelectNum('Avg prio slack', (s.autoAltAvgSlack ?? 0), [
          {value:0, label:'0 (best only)'},
          {value:0.25, label:'0.25'},
          {value:0.5, label:'0.5'},
          {value:1, label:'1.0'},
          {value:1.5, label:'1.5'},
          {value:2, label:'2.0'},
        ], v=>store.update(st=>{ st.settings.autoAltAvgSlack = Math.max(0, Number(v)||0); })),
        fieldSelectNum('Max variations (cycle + combos)', (s.variationLimit ?? 8), [
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
      el('div', {class:'muted small'}, 'Data contributions: [MÜSH] Alphy.'),
      el('div', {class:'muted small'}, 'Groundwork: [MÜSH] TTVxSenseiNESS and RuthlessZ (LNY Event 2024 & 2025).'),
      el('div', {class:'muted small'}, 'Sprites: Pokémon Database (pokemondb.net / img.pokemondb.net).'),
      el('div', {class:'muted small'}, 'Pokédex / evolutions: PokéAPI.'),
      el('div', {class:'muted small'}, 'Pokémon is © Nintendo / Creatures Inc. / GAME FREAK inc. This is an unofficial fan tool.'),
      el('hr'),
      el('div', {class:'panel-subtitle'}, 'Impressum'),
      el('div', {class:'muted small'}, 'Private community tool for Team MÜSH. Non-commercial. No affiliation with Nintendo / GAME FREAK / Creatures.'),
      el('div', {class:'muted small'}, 'Contact: PaulusTFT (update as needed).'),
    ]);

    // Layout tags (CSS)
    pAbout.classList.add('settings-about');
    pCore.classList.add('settings-core');
    pThreat.classList.add('settings-threat');
    pDefaults.classList.add('settings-defaults');
    pTools.classList.add('settings-tools');

    tabSettings.appendChild(el('div', {class:'settings-layout'}, [
      el('div', {class:'settings-col settings-col-left'}, [pAbout, pTools]),
      el('div', {class:'settings-col settings-col-mid'}, [pCore]),
      el('div', {class:'settings-col settings-col-right'}, [pThreat, pDefaults]),
    ]));
  }



  function typeClass(t){
    return 'type-' + String(t||'').replace(/[^A-Za-z0-9]/g,'');
  }

  function shortMoveLabel(m){
    const s = String(m||'').trim();
    if (!s) return '—';
    // Compact common long patterns in the grid.
    // (Detail view keeps full names.)
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
    const tarr = Array.isArray(types) ? types.slice(0,2) : (types ? String(types).split('/').map(s=>s.trim()).filter(Boolean).slice(0,2) : []);
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
      // IMPORTANT UX FIX:
      // The Dex detail view re-renders frequently while async caches (meta/moves/evo line) resolve.
      // If the DOM node is replaced between mousedown and mouseup, a normal "click" won't fire.
      // Using pointerdown ensures the action triggers immediately and can't be "lost".
      const backBtn = el('button', {class:'btn-mini', type:'button', id:'dexBackBtn'}, backLabel);
      const goBack = (ev)=>{
        ev?.preventDefault?.();
        ev?.stopPropagation?.();

        // Clean up the Dex detail height-sync observer when leaving the detail layer.
        try{ if (window.__dexDetailRO){ window.__dexDetailRO.disconnect(); window.__dexDetailRO = null; } } catch(_e) {}

        store.update(s=>{
          const ret = s.ui.dexReturnTab || s.ui.lastNonDexTab || 'unlocked';
          s.ui.dexDetailBase = null;
          s.ui.dexSelectedForm = null;
          s.ui.dexReturnTab = null;
          s.ui.dexReturn = null; // legacy
          if (ret === 'roster' && s.ui.dexReturnRosterId){
            s.ui.selectedRosterId = s.ui.dexReturnRosterId;
          }
          s.ui.dexReturnRosterId = null;
          if (ret) s.ui.tab = ret;
        });
      };
      backBtn.addEventListener('pointerdown', goBack);
      // Keep click for keyboard accessibility.
      backBtn.addEventListener('click', goBack);

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
                img.src = spriteAnim(calc, sp);
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
          (function(){
            const img = el('img', {class:'sprite sprite-xxl', src:sprite(calc, selected), alt:selected});
            img.dataset.fallbackTried = '0';
            img.onerror = ()=>{
              if (img.dataset.fallbackTried !== '1'){
                img.dataset.fallbackTried = '1';
                img.src = spriteAnim(calc, selected);
                return;
              }
              img.style.opacity = '0.25';
            };
            return img;
          })(),
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
          img.src = spriteAnim(calc, base);
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

  // ---------------- Render orchestrator ----------------

  function render(){
    const state = store.getState();

    renderTabs(state);
    updateHeaderCounts(state);
    renderOverview(state);

    if (state.ui.tab === 'waves') renderWaves(state);
    else if (state.ui.tab === 'roster') renderRoster(state);
    else if (state.ui.tab === 'bag') renderBag(state);
    else if (state.ui.tab === 'settings') renderSettings(state);
    else if (state.ui.tab === 'unlocked') renderUnlocked(state);
  }

  attachTabHandlers();
  attachOverviewToggle();

  return { render };
}
