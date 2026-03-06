// js/ui/panels/attackOverview.js
// alpha v1
// Attack overview panel (shown on Waves) extracted from js/app/app.js.

import { el, pill, formatPct, sprite } from '../dom.js';
import { getItemIcon } from '../icons.js';
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
    if (hintEl) hintEl.textContent = 'One-shot info vs your active roster (OHKO = best by prio · otherwise closest-to-kill).';

    const roster = (state.roster||[]).filter(r=>r && r.active);
    const defObj = {species:defName, level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};

    if (bodyEl) bodyEl.innerHTML = '';
    if (collapsed) return;

    if (!roster.length){
      bodyEl?.appendChild(el('div', {class:'muted'}, 'No active roster Pokémon.'));
      return;
    }

    const rows = [];

    const OFFENSIVE_ITEM_CANDIDATES = (best)=>{
      // Only test a small set of likely damage boosters (owned items only).
      // This keeps the panel fast while still surfacing "an owned item makes OHKO possible".
      const bag = state.bag || {};
      const owned = (name)=> Number(bag[name]||0) > 0;
      const out = [];

      if (owned('Life Orb')) out.push('Life Orb');
      if (owned('Expert Belt')) out.push('Expert Belt');

      const cat = best?.category || '';
      if (cat === 'Physical' && owned('Choice Band')) out.push('Choice Band');
      if (cat === 'Physical' && owned('Muscle Band')) out.push('Muscle Band');
      if (cat === 'Special' && owned('Wise Glasses')) out.push('Wise Glasses');

      const t = best?.moveType || '';
      if (t){
        const plate = `${t} Plate`;
        const gem = `${t} Gem`;
        if (owned(plate)) out.push(plate);
        if (owned(gem)) out.push(gem);
      }

      // De-dupe while preserving priority.
      return [...new Set(out)].slice(0, 6);
    };

    const pickClosestToKill = (all)=>{
      if (!all || !all.length) return null;
      // No OHKO available → always show the move that gets closest to 100% min.
      // Tie-breaker: higher min, then lower prio, then name.
      const pool = all.slice();
      pool.sort((a,b)=>{
        const am = Number(a.minPct||0);
        const bm = Number(b.minPct||0);
        if (am !== bm) return bm - am;
        const ap = Number.isFinite(Number(a.prio)) ? Number(a.prio) : 9;
        const bp = Number.isFinite(Number(b.prio)) ? Number(b.prio) : 9;
        if (ap !== bp) return ap - bp;
        return String(a.move||'').localeCompare(String(b.move||''));
      });
      return pool[0];
    };

    const findOwnedItemOhko = ({atk, defObj, movePool, baseSettings, tags, baseHasOhko, baseBest})=>{
      if (baseHasOhko) return null;
      const items = OFFENSIVE_ITEM_CANDIDATES(baseBest);
      if (!items.length) return null;

      let best = null;
      for (const itemName of items){
        const res = calc.chooseBestMove({
          data,
          attacker: atk,
          defender: defObj,
          movePool,
          settings: { ...baseSettings, attackerItem: itemName },
          tags,
        });
        if (!res?.best?.oneShot) continue;
        const cand = { itemName, best: res.best };
        // prefer lower prio OHKO, then closer-to-100.
        if (!best) best = cand;
        else {
          const ap = Number(cand.best.prio ?? 9);
          const bp = Number(best.best.prio ?? 9);
          if (ap < bp) best = cand;
          else if (ap === bp){
            const da = Math.abs(Number(cand.best.minPct||0) - 100);
            const db = Math.abs(Number(best.best.minPct||0) - 100);
            if (da < db) best = cand;
          }
        }
      }
      return best;
    };
    for (const r of roster){
      const atk = {
        species:(r.effectiveSpecies||r.baseSpecies),
        level: state.settings.claimedLevel,
        ivAll: state.settings.claimedIV,
        evAll: r.strength ? state.settings.strengthEV : state.settings.claimedEV,
      };
      const defAb = enemyAbilityForSpecies(data, defName);
      const weather = inferBattleWeatherFromLeads(data, state, [r], [{defender:defName, level}]);
      const baseSettings = {
        ...state.settings,
        attackerItem: r.item || null,
        defenderItem: null,
        attackerAbility: (r.ability||''),
        defenderAbility: defAb,
        weather,
      };

      const movePool = filterMovePoolForCalc({ppMap: state.pp || {}, monId: r.id, movePool: r.movePool || []});

      const res = calc.chooseBestMove({
        data,
        attacker: atk,
        defender: defObj,
        movePool,
        settings: baseSettings,
        tags,
      });

      if (!res?.best) continue;

      const hasOhko = (res.all||[]).some(x=>x && x.oneShot);
      const best = hasOhko ? res.best : pickClosestToKill(res.all);
      if (!best) continue;

      const itemOhko = findOwnedItemOhko({
        atk,
        defObj,
        movePool,
        baseSettings,
        tags,
        baseHasOhko: hasOhko,
        baseBest: best,
      });

      rows.push({r, best, itemOhko});
    }

    rows.sort((a,b)=>{
      const ao = a.best.oneShot?1:0;
      const bo = b.best.oneShot?1:0;
      if (ao !== bo) return bo-ao;
      if (ao && bo){
        const ap = a.best.prio ?? 9;
        const bp = b.best.prio ?? 9;
        if (ap !== bp) return ap-bp;
      }
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

      let itemHintEl = null;
      if (row.itemOhko?.itemName){
        const src = getItemIcon(row.itemOhko.itemName);
        itemHintEl = src
          ? el('img', {class:'item-ico', src, alt:'', title:`OHKO possible with owned item: ${row.itemOhko.itemName}`})
          : pill('ITEM','warn danger');
        if (!src) itemHintEl.title = `OHKO possible with owned item: ${row.itemOhko.itemName}`;
      }

      tbody.appendChild(el('tr', {}, [
        el('td', {}, attackerCell),
        el('td', {}, moveCell),
        el('td', {}, pr),
        el('td', {}, formatPct(row.best.minPct)),
        el('td', {}, speedPill),
        el('td', {}, el('div', {style:'display:flex; align-items:center; gap:8px'}, [resPill, itemHintEl].filter(Boolean))),
      ]));
    }

    tbl.appendChild(tbody);
    bodyEl?.appendChild(tbl);
  }

  return { attach, render };
}
