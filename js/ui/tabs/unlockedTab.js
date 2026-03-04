// js/ui/tabs/unlockedTab.js
// alpha v1
// Pokédex (Unlocked) tab UI extracted from js/app/app.js (UI-only refactor).

import { $, el, pill, sprite, formatPct } from '../dom.js';
import { fixName } from '../../data/nameFixes.js';
import { applyMovesetOverrides, defaultNatureForSpecies } from '../../domain/shrineRules.js';
import { getItemIcon, getTypeIcon } from '../icons.js';
import { TYPES_NO_FAIRY } from '../../domain/items.js';
import { speciesListFromSlots } from '../../domain/waves.js';
import { resolveDexReturnRosterId } from '../dexNav.js';
import { buildOneShotTable as buildOneShotTableShared } from '../oneShotTable.js';
import { createDexApiHelpers } from '../dexApi.js';

function uniq(arr){
  return Array.from(new Set((arr || []).filter(v=>v!==undefined && v!==null)));
}

function normSearch(s){
  return String(s||'')
    .toLowerCase()
    .replace(/\bhp\b/g,'hidden power')
    .replace(/[^a-z0-9]+/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

function tokenizeSearch(q){
  const t = normSearch(q);
  return t ? t.split(' ').filter(Boolean) : [];
}

function buildSearchHaystack(species, base, claimed){
  const parts = [species, base];
  if (claimed){
    if (claimed.ability) parts.push(claimed.ability);
    if (Array.isArray(claimed.moves)) parts.push(...claimed.moves);
  }
  return normSearch(parts.join(' '));
}

export function createUnlockedTab(ctx){
  const { data, calc, store, pokeApi, tabUnlocked } = ctx;

  // NOTE (UX): This tab is full re-render on state updates.
  // Typing into the search box triggers store.update() which replaces the DOM
  // node and can drop focus/caret after the first character. Keep a tiny local
  // snapshot so the search input remains usable while filtering.
  let __searchUnlockedRestore = null;

  // Keep the old in-module call signature for compatibility with extracted code.
  const buildOneShotTable = (state, defenderName, level, tags)=>
    buildOneShotTableShared({data, calc}, state, defenderName, level, tags);

  const { ensureDexApi, ensureDexMeta } = createDexApiHelpers({ store, pokeApi });

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

  const qRaw = String(state.ui.searchUnlocked || '');
  const qTokens = tokenizeSearch(qRaw);

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
      const cached = state.dexMoveCache?.[key];
      // If the cache contains an unresolved placeholder, re-fetch once to fix the text.
      if (cached && !String(cached).includes('$effect_chance')) return;
      const slug = moveSlug(canon);
      if (!slug) return;
      if (typeof pokeApi?.fetchMove !== 'function') return;
      const p = pokeApi.fetchMove(slug).catch(()=>null);

      p.then(j => {
          const eff = j?.effect_entries?.find(e => e.language?.name === 'en');
          const shortEff = eff?.short_effect || eff?.effect || null;
          if (!shortEff) return;
          // PokeAPI uses "$effect_chance" placeholders in effect text.
          // Replace with the numeric chance when available (e.g., Flamethrower 10%).
          let txt = String(shortEff);
          if (txt.includes('$effect_chance')){
            const ch = Number(j?.effect_chance);
            if (Number.isFinite(ch) && ch > 0){
              txt = txt.replace(/\$effect_chance/g, String(ch));
            }else{
              // If chance is missing, remove the placeholder cleanly.
              txt = txt.replace(/\$effect_chance%?\s*/g, '');
            }
          }
          store.update(s=>{
            s.dexMoveCache = s.dexMoveCache || {};
            // Keep it short in UI.
            s.dexMoveCache[key] = String(txt).replace(/\s+/g,' ').trim();
          });
        });
    };

    const origin = state.ui?.dexOrigin || state.ui?.dexReturnTab || 'unlocked';
    const backLabel = (origin === 'roster') ? '← Back to Roster' : '← Back to Pokédex';
    // Use pointerdown to avoid "lost clicks" when Dex detail re-renders due to async cache updates.
    const backBtn = el('button', {class:'btn-mini', type:'button'}, backLabel);

    let backDidNav = false;
    const doDexBack = ()=>{
      if (backDidNav) return;
      backDidNav = true;
      store.update(s=>{
        // Deterministic origin: roster => return to roster; otherwise return to Pokédex grid.
        const origin2 = s.ui.dexOrigin || s.ui.dexReturnTab || 'unlocked';
        const rid = resolveDexReturnRosterId(s);
        const ret = (origin2 === 'roster') ? 'roster' : 'unlocked';
        s.ui.dexDetailBase = null;
        s.ui.dexSelectedForm = null;
        // Clear legacy + origin routing when leaving the detail layer.
        if (ret === 'roster'){
          s.ui.dexOrigin = null;
          s.ui.dexOriginRosterId = null;
          s.ui.dexOriginRosterBase = null;
          s.ui.dexReturnTab = null;
        }else{
          // Stay in Pokédex browsing mode.
          s.ui.dexOrigin = 'unlocked';
          s.ui.dexReturnTab = 'unlocked';
        }
        if (ret === 'roster' && rid){
          s.ui.selectedRosterId = rid;
        }
        s.ui.dexReturnRosterId = null;
        s.ui.dexReturnRosterBase = null;
        s.ui.dexOriginRosterId = null;
        s.ui.dexOriginRosterBase = null;
        if (ret) s.ui.tab = ret;
      });
    };

    const onDexBack = (ev)=>{
      ev?.preventDefault?.();
      ev?.stopPropagation?.();
      doDexBack();
    };
    backBtn.addEventListener('pointerdown', onDexBack, {passive:false});
    backBtn.addEventListener('mousedown', onDexBack);
    backBtn.addEventListener('click', onDexBack);

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
        // Debug: reflect move base power overrides in UI (so displayed BP matches calc).
        let pow = mv?.power;
        try{
          const enabled = !!state?.settings?.enableMovePowerOverrides;
          if (enabled){
            const ovr = state?.settings?.movePowerOverrides?.[canon] ?? state?.settings?.movePowerOverrides?.[rawName];
            const p = (ovr !== undefined && ovr !== null && ovr !== '') ? Number(ovr) : null;
            if (Number.isFinite(p) && p > 0) pow = p;
          }
        }catch(e){ /* ignore */ }
        const bp = (typeof pow === 'number' && Number.isFinite(pow)) ? String(Math.round(pow)) : '—';

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
    el('div', {class:'field dex-search-field'}, [
      el('label', {for:'searchUnlocked'}, 'Search'),
      el('input', {type:'text', id:'searchUnlocked', placeholder:'Search…', value: state.ui.searchUnlocked || ''}),
    ]),
    el('div', {class:'dex-grid', id:'dexGrid'}),
  ]);

  tabUnlocked.appendChild(wrap);

  const grid = $('#dexGrid', wrap);
  const search = $('#searchUnlocked', wrap);
  const resolveHint = $('#dexResolveHint', wrap);

  // Restore focus + caret after re-render (see note above).
  if (__searchUnlockedRestore && search){
    const snap = __searchUnlockedRestore;
    __searchUnlockedRestore = null;
    requestAnimationFrame(()=>{
      try{
        search.focus();
        const len = String(search.value||'').length;
        const a = Math.max(0, Math.min(Number(snap.a)||len, len));
        const b = Math.max(0, Math.min(Number(snap.b)||a, len));
        if (search.setSelectionRange) search.setSelectionRange(a,b);
      } catch(_e) {}
    });
  }
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

  const hasQ = qTokens.length > 0;
  const baseSet = new Set();
  for (const sp0 of claimable){
    const norm = fixName(sp0);
    if (!norm) continue;

    const base0 = pokeApi.baseOfSync(norm, baseCache);
    const base = base0 || norm;

    if (!hasQ){
      baseSet.add(base);
      continue;
    }

    const claimed = data.claimedSets?.[norm] || data.claimedSets?.[base] || null;
    const hay = buildSearchHaystack(norm, base, claimed);
    const hayCompact = hay.replace(/\s+/g,'');

    let ok = true;
    for (const t of qTokens){
      if (!t) continue;
      if (hay.includes(t) || hayCompact.includes(t)) continue;
      ok = false;
      break;
    }
    if (ok) baseSet.add(base);
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
  if (!baseList.length){
    grid.appendChild(el('div', {class:'muted small', style:'padding:10px'}, 'No matches. Try a Pokémon, ability, or move name.'));
  } else {
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
      store.update(s=>{
        // Normal browsing: only set origin if one isn't already established (e.g. opened from Roster).
        if (!s.ui.dexOrigin) s.ui.dexOrigin = 'unlocked';
        if (!s.ui.dexReturnTab) s.ui.dexReturnTab = 'unlocked';
        s.ui.dexDetailBase = base;
        s.ui.dexSelectedForm = base;
      });
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


  }
  search.addEventListener('input', ()=>{
    // Snapshot caret before the DOM node gets replaced on re-render.
    __searchUnlockedRestore = {
      a: (typeof search.selectionStart === 'number') ? search.selectionStart : String(search.value||'').length,
      b: (typeof search.selectionEnd === 'number') ? search.selectionEnd : ((typeof search.selectionStart === 'number') ? search.selectionStart : String(search.value||'').length),
    };
    store.update(s=>{ s.ui.searchUnlocked = search.value; });
  });
}


  return { render: renderUnlocked };
}
