// js/ui/tabs/waves/wavePlanner.js
// alpha v1
// Wave card UI (header + loot picker). The heavy planner panel lives in planner/wavePlannerPanel.js.

import { el } from '../../dom.js';
import { ensureWavePlan } from '../../../domain/waves.js';
import {
  ITEM_CATALOG,
  TYPES_NO_FAIRY,
  lootBundle,
  enforceBagConstraints,
  isGem,
  isPlate,
  gemName,
  plateName,
} from '../../../domain/items.js';
import { applyCharmRulesSync } from '../../../domain/roster.js';
import { getItemIcon, getTypeIcon } from '../../icons.js';
import { createWavePlannerPanelRenderer } from './planner/wavePlannerPanel.js';
import { uniq } from './wavesUtil.js';

export function createWaveCardRenderer(ctx){
  const { data, store, prefetchBaseForSlots } = ctx;
  const renderWavePlanner = createWavePlannerPanelRenderer(ctx);

function renderWaveCard(state, waveKey, slots){
  const expanded = !!state.ui.waveExpanded[waveKey];
  const first = slots[0];
  const title = `${waveKey} • ${first.animal} • Lv ${first.level}`;

  // Overview "logged" status: wave is considered logged once 4 fights are logged
  // AND the wave loot item has been claimed (waveItem set).
  const wp = state.wavePlans?.[waveKey] || null;
  const fightsLogged = (wp?.fightLog || []).length >= 4;
  const lootLogged = !!(wp?.waveItem);
  const isLogged = fightsLogged && lootLogged;

  const btn = el('button', {class:'btn-mini btn-expander'}, expanded ? 'Collapse wave' : 'Expand wave');
  btn.addEventListener('click', ()=>{
    store.update(s => { s.ui.waveExpanded[waveKey] = !expanded; });
  });



  const lootInline = (()=>{
    const fixedLoot = (data.waveLoot && data.waveLoot[waveKey]) ? data.waveLoot[waveKey] : null;
    const fixedName = (fixedLoot && typeof fixedLoot === 'string') ? fixedLoot : null;

    const applyLootDelta = (s, itemName, dir)=>{
      const b = lootBundle(itemName);
      if (!b) return;
      s.bag = s.bag || {};
      const cur = Number(s.bag[b.key]||0) + (dir * b.qty);
      if (cur <= 0) delete s.bag[b.key];
      else s.bag[b.key] = cur;
    };

    function updateLootInState(nextItem){
      store.update(s=>{
        ensureWavePlan(data, s, waveKey, slots);
        const w = s.wavePlans[waveKey];
        const prevItem = w.waveItem || null;
        if (prevItem) applyLootDelta(s, prevItem, -1);
        w.waveItem = nextItem;
        if (w.waveItem) applyLootDelta(s, w.waveItem, +1);
        enforceBagConstraints(data, s, applyCharmRulesSync);
      });
    }

    const curLoot = state.wavePlans?.[waveKey]?.waveItem || null;

    // Fixed loot (no picker needed)
    if (fixedName){
      const iconImg = el('img', {class:'item-ico', alt:''});
      const typeBadge = (String(fixedName).endsWith(' Plate') ? String(fixedName).replace(/ Plate$/, '') : (String(fixedName).endsWith(' Gem') ? String(fixedName).replace(/ Gem$/, '') : null));
      const typeImg = el('img', {class:'type-ico', alt:typeBadge || ''});

      const itemSrc = getItemIcon(fixedName);
      iconImg.src = itemSrc || '';
      iconImg.style.display = itemSrc ? '' : 'none';

      const tSrc = typeBadge ? getTypeIcon(typeBadge) : '';
      typeImg.src = tSrc || '';
      typeImg.style.display = tSrc ? '' : 'none';

      const sel = el('select', {class:'sel-mini wave-loot-sel', title:'Selecting adds it to the shared Bag.'}, [
        el('option', {value:''}, '— claim loot —'),
        (function(){
          const b = lootBundle(fixedName);
          const label = b ? `${b.key}${b.qty>1 ? ` (x${b.qty})` : ''}` : fixedName;
          return el('option', {value:fixedName, selected:curLoot===fixedName}, label);
        })(),
      ]);
      sel.addEventListener('change', ()=> updateLootInState(sel.value || null));
      return el('div', {class:'wave-loot'}, [
        el('span', {class:'lbl'}, 'Loot'),
        iconImg,
        typeImg,
        sel,
      ]);
    }


    // Split the huge list into compact selectors (gems/plates are type-based)
    const bundles = ['Air Balloon x5', 'Copper Coin x5'];

    // Charms category (unclutter)
    const charms = ['Evo Charm', 'Strength Charm'];

    // Dedup: if a bundle exists, hide the single from "Other items"
    const bundleDedupSingles = new Set([
      'Air Balloon',
      'Copper Coin',
    ]);
    const present = new Set(ITEM_CATALOG);

    const otherItems = uniq(ITEM_CATALOG.slice())
      .filter(n=>!isGem(n))
      .filter(n=>!isPlate(n))
      .filter(n=>!String(n).startsWith('Rare Candy'))
      .filter(n=>!charms.includes(n))
      // if single + bundle exists, hide single
      .filter(n=>!(bundleDedupSingles.has(n) && present.has(`${n} x5`)))
      .filter(n=>!bundles.includes(n))
      .sort((a,b)=>a.localeCompare(b));

    const typeFromGemItem = (name)=>{
      for (const t of TYPES_NO_FAIRY) if (gemName(t) === name) return t;
      return null;
    };
    const typeFromPlateItem = (name)=>{
      for (const t of TYPES_NO_FAIRY) if (plateName(t) === name) return t;
      return null;
    };
    const rareQtyFromItem = (name)=>{
      const s = String(name||'');
      if (s === 'Rare Candy') return 1;
      if (s === 'Rare Candy x2') return 2;
      if (s === 'Rare Candy x3') return 3;
      return null;
    };

    function detectCategory(itemName){
      const n = String(itemName||'');
      if (!n) return {cat:'', val:''};
      if (isGem(n)) return {cat:'gem', val: typeFromGemItem(n) || TYPES_NO_FAIRY[0]};
      if (isPlate(n)) return {cat:'plate', val: typeFromPlateItem(n) || TYPES_NO_FAIRY[0]};
      if (String(n).startsWith('Rare Candy')) return {cat:'rare', val: String(rareQtyFromItem(n) || 1)};
      if (bundles.includes(n)) return {cat:'bundle', val:n};
      if (charms.includes(n)) return {cat:'charms', val:n};
      return {cat:'other', val:n};
    }

    function resolveItem(cat, val){
      if (!cat) return null;
      if (cat === 'gem') return gemName(val);
      if (cat === 'plate') return plateName(val);
      if (cat === 'rare'){
        const q = Number(val||1);
        if (q === 1) return 'Rare Candy';
        if (q === 2) return 'Rare Candy x2';
        if (q === 3) return 'Rare Candy x3';
        return 'Rare Candy';
      }
      if (cat === 'bundle') return val || null;
      if (cat === 'charms') return val || null;
      if (cat === 'other') return val || null;
      return null;
    }

    const init = detectCategory(curLoot);
    const catSel = el('select', {class:'sel-mini wave-loot-cat', title:'Wave loot adds to the shared Bag.'}, [
      el('option', {value:''}, '— loot —'),
      el('option', {value:'gem', selected:init.cat==='gem'}, 'Gem (x5)'),
      el('option', {value:'plate', selected:init.cat==='plate'}, 'Plate'),
      el('option', {value:'rare', selected:init.cat==='rare'}, 'Rare Candy'),
      el('option', {value:'bundle', selected:init.cat==='bundle'}, 'Bundles'),
      el('option', {value:'charms', selected:init.cat==='charms'}, 'Charms'),
      el('option', {value:'other', selected:init.cat==='other'}, 'Other items'),
    ]);

    const itemSel = el('select', {class:'sel-mini wave-loot-item'});

    const iconImg = el('img', {class:'item-ico', alt:''});
    const typeImg = el('img', {class:'type-ico', alt:''});

    function syncIcons(){
      const cat = catSel.value || '';
      const val = itemSel.value || '';
      const resolved = resolveItem(cat, val);
      const itemSrc = resolved ? getItemIcon(resolved) : '';
      iconImg.src = itemSrc || '';
      iconImg.style.display = itemSrc ? '' : 'none';

      const type = (cat === 'gem' || cat === 'plate') ? (val || TYPES_NO_FAIRY[0]) : null;
      const tSrc = type ? getTypeIcon(type) : '';
      typeImg.src = tSrc || '';
      typeImg.alt = type || '';
      typeImg.style.display = tSrc ? '' : 'none';
    }

    function fillItemOptions(cat, curVal){
      itemSel.innerHTML = '';
      itemSel.disabled = !cat;
      if (!cat) return;

      if (cat === 'gem' || cat === 'plate'){
        for (const t of TYPES_NO_FAIRY){
          itemSel.appendChild(el('option', {value:t, selected:String(curVal||'')===String(t)}, t));
        }
        return;
      }
      if (cat === 'rare'){
        const qs = [1,2,3];
        for (const q of qs){
          itemSel.appendChild(el('option', {value:String(q), selected:String(curVal||'')===String(q)}, `x${q}`));
        }
        return;
      }
      if (cat === 'bundle'){
        for (const b of bundles){
          const lbl = (function(){
            const bb = lootBundle(b);
            return bb ? `${bb.key} (x${bb.qty})` : b;
          })();
          itemSel.appendChild(el('option', {value:b, selected:String(curVal||'')===String(b)}, lbl));
        }
        return;
      }
      if (cat === 'charms'){
        for (const c of charms){
          itemSel.appendChild(el('option', {value:c, selected:String(curVal||'')===String(c)}, c));
        }
        return;
      }
      if (cat === 'other'){
        itemSel.appendChild(el('option', {value:''}, '— select —'));
        for (const n of otherItems){
          const bb = lootBundle(n);
          const lbl = bb ? `${bb.key}${bb.qty>1 ? ` (x${bb.qty})` : ''}` : n;
          itemSel.appendChild(el('option', {value:n, selected:String(curVal||'')===String(n)}, lbl));
        }
        return;
      }
    }

    function commitFromSelectors(){
      const cat = catSel.value || '';
      const val = itemSel.value || '';
      // For Other items, do not auto-commit an empty selection (it would reset the UI).
      if (cat === 'other' && !val) return;
      const next = resolveItem(cat, val);
      updateLootInState(next);
    }

    fillItemOptions(init.cat, init.val);
    if (init.cat) itemSel.value = String(init.val||'');
    syncIcons();

    catSel.addEventListener('change', ()=>{
      const cat = catSel.value || '';
      // Set a safe default value per category
      const defVal = (cat === 'gem' || cat === 'plate') ? TYPES_NO_FAIRY[0]
        : (cat === 'rare') ? '1'
        : (cat === 'bundle') ? (bundles[0] || '')
        : (cat === 'charms') ? (charms[0] || '')
        : (cat === 'other') ? ''
        : '';
      fillItemOptions(cat, defVal);
      if (cat) itemSel.value = String(defVal||'');
      syncIcons();
      // Do not auto-commit Other items when no item is selected; wait for the item dropdown.
      if (cat === 'other') return;
      commitFromSelectors();
    });
    itemSel.addEventListener('change', ()=>{ syncIcons(); commitFromSelectors(); });

    // Layout: compact and wrap-friendly without needing CSS changes.
    return el('div', {class:'wave-loot'}, [
      el('span', {class:'lbl'}, 'Loot'),
      el('span', {style:'display:flex; gap:6px; align-items:center; flex-wrap:wrap'}, [
        iconImg,
        typeImg,
        catSel,
        itemSel,
      ]),
    ]);
  })();

  const loggedPill = isLogged ? el('div', {class:'pill good', title:'Wave logged (4 fights + loot claimed)'}, 'LOGGED') : null;

  const head = el('div', {class:'wave-head'}, [
    el('div', {class:'wave-left'}, [
      el('div', {}, [
        el('div', {class:'wave-title'}, title),
        el('div', {class:'wave-meta'}, `Phase ${first.phase} · Wave ${first.wave} · ${slots.length} defenders`),
      ]),
    ]),
    el('div', {class:'wave-actions'}, [loggedPill, lootInline, btn].filter(Boolean)),
  ]);

  const body = el('div', {class:'wave-body ' + (expanded ? '' : 'hidden')});

  if (expanded){
    prefetchBaseForSlots(slots);
    const wp = state.wavePlans?.[waveKey] || null;
    body.appendChild(renderWavePlanner(state, waveKey, slots, wp));
  }

  return el('div', {class:'wave-card' + (isLogged ? ' logged' : '') + (expanded ? ' expanded' : '')}, [head, body]);
}

  return renderWaveCard;
}
