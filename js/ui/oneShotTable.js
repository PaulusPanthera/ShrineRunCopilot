// js/ui/oneShotTable.js
// alpha v1
// Shared one-shot table builder (used in Dex detail view).

import { el, pill, formatPct } from './dom.js';
import { settingsForWave } from '../domain/waves.js';
import { rosterLabel, filterMovePoolForCalc, inferBattleWeatherFromLeads, withWeatherSettings } from './battleUiHelpers.js';

// Build a one-shot table against a given defender using the LIVE active roster.
export function buildOneShotTable(ctx, state, defenderName, level, tags){
  const { data, calc } = ctx;
  const roster = (state.roster||[]).filter(r=>r && r.active).slice(0,16);
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
      movePool: filterMovePoolForCalc({ppMap: state.pp || {}, monId: r.id, movePool: r.movePool || []}),
      settings: withWeatherSettings(
        settingsForWave(state, dummyWp, r.id, null, defenderName),
        inferBattleWeatherFromLeads(data, state, [r], [{defender:defenderName, level:Number(level||50)}])
      ),
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
      ].filter(Boolean))),
      el('td', {}, `P${best.prio}`),
      el('td', {}, formatPct(best.minPct)),
      el('td', {}, best.slower ? pill('SLOW','warn danger') : pill('OK','good')),
      el('td', {}, best.oneShot ? pill('OHKO','good') : pill('NO','bad')),
    ]));
  }
  tbl.appendChild(tbody);
  return tbl;
}
