
// app.js
// Abundant Shrine — Roster Planner (alpha v13)
// Local-first: state saved to localStorage.

(async function(){
  const $ = (sel, el=document) => el.querySelector(sel);
  const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));

  const STORAGE_KEY = "abundantShrinePlanner_state_v13";
  const OLD_KEYS = ["abundantShrinePlanner_state_v12","abundantShrinePlanner_state_v11","abundantShrinePlanner_state_v10","abundantShrinePlanner_state_v9"];
  const STATE_VERSION = 13;

  function deepClone(x){ return JSON.parse(JSON.stringify(x)); }

  function uniq(arr){ return Array.from(new Set(arr)); }

  function byId(arr, id){ return arr.find(x => x.id === id); }

  function safeText(s){ return (s == null) ? "" : String(s); }

  function sprite(name){
    return window.SHRINE_CALC.spriteUrlPokemonDbBW(name);
  }

  function el(tag, attrs={}, children=[]){
    const n = document.createElement(tag);
    for (const [k,v] of Object.entries(attrs||{})){
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, "");
      else if (v !== false && v != null) n.setAttribute(k, String(v));
    }
    for (const c of (Array.isArray(children)?children:[children])){
      if (c == null) continue;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return n;
  }

  function pill(text, kind){
    return el("span", {class:`pill ${kind||""}`}, text);
  }

  function formatPct(x){
    if (x == null || Number.isNaN(Number(x))) return "—";
    return `${Number(x).toFixed(1)}%`;
  }

  function clampInt(v, lo, hi){
    const n = Number.parseInt(String(v), 10);
    const x = Number.isFinite(n) ? n : lo;
    return Math.max(lo, Math.min(hi, x));
  }

