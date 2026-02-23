// js/app/app.js
// v2.0.0-beta
// Abundant Shrine — Roster Planner UI + orchestration (Waves tab planner UX + auto-match display)

import { $, $$, el, pill, formatPct, clampInt, sprite } from '../ui/dom.js';
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
import {
  ITEM_CATALOG,
  lootBundle,
  normalizeBagKey,
  computeRosterUsage,
  availableCount,
  enforceBagConstraints,
  isGem,
  isPlate,
} from '../domain/items.js';

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
        store.update(s => { s.ui.tab = t; });
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
      ovSprite.src = sprite(calc, defName);
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

    const startAnimal = state.settings?.startWaveAnimal || 'Goat';

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

    const lootOptions = fixedName
      ? [fixedName]
      : ITEM_CATALOG.slice();

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


      const sp = el('img', {class:'sprite sprite-sm', src:sprite(calc, s.defender), alt:s.defender});
      sp.onerror = ()=> sp.style.opacity='0.25';
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

      enemyList.appendChild(rowEl);
    }

    const activeRoster = state.roster.filter(r=>r.active).slice(0,16);

    const MAX_FIGHTS_PER_WAVE = 4;
    const existingStack = (state.ui?.fightUndo && state.ui.fightUndo[waveKey]) ? state.ui.fightUndo[waveKey] : [];
    const fightCount = Array.isArray(existingStack) ? existingStack.length : 0;

    // Fight plan + suggestions
    const fightBtn = el('button', {class:'btn-mini'}, 'Fight');
    fightBtn.title = 'Simulate this wave fight: consumes PP, marks slots cleared, and unlocks base species.';
    if (fightCount >= MAX_FIGHTS_PER_WAVE) fightBtn.disabled = true;

    const undoBtn = el('button', {class:'btn-mini'}, 'Undo');
    undoBtn.title = 'Undo the last Fight for this wave (restores PP, cleared flags, unlocks, and fight log).';
    if (fightCount <= 0) undoBtn.disabled = true;

    const countLabel = el('span', {class:'muted small'}, `Fights: ${fightCount}/${MAX_FIGHTS_PER_WAVE}`);

    const planEl = el('div', {class:'panel'}, [
      el('div', {style:'display:flex; align-items:center; justify-content:space-between; gap:10px'}, [
        el('div', {class:'panel-title'}, 'Fight plan'),
        el('div', {style:'display:flex; align-items:center; gap:8px'}, [countLabel, fightBtn, undoBtn]),
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
      return calc.chooseBestMove({
        data,
        attacker:{
          species:(attackerMon.effectiveSpecies||attackerMon.baseSpecies),
          level: state.settings.claimedLevel,
          ivAll: state.settings.claimedIV,
          evAll: attackerMon.strength ? state.settings.strengthEV : state.settings.claimedEV,
        },
        defender:defObj,
        movePool: attackerMon.movePool||[],
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


    function ensureFightUndo(s){
      s.ui = s.ui || {};
      s.ui.fightUndo = s.ui.fightUndo || {};
      if (!Array.isArray(s.ui.fightUndo[waveKey])) s.ui.fightUndo[waveKey] = [];
      return s.ui.fightUndo[waveKey];
    }

    undoBtn.addEventListener('click', ()=>{
      store.update(s=>{
        const stack = ensureFightUndo(s);
        const rec = stack.pop();
        if (!rec) return;

        s.cleared = s.cleared || {};
        s.unlocked = s.unlocked || {};
        s.ui = s.ui || {};
        s.ui.fightLog = s.ui.fightLog || {};

        // Restore PP
        for (const p of (rec.ppPrev||[])){
          const mon = byId(s.roster||[], p.attackerId);
          if (!mon) continue;
          const mv = (mon.movePool||[]).find(x=>x.name===p.move);
          if (!mv) continue;
          if (Number.isFinite(Number(p.prevPPMax))) mv.ppMax = Math.max(1, Math.floor(Number(p.prevPPMax)));
          mv.pp = Number.isFinite(Number(p.prevPP)) ? Math.max(0, Math.floor(Number(p.prevPP))) : mv.pp;
        }

        // Restore cleared flags
        for (const [rk, prev] of Object.entries(rec.clearedPrev||{})){
          if (prev) s.cleared[rk] = true;
          else delete s.cleared[rk];
        }

        // Restore unlocks
        for (const [base, prev] of Object.entries(rec.unlockedPrev||{})){
          if (prev) s.unlocked[base] = true;
          else delete s.unlocked[base];
        }

        // Restore wave log
        if (Array.isArray(rec.logPrev)) s.ui.fightLog[waveKey] = rec.logPrev.slice(0, 20);

        // Revert completion reward (if this Fight granted one)
        if (rec.reward){
          const g = Math.max(0, Math.floor(Number(rec.reward.gold)||0));
          if (g){
            s.wallet = s.wallet || {};
            s.wallet.gold = Math.max(0, Math.floor(Number(s.wallet.gold)||0) - g);
          }
          const items = rec.reward.items || {};
          s.bag = s.bag || {};
          for (const [k,v0] of Object.entries(items)){
            const v = Math.max(0, Math.floor(Number(v0)||0));
            if (!v) continue;
            const cur = Number(s.bag[k]||0);
            const next = cur - v;
            if (next <= 0) delete s.bag[k];
            else s.bag[k] = next;
          }
        }

      });
    });

    // --- Fight simulation (very lightweight): consumes 1 PP from the chosen move(s),
    // marks selected defender slots as cleared, and unlocks the base species.

    fightBtn.addEventListener('click', ()=>{
      const st0 = store.getState();
      const stack0 = (st0.ui?.fightUndo && Array.isArray(st0.ui.fightUndo[waveKey])) ? st0.ui.fightUndo[waveKey] : [];
      if (stack0.length >= MAX_FIGHTS_PER_WAVE){
        alert(`This wave is capped at ${MAX_FIGHTS_PER_WAVE} fights. Use Undo if you need to change something.`);
        return;
      }

      if (!allDef.length) {
        alert('Select at least 1 enemy first.');
        return;
      }
      if (!startersOrdered.length){
        alert('You need at least 1 active roster mon.');
        return;
      }

      // Build matchups to execute
      const matchups = [];
      if (defLimit === 2 && allDef.length === 2 && startersOrdered.length === 2){
        const plan = bestAssignmentForWavePair(data, st0, wp, startersOrdered[0], startersOrdered[1], allDef[0], allDef[1]);
        for (const a of (plan?.assign||[])){
          if (a?.attacker && a?.defSlot && a?.best?.move) matchups.push({attackerId:a.attacker.id, attackerLabel:rosterLabel(a.attacker), defSlot:a.defSlot, move:a.best.move});
        }
      } else {
        // 1v1 planning: for each selected enemy, pick better of the two starters.
        for (const ds of allDef){
          const a0 = startersOrdered[0] || null;
          const a1 = startersOrdered[1] || null;
          const b0 = bestMoveFor(a0, ds);
          const b1 = bestMoveFor(a1, ds);
          const pick = betterPick(a0, b0, a1, b1);
          if (pick.attacker && pick.best?.move){
            matchups.push({attackerId:pick.attacker.id, attackerLabel:rosterLabel(pick.attacker), defSlot:ds, move:pick.best.move});
          }
        }
      }

      if (!matchups.length){
        alert('No valid matchups (missing move data or no usable moves).');
        return;
      }

      const fightId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      // Apply state changes + create undo record
      store.update(s=>{
        const stack = ensureFightUndo(s);
        if (stack.length >= MAX_FIGHTS_PER_WAVE) return;

        s.cleared = s.cleared || {};
        s.unlocked = s.unlocked || {};
        s.ui = s.ui || {};
        s.ui.fightLog = s.ui.fightLog || {};

        const prevLog = (s.ui.fightLog[waveKey] || []).slice();

        const rec = {
          id: fightId,
          ppPrev: [],
          clearedPrev: {},
          unlockedPrev: {},
          logPrev: prevLog,
          matchups: matchups.map(m=>({rowKey:m.defSlot?.rowKey, defender:m.defSlot?.defender, attackerId:m.attackerId, move:m.move})),
        };

        const nextLog = prevLog.slice();

        for (const m of matchups){
          const mon = byId(s.roster||[], m.attackerId);
          if (!mon) continue;
          const mv = (mon.movePool||[]).find(x=>x.name === m.move);
          if (mv){
            const prevPPMax = Number.isFinite(Number(mv.ppMax)) ? Math.max(1, Math.floor(Number(mv.ppMax))) : 12;
            const prevPP = Number.isFinite(Number(mv.pp)) ? Math.max(0, Math.floor(Number(mv.pp))) : prevPPMax;
            rec.ppPrev.push({attackerId: mon.id, move: m.move, prevPP, prevPPMax});

            mv.ppMax = prevPPMax;
            mv.pp = prevPP;
            if (mv.pp > 0) mv.pp -= 1;
          }

          // Cleared
          const rk = m.defSlot.rowKey;
          if (!(rk in rec.clearedPrev)) rec.clearedPrev[rk] = !!s.cleared[rk];
          s.cleared[rk] = true;

          // Unlock: only if we already have a known base mapping (avoid wrongly unlocking evo forms).
          const norm = fixName(m.defSlot.defender);
          const baseKnown = (s.baseCache||{})[norm] || null;
          if (baseKnown){
            if (!(baseKnown in rec.unlockedPrev)) rec.unlockedPrev[baseKnown] = !!s.unlocked[baseKnown];
            s.unlocked[baseKnown] = true;
          }

          const ppStr = mv ? ` (PP ${mv.pp}/${mv.ppMax})` : '';
          const line = `${m.defSlot.defender} ← ${m.attackerLabel}: ${m.move}${ppStr}`;
          nextLog.unshift(line);
        }

        // Defender targeting + log: each enemy attacks the on-field attacker it can damage the most.
        // IMPORTANT: if we (guaranteed) OHKO a defender before it can act, it should not show an attack line.
        try{
          const w = s.wavePlans?.[waveKey] || wp;
          const onField = (w.attackerOrder || w.attackerStart || [])
            .slice(0,2)
            .map(id=>byId(s.roster||[], id))
            .filter(Boolean);

          const clampPrio = (p)=>{
            const n = Number(p);
            if (!Number.isFinite(n)) return 3;
            return Math.max(1, Math.min(3, Math.floor(n)));
          };

          const avgPct = (t)=>{
            const mi = Number(t?.minPct)||0;
            const ma0 = Number(t?.maxPct);
            const ma = Number.isFinite(ma0) ? ma0 : mi;
            return (mi + ma) / 2;
          };

          const attackerActsBeforeEnemy = ({atkPrio, atkSpe, enemyPrio, enemySpe, enemyTieFirst})=>{
            const ap = clampPrio(atkPrio);
            const ep = clampPrio(enemyPrio);
            if (ap !== ep) return ap < ep;
            const as = Number(atkSpe)||0;
            const es = Number(enemySpe)||0;
            if (as !== es) return as > es;
            return !enemyTieFirst; // tie → enemy first if configured
          };

          // Precompute our outgoing (per defender slot) so we can suppress phantom enemy attacks
          const outByRowKey = {};
          for (const m of (matchups||[])){
            const rk = m?.defSlot?.rowKey;
            if (!rk) continue;
            const mon = byId(s.roster||[], m.attackerId);
            if (!mon) continue;

            const mvEntry = (mon.movePool||[]).find(x=>x && x.name===m.move) || null;
            const atkPrio = clampPrio(mvEntry?.prio);

            const atkObj = {
              species: (mon.effectiveSpecies||mon.baseSpecies),
              level: s.settings.claimedLevel,
              ivAll: s.settings.claimedIV,
              evAll: mon.strength ? s.settings.strengthEV : s.settings.claimedEV,
            };
            const defObj = {
              species: m.defSlot.defender,
              level: m.defSlot.level,
              ivAll: s.settings.wildIV,
              evAll: s.settings.wildEV,
            };

            const r = window.SHRINE_CALC.computeDamageRange({
              data,
              attacker: atkObj,
              defender: defObj,
              moveName: m.move,
              settings: settingsForWave(s, w, mon.id, rk),
              tags: m.defSlot.tags || [],
            });

            outByRowKey[rk] = {
              oneShot: !!r?.oneShot,
              atkPrio,
              atkSpe: Number(r?.attackerSpe)||0,
              defSpe: Number(r?.defenderSpe)||0,
            };
          }

          const incoming = [];
          for (const ds of (allDef||[])){
            let best = null;
            for (const a of onField){
              const t = enemyThreatForMatchup(data, s, w, a, ds) || assumedEnemyThreatForMatchup(data, s, w, a, ds);
              if (!t) continue;
              if (!best) best = {attacker:a, threat:t};
              else {
                const aa = avgPct(t);
                const bb = avgPct(best.threat);
                if (aa > bb) best = {attacker:a, threat:t};
                else if (aa === bb){
                  const ax = Number(t.maxPct)||Number(t.minPct)||0;
                  const bx = Number(best.threat.maxPct)||Number(best.threat.minPct)||0;
                  if (ax > bx) best = {attacker:a, threat:t};
                  else if (ax === bx){
                    const am = Number(t.minPct)||0;
                    const bm = Number(best.threat.minPct)||0;
                    if (am > bm) best = {attacker:a, threat:t};
                  }
                }
              }
            }
            if (best && best.threat){
              const mv = best.threat.move || '—';

              // Suppress the log line if we (guaranteed) OHKO this defender before it can act.
              const out = outByRowKey[ds.rowKey] || null;
              const enemyTieFirst = !!(s.settings?.enemySpeedTieActsFirst ?? true);

              let suppress = false;
              if (out && out.oneShot){
                const enemyPrio = clampPrio(best.threat.prio ?? 2);
                const enemySpe = Number(best.threat.attackerSpe)||out.defSpe||0;
                const atkSpe = out.atkSpe || Number(best.threat.defenderSpe)||0;

                const attackerFirst = attackerActsBeforeEnemy({
                  atkPrio: out.atkPrio,
                  atkSpe,
                  enemyPrio,
                  enemySpe,
                  enemyTieFirst,
                });

                if (attackerFirst) suppress = true;
              }

              if (!suppress){
                incoming.push(`ENEMY ${ds.defender} → ${rosterLabel(best.attacker)}: ${mv} · ${formatPct(best.threat.minPct)} min`);
              }
            }
          }

          for (let i=incoming.length-1;i>=0;i--){
            nextLog.unshift(incoming[i]);
          }
        }catch(e){ /* ignore */ }

        s.ui.fightLog[waveKey] = nextLog.slice(0, 20);
        stack.push(rec);

        // Wave 12 (Phase 1) completion reward: after the 4th Fight, grant 10 gold + 1 Revive.
        if (waveKey === 'P1W12' && stack.length === MAX_FIGHTS_PER_WAVE){
          const rewardGold = 10;
          const rewardItem = 'Revive';

          rec.reward = {gold: rewardGold, items: {[rewardItem]: 1}};

          s.wallet = s.wallet || {};
          s.wallet.gold = Math.max(0, Math.floor(Number(s.wallet.gold)||0)) + rewardGold;

          s.bag = s.bag || {};
          s.bag[rewardItem] = (Number(s.bag[rewardItem]||0) + 1);
        }

      });

      // Resolve bases async so unlock sticks to true BASE species.
      for (const m of matchups){
        const rk = m.defSlot.rowKey;
        pokeApi.resolveBaseSpecies(m.defSlot.defender, store.getState().baseCache||{})
          .then(({base:resolved, updates})=>{
            store.update(st=>{
              st.baseCache = {...(st.baseCache||{}), ...(updates||{})};
              // Only unlock if this fight still exists AND the slot is still cleared (undo-safe).
              if (!st.cleared?.[rk]) return;
              const stack = (st.ui?.fightUndo && Array.isArray(st.ui.fightUndo[waveKey])) ? st.ui.fightUndo[waveKey] : [];
              const rec = stack.find(x=>x && x.id===fightId);
              if (!rec) return;
              if (resolved){
                if (!(resolved in rec.unlockedPrev)) rec.unlockedPrev[resolved] = !!st.unlocked?.[resolved];
                st.unlocked[resolved] = true;
              }
            });
          })
          .catch(()=>{});
      }
    });

	    let startersClear = 0;
    const planTable = el('div', {class:'plan'});

    if (!allDef.length){
      planTable.appendChild(el('div', {class:'muted small', style:'padding:10px 0'}, 'Select enemies to see the fight plan.'));
    } else if (defLimit === 2 && allDef.length === 2 && startersOrdered.length === 2){
      const a0 = startersOrdered[0];
      const a1 = startersOrdered[1];
      const plan = bestAssignmentForWavePair(data, state, wp, a0, a1, allDef[0], allDef[1]);
      const assigned = (plan?.assign||[]);
      startersClear = plan?.meta?.ohko ?? 0;

      for (const ds of allDef){
        const pick = assigned.find(x=>x.defSlot === ds) || {attacker:null, best:null};
        const oneShot = !!pick.best?.oneShot;

        const tp = defenderTargetPick(ds);
        const threat = tp.threat;

        const inPill = (showThreat && threat)
          ? pill(threat.oneShot ? 'IN OHKO' : `IN ${formatPct(threat.minPct)}`, threat.oneShot ? 'bad' : 'warn')
          : null;
        if (inPill) inPill.title = threatTooltip(threat);

        const targetPill = (showThreat && threat && tp.attacker)
          ? pill(`→ ${rosterLabel(tp.attacker)}`, 'warn')
          : null;

        const firstPill = (showThreat && threat && threat.enemyActsFirst)
          ? pill('ENEMY FIRST','warn')
          : null;

        planTable.appendChild(el('div', {class:'plan-line'}, [
          el('div', {class:'plan-left'}, [
            el('strong', {}, ds.defender),
            el('span', {class:'muted'}, ` · Lv ${ds.level}`),
          ]),
          el('div', {class:'plan-right'}, [
            pick.best
              ? el('span', {}, `${pick.attacker ? rosterLabel(pick.attacker) : '—'}: ${pick.best.move} (P${pick.best.prio}) · ${formatPct(pick.best.minPct)} min`)
              : el('span', {class:'muted'}, 'No move data'),
            oneShot ? pill('OHKO','good') : pill('NO','bad'),
            inPill,
            targetPill,
            firstPill,
            (threat?.diesBeforeMove ? pill('DIES','bad') : null),
            (!oneShot ? pill('SWITCH','warn') : null),
          ]),
        ]));
      }
    } else {
      for (const ds of allDef){
        const a0 = startersOrdered[0];
        const a1 = startersOrdered[1];
        const b0 = a0 ? bestMoveFor(a0, ds) : null;
        const b1 = a1 ? bestMoveFor(a1, ds) : null;

        const pick = betterPick(a0, b0, a1, b1);
        const oneShot = !!pick.best?.oneShot;
        if (oneShot) startersClear += 1;

        const tp = defenderTargetPick(ds);
        const threat = tp.threat;

        const inPill = (showThreat && threat)
          ? pill(threat.oneShot ? 'IN OHKO' : `IN ${formatPct(threat.minPct)}`, threat.oneShot ? 'bad' : 'warn')
          : null;
        if (inPill) inPill.title = threatTooltip(threat);

        const targetPill = (showThreat && threat && tp.attacker)
          ? pill(`→ ${rosterLabel(tp.attacker)}`, 'warn')
          : null;

        const firstPill = (showThreat && threat && threat.enemyActsFirst)
          ? pill('ENEMY FIRST','warn')
          : null;

        planTable.appendChild(el('div', {class:'plan-line'}, [
          el('div', {class:'plan-left'}, [
            el('strong', {}, ds.defender),
            el('span', {class:'muted'}, ` · Lv ${ds.level}`),
          ]),
          el('div', {class:'plan-right'}, [
            pick.best
              ? el('span', {}, `${pick.attacker ? rosterLabel(pick.attacker) : '—'}: ${pick.best.move} (P${pick.best.prio}) · ${formatPct(pick.best.minPct)} min`)
              : el('span', {class:'muted'}, 'No move data'),
            oneShot ? pill('OHKO','good') : pill('NO','bad'),
            inPill,
            targetPill,
            firstPill,
            (threat?.diesBeforeMove ? pill('DIES','bad') : null),
            (!oneShot ? pill('SWITCH','warn') : null),
          ]),
        ]));
      }
    }

    planEl.appendChild(el('div', {class:'muted small'}, `Starters clear ${startersClear}/${allDef.length} without switching.`));
    planEl.appendChild(planTable);

    // Fight log (last 20 actions)
    const log = (state.ui?.fightLog && state.ui.fightLog[waveKey]) ? state.ui.fightLog[waveKey] : [];
    if (Array.isArray(log) && log.length){
      const logWrap = el('div', {style:'margin-top:10px'}, [
        el('div', {class:'panel-subtitle'}, 'Fight log'),
        el('div', {class:'muted small'}, 'Newest first. Clicking Fight appends entries and consumes PP.'),
      ]);
      const ul = el('div', {class:'small', style:'margin-top:6px; display:flex; flex-direction:column; gap:4px;'});
      for (const line of log.slice(0, 10)){
        ul.appendChild(el('div', {class:'muted'}, line));
      }
      logWrap.appendChild(ul);
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
        const chipEl = el('div', {class:'chip'}, [
          el('strong', {}, `${rosterLabel(p.a)} + ${rosterLabel(p.b)}`),
          el('span', {class:'muted'}, ` · OHKO ${meta.ohko ?? 0}/2`),
          el('span', {class:'muted'}, ` · prio P${meta.prioWorst ?? '?'}`),
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

  // ---------------- Bag ----------------

  function renderBag(state){
    tabBag.innerHTML = '';

    const sellPrice = (itemName)=>{
      const name = String(itemName||'');
      if (!name) return 0;
      // Sell prices (early economy; will be expanded later)
      if (name === 'Evo Charm') return 8;
      if (name === 'Strength Charm') return 6;
      if (name.startsWith('Rare Candy')) return 0;

      if (name === 'Copper Coin') return 1;
      if (isGem(name)) return 1;
      if (isPlate(name)) return 5;
      // Placeholder default; we'll refine the exact economy later.
      return 8;
    };

    const buyPrice = (itemName)=>{
      const key = normalizeBagKey(itemName) || String(itemName||'');
      if (!key) return 0;
      // Coins are loot-only.
      if (key === 'Copper Coin') return 0;
      // Placeholder shop prices: buy = 2x sell (matches charms: 16/12).
      if (key === 'Rare Candy') return 16;
      const s = sellPrice(key);
      return (s > 0) ? (s * 2) : 0;
    };

    function ensureBagUndo(s){
      s.ui = s.ui || {};
      if (!Array.isArray(s.ui.bagUndo)) s.ui.bagUndo = [];
      return s.ui.bagUndo;
    }

    const right = el('div', {class:'panel'}, [
      el('div', {class:'panel-title'}, 'Bag'),
      el('div', {class:'muted small'}, 'Shared team bag. Items come from Wave loot. Charms + held items consume from shared totals.'),
    ]);

    const walletRow = el('div', {class:'kv', style:'margin-top:8px'}, [
      el('div', {class:'k'}, 'Gold'),
      el('div', {}, String(Math.max(0, Math.floor(Number(state.wallet?.gold)||0)))),
    ]);
    right.appendChild(walletRow);

    const bagUndoBtn = el('button', {class:'btn-mini'}, 'Undo last bag action');
    const bagUndoStack = Array.isArray(state.ui?.bagUndo) ? state.ui.bagUndo : [];
    if (!bagUndoStack.length) bagUndoBtn.disabled = true;
    bagUndoBtn.addEventListener('click', ()=>{
      store.update(s=>{
        const st = ensureBagUndo(s);
        const rec = st.pop();
        if (!rec) return;

        const invBag = -Number(rec.bagDelta||0);
        const invGold = -Number(rec.goldDelta||0);
        const item = String(rec.item||'');
        if (item){
          s.bag = s.bag || {};
          const cur = Number(s.bag[item]||0);
          const next = cur + invBag;
          if (next <= 0) delete s.bag[item];
          else s.bag[item] = next;
        }

        s.wallet = s.wallet || {};
        s.wallet.gold = Math.max(0, Math.floor(Number(s.wallet.gold)||0) + invGold);

        // Restore any roster item that was cleared by a bag "Use" action
        if (Array.isArray(rec.rosterRestore)){
          for (const rr of rec.rosterRestore){
            const mon = byId(s.roster||[], rr.id);
            if (!mon) continue;
            // Only restore if the slot is empty; don't overwrite a new assignment.
            if (!mon.item) mon.item = rr.prevItem || null;
          }
        }

        enforceBagConstraints(data, s, applyCharmRulesSync);
      });
    });

    right.appendChild(el('div', {style:'margin-top:8px; display:flex; justify-content:flex-end;'}, [bagUndoBtn]));

    const tbl = el('table', {class:'bag-table'}, [
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
    const used = computeRosterUsage(state);
    const names = Object.keys(state.bag||{}).sort((a,b)=>a.localeCompare(b));
    if (!names.length){
      tbody.appendChild(el('tr', {}, [
        el('td', {colspan:'6', class:'muted'}, 'No items yet.'),
      ]));
    } else {
      for (const name of names){
        const qty = Number(state.bag[name]) || 0;
        const u = Number(used[name]||0);
        const avail = qty - u;

        const canUse = (isGem(name) || name === 'Air Balloon' || name === 'Revive');
        const use1 = el('button', {class:'btn-mini'}, 'Use 1');
        if (!canUse || qty <= 0) use1.disabled = true;
        use1.title = canUse ? 'Consume 1 (undoable). For held items, this also clears it from the roster.' : 'Not usable';
        use1.addEventListener('click', ()=>{
          if (!canUse) return;
          store.update(s=>{
            const undo = ensureBagUndo(s);
            const have = Number(s.bag?.[name]||0);
            if (have <= 0) return;

            // If this is a held item, clear it from the current holder (if any) before consuming.
            const rosterRestore = [];
            const holder = (s.roster||[]).find(r=>r && r.item === name);
            if (holder){
              rosterRestore.push({id: holder.id, prevItem: name});
              holder.item = null;
            }

            const next = have - 1;
            if (next <= 0) delete s.bag[name];
            else s.bag[name] = next;

            undo.push({type:'use', item:name, qty:1, bagDelta:-1, goldDelta:0, rosterRestore, at:Date.now()});
            if (undo.length > 50) undo.splice(0, undo.length - 50);

            enforceBagConstraints(data, s, applyCharmRulesSync);
          });
        });

        const sell1 = el('button', {class:'btn-mini'}, 'Sell 1');
        const price = sellPrice(name);
        if (!(price > 0) || avail <= 0) sell1.disabled = true;
        sell1.title = (price > 0) ? `${price} gold` : 'Not sellable';
        sell1.addEventListener('click', ()=>{
          if (!(price > 0)) return;
          store.update(s=>{
            const undo = ensureBagUndo(s);
            const used2 = computeRosterUsage(s);
            const have = Number(s.bag?.[name]||0);
            const u2 = Number(used2?.[name]||0);
            const a2 = have - u2;
            if (a2 <= 0) return;
            const next = have - 1;
            if (next <= 0) delete s.bag[name];
            else s.bag[name] = next;
            s.wallet = s.wallet || {};
            s.wallet.gold = Math.max(0, Math.floor(Number(s.wallet.gold)||0)) + price;

            undo.push({type:'sell', item:name, qty:1, bagDelta:-1, goldDelta:+price, at:Date.now()});
            if (undo.length > 50) undo.splice(0, undo.length - 50);

            enforceBagConstraints(data, s, applyCharmRulesSync);
          });
        });

        tbody.appendChild(el('tr', {}, [
          el('td', {}, name),
          el('td', {}, String(qty)),
          el('td', {}, String(u)),
          el('td', {}, el('span', {class: avail < 0 ? 'pill bad' : 'pill good'}, avail < 0 ? `-${Math.abs(avail)}` : String(avail))),
          el('td', {}, use1),
          el('td', {}, sell1),
        ]));
      }
    }

    right.appendChild(tbl);


    const shop = el('div', {class:'panel', style:'margin-top:12px'}, [
      el('div', {class:'panel-title'}, "Politoed's Shop"),
      el('div', {class:'muted small'}, 'Buy items with gold. Prices are placeholders for now (buy = 2× sell; gems/coins simplified).'),
    ]);

    const shopList = el('div', {class:'shop-grid'});

    const shopItems = uniq(ITEM_CATALOG.map(x=>normalizeBagKey(x)).filter(Boolean))
      .filter(x=>x !== 'Copper Coin')
      .sort((a,b)=>String(a).localeCompare(String(b)));

    const goldNow = Math.max(0, Math.floor(Number(state.wallet?.gold)||0));
    for (const name of shopItems){
      const price = buyPrice(name);
      const buyBtn = el('button', {class:'btn-mini'}, 'Buy');
      if (!(price > 0) || goldNow < price) buyBtn.disabled = true;

      buyBtn.addEventListener('click', ()=>{
        store.update(s=>{
          const undo = ensureBagUndo(s);
          const gold = Math.max(0, Math.floor(Number(s.wallet?.gold)||0));
          const cost = buyPrice(name);
          if (!(cost > 0)) return;
          if (gold < cost){
            alert('Not enough gold.');
            return;
          }

          s.wallet = s.wallet || {};
          s.wallet.gold = gold - cost;
          s.bag = s.bag || {};
          const cur = Number(s.bag[name]||0);
          s.bag[name] = cur + 1;

          undo.push({type:'buy', item:name, qty:1, bagDelta:+1, goldDelta:-cost, at:Date.now()});
          if (undo.length > 50) undo.splice(0, undo.length - 50);

          enforceBagConstraints(data, s, applyCharmRulesSync);
        });
      });

      const row = el('div', {class:'shop-row'}, [
        el('div', {}, name),
        el('div', {class:'muted small'}, (price > 0) ? `price: ${price}g` : 'price: —'),
        buyBtn,
      ]);
      shopList.appendChild(row);
    }
    shop.appendChild(shopList);

    right.appendChild(shop);

    tabBag.appendChild(right);
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
        const img = el('img', {class:'sprite', src:sprite(calc, sp), alt:sp});
        img.onerror = ()=> img.style.opacity='0.25';
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

    const spImg = el('img', {class:'sprite sprite-lg', src:sprite(calc, eff), alt:eff});
    spImg.onerror = ()=> spImg.style.opacity = '0.25';

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
        s.ui.dexReturn = {tab:'roster', selectedRosterId: r.id};
        s.ui.dexDetailBase = base;
        s.ui.dexSelectedForm = eff;
        s.ui.dexDefenderLevel = null;
      });
      // Fill evo line async
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

  // ---------------- Unlocked (Pokédex) ----------------

  function renderUnlocked(state){
    tabUnlocked.innerHTML = '';

    // Pokédex should at least include everything that appears in the shrine waves.
    const claimable = uniq([
      ...Object.keys(data.claimedSets || {}),
      ...speciesListFromSlots(data.calcSlots || []),
    ]).sort((a,b)=>a.localeCompare(b));
    const q = (state.ui.searchUnlocked || '').toLowerCase().trim();

    // Detail view (layer/page)
    if (state.ui.dexDetailBase){
      const base = state.ui.dexDetailBase;
      const locked = !state.unlocked?.[base];
      const line = (state.evoLineCache && state.evoLineCache[base]) ? state.evoLineCache[base] : [base];
      const selected = state.ui.dexSelectedForm || line[0] || base;

      // Defender levels should come from where this species appears in waves.
      const rawLvls = (data.calcSlots||[])
        .filter(s => fixName(s.defender) === fixName(selected) || fixName(s.defender) === fixName(base))
        .map(s => Number(s.level))
        .filter(v => Number.isFinite(v) && v > 0);
      const levels = uniq(rawLvls).sort((a,b)=>a-b);
      const fallbackLvl = Number(state.settings.claimedLevel || 50);
      const preferred = Number(state.ui.dexDefenderLevel);
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

      const dexObj = data.dex?.[selected] || null;
      const typesArr = (dexObj && Array.isArray(dexObj.types)) ? dexObj.types : [];
      const typesStr = typesArr.length ? typesArr.join(' / ') : '—';
      const baseStats = dexObj?.base || null;
      const bst = (dexObj && (typeof dexObj.bst === 'number'))
        ? dexObj.bst
        : (baseStats ? (baseStats.hp||0)+(baseStats.atk||0)+(baseStats.def||0)+(baseStats.spa||0)+(baseStats.spd||0)+(baseStats.spe||0) : 0);

      const claimed = resolveClaimedSet(base, selected);
      const ability = claimed?.ability || '—';
      const moves = Array.isArray(claimed?.moves) ? claimed.moves : [];

      const ret = state.ui?.dexReturn || null;
      const backLabel = (ret && ret.tab === 'roster') ? '← Back to Roster' : '← Back to Pokédex';
      const backBtn = el('button', {class:'btn-mini'}, backLabel);
      backBtn.addEventListener('click', ()=>{
        store.update(s=>{
          const r0 = s.ui?.dexReturn || null;
          s.ui.dexDetailBase = null;
          s.ui.dexSelectedForm = null;
          s.ui.dexDefenderLevel = null;
          s.ui.dexReturn = null;

          if (r0 && r0.tab === 'roster'){
            s.ui.tab = 'roster';
            if (r0.selectedRosterId) s.ui.selectedRosterId = r0.selectedRosterId;
          }
        });
      });

      const lvlSel = (levels.length > 1) ? (function(){
        const sel = el('select', {class:'sel-mini'}, levels.map(v => el('option', {value:String(v), selected:Number(v)===Number(lvl)}, String(v))));
        sel.addEventListener('change', ()=>{
          const v = Number(sel.value);
          store.update(s=>{ s.ui.dexDefenderLevel = Number.isFinite(v) ? v : null; });
        });
        return sel;
      })() : null;

      const head = el('div', {class:'dex-detail-head'}, [
        el('div', {class:'dex-detail-head-left'}, [
          backBtn,
          el('div', {class:'panel-title'}, base),
          pill(locked ? 'Locked' : 'Unlocked', locked ? 'bad' : 'good'),
        ]),
        el('div', {style:'display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end;'}, [
          el('div', {class:'muted small'}, 'Defender level:'),
          lvlSel || el('div', {class:'muted small'}, String(lvl)),
        ]),
      ]);

      const evoRow = el('div', {class:'dex-evo-row'});
      for (const sp of line){
        const btn = el('button', {class:'dex-form' + (sp===selected ? ' active' : '')}, [
          el('img', {class:'sprite sprite-lg', src:sprite(calc, sp), alt:sp}),
          el('div', {class:'dex-form-name'}, sp),
        ]);
        btn.addEventListener('click', ()=>{
          store.update(s=>{ s.ui.dexSelectedForm = sp; });
        });
        evoRow.appendChild(btn);
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

      const moveBadges = el('div', {class:'dex-moves'},
        moves.length ? moves.map(m => el('span', {class:'dex-move'}, m)) : [el('div', {class:'muted'}, '—')]
      );

      const info = el('div', {class:'panel', style:'margin-top:12px'}, [
        el('div', {class:'dex-hero'}, [
          el('img', {class:'sprite sprite-xl', src:sprite(calc, selected), alt:selected}),
          el('div', {class:'dex-hero-meta'}, [
            el('div', {class:'dex-hero-title'}, selected),
            (selected !== base) ? el('div', {class:'dex-hero-sub'}, `Base: ${base}`) : el('div', {class:'dex-hero-sub'}, ' '),
            el('div', {class:'dex-hero-badges'}, [
              ...typesArr.map(t => pill(t)),
              pill(`BST ${bst}`,'warn'),
            ]),
          ]),
        ]),
        el('div', {class:'hr'}),
        el('div', {class:'kv'}, [el('div',{class:'k'},'Types'), el('div',{},typesStr)]),
        el('div', {class:'kv'}, [el('div',{class:'k'},'Ability'), el('div',{},ability)]),
        el('div', {class:'kv'}, [el('div',{class:'k'},'BST'), el('div',{},String(bst))]),
        el('div', {class:'panel-subtitle', style:'margin-top:10px'}, 'Base stats'),
        statGrid,
        el('div', {class:'panel-subtitle', style:'margin-top:10px'}, 'Moveset'),
        moveBadges,
      ]);

      const tablePanel = el('div', {class:'panel', style:'margin-top:12px'}, [
        el('div', {class:'panel-title'}, `One-shot vs active roster — ${selected}`),
        buildOneShotTable(state, selected, lvl, []),
      ]);

      const wrap = el('div', {class:'panel'}, [
        head,
        el('div', {class:'hr'}),
        el('div', {class:'panel-subtitle'}, 'Evolution line'),
        evoRow,
      ]);

      tabUnlocked.appendChild(wrap);
      tabUnlocked.appendChild(info);
      tabUnlocked.appendChild(tablePanel);
      return;
    }

    // Base-species grid view
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

    const filtered = claimable.filter(sp => !q || sp.toLowerCase().includes(q));

    // Best-effort base resolution for visible rows (we only show BASE forms in the grid).
    // We also include base forms for wave-only species (evo-only appearances).
    prefetchBaseForSpeciesList(filtered.slice(0, 1200));

    const baseSet = new Map();
    const unresolvedList = [];

    // Anything already unlocked should be a BASE species. If it isn't, map it back to its base.
    for (const k of Object.keys(state.unlocked||{})){
      if (!state.unlocked[k]) continue;
      const norm = fixName(k);
      const base = (state.baseCache||{})[norm] || null;
      if (base){
        baseSet.set(base, true);
      } else if (data.claimedSets?.[k]){
        // If we have a claimed-set entry, treat it as a base (good enough until base resolves).
        baseSet.set(k, true);
      } else {
        unresolvedList.push(k);
      }
    }

    // Add bases for any visible species list entries (from waves + claimed sets).
    for (const sp of filtered){
      const norm = fixName(sp);
      const base = (state.baseCache||{})[norm] || null;
      if (base){
        baseSet.set(base, true);
      } else {
        unresolvedList.push(sp);
      }
    }

    const unresolved = uniq(unresolvedList.map(x=>fixName(x)))
      .filter(n => !(state.baseCache||{})[n]).length;

    // Kick base resolves for anything we still don't know.
    if (unresolvedList.length){
      prefetchBaseForSpeciesList(uniq(unresolvedList).slice(0, 1200));
    }

    if (resolveHint){
      resolveHint.textContent = unresolved ? `Resolving base forms… (${unresolved} not resolved yet)` : '';
    }

    const baseList = Array.from(baseSet.keys()).sort((a,b)=>a.localeCompare(b));
    grid.innerHTML = '';
    for (const base of baseList){
      const locked = !state.unlocked?.[base];
      const d = data.dex?.[base];
      const t = (d && Array.isArray(d.types) && d.types.length) ? d.types.join(' / ') : '';
      const card = el('button', {class:'dex-card' + (locked ? ' locked' : ' unlocked')}, [
        el('img', {class:'sprite sprite-xl', src:sprite(calc, base), alt:base}),
        el('div', {class:'dex-meta'}, [
          el('div', {class:'dex-name'}, base),
          t ? el('div', {class:'dex-sub'}, t) : null,
        ]),
        pill(locked ? 'Locked' : 'Unlocked', locked ? 'bad' : 'good'),
      ]);

      card.addEventListener('click', ()=>{
        // Open detail immediately; evo line fills async.
        store.update(s=>{ s.ui.dexReturn = null; s.ui.dexDetailBase = base; s.ui.dexSelectedForm = base; s.ui.dexDefenderLevel = null; });
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
      });

      grid.appendChild(card);
    }

    search.addEventListener('input', ()=>{
      store.update(s=>{ s.ui.searchUnlocked = search.value; });
    });
  }

  // ---------------- Settings ----------------

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

    const fieldSel = (label, value, options, onChange)=>{
      const sel = el('select', {}, (options||[]).map(o=>el('option', {value:o, selected:String(o)===String(value)}, String(o))));
      sel.addEventListener('change', ()=> onChange(sel.value));
      return el('div', {class:'field'}, [el('label', {}, label), sel]);
    };

    const fieldCheck = (label, checked, onChange)=>{
      const inp = el('input', {type:'checkbox', checked:!!checked});
      inp.addEventListener('change', ()=> onChange(!!inp.checked));
      return el('label', {class:'check'}, [inp, el('span', {}, label)]);
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

    // Calc + roster constants
    const pCalc = panel('Global calc constants', [
      el('div', {class:'muted small'}, 'These affect damage calcs everywhere (Waves + Overview).'),
      fieldSel('Start wave type', s.startWaveAnimal || 'Goat', animals.length ? animals : ['Goat'], v=>store.update(st=>{st.settings.startWaveAnimal=v;})),
      fieldNum('Claimed level', s.claimedLevel, {min:1,max:100,step:1}, v=>store.update(st=>{st.settings.claimedLevel=v;})),
      fieldNum('Claimed IV (all stats)', s.claimedIV, {min:0,max:31,step:1}, v=>store.update(st=>{st.settings.claimedIV=v;})),
      fieldNum('Claimed EV (all stats)', s.claimedEV, {min:0,max:252,step:1}, v=>store.update(st=>{st.settings.claimedEV=v;})),
      fieldNum('Strength charm EV (all stats)', s.strengthEV, {min:0,max:252,step:1}, v=>store.update(st=>{st.settings.strengthEV=v;})),
      el('hr'),
      fieldNum('Wild IV default', s.wildIV, {min:0,max:31,step:1}, v=>store.update(st=>{st.settings.wildIV=v;})),
      fieldNum('Wild EV default', s.wildEV, {min:0,max:252,step:1}, v=>store.update(st=>{st.settings.wildEV=v;})),
    ]);

    const pMove = panel('Move selection behavior', [
      el('div', {class:'muted small'}, 'Priority is fixed: P1 preferred, P3 only if P1/P2 cannot OHKO.'),
      fieldCheck('Conserve power (prefer closest-to-100% OHKO)', s.conservePower, v=>store.update(st=>{st.settings.conservePower=v;})),
      fieldNum('STAB preference bonus (adds to score)', s.stabBonus, {min:0,max:50,step:1}, v=>store.update(st=>{st.settings.stabBonus=v;})),
      fieldNum('Other multiplier (damage)', s.otherMult, {min:0,max:10,step:0.05,isFloat:true}, v=>store.update(st=>{st.settings.otherMult=v;})),
      fieldCheck('Apply Intimidate (INT tag)', s.applyINT, v=>store.update(st=>{st.settings.applyINT=v;})),
      fieldCheck('Apply Sturdy (STU tag at full HP)', s.applySTU, v=>store.update(st=>{st.settings.applySTU=v;})),
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

    const defaultModsEditor = (title, cur, onPatch)=>{
      return panel(title, [
        el('div', {class:'muted small'}, 'These apply when a wave/mon has no custom modifier set yet.'),
        el('div', {style:'display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end'}, [
          el('div', {class:'field', style:'width:90px'}, [el('label', {}, 'HP%'), hpSel(cur.hpPct, v=>onPatch({hpPct:v}))]),
          el('div', {class:'field', style:'width:90px'}, [el('label', {}, 'Atk'), stageSel(cur.atkStage, v=>onPatch({atkStage:v}))]),
          el('div', {class:'field', style:'width:90px'}, [el('label', {}, 'SpA'), stageSel(cur.spaStage, v=>onPatch({spaStage:v}))]),
          el('div', {class:'field', style:'width:90px'}, [el('label', {}, 'Def'), stageSel(cur.defStage, v=>onPatch({defStage:v}))]),
          el('div', {class:'field', style:'width:90px'}, [el('label', {}, 'SpD'), stageSel(cur.spdStage, v=>onPatch({spdStage:v}))]),
          el('div', {class:'field', style:'width:90px'}, [el('label', {}, 'Spe'), stageSel(cur.speStage, v=>onPatch({speStage:v}))]),
        ]),
        el('div', {style:'margin-top:10px; display:flex; gap:8px; flex-wrap:wrap'}, [
          (function(){
            const b = el('button', {class:'btn-mini'}, 'Reset to neutral');
            b.addEventListener('click', ()=> onPatch({hpPct:100, atkStage:0, spaStage:0, defStage:0, spdStage:0, speStage:0}, true));
            return b;
          })(),
        ]),
      ]);
    };

    const pDefaultsAtk = defaultModsEditor('Default wave attacker modifiers', defAtk, (patch, replace)=>{
      store.update(st=>{
        st.settings.defaultAtkMods = replace ? {...patch} : {...(st.settings.defaultAtkMods||defAtk), ...patch};
      });
    });

    const pDefaultsDef = defaultModsEditor('Default wave defender modifiers', defDef, (patch, replace)=>{
      store.update(st=>{
        st.settings.defaultDefMods = replace ? {...patch} : {...(st.settings.defaultDefMods||defDef), ...patch};
      });
    });

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

    const pCredits = panel('Credits / Impressum', [
      el('div', {class:'muted small'}, 'Attributions and thanks.'),
      el('div', {class:'credits-list'}, [
        el('div', {}, [el('strong', {}, 'Damage calc reference:'), el('span', {}, ' c4vv’s PokeMMO Damage Calc (Gen 5) — '), el('a', {href:'https://c4vv.github.io/pokemmo-damage-calc/?gen=5', target:'_blank', rel:'noopener'}, 'link')]),
        el('div', {}, [el('strong', {}, 'Data contributions:'), el('span', {}, ' [MÜSH] Alphy')]),
        el('div', {}, [el('strong', {}, 'Groundwork:'), el('span', {}, ' [MÜSH] TTVxSenseiNESS and RuthlessZ (LNY Event 2024 & 2025)')]),
        el('div', {}, [el('strong', {}, 'Sprites:'), el('span', {}, ' Pokémon Database (pokemondb.net / img.pokemondb.net)')]),
        el('div', {}, [el('strong', {}, 'Pokédex / evolutions:'), el('span', {}, ' PokéAPI')]),
        el('div', {class:'muted small', style:'margin-top:6px'}, 'Pokémon is © Nintendo / Creatures Inc. / GAME FREAK inc. This is an unofficial fan tool.'),
      ]),
    ]);

    tabSettings.appendChild(el('div', {class:'settings-grid'}, [
      el('div', {class:'settings-col'}, [pCalc, pMove]),
      el('div', {class:'settings-col'}, [pThreat, pDefaultsAtk, pDefaultsDef, pTools, pCredits]),
    ]));
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
