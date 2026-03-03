// js/ui/tabs/settingsTab.js
// alpha v1
// Settings tab UI extracted from js/app/app.js (UI-only refactor).

import { el, clampInt } from '../dom.js';
import { normalizeMovePool, defaultPrioForMove } from '../../domain/roster.js';
import { openEggGame } from '../eggGame.js';

export function createSettingsTab(ctx){
  const { data, store, tabSettings } = ctx;

  function recomputeAutoPriosForRoster(st){
    for (const r of (st.roster||[])){
      if (!r) continue;
      const eff = r.effectiveSpecies || r.baseSpecies;
      for (const mv of (r.movePool||[])){
        if (!mv || !mv.name) continue;
        if (mv.prioAuto === false) continue;
        if (mv.lowPpBumped === true) continue;
        mv.prio = defaultPrioForMove(data, eff, mv.name, r.ability || '', {state:st, entry:r});
        mv.prioAuto = true;
      }
      normalizeMovePool(r);
    }
  }

function renderSettings(state){
  tabSettings.innerHTML = '';

  const s = state.settings || {};

  let fieldIdSeq = 0;
  const mkFieldId = (label)=>{
    const base = String(label||'field').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
    fieldIdSeq += 1;
    return `set_${base}_${fieldIdSeq}`;
  };

  const fieldNum = (label, value, opts, onChange)=>{
    const o = opts || {};
    const id = mkFieldId(label);
    const inp = el('input', {id, type:'number', value:String(value ?? ''), min:o.min, max:o.max, step:o.step ?? '1'});
    inp.addEventListener('change', ()=>{
      const v = (o.isFloat ? Number(inp.value) : clampInt(inp.value, Number(o.min ?? -999999), Number(o.max ?? 999999)));
      onChange(v);
    });
    return el('div', {class:'field'}, [el('label', {for:id}, label), inp]);
  };

  const fieldCheck = (label, checked, onChange)=>{
    const inp = el('input', {type:'checkbox', checked:!!checked});
    inp.addEventListener('change', ()=> onChange(!!inp.checked));
    return el('label', {class:'check'}, [inp, el('span', {}, label)]);
  };

  const fieldSelect = (label, value, options, onChange)=>{
    const id = mkFieldId(label);
    const sel = el('select', {id}, (options||[]).map(o=>{
      const v = (o && o.value !== undefined) ? o.value : o;
      const t = (o && o.label !== undefined) ? o.label : String(v);
      return el('option', {value:String(v), selected:String(v)===String(value)}, t);
    }));
    sel.addEventListener('change', ()=> onChange(Number(sel.value)));
    return el('div', {class:'field'}, [el('label', {for:id}, label), sel]);
  };

  const stageSel = (cur, onChange, id)=>{
    const sel = el('select', {id}, Array.from({length:13}).map((_,i)=>{
      const v = i-6;
      return el('option', {value:String(v), selected:Number(cur)===v}, (v>=0?`+${v}`:`${v}`));
    }));
    sel.addEventListener('change', ()=> onChange(Number(sel.value)||0));
    return sel;
  };

  const hpSel = (cur, onChange, id)=>{
    const inp = el('input', {id, type:'number', min:'1', max:'100', step:'1', value:String(cur ?? 100)});
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
      fieldNum('Claimed level', s.claimedLevel, {min:1,max:100,step:1}, v=>store.update(st=>{st.settings.claimedLevel=v; recomputeAutoPriosForRoster(st);})),
      fieldNum('Claimed IV (all stats)', s.claimedIV, {min:0,max:31,step:1}, v=>store.update(st=>{st.settings.claimedIV=v; recomputeAutoPriosForRoster(st);})),
      fieldNum('Claimed EV (all stats)', s.claimedEV, {min:0,max:252,step:1}, v=>store.update(st=>{st.settings.claimedEV=v; recomputeAutoPriosForRoster(st);})),
      fieldNum('Strength charm EV (all stats)', s.strengthEV, {min:0,max:252,step:1}, v=>store.update(st=>{st.settings.strengthEV=v; recomputeAutoPriosForRoster(st);})),
    ]),
    el('hr'),
    el('div', {class:'core-fields'}, [
      fieldNum('Wild IV default', s.wildIV, {min:0,max:31,step:1}, v=>store.update(st=>{st.settings.wildIV=v;})),
      fieldNum('Wild EV default', s.wildEV, {min:0,max:252,step:1}, v=>store.update(st=>{st.settings.wildEV=v;})),
    ]),
    el('hr'),
    el('div', {class:'panel-subtitle'}, 'Move selection behavior'),
    el('div', {class:'muted small'}, 'Priority tiers are 1..5 (lower is more preferred). Solver always tries the lowest tier that still wins.'),
    el('div', {class:'settings-checkgrid'}, [
      fieldCheck('Conserve power (prefer closest-to-100% OHKO)', s.conservePower, v=>store.update(st=>{st.settings.conservePower=v;})),
      fieldCheck('Allow manual PP editing (debug)', s.allowManualPPEdit, v=>store.update(st=>{st.settings.allowManualPPEdit=v;})),
      fieldCheck('Auto-bump prio when PP ≤ 5 (lazy conserve)', s.autoBumpPrioLowPP, v=>store.update(st=>{st.settings.autoBumpPrioLowPP=v;})),
      fieldCheck('Outgoing tooltip: show roll + crit (late game)', (s.outTipCrit ?? false), v=>store.update(st=>{st.settings.outTipCrit=v;})),
    ]),
    el('div', {class:'core-fields'}, [
      fieldNum('STAB preference bonus (adds to score)', s.stabBonus, {min:0,max:50,step:1}, v=>store.update(st=>{st.settings.stabBonus=v;})),
      fieldNum('Other multiplier (damage)', s.otherMult, {min:0,max:10,step:0.05,isFloat:true}, v=>store.update(st=>{st.settings.otherMult=v;})),
    ]),
    el('div', {class:'settings-checkgrid'}, [
      fieldCheck('Apply Intimidate (INT tag)', s.applyINT, v=>store.update(st=>{st.settings.applyINT=v;})),
      fieldCheck('Apply Sturdy (STU tag at full HP)', s.applySTU, v=>store.update(st=>{st.settings.applySTU=v;})),
      fieldCheck('Sturdy AoE solve (auto): prefer AoE OHKO + finish STU', s.sturdyAoeSolve, v=>store.update(st=>{st.settings.sturdyAoeSolve=v;})),
      fieldCheck('Allow friendly fire (dangerous)', s.allowFriendlyFire, v=>store.update(st=>{st.settings.allowFriendlyFire=v;})),
    ]),

    el('hr'),
    el('div', {class:'panel-subtitle'}, 'Auto x4 behavior'),
	  el('div', {class:'muted small'}, 'When cycling Auto x4, include solutions up to bestAvg + slack (avg prioØ, then turns). 0 = best-only.'),
    el('div', {class:'settings-checkgrid'}, [
      fieldCheck('Auto x4: allow bag-held items (scarf/orb/plates/gems)', (s.autoSolveUseItems ?? true), v=>store.update(st=>{ st.settings.autoSolveUseItems = v; })),
      fieldCheck('Auto x4: optimize items on already-winning fights', (s.autoSolveOptimizeItems ?? true), v=>store.update(st=>{ st.settings.autoSolveOptimizeItems = v; })),
      fieldCheck('Auto x4: deep search on ≤8 defenders (force ≥20k cap; slower)', (s.autoSolveDeepSearch ?? true), v=>store.update(st=>{ st.settings.autoSolveDeepSearch = v; })),
    ]),
    el('div', {class:'muted small'}, 'This can be slower on later waves.'),
    el('div', {class:'muted small'}, 'If Auto x4 feels slow or gets stuck, turn this OFF to respect the Max combos cap exactly.'),
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
    fieldSelect('Crit multiplier', (s.critMult ?? 1.5), [
      {value:1.5, label:'1.5 (PokeMMO)'},
      {value:2.0, label:'2.0 (Gen 5 mainline)'},
    ], v=>store.update(st=>{st.settings.critMult = Number(v)||1.5;})),
    fieldCheck('IN tooltip: show risk view (roll + crit chance)', (s.inTipRisk ?? true), v=>store.update(st=>{st.settings.inTipRisk=v;})),
    fieldCheck('IN tooltip: include crit range (worst-case)', (s.inTipCritWorst ?? true), v=>store.update(st=>{st.settings.inTipCritWorst=v;})),
  ]);

  // Defaults for per-mon wave modifiers
  const defAtk = s.defaultAtkMods || {hpPct:100, atkStage:0, spaStage:0, defStage:0, spdStage:0, speStage:0};
  const defDef = s.defaultDefMods || {hpPct:100, atkStage:0, spaStage:0, defStage:0, spdStage:0, speStage:0};

  const renderDefaultModsInline = (cur, onPatch)=>{
    const hpId = mkFieldId('HP%');
    const atkId = mkFieldId('Atk');
    const spaId = mkFieldId('SpA');
    const defId = mkFieldId('Def');
    const spdId = mkFieldId('SpD');
    const speId = mkFieldId('Spe');
    return el('div', {class:'settings-inline'}, [
      el('div', {style:'display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end'}, [
        el('div', {class:'field', style:'width:82px'}, [el('label', {for:hpId}, 'HP%'), hpSel(cur.hpPct, v=>onPatch({hpPct:v}), hpId)]),
        el('div', {class:'field', style:'width:82px'}, [el('label', {for:atkId}, 'Atk'), stageSel(cur.atkStage, v=>onPatch({atkStage:v}), atkId)]),
        el('div', {class:'field', style:'width:82px'}, [el('label', {for:spaId}, 'SpA'), stageSel(cur.spaStage, v=>onPatch({spaStage:v}), spaId)]),
        el('div', {class:'field', style:'width:82px'}, [el('label', {for:defId}, 'Def'), stageSel(cur.defStage, v=>onPatch({defStage:v}), defId)]),
        el('div', {class:'field', style:'width:82px'}, [el('label', {for:spdId}, 'SpD'), stageSel(cur.spdStage, v=>onPatch({spdStage:v}), spdId)]),
        el('div', {class:'field', style:'width:82px'}, [el('label', {for:speId}, 'Spe'), stageSel(cur.speStage, v=>onPatch({speStage:v}), speId)]),
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
    el('div', {class:'muted small'}, [
      'Item icons: PokéSprite by msikma — ',
      el('a', {href:'https://msikma.github.io/pokesprite/overview/inventory.html', target:'_blank', rel:'noreferrer'}, 'msikma.github.io/pokesprite'),
      '.',
    ]),
    el('div', {class:'muted small'}, 'Pokédex / evolutions: PokéAPI.'),
    el('div', {class:'muted small'}, 'Pokémon is © Nintendo / Creatures Inc. / GAME FREAK inc. This is an unofficial fan tool.'),
    el('hr'),
    el('div', {class:'panel-subtitle'}, 'Impressum'),
    el('div', {class:'muted small'}, 'Private community tool for Team MÜSH. Non-commercial. No affiliation with Nintendo / GAME FREAK / Creatures.'),
    el('div', {class:'muted small'}, 'Contact: PaulusTFT (update as needed).'),
  ]);

  // Run order (wave rotation) moved from Waves tab → Settings (left column) for compactness.
  const pRunOrder = (function(){
    const waveAnimal = {};
    for (const sl of (data.calcSlots || [])){
      if (!sl || !sl.waveKey) continue;
      if (waveAnimal[sl.waveKey]) continue;
      waveAnimal[sl.waveKey] = sl.animal || null;
    }

    const phase1Animals = Array.from({length:12}).map((_,i)=> waveAnimal[`P1W${i+1}`] || null);
    const animals = [];
    const seen = new Set();
    for (const a of phase1Animals){
      if (!a) continue;
      if (seen.has(a)) continue;
      seen.add(a);
      animals.push(a);
    }

    const cur = (s.startAnimal ? String(s.startAnimal) : 'Goat');
    if (cur && !seen.has(cur)) animals.unshift(cur);

    const selId = mkFieldId('Start wave');
    const sel = el('select', {id:selId, style:'min-width:220px'}, (animals.length ? animals : ['Goat']).map(a=>
      el('option', {value:a, selected:String(a)===String(cur)}, a)
    ));
    sel.addEventListener('change', ()=> store.update(st=>{ st.settings.startAnimal = sel.value; }));

    const bReset = el('button', {class:'btn-mini'}, 'Reset to Goat');
    bReset.addEventListener('click', ()=> store.update(st=>{ st.settings.startAnimal = 'Goat'; }));

    return panel('Run order', [
      el('div', {class:'muted small'}, 'Pick which animal wave shows first. This rotates wave order within each phase (data unchanged).'),
      el('div', {style:'display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap; margin-top:10px'}, [
        el('div', {class:'field', style:'margin:0'}, [el('label', {for:selId}, 'Start wave'), sel]),
        bReset,
      ]),
    ]);
  })();

  // Simple code gate (no explanation).
  const pCode = (function(){
    const id = mkFieldId('Code');
    const inp = el('input', {id, type:'password', inputmode:'numeric', autocomplete:'one-time-code', placeholder:'', style:'width:140px'});
    const btn = el('button', {class:'btn-mini'}, 'Enter');

    function submit(){
      const v = String(inp.value || '').trim();
      if (v === '0220') openEggGame();
      inp.value = '';
    }

    btn.addEventListener('click', submit);
    inp.addEventListener('keydown', (ev)=>{
      if (ev.key === 'Enter') submit();
    });

    return panel('Code', [
      el('div', {style:'display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap'}, [
        el('div', {class:'field', style:'margin:0'}, [el('label', {for:id}, 'Password'), inp]),
        btn,
      ]),
    ]);
  })();

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
    el('div', {class:'settings-col settings-col-left'}, [pAbout, pRunOrder, pCode, pTools]),
    el('div', {class:'settings-col settings-col-mid'}, [pCore]),
    el('div', {class:'settings-col settings-col-right'}, [pThreat, pDefaults]),
  ]));
}


  return { render: renderSettings };
}
