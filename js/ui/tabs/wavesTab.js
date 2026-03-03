// js/ui/tabs/wavesTab.js
// alpha v1
// Waves tab UI extracted from js/app/app.js.
// This file is intentionally small: it wires up tab-level concerns (prefetch + overview)
// and delegates wave-card rendering to js/ui/tabs/waves/waveCard.js.

import { el } from '../dom.js';
import { fixName } from '../../data/nameFixes.js';
import { speciesListFromSlots } from '../../domain/waves.js';
import { createWaveCardRenderer } from './waves/waveCard.js';
import { groupBy } from './waves/wavesUtil.js';

export function createWavesTab(ctx){
  const { data, calc, store, pokeApi, tabWaves } = ctx;

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

  const renderWaveCard = createWaveCardRenderer({
    data,
    calc,
    store,
    pokeApi,
    prefetchBaseForSlots,
    showOverviewForSlot,
  });

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

  return { render: renderWaves };
}
