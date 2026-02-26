// js/ui/dom.js

export const $ = (sel, el=document) => el.querySelector(sel);
export const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));

export function safeText(s){
  return (s == null) ? '' : String(s);
}

export function el(tag, attrs={}, children=[]){
  const n = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs||{})){
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, String(v));
  }
  for (const c of (Array.isArray(children)?children:[children])){
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

export function pill(text, kind=''){
  return el('span', {class:`pill ${kind}`}, text);
}

export function formatPct(x){
  if (x == null || Number.isNaN(Number(x))) return '—';
  return `${Number(x).toFixed(1)}%`;
}

export function statCell(label, value){
  return el('div', {class:'statcell'}, [
    el('div', {class:'muted small'}, label),
    el('div', {class:'statval'}, value == null ? '—' : String(value)),
  ]);
}

export function clampInt(v, lo, hi){
  const n = Number.parseInt(String(v), 10);
  const x = Number.isFinite(n) ? n : lo;
  return Math.max(lo, Math.min(hi, x));
}

export function sprite(calc, name){
  // Prefer static sprites for performance and UI clarity.
  // Callers can fall back to spriteAnim() if the PNG is missing.
  return (calc.spriteUrlPokemonDbBWStatic ? calc.spriteUrlPokemonDbBWStatic(name) : calc.spriteUrlPokemonDbBW(name));
}

export function spriteAnim(calc, name){
  return calc.spriteUrlPokemonDbBW(name);
}
