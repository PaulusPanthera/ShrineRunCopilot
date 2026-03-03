// js/ui/panels/attackOverview.js
// alpha v1
// Attack overview panel (shown on Waves) extracted from js/app/app.js.

import { el, pill, formatPct, sprite } from '../dom.js';
import {
  spriteStatic,
  rosterLabel,
  filterMovePoolForCalc,
  enemyAbilityForSpecies,
  inferBattleWeatherFromLeads,
} from '../battleUiHelpers.js';

export function createAttackOverview({ data, calc, store, els }){
  const {
    panel,
    spriteEl,
    titleEl,
    metaEl,
    hintEl,
    bodyEl,
    toggleEl,
  } = els;

  function attach(){
    if (toggleEl){
      toggleEl.addEventListener('click', ()=>{
        store.update(s=>{ s.ui.overviewCollapsed = !s.ui.overviewCollapsed; });
      });
    }

    // Right click anywhere on the overview panel to fully dismiss it.
    if (panel){
      panel.addEventListener('contextmenu', (ev)=>{
        ev.preventDefault();
        store.update(s=>{ s.ui.attackOverview = null; });
      });
    }
  }

  function render(state){
    const ov = state.ui.attackOverview;
    const tab = state.ui.tab;
    const tabAllows = (tab === 'waves');
    if (!ov || !tabAllows){
      panel?.classList.add('hidden');
      return;
    }
    panel?.classList.remove('hidden');

    const collapsed = !!state.ui.overviewCollapsed;
    panel?.classList.toggle('collapsed', collapsed);
    if (toggleEl) toggleEl.textContent = collapsed ? 'Show' : 'Hide';

    const defName = ov.defender;
    const level = Number(ov.level || 50);
    const tags = ov.tags || [];

    if (spriteEl){
      spriteEl.src = spriteStatic(calc, defName);
      spriteEl.onerror = ()=> spriteEl.style.opacity = '0.25';
    }
    if (titleEl) titleEl.textContent = defName;
    if (metaEl) metaEl.textContent = `Lv ${level}` + (tags.length ? ` · ${tags.join(', ')}` : '');
    if (hintEl) hintEl.textContent = 'One-shot info vs your active roster (best moves by priority).';

    const roster = (state.roster||[]).filter(r=>r && r.active);
    const defObj = {species:defName, level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};

    if (bodyEl) bodyEl.innerHTML = '';
    if (collapsed) return;

    if (!roster.length){
      bodyEl?.appendChild(el('div', {class:'muted'}, 'No active roster Pokémon.'));
      return;
    }

    const rows = [];
    for (const r of roster){
      const atk = {
        species:(r.effectiveSpecies||r.baseSpecies),
        level: state.settings.claimedLevel,
        ivAll: state.settings.claimedIV,
        evAll: r.strength ? state.settings.strengthEV : state.settings.claimedEV,
      };
      const defAb = enemyAbilityForSpecies(data, defName);
      const weather = inferBattleWeatherFromLeads(data, state, [r], [{defender:defName, level}]);
      const res = calc.chooseBestMove({
        data,
        attacker: atk,
        defender: defObj,
        movePool: filterMovePoolForCalc({ppMap: state.pp || {}, monId: r.id, movePool: r.movePool || []}),
        settings: {
          ...state.settings,
          attackerItem: r.item || null,
          defenderItem: null,
          attackerAbility: (r.ability||''),
          defenderAbility: defAb,
          weather,
        },
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
    bodyEl?.appendChild(tbl);
  }

  return { attach, render };
}