function statCell(label, value){
  return el("div", {class:"statcell"}, [
    el("div", {class:"muted small"}, label),
    el("div", {class:"statval"}, value == null ? "—" : String(value))
  ]);
}


  // ---------------- Data load ----------------
  const data = await loadData();


  // Name fixes (sheet quirks)
  const NAME_FIX = {
    "Snub +": "Snubbull",
    "Snubb +": "Snubbull",
    "Charm": "Charmeleon"
  };
  const fixName = (s) => NAME_FIX[s] || s;

  // Apply name fixes to calc slots + claimed sets
  data.calcSlots = (data.calcSlots || []).map(x => ({
    ...x,
    defender: fixName(x.defender),
    animal: x.animal ? String(x.animal) : x.animal,
    rowKey: x.rowKey
  }));

  // Derive useful sets
  const defenderSpeciesSet = new Set(data.calcSlots.map(s => s.defender));
  const defenderSpecies = Array.from(defenderSpeciesSet).sort((a,b)=>a.localeCompare(b));

  // ---------------- State ----------------

  
  // Evo + Strength rules
  // - Starters (Cobalion/Keldeo/Terrakion/Virizion): Strength forced ON, no Evo charm.
  // - Everyone else: Evo charm auto-evolves to a best-known final form (alpha rules).
  const STARTERS = new Set(["Cobalion","Keldeo","Terrakion","Virizion"]);

  // Hard overrides for alpha (branch evolutions)
  const EVO_OVERRIDES = {
    Eevee: "Espeon",
    Slowpoke: "Slowking",
  };

  // Small fast-path presets (avoids network, can be extended any time)
  const EVO_PRESET = {
    Mareep: "Ampharos",
    Cottonee: "Whimsicott",
  };

  function isStarterSpecies(species){
    return STARTERS.has(species);
  }

  // Normalization helpers for mapping API names -> our Dex keys
  const _dexKeyByNorm = new Map();
  function _normName(s){
    return String(s||"")
      .toLowerCase()
      .replace(/['.:%]/g,"")
      .replace(/\s+/g,"")
      .replace(/[^a-z0-9-]/g,"")
      .replace(/-/g,"");
  }
  for (const k of Object.keys(data.dex)){
    _dexKeyByNorm.set(_normName(k), k);
  }

  function toApiSlug(name){
    // best-effort; many of your names are simple
    return String(name||"")
      .toLowerCase()
      .replace(/♀/g,'-f')
      .replace(/♂/g,'-m')
      .replace(/'/g,'')
      .replace(/\./g,'')
      .replace(/:/g,'')
      .replace(/é/g,'e')
      .replace(/\s+/g,'-')
      .replace(/[^a-z0-9-]/g,'');
  }

  function bstOf(species){
    const d = data.dex[species];
    if (!d) return 0;
    if (typeof d.bst === "number") return d.bst;
    const b = d.base || {};
    return (b.hp||0)+(b.atk||0)+(b.def||0)+(b.spa||0)+(b.spd||0)+(b.spe||0);
  }

  function getEvoTarget(base){
    if (!base || isStarterSpecies(base)) return null;
    // overrides > preset > cached
    const override = EVO_OVERRIDES[base];
    if (override && data.dex[override]) return override;

    const preset = EVO_PRESET[base];
    if (preset && data.dex[preset]) return preset;

    const cached = state?.evoCache?.[base];
    if (cached && data.dex[cached]) return cached;

    return null;
  }

  async function resolveEvoTarget(base){
    if (!base || isStarterSpecies(base)) return null;
    const already = getEvoTarget(base);
    if (already) return already;

    state.evoCache = state.evoCache || {};
  state.baseCache = state.baseCache || {};


    try{
      const slug = toApiSlug(base);
      const sp = await fetch(`https://pokeapi.co/api/v2/pokemon-species/${slug}`);
      if (!sp.ok) throw new Error("species fetch failed");
      const spJson = await sp.json();

      // If no evolution chain, cache as null
      if (!spJson.evolution_chain || !spJson.evolution_chain.url){
        state.evoCache[base] = null;
        saveState();
        return null;
      }

      const chainRes = await fetch(spJson.evolution_chain.url);
      if (!chainRes.ok) throw new Error("chain fetch failed");
      const chainJson = await chainRes.json();

      // Collect all species names in the chain
      const names = [];
      const walk = (node)=>{
        if (!node) return;
        if (node.species && node.species.name) names.push(node.species.name);
        if (Array.isArray(node.evolves_to)){
          for (const ch of node.evolves_to) walk(ch);
        }
      };
      walk(chainJson.chain);

      // Map to our Dex keys, choose highest BST as "final" for planning
      const candidates = [];
      for (const n of names){
        const key = _dexKeyByNorm.get(_normName(n));
        if (key && data.dex[key]) candidates.push(key);
      }

      // if we can't map, cache null
      if (!candidates.length){
        state.evoCache[base] = null;
        saveState();
        return null;
      }

      // Apply alpha branch override if base matches
      if (EVO_OVERRIDES[base] && data.dex[EVO_OVERRIDES[base]]){
        state.evoCache[base] = EVO_OVERRIDES[base];
        saveState();
        return state.evoCache[base];
      }

      // Pick highest BST among candidates (usually final evo)
      candidates.sort((a,b)=>bstOf(b)-bstOf(a));
      const chosen = candidates[0] || null;

      state.evoCache[base] = chosen;
      saveState();
      return chosen;
    }catch(e){
      // network failed -> leave unmapped
      state.evoCache[base] = state.evoCache[base] ?? null;
      saveState();
      return null;
    }
  }

  
  // Base-species resolution (for unlocking/claiming)
  const BASE_OVERRIDES = {
    Espeon: "Eevee",
    Slowking: "Slowpoke",
    Whimsicott: "Cottonee",
    Ampharos: "Mareep",
  };

  function apiNameToDexKey(apiName){
    const k = _dexKeyByNorm.get(_normName(apiName));
    return k || null;
  }

  function baseOfSync(species){
    const s = fixName(species);
    const o = BASE_OVERRIDES[s];
    if (o && data.dex[o]) return o;
    const cached = state?.baseCache?.[s];
    if (cached && data.dex[cached]) return cached;
    return s;
  }

async function resolveBaseSpecies(species){
  // Returns base species (root of evo chain) and caches ALL forms in that chain → base.
  const s = fixName(species);
  const o = BASE_OVERRIDES[s];
  if (o && data.dex[o]) return o;

  state.baseCache = state.baseCache || {};
  const cached = state.baseCache[s];
  if (cached && data.dex[cached]) return cached;

  const cacheSelf = (base)=>{
    state.baseCache[s] = base;
    saveState();
    return base;
  };

  try{
    const slug = toApiSlug(s);
    const sp = await fetch(`https://pokeapi.co/api/v2/pokemon-species/${slug}`);
    if (!sp.ok) throw new Error("species fetch failed");
    const spJson = await sp.json();
    if (!spJson.evolution_chain || !spJson.evolution_chain.url){
      return cacheSelf(s);
    }

    const ch = await fetch(spJson.evolution_chain.url);
    if (!ch.ok) throw new Error("chain fetch failed");
    const chJson = await ch.json();

    // walk chain and collect all species api names
    const apiNames = [];
    const walk = (node)=>{
      if (!node) return;
      if (node.species && node.species.name) apiNames.push(node.species.name);
      if (Array.isArray(node.evolves_to)){
        for (const c of node.evolves_to) walk(c);
      }
    };
    walk(chJson.chain);

    const rootApi = chJson?.chain?.species?.name;
    const rootDex = apiNameToDexKey(rootApi) || s;

    // cache every chain member (best effort)
    for (const an of apiNames){
      const dk = apiNameToDexKey(an);
      if (dk) state.baseCache[dk] = rootDex;
    }
    state.baseCache[s] = rootDex;
    saveState();
    return rootDex;
  }catch(e){
    return cacheSelf(s);
  }
}


  // Best-effort prefetch so baseOfSync() can instantly map evo-forms across the UI.
  // Non-blocking; uses resolveBaseSpecies() which caches whole evo chains.
  const _basePrefetchInFlight = new Set();
  let _basePrefetchTimer = null;

  function _scheduleBaseUiRefresh(){
    if (_basePrefetchTimer) return;
    _basePrefetchTimer = setTimeout(()=>{
      _basePrefetchTimer = null;
      try{
        renderWaves();
        renderUnlocked();
        updateHeaderCounts();
      }catch(e){ /* ignore */ }
    }, 50);
  }

  function prefetchBaseForSlots(slots){
    if (!slots || !slots.length) return;
    state.baseCache = state.baseCache || {};
    const species = uniq(slots.map(s=>fixName(s.defender)));
    for (const sp of species){
      const s = fixName(sp);
      if (BASE_OVERRIDES[s]) continue;
      if (state.baseCache[s] && data.dex[state.baseCache[s]]) continue;
      if (_basePrefetchInFlight.has(s)) continue;
      _basePrefetchInFlight.add(s);
      resolveBaseSpecies(s)
        .catch(()=>{})
        .finally(()=>{
          _basePrefetchInFlight.delete(s);
          _scheduleBaseUiRefresh();
        });
    }
  }

function applyCharmRules(entry){
    const base = entry.baseSpecies;

    // Starters: Strength forced ON, Evo unavailable
    if (isStarterSpecies(base)){
      entry.strength = true;
      entry.evo = false;
      entry.effectiveSpecies = base;
      return;
    }

    if (entry.evo){
      const t = getEvoTarget(base);
      if (t){
        entry.effectiveSpecies = t;
      } else {
        entry.effectiveSpecies = base;
        // async resolve (non-blocking)
        resolveEvoTarget(base).then((resolved)=>{
          if (!resolved) return;
          // entry may have been removed; just update if still present and evo still on
          const cur = byId(state.roster, entry.id);
          if (!cur) return;
          if (!cur.evo) return;
          cur.effectiveSpecies = resolved;
          saveState();
          renderRoster();
          renderWaves();
          refreshOverviewIfNeeded();
        });
      }
    } else {
      entry.effectiveSpecies = base;
    }
  }

const defaultRoster = ["Cobalion","Keldeo","Terrakion","Virizion"].filter(s => data.claimedSets[s]);

  const defaultState = {
    version: STATE_VERSION,
    settings: {
      defenderHpFrac: 1.0,
      atkStage: 0,
      spaStage: 0,
      enemyDefStage: 0,
      enemySpdStage: 0,
      speStage: 0,
      enemySpeStage: 0,
      autoMatch: true,
      applyINT: true,
      applySTU: true,
      movesPerMon: 3,
      stabBonus: 2,
      conservePower: true,
      hideCleared: false,

      // constants from rules
      claimedLevel: Number(data.rules.Claimed_Level || 50),
      claimedIV: Number(data.rules.Claimed_IV_All || 31),
      claimedEV: Number(data.rules.Claimed_EV_All || 0),
      strengthEV: Number(data.rules.StrengthCharm_EV_All || 85),

      wildIV: Number(data.rules.Wild_IV_Default || 0),
      wildEV: Number(data.rules.Wild_EV_Default || 0),

      otherMult: 1
    },
    unlocked: {},
    cleared: {},     // rowKey -> true
    roster: [],      // entries
    bag: {},         // itemName -> qty
    evoCache: {},
    baseCache: {},    // species -> base species (cached)
    // baseSpecies -> evolved species (cached)
    wavePlans: {},   // waveKey -> per-wave setup (attackers/defenders)
    ui: {
      tab: "waves",
      waveExpanded: {}, // waveKey -> bool
      selectedRosterId: null,
      searchRoster: "",
      searchUnlocked: "",
      attackOverview: null // {defender, level, tags, source}
    }
  };

  let state = loadState() || defaultState;
  // migrate / sanity
  if (!state.version) state.version = STATE_VERSION;
  if (!state.settings) state.settings = deepClone(defaultState.settings);
  // Ensure defaults exist
  state.settings = {...deepClone(defaultState.settings), ...state.settings};
  // Auto-match is always enabled in v13+ (no sidebar toggle)
  state.settings.autoMatch = true;
  state.ui = {...deepClone(defaultState.ui), ...(state.ui||{})};
  state.unlocked = state.unlocked || {};
  state.cleared = state.cleared || {};
  state.roster = state.roster || [];
  state.bag = state.bag || {};
  state.wavePlans = state.wavePlans || {};
  state.evoCache = state.evoCache || {};
  state.baseCache = state.baseCache || {};


  // Seed roster if empty
  if (state.roster.length === 0) {
    for (const sp of defaultRoster){
      state.unlocked[sp] = true;
      state.roster.push(makeRosterEntryFromClaimedSet(sp));
    }
    state.ui.selectedRosterId = state.roster[0]?.id || null;
    saveState();
  }

  // Ensure roster species are unlocked
  for (const r of state.roster){
    state.unlocked[r.baseSpecies] = true;

    // Clean legacy fields
    if ("evolveTo" in r) delete r.evolveTo;

    // Enforce charm rules + effective species
    applyCharmRules(r);

    // v13+: migrate move priorities to 1/2/3 (lower = more preferred)
    r.movePool = r.movePool || [];
    for (const mv of r.movePool){
      const p = Number(mv.prio);
      if (p === 1 || p === 2 || p === 3) mv.prio = p;
      else if (p === 3.0) mv.prio = 1;
      else if (p === 2.5) mv.prio = 2;
      else mv.prio = 2;
    }
    // v13: held item field
    if (!('item' in r)) r.item = null;
  }

  
  // Migrate legacy waveTeams -> wavePlans (alpha v9)
  state.wavePlans = state.wavePlans || {};
  if (state.waveTeams){
    for (const [wk,obj] of Object.entries(state.waveTeams||{})){
      if (!state.wavePlans[wk]){
        const team2 = (obj && obj.team) ? obj.team.filter(id => !!byId(state.roster, id)) : [];
        state.wavePlans[wk] = {
          attackers: team2.slice(0,16),
          attackerStart: team2.slice(0,2),
          defenders: [],
          defenderStart: []
        };
      }
    }
  }

  // Prune invalid wave plan selections (roster edits)
  for (const [wk,wp] of Object.entries(state.wavePlans||{})){
    const a = (wp.attackers||[]).filter(id => !!byId(state.roster,id)).slice(0,16);
    const as = (wp.attackerStart||[]).filter(id => a.includes(id)).slice(0,2);
    state.wavePlans[wk] = {
      ...wp,
      attackers: a,
      attackerStart: (as.length?as:a.slice(0,2))
    };
  }

// ---------------- DOM refs ----------------
  const hpFrac = $("#hpFrac");
  const hpFracLabel = $("#hpFracLabel");
  const atkStage = $("#atkStage");
  const spaStage = $("#spaStage");
  const enemyDefStage = $("#enemyDefStage");
  const enemySpdStage = $("#enemySpdStage");
  const speStage = $("#speStage");
  const enemySpeStage = $("#enemySpeStage");
  const autoMatch = $("#autoMatch");
  const defIV = $("#defIV");
  const defEV = $("#defEV");

  const tabWaves = $("#tabWaves");
  const tabRoster = $("#tabRoster");
  const tabBag = $("#tabBag");
  const tabUnlocked = $("#tabUnlocked");
  const unlockedCountEl = $("#unlockedCount");
  const overview = $("#attackOverview");
  const ovSprite = $("#ovSprite");
  const ovTitle = $("#ovTitle");
  const ovMeta = $("#ovMeta");
  const ovBody = $("#ovBody");

  // ---------------- UI init ----------------
  bindTopButtons();
  bindEasterEgg();
  bindSidebar();

  renderAll();
  attachTabHandlers();

  // ---------------- Functions ----------------

  function moveInfo(name){
    return data.moves[name] || null;
  }

  function isDamagingMove(name){
    const mi = moveInfo(name);
    return !!mi && (mi.category === "Physical" || mi.category === "Special") && Number(mi.power);
  }

  function isStabMove(species, moveName){
    const d = data.dex[species];
    const mi = moveInfo(moveName);
    if (!d || !mi) return false;
    return Array.isArray(d.types) && d.types.includes(mi.type);
  }

  function defaultPrioForMove(species, moveName){
  // Priority tiers:
  //   P1 = preferred (weak filler; low BP, usually non-STAB)
  //   P2 = normal
  //   P3 = "nukes" (only used if P1/P2 can't OHKO)
  const mi = moveInfo(moveName);
  if (!mi) return 2;
  const bp = Number(mi.power) || 0;
  if (!(mi.category === "Physical" || mi.category === "Special") || bp <= 0) return 2;

  const stab = isStabMove(species, moveName);

  // Weak coverage/filler
  if (!stab && bp <= 60) return 1;

  // Very strong moves default to P3 (save unless needed)
  if (bp >= 90) return 3;

  return 2;
}

  function buildDefaultMovePool(species, moveNames, source){
    const uniqueMoves = uniq((moveNames||[]).filter(Boolean));
    return uniqueMoves.map(m => ({
      name: m,
      prio: defaultPrioForMove(species, m),
      use: true,
      source: source || "base"
    }));
  }

  function makeRosterEntryFromClaimedSet(species){
    const set = data.claimedSets[species] || {ability:"", moves:[]};
    const id = `r_${species}_${Math.random().toString(16).slice(2,9)}`;
    const entry = {
      id,
      baseSpecies: species,
      effectiveSpecies: species,
      active: true,
      // Charms
      evo: false,
      strength: false,
      // Fixed baseline
      ability: set.ability || "",
      // Move pool (fixed baseline + TM additions later)
      movePool: buildDefaultMovePool(species, (set.moves||[]), "base"),
      // Held item (tracking only)
      item: null
    };

    // Apply starter + evo mapping rules
    applyCharmRules(entry);
    return entry;
  }

  function saveState(){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }catch(e){
      console.warn("Failed saving state", e);
    }
  }
  function loadState(){
    try{
      let raw = localStorage.getItem(STORAGE_KEY);
      if (!raw){
        for (const k of (OLD_KEYS||[])){
          const r = localStorage.getItem(k);
          if (r){ raw = r; break; }
        }
      }
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || typeof s !== 'object') return null;
      return s;
    }catch(e){
      return null;
    }
  }

  function bindTopButtons(){
    $("#btnExport").addEventListener("click", ()=>{
      const blob = new Blob([JSON.stringify(state, null, 2)], {type:"application/json"});
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `abundant_shrine_state_alpha_${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    $("#btnImport").addEventListener("click", ()=> $("#fileImport").click());
    $("#fileImport").addEventListener("change", async (ev)=>{
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      try{
        const txt = await file.text();
        const s = JSON.parse(txt);
        if (!s || typeof s !== 'object') throw new Error("Bad JSON");
        state = {...deepClone(defaultState), ...s};
        // ensure settings defaults
        state.settings = {...deepClone(defaultState.settings), ...(state.settings||{})};
        state.ui = {...deepClone(defaultState.ui), ...(state.ui||{})};

        state.unlocked = state.unlocked || {};
        state.cleared = state.cleared || {};
        state.roster = state.roster || [];
  state.bag = state.bag || {};
        state.wavePlans = state.wavePlans || {};
  state.evoCache = state.evoCache || {};
  state.baseCache = state.baseCache || {};


        // Enforce alpha rules
        for (const r of state.roster){
          if ("evolveTo" in r) delete r.evolveTo;
          if (!Array.isArray(r.movePool)) r.movePool = [];
          applyCharmRules(r);

          // v13+: migrate move priorities to 1/2/3 (lower = more preferred)
          r.movePool = r.movePool || [];
          for (const mv of r.movePool){
            const p = Number(mv.prio);
            if (p === 1 || p === 2 || p === 3) mv.prio = p;
            else if (p === 3.0) mv.prio = 1;
            else if (p === 2.5) mv.prio = 2;
            else mv.prio = 2;
          }
          if (!('item' in r)) r.item = null;

          // If movePool is empty, rebuild from claimedSets
          if (r.movePool.length === 0 && data.claimedSets[r.baseSpecies]){
            r.movePool = buildDefaultMovePool(r.baseSpecies, data.claimedSets[r.baseSpecies].moves || [], "base");
          }
        }

        saveState();
        renderAll();
      }catch(e){
        alert("Import failed: " + e.message);
      } finally {
        ev.target.value = "";
      }
    });
    $("#btnReset").addEventListener("click", ()=>{
      if (!confirm("Reset ALL local data (roster, cleared slots, unlocked)?")) return;
      state = deepClone(defaultState);
      // seed roster
      for (const sp of defaultRoster){
        state.unlocked[sp] = true;
        state.roster.push(makeRosterEntryFromClaimedSet(sp));
      }
      state.ui.selectedRosterId = state.roster[0]?.id || null;
      saveState();
      renderAll();
    });
  }

  // ---------------- Easter egg mini-game ----------------
  function bindEasterEgg(){
    const title = $("#brandTitle");
    const modal = $("#eggModal");
    if (!title || !modal) return;

    const closeBtn = $("#eggClose");
    const arena = $("#eggArena");
    const ball = $("#eggBall");
    const tEl = $("#eggTime");
    const sEl = $("#eggScore");
    const bEl = $("#eggBest");

    const BEST_KEY = "abundantShrinePlanner_eggBest";
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
      modal.classList.remove("hidden");
      startGame();
    }
    function close(){
      stopGame();
      modal.classList.add("hidden");
    }
    function stopGame(){
      if (gameTimer) clearInterval(gameTimer);
      if (tickTimer) clearInterval(tickTimer);
      gameTimer = null; tickTimer = null;
    }
    function startGame(){
      stopGame();
      timeLeft = 15;
      score = 0;
      tEl.textContent = String(timeLeft);
      sEl.textContent = String(score);
      moveBall();

      tickTimer = setInterval(()=>{
        timeLeft -= 1;
        tEl.textContent = String(Math.max(0, timeLeft));
        if (timeLeft <= 0){
          stopGame();
          if (score > best){
            best = score;
            localStorage.setItem(BEST_KEY, String(best));
            bEl.textContent = String(best);
          }
        }
      }, 1000);

      // keep it moving
      gameTimer = setInterval(()=>{
        if (timeLeft <= 0) return;
        moveBall();
      }, 650);
    }

    function moveBall(){
      const rect = arena.getBoundingClientRect();
      const size = 54;
      const pad = 8;
      const maxX = Math.max(pad, rect.width - size - pad);
      const maxY = Math.max(pad, rect.height - size - pad);
      const x = pad + Math.random() * (maxX - pad);
      const y = pad + Math.random() * (maxY - pad);
      ball.style.left = `${x}px`;
      ball.style.top = `${y}px`;
    }

    ball.addEventListener("click", ()=>{
      if (timeLeft <= 0) return;
      score += 1;
      sEl.textContent = String(score);
      moveBall();
    });

    closeBtn.addEventListener("click", close);
    modal.addEventListener("click", (ev)=>{
      if (ev.target === modal) close();
    });
    document.addEventListener("keydown", (ev)=>{
      if (ev.key === "Escape" && !modal.classList.contains("hidden")) close();
    });

    title.addEventListener("click", ()=>{
      clickCount += 1;
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(()=>{ clickCount = 0; }, 1200);
      if (clickCount >= 7){
        clickCount = 0;
        open();
      }
    });
  }

  function bindSidebar(){
    function syncControlsFromState(){
      if (hpFrac){
        hpFrac.value = String(Math.round(state.settings.defenderHpFrac * 100));
        hpFracLabel.textContent = `${hpFrac.value}%`;
      }
      if (atkStage) atkStage.value = String(state.settings.atkStage);
      if (spaStage) spaStage.value = String(state.settings.spaStage);
      if (enemyDefStage) enemyDefStage.value = String(state.settings.enemyDefStage);
      if (enemySpdStage) enemySpdStage.value = String(state.settings.enemySpdStage);
      if (speStage) speStage.value = String(state.settings.speStage);
      if (enemySpeStage) enemySpeStage.value = String(state.settings.enemySpeStage);
      if (autoMatch) autoMatch.checked = !!state.settings.autoMatch;
      if (defIV) defIV.value = String(state.settings.wildIV);
      if (defEV) defEV.value = String(state.settings.wildEV);
    }

    syncControlsFromState();

    if (hpFrac){
      hpFrac.addEventListener("input", ()=>{
        const v = Number(hpFrac.value);
        hpFracLabel.textContent = `${v}%`;
        state.settings.defenderHpFrac = v/100;
        saveState(); renderWaves(); refreshOverviewIfNeeded();
      });
    }
    if (atkStage){
      atkStage.addEventListener("change", ()=>{
        state.settings.atkStage = clampInt(atkStage.value, -6, 6);
        saveState(); renderWaves(); refreshOverviewIfNeeded();
      });
    }
    if (spaStage){
      spaStage.addEventListener("change", ()=>{
        state.settings.spaStage = clampInt(spaStage.value, -6, 6);
        saveState(); renderWaves(); refreshOverviewIfNeeded();
      });
    }
    if (enemyDefStage){
      enemyDefStage.addEventListener("change", ()=>{
        state.settings.enemyDefStage = clampInt(enemyDefStage.value, -6, 6);
        saveState(); renderWaves(); refreshOverviewIfNeeded();
      });
    }
    if (enemySpdStage){
      enemySpdStage.addEventListener("change", ()=>{
        state.settings.enemySpdStage = clampInt(enemySpdStage.value, -6, 6);
        saveState(); renderWaves(); refreshOverviewIfNeeded();
      });
    }
    if (speStage){
      speStage.addEventListener("change", ()=>{
        state.settings.speStage = clampInt(speStage.value, -6, 6);
        saveState(); renderWaves(); refreshOverviewIfNeeded();
      });
    }
    if (enemySpeStage){
      enemySpeStage.addEventListener("change", ()=>{
        state.settings.enemySpeStage = clampInt(enemySpeStage.value, -6, 6);
        saveState(); renderWaves(); refreshOverviewIfNeeded();
      });
    }
    if (autoMatch){
      autoMatch.addEventListener("change", ()=>{
        state.settings.autoMatch = !!autoMatch.checked;
        // when re-enabled, allow auto-pick again
        for (const wp of Object.values(state.wavePlans||{})) wp.manualOrder = false;
        saveState(); renderWaves();
      });
    }
    if (defIV){
      defIV.addEventListener("change", ()=>{
        state.settings.wildIV = clampInt(defIV.value, 0, 31);
        saveState(); renderWaves(); refreshOverviewIfNeeded();
      });
    }
    if (defEV){
      defEV.addEventListener("change", ()=>{
        state.settings.wildEV = clampInt(defEV.value, 0, 252);
        saveState(); renderWaves(); refreshOverviewIfNeeded();
      });
    }
  }

  function attachTabHandlers(){
    $$(".tab").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const t = btn.getAttribute("data-tab");
        state.ui.tab = t;
        saveState();
        renderTabs();
        refreshOverviewIfNeeded();
      });
    });
  }

  function renderAll(){
    renderTabs();
    renderWaves();
    renderRoster();
    renderBag();
    renderUnlocked();
    updateHeaderCounts();
    refreshOverviewIfNeeded();
  }

  function updateHeaderCounts(){
    if (!unlockedCountEl) return;
    const n = Object.keys(state.unlocked||{}).filter(k => !!state.unlocked[k]).length;
    unlockedCountEl.textContent = String(n);
  }

  function renderTabs(){
    $$(".tab").forEach(btn=>{
      btn.classList.toggle("active", btn.getAttribute("data-tab") === state.ui.tab);
    });
    tabWaves.classList.toggle("hidden", state.ui.tab !== "waves");
    tabRoster.classList.toggle("hidden", state.ui.tab !== "roster");
    tabBag.classList.toggle("hidden", state.ui.tab !== "bag");
    tabUnlocked.classList.toggle("hidden", state.ui.tab !== "unlocked");
  }

  // ---------------- Waves ----------------

  function waveOrderKey(wk){
    // wk like P2W10
    const m = /^P(\d+)W(\d+)$/.exec(wk);
    if (!m) return 999999;
    return (Number(m[1])*100) + Number(m[2]);
  }

  function renderWaves(){
    tabWaves.innerHTML = "";

    const waves = groupBy(data.calcSlots, s => s.waveKey);
    const waveKeys = Object.keys(waves).sort((a,b)=>waveOrderKey(a)-waveOrderKey(b));

    // render sections
    const sections = [
      {id:"P1", title:"Phase 1", phase:1, waves:[1,12], bossAfter:true},
      {id:"P2A", title:"Phase 2 — Part 1", phase:2, waves:[1,6], bossAfter:true},
      {id:"P2B", title:"Phase 2 — Part 2", phase:2, waves:[7,12], bossAfter:true},
      {id:"P3A", title:"Phase 3 — Part 1", phase:3, waves:[1,6], bossAfter:true},
      {id:"P3B", title:"Phase 3 — Part 2", phase:3, waves:[7,12], bossAfter:true},
    ];

    for (const sec of sections){
      const secEl = el("div", {}, [
        el("div", {class:"section-title"}, [
          el("div", {}, [
            el("div", {}, sec.title),
            el("div", {class:"section-sub"}, `Waves ${sec.waves[0]}–${sec.waves[1]}`)
          ])
        ])
      ]);
      tabWaves.appendChild(secEl);

      const inSec = waveKeys.filter(wk=>{
        const m = /^P(\d+)W(\d+)$/.exec(wk);
        if (!m) return false;
        const p = Number(m[1]); const w = Number(m[2]);
        return p===sec.phase && w>=sec.waves[0] && w<=sec.waves[1];
      });

      for (const wk of inSec){
        tabWaves.appendChild(renderWaveCard(wk, waves[wk]));
      }

      if (sec.bossAfter){
        tabWaves.appendChild(el("div", {class:"boss"}, [
          el("div", {}, [
            el("div", {class:"title"}, "NIAN BOSS"),
            el("div", {class:"hint"}, "Checkpoint — after this section")
          ]),
          el("div", {class:"pill warn"}, "prep / heal / items")
        ]));
      }
    }
  }

  
  function phaseDefenderLimit(phase){
    if (phase === 1) return 2;
    if (phase === 2) return 3;
    return 4;
  }

  function ensureWavePlan(waveKey, slots){
    state.wavePlans = state.wavePlans || {};
    const phase = Number(slots[0]?.phase || 1);
    const limit = phaseDefenderLimit(phase);

    let wp = state.wavePlans[waveKey];
    if (!wp){
      wp = state.wavePlans[waveKey] = {attackers:[], attackerStart:[], defenders:[], defenderStart:[]};
    }

    // ---- Defenders (selected from this wave) ----
    const slotByKey = new Map(slots.map(s=>[s.rowKey, s]));
    ensureWaveMods(wp);
    wp.defenders = (wp.defenders||[]).filter(rk => slotByKey.has(rk)).slice(0, limit);

    if (!wp.defenders.length){
      // default: first not-cleared defenders, else first defenders
      const prefer = slots.filter(s=>!state.cleared[s.rowKey]);
      const base = prefer.length ? prefer : slots;
      wp.defenders = base.slice(0, limit).map(s=>s.rowKey);
    }

    function normalizeOrder(order, starters){
      const s = (starters||[]).slice(0,2);
      if (s.length < 2) return s;
      const o = (order||[]).filter(x=>s.includes(x));
      if (o.length === 2) return o;
      if (o.length === 1) return [o[0], s.find(x=>x!==o[0])];
      return s;
    }

    // starter defenders always 2
    wp.defenderStart = (wp.defenderStart||[]).filter(rk => wp.defenders.includes(rk)).slice(0,2);
    if (wp.defenderStart.length < 2){
      wp.defenderStart = wp.defenders.slice(0,2);
    }
    // ordered matchup controls (left/right)
    wp.defenderOrder = normalizeOrder(wp.defenderOrder, wp.defenderStart);

    // ---- Attackers (selected from roster) ----
    const activeRoster = state.roster.filter(r=>r.active);
    const validIds = new Set(activeRoster.map(r=>r.id));
    wp.attackers = (wp.attackers||[]).filter(id=>validIds.has(id)).slice(0,16);

    if (wp.attackers.length < 2){
      wp.attackers = activeRoster.slice(0,2).map(r=>r.id);
    }

    // starter attackers always 2
    wp.attackerStart = (wp.attackerStart||[]).filter(id=>wp.attackers.includes(id)).slice(0,2);
    if (wp.attackerStart.length < 2){
      wp.attackerStart = wp.attackers.slice(0,2);
    }
    wp.attackerOrder = normalizeOrder(wp.attackerOrder, wp.attackerStart);

    // Per-wave per-mon battle modifiers (stages + HP%)
    wp.monMods = wp.monMods || {atk:{}, def:{}};
    wp.monMods.atk = wp.monMods.atk || {};
    wp.monMods.def = wp.monMods.def || {};

    // v13: auto-match favorable matchup (default) unless user manually overrides
    if (state.settings.autoMatch && !wp.manualOrder){
      try{
        const slotByKey2 = new Map(slots.map(s=>[s.rowKey, s]));
        autoPickOrdersForWave(wp, slotByKey2);
      }catch(e){ /* ignore */ }
    }

    state.wavePlans[waveKey] = wp;
    saveState();
    return wp;
  }

function ensureWaveMods(wp){
  wp.monMods = wp.monMods || {atk:{}, def:{}};
  wp.monMods.atk = wp.monMods.atk || {};
  wp.monMods.def = wp.monMods.def || {};
  return wp.monMods;
}

function settingsForWave(wp, attackerId, defenderRowKey){
  const mods = ensureWaveMods(wp);
  const am = (attackerId && mods.atk[attackerId]) ? mods.atk[attackerId] : {};
  const dm = (defenderRowKey && mods.def[defenderRowKey]) ? mods.def[defenderRowKey] : {};

  const hpPct = clampInt((dm.hpPct ?? 100), 1, 100);

  return {
    ...state.settings,

    // Attacker modifiers (per-mon)
    atkStage: clampInt((am.atkStage ?? 0), -6, 6),
    spaStage: clampInt((am.spaStage ?? 0), -6, 6),
    speStage: clampInt((am.speStage ?? 0), -6, 6),
    defStage: clampInt((am.defStage ?? 0), -6, 6),
    spdStage: clampInt((am.spdStage ?? 0), -6, 6),

    // Defender modifiers (per-mon)
    enemyDefStage: clampInt((dm.defStage ?? 0), -6, 6),
    enemySpdStage: clampInt((dm.spdStage ?? 0), -6, 6),
    enemySpeStage: clampInt((dm.speStage ?? 0), -6, 6),

    // (Not currently used by the damage engine, but stored for completeness / future rules)
    enemyAtkStage: clampInt((dm.atkStage ?? 0), -6, 6),
    enemySpaStage: clampInt((dm.spaStage ?? 0), -6, 6),

    defenderHpFrac: hpPct / 100
  };
}

// Defaults for per-mon modifiers
const WAVE_DEF_DEFAULT = {hpPct:100, atkStage:0, spaStage:0, defStage:0, spdStage:0, speStage:0};
const WAVE_ATK_DEFAULT = {hpPct:100, atkStage:0, spaStage:0, defStage:0, spdStage:0, speStage:0};

function getWaveDefMods(wp, rowKey){
  ensureWaveMods(wp);
  return {...WAVE_DEF_DEFAULT, ...((wp.monMods?.def && wp.monMods.def[rowKey]) || {})};
}

function getWaveAtkMods(wp, attackerId){
  ensureWaveMods(wp);
  return {...WAVE_ATK_DEFAULT, ...((wp.monMods?.atk && wp.monMods.atk[attackerId]) || {})};
}

// Approximate "enemy hits you" threat model so defender Atk/SpA + attacker Def/SpD stages matter.
// Assumptions: enemy uses a STAB move of its type, power 80, best category (physical/special) vs your bulk.
const ENEMY_ASSUMED_POWER = 80;

function assumedEnemyThreatForMatchup(wp, attackerRosterMon, defSlot){
  try{
    if (!attackerRosterMon || !defSlot) return null;
    const enemyDex = data.dex[defSlot.defender];
    const myDex = data.dex[attackerRosterMon.effectiveSpecies || attackerRosterMon.baseSpecies];
    if (!enemyDex || !myDex) return null;

    const dm = getWaveDefMods(wp, defSlot.rowKey);
    const am = getWaveAtkMods(wp, attackerRosterMon.id);

    const enemy = {
      species: defSlot.defender,
      level: defSlot.level,
      ivAll: state.settings.wildIV,
      evAll: state.settings.wildEV
    };
    const me = {
      species: attackerRosterMon.effectiveSpecies || attackerRosterMon.baseSpecies,
      level: state.settings.claimedLevel,
      ivAll: state.settings.claimedIV,
      evAll: attackerRosterMon.strength ? state.settings.strengthEV : state.settings.claimedEV
    };

    const hpFrac = clampInt((am.hpPct ?? 100), 1, 100) / 100;

    // Map wave mods into calc settings for the reverse calc (enemy attacks you).
    const s = {
      ...state.settings,
      defenderHpFrac: hpFrac,
      // enemy offense stages
      atkStage: clampInt(dm.atkStage ?? 0, -6, 6),
      spaStage: clampInt(dm.spaStage ?? 0, -6, 6),
      speStage: clampInt(dm.speStage ?? 0, -6, 6),
      // your bulk stages (as defender in this calc)
      enemyDefStage: clampInt(am.defStage ?? 0, -6, 6),
      enemySpdStage: clampInt(am.spdStage ?? 0, -6, 6),
      enemySpeStage: clampInt(am.speStage ?? 0, -6, 6),
      // don't apply intimidate/sturdy in this approximation
      applyINT: false,
      applySTU: false,
    };

    const types = Array.isArray(enemyDex.types) && enemyDex.types.length ? enemyDex.types : ["Normal"];
    const cats = ["Physical","Special"];

    let best = null;
    for (const type of types){
      for (const category of cats){
        const r = window.SHRINE_CALC.computeGenericDamageRange({
          data,
          attacker: enemy,
          defender: me,
          profile: {type, category, power: ENEMY_ASSUMED_POWER},
          settings: s,
          tags: []
        });
        if (!r || !r.ok) continue;
        if (!best) { best = r; continue; }
        const aOHKO = !!r.oneShot;
        const bOHKO = !!best.oneShot;
        if (aOHKO !== bOHKO) { if (aOHKO) best = r; continue; }
        if ((r.minPct ?? 0) > (best.minPct ?? 0)) best = r;
      }
    }

    if (!best) return null;

    const enemyFaster = (best.attackerSpe ?? 0) > (best.defenderSpe ?? 0);
    const tie = (best.attackerSpe ?? 0) === (best.defenderSpe ?? 0);
    const enemyActsFirst = enemyFaster || tie; // tie = risk
    const diesBeforeMove = enemyActsFirst && !!best.oneShot;

    return {
      ...best,
      enemyFaster,
      speedTie: tie,
      enemyActsFirst,
      diesBeforeMove,
      assumed: true
    };
  }catch(e){
    return null;
  }
}

function autoPickOrdersForWave(wp, slotByKey){
  const atkIds = (wp.attackerStart||[]).slice(0,2);
  const defKeys = (wp.defenderStart||[]).slice(0,2);
  if (atkIds.length < 2 || defKeys.length < 2) return;

  const atk0 = byId(state.roster, atkIds[0]);
  const atk1 = byId(state.roster, atkIds[1]);
  const def0 = slotByKey.get(defKeys[0]);
  const def1 = slotByKey.get(defKeys[1]);
  if (!atk0 || !atk1 || !def0 || !def1) return;

  const atkOrders = [[atk0.id, atk1.id],[atk1.id, atk0.id]];
  const defOrders = [[def0.rowKey, def1.rowKey],[def1.rowKey, def0.rowKey]];

  const allDefSlots = (wp.defenders||[]).map(k=>slotByKey.get(k)).filter(Boolean);

  const scorePlan = (atkOrder, defOrder)=>{
    const aL = byId(state.roster, atkOrder[0]);
    const aR = byId(state.roster, atkOrder[1]);
    const dL = slotByKey.get(defOrder[0]);
    const dR = slotByKey.get(defOrder[1]);
    if (!aL || !aR || !dL || !dR) return {score:-Infinity};

    const defLeft = {species:dL.defender, level:dL.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
    const defRight = {species:dR.defender, level:dR.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};

    const sL = settingsForWave(wp, aL.id, dL.rowKey);
    const sR = settingsForWave(wp, aR.id, dR.rowKey);

    const ordered = window.SHRINE_CALC.bestOrderedForPair({
      data,
      attackerLeft: aL,
      attackerRight: aR,
      defenderLeft: defLeft,
      defenderRight: defRight,
      settings: state.settings,
      settingsLeft: sL,
      settingsRight: sR,
      tagsLeft: dL.tags||[],
      tagsRight: dR.tags||[],
    });

    let ohko = 0;
    let prioSum = 0;
    let dmgSum = 0;
    let slowCount = 0;
    let deathCount = 0;
    for (const asg of ordered.assign){
      const best = asg.calc.best;
      if (best?.oneShot) ohko += 1;
      prioSum += (best?.prio ?? 0);
      dmgSum += (best?.minPct ?? 0);
      if (best?.slower) slowCount += 1;
    }

    // Apply attacker Def/SpD + defender Atk/SpA stages by approximating whether the enemy can OHKO you before you act.
    const thL = assumedEnemyThreatForMatchup(wp, aL, dL);
    const thR = assumedEnemyThreatForMatchup(wp, aR, dR);
    if (thL?.diesBeforeMove) deathCount += 1;
    if (thR?.diesBeforeMove) deathCount += 1;

    // starters-only coverage for full wave (3/4 defenders)
    let startersOhko = 0;
    for (const s of allDefSlots){
      const defObj = {species:s.defender, level:s.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
      const b0 = window.SHRINE_CALC.chooseBestMove({data, attacker:{species:(aL.effectiveSpecies||aL.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: aL.strength?state.settings.strengthEV:state.settings.claimedEV}, defender:defObj, movePool:aL.movePool||[], settings: settingsForWave(wp, aL.id, s.rowKey), tags: s.tags||[]}).best;
      const b1 = window.SHRINE_CALC.chooseBestMove({data, attacker:{species:(aR.effectiveSpecies||aR.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: aR.strength?state.settings.strengthEV:state.settings.claimedEV}, defender:defObj, movePool:aR.movePool||[], settings: settingsForWave(wp, aR.id, s.rowKey), tags: s.tags||[]}).best;
      if ((b0 && b0.oneShot) || (b1 && b1.oneShot)) startersOhko += 1;
    }

    // Score: maximize 2v2 OHKOs first, then prefer higher prio, then dmg,
    // and strongly prefer starters-only coverage for 3/4 defenders.
    // Deaths dominate: if you die before acting, the "OHKO" is effectively unusable.
    const score = (ohko*100000) + (startersOhko*5000) + - (prioSum*100) + dmgSum - (slowCount*50) - (deathCount*200000);
    return {score, ohko, startersOhko, prioSum, dmgSum, slowCount};
  };

  let best = null;
  for (const ao of atkOrders){
    for (const do_ of defOrders){
      const s = scorePlan(ao, do_);
      if (!best || s.score > best.score){
        best = {...s, atkOrder: ao, defOrder: do_};
      }
    }
  }

  if (best){
    wp.attackerOrder = best.atkOrder;
    wp.defenderOrder = best.defOrder;
  }
}

  function renderWavePlanner(waveKey, slots, wp){
    // Ensure evo-base cache is warm so claiming any evo form propagates across waves.
    prefetchBaseForSlots(slots);
    const phase = Number(slots[0]?.phase || 1);
    const defLimit = phaseDefenderLimit(phase);

    const slotByKey = new Map(slots.map(s=>[s.rowKey, s]));

    const selectedDef = new Set(wp.defenders||[]);
    const selectedAtk = new Set(wp.attackers||[]);
    const activeRoster = state.roster.filter(r=>r.active);

    function ensureOrder(cur, selSet){
      const arr = Array.from(selSet);
      let L = (cur && cur[0] && selSet.has(cur[0])) ? cur[0] : null;
      let R = (cur && cur[1] && selSet.has(cur[1])) ? cur[1] : null;
      if (!L) L = arr[0] || null;
      if (!R || R === L) R = arr.find(x=>x!==L) || null;
      if (!L || !R) return [];
      return [L, R];
    }

    function commit(){
      // Selection changed → re-enable auto-match ordering
      wp.manualOrder = false;
      wp.defenders = Array.from(selectedDef).slice(0, defLimit);
      wp.attackers = Array.from(selectedAtk).slice(0, 16);

      const defSel = new Set(wp.defenders);
      const atkSel = new Set(wp.attackers);

      wp.defenderOrder = ensureOrder(wp.defenderOrder, defSel);
      wp.attackerOrder = ensureOrder(wp.attackerOrder, atkSel);

      state.wavePlans[waveKey] = wp;
      saveState();
      renderWaves();
      refreshOverviewIfNeeded();
    }

// Save modifiers without changing selection
    function commitMods(){
      state.wavePlans[waveKey] = wp;
      saveState();
      renderWaves();
      refreshOverviewIfNeeded();
    }

    const stageVals = [-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6];

    function stageSel(cur, onSet){
      const sel = el("select", {}, stageVals.map(v=>el("option", {value:String(v), selected:Number(cur)===v}, (v>0?`+${v}`:String(v)))));
      sel.addEventListener("change", ()=>{ onSet(clampInt(sel.value, -6, 6)); commitMods(); });
      return sel;
    }

    function hpPctInput(cur, onSet){
      const inp = el("input", {type:"number", min:"1", max:"100", step:"1", value:String(clampInt(cur ?? 100, 1, 100))});
      inp.addEventListener("change", ()=>{ onSet(clampInt(inp.value, 1, 100)); commitMods(); });
      return inp;
    }

    function chip(label, control){
      return el("div", {class:"modchip"}, [el("span", {class:"lbl"}, label), control]);
    }

    const DEF_DEFAULT = {hpPct:100, atkStage:0, spaStage:0, defStage:0, spdStage:0, speStage:0};
    const ATK_DEFAULT = {hpPct:100, atkStage:0, spaStage:0, defStage:0, spdStage:0, speStage:0};

    function getDefMods(rowKey){
      return {...DEF_DEFAULT, ...(wp.monMods.def[rowKey]||{})};
    }
    function getAtkMods(id){
      return {...ATK_DEFAULT, ...(wp.monMods.atk[id]||{})};
    }
    function patchDefMods(rowKey, patch){
      wp.monMods.def[rowKey] = {...DEF_DEFAULT, ...(wp.monMods.def[rowKey]||{}), ...(patch||{})};
    }
    function patchAtkMods(id, patch){
      wp.monMods.atk[id] = {...ATK_DEFAULT, ...(wp.monMods.atk[id]||{}), ...(patch||{})};
    }

    function buildDefModRow(slotObj){
      const dm = getDefMods(slotObj.rowKey);
      return el("div", {class:"modrow"}, [
        chip("HP%", hpPctInput(dm.hpPct, (v)=> patchDefMods(slotObj.rowKey, {hpPct:v}))),
        chip("Atk", stageSel(dm.atkStage, (v)=> patchDefMods(slotObj.rowKey, {atkStage:v}))),
        chip("SpA", stageSel(dm.spaStage, (v)=> patchDefMods(slotObj.rowKey, {spaStage:v}))),
        chip("Def", stageSel(dm.defStage, (v)=> patchDefMods(slotObj.rowKey, {defStage:v}))),
        chip("SpD", stageSel(dm.spdStage, (v)=> patchDefMods(slotObj.rowKey, {spdStage:v}))),
        chip("Spe", stageSel(dm.speStage, (v)=> patchDefMods(slotObj.rowKey, {speStage:v}))),
      ]);
    }

    function buildAtkModRow(r){
      const am = getAtkMods(r.id);
      return el("div", {class:"modrow"}, [
        chip("HP%", hpPctInput(am.hpPct, (v)=> patchAtkMods(r.id, {hpPct:v}))),
        chip("Atk", stageSel(am.atkStage, (v)=> patchAtkMods(r.id, {atkStage:v}))),
        chip("SpA", stageSel(am.spaStage, (v)=> patchAtkMods(r.id, {spaStage:v}))),
        chip("Def", stageSel(am.defStage, (v)=> patchAtkMods(r.id, {defStage:v}))),
        chip("SpD", stageSel(am.spdStage, (v)=> patchAtkMods(r.id, {spdStage:v}))),
        chip("Spe", stageSel(am.speStage, (v)=> patchAtkMods(r.id, {speStage:v}))),
      ]);
    }

// ---------- Enemy picker ----------
    const enemyList = el("div", {class:"pick-grid"});
    const selectedCount = selectedDef.size;

    for (const s of slots){
      const checked = selectedDef.has(s.rowKey);
      const unlockedBase = baseOfSync(s.defender);
      const isUnlocked = !!state.unlocked[unlockedBase];
      const cb = el("input", {type:"checkbox", checked});
      if (!checked && selectedCount >= defLimit) cb.disabled = true;

      cb.addEventListener("change", ()=>{
        if (cb.checked) selectedDef.add(s.rowKey);
        else selectedDef.delete(s.rowKey);
        commit();
      });

      const claimChk = el("input", {type:"checkbox", checked: isUnlocked});
      claimChk.addEventListener("change", ()=>{
        const want = !!claimChk.checked;
        resolveBaseSpecies(s.defender).then((base)=>{
          if (want) state.unlocked[base] = true;
          else delete state.unlocked[base];
          saveState();
          renderWaves(); renderUnlocked(); renderRoster(); updateHeaderCounts();
        });
      });

      const sp = el("img", {class:"sprite sprite-sm", src:sprite(s.defender), alt:s.defender});
      sp.onerror = ()=> sp.style.opacity="0.25";
      sp.addEventListener("click", ()=> showOverviewForSlot(s));

      enemyList.appendChild(el("div", {class:"pick-item" + (isUnlocked ? " unlocked": "")}, [
        cb,
        sp,
        el("div", {class:"pick-meta"}, [
          el("div", {class:"pick-title"}, s.defender),
          el("div", {class:"pick-sub"}, `Lv ${s.level}` + ((s.tags||[]).length ? ` · ${s.tags.join(",")}` : "")),
          buildDefModRow(s),
        ]),
        el("label", {class:"check tiny"}, [claimChk, el("span", {}, "claimed")])
      ]));
    }

    // ---------- Attacker picker ----------
    const teamList = el("div", {class:"pick-grid"});
    const atkCount = selectedAtk.size;

    for (const r of activeRoster){
      const checked = selectedAtk.has(r.id);
      const cb = el("input", {type:"checkbox", checked});
      if (!checked && atkCount >= 16) cb.disabled = true;

      cb.addEventListener("change", ()=>{
        if (cb.checked) selectedAtk.add(r.id);
        else selectedAtk.delete(r.id);
        commit();
      });

      const eff = r.effectiveSpecies || r.baseSpecies;
      const sp = el("img", {class:"sprite sprite-sm", src:sprite(eff), alt:eff});
      sp.onerror = ()=> sp.style.opacity="0.25";

      teamList.appendChild(el("div", {class:"pick-item"}, [
        cb,
        sp,
        el("div", {class:"pick-meta"}, [
          el("div", {class:"pick-title"}, rosterLabel(r)),
          el("div", {class:"pick-sub"}, r.ability ? `Ability: ${r.ability}` : "Ability: —"),
          buildAtkModRow(r),
        ]),
      ]));
    }


    const teamButtons = el("div", {style:"display:flex; gap:8px; flex-wrap:wrap; margin:6px 0 8px"}, [
      (function(){
        const b = el("button", {class:"btn-mini"}, "Select all");
        b.addEventListener("click", ()=>{
          for (const r of activeRoster) selectedAtk.add(r.id);
          commit();
        });
        return b;
      })(),
      (function(){
        const b = el("button", {class:"btn-mini"}, "Clear");
        b.addEventListener("click", ()=>{
          selectedAtk.clear();
          commit();
        });
        return b;
      })(),
    ]);

    // Suggestions for lead pairs vs starter defenders
    const defStartSlots = (wp.defenderOrder||[]).map(k=>slotByKey.get(k)).filter(Boolean).slice(0,2);
    const suggEl = el("div", {class:"suggestions"});
    if (defStartSlots.length === 2){
      const allSelDefsForSugg = (wp.defenders||[]).map(k=>slotByKey.get(k)).filter(Boolean);
      const rosterSubset = (wp.attackers && wp.attackers.length) ? (wp.attackers.map(id=>byId(state.roster,id)).filter(Boolean)) : activeRoster;
      const leadSugg = computeLeadPairSuggestions(defStartSlots[0], defStartSlots[1], rosterSubset, allSelDefsForSugg, wp);
      const shown = leadSugg.filter(x=>x.covered);
      const listToShow = shown.length ? shown.slice(0,10) : leadSugg.slice(0,10);
      if (!shown.length){
        suggEl.appendChild(el("div", {class:"muted small"}, "No full OHKO lead pair found with current modifiers. Showing closest matches."));
      }
      for (const s of listToShow){
        const chip = el("div", {class:"chip"}, [
          el("strong", {}, s.label),
          ` · ${s.covered? "2/2":"—"}`,
          (s.clearTotal && s.clearTotal>2) ? ` · starters ${s.clearCount}/${s.clearTotal}` : "",
          ` · prio${s.avgPrio.toFixed(1)}`
        ]);
        chip.addEventListener("click", ()=>{
          // Set these as the two starters AND update the fight plan immediately.
          selectedAtk.add(s.ids[0]);
          selectedAtk.add(s.ids[1]);

          wp.attackers = Array.from(selectedAtk).slice(0,16);
          wp.attackerStart = [s.ids[0], s.ids[1]];
          wp.attackerOrder = [s.ids[0], s.ids[1]];

          commit();
        });
        suggEl.appendChild(chip);
      }
    } else {
      suggEl.appendChild(el("div", {class:"muted small"}, "Pick 2 starter defenders to get lead suggestions."));
    }

    // Plan for the current starters (2v2) — with explicit left/right order for both sides
    const planBox = el("div", {class:"planbox"});
        const atkOrderIds = (wp.attackerOrder && wp.attackerOrder.length===2) ? wp.attackerOrder : [];
    const defOrderKeys = (wp.defenderOrder && wp.defenderOrder.length===2) ? wp.defenderOrder : [];

    const atkStarters = atkOrderIds.map(id=>byId(state.roster,id)).filter(Boolean).slice(0,2);
    const defStarters = defOrderKeys.map(k=>slotByKey.get(k)).filter(Boolean).slice(0,2);

    function buildOrderControls(){
      const wrap = el("div", {class:"orderbar"});
      const row = (label, opts, cur, onSet) => {
        const leftSel = el("select", {class:"sel"}, opts.map(o=>el("option", {value:o.value, selected:o.value===cur[0]}, o.label)));
        const rightSel = el("select", {class:"sel"}, opts.map(o=>el("option", {value:o.value, selected:o.value===cur[1]}, o.label)));
        const swapBtn = el("button", {class:"btn-mini"}, "Swap");
        const commitOrder = ()=>{
          let L = leftSel.value;
          let R = rightSel.value;
          if (L === R){
            // enforce distinct by swapping
            const other = opts.map(x=>x.value).find(v=>v!==L);
            R = other || R;
            rightSel.value = R;
          }
          onSet([L,R]);
        };
        leftSel.addEventListener("change", commitOrder);
        rightSel.addEventListener("change", commitOrder);
        swapBtn.addEventListener("click", ()=>{
          const tmp = leftSel.value;
          leftSel.value = rightSel.value;
          rightSel.value = tmp;
          commitOrder();
        });
        return el("div", {class:"orderrow"}, [
          el("div", {class:"orderlabel"}, label),
          el("div", {class:"orderctrl"}, [
            el("span", {class:"muted small"}, "Left"),
            leftSel,
            el("span", {class:"muted small"}, "Right"),
            rightSel,
            swapBtn
          ])
        ]);
      };

      const atkOpts = (wp.attackers||[]).map(id=>{
        const r = byId(state.roster,id);
        const name = r ? rosterLabel(r) : String(id);
        return {value:id, label:name};
      });
      const defOpts = (wp.defenders||[]).map(k=>{
        const s = slotByKey.get(k);
        const name = s ? `${s.defender} (Lv ${s.level})` : String(k);
        return {value:k, label:name};
      });

      wrap.appendChild(row("Your starters (left/right)", atkOpts, wp.attackerOrder || atkOpts.slice(0,2).map(o=>o.value), (arr)=>{
        wp.attackerOrder = arr;
        wp.manualOrder = true;
        state.wavePlans[waveKey] = wp;
        saveState();
        renderWaves();
        refreshOverviewIfNeeded();
      }));
      wrap.appendChild(row("Enemy starters (left/right)", defOpts, wp.defenderOrder || defOpts.slice(0,2).map(o=>o.value), (arr)=>{
        wp.defenderOrder = arr;
        wp.manualOrder = true;
        state.wavePlans[waveKey] = wp;
        saveState();
        renderWaves();
        refreshOverviewIfNeeded();
      }));
      return wrap;
    }

    if (atkStarters.length === 2 && defStarters.length === 2){
      planBox.appendChild(el("div", {class:"panel-subtitle"}, "Fight plan (2v2 starters)"));
      planBox.appendChild(buildOrderControls());

      const defLeft = {species:defStarters[0].defender, level:defStarters[0].level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
      const defRight = {species:defStarters[1].defender, level:defStarters[1].level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};

      const res = window.SHRINE_CALC.bestOrderedForPair({
        data,
        attackerLeft: atkStarters[0],
        attackerRight: atkStarters[1],
        defenderLeft: defLeft,
        defenderRight: defRight,
        settings: state.settings,
        settingsLeft: settingsForWave(wp, atkStarters[0].id, defStarters[0].rowKey),
        settingsRight: settingsForWave(wp, atkStarters[1].id, defStarters[1].rowKey),
        tagsLeft: defStarters[0].tags||[],
        tagsRight: defStarters[1].tags||[],
      });

      for (let idx=0; idx<res.assign.length; idx++){
        const asg = res.assign[idx];
        const best = asg.calc.best;
        const atkSp = asg.attacker.effectiveSpecies || asg.attacker.baseSpecies;
        const slow = best?.slower;
        const defSlotObj = idx === 0 ? defStarters[0] : defStarters[1];
        const th = assumedEnemyThreatForMatchup(wp, asg.attacker, defSlotObj);
        const dies = !!th?.diesBeforeMove;
        planBox.appendChild(el("div", {style:"margin:6px 0"}, [
          pill(best && best.oneShot ? "OHKO":"no", best && best.oneShot ? "good":"bad"),
          slow ? " " : "",
          slow ? pill("SLOW", "warn") : "",
          dies ? " " : "",
          dies ? pill("DIES", "bad") : "",
          slow ? " " : " ",
          el("strong", {}, atkSp),
          " → ",
          el("span", {}, asg.vs.species),
          " · ",
          el("span", {}, best ? best.move : "—"),
          " ",
          el("span", {class:"muted small"}, best ? `(min ${formatPct(best.minPct)} · p${best.prio}${best.stab?" · STAB":""}${best.eff!=null?` · eff ${best.eff}`:""})` : "")
        ]));
      }
    } else {
      planBox.appendChild(el("div", {class:"muted"}, "Select defenders (2/3/4) and mark 2 starters (★). Select up to 4 of your mons and mark 2 starters (★)."));
    }


    // Starters-only check for 3/4-defender waves (prefer no switching)
    const allSelDefs = (wp.defenders||[]).map(k=>slotByKey.get(k)).filter(Boolean);
    if (atkStarters.length===2 && allSelDefs.length > 2){
      let startersOhko = 0;
      for (const s of allSelDefs){
        const defObj = {species:s.defender, level:s.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
        const b0 = window.SHRINE_CALC.chooseBestMove({data, attacker:{species:(atkStarters[0].effectiveSpecies||atkStarters[0].baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: atkStarters[0].strength?state.settings.strengthEV:state.settings.claimedEV}, defender:defObj, movePool:atkStarters[0].movePool||[], settings: settingsForWave(wp, atkStarters[0].id, s.rowKey), tags: s.tags||[]}).best;
        const b1 = window.SHRINE_CALC.chooseBestMove({data, attacker:{species:(atkStarters[1].effectiveSpecies||atkStarters[1].baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: atkStarters[1].strength?state.settings.strengthEV:state.settings.claimedEV}, defender:defObj, movePool:atkStarters[1].movePool||[], settings: settingsForWave(wp, atkStarters[1].id, s.rowKey), tags: s.tags||[]}).best;
        if ((b0 && b0.oneShot) || (b1 && b1.oneShot)) startersOhko += 1;
      }
      const total = allSelDefs.length;
      const ok = startersOhko === total;
      planBox.appendChild(el("div", {style:"margin-top:8px"}, [
        pill(`starters clear ${startersOhko}/${total}`, ok ? "good" : "warn"),
        !ok ? " " : "",
        !ok ? pill("SWITCH", "warn") : "",
        " ",
        el("span", {class:"muted small"}, ok ? "No switching expected (best case)." : "Switching likely needed (switch costs 1 full turn).")
      ]));
    }

    // Bench defenders (selected but not starters)
    const benchDefs = (wp.defenders||[]).filter(k=>!(wp.defenderOrder||[]).includes(k)).map(k=>slotByKey.get(k)).filter(Boolean);
    if (benchDefs.length){
      planBox.appendChild(el("div", {class:"panel-subtitle", style:"margin-top:10px"}, "Bench defenders (best from your selected team)"));
      const rosterSubset = (wp.attackers||[]).map(id=>byId(state.roster,id)).filter(Boolean);
      for (const s of benchDefs){
        const opts = bestOptionsForSlot(s, rosterSubset, wp);
        const best = opts.find(o=>o.best && o.best.oneShot) || null;
        planBox.appendChild(el("div", {style:"margin:6px 0"}, [
          el("span", {class:"muted"}, `${s.defender} (Lv ${s.level}) — `),
          best ? renderPlanLine(best, s, wp) : el("span",{class:"muted"},"No option")
        ]));
      }
    }

    return el("div", {class:"wave-planner"}, [
      el("div", {class:"planner-grid"}, [
        el("div", {class:"planner-col"}, [
          el("div", {class:"panel-subtitle"}, `Enemy selection (pick up to ${defLimit}${defLimit>2? ", choose 2 starters":""})`),
          enemyList,
        ]),
        el("div", {class:"planner-col"}, [
          el("div", {class:"panel-subtitle"}, "Your team (pick up to 16, choose 2 starters)"),
          teamButtons,
          teamList,
          el("div", {class:"panel-subtitle", style:"margin-top:10px"}, "Suggested lead pairs"),
          suggEl,
        ]),
      ]),
      planBox
    ]);
  }
  function computeLeadPairSuggestions(defSlotA, defSlotB, roster, allDefSlots, wp){
    const active = roster.filter(r=>r.active);
    const ids = active.map(r=>r.id);
    const pairs = [];
    for (let i=0;i<ids.length;i++){
      for (let j=i+1;j<ids.length;j++){
        pairs.push([ids[i], ids[j]]);
      }
    }
    const max = 400;
    const sample = pairs.length > max ? pairs.slice(0, max) : pairs;

    const defA = {species:defSlotA.defender, level:defSlotA.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
    const defB = {species:defSlotB.defender, level:defSlotB.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};

    const scoreAssign = (a, b, sA, sB, tA, tB)=>{
      const aAtk = {species:(a.effectiveSpecies||a.baseSpecies), level: sA.claimedLevel, ivAll: sA.claimedIV, evAll: a.strength?sA.strengthEV:sA.claimedEV};
      const bAtk = {species:(b.effectiveSpecies||b.baseSpecies), level: sB.claimedLevel, ivAll: sB.claimedIV, evAll: b.strength?sB.strengthEV:sB.claimedEV};

      const aRes = window.SHRINE_CALC.chooseBestMove({data, attacker:aAtk, defender:tA, movePool:a.movePool||[], settings:sA, tags: tA.tags||[]}).best;
      const bRes = window.SHRINE_CALC.chooseBestMove({data, attacker:bAtk, defender:tB, movePool:b.movePool||[], settings:sB, tags: tB.tags||[]}).best;

      const ohko = (aRes?.oneShot?1:0) + (bRes?.oneShot?1:0);
      const prioSum = (aRes?.prio ?? 2) + (bRes?.prio ?? 2);
      const dmgSum = (aRes?.minPct ?? 0) + (bRes?.minPct ?? 0);
      const maxPrio = Math.max((aRes?.prio ?? 2), (bRes?.prio ?? 2));
      const covered = ohko === 2;
      return {covered, ohko, prioSum, dmgSum, maxPrio, aRes, bRes};
    };

    const scored = [];
    for (const [idA,idB] of sample){
      const a = byId(state.roster,idA);
      const b = byId(state.roster,idB);
      if (!a || !b) continue;

      // Evaluate both assignments (since left/right can be swapped)
      const s_aA = settingsForWave(wp, a.id, defSlotA.rowKey);
      const s_bB = settingsForWave(wp, b.id, defSlotB.rowKey);
      const s_aB = settingsForWave(wp, a.id, defSlotB.rowKey);
      const s_bA = settingsForWave(wp, b.id, defSlotA.rowKey);

      // Attach tags into temporary defender objects for reuse
      const tDefA = {...defA, tags: defSlotA.tags||[]};
      const tDefB = {...defB, tags: defSlotB.tags||[]};

      const asg1 = scoreAssign(a,b,s_aA,s_bB,tDefA,tDefB); // a->A, b->B
      const asg2 = scoreAssign(a,b,s_aB,s_bA,tDefB,tDefA); // a->B, b->A

      const better = (x,y)=>{
        if (x.ohko !== y.ohko) return x.ohko > y.ohko;
        if (x.prioSum !== y.prioSum) return x.prioSum < y.prioSum;
        return x.dmgSum >= y.dmgSum;
      };
      const pick1 = better(asg1, asg2);
      const pick = pick1 ? asg1 : asg2;

      const covered = pick.covered;
      const avgPrio = pick.prioSum / 2;

      // Apply attacker Def/SpD + defender Atk/SpA stages: approximate whether each starter dies before acting.
      const mapA = pick1 ? defSlotA : defSlotB;
      const mapB = pick1 ? defSlotB : defSlotA;
      const thA = assumedEnemyThreatForMatchup(wp, a, mapA);
      const thB = assumedEnemyThreatForMatchup(wp, b, mapB);
      const deathCount = (thA?.diesBeforeMove ? 1 : 0) + (thB?.diesBeforeMove ? 1 : 0);

      // If this wave has 3/4 defenders selected, prefer pairs whose 2 starters can clear all of them (no switching).
      let clearCount = 0;
      let clearTotal = 0;
      if (Array.isArray(allDefSlots) && allDefSlots.length > 2){
        clearTotal = allDefSlots.length;
        for (const ds of allDefSlots){
          const defObj = {species:ds.defender, level:ds.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
          const b0 = window.SHRINE_CALC.chooseBestMove({data, attacker:{species:(a.effectiveSpecies||a.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: a.strength?state.settings.strengthEV:state.settings.claimedEV}, defender:defObj, movePool:a.movePool||[], settings: settingsForWave(wp, a.id, ds.rowKey), tags: ds.tags||[]}).best;
          const b1 = window.SHRINE_CALC.chooseBestMove({data, attacker:{species:(b.effectiveSpecies||b.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: b.strength?state.settings.strengthEV:state.settings.claimedEV}, defender:defObj, movePool:b.movePool||[], settings: settingsForWave(wp, b.id, ds.rowKey), tags: ds.tags||[]}).best;
          if ((b0 && b0.oneShot) || (b1 && b1.oneShot)) clearCount += 1;
        }
      }

      const clearsAll = clearTotal>0 && clearCount === clearTotal;

      scored.push({
        ids:[idA,idB],
        label:`${rosterLabel(a)} + ${rosterLabel(b)}`,
        covered,
        avgPrio,
        clearCount,
        clearTotal,
        clearsAll,
        score: (covered?100000:0) + (clearsAll?50000:0) + (clearCount*200) - (pick.prioSum*50) + pick.dmgSum - (deathCount*200000)
      });
    }

    scored.sort((x,y)=>y.score-x.score);
    return scored;
  }

function renderWaveCard(waveKey, slots){
    const expanded = !!state.ui.waveExpanded[waveKey];
    const first = slots[0];
    const title = `${waveKey} • ${first.animal} • Lv ${first.level}`;

    const btn = el("button", {class:"btn-mini"}, expanded ? "Collapse" : "Expand");
    btn.addEventListener("click", ()=>{
      state.ui.waveExpanded[waveKey] = !expanded;
      saveState();
      renderWaves();
    });

    const head = el("div", {class:"wave-head"}, [
      el("div", {class:"wave-left"}, [
        el("div", {}, [
          el("div", {class:"wave-title"}, title),
          el("div", {class:"wave-meta"}, `Phase ${first.phase} · Wave ${first.wave} · ${slots.length} defenders`)
        ])
      ]),
      el("div", {class:"wave-actions"}, [btn])
    ]);

    const body = el("div", {class:"wave-body " + (expanded ? "" : "hidden")});

    if (expanded){
      const wp = ensureWavePlan(waveKey, slots);
      body.appendChild(renderWavePlanner(waveKey, slots, wp));
    }

    return el("div", {class:"wave-card"}, [head, body]);
  }

  function renderTeamBar(waveKey, slots){
    const team = state.waveTeams[waveKey]?.team || [];
    const roster = state.roster.filter(r=>r.active);
    const rosterOpts = roster.map(r => ({
      id:r.id,
      label: rosterLabel(r),
      species: r.effectiveSpecies || r.baseSpecies
    }));

    function setTeamIds(ids){
      const t = (ids||[]).filter(Boolean).slice(0,2);
      state.waveTeams[waveKey] = {team: t};
      saveState();
      renderWaves();
    }

    const clearBtn = el("button", {class:"btn-mini"}, "Clear team");
    clearBtn.addEventListener("click", ()=>{
      state.waveTeams[waveKey] = {team:[]};
      saveState(); renderWaves();
    });

    // Checkbox picker (select exactly 2)
    const picker = el("div", {class:"team-picker"});
    const selectedSet = new Set(team);
    const maxed = selectedSet.size >= 2;

    for (const opt of rosterOpts){
      const checked = selectedSet.has(opt.id);
      const cb = el("input", {type:"checkbox", checked});
      if (maxed && !checked) cb.disabled = true;

      cb.addEventListener("change", ()=>{
        const now = new Set(state.waveTeams[waveKey]?.team || []);
        if (cb.checked){
          // add, enforce max 2
          if (now.size >= 2){
            // remove the oldest
            const arr = Array.from(now);
            now.delete(arr[0]);
          }
          now.add(opt.id);
        } else {
          now.delete(opt.id);
        }
        setTeamIds(Array.from(now));
      });

      picker.appendChild(el("label", {class:"team-item" + ((cb.disabled)?" disabled":"")}, [
        cb,
        el("img", {class:"sprite sprite-sm", src:sprite(opt.species), alt:opt.species, onerror:()=>{}}),
        el("span", {class:"name"}, opt.label)
      ]));
    }

    // Suggestions
    const sugg = computeTeamSuggestionsForWave(waveKey, slots, roster);
    const suggEl = el("div", {class:"suggestions"}, sugg.slice(0,10).map(s=>{
      const chip = el("div", {class:"chip"}, [
        el("strong", {}, s.label),
        ` · ${s.ohkoPairs}/${s.totalPairs} pairs`,
        ` · prio${s.avgPrio.toFixed(1)}`
      ]);
      chip.addEventListener("click", ()=>{
        state.waveTeams[waveKey] = {team:[s.ids[0], s.ids[1]]};
        saveState(); renderWaves();
      });
      return chip;
    }));

    return el("div", {class:"teambar"}, [
      el("div", {class:"label"}, "Wave team (2v2)"),
      el("div", {style:"display:flex; flex-wrap:wrap; gap:10px; align-items:center"}, [
        picker,
        clearBtn
      ]),
      el("div", {class:"label"}, "Suggested pairs"),
      suggEl
    ]);
  }

  function rosterLabel(r){
    const eff = r.effectiveSpecies || r.baseSpecies;
    if (eff !== r.baseSpecies) return `${eff} (${r.baseSpecies})`;
    return eff;
  }

  function pairGroups(slots){
    // Slots already include slot numbers; group by (slot-1)//2
    const groups = {};
    for (const s of slots){
      const idx = Math.floor((s.slot - 1)/2);
      (groups[idx] = groups[idx] || []).push(s);
    }
    return Object.keys(groups).map(k=>({idx:Number(k), slots: groups[k].sort((a,b)=>a.slot-b.slot)})).sort((a,b)=>a.idx-b.idx);
  }

  function renderWavePairsTable(waveKey, slots){
    const roster = state.roster.filter(r=>r.active);
    const teamIds = (state.waveTeams[waveKey]?.team || []).slice(0,2);
    const team = teamIds.map(id=>byId(state.roster, id)).filter(Boolean);

    const hideCleared = !!state.settings.hideCleared;

    const pairs = pairGroups(slots);

    const table = el("table", {class:"table"}, [
      el("thead", {}, el("tr", {}, [
        el("th", {}, "Pair"),
        el("th", {}, "Enemy A"),
        el("th", {}, "Enemy B"),
        el("th", {}, "Plan (your team)"),
        el("th", {}, "Progress")
      ])),
      el("tbody")
    ]);

    const tbody = table.querySelector("tbody");

    for (const p of pairs){
      const [a,b] = p.slots;
      const aCleared = a ? !!state.cleared[a.rowKey] : false;
      const bCleared = b ? !!state.cleared[b.rowKey] : false;
      if (hideCleared && aCleared && (!b || bCleared)) continue;

      const enemyCell = (slotObj)=>{
        if (!slotObj) return el("td", {}, "—");
        const defName = slotObj.defender;
        const tagTxt = (slotObj.tags||[]).join(", ");
        const sp = el("img", {class:"sprite", src:sprite(defName), alt:defName});
        sp.addEventListener("click", ()=> showOverviewForSlot(slotObj));
        sp.onerror = ()=> sp.style.opacity = "0.25";

        return el("td", {}, [
          el("div", {class:"row-left"}, [
            sp,
            el("div", {}, [
              el("div", {class:"row-title"}, defName),
              el("div", {class:"row-sub"}, `Lv ${slotObj.level}` + (tagTxt ? ` · ${tagTxt}` : ""))
            ])
          ])
        ]);
      };

      const planCell = ()=>{
        if (team.length !== 2){
          // no team picked → show best single option from roster per enemy
          const lines = [];
          for (const s of [a,b].filter(Boolean)){
            const opts = bestOptionsForSlot(s, roster);
            const best = opts.find(o=>o.best && o.best.oneShot) || null;
            lines.push(renderPlanLine(best, s));
          }
          return el("td", {}, lines);
        }
        const defA = a ? {species:a.defender, level:a.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV} : null;
        const defB = b ? {species:b.defender, level:b.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV} : null;

        const assignment = window.SHRINE_CALC.bestAssignmentForPair({
          data,
          team,
          defenderA: defA,
          defenderB: defB,
          settings: state.settings,
          tagsA: (a?.tags||[]),
          tagsB: (b?.tags||[])
        });

        const lines = assignment.assign.map(x=>{
          const best = x.calc.best;
          const atkSp = x.attacker.effectiveSpecies || x.attacker.baseSpecies;
          const line = el("div", {style:"margin-bottom:6px"}, [
            pill(best && best.oneShot ? "OHKO" : "no", best && best.oneShot ? "good":"bad"),
            " ",
            el("strong", {}, atkSp),
            " → ",
            el("span", {}, x.vs.species),
            " · ",
            el("span", {}, best ? `${best.move}` : "—"),
            " ",
            el("span", {class:"muted small"}, best ? `(min ${formatPct(best.minPct)} · prio ${best.prio}${best.stab? " · STAB":""}${best.eff!=null? ` · eff ${best.eff}`:""})` : "")
          ]);
          return line;
        });
        return el("td", {}, lines);
      };

      const progCell = ()=>{
        const wrap = el("div", {});
        for (const s of [a,b].filter(Boolean)){
          const chk = el("input", {type:"checkbox", checked: !!state.cleared[s.rowKey]});
          chk.addEventListener("change", ()=>{
            state.cleared[s.rowKey] = chk.checked ? true : undefined;
            if (chk.checked){
              // auto-unlock defender species
              state.unlocked[s.defender] = true;
            }
            saveState(); renderWaves(); renderUnlocked(); renderRoster(); updateHeaderCounts();
          });
          wrap.appendChild(el("label", {class:"check", style:"margin:0"}, [
            chk,
            el("span", {}, `cleared ${s.rowKey}`)
          ]));
        }
        return el("td", {}, wrap);
      };

      tbody.appendChild(el("tr", {}, [
        el("td", {}, `#${p.idx+1}`),
        enemyCell(a),
        enemyCell(b),
        planCell(),
        progCell()
      ]));
    }

    return table;
  }

  function bestOptionsForSlot(slotObj, roster, wp){
    const defKey = slotObj.rowKey;
    const def = {species: slotObj.defender, level: slotObj.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
    const options = [];

    for (const r of roster){
      if (!r.active) continue;
      const s = settingsForWave(wp, r.id, defKey);

      const attacker = {
        species: r.effectiveSpecies || r.baseSpecies,
        level: s.claimedLevel,
        ivAll: s.claimedIV,
        evAll: r.strength ? s.strengthEV : s.claimedEV
      };

      const pool = r.movePool || r.moves || [];
      const res = window.SHRINE_CALC.chooseBestMove({
        data,
        attacker,
        defender: def,
        movePool: pool,
        settings: s,
        tags: slotObj.tags || []
      });

      options.push({
        attackerId: r.id,
        attackerSpecies: attacker.species,
        baseSpecies: r.baseSpecies,
        best: res.best,
        all: res.all
      });
    }

    options.sort((a,b)=>{
      const ao = a.best?.oneShot ? 1 : 0;
      const bo = b.best?.oneShot ? 1 : 0;
      if (ao !== bo) return bo - ao;
      const ap = a.best?.prio ?? Infinity;
      const bp = b.best?.prio ?? Infinity;
      if (ap !== bp) return ap - bp;
      const am = a.best?.minPct ?? -Infinity;
      const bm = b.best?.minPct ?? -Infinity;
      if (am !== bm) return bm - am;
      return (a.attackerSpecies||'').localeCompare(b.attackerSpecies||'');
    });

    return options;
  }

  function renderPlanLine(bestOpt, slotObj, wp){
    if (!bestOpt){
      return el("div", {style:"margin-bottom:6px"}, [
        pill("no", "bad"),
        " ",
        el("span", {class:"muted"}, "No roster option")
      ]);
    }
    const b = bestOpt.best;
    const atkSp = bestOpt.attackerSpecies;
    let dies = false;
    if (wp && slotObj && bestOpt.attackerId){
      const r = byId(state.roster, bestOpt.attackerId);
      const th = assumedEnemyThreatForMatchup(wp, r, slotObj);
      dies = !!th?.diesBeforeMove;
    }
    return el("div", {style:"margin-bottom:6px"}, [
      pill(b.oneShot ? "OHKO":"no", b.oneShot ? "good":"bad"),
      dies ? " " : "",
      dies ? pill("DIES", "bad") : "",
      " ",
      el("strong", {}, atkSp),
      " · ",
      el("span", {}, b.move),
      " ",
      el("span", {class:"muted small"}, `(min ${formatPct(b.minPct)} · prio ${b.prio}${b.stab? " · STAB":""}${b.eff!=null? ` · eff ${b.eff}`:""})`)
    ]);
  }

  function computeTeamSuggestionsForWave(waveKey, slots, roster){
    const pairs = pairGroups(slots);
    const active = roster.filter(r=>r.active);
    const ids = active.map(r=>r.id);

    // limit combos if roster huge
    const combos = [];
    for (let i=0;i<ids.length;i++){
      for (let j=i+1;j<ids.length;j++){
        combos.push([ids[i], ids[j]]);
      }
    }
    const maxCombos = 220; // keep snappy
    const sample = combos.length > maxCombos ? combos.slice(0, maxCombos) : combos;

    const scored = sample.map(([idA,idB])=>{
      const a = byId(state.roster,idA);
      const b = byId(state.roster,idB);
      if (!a || !b) return null;

      let ohkoPairs = 0;
      let prioSum = 0;
      let prioCount = 0;

      for (const p of pairs){
        const [sa,sb] = p.slots;
        const defA = sa ? {species: sa.defender, level: sa.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV} : null;
        const defB = sb ? {species: sb.defender, level: sb.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV} : null;

        const res = window.SHRINE_CALC.bestAssignmentForPair({
          data,
          team:[a,b],
          defenderA:defA,
          defenderB:defB,
          settings: state.settings,
          tagsA: (sa?.tags||[]),
          tagsB: (sb?.tags||[])
        });

        // pair is "covered" if both enemies OHKO (or single enemy OHKO if solo pair)
        const assigns = res.assign;
        let covered = true;
        for (const asg of assigns){
          if (!asg.calc.best || !asg.calc.best.oneShot) covered = false;
          if (asg.calc.best){
            prioSum += (asg.calc.best.prio || 2);
            prioCount += 1;
          }
        }
        if (covered) ohkoPairs += 1;
      }

      const totalPairs = pairs.length;
      const avgPrio = prioCount ? (prioSum/prioCount) : 0;

      // overall score: maximize covered pairs, prefer higher avgPrio
      const score = (ohkoPairs*1000) - (avgPrio*10);

      return {
        ids:[idA,idB],
        label: `${rosterLabel(a)} + ${rosterLabel(b)}`,
        ohkoPairs,
        totalPairs,
        avgPrio,
        clearCount,
        clearTotal,
        score
      };
    }).filter(Boolean);

    scored.sort((x,y)=>y.score-x.score);
    return scored;
  }

  function showOverviewForSlot(slotObj){
    state.ui.attackOverview = {
      defender: slotObj.defender,
      level: slotObj.level,
      tags: slotObj.tags || [],
      source: slotObj.rowKey
    };
    saveState();
    renderOverview();
  }

  function refreshOverviewIfNeeded(){
    if (!state.ui.attackOverview) return;
    renderOverview();
  }

  function renderOverview(){
  const ov = state.ui.attackOverview;

  // Overview visibility rules:
  // - never show on Roster tab
  // - show battle plan only on Waves
  // - show static info only on Unlocked
  if (state.ui.tab === "roster"){
    overview.classList.add("hidden");
    return;
  }
  if (!ov){
    overview.classList.add("hidden");
    return;
  }

  const defName = ov.defender;

  // Unlocked: static info only
  if (ov.source === "unlocked"){
    if (state.ui.tab !== "unlocked"){
      overview.classList.add("hidden");
      return;
    }
    overview.classList.remove("hidden");
    ovSprite.src = sprite(defName);
    ovSprite.onerror = ()=> ovSprite.style.opacity = "0.25";

    const d = data.dex[defName];
    const types = d?.types?.join(" / ") || "—";
    const b = d?.base || {};
    ovTitle.textContent = defName;
    ovMeta.textContent = `Type: ${types}`;

    const set = data.claimedSets[defName] || null;

    const statsGrid = el("div", {class:"statgrid"}, [
      statCell("HP", b.hp),
      statCell("Atk", b.atk),
      statCell("Def", b.def),
      statCell("SpA", b.spa),
      statCell("SpD", b.spd),
      statCell("Spe", b.spe),
      statCell("BST", bstOf(defName)),
    ]);

    const abilityLine = el("div", {}, [
      el("div", {class:"muted small"}, "Ability"),
      el("div", {}, set?.ability ? set.ability : "—")
    ]);

    const movesLine = el("div", {}, [
      el("div", {class:"muted small"}, "Default moves"),
    ]);

    const mvList = el("div", {class:"mvlist"});
    const mvNames = (set?.moves || []).filter(Boolean);
    if (mvNames.length){
      for (const mn of mvNames){
        const mi = moveInfo(mn);
        mvList.appendChild(el("div", {class:"mvrow"}, [
          el("strong", {}, mn),
          el("span", {class:"muted small"}, mi ? ` · ${mi.type} · ${mi.category} · ${mi.power || "—"}` : "")
        ]));
      }
    } else {
      mvList.appendChild(el("div", {class:"muted"}, "No default moves listed for this species yet."));
    }
    movesLine.appendChild(mvList);

    ovBody.innerHTML = "";
    ovBody.appendChild(el("div", {class:"ov-static"}, [
      el("div", {class:"ov-col"}, [statsGrid]),
      el("div", {class:"ov-col"}, [abilityLine, el("div",{class:"hr"}), movesLine]),
    ]));
    return;
  }

  // Waves: battle overview only
  if (state.ui.tab !== "waves"){
    overview.classList.add("hidden");
    return;
  }

  overview.classList.remove("hidden");

  ovSprite.src = sprite(defName);
  ovSprite.onerror = ()=> ovSprite.style.opacity = "0.25";

  const defData = data.dex[defName];
  const types = defData?.types?.join(" / ") || "—";
  ovTitle.textContent = `${defName} (Lv ${ov.level})`;
  ovMeta.textContent = `Type: ${types}` + (ov.tags?.length ? ` · Tags: ${ov.tags.join(", ")}` : "");

  // Build results from roster
    const roster = state.roster.filter(r=>r.active);
    const defender = {species:defName, level: ov.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};

    const opts = window.SHRINE_CALC.bestFromRoster({
      data,
      roster,
      defender,
      settings: state.settings,
      tags: ov.tags || []
    });

    if (!opts.length){
      ovBody.innerHTML = "";
      ovBody.appendChild(el("div", {class:"muted"}, "No active roster options."));
      return;
    }

    const tbl = el("table", {class:"table"}, [
      el("thead", {}, el("tr", {}, [
        el("th", {}, "Attacker"),
        el("th", {}, "Best move (prio)"),
        el("th", {}, "Min %"),
        el("th", {}, "Notes")
      ])),
      el("tbody")
    ]);

    const tb = tbl.querySelector("tbody");

    for (const o of opts.slice(0, 30)){
      const atkSp = o.attackerSpecies;
      const spImg = el("img", {class:"sprite", src:sprite(atkSp), alt:atkSp});
      spImg.onerror = ()=> spImg.style.opacity = "0.25";
      const best = o.best;
      const oh = best.oneShot ? pill("OHKO","good") : pill("no","bad");
      const notes = [];
      notes.push(`eff ${best.eff}`);
      if (best.stab) notes.push("STAB");
      if (best.hh) notes.push("HH");
      if (ov.tags?.includes('STU') && state.settings.applySTU && state.settings.defenderHpFrac>=0.999) notes.push("STU check");

      // Also show the other candidate moves (top 3 by prio) as a small line
      const others = o.all
        .sort((a,b)=>(a.prio-b.prio)|| (b.minPct-a.minPct))
        .slice(0, Math.max(3, state.settings.movesPerMon))
        .map(x=>`${x.move} (p${x.prio} ${formatPct(x.minPct)}${x.oneShot?"*":""})`)
        .join(" · ");

      tb.appendChild(el("tr", {}, [
        el("td", {}, el("div", {class:"row-left"}, [
          spImg,
          el("div", {}, [
            el("div", {class:"row-title"}, atkSp),
            el("div", {class:"row-sub"}, o.baseSpecies !== atkSp ? `base: ${o.baseSpecies}` : "")
          ])
        ])),
        el("td", {}, [
          oh, " ",
          el("strong", {}, best.move),
          el("span", {class:"muted small"}, ` · prio ${best.prio}`)
        ]),
        el("td", {}, [
          el("div", {}, formatPct(best.minPct)),
          el("div", {class:"muted small"}, `max ${formatPct(best.maxPct)}`)
        ]),
        el("td", {}, [
          el("div", {class:"muted small"}, notes.join(" · ")),
          el("div", {class:"muted small"}, others)
        ])
      ]));
    }

    ovBody.innerHTML = "";
    ovBody.appendChild(tbl);
  }


  // ---------------- Bag ----------------

  function renderBag(){
    tabBag.innerHTML = "";

    const left = el("div", {class:"panel bag-col"}, [
      el("div", {class:"panel-title"}, "Bag"),
      el("div", {class:"muted small"}, "Add items you own (qty). These are available as held items in Roster details.")
    ]);

    const nameIn = el("input", {type:"text", placeholder:"Item name (e.g. Choice Band)"});
    const qtyIn = el("input", {type:"number", min:"0", step:"1", value:"1"});
    const addBtn = el("button", {class:"btn-mini"}, "Add / Update");

    addBtn.addEventListener("click", ()=>{
      const name = String(nameIn.value||"").trim();
      if (!name) return;
      const qty = clampInt(qtyIn.value, 0, 9999);
      if (qty <= 0){
        delete state.bag[name];
        // also unassign from roster
        for (const r of state.roster){ if (r.item === name) r.item = null; }
      } else {
        state.bag[name] = qty;
      }
      nameIn.value = "";
      qtyIn.value = "1";
      saveState();
      renderBag();
      renderRoster();
    });

    const form = el("div", {class:"bag-form"}, [
      el("div", {class:"field"}, [el("label", {}, "Item"), nameIn]),
      el("div", {class:"field"}, [el("label", {}, "Qty"), qtyIn]),
      addBtn
    ]);

    left.appendChild(form);

    const right = el("div", {class:"panel bag-col"}, [
      el("div", {class:"panel-title"}, "Inventory"),
    ]);

    const tbl = el("table", {class:"bag-table"}, [
      el("thead", {}, el("tr", {}, [
        el("th", {}, "Item"),
        el("th", {}, "Qty"),
        el("th", {}, "")
      ])),
      el("tbody")
    ]);

    const tbody = tbl.querySelector("tbody");
    const names = Object.keys(state.bag||{}).sort((a,b)=>a.localeCompare(b));
    if (!names.length){
      tbody.appendChild(el("tr", {}, [
        el("td", {colspan:"3", class:"muted"}, "No items yet.")
      ]));
    } else {
      for (const name of names){
        const qty = Number(state.bag[name]) || 0;
        const qtyEdit = el("input", {type:"number", min:"0", step:"1", value:String(qty), style:"width:90px"});
        qtyEdit.addEventListener("change", ()=>{
          const q = clampInt(qtyEdit.value, 0, 9999);
          if (q <= 0){
            delete state.bag[name];
            for (const r of state.roster){ if (r.item === name) r.item = null; }
          } else {
            state.bag[name] = q;
          }
          saveState();
          renderBag();
          renderRoster();
        });

        const delBtn = el("button", {class:"btn-mini"}, "Remove");
        delBtn.addEventListener("click", ()=>{
          delete state.bag[name];
          for (const r of state.roster){ if (r.item === name) r.item = null; }
          saveState();
          renderBag();
          renderRoster();
        });

        tbody.appendChild(el("tr", {}, [
          el("td", {}, name),
          el("td", {}, qtyEdit),
          el("td", {}, delBtn)
        ]));
      }
    }

    right.appendChild(tbl);

    tabBag.appendChild(el("div", {class:"bag-layout"}, [left, right]));
  }


  // ---------------- Roster ----------------

  function renderRoster(){
    tabRoster.innerHTML = "";

    const left = el("div", {class:"list"}, [
      el("div", {class:"list-head"}, [
        el("button", {class:"btn-mini", id:"btnAddRoster"}, "Add"),
        el("input", {id:"searchRoster", type:"text", placeholder:"Search roster…", value: state.ui.searchRoster || ""})
      ]),
      el("div", {class:"list-body", id:"rosterList"})
    ]);

    const right = el("div", {class:"panel"}, [
      el("div", {class:"panel-title"}, "Roster details"),
      el("div", {id:"rosterDetails", class:"muted"}, "Select a roster Pokémon.")
    ]);

    tabRoster.appendChild(el("div", {class:"roster-layout"}, [left, right]));

    // render list
    const listBody = $("#rosterList", tabRoster);
    const q = (state.ui.searchRoster || "").toLowerCase().trim();
    const roster = state.roster.slice().sort((a,b)=>rosterLabel(a).localeCompare(rosterLabel(b)));
    for (const r of roster){
      const label = rosterLabel(r);
      if (q && !label.toLowerCase().includes(q)) continue;

      const img = el("img", {class:"sprite", src:sprite(r.effectiveSpecies || r.baseSpecies), alt:label});
      img.onerror = ()=> img.style.opacity="0.25";

      const activeChk = el("input", {type:"checkbox", checked: !!r.active});
      activeChk.addEventListener("change", ()=>{
        r.active = activeChk.checked;
        saveState(); renderWaves(); refreshOverviewIfNeeded();
      });

      const rowEl = el("div", {class:"row"}, [
        el("div", {class:"row-left"}, [
          img,
          el("div", {}, [
            el("div", {class:"row-title"}, label),
            el("div", {class:"row-sub"}, r.ability ? `Ability: ${r.ability}` : "Ability: —")
          ])
        ]),
        el("div", {class:"row-right"}, [
          el("label", {class:"check", style:"margin:0"}, [activeChk, el("span", {}, "active")]),
          el("button", {class:"btn-mini"}, "Edit")
        ])
      ]);

      rowEl.querySelector("button").addEventListener("click", ()=>{
        state.ui.selectedRosterId = r.id;
        saveState();
        renderRoster(); // rerender (so selection highlight could be added later)
        renderRosterDetails(r, $("#rosterDetails", tabRoster));
      });

      listBody.appendChild(rowEl);
    }

    // selection
    const selected = byId(state.roster, state.ui.selectedRosterId);
    if (selected){
      renderRosterDetails(selected, $("#rosterDetails", tabRoster));
    }

    // handlers
    $("#searchRoster", tabRoster).addEventListener("input", (ev)=>{
      state.ui.searchRoster = ev.target.value;
      saveState();
      renderRoster();
    });

    $("#btnAddRoster", tabRoster).addEventListener("click", ()=> openAddRosterModal());
  }

  function renderRosterDetails(r, container){
    container.innerHTML = "";
    const eff = r.effectiveSpecies || r.baseSpecies;

    const spImg = el("img", {class:"sprite sprite-lg", src:sprite(eff), alt:eff});
    spImg.onerror = ()=> spImg.style.opacity="0.25";

    const title = el("div", {style:"display:flex; align-items:center; justify-content:space-between; gap:10px"}, [
      el("div", {style:"display:flex; align-items:center; gap:12px"}, [
        spImg,
        el("div", {}, [
          el("div", {class:"ov-title"}, rosterLabel(r)),
          el("div", {class:"muted small"}, `Ability: ${r.ability || "—"} · Moves: ${(r.movePool||[]).length}`)
        ])
      ]),
      el("div", {style:"display:flex; gap:8px"}, [
        el("button", {class:"btn-mini"}, "Remove")
      ])
    ]);

    title.querySelector("button").addEventListener("click", ()=>{
      if (!confirm(`Remove ${rosterLabel(r)} from roster?`)) return;
      state.roster = state.roster.filter(x=>x.id !== r.id);
      if (state.ui.selectedRosterId === r.id) state.ui.selectedRosterId = state.roster[0]?.id || null;
      saveState(); renderRoster(); renderWaves(); refreshOverviewIfNeeded();
    });

    
    const charms = el("div", {}, [
      el("div", {class:"panel-subtitle"}, "Charms"),
      ...(isStarterSpecies(r.baseSpecies) ? [
        el("div", {class:"muted small"}, "Starters: Strength is forced. Evo charm is unavailable.")
      ] : [
        el("label", {class:"check"}, [
          el("input", {type:"checkbox", checked: !!r.evo, "data-charm":"evo"}),
          el("span", {}, (()=> {
            const t = getEvoTarget(r.baseSpecies);
            return t ? `Evo (auto → ${t})` : "Evo (auto)";
          })())
        ]),
        ...(r.evo && !getEvoTarget(r.baseSpecies) ? [
          el("div", {class:"muted small"}, "Resolving evolution target… (first time may require internet)")
        ] : [])
      ]),
      el("label", {class:"check"}, [
        el("input", {type:"checkbox", checked: !!r.strength, disabled: isStarterSpecies(r.baseSpecies), "data-charm":"str"}),
        el("span", {}, isStarterSpecies(r.baseSpecies)
          ? `Strength (forced) — EVs=${state.settings.strengthEV} all`
          : `Strength (EVs=${state.settings.strengthEV} all)`)
      ])
    ]);

    const evoChk = charms.querySelector('input[data-charm="evo"]');
    const strChk = charms.querySelector('input[data-charm="str"]');

    if (evoChk){
      evoChk.addEventListener("change", ()=>{
        r.evo = evoChk.checked;
        applyCharmRules(r);
        saveState();
        renderRoster();
        renderWaves();
        refreshOverviewIfNeeded();
      });
    }

    strChk.addEventListener("change", ()=>{
      if (isStarterSpecies(r.baseSpecies)){
        r.strength = true;
      } else {
        r.strength = strChk.checked;
      }
      saveState();
      renderWaves();
      refreshOverviewIfNeeded();
    });


    // Move pool editor
    const mp = el("div", {}, [
      el("div", {class:"panel-subtitle"}, "Move pool (set priority + enable moves)"),
      el("div", {class:"muted small"}, "Priority: P1 is preferred (weak/filler), then P2. P3 is only used if P1/P2 can’t one-shot."),
      el("div", {id:"movePoolList"})
    ]);

    const mpList = $("#movePoolList", mp);
    renderMovePoolList(r, mpList);

    // Add TM move
    const addMove = el("div", {class:"field"}, [
      el("label", {}, "Add TM move"),
      el("div", {style:"display:flex; gap:8px"}, [
        buildMoveSelect(),
        el("button", {class:"btn-mini"}, "Add")
      ]),
      el("div", {class:"muted small"}, "Move data (type/power/category) is fixed from the sheet. You can only add or enable/disable moves.")
    ]);

    const moveSel = addMove.querySelector("select");
    addMove.querySelector("button").addEventListener("click", ()=>{
      const mv = moveSel.value;
      if (!mv) return;
      if ((r.movePool||[]).some(x=>x.name===mv)){
        alert("Already in move pool.");
        return;
      }
      // Default prio for newly added moves
      const species = r.effectiveSpecies || r.baseSpecies;
      const prio = defaultPrioForMove(species, mv);

      r.movePool.push({name: mv, prio, use: true, source:"tm"});
      saveState(); renderMovePoolList(r, mpList); renderWaves(); refreshOverviewIfNeeded();
    });

    function buildMoveSelect(){
      const damaging = Object.values(data.moves)
        .filter(m=>m && (m.category==="Physical"||m.category==="Special") && m.power)
        .map(m=>m.name)
        .sort((a,b)=>a.localeCompare(b));

      return el("select", {}, [
        el("option", {value:""}, "— choose a move —"),
        ...damaging.map(m=>el("option", {value:m}, m))
      ]);
    }

    container.appendChild(title);
    container.appendChild(el("div", {class:"hr"}));
    // Held item (tracking only)
    const itemSec = el("div", {}, [
      el("div", {class:"panel-subtitle"}, "Held item"),
      el("div", {class:"muted small"}, "Tracking only (no damage effects yet). Items come from your Bag tab."),
      (function(){
        const sel = el("select", {id:`heldItem_${r.id}`}, [
          el("option", {value:""}, "— none —"),
          ...Object.keys(state.bag||{}).sort((a,b)=>a.localeCompare(b)).map(n=>el("option", {value:n, selected:r.item===n}, `${n} (${state.bag[n]})`))
        ]);
        sel.addEventListener("change", ()=>{
          r.item = sel.value || null;
          saveState();
          renderRoster();
        });
        return el("div", {class:"field"}, [sel]);
      })()
    ]);

    container.appendChild(charms);
    container.appendChild(el("div", {class:"hr"}));
    container.appendChild(itemSec);
    container.appendChild(el("div", {class:"hr"}));
    container.appendChild(mp);
    container.appendChild(addMove);

  }

  function renderMovePoolList(r, container){
    container.innerHTML = "";
    const list = (r.movePool||[]).slice().sort((a,b)=>(Number(a.prio)-Number(b.prio))||a.name.localeCompare(b.name));
    for (const m of list){
      const mv = data.moves[m.name];
      const meta = mv ? `${mv.type} · ${mv.category} · ${mv.power}` : "—";
      const useChk = el("input", {type:"checkbox", checked: !!m.use});
      useChk.addEventListener("change", ()=>{
        m.use = useChk.checked;
        saveState(); renderWaves(); refreshOverviewIfNeeded();
      });

      const prioSel = el("select", {}, [1,2,3].map(p=>el("option",{value:String(p), selected:Number(m.prio)===p}, `prio ${p}`)));
      prioSel.addEventListener("change", ()=>{
        m.prio = Number(prioSel.value) || 2;
        saveState(); renderWaves(); refreshOverviewIfNeeded();
      });

      const rmBtn = el("button", {class:"btn-mini"}, "Remove");
      rmBtn.addEventListener("click", ()=>{
        // Base moves can be removed? We allow remove but warn.
        r.movePool = r.movePool.filter(x=>x.name !== m.name);
        saveState(); renderMovePoolList(r, container); renderWaves(); refreshOverviewIfNeeded();
      });

      container.appendChild(el("div", {class:"row"}, [
        el("div", {class:"row-left"}, [
          el("div", {}, [
            el("div", {class:"row-title"}, m.name),
            el("div", {class:"row-sub"}, meta + (m.source ? ` · ${m.source}` : ""))
          ])
        ]),
        el("div", {class:"row-right"}, [
          prioSel,
          el("label", {class:"check", style:"margin:0"}, [useChk, el("span", {}, "use")]),
          rmBtn
        ])
      ]));
    }
  }

  function openAddRosterModal(){
    const unlockedSpecies = Object.keys(state.unlocked).filter(k=>state.unlocked[k]).sort((a,b)=>a.localeCompare(b));
    const existing = new Set(state.roster.map(r=>r.baseSpecies));
    const candidates = unlockedSpecies.filter(s=>!existing.has(s) && data.claimedSets[s]);

    const overlay = el("div", {style:`
      position:fixed; inset:0; background: rgba(0,0,0,.55);
      display:flex; align-items:center; justify-content:center; z-index:1000;
    `});
    const modal = el("div", {class:"panel", style:"width:820px; max-width:95vw; max-height:85vh; overflow:hidden"}, [
      el("div", {style:"display:flex; align-items:center; justify-content:space-between; gap:10px"}, [
        el("div", {class:"panel-title"}, "Add to roster (from unlocked)"),
        el("button", {class:"btn-mini"}, "Close")
      ]),
      el("div", {class:"field"}, [
        el("label", {}, "Search"),
        el("input", {type:"text", id:"addSearch", placeholder:"Search species…"})
      ]),
      el("div", {class:"list", style:"max-height:60vh"}, [
        el("div", {class:"list-body", id:"addList", style:"max-height:60vh"})
      ]),
      el("div", {class:"muted small"}, "Only species that have a baseline set in your sheet (ClaimedSets) can be added right now.")
    ]);

    modal.querySelector("button").addEventListener("click", ()=> overlay.remove());
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const listBody = $("#addList", modal);
    const search = $("#addSearch", modal);

    function render(){
      listBody.innerHTML = "";
      const q = search.value.toLowerCase().trim();
      const rows = candidates.filter(s => !q || s.toLowerCase().includes(q));
      for (const s of rows){
        const img = el("img", {class:"sprite", src:sprite(s), alt:s});
        img.onerror = ()=> img.style.opacity="0.25";
        const btn = el("button", {class:"btn-mini"}, "Add");
        btn.addEventListener("click", ()=>{
          state.roster.push(makeRosterEntryFromClaimedSet(s));
          state.ui.selectedRosterId = state.roster[state.roster.length-1].id;
          saveState();
          overlay.remove();
          renderRoster(); renderWaves(); refreshOverviewIfNeeded();
        });
        listBody.appendChild(el("div", {class:"row"}, [
          el("div", {class:"row-left"}, [
            img,
            el("div", {}, [
              el("div", {class:"row-title"}, s),
              el("div", {class:"row-sub"}, `Ability: ${data.claimedSets[s]?.ability || "—"} · Moves: ${(data.claimedSets[s]?.moves||[]).join(", ")}`)
            ])
          ]),
          el("div", {class:"row-right"}, [btn])
        ]));
      }
      if (!rows.length){
        listBody.appendChild(el("div", {class:"row"}, el("div", {class:"muted"}, "No matches.")));
      }
    }
    search.addEventListener("input", render);
    render();
  }

  // ---------------- Unlocked ----------------

  function renderUnlocked(){
    tabUnlocked.innerHTML = "";

    const wrap = el("div", {class:"panel"}, [
      el("div", {class:"panel-title"}, "Pokédex"),
      el("div", {class:"muted small"}, "Shows whether a base species is unlocked (claiming is done from Waves). Click any entry for one-shot info."),
      el("div", {class:"field"}, [
        el("label", {}, "Search"),
        el("input", {type:"text", id:"searchUnlocked", placeholder:"Search…", value: state.ui.searchUnlocked || ""})
      ]),
      el("div", {class:"dex-grid", id:"dexGrid"})
    ]);

    tabUnlocked.appendChild(wrap);

    const grid = $("#dexGrid", wrap);
    const search = $("#searchUnlocked", wrap);

    const claimable = Object.keys(data.claimedSets || {}).sort((a,b)=>a.localeCompare(b));

    function renderGrid(){
      grid.innerHTML = "";
      const q = search.value.toLowerCase().trim();

      for (const s of claimable){
        if (q && !s.toLowerCase().includes(q)) continue;

        const unlocked = !!state.unlocked[s];
        const img = el("img", {class:"sprite dex-sprite", src:sprite(s), alt:s});
        img.onerror = ()=> img.style.opacity="0.25";

        const card = el("button", {type:"button", class:"dex-card " + (unlocked ? "unlocked" : "locked")}, [
          img,
          el("div", {class:"dex-meta"}, [
            el("div", {class:"dex-name"}, s),
            el("div", {class:"dex-status"}, unlocked ? "Unlocked" : "Locked"),
          ]),
          el("div", {style:"margin-left:auto"}, pill(unlocked ? "Unlocked" : "Locked", unlocked ? "good" : "bad"))
        ]);

        card.addEventListener("click", ()=>{
          state.ui.attackOverview = {defender:s, level:Number(state.settings.claimedLevel), tags:[], source:"unlocked"};
          saveState();
          renderOverview();
        });

        grid.appendChild(card);
      }
    }

    search.addEventListener("input", ()=>{
      state.ui.searchUnlocked = search.value;
      saveState();
      renderGrid();
    });

    renderGrid();
  }


  function levelsForDefender(species){
    const levels = [];
    for (const s of data.calcSlots){
      if (s.defender === species) levels.push(s.level);
    }
    return uniq(levels);
  }

  // ---------------- Utils ----------------

  function groupBy(arr, fn){
    const out = {};
    for (const x of arr){
      const k = fn(x);
      (out[k] = out[k] || []).push(x);
    }
    return out;
  }

  async function loadData(){
    const fetchJson = (p)=>fetch(p).then(r=>r.json());
    const [dex, moves, typing, rules, stages, calcSlots, claimedSets] = await Promise.all([
      fetchJson("data/dex.json"),
      fetchJson("data/moves.json"),
      fetchJson("data/typing.json"),
      fetchJson("data/rules.json"),
      fetchJson("data/stages.json"),
      fetchJson("data/calcSlots.json"),
      fetchJson("data/claimedSets.json"),
    ]);
    return {dex, moves, typing, rules, stages, calcSlots, claimedSets};
  }

})();
