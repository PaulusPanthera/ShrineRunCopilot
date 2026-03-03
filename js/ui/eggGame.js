// js/ui/eggGame.js
// alpha v1
// Optional easter-egg mini-game (opened via Settings code).

import { $ } from './dom.js';

let _inited = false;
let _nodes = null;

const BEST_KEY = 'abundantShrinePlanner_eggBest';

function clamp(n, lo, hi){
  return Math.max(lo, Math.min(hi, n));
}

function safeGetBest(){
  try{
    const v = Number(localStorage.getItem(BEST_KEY) || 0);
    return Number.isFinite(v) ? v : 0;
  }catch(e){
    return 0;
  }
}

function safeSetBest(v){
  try{ localStorage.setItem(BEST_KEY, String(v)); }catch(e){ /* ignore */ }
}

function init(){
  if (_inited) return true;

  const modal = $('#eggModal');
  const closeBtn = $('#eggClose');
  const arena = $('#eggArena');
  const ball = $('#eggBall');
  const tEl = $('#eggTime');
  const sEl = $('#eggScore');
  const bEl = $('#eggBest');
  const mEl = $('#eggMult');
  const stEl = $('#eggStreak');
  const aEl = $('#eggAcc');
  const shareBtn = $('#eggShare');

  // If any required node is missing, fail silently (egg is optional).
  if (!modal || !arena || !ball || !tEl || !sEl || !bEl) return false;

  const best = safeGetBest();
  bEl.textContent = String(best);

  const state = {
    running: false,
    duration: 30,
    timeLeft: 30,
    score: 0,
    best,
    streak: 0,
    mult: 1,
    hits: 0,
    attempts: 0,
    maxStreak: 0,
    maxMult: 1,
    moveEveryMs: 650,
    sizePx: 54,
    tickTimer: null,
    moveTimer: null,
    endTimer: null,
    goldenTimer: null,
    decoys: [],
  };

  function setStats(){
    tEl.textContent = String(state.timeLeft);
    sEl.textContent = String(state.score);
    if (mEl) mEl.textContent = `x${state.mult}`;
    if (stEl) stEl.textContent = String(state.streak);
    if (aEl){
      const acc = state.attempts ? Math.round((state.hits / state.attempts) * 100) : 0;
      aEl.textContent = `${acc}%`;
    }
  }

  function randomPosFor(el){
    const ar = arena.getBoundingClientRect();
    const br = el.getBoundingClientRect();
    const pad = 10;
    const maxX = Math.max(pad, ar.width - br.width - pad);
    const maxY = Math.max(pad, ar.height - br.height - pad);
    const x = pad + Math.random() * (maxX - pad);
    const y = pad + Math.random() * (maxY - pad);
    return {
      x: clamp(x, 0, ar.width - br.width),
      y: clamp(y, 0, ar.height - br.height),
    };
  }

  function place(el){
    const { x, y } = randomPosFor(el);
    el.style.left = `${x}px`;
    el.style.top  = `${y}px`;
  }

  function setBallSize(px){
    const v = clamp(Math.floor(px), 36, 62);
    ball.style.width = `${v}px`;
    ball.style.height = `${v}px`;
    for (const d of state.decoys){
      d.style.width = `${v}px`;
      d.style.height = `${v}px`;
    }
  }

  function clearGolden(){
    ball.classList.remove('golden');
    if (state.goldenTimer) clearTimeout(state.goldenTimer);
    state.goldenTimer = null;
  }

  function maybeGolden(){
    if (!state.running) return;
    // Small chance each move cycle.
    if (Math.random() < 0.12){
      ball.classList.add('golden');
      if (state.goldenTimer) clearTimeout(state.goldenTimer);
      state.goldenTimer = setTimeout(()=>{
        ball.classList.remove('golden');
        state.goldenTimer = null;
      }, 1200);
    }
  }

  function floatText(txt, x, y, kind){
    const n = document.createElement('div');
    n.className = 'egg-float' + (kind ? ` ${kind}` : '');
    n.textContent = txt;
    n.style.left = `${x}px`;
    n.style.top = `${y}px`;
    arena.appendChild(n);
    setTimeout(()=>{ try{ n.remove(); }catch(e){ /* ignore */ } }, 750);
  }

  function roundedRectPath(ctx, x, y, w, h, r){
    const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawPokeball(ctx, cx, cy, r, golden){
    ctx.save();
    ctx.translate(cx, cy);

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,.30)';
    ctx.beginPath();
    ctx.ellipse(0, r + 10, r * 0.9, r * 0.25, 0, 0, Math.PI * 2);
    ctx.fill();

    // Outer circle
    ctx.lineWidth = Math.max(2, r * 0.06);
    ctx.strokeStyle = 'rgba(255,255,255,.35)';

    // Top half
    ctx.beginPath();
    ctx.arc(0, 0, r, Math.PI, 0);
    ctx.lineTo(r, 0);
    ctx.arc(0, 0, r, 0, Math.PI, true);
    ctx.closePath();
    ctx.fillStyle = golden ? '#f1c04b' : '#e23b3b';
    ctx.fill();

    // Bottom half
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI);
    ctx.closePath();
    ctx.fillStyle = '#e7eefc';
    ctx.fill();

    // Middle band
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.lineWidth = Math.max(3, r * 0.10);
    ctx.beginPath();
    ctx.moveTo(-r, 0);
    ctx.lineTo(r, 0);
    ctx.stroke();

    // Center button
    ctx.lineWidth = Math.max(2, r * 0.06);
    ctx.strokeStyle = 'rgba(0,0,0,.65)';
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }

  function downloadScorePlate(){
    const now = new Date();
    const bestShown = Math.max(state.best, state.score);
    const acc = state.attempts ? Math.round((state.hits / state.attempts) * 100) : 0;

    const W = 960;
    const H = 540;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Background gradient
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#0f1726');
    bg.addColorStop(1, '#070a12');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Card
    roundedRectPath(ctx, 40, 40, W - 80, H - 80, 28);
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(122,167,255,.22)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Header
    ctx.fillStyle = '#e7eefc';
    ctx.font = '900 44px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.fillText('Shrine Run Copilot', 86, 118);

    ctx.fillStyle = 'rgba(231,238,252,.85)';
    ctx.font = '800 26px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.fillText('Wild Encounter — Score Plate', 86, 158);

    // Poké Ball (decor)
    drawPokeball(ctx, W - 150, 140, 58, false);

    // Big stats
    ctx.fillStyle = '#e7eefc';
    ctx.font = '900 56px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.fillText(String(state.score), 86, 260);
    ctx.fillStyle = 'rgba(231,238,252,.80)';
    ctx.font = '800 18px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.fillText('SCORE', 86, 286);

    ctx.fillStyle = 'rgba(231,238,252,.95)';
    ctx.font = '900 44px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.fillText(String(bestShown), 330, 260);
    ctx.fillStyle = 'rgba(231,238,252,.80)';
    ctx.font = '800 18px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.fillText('BEST', 330, 286);

    // Small stats grid
    const leftX = 86;
    const rowY = 340;
    const colW = 240;
    const lineH = 34;

    function labelValue(label, value, col, row){
      const x = leftX + col * colW;
      const y = rowY + row * lineH;
      ctx.fillStyle = 'rgba(231,238,252,.75)';
      ctx.font = '800 18px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
      ctx.fillText(label, x, y);
      ctx.fillStyle = 'rgba(231,238,252,.98)';
      ctx.font = '900 18px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
      ctx.fillText(String(value), x + 110, y);
    }

    labelValue('Accuracy', `${acc}%`, 0, 0);
    labelValue('Max streak', state.maxStreak, 1, 0);
    labelValue('Max mult', `x${state.maxMult}`, 2, 0);
    labelValue('Attempts', state.attempts, 0, 1);
    labelValue('Hits', state.hits, 1, 1);
    labelValue('Duration', `${state.duration}s`, 2, 1);

    // Footer
    ctx.fillStyle = 'rgba(231,238,252,.55)';
    ctx.font = '700 16px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.fillText(now.toLocaleString(), 86, H - 78);

    // Download
    const fileName = `wild-encounter_${bestShown}.png`;
    if (canvas.toBlob){
      canvas.toBlob((blob)=>{
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(()=>{ try{ URL.revokeObjectURL(url); }catch(e){ /* ignore */ } }, 0);
      }, 'image/png');
    }else{
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  function resetCombo(){
    state.streak = 0;
    state.mult = 1;
  }

  function computeMult(){
    // Every 4 hits increases multiplier (cap 6).
    state.mult = clamp(1 + Math.floor(state.streak / 4), 1, 6);
  }

  function onHit(ev){
    if (!state.running || state.timeLeft <= 0) return;
    state.attempts += 1;
    state.hits += 1;
    state.streak += 1;
    computeMult();

    state.maxStreak = Math.max(state.maxStreak, state.streak);
    state.maxMult = Math.max(state.maxMult, state.mult);

    const isGolden = ball.classList.contains('golden');
    const base = isGolden ? 5 : 1;
    const add = base * state.mult;
    state.score += add;

    // Float feedback at cursor relative to arena.
    const ar = arena.getBoundingClientRect();
    const x = clamp((ev?.clientX ?? ar.left + ar.width/2) - ar.left, 6, ar.width - 6);
    const y = clamp((ev?.clientY ?? ar.top + ar.height/2) - ar.top, 6, ar.height - 6);
    floatText(`+${add}`, x, y, isGolden ? 'good' : '');

    clearGolden();
    setStats();
    // Move targets on hit.
    place(ball);
    for (const d of state.decoys) place(d);
    maybeGolden();
  }

  function onDecoy(ev){
    if (!state.running || state.timeLeft <= 0) return;
    state.attempts += 1;
    resetCombo();
    const sub = 1;
    state.score = Math.max(0, state.score - sub);
    const ar = arena.getBoundingClientRect();
    const x = clamp((ev?.clientX ?? ar.left + ar.width/2) - ar.left, 6, ar.width - 6);
    const y = clamp((ev?.clientY ?? ar.top + ar.height/2) - ar.top, 6, ar.height - 6);
    floatText(`-${sub}`, x, y, 'bad');
    setStats();
    place(ev.currentTarget);
  }

  function onMiss(ev){
    if (!state.running || state.timeLeft <= 0) return;
    // Only count a miss if you clicked empty arena.
    if (ev.target !== arena) return;
    state.attempts += 1;
    resetCombo();
    setStats();
  }

  function stopGame(){
    state.running = false;
    if (state.tickTimer) clearInterval(state.tickTimer);
    if (state.endTimer) clearTimeout(state.endTimer);
    if (state.moveTimer) clearTimeout(state.moveTimer);
    state.tickTimer = null;
    state.endTimer = null;
    state.moveTimer = null;
    clearGolden();

    // Disable targets.
    ball.disabled = true;
    for (const d of state.decoys) d.disabled = true;

    // Update best.
    if (state.score > state.best){
      state.best = state.score;
      safeSetBest(state.best);
      bEl.textContent = String(state.best);
    }
  }

  function scheduleMove(){
    if (!state.running) return;
    // Move all targets.
    place(ball);
    for (const d of state.decoys) place(d);
    maybeGolden();
    state.moveTimer = setTimeout(scheduleMove, state.moveEveryMs);
  }

  function startGame(){
    stopGame();
    state.running = true;
    state.timeLeft = state.duration;
    state.score = 0;
    state.streak = 0;
    state.mult = 1;
    state.hits = 0;
    state.attempts = 0;
    state.maxStreak = 0;
    state.maxMult = 1;

    // Difficulty baseline.
    state.moveEveryMs = 650;
    state.sizePx = 54;
    setBallSize(state.sizePx);

    setStats();

    // Ensure decoys exist (2) and are enabled.
    if (!state.decoys.length){
      for (let i=0;i<2;i++){
        const d = document.createElement('button');
        d.type = 'button';
        d.className = 'egg-ball decoy';
        d.setAttribute('aria-label', 'Pokeball decoy');
        d.addEventListener('click', onDecoy);
        arena.appendChild(d);
        state.decoys.push(d);
      }
    }
    ball.disabled = false;
    for (const d of state.decoys) d.disabled = false;

    // Place immediately then begin movement loop.
    place(ball);
    for (const d of state.decoys) place(d);
    maybeGolden();
    scheduleMove();

    // Second-by-second timer + difficulty ramp.
    state.tickTimer = setInterval(()=>{
      state.timeLeft -= 1;
      // Ramp every 5 seconds.
      const elapsed = state.duration - state.timeLeft;
      if (elapsed > 0 && elapsed % 5 === 0){
        state.moveEveryMs = clamp(state.moveEveryMs - 40, 320, 650);
        state.sizePx = clamp(state.sizePx - 2, 40, 54);
        setBallSize(state.sizePx);
      }
      setStats();
      if (state.timeLeft <= 0){
        stopGame();
      }
    }, 1000);

    state.endTimer = setTimeout(()=>{
      stopGame();
    }, state.duration * 1000);
  }

  function open(){
    modal.classList.remove('hidden');
    startGame();
  }

  function close(){
    modal.classList.add('hidden');
    stopGame();
  }

  closeBtn?.addEventListener('click', close);
  shareBtn?.addEventListener('click', downloadScorePlate);
  modal?.addEventListener('click', (ev)=>{ if (ev.target === modal) close(); });
  ball.addEventListener('click', onHit);
  arena.addEventListener('click', onMiss);

  _nodes = { open, close, startGame, stopGame };
  _inited = true;
  return true;
}

export function openEggGame(){
  if (!init()) return;
  _nodes?.open?.();
}
