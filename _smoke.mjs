import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve('/mnt/data/_shipcheck');
process.chdir(ROOT);

// Browser-ish globals
globalThis.window = globalThis;
// Minimal fetch stub for local data files used by loadData()
globalThis.fetch = async (p)=>{
  const url = String(p);
  // local-only for this harness
  if (url.startsWith('data/')){
    const fp = path.join(ROOT, url);
    const body = fs.readFileSync(fp, 'utf-8');
    return {
      ok: true,
      status: 200,
      async json(){ return JSON.parse(body); },
      async text(){ return body; },
    };
  }
  return { ok:false, status:404, async json(){ throw new Error('fetch not stubbed: '+url);} };
};

// Load calc.js into window.SHRINE_CALC
const calcSrc = fs.readFileSync(path.join(ROOT, 'calc.js'), 'utf-8');
vm.runInThisContext(calcSrc, { filename: 'calc.js' });
if (!globalThis.SHRINE_CALC){
  throw new Error('SHRINE_CALC missing after calc.js eval');
}

const { loadData } = await import('./js/data/loadData.js');
const { createDefaultState } = await import('./js/state/defaultState.js');
const { hydrateState } = await import('./js/state/migrate.js');
const { validateState } = await import('./js/state/validate.js');
const { ensureWavePlan } = await import('./js/domain/waves.js');
const { initBattleForWave, stepBattleTurn } = await import('./js/domain/battle.js');

function groupBy(arr, fn){
  const out = new Map();
  for (const x of arr){
    const k = fn(x);
    const a = out.get(k) || [];
    a.push(x);
    out.set(k, a);
  }
  return out;
}

const data = await loadData();
const defaultState = createDefaultState(data);
const state = hydrateState(null, defaultState, data);

const warnings = validateState(state);

const waves = groupBy(data.calcSlots, x => x.waveKey);

// Ensure wave plans
for (const [wk, slots] of waves.entries()){
  ensureWavePlan(data, state, wk, slots);
}

// Battle smoke: init and step a few turns
let initOk = 0;
let stepped = 0;
let stalled = 0;
let crashed = null;

for (const [wk, slots] of waves.entries()){
  try{
    initBattleForWave({data, calc: globalThis.SHRINE_CALC, state, waveKey: wk, slots});
    initOk++;
    // Step up to 10 turns or until resolved
    for (let t=0;t<10;t++){
      const b = state.battles?.[wk];
      if (!b || b.status !== 'active') break;
      stepBattleTurn({data, calc: globalThis.SHRINE_CALC, state, waveKey: wk, slots});
      stepped++;
      const bb = state.battles?.[wk];
      if (bb && bb.status === 'stalled') stalled++;
      // NaN check
      if (bb){
        for (const v of Object.values(bb.hpAtk||{})) if (!Number.isFinite(Number(v))) throw new Error('NaN hpAtk');
        for (const v of Object.values(bb.hpDef||{})) if (!Number.isFinite(Number(v))) throw new Error('NaN hpDef');
      }
    }
  }catch(e){
    crashed = { waveKey: wk, error: String(e?.stack || e) };
    break;
  }
}

const result = {
  js_parse: true,
  stateWarnings: warnings,
  waves: waves.size,
  initOk,
  stepped,
  stalled,
  crashed,
};

console.log(JSON.stringify(result, null, 2));
