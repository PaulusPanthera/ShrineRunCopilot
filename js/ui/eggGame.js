// js/ui/eggGame.js
// v13 — hidden mini-game

import { $ } from './dom.js';

export function bindEasterEgg(){
  const title = $('#brandTitle');
  const modal = $('#eggModal');
  if (!title || !modal) return;

  const closeBtn = $('#eggClose');
  const ball = $('#eggBall');
  const tEl = $('#eggTime');
  const sEl = $('#eggScore');
  const bEl = $('#eggBest');

  const BEST_KEY = 'abundantShrinePlanner_eggBest';
  let best = Number(localStorage.getItem(BEST_KEY) || 0);
  if (!Number.isFinite(best)) best = 0;
  bEl.textContent = String(best);

  let clickCount = 0;
  let clickTimer = null;
  let gameTimer = null;
  let tickTimer = null;
  let timeLeft = 15;
  let score = 0;

  function open(){
    modal.classList.remove('hidden');
    startGame();
  }
  function close(){
    modal.classList.add('hidden');
    stopGame();
  }

  function startGame(){
    stopGame();
    timeLeft = 15;
    score = 0;
    tEl.textContent = String(timeLeft);
    sEl.textContent = String(score);

    tickTimer = setInterval(()=>{
      timeLeft -= 1;
      tEl.textContent = String(timeLeft);
      if (timeLeft <= 0){
        stopGame();
        if (score > best){
          best = score;
          localStorage.setItem(BEST_KEY, String(best));
          bEl.textContent = String(best);
        }
      }
    }, 1000);

    gameTimer = setTimeout(()=>{
      stopGame();
    }, 15000);

    ball.disabled = false;
  }

  function stopGame(){
    if (tickTimer) clearInterval(tickTimer);
    if (gameTimer) clearTimeout(gameTimer);
    tickTimer = null;
    gameTimer = null;
    ball.disabled = true;
  }

  // Title click 7x
  title.addEventListener('click', ()=>{
    clickCount += 1;
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(()=>{ clickCount = 0; }, 700);
    if (clickCount >= 7){
      clickCount = 0;
      open();
    }
  });

  closeBtn?.addEventListener('click', close);
  modal?.addEventListener('click', (ev)=>{ if (ev.target === modal) close(); });

  ball?.addEventListener('click', ()=>{
    if (timeLeft <= 0) return;
    score += 1;
    sEl.textContent = String(score);
  });
}
