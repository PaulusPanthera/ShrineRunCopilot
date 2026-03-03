// js/ui/tabs/bagTab.js
// alpha v1
// Bag tab UI extracted from js/app/app.js (UI-only refactor).

import { el, pill } from '../dom.js';
import { fixName } from '../../data/nameFixes.js';
import {
  ITEM_CATALOG,
  TYPES_NO_FAIRY,
  plateName,
  gemName,
  moveTypesFromMovePool,
  tipCandidatesForTypes,
  lootBundle,
  normalizeBagKey,
  computeRosterUsage,
  availableCount,
  availableCountWithItemOverrides,
  enforceBagConstraints,
  isGem,
  isPlate,
  priceOfItem,
  buyOffer,
} from '../../domain/items.js';
import { applyCharmRulesSync } from '../../domain/roster.js';
import { getItemIcon, getTypeIcon } from '../icons.js';

function byId(arr, id){
  return (arr||[]).find(x => x && x.id === id);
}
function uniq(arr){
  return Array.from(new Set((arr||[]).filter(Boolean)));
}

export function createBagTab(ctx){
  const { data, store, tabBag } = ctx;

function renderBag(state){
  tabBag.innerHTML = '';

  const used0 = computeRosterUsage(state);
  const bag = state.bag || {};
  const bagNames = Object.keys(bag).sort((a,b)=>a.localeCompare(b));

  const isPlate = (n)=> typeof n === 'string' && n.endsWith(' Plate');
  const isGem = (n)=> typeof n === 'string' && n.endsWith(' Gem');
  const isCharm = (n)=> n === 'Evo Charm' || n === 'Strength Charm';

  // Shop state
  const shop = state.shop || {gold:0, ledger:[]};
  const gold = Math.max(0, Math.floor(Number(shop.gold||0)));
  const ledger = Array.isArray(shop.ledger) ? shop.ledger : [];

  const canUseItem = (name)=>{
    // "Use" = consume 1 from bag (undoable). For held items, we also clear it from one current holder.
    if (!name) return false;
    if (isCharm(name)) return false;
    return true;
  };

  const bagPanel = el('div', {class:'panel'}, [
    el('div', {style:'display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap'}, [
      el('div', {}, [
        el('div', {class:'panel-title'}, 'Bag'),
        el('div', {class:'muted small'}, 'Shared team bag. Wave loot adds here. Charms + held items consume from shared totals.'),
      ]),
      el('div', {style:'display:flex; align-items:center; gap:10px; flex-wrap:wrap'}, [
        el('div', {class:'shop-balance'}, ['Gold: ', el('span', {class:'pill good'}, String(gold))]),
        (function(){
          const b = el('button', {class:'btn-mini btn-undo', disabled: ledger.length===0}, '↩ Undo');
          b.title = 'Undo last shop/bag action (buy/sell/use)';
          b.addEventListener('click', ()=>{
            store.update(s=>{
              s.shop = s.shop || {gold:0, ledger:[]};
              const led = Array.isArray(s.shop.ledger) ? s.shop.ledger : (s.shop.ledger=[]);
              const tx = led.pop();
              if (!tx) return;

              // Undo gold
              s.shop.gold = Math.max(0, Math.floor(Number(s.shop.gold||0) - Number(tx.goldDelta||0)));

              // Undo bag delta
              s.bag = s.bag || {};
              const item = String(tx.item||'');
              const qty = Math.max(1, Number(tx.qty||1));
              let inv = 0;
              if (tx.type === 'buy') inv = -qty;
              else if (tx.type === 'sell' || tx.type === 'use') inv = +qty;

              if (item && inv !== 0){
                const cur = Number(s.bag[item]||0);
                const next = cur + inv;
                if (next <= 0) delete s.bag[item];
                else s.bag[item] = next;
              }

              // Restore roster items cleared by a "use" action
              if (Array.isArray(tx.rosterRestore)){
                for (const rr of tx.rosterRestore){
                  const mon = byId(s.roster||[], rr.id);
                  if (!mon) continue;
                  if (!mon.item) mon.item = rr.prevItem || null;
                }
              }

              enforceBagConstraints(data, s, applyCharmRulesSync);
            });
          });
          return b;
        })(),
      ]),
    ]),
  ]);



  // Bag category tabs (UI only)
  const bagTab = (state.ui && state.ui.bagTab) ? String(state.ui.bagTab) : 'all';
  const tabBtn = (key, label)=>{
    const b = el('button', {class: 'tabpill' + (bagTab===key ? ' active' : ''), type:'button'}, label);
    b.addEventListener('click', ()=>{
      store.update(s=>{ s.ui = s.ui || {}; s.ui.bagTab = key; });
    });
    return b;
  };
  const tabsRow = el('div', {class:'bag-tabs'}, [
    tabBtn('all','All'),
    tabBtn('charms','Charms'),
    tabBtn('held','Held'),
    tabBtn('plates','Plates'),
    tabBtn('gems','Gems'),
  ]);
  bagPanel.appendChild(tabsRow);
  // Bag table
  const tbl = el('table', {class:'bag-table', style:'margin-top:10px'}, [
    el('thead', {}, el('tr', {}, [
      el('th', {}, 'Item'),
      el('th', {}, 'Total'),
      el('th', {}, 'Used'),
      el('th', {}, 'Avail'),
      el('th', {}, 'Use'),
      el('th', {}, 'Sell'),
    ])),
    el('tbody'),
  ]);

  const tbody = tbl.querySelector('tbody');

  const sections = [
    {key:'charms', title:'Charms', filter:isCharm},
    {key:'held', title:'Hold items', filter:(n)=>!isCharm(n) && !isPlate(n) && !isGem(n)},
    {key:'plates', title:'Plates', filter:isPlate},
    {key:'gems', title:'Gems', filter:isGem},
  ];

  const addSectionRow = (title)=>{
    tbody.appendChild(el('tr', {}, [
      el('td', {colspan:'6', class:'muted small', style:'padding-top:14px; font-weight:900; letter-spacing:.02em;'}, title),
    ]));
  };

  const makeItemRow = (name)=>{
    const qty = Number(state.bag?.[name]) || 0;
    const u = Number(used0[name]||0);
    const avail = qty - u;
    const price = priceOfItem(name);

    const itemIconSrc = getItemIcon(name);
    const typeBadge = (isPlate(name) ? String(name).replace(/ Plate$/, '') : (isGem(name) ? String(name).replace(/ Gem$/, '') : null));
    const typeIconSrc = typeBadge ? getTypeIcon(typeBadge) : '';

    const itemCell = el('div', {class:'itemcell'}, [
      itemIconSrc ? el('img', {class:'item-ico', src:itemIconSrc, alt:''}) : null,
      typeIconSrc ? el('img', {class:'type-ico', src:typeIconSrc, alt:typeBadge}) : null,
      el('span', {class:'name'}, name),
    ].filter(Boolean));

    const useBtn = el('button', {class:'btn-mini'}, 'Use 1');
    useBtn.disabled = (!canUseItem(name) || qty <= 0);
    useBtn.title = canUseItem(name)
      ? 'Consume 1 from Bag (undoable). If equipped, clears it from one holder.'
      : 'Not usable';

    useBtn.addEventListener('click', ()=>{
      if (!canUseItem(name)) return;
      store.update(s=>{
        s.bag = s.bag || {};
        const have = Number(s.bag?.[name]||0);
        if (have <= 0) return;

        // If equipped anywhere, clear from ONE holder so we don't keep a ghost-equipped item.
        const rosterRestore = [];
        const holder = (s.roster||[]).find(r=>r && r.item === name);
        if (holder){
          rosterRestore.push({id: holder.id, prevItem: name});
          holder.item = null;
        }

        const next = have - 1;
        if (next <= 0) delete s.bag[name];
        else s.bag[name] = next;

        s.shop = s.shop || {gold:0, ledger:[]};
        s.shop.ledger = Array.isArray(s.shop.ledger) ? s.shop.ledger : [];
        s.shop.ledger.push({ts:Date.now(), type:'use', item:name, qty:1, goldDelta:0, rosterRestore});
        if (s.shop.ledger.length > 80) s.shop.ledger.splice(0, s.shop.ledger.length - 80);

        enforceBagConstraints(data, s, applyCharmRulesSync);
      });
    });

    const sellBtn = el('button', {class:'btn-mini'}, 'Sell 1');
    sellBtn.disabled = !(price > 0) || avail <= 0;
    sellBtn.title = (price > 0) ? `${price} gold (only AVAILABLE can be sold)` : 'Not sellable';

    sellBtn.addEventListener('click', ()=>{
      if (!(price > 0)) return;
      store.update(s=>{
        s.bag = s.bag || {};
        const used2 = computeRosterUsage(s);
        const have = Number(s.bag?.[name]||0);
        const u2 = Number(used2?.[name]||0);
        const a2 = have - u2;
        if (a2 <= 0) return;

        const next = have - 1;
        if (next <= 0) delete s.bag[name];
        else s.bag[name] = next;

        s.shop = s.shop || {gold:0, ledger:[]};
        s.shop.gold = Math.max(0, Math.floor(Number(s.shop.gold||0) + price));
        s.shop.ledger = Array.isArray(s.shop.ledger) ? s.shop.ledger : [];
        s.shop.ledger.push({ts:Date.now(), type:'sell', item:name, qty:1, goldDelta:+price});
        if (s.shop.ledger.length > 80) s.shop.ledger.splice(0, s.shop.ledger.length - 80);

        enforceBagConstraints(data, s, applyCharmRulesSync);
      });
    });

    return el('tr', {}, [
      el('td', {}, itemCell),
      el('td', {style:'text-align:right'}, String(qty)),
      el('td', {style:'text-align:right'}, String(u)),
      el('td', {style:'text-align:right'}, el('span', {class: avail < 0 ? 'pill bad' : 'pill good'}, avail < 0 ? `-${Math.abs(avail)}` : String(avail))),
      el('td', {style:'text-align:right'}, useBtn),
      el('td', {style:'text-align:right'}, sellBtn),
    ]);
  };

  if (!bagNames.length){
    tbody.appendChild(el('tr', {}, [
      el('td', {colspan:'6', class:'muted'}, 'No items yet.'),
    ]));
  } else {
    const sectionsToShow = (bagTab && bagTab !== 'all')
      ? sections.filter(s=>s.key===bagTab)
      : sections;

    for (const sec of sectionsToShow){
      const list = bagNames.filter(sec.filter);
      if (!list.length) continue;
      addSectionRow(sec.title);
      for (const n of list){
        tbody.appendChild(makeItemRow(n));
      }
    }
  }

  bagPanel.appendChild(tbl);

  
  // Politoed shop (buy)
  const shopPanel = el('div', {class:'panel'}, [
    el('div', {class:'panel-title'}, "Politoed's Shop"),
    el('div', {class:'muted small'}, 'Shop sells Plates as singles, Gems as bundles (x5), and Rare Candy as a bundle (x1/x2/x3). Selling via the table above is always 1 unit. Coins are loot-only.'),
  ]);

  const buyOfferFor = (itemName)=> buyOffer(itemName);

  const doBuyOffer = (off)=>{
    if (!off) return;
    store.update(s=>{
      s.shop = s.shop || {gold:0, ledger:[]};
      const g = Math.max(0, Math.floor(Number(s.shop.gold||0)));
      const cost = Math.max(0, Math.floor(Number(off.cost||0)));
      const qty = Math.max(1, Math.floor(Number(off.qty||1)));
      if (!(cost > 0)) return;
      if (g < cost){
        alert('Not enough gold.');
        return;
      }

      s.shop.gold = g - cost;
      s.shop.ledger = Array.isArray(s.shop.ledger) ? s.shop.ledger : [];
      s.shop.ledger.push({ts:Date.now(), type:'buy', item:off.item, qty, goldDelta:-cost});
      if (s.shop.ledger.length > 80) s.shop.ledger.splice(0, s.shop.ledger.length - 80);

      s.bag = s.bag || {};
      const k = normalizeBagKey ? normalizeBagKey(off.item) : off.item;
      s.bag[k] = Number(s.bag[k]||0) + qty;

      // keep wallet in sync if it exists
      if (s.wallet && typeof s.wallet === 'object'){
        s.wallet.gold = Math.max(0, Math.floor(Number(s.shop.gold||0)));
      }

      enforceBagConstraints(data, s, applyCharmRulesSync);
    });
  };

  const doBuy = (itemName)=>{
    const off = buyOfferFor(itemName);
    if (!off) return;
    doBuyOffer(off);
  };

  const grid = el('div', {class:'shop-grid'});

  // Charms first (high-traffic)
  for (const name of ['Evo Charm','Strength Charm']){
    const off = buyOfferFor(name);
    if (!off) continue;
    const iconImg = el('img', {class:'item-ico', alt:''});
    const itemSrc = getItemIcon(name);
    iconImg.src = itemSrc || '';
    iconImg.style.display = itemSrc ? '' : 'none';

    const buyBtn = el('button', {class:'btn-mini'}, 'Buy');
    if (gold < (off.cost||0)) buyBtn.disabled = true;
    buyBtn.addEventListener('click', ()=> doBuy(name));

    grid.appendChild(el('div', {class:'shop-card shop-card-charm'}, [
      el('div', {class:'shop-meta'}, [
        el('div', {class:'shop-name'}, el('span', {class:'itemcell'}, [
          iconImg,
          el('span', {class:'name'}, name),
        ])),
        el('div', {class:'shop-price'}, `price: ${off.cost}g${(off.qty||1) > 1 ? ` · +${off.qty}` : ''}`),
      ]),
      buyBtn,
    ]));
  }


  // --- Smart selectors (reduce 80+ variations) ---

  // Gems (bundle x5)
  (function(){
    const sel = el('select', {class:'sel-mini'}, TYPES_NO_FAIRY.map(t=> el('option', {value:t}, t)));
    const getItem = ()=> gemName(sel.value);
    const iconImg = el('img', {class:'item-ico', alt:''});
    const typeImg = el('img', {class:'type-ico', alt:''});
    const buyBtn = el('button', {class:'btn-mini'}, 'Buy');
    const priceLine = el('div', {class:'shop-price'});

    const sync = ()=>{
      const off = buyOfferFor(getItem());
      const can = off && (gold >= (off.cost||0));
      buyBtn.disabled = !can;
      priceLine.textContent = off ? `price: ${off.cost}g · +${off.qty}` : 'price: —';

      const itemSrc = getItemIcon(getItem());
      iconImg.src = itemSrc || '';
      iconImg.style.display = itemSrc ? '' : 'none';

      const tSrc = getTypeIcon(sel.value);
      typeImg.src = tSrc || '';
      typeImg.alt = sel.value;
      typeImg.style.display = tSrc ? '' : 'none';
    };
    sel.addEventListener('change', sync);
    buyBtn.addEventListener('click', ()=> doBuy(getItem()));
    sync();

    const mainRow = el('div', {class:'shop-card-main'}, [
      el('span', {class:'itemcell'}, [
        iconImg,
        typeImg,
        el('span', {class:'name'}, 'Gem (x5)'),
      ]),
      buyBtn,
    ]);
    const subRow = el('div', {class:'shop-card-sub'}, [
      el('div', {class:'shop-sub-left'}, [sel]),
      el('div', {class:'shop-sub-right'}, [priceLine]),
    ]);
    grid.appendChild(el('div', {class:'shop-card shop-card-stack'}, [mainRow, subRow]));
  })();

  // Plates (single)
  (function(){
    const sel = el('select', {class:'sel-mini'}, TYPES_NO_FAIRY.map(t=> el('option', {value:t}, t)));
    const getItem = ()=> plateName(sel.value);
    const iconImg = el('img', {class:'item-ico', alt:''});
    const typeImg = el('img', {class:'type-ico', alt:''});
    const buyBtn = el('button', {class:'btn-mini'}, 'Buy');
    const priceLine = el('div', {class:'shop-price'});

    const sync = ()=>{
      const off = buyOfferFor(getItem());
      const can = off && (gold >= (off.cost||0));
      buyBtn.disabled = !can;
      priceLine.textContent = off ? `price: ${off.cost}g` : 'price: —';

      const itemSrc = getItemIcon(getItem());
      iconImg.src = itemSrc || '';
      iconImg.style.display = itemSrc ? '' : 'none';

      const tSrc = getTypeIcon(sel.value);
      typeImg.src = tSrc || '';
      typeImg.alt = sel.value;
      typeImg.style.display = tSrc ? '' : 'none';
    };
    sel.addEventListener('change', sync);
    buyBtn.addEventListener('click', ()=> doBuy(getItem()));
    sync();

    const mainRow = el('div', {class:'shop-card-main'}, [
      el('span', {class:'itemcell'}, [
        iconImg,
        typeImg,
        el('span', {class:'name'}, 'Plate'),
      ]),
      buyBtn,
    ]);
    const subRow = el('div', {class:'shop-card-sub'}, [
      el('div', {class:'shop-sub-left'}, [sel]),
      el('div', {class:'shop-sub-right'}, [priceLine]),
    ]);
    grid.appendChild(el('div', {class:'shop-card shop-card-stack'}, [mainRow, subRow]));
  })();

  // Rare Candy (x1/x2/x3)
  (function(){
    const sel = el('select', {class:'sel-mini'}, [1,2,3].map(n=> el('option', {value:String(n)}, `x${n}`)));
    const iconImg = el('img', {class:'item-ico', alt:''});
    const buyBtn = el('button', {class:'btn-mini'}, 'Buy');
    const priceLine = el('div', {class:'shop-price'});

    const sync = ()=>{
      const qty = Number(sel.value||1);
      const cost = qty * 16;
      buyBtn.disabled = gold < cost;
      priceLine.textContent = `price: ${cost}g · +${qty}`;

      const itemSrc = getItemIcon('Rare Candy');
      iconImg.src = itemSrc || '';
      iconImg.style.display = itemSrc ? '' : 'none';
    };
    sel.addEventListener('change', sync);
    buyBtn.addEventListener('click', ()=>{
      const qty = Number(sel.value||1);
      const cost = qty * 16;
      doBuyOffer({item:'Rare Candy', qty, cost, label:`Rare Candy x${qty}`});
    });
    sync();

    const mainRow = el('div', {class:'shop-card-main'}, [
      el('span', {class:'itemcell'}, [
        iconImg,
        el('span', {class:'name'}, 'Rare Candy'),
      ]),
      buyBtn,
    ]);
    const subRow = el('div', {class:'shop-card-sub'}, [
      el('div', {class:'shop-sub-left'}, [sel]),
      el('div', {class:'shop-sub-right'}, [priceLine]),
    ]);
    grid.appendChild(el('div', {class:'shop-card shop-card-stack'}, [mainRow, subRow]));
  })();



  // Air Balloon (x5)
  (function(){
    const iconImg = el('img', {class:'item-ico', alt:''});
    const buyBtn = el('button', {class:'btn-mini'}, 'Buy');
    const priceLine = el('div', {class:'shop-price'});

    const sync = ()=>{
      const off = buyOfferFor('Air Balloon');
      const can = off && (gold >= (off.cost||0));
      buyBtn.disabled = !can;
      priceLine.textContent = off ? `price: ${off.cost}g · +${off.qty}` : 'price: —';

      const itemSrc = getItemIcon('Air Balloon');
      iconImg.src = itemSrc || '';
      iconImg.style.display = itemSrc ? '' : 'none';
    };

    buyBtn.addEventListener('click', ()=> doBuy('Air Balloon'));
    sync();

    grid.appendChild(el('div', {class:'shop-card'}, [
      el('div', {class:'shop-meta'}, [
        el('div', {class:'shop-name'}, el('span', {class:'itemcell'}, [
          iconImg,
          el('span', {class:'name'}, 'Air Balloon (x5)'),
        ])),
        priceLine,
      ]),
      buyBtn,
    ]));
  })();
  // --- Remaining singles (no type variations) ---
  const shopSingles = uniq(ITEM_CATALOG
    .map(n=>lootBundle(n))
    .filter(Boolean)
    .map(b=>b.key)
    .filter(Boolean)
  )
    .filter(n=>!isGem(n) && !isPlate(n))
    .filter(n=>n !== 'Copper Coin')
    .filter(n=>n !== 'Air Balloon')
    .filter(n=>n !== 'Rare Candy')
    .filter(n=>n !== 'Evo Charm')
    .filter(n=>n !== 'Strength Charm')
    .filter(n=>!!buyOfferFor(n))
    .sort((a,b)=>a.localeCompare(b));

  for (const name of shopSingles){
    const off = buyOfferFor(name);
    if (!off) continue;
    const iconImg = el('img', {class:'item-ico', alt:''});
    const itemSrc = getItemIcon(name);
    iconImg.src = itemSrc || '';
    iconImg.style.display = itemSrc ? '' : 'none';
    const buyBtn = el('button', {class:'btn-mini'}, 'Buy');
    if (gold < (off.cost||0)) buyBtn.disabled = true;
    buyBtn.addEventListener('click', ()=> doBuy(name));
    grid.appendChild(el('div', {class:'shop-card'}, [
      el('div', {class:'shop-meta'}, [
        el('div', {class:'shop-name'}, el('span', {class:'itemcell'}, [
          iconImg,
          el('span', {class:'name'}, name),
        ])),
        el('div', {class:'shop-price'}, `price: ${off.cost}g${(off.qty||1) > 1 ? ` · +${off.qty}` : ''}`),
      ]),
      buyBtn,
    ]));
  }

  shopPanel.appendChild(grid);
// Recent transactions (compact)
  const recent = ledger.slice(-10).reverse();
  const ledgerBox = el('div', {class:'shop-ledger'}, []);
  if (!recent.length){
    ledgerBox.appendChild(el('div', {class:'muted small'}, 'No transactions yet.'));
  } else {
    for (const tx of recent){
      const sign = tx.goldDelta >= 0 ? '+' : '';
      ledgerBox.appendChild(el('div', {class:'shop-ledger-row'}, `${tx.type.toUpperCase()} ${tx.item} x${tx.qty} (${sign}${tx.goldDelta}g)`));
    }
  }
  shopPanel.appendChild(el('div', {class:'panel-subtitle', style:'margin-top:12px'}, 'Recent transactions'));
  shopPanel.appendChild(ledgerBox);

  tabBag.appendChild(el('div', {class:'bag-layout'}, [
    el('div', {class:'bag-col bag-left'}, [bagPanel]),
    el('div', {class:'bag-col bag-right'}, [shopPanel]),
  ]));
}


  return { render: renderBag };
}
