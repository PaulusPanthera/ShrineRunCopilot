// js/main.js
// alpha v1
// App bootstrap and top-level initialization.

import { loadData } from './data/loadData.js';
import { createPokeApi } from './services/pokeApi.js';
import { loadStoredState, saveStoredState, downloadJson, readJsonFile } from './services/storage.js';
import { createDefaultState, STORAGE_KEY, OLD_KEYS } from './state/defaultState.js';
import { hydrateState } from './state/migrate.js';
import { validateState } from './state/validate.js';
import { createStore } from './state/store.js';
import { startApp } from './app/app.js';
// Easter egg mini-game is triggered via Settings code (no global binder).
import { ensureWavePlan } from './domain/waves.js';
import { awardCompletedPhasesOnLoad } from './domain/phaseRewards.js';
import { loadIcons } from './ui/icons.js';
import { loadMoveMetaCacheIntoWindow, primeMoveMetaCache } from './services/moveMeta.js';

function groupBy(arr, fn){
  const out = {};
  for (const x of (arr||[])){
    const k = fn(x);
    out[k] = out[k] || [];
    out[k].push(x);
  }
  return out;
}

(async function(){
  if (!window.SHRINE_CALC){
    console.error('calc.js did not load (window.SHRINE_CALC missing)');
    return;
  }

  // UI icon manifest (safe to fail; UI will degrade gracefully).
  await loadIcons();

  // Move meta cache (Sheer Force eligibility, etc.)
  loadMoveMetaCacheIntoWindow();

  const data = await loadData();
  const pokeApi = createPokeApi(data);

  // Fetch missing move meta (only for Sheer Force move list) and cache it.
  try{ await primeMoveMetaCache(data, {pokeApi, timeoutMs: 6000}); }catch(e){ /* ignore */ }

  const defaultState = createDefaultState(data);
  const raw = loadStoredState(STORAGE_KEY, OLD_KEYS);
  const hydrated = hydrateState(raw, defaultState, data);

  // Non-fatal sanity check: helpful when refactoring large UI files.
  try {
    const warnings = validateState(hydrated);
    if (warnings.length) console.warn("[alpha_v1_sim] state warnings", warnings);
  } catch (e) { /* ignore */ }

  const store = createStore(hydrated);

  // Normalize wavePlans once at startup (defaults, limits, auto-match)
  store.update(s=>{
    const waves = groupBy(data.calcSlots, x => x.waveKey);
    for (const [wk, slots] of Object.entries(waves)){
      ensureWavePlan(data, s, wk, slots);
    }

    // If the user already completed phases in an older version, award immediately on load.
    awardCompletedPhasesOnLoad(data, s);
  });

  const app = startApp({
    data,
    calc: window.SHRINE_CALC,
    store,
    defaultState,
    pokeApi,
  });

  // Centralized save + render batching
  let queued = false;
  const schedule = ()=>{
    if (queued) return;
    queued = true;
    requestAnimationFrame(()=>{
      queued = false;
      try{
        saveStoredState(STORAGE_KEY, store.getState());
      }catch(e){ /* ignore */ }
      app.render();
    });
  };

  store.subscribe(schedule);

  // Top bar buttons (export/import/reset)
  const btnExport = document.getElementById('btnExport');
  const btnImport = document.getElementById('btnImport');
  const btnReset = document.getElementById('btnReset');
  const fileImport = document.getElementById('fileImport');

  btnExport?.addEventListener('click', ()=>{
    const s = store.getState();
    downloadJson(s, `abundant_shrine_state_alpha_${new Date().toISOString().slice(0,10)}.json`);
  });

  btnImport?.addEventListener('click', ()=> fileImport?.click());
  fileImport?.addEventListener('change', async (ev)=>{
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try{
      const imported = await readJsonFile(file);
      const next = hydrateState(imported, defaultState, data);
      try {
        const warnings = validateState(next);
        if (warnings.length) console.warn("[alpha_v1_sim] imported state warnings", warnings);
      } catch (e) { /* ignore */ }
      store.setState(next);
    }catch(e){
      alert('Import failed: ' + (e?.message || e));
    } finally {
      ev.target.value = '';
    }
  });

  btnReset?.addEventListener('click', ()=>{
    if (!confirm('Reset ALL local data (roster, cleared slots, unlocked)?')) return;
    const next = hydrateState(null, defaultState, data);
    try {
      const warnings = validateState(next);
      if (warnings.length) console.warn("[alpha_v1_sim] reset state warnings", warnings);
    } catch (e) { /* ignore */ }
    store.setState(next);
  });

  // (Egg game is opened from Settings via a code field.)

  // initial paint
  schedule();
})();
