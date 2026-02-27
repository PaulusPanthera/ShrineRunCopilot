// js/main.js
// alpha v1
// App bootstrap and top-level initialization.

import { loadData } from './data/loadData.js';
import { createPokeApi } from './services/pokeApi.js';
import { loadStoredState, saveStoredState, downloadJson, readJsonFile } from './services/storage.js';
import { createDefaultState, STORAGE_KEY, OLD_KEYS } from './state/defaultState.js';
import { hydrateState } from './state/migrate.js';
import { createStore } from './state/store.js';
import { startApp } from './app/app.js';
import { bindEasterEgg } from './ui/eggGame.js';
import { ensureWavePlan } from './domain/waves.js';

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

  const data = await loadData();
  const pokeApi = createPokeApi(data);

  const defaultState = createDefaultState(data);
  const raw = loadStoredState(STORAGE_KEY, OLD_KEYS);
  const hydrated = hydrateState(raw, defaultState, data);

  const store = createStore(hydrated);

  // Normalize wavePlans once at startup (defaults, limits, auto-match)
  store.update(s=>{
    const waves = groupBy(data.calcSlots, x => x.waveKey);
    for (const [wk, slots] of Object.entries(waves)){
      ensureWavePlan(data, s, wk, slots);
    }
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
    store.setState(next);
  });

  bindEasterEgg();

  // initial paint
  schedule();
})();
