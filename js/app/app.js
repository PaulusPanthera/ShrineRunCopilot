// js/app/app.js
// Abundant Shrine — Roster Planner (alpha v13)
// Professionalized module entry: data/services/state are external; this file focuses on UI + orchestration.

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
  phaseDefenderLimit,
  speciesListFromSlots,
} from '../domain/waves.js';
import {
  ITEM_CATALOG,
  lootBundle,
  computeRosterUsage,
  availableCount,
  enforceBagConstraints,
  priceOfItem,
} from '../domain/items.js';
import { initBattleForWave, stepBattleTurn, resetBattle, setManualAction, chooseReinforcement, setPP, battleLabelForRowKey, DEFAULT_MOVE_PP } from '../domain/battle.js';


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

function rosterLabel(r){
  const eff = r.effectiveSpecies || r.baseSpecies;
  if (eff !== r.baseSpecies) return `${eff} (${r.baseSpecies})`;
  return eff;
}

// Defender "instance" keys allow duplicates, e.g. "P1W1S1#2".
function baseDefKey(k){
  return String(k || '').split('#')[0];
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
    tabSim.classList.toggle('hidden', state.ui.tab !== 'sim');
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
            el('img', {class:'sprite sprite-md', src:sprite(calc, sl.defender), alt:sl.defender}),
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

    const sections = [
      {title:'Phase 1', phase:1, keys: phase1, bossAfter:true},
      {title:'Phase 2 — Part 1', phase:2, keys: phase2.slice(0,6), bossAfter:true},
      {title:'Phase 2 — Part 2', phase:2, keys: phase2.slice(6), bossAfter:true},
      {title:'Phase 3 — Part 1', phase:3, keys: phase3.slice(0,6), bossAfter:true},
      {title:'Phase 3 — Part 2', phase:3, keys: phase3.slice(6), bossAfter:true},
    ];

    for (const sec of sections){
      tabWaves.appendChild(el('div', {}, [
        el('div', {class:'section-title'}, [
          el('div', {}, [
            el('div', {}, sec.title),
            el('div', {class:'section-sub'}, `Start: ${startAnimal}`),
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

    const head = el('div', {class:'wave-head'}, [
      el('div', {class:'wave-left'}, [
        el('div', {}, [
          el('div', {class:'wave-title'}, title),
          el('div', {class:'wave-meta'}, `Phase ${first.phase} · Wave ${first.wave} · ${slots.length} defenders`),
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

    const resetAll = el('button', {class:'btn-mini'}, 'Reset fights');
    resetAll.addEventListener('click', ()=>{
      store.update(s=>{
        const w = s.wavePlans?.[waveKey];
        if (!w || !Array.isArray(w.fights)) return;
        for (const f of w.fights){
          if (!f) continue;
          f.done = false;
          f.summary = null;
        }
      });
    });
    panel.appendChild(el('div', {style:'margin-top:10px; display:flex; justify-content:flex-end'}, [resetAll]));

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

      const summaryWrap = el('div', {class:'muted small', style:'margin-top:6px'}, fight.summary ? fight.summary.text : 'Not simulated yet.');

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

        const defKeys = (wp.defenders||[]).slice(0, defLimit);
        const defSlots = defKeys.map(rk=>slotByKey.get(baseDefKey(rk))).filter(Boolean);
        if (defSlots.length < 2){
          alert('Select at least 2 defenders for this wave first.');
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

          // Auto-claim: simulating a fight means you will do it in-game; claim all selected defenders.
          const baseCache = s.baseCache || {};
          for (const rk of (w.defenders||[]).slice(0, defLimit)){
            const sl = slotByKey.get(baseDefKey(rk));
            if (!sl) continue;
            const base = pokeApi.baseOfSync(sl.defender, baseCache);
            s.unlocked[base] = true;
            // Mark the base row as cleared so the wave list can show CLAIMED.
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

    // Enemy picker (lead pair + optional reinforcements)
    // Phase 1: limit is 2, swapping should be effortless. Duplicates are supported by rowKey.
    // Phase 2/3: allow picking up to the phase limit (3/4) so the fight simulator can model reinforcements.
    const enemyList = el('div', {class:'pick-grid'});

    const selected = Array.from({length:defLimit}).map((_,i)=> (wp.defenders||[])[i] || null);
    const selectedKeys = selected.filter(Boolean);
    const selectedBaseSet = new Set(selectedKeys.map(baseDefKey));

    function setSelectedArr(next){
      const arr = Array.isArray(next) ? next.slice(0, defLimit) : [];
      const seen = new Set();
      for (let i=0;i<arr.length;i++){
        const k = arr[i] || null;
        if (!k) { arr[i] = null; continue; }
        if (seen.has(k)) arr[i] = null;
        else seen.add(k);
      }
      while (arr.length < defLimit) arr.push(null);

      store.update(s=>{
        ensureWavePlan(data, s, waveKey, slots);
        const w = s.wavePlans[waveKey];
        w.defenders = arr.filter(Boolean).slice(0, defLimit);
        w.defenderStart = w.defenders.slice(0,2);
        w.manualOrder = false;
        ensureWavePlan(data, s, waveKey, slots);
      });
    }

    // Allow duplicates by offering "instance" options (S1, S1#2, S1#3, ... up to phase limit).
    const optionEls = [];
    for (const sl of slots){
      for (let n=1; n<=defLimit; n++){
        const rk = n === 1 ? sl.rowKey : `${sl.rowKey}#${n}`;
        const label = battleLabelForRowKey({rowKey:rk, waveKey, defender:sl.defender, level:sl.level});
        optionEls.push(el('option', {value:rk}, label));
      }
    }

    const slotLabelFor = (i)=>{
      if (i === 0) return 'Enemy A';
      if (i === 1) return 'Enemy B';
      return `Bench ${i-1}`;
    };

    const makeSlot = (idx, curKey)=>{
      const used = new Set(selectedKeys);
      const sel = el('select', {class:'sel-mini', style:'min-width:270px'}, [
        el('option', {value:''}, '— empty —'),
        ...optionEls.map(o=>{
          const clone = o.cloneNode(true);
          const rk = clone.getAttribute('value');
          if (rk === curKey) clone.setAttribute('selected','selected');
          if (rk && rk !== curKey && used.has(rk)) clone.setAttribute('disabled','disabled');
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

    const slotControls = el('div', {class:'panel', style:'margin-bottom:10px'}, [
      el('div', {class:'panel-title'}, 'Selected enemies'),
      el('div', {class:'muted small'}, `Pick up to ${defLimit} defenders for this wave (first two are the lead pair). Click from the list to toggle; duplicates are supported (by row).`),
      ...Array.from({length:defLimit}).map((_,i)=> makeSlot(i, selected[i] || null)),
      el('div', {style:'margin-top:8px; display:flex; justify-content:flex-end'}, [clearAll]),
    ]);

    for (const s of slots){
      const isSelected = selectedBaseSet.has(s.rowKey);

      const base = pokeApi.baseOfSync(s.defender, state.baseCache||{});
      const isUnlocked = !!state.unlocked?.[base];

      const sp = el('img', {class:'sprite sprite-sm', src:sprite(calc, s.defender), alt:s.defender});
      sp.onerror = ()=> sp.style.opacity='0.25';

      const row = el('div', {class:'pick-item' + (isUnlocked ? ' unlocked':'' ) + (isSelected ? ' selected':'' )}, [
        sp,
        el('div', {class:'pick-meta'}, [
          el('div', {class:'pick-title'}, `${s.defender} · ${s.rowKey.startsWith(waveKey) ? s.rowKey.slice(waveKey.length) : s.rowKey}`),
          el('div', {class:'pick-sub'}, `Lv ${s.level}` + ((s.tags||[]).length ? ` · ${s.tags.join(',')}` : '')),
          buildDefModRow(s),
        ]),
      ]);

      row.addEventListener('click', ()=>{
        // Toggle selection; fill next empty slot (supports duplicates by rowKey).
        const cur = (store.getState().wavePlans?.[waveKey]?.defenders || []).slice(0, defLimit);
        const arr = Array.from({length:defLimit}).map((_,i)=> cur[i] || null);
        const base = s.rowKey;
        const indices = [];
        for (let i=0;i<arr.length;i++) if (arr[i] && baseDefKey(arr[i]) === base) indices.push(i);
        if (indices.length){
          // clicking a selected enemy unselects the most recent instance
          arr[indices[indices.length-1]] = null;
          return setSelectedArr(arr);
        }
        // add next instance if possible
        const empty = arr.indexOf(null);
        const nextKey = base;
        if (empty !== -1){
          arr[empty] = nextKey;
          return setSelectedArr(arr);
        }
        // full: replace last slot for quick swap
        arr[defLimit-1] = nextKey;
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
      return calc.chooseBestMove({data, attacker:atk, defender:def, movePool:att.movePool||[], settings: settingsForWave(state, wp, att.id, defSlot.rowKey), tags: defSlot.tags||[]}).best;
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

      const line = (x)=>{
        const out = x.best ? `${rosterLabel(x.att)} → ${x.def.defender}: ${x.best.move} (P${x.best.prio} · ${formatPct(x.best.minPct)} min)` : `${rosterLabel(x.att)} → ${x.def.defender}: —`;
        return el('div', {class:'plan-line'}, [
          el('div', {class:'plan-left'}, [el('strong', {}, x.def.defender), el('span', {class:'muted'}, ` · Lv ${x.def.level}`)]),
          el('div', {class:'plan-right'}, [
            el('span', {}, out),
            x.best?.oneShot ? pill('OHKO','good') : pill('NO','bad'),
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
        const target = pickRes.target;
        const p = pill(th.oneShot ? 'IN OHKO' : `IN ${formatPct(th.minPct)}`, th.oneShot ? 'bad' : 'warn');
        if (prevented) p.style.opacity = '0.55';
        const why = th.chosenReason === 'ohkoChance' ? 'chosen: OHKO chance' : (th.chosenReason === 'maxDamage' ? 'chosen: max damage' : '');
        p.title = `Incoming: ${th.move} · ${th.moveType} · ${th.category} · ${formatPct(th.minPct)} min`
          + (why ? ` · ${why}` : '')
          + (th.assumed ? ' (assumed)' : '')
          + (prevented ? ' · NOTE: this would be prevented by your faster OHKO' : '');
        return el('div', {class:'muted small', style:'margin-top:6px'}, [`${defSlot.defender} incoming → ${target}: `, p]);
      };

      const inc0 = incomingRow(left.def, left);
      const inc1 = incomingRow(right.def, right);
      if (inc0) planTable.appendChild(inc0);
      if (inc1) planTable.appendChild(inc1);

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
            movePool:a.movePool||[],
            settings: settingsForWave(state, wp, a.id, d0.rowKey),
            tags: d0.tags||[],
          }).best;
          const bestA1 = calc.chooseBestMove({
            data,
            attacker:{species:(a.effectiveSpecies||a.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: a.strength?state.settings.strengthEV:state.settings.claimedEV},
            defender:defRight,
            movePool:a.movePool||[],
            settings: settingsForWave(state, wp, a.id, d1.rowKey),
            tags: d1.tags||[],
          }).best;
          const bestB0 = calc.chooseBestMove({
            data,
            attacker:{species:(b.effectiveSpecies||b.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: b.strength?state.settings.strengthEV:state.settings.claimedEV},
            defender:defLeft,
            movePool:b.movePool||[],
            settings: settingsForWave(state, wp, b.id, d0.rowKey),
            tags: d0.tags||[],
          }).best;
          const bestB1 = calc.chooseBestMove({
            data,
            attacker:{species:(b.effectiveSpecies||b.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: b.strength?state.settings.strengthEV:state.settings.claimedEV},
            defender:defRight,
            movePool:b.movePool||[],
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
            const b0 = calc.chooseBestMove({data, attacker:{species:(a.effectiveSpecies||a.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: a.strength?state.settings.strengthEV:state.settings.claimedEV}, defender:defObj, movePool:a.movePool||[], settings: settingsForWave(state, wp, a.id, ds.rowKey), tags: ds.tags||[]}).best;
            const b1 = calc.chooseBestMove({data, attacker:{species:(b.effectiveSpecies||b.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: b.strength?state.settings.strengthEV:state.settings.claimedEV}, defender:defObj, movePool:b.movePool||[], settings: settingsForWave(state, wp, b.id, ds.rowKey), tags: ds.tags||[]}).best;
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
    const enemyPanel = el('div', {class:'panel'}, [
      el('div', {class:'panel-title'}, `Enemies (Phase ${phase})`),
      slotControls,
      enemyList,
    ]);

    const rightCol = el('div', {class:'planner-stack'}, [
      planEl,
      suggWrap,
      renderWaveFightsPanel(state, waveKey, slots, wp),
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

    const used = computeRosterUsage(state);
    const bagNames = Object.keys(state.bag||{});

    const isPlate = (n)=> typeof n === 'string' && n.endsWith(' Plate');
    const isGem = (n)=> typeof n === 'string' && n.endsWith(' Gem');
    const isCharm = (n)=> n === 'Evo Charm' || n === 'Strength Charm';
    const isConsumable = (n)=> n === 'Rare Candy';

    const sections = [
      {title:'Charms', filter:isCharm},
      {title:'Hold items', filter:(n)=>!isCharm(n) && !isPlate(n) && !isGem(n) && !isConsumable(n)},
      {title:'Plates', filter:isPlate},
      {title:'Gems', filter:isGem},
      {title:'Consumables', filter:isConsumable},
    ];

    const bagPanel = el('div', {class:'panel'}, [
      el('div', {class:'panel-title'}, 'Bag'),
      el('div', {class:'muted small'}, 'Shared team bag. Charms + held items consume from shared totals.'),
    ]);

    const headerRow = el('div', {class:'bag-row bag-head'}, [
      el('div', {}, 'Item'),
      el('div', {class:'bag-num'}, 'Total'),
      el('div', {class:'bag-num'}, 'Used'),
      el('div', {class:'bag-num'}, 'Avail'),
    ]);
    bagPanel.appendChild(headerRow);

    const makeRow = (name)=>{
      const qty = Number(state.bag[name]) || 0;
      const u = Number(used[name]||0);
      const avail = qty - u;
      return el('div', {class:'bag-row'}, [
        el('div', {class:'bag-item'}, name),
        el('div', {class:'bag-num'}, String(qty)),
        el('div', {class:'bag-num'}, String(u)),
        el('div', {class:'bag-num'}, el('span', {class: avail < 0 ? 'pill bad' : 'pill good'}, avail < 0 ? `-${Math.abs(avail)}` : String(avail))),
      ]);
    };

    if (!bagNames.length){
      bagPanel.appendChild(el('div', {class:'muted'}, 'No items yet.'));
    } else {
      for (const sec of sections){
        const list = bagNames.filter(sec.filter).sort((a,b)=>a.localeCompare(b));
        if (!list.length) continue;
        bagPanel.appendChild(el('div', {class:'panel-subtitle', style:'margin-top:12px'}, sec.title));
        for (const n of list){
          bagPanel.appendChild(makeRow(n));
        }
      }
    }

    // Politoed shop
    const shop = state.shop || {gold:0, ledger:[]};
    const gold = Number(shop.gold||0);
    const ledger = Array.isArray(shop.ledger) ? shop.ledger : [];

    const shopPanel = el('div', {class:'panel'}, [
      el('div', {class:'panel-title'}, 'Politoed shop'),
      el('div', {class:'muted small'}, 'Buy/sell bag items for placeholder prices. You can only sell AVAILABLE quantity (not equipped). Undo reverts the last transaction.'),
      el('div', {class:'shop-top'}, [
        el('div', {class:'shop-balance'}, ['Gold: ', el('span', {class:'pill good'}, String(gold))]),
        (function(){
          const b = el('button', {class:'btn-mini', disabled: ledger.length===0}, 'Undo');
          b.addEventListener('click', ()=>{
            store.update(s=>{
              s.shop = s.shop || {gold:0, ledger:[]};
              const led = s.shop.ledger || [];
              const tx = led.pop();
              if (!tx) return;
              const delta = Number(tx.goldDelta||0);
              s.shop.gold = Number(s.shop.gold||0) - delta;
              s.bag = s.bag || {};
              const cur = Number(s.bag[tx.item]||0);
              const next = cur + (tx.type==='sell' ? tx.qty : -tx.qty);
              if (next <= 0) delete s.bag[tx.item];
              else s.bag[tx.item] = next;
              enforceBagConstraints(data, s, applyCharmRulesSync);
            });
          });
          return b;
        })(),
      ]),
    ]);

    // Buy form
    const shopKeys = Array.from(new Set(ITEM_CATALOG
      .map(n=>lootBundle(n))
      .filter(Boolean)
      .map(b=>b.key)
      .filter(Boolean)
    )).sort((a,b)=>a.localeCompare(b));

    const buySel = el('select', {class:'sel-mini', style:'min-width:260px'}, shopKeys.map(k=> el('option', {value:k}, `${k} — ${priceOfItem(k)}g`)));
    const buyQty = el('input', {type:'number', class:'inp-mini', min:'1', step:'1', value:'1', style:'width:90px'});
    const buyBtn = el('button', {class:'btn-mini'}, 'Buy');

    buyBtn.addEventListener('click', ()=>{
      const item = buySel.value;
      const qty = clampInt(buyQty.value, 1, 9999);
      const price = priceOfItem(item);
      const cost = price * qty;
      store.update(s=>{
        s.shop = s.shop || {gold:0, ledger:[]};
        const g = Number(s.shop.gold||0);
        if (cost > g){
          alert('Not enough gold.');
          return;
        }
        s.shop.gold = g - cost;
        s.shop.ledger = s.shop.ledger || [];
        s.shop.ledger.push({ts:Date.now(), type:'buy', item, qty, goldDelta:-cost});
        s.bag = s.bag || {};
        s.bag[item] = Number(s.bag[item]||0) + qty;
      });
    });

    shopPanel.appendChild(el('div', {class:'panel-subtitle', style:'margin-top:10px'}, 'Buy'));
    shopPanel.appendChild(el('div', {style:'display:flex; gap:8px; flex-wrap:wrap; align-items:center'}, [
      buySel,
      el('span', {class:'muted small'}, 'Qty'),
      buyQty,
      buyBtn,
    ]));

    // Sell table
    shopPanel.appendChild(el('div', {class:'panel-subtitle', style:'margin-top:14px'}, 'Sell from bag'));

    const sellHead = el('div', {class:'shop-row shop-head'}, [
      el('div', {class:'shop-item'}, 'Item'),
      el('div', {class:'shop-num'}, 'Avail'),
      el('div', {class:'shop-num'}, 'Price'),
      el('div', {class:'shop-actions'}, 'Action'),
    ]);
    shopPanel.appendChild(sellHead);

    const namesSorted = bagNames.slice().sort((a,b)=>a.localeCompare(b));
    if (!namesSorted.length){
      shopPanel.appendChild(el('div', {class:'muted small', style:'margin-top:8px'}, 'No items to sell yet.'));
    } else {
      for (const name of namesSorted){
        const total = Number(state.bag[name]||0);
        const u = Number(used[name]||0);
        const avail = Math.max(0, total - u);
        const price = priceOfItem(name);

        const qtyInp = el('input', {type:'number', class:'inp-mini', min:'1', step:'1', value:'1', style:'width:70px'});
        const sellBtn = el('button', {class:'btn-mini', disabled: avail<=0}, 'Sell');
        sellBtn.addEventListener('click', ()=>{
          const qty = clampInt(qtyInp.value, 1, avail);
          if (qty <= 0) return;
          const gain = price * qty;
          store.update(s=>{
            s.shop = s.shop || {gold:0, ledger:[]};
            s.shop.gold = Number(s.shop.gold||0) + gain;
            s.shop.ledger = s.shop.ledger || [];
            s.shop.ledger.push({ts:Date.now(), type:'sell', item:name, qty, goldDelta: gain});
            s.bag = s.bag || {};
            const next = Number(s.bag[name]||0) - qty;
            if (next <= 0) delete s.bag[name];
            else s.bag[name] = next;
            enforceBagConstraints(data, s, applyCharmRulesSync);
          });
        });

        shopPanel.appendChild(el('div', {class:'shop-row'}, [
          el('div', {class:'shop-item'}, name),
          el('div', {class:'shop-num'}, String(avail)),
          el('div', {class:'shop-num'}, `${price}g`),
          el('div', {class:'shop-actions'}, [
            el('span', {class:'muted small'}, 'Qty'),
            qtyInp,
            sellBtn,
          ]),
        ]));
      }
    }

    // Ledger preview
    shopPanel.appendChild(el('div', {class:'panel-subtitle', style:'margin-top:14px'}, 'Recent transactions'));
    const ledgerBox = el('div', {class:'shop-ledger'}, []);
    const recent = ledger.slice(-8).reverse();
    if (!recent.length){
      ledgerBox.appendChild(el('div', {class:'muted small'}, 'No transactions yet.'));
    } else {
      for (const tx of recent){
        const sign = tx.goldDelta >= 0 ? '+' : '';
        ledgerBox.appendChild(el('div', {class:'shop-ledger-row'}, `${tx.type.toUpperCase()} ${tx.item} x${tx.qty} (${sign}${tx.goldDelta}g)`));
      }
    }
    shopPanel.appendChild(ledgerBox);

    tabBag.appendChild(el('div', {class:'bag-layout'}, [bagPanel, shopPanel]));
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

    const openDex = ()=>{
      const base = r.baseSpecies;
      store.update(s=>{
        s.ui.tab = 'unlocked';
        // Remember where we came from so the Dex back button can return.
        s.ui.dexReturnTab = 'roster';
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
            el('div', {class:'row-sub'}, meta + (m.source ? ` · ${m.source}` : '')),
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

  // ---------------- Unlocked (Pokédex) ----------------

  function renderUnlocked(state){
    tabUnlocked.innerHTML = '';
    // Build Pokédex base list from wave defenders (so everything that appears in waves is shown).
    const waveInfoByBase = new Map();
    for (const sl of (data.calcSlots||[])){
      const base = pokeApi.baseOfSync(sl.defender, state.baseCache||{});
      const cur = waveInfoByBase.get(base) || {levels:new Set(), forms:new Set()};
      cur.levels.add(Number(sl.level)||0);
      cur.forms.add(sl.defender);
      waveInfoByBase.set(base, cur);
    }
    const baseListAll = Array.from(waveInfoByBase.keys()).sort((a,b)=>a.localeCompare(b));
    const q = (state.ui.searchUnlocked || '').toLowerCase().trim();

    // Detail view (layer/page)
    if (state.ui.dexDetailBase){
      const base = state.ui.dexDetailBase;
      const locked = !state.unlocked?.[base];
      const line = (state.evoLineCache && state.evoLineCache[base]) ? state.evoLineCache[base] : [base];
      const selected = state.ui.dexSelectedForm || line[0] || base;
      const lvlOptions = Array.from((waveInfoByBase.get(base)?.levels || new Set())).filter(x=>Number.isFinite(Number(x)) && Number(x)>0).sort((a,b)=>a-b);
      const savedLvl = Number(state.ui.dexDefenderLevelByBase?.[base] || 0);
      const lvl = (lvlOptions.length ? (lvlOptions.includes(savedLvl) ? savedLvl : lvlOptions[0]) : Number(state.settings.claimedLevel || 50));

      const backBtn = el('button', {class:'btn-mini'}, '← Back');
      backBtn.addEventListener('click', ()=>{
        store.update(s=>{
          const ret = s.ui.dexReturnTab || 'unlocked';
          s.ui.dexDetailBase = null;
          s.ui.dexSelectedForm = null;
          s.ui.dexReturnTab = null;
          // Return to the originating tab (Roster -> Dex -> Back should return to Roster).
          if (ret) s.ui.tab = ret;
        });
      });

      const head = el('div', {style:'display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap'}, [
        el('div', {style:'display:flex; align-items:center; gap:10px; flex-wrap:wrap'}, [
          backBtn,
          el('div', {class:'panel-title'}, base),
          pill(locked ? 'Locked' : 'Unlocked', locked ? 'bad' : 'good'),
        ]),
        (function(){
          if (lvlOptions.length <= 1){
            return el('div', {class:'muted small'}, `One-shot info uses your LIVE active roster. Defender level: ${lvl}.`);
          }
          const sel = el('select', {class:'sel-mini'}, lvlOptions.map(v=> el('option', {value:String(v), selected:Number(v)===Number(lvl)}, `Lv ${v}`)));
          sel.addEventListener('change', ()=>{
            store.update(s=>{
              s.ui.dexDefenderLevelByBase = s.ui.dexDefenderLevelByBase || {};
              s.ui.dexDefenderLevelByBase[base] = Number(sel.value)||lvlOptions[0];
            });
          });
          return el('div', {style:'display:flex; align-items:center; gap:10px; flex-wrap:wrap'}, [
            el('div', {class:'muted small'}, 'One-shot info uses your LIVE active roster.'),
            el('div', {class:'muted small'}, 'Defender level:'),
            sel,
          ]);
        })(),
      ]);

      const evoRow = el('div', {class:'dex-evo-row'});
      for (const sp of line){
        const btn = el('button', {class:'dex-form' + (sp===selected ? ' active' : '')}, [
          el('img', {class:'sprite sprite-md', src:sprite(calc, sp), alt:sp}),
          el('div', {class:'dex-form-name'}, sp),
        ]);
        btn.addEventListener('click', ()=>{
          store.update(s=>{ s.ui.dexSelectedForm = sp; });
        });
        evoRow.appendChild(btn);
      }

      const info = (function(){
        const d = data.dex?.[selected];
        const typesArr = (d && Array.isArray(d.types)) ? d.types : [];
        const types = typesArr.length ? typesArr.join(' / ') : '—';
        const baseStats = d?.base || {};
        const bst = (d && (d.bst || ((baseStats.hp||0)+(baseStats.atk||0)+(baseStats.def||0)+(baseStats.spa||0)+(baseStats.spd||0)+(baseStats.spe||0)))) || 0;
        // Move data inheritance: if this form has no moveset, inherit from base.
        const moves = (data.claimedSets?.[selected]?.moves && data.claimedSets[selected].moves.length)
          ? data.claimedSets[selected].moves
          : (data.claimedSets?.[base]?.moves || []);
        return el('div', {class:'panel', style:'margin-top:12px'}, [
          el('div', {class:'panel-title'}, 'Info'),
          el('div', {style:'display:flex; gap:14px; align-items:center; flex-wrap:wrap; margin-bottom:10px'}, [
            el('img', {class:'sprite sprite-lg', src:sprite(calc, selected), alt:selected}),
            el('div', {}, [
              el('div', {style:'font-weight:900; font-size:18px'}, selected),
              typesArr.length ? renderTypeChips(typesArr) : el('div', {class:'muted small'}, types),
            ]),
          ]),
          el('div', {class:'kv'}, [el('div',{class:'k'},'Types'), typesArr.length ? renderTypeChips(typesArr) : el('div',{},types)]),
          el('div', {class:'kv'}, [el('div',{class:'k'},'BST'), el('div',{},String(bst))]),
          el('div', {class:'kv'}, [el('div',{class:'k'},'Base stats'), el('div',{}, `HP ${baseStats.hp ?? '—'} · Atk ${baseStats.atk ?? '—'} · Def ${baseStats.def ?? '—'} · SpA ${baseStats.spa ?? '—'} · SpD ${baseStats.spd ?? '—'} · Spe ${baseStats.spe ?? '—'}`)]),
          el('div', {class:'kv'}, [el('div',{class:'k'},'Moveset'), el('div',{}, moves.length ? moves.join(', ') : '—')]),
        ]);
      })();

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
      el('div', {class:'field'}, [
        el('label', {}, 'Search'),
        el('input', {type:'text', id:'searchUnlocked', placeholder:'Search…', value: state.ui.searchUnlocked || ''}),
      ]),
      el('div', {class:'dex-grid', id:'dexGrid'}),
    ]);

    tabUnlocked.appendChild(wrap);

    const grid = $('#dexGrid', wrap);
    const search = $('#searchUnlocked', wrap);

    const filtered = baseListAll.filter(sp => !q || sp.toLowerCase().includes(q));

    // Best-effort base resolution for visible rows (fills cache over time)
    prefetchBaseForSpeciesList(filtered.slice(0, 50));

    const baseList = filtered;
    grid.innerHTML = '';
    for (const base of baseList){
      const locked = !state.unlocked?.[base];
      const d = data.dex?.[base] || null;
      const types = d?.types || [];
      const lvlSet = waveInfoByBase.get(base)?.levels || new Set();
      const lvls = Array.from(lvlSet).filter(x=>Number.isFinite(Number(x)) && Number(x)>0).sort((a,b)=>a-b);
      const lvlLabel = lvls.length ? (lvls.length===1 ? `Lv ${lvls[0]}` : `Lv ${lvls[0]}–${lvls[lvls.length-1]}`) : '';

      const img = el('img', {class:'sprite sprite-md dex-sprite', src:sprite(calc, base), alt:base});
      img.onerror = ()=> img.style.opacity='0.25';

      const card = el('button', {class:'dex-card' + (locked ? ' locked' : ' unlocked')}, [
        el('div', {class:'dex-top'}, [
          img,
          el('div', {class:'dex-meta'}, [
            el('div', {class:'dex-name'}, base),
            lvlLabel ? el('div', {class:'dex-levels'}, lvlLabel) : null,
            types && types.length ? renderTypeChips(types) : el('div', {class:'muted small'}, '—'),
          ]),
          el('div', {class:'dex-tag ' + (locked ? 'bad' : 'good')}, locked ? 'Locked' : 'Unlocked'),
        ]),
      ]);

      card.addEventListener('click', ()=>{
        // Open detail immediately; evo line fills async.
        store.update(s=>{ s.ui.dexReturnTab = 'unlocked'; s.ui.dexDetailBase = base; s.ui.dexSelectedForm = base; });
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



    // Run order
    const pRun = (function(){
      // Determine animal order from Phase 1 wave list
      const byWave = {};
      for (const sl of (data.calcSlots||[])){
        if (Number(sl.phase)!==1) continue;
        if (Number(sl.slot)!==1) continue;
        byWave[Number(sl.wave)] = sl.animal;
      }
      const animals = Array.from({length:12}).map((_,i)=>byWave[i+1]).filter(Boolean);
      const cur = s.startAnimal || 'Goat';
      const sel = el('select', {style:'min-width:220px'}, animals.map(a=>el('option', {value:a, selected:a===cur}, a)));
      sel.addEventListener('change', ()=> store.update(st=>{ st.settings.startAnimal = sel.value; }));
      return panel('Run settings', [
        el('div', {class:'muted small'}, 'Choose which animal wave is shown first. This rotates wave order within each phase (data unchanged).'),
        el('div', {class:'field'}, [el('label', {}, 'Start wave'), sel]),
      ]);
    })();

    const pAbout = panel('Credits & Impressum', [
      el('div', {class:'panel-subtitle'}, 'Credits'),
      el('div', {class:'muted small'}, 'Pokémon © Nintendo / Creatures Inc. / GAME FREAK inc. Sprites and names are property of their respective owners.'),
      el('div', {class:'muted small'}, 'Damage logic based on the public PokeMMO calc by c4vv (Gen 5).'),
      el('div', {class:'muted small'}, 'Evolution/base mapping uses PokeAPI where available.'),
      el('div', {class:'hr'}),
      el('div', {class:'panel-subtitle'}, 'Impressum'),
      el('div', {class:'muted small'}, 'Private community tool for Team MÜSH. Non-commercial. No affiliation with Nintendo / GAME FREAK / Creatures.'),
      el('div', {class:'muted small'}, 'Contact: PaulusTFT (update as needed).'),
    ]);
    tabSettings.appendChild(el('div', {class:'settings-grid'}, [
      el('div', {class:'settings-col'}, [pCalc, pMove]),
      el('div', {class:'settings-col'}, [pThreat, pRun, pDefaultsAtk, pDefaultsDef, pTools, pAbout]),
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
    else if (state.ui.tab === 'sim') renderSim(state);
    else if (state.ui.tab === 'unlocked') renderUnlocked(state);
  }

  attachTabHandlers();
  attachOverviewToggle();

  return { render };
}
