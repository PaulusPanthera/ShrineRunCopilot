// js/app/app.js
// alpha v1
// UI router + shared panels (Overview). All tab UIs live under js/ui/tabs/.

import { $, $$, ensureFormFieldA11y } from '../ui/dom.js';
import { createAttackOverview } from '../ui/panels/attackOverview.js';
import { createWavesTab } from '../ui/tabs/wavesTab.js';
import { createRosterTab } from '../ui/tabs/rosterTab.js';
import { createBagTab } from '../ui/tabs/bagTab.js';
import { createSettingsTab } from '../ui/tabs/settingsTab.js';
import { createUnlockedTab } from '../ui/tabs/unlockedTab.js';
import { createDexApiHelpers } from '../ui/dexApi.js';
import { resolveDexReturnRosterId } from '../ui/dexNav.js';

export function startApp(ctx){
  const { data, calc, store, pokeApi } = ctx;

  // DOM refs
  const tabWaves = $('#tabWaves');
  const tabRoster = $('#tabRoster');
  const tabBag = $('#tabBag');
  const tabSettings = $('#tabSettings');
  const tabUnlocked = $('#tabUnlocked');
  const unlockedCountEl = $('#unlockedCount');

  // Tab modules
  const wavesTab = createWavesTab({ data, calc, store, pokeApi, tabWaves });
  const rosterTab = createRosterTab({ data, calc, store, pokeApi, tabRoster });
  const bagTab = createBagTab({ data, store, tabBag });
  const settingsTab = createSettingsTab({ data, store, tabSettings });
  const unlockedTab = createUnlockedTab({ data, calc, store, pokeApi, tabUnlocked });

  // Shared Dex helpers (used for lightweight evo info like Eviolite eligibility)
  const { ensureDexEvo } = createDexApiHelpers({ store, pokeApi });


  // Overview panel (shown on Waves)
  const ovPanel = $('#attackOverview');
  const ovSprite = $('#ovSprite');
  const ovTitle = $('#ovTitle');
  const ovMeta = $('#ovMeta');
  const ovHint = $('#ovHint');
  const ovBody = $('#ovBody');
  const ovToggle = $('#ovToggle');

  function updateHeaderCounts(state){
    if (!unlockedCountEl) return;
    const n = Object.keys(state.unlocked||{}).filter(k => !!state.unlocked[k]).length;
    unlockedCountEl.textContent = String(n);
  }


  function ensureEvioliteEvoMeta(state){
    // Eviolite eligibility depends on whether the CURRENT species can evolve further.
    // We fetch + cache this lazily via PokéAPI (dexMetaCache[species].canEvolve).
    const roster = state?.roster || [];
    const byId = new Map();
    for (const m of roster){ if (m && m.id) byId.set(m.id, m); }

    const want = [];
    for (const m of roster){
      const item = String(m?.item || "").trim();
      if (item === "Eviolite"){
        const sp = m.effectiveSpecies || m.baseSpecies;
        if (sp) want.push(sp);
      }
    }

    // Also scan per-wave item overrides (Eviolite can be applied as an override).
    const waves = state?.waves || {};
    for (const w of Object.values(waves)){
      const ovr = w?.itemOverride || {};
      for (const [id, it] of Object.entries(ovr)){
        if (String(it||"").trim() !== "Eviolite") continue;
        const m = byId.get(id);
        const sp = m ? (m.effectiveSpecies || m.baseSpecies) : null;
        if (sp) want.push(sp);
      }
    }

    for (const sp of new Set(want)){
      ensureDexEvo(sp);
    }
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

  function activeTabRoot(state){
    const t = state?.ui?.tab;
    if (t === 'waves') return tabWaves;
    if (t === 'roster') return tabRoster;
    if (t === 'bag') return tabBag;
    if (t === 'settings') return tabSettings;
    if (t === 'unlocked') return tabUnlocked;
    return document;
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
            // Entering Pokédex from the top nav starts a normal browsing session.
            s.ui.dexOrigin = 'unlocked';
            s.ui.dexOriginRosterId = null;
            s.ui.dexOriginRosterBase = null;
            s.ui.dexReturnTab = 'unlocked';
            s.ui.dexReturnRosterId = null;
            s.ui.dexReturnRosterBase = null;
            s.ui.dexDetailBase = null;
            s.ui.dexSelectedForm = null;
            return;
          }

          // Any other tab: leave Pokédex entirely.
          if (t === 'roster'){
            const rid = resolveDexReturnRosterId(s);
            if (rid) s.ui.selectedRosterId = rid;
          }
          s.ui.tab = t;
          s.ui.lastNonDexTab = t;
          s.ui.dexDetailBase = null;
          s.ui.dexSelectedForm = null;
          s.ui.dexOrigin = null;
          s.ui.dexOriginRosterId = null;
          s.ui.dexOriginRosterBase = null;
          s.ui.dexReturnTab = null;
          s.ui.dexReturnRosterId = null;
          s.ui.dexReturnRosterBase = null;
        });
      });
    });
  }

  const attackOverview = createAttackOverview({
    data,
    calc,
    store,
    els: {
      panel: ovPanel,
      spriteEl: ovSprite,
      titleEl: ovTitle,
      metaEl: ovMeta,
      hintEl: ovHint,
      bodyEl: ovBody,
      toggleEl: ovToggle,
    },
  });
  attackOverview.attach();

  // Chrome DevTools "Issues" will otherwise report hundreds of unlabeled/id-less fields.
  let __a11yQueued = false;
  function scheduleA11y(){
    if (__a11yQueued) return;
    __a11yQueued = true;
    requestAnimationFrame(()=>{
      __a11yQueued = false;

      // Only scan the active tab to reduce DOM churn & "Issues" spam.
      const root = activeTabRoot(store.getState()) || document;
      ensureFormFieldA11y(root);

      // If a modal is open, also scan it (and only it) so its fields are labeled.
      const modal = document.querySelector('.modal');
      if (modal) ensureFormFieldA11y(modal);
    });
  }

  function render(){
    const state = store.getState();

    // Ensure evo meta is available for Eviolite holders (async cache fill).
    ensureEvioliteEvoMeta(state);

    renderTabs(state);
    updateHeaderCounts(state);
    attackOverview.render(state);

    if (state.ui.tab === 'waves') wavesTab.render(state);
    else if (state.ui.tab === 'roster') rosterTab.render(state);
    else if (state.ui.tab === 'bag') bagTab.render(state);
    else if (state.ui.tab === 'settings') settingsTab.render(state);
    else if (state.ui.tab === 'unlocked') unlockedTab.render(state);

    scheduleA11y();
  }

  attachTabHandlers();

  return { render };
}
