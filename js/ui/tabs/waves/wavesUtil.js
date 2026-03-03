// js/ui/tabs/waves/wavesUtil.js
// alpha v1
// Small shared helpers for Waves UI modules.

export function byId(arr, id){
  return (arr||[]).find(x => x && x.id === id);
}

export function groupBy(arr, fn){
  const out = {};
  for (const x of (arr||[])){
    const k = fn(x);
    out[k] = out[k] || [];
    out[k].push(x);
  }
  return out;
}

export function uniq(arr){
  return Array.from(new Set((arr||[]).filter(Boolean)));
}

export function baseDefKey(k){
  return String(k || '').split('#')[0];
}

export function defInstNum(k){
  const parts = String(k || '').split('#');
  const n = (parts.length > 1) ? Number(parts[1] || 1) : 1;
  return Number.isFinite(n) ? n : 1;
}

export function formatPrioAvg(n){
  const x = Math.round(Number(n || 0) * 2) / 2;
  return Number.isInteger(x) ? String(x) : x.toFixed(1);
}

export function waveOrderKey(wk){
  const m = /^P(\d+)W(\d+)$/.exec(String(wk||''));
  if (!m) return 999999;
  return (Number(m[1]) * 100) + Number(m[2]);
}
