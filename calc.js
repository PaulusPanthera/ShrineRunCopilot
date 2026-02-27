// calc.js
// alpha_v1_sim v1.0.13
// Damage calc core and helpers.

(function(){
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const isNum = (x) => typeof x === 'number' && !Number.isNaN(x) && Number.isFinite(x);

  function floor(n){ return Math.floor(n); }

  function statHP(base, level, iv, ev){
    const evq = floor(ev/4);
    return floor(((2*base + iv + evq) * level)/100) + level + 10;
  }
  function statOther(base, level, iv, ev){
    const evq = floor(ev/4);
    return floor(((2*base + iv + evq) * level)/100) + 5;
  }

  function getEffectiveness(chart, moveType, defTypes){
    if (!moveType) return 1;
    let mult = 1;
    for (const dt of defTypes){
      const row = chart[moveType];
      if (!row) continue;
      const v = row[dt];
      if (isNum(v)) mult *= v;
    }
    return mult;
  }

  function slugifyPokemonDb(name){
    const specials = {
      "Mr. Mime":"mr-mime",
      "Mime Jr.":"mime-jr",
      "Farfetch'd":"farfetchd",
      "Nidoran♀":"nidoran-f",
      "Nidoran♂":"nidoran-m",
      "Type: Null":"type-null",
      "Flabébé":"flabebe",
    };
    if (specials[name]) return specials[name];
    return name
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

  function spriteUrlPokemonDbBW(name){
    const slug = slugifyPokemonDb(name);
    return `https://img.pokemondb.net/sprites/black-white/anim/normal/${slug}.gif`;
  }

  // Static BW sprites (PNG). Intended for Pokédex grid / chips for performance.
  function spriteUrlPokemonDbBWStatic(name){
    const slug = slugifyPokemonDb(name);
    return `https://img.pokemondb.net/sprites/black-white/normal/${slug}.png`;
  }

  function stageMultiplier(stages, stage){
    const s = clamp(Number(stage)||0, -6, 6);
    return stages[String(s)] ?? stages[s] ?? 1;
  }

  // --- Items (small, opinionated set) ---
  // Items are passed through settings.attackerItem / settings.defenderItem.
  // This keeps calc deterministic without needing a full battle simulator.

  function itemSpeedMult(item){
    if (!item) return 1;
    if (item === 'Choice Scarf') return 1.5;
    return 1;
  }

  function itemOffenseMult(item, moveType, category, eff){
    if (!item) return 1;
    let m = 1;
    // Type boosts
    if (typeof item === 'string' && item.endsWith(' Plate')){
      const t = item.replace(/ Plate$/, '');
      if (t && t === moveType) m *= 1.2;
    }
    if (typeof item === 'string' && item.endsWith(' Gem')){
      const t = item.replace(/ Gem$/, '');
      if (t && t === moveType) m *= 1.3; // modeled as always-on for planning
    }

    // Category boosts
    if (item === 'Muscle Band' && category === 'Physical') m *= 1.1;
    if (item === 'Wise Glasses' && category === 'Special') m *= 1.1;
    if (item === 'Choice Band' && category === 'Physical') m *= 1.5;
    if (item === 'Choice Specs' && category === 'Special') m *= 1.5;
    if (item === 'Life Orb') m *= 1.3;
    if (item === 'Expert Belt' && (eff ?? 1) > 1) m *= 1.2;

    return m;
  }

  function applyDefensiveItemMult(item, category, D){
    if (!item) return D;
    if (item === 'Assault Vest' && category === 'Special'){
      return Math.max(1, Math.floor(D * 1.5));
    }
    return D;
  }

  
  // Weight-based base power moves (Gen 5 brackets; same as later gens).
  // Low Kick / Grass Knot: base power depends on the TARGET's weight.
  function weightBasedPowerKg(weightKg){
    const w = Number(weightKg);
    if (!isNum(w) || w <= 0) return null;
    if (w < 10) return 20;
    if (w < 25) return 40;
    if (w < 50) return 60;
    if (w < 100) return 80;
    if (w < 200) return 100;
    return 120;
  }

  function computeDamageRange({data, attacker, defender, moveName, settings, tags}){
    const {dex, moves, typing, rules, stages} = data;
    const mv = moves[moveName];
    const varPower = (moveName === 'Low Kick' || moveName === 'Grass Knot');
    if (!mv || !mv.type || !mv.category || (!varPower && (!isNum(mv.power) || mv.power <= 0))) {
      return {ok:false, reason:"non-damaging"};
    }
    const atkMon = dex[attacker.species];
    const defMon = dex[defender.species];
    if (!atkMon || !defMon) return {ok:false, reason:"missing species"};

    const abRaw = (settings && (settings.attackerAbility ?? settings.atkAbility)) ?? attacker.ability;
    const ab = String(abRaw || '').trim();
    const abLc = ab.toLowerCase();

    const L = attacker.level;
    const levelDef = defender.level;

    // EV/IV assumptions
    const atkIV = attacker.ivAll;
    const atkEV = attacker.evAll;
    const defIV = defender.ivAll;
    const defEV = defender.evAll;

    // Defender HP for percent calc
    const defHP = statHP(defMon.base.hp, levelDef, defIV, defEV);
    // Max HP scaling (HP% modifiers) is defenderHpFrac. Current remaining HP fraction is defenderCurHpFrac.
    // If defenderCurHpFrac is omitted, assume full HP.
    const hpScale = (settings.defenderHpFrac ?? 1);
    const curFrac = (settings.defenderCurHpFrac ?? 1);
    const maxHP = Math.max(1, Math.floor(defHP * hpScale));
    const curHP = Math.max(1, Math.floor(maxHP * curFrac));

    // Attacker offensive stat + stages
    const uses = (mv.uses || (mv.category === 'Physical' ? 'Atk' : 'SpA'));
    let atkStage = uses === 'Atk' ? (settings.atkStage ?? 0) : (settings.spaStage ?? 0);

    // INT tag: -1 Atk for physical
    if ((settings.applyINT ?? true) && uses === 'Atk' && tags.includes('INT')) {
      atkStage = atkStage - 1;
    }

    const A0 = (uses === 'Atk')
      ? statOther(atkMon.base.atk, L, atkIV, atkEV)
      : statOther(atkMon.base.spa, L, atkIV, atkEV);

    let A = Math.floor(A0 * stageMultiplier(stages, atkStage));
    // Ability offensive scaling (minimal set for shrine planning)
    if (uses === 'Atk' && (abLc === 'huge power' || abLc === 'pure power')) A = Math.floor(A * 2);

    // Defender defensive stat + stages
    // Most moves target the defensive stat implied by category, but some moves (e.g. Secret Sword)
    // use SpA offensively while targeting the foe's Defense.
    const defKey = (mv.targets === 'Def' || mv.targets === 'SpD')
      ? mv.targets
      : (mv.category === 'Special' ? 'SpD' : 'Def');

    const D0 = (defKey === 'SpD')
      ? statOther(defMon.base.spd, levelDef, defIV, defEV)
      : statOther(defMon.base.def, levelDef, defIV, defEV);

    const defStage = (defKey === 'SpD')
      ? (settings.enemySpdStage ?? 0)
      : (settings.enemyDefStage ?? 0);
    let D = Math.max(1, Math.floor(D0 * stageMultiplier(stages, defStage)));

    // Defensive item scaling should follow the targeted defensive stat (e.g. AV only affects SpD).
    const defCat = (defKey === 'SpD') ? 'Special' : 'Physical';
    D = applyDefensiveItemMult(settings.defenderItem, defCat, D);
    // Base damage (Gen5-ish rounding)
    let power = isNum(mv.power) ? mv.power : 0;
    if (varPower){
      const wKg = (settings && (settings.defenderWeightKg ?? (isNum(settings.defenderWeightHg) ? (settings.defenderWeightHg/10) : null))) ?? null;
      const wp = weightBasedPowerKg(wKg);
      if (wp) power = wp;
      else power = 60; // safe mid default when weight is unknown
    }
    // Multi-hit moves (deterministic): model as full hit count when known.
    // This affects planning + solver decisions without adding RNG.
    if (moveName === 'Bonemerang') power = power * 2;
    if (moveName === 'Dual Chop') power = power * 2;
    if (moveName === 'DoubleSlap') power = power * ((abLc === 'skill link') ? 5 : 2);
    // Acrobatics: double BP when attacker holds no item.
    if (moveName === 'Acrobatics' && !(settings.attackerItem)) power = power * 2;
    const base1 = Math.floor((2 * L) / 5) + 2;
    let dmg = Math.floor(Math.floor(Math.floor(base1 * power * A / D) / 50) + 2);

    // Modifiers
    const stab = (atkMon.types || []).includes(mv.type);
    const stabMult = stab ? rules.STAB : 1;

    const eff = getEffectiveness(typing.chart, mv.type, defMon.types || []);
    const hhMult = (tags.includes('HH') ? rules.HelpingHand_Mult : 1);

    const other = settings.otherMult ?? 1;

    // Ability multipliers (deterministic; assumes ability is active for planning).
    let abMult = 1;
    if (mv.category === 'Physical' && abLc === 'toxic boost') abMult *= 1.5;
    if (abLc === 'iron fist'){
      const punch = new Set(['Drain Punch','ThunderPunch','Fire Punch','Ice Punch','DynamicPunch','Bullet Punch','Mach Punch']);
      if (punch.has(moveName)) abMult *= 1.2;
    }
    if (abLc === 'reckless'){
      const reckless = new Set(['Brave Bird','Double-Edge','Head Smash','Jump Kick','High Jump Kick','Take Down','Wild Charge']);
      if (reckless.has(moveName)) abMult *= 1.2;
    }

    const itemMult = itemOffenseMult(settings.attackerItem, mv.type, mv.category, eff);
    const modifier = stabMult * eff * hhMult * other * itemMult * abMult;

    dmg = Math.floor(dmg * modifier);

    let min = Math.floor(dmg * rules.RandMin);
    let max = Math.floor(dmg * rules.RandMax);

    // STU: Sturdy blocks any KO from full HP by capping damage to leave 1 HP.
    // Applies whenever the defender is at full HP (curFrac ~= 1) and ANY roll could KO.
    if ((settings.applySTU ?? true) && tags.includes('STU') && curFrac >= 0.999 && max >= curHP) {
      const cap = Math.max(0, curHP - 1);
      min = Math.min(min, cap);
      max = Math.min(max, cap);
    }

    const minPct = (min / maxHP) * 100;
    const maxPct = (max / maxHP) * 100;

    let oneShot = min >= curHP;

    // Speed (for warnings / planning)
    const atkSpe0 = statOther(atkMon.base.spe, L, atkIV, atkEV);
    const defSpe0 = statOther(defMon.base.spe, levelDef, defIV, defEV);
    const atkSpe = Math.floor(atkSpe0 * stageMultiplier(stages, settings.speStage ?? 0) * itemSpeedMult(settings.attackerItem));
    const defSpe = Math.floor(defSpe0 * stageMultiplier(stages, settings.enemySpeStage ?? 0) * itemSpeedMult(settings.defenderItem));

    return {
      ok:true,
      move: moveName,
      moveType: mv.type,
      category: mv.category,
      uses,
      power,
      stab,
      eff,
      hh: tags.includes('HH'),
      min, max,
      minPct, maxPct,
      oneShot,
      defHP, targetHP: maxHP,
      attackerSpe: atkSpe,
      defenderSpe: defSpe,
      slower: atkSpe < defSpe
    };
  }

  // Generic damage using an assumed move profile (no moveName lookup).
  // Useful for approximate "enemy hit" checks when move pools are unknown.
  function computeGenericDamageRange({data, attacker, defender, profile, settings, tags}){
    const {dex, typing, rules, stages} = data;
    const p = profile || {};
    const moveType = p.type;
    const category = p.category; // 'Physical' | 'Special'
    const power = Number(p.power);
    if (!moveType || (category !== 'Physical' && category !== 'Special') || !isNum(power) || power <= 0) {
      return {ok:false, reason:"bad-profile"};
    }
    const atkMon = dex[attacker.species];
    const defMon = dex[defender.species];
    if (!atkMon || !defMon) return {ok:false, reason:"missing species"};

    const L = attacker.level;
    const levelDef = defender.level;

    const atkIV = attacker.ivAll;
    const atkEV = attacker.evAll;
    const defIV = defender.ivAll;
    const defEV = defender.evAll;

    const defHP = statHP(defMon.base.hp, levelDef, defIV, defEV);
    const hpScale = (settings.defenderHpFrac ?? 1);
    const curFrac = (settings.defenderCurHpFrac ?? 1);
    const maxHP = Math.max(1, Math.floor(defHP * hpScale));
    const curHP = Math.max(1, Math.floor(maxHP * curFrac));

    // Offense
    const uses = (category === 'Physical') ? 'Atk' : 'SpA';
    let atkStage = uses === 'Atk' ? (settings.atkStage ?? 0) : (settings.spaStage ?? 0);
    if ((settings.applyINT ?? true) && uses === 'Atk' && (tags||[]).includes('INT')) {
      atkStage = atkStage - 1;
    }

    const A0 = (uses === 'Atk')
      ? statOther(atkMon.base.atk, L, atkIV, atkEV)
      : statOther(atkMon.base.spa, L, atkIV, atkEV);
    const A = Math.floor(A0 * stageMultiplier(stages, atkStage));

    // Defense
    const isSpecial = (category === 'Special');
    const D0 = isSpecial
      ? statOther(defMon.base.spd, levelDef, defIV, defEV)
      : statOther(defMon.base.def, levelDef, defIV, defEV);

    const defStage = isSpecial ? (settings.enemySpdStage ?? 0) : (settings.enemyDefStage ?? 0);
    let D = Math.max(1, Math.floor(D0 * stageMultiplier(stages, defStage)));
    D = applyDefensiveItemMult(settings.defenderItem, category, D);

    // Base damage
    const base1 = Math.floor((2 * L) / 5) + 2;
    let dmg = Math.floor(Math.floor(Math.floor(base1 * power * A / D) / 50) + 2);

    const stab = (atkMon.types || []).includes(moveType);
    const stabMult = stab ? rules.STAB : 1;
    const eff = getEffectiveness(typing.chart, moveType, defMon.types || []);
    const hhMult = ((tags||[]).includes('HH') ? rules.HelpingHand_Mult : 1);
    const other = settings.otherMult ?? 1;
    const itemMult = itemOffenseMult(settings.attackerItem, moveType, category, eff);
    const modifier = stabMult * eff * hhMult * other * itemMult;
    dmg = Math.floor(dmg * modifier);

    let min = Math.floor(dmg * rules.RandMin);
    let max = Math.floor(dmg * rules.RandMax);

    if ((settings.applySTU ?? true) && (tags||[]).includes('STU') && curFrac >= 0.999 && max >= curHP) {
      const cap = Math.max(0, curHP - 1);
      min = Math.min(min, cap);
      max = Math.min(max, cap);
    }

    const minPct = (min / maxHP) * 100;
    const maxPct = (max / maxHP) * 100;

    let oneShot = min >= curHP;

    // Speed
    const atkSpe0 = statOther(atkMon.base.spe, L, atkIV, atkEV);
    const defSpe0 = statOther(defMon.base.spe, levelDef, defIV, defEV);
    const atkSpe = Math.floor(atkSpe0 * stageMultiplier(stages, settings.speStage ?? 0) * itemSpeedMult(settings.attackerItem));
    const defSpe = Math.floor(defSpe0 * stageMultiplier(stages, settings.enemySpeStage ?? 0) * itemSpeedMult(settings.defenderItem));

    return {
      ok:true,
      profile: {...p},
      moveType,
      category,
      uses,
      power,
      stab,
      eff,
      hh: (tags||[]).includes('HH'),
      min, max,
      minPct, maxPct,
      oneShot,
      defHP, targetHP: maxHP,
      attackerSpe: atkSpe,
      defenderSpe: defSpe,
      slower: atkSpe < defSpe
    };
  }

  function normPrio(p){
    const n = Number(p);
    // Default midpoint for the expanded 1..5 tier system.
    if (!Number.isFinite(n)) return 3;
    // clamp to 1..5
    return clamp(n, 1, 5);
  }

  function pickCandidateMoves(movePool){
    // movePool: [{name, prio, use}]
    const enabled = (movePool || []).filter(m => m && m.use && m.name);
    // Lower number means more preferred (P1 > P2 > P3)
    enabled.sort((a,b) => (normPrio(a.prio) - normPrio(b.prio)) || a.name.localeCompare(b.name));
    return enabled;
  }

  function chooseBestMove({data, attacker, defender, movePool, settings, tags}){
    const candidates = pickCandidateMoves(movePool);
    const all = [];

    for (const m of candidates){
      const r = computeDamageRange({
        data,
        attacker,
        defender,
        moveName: m.name,
        settings,
        tags
      });
      if (!r.ok) continue;
      const prio = normPrio(m.prio);
      const stabBonus = (r.stab ? (settings.stabBonus ?? 0) : 0);
      const score = r.minPct + stabBonus;
      all.push({...r, prio, score});
    }

    if (!all.length) return {best:null, all:[]};

    // Prefer: any OHKO at the lowest-priority tier first (P1 before P2 before P3).
    const oneShots = all.filter(x => x.oneShot);
    if (oneShots.length){
      const bestPrio = Math.min(...oneShots.map(x => x.prio));
      const pool = oneShots.filter(x => x.prio === bestPrio);

      // Within tier: conserve power (closest to 100% min), then STAB, then effectiveness, then highest min.
      pool.sort((a,b)=>{
        const da = Math.abs(a.minPct - 100);
        const db = Math.abs(b.minPct - 100);
        if ((settings.conservePower ?? true) && da !== db) return da - db;
        if (a.stab !== b.stab) return a.stab ? -1 : 1;
        if (a.eff !== b.eff) return b.eff - a.eff;
        if (a.minPct !== b.minPct) return b.minPct - a.minPct;
        return a.move.localeCompare(b.move);
      });

      return {best: pool[0], all};
    }

    // No OHKO → pick lowest prio tier, then best damage score.
    const bestPrio = Math.min(...all.map(x => x.prio));
    const pool = all.filter(x => x.prio === bestPrio);
    pool.sort((a,b)=> (b.score - a.score) || (b.minPct - a.minPct) || a.move.localeCompare(b.move));
    return {best: pool[0], all};
  }

  function bestFromRoster({data, roster, defender, settings, tags}){
    const options = [];
    for (const r of roster){
      if (!r.active) continue;
      const attacker = {
        species: r.effectiveSpecies || r.baseSpecies,
        level: settings.claimedLevel,
        ivAll: settings.claimedIV,
        evAll: r.strength ? settings.strengthEV : settings.claimedEV
      };

      const pool = r.movePool || r.moves || [];
      const res = chooseBestMove({
        data,
        attacker,
        defender,
        movePool: pool,
        settings,
        tags
      });

      options.push({
        attackerId: r.id,
        attackerSpecies: attacker.species,
        baseSpecies: r.baseSpecies,
        best: res.best,
        all: res.all
      });
    }

    // Rank: prefer OHKO, then lowest prio, then highest minPct.
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

  function bestAssignmentForPair({data, team, defenderA, defenderB, settings, tagsA, tagsB, settingsA, settingsB}){
    // Try both assignments.
    // Score: maximize OHKOs, then minimize sum of priorities, then maximize damage.

    const atk0 = (r)=>({
      species: r.effectiveSpecies||r.baseSpecies,
      level: settings.claimedLevel,
      ivAll: settings.claimedIV,
      evAll: r.strength?settings.strengthEV:settings.claimedEV
    });

    const sA = settingsA || settings;
    const sB = settingsB || settings;

    const calcA1 = chooseBestMove({data, attacker: atk0(team[0]), defender: defenderA, movePool: team[0].moves||team[0].movePool||[], settings: sA, tags: tagsA||[]});
    const calcA2 = defenderB ? chooseBestMove({data, attacker: atk0(team[0]), defender: defenderB, movePool: team[0].moves||team[0].movePool||[], settings: sB, tags: tagsB||[]}) : {best:null,all:[]};

    const calcB1 = chooseBestMove({data, attacker: atk0(team[1]), defender: defenderA, movePool: team[1].moves||team[1].movePool||[], settings: sA, tags: tagsA||[]});
    const calcB2 = defenderB ? chooseBestMove({data, attacker: atk0(team[1]), defender: defenderB, movePool: team[1].moves||team[1].movePool||[], settings: sB, tags: tagsB||[]}) : {best:null,all:[]};

    const assign1 = [
      {attackerId: team[0].id, defender: defenderA?.species, calc: calcA1},
      defenderB ? {attackerId: team[1].id, defender: defenderB?.species, calc: calcB2} : null
    ].filter(Boolean);

    const assign2 = [
      {attackerId: team[1].id, defender: defenderA?.species, calc: calcB1},
      defenderB ? {attackerId: team[0].id, defender: defenderB?.species, calc: calcA2} : null
    ].filter(Boolean);

    const scoreAssign = (arr)=>{
      let ohko = 0;
      let prioSum = 0;
      let dmgSum = 0;
      for (const x of arr){
        if (x.calc.best?.oneShot) ohko += 1;
        prioSum += (x.calc.best?.prio ?? 2);
        dmgSum += (x.calc.best?.minPct ?? 0);
      }
      return {ohko, prioSum, dmgSum};
    };

    const s1 = scoreAssign(assign1);
    const s2 = scoreAssign(assign2);

    const better = (a,b)=>{
      if (a.ohko !== b.ohko) return a.ohko > b.ohko;
      if (a.prioSum !== b.prioSum) return a.prioSum < b.prioSum; // lower better
      return a.dmgSum >= b.dmgSum;
    };

    const pick1 = better(s1,s2);
    return {
      assign: pick1 ? assign1 : assign2,
      meta: pick1 ? s1 : s2
    };
  }

  function bestOrderedForPair({data, attackerLeft, attackerRight, defenderLeft, defenderRight, settings, settingsLeft, settingsRight, tagsLeft, tagsRight}){
    const sL = settingsLeft || settings;
    const sR = settingsRight || settings;

    const atkL = {
      species: attackerLeft.effectiveSpecies || attackerLeft.baseSpecies,
      level: sL.claimedLevel,
      ivAll: sL.claimedIV,
      evAll: attackerLeft.strength ? sL.strengthEV : sL.claimedEV
    };
    const atkR = {
      species: attackerRight.effectiveSpecies || attackerRight.baseSpecies,
      level: sR.claimedLevel,
      ivAll: sR.claimedIV,
      evAll: attackerRight.strength ? sR.strengthEV : sR.claimedEV
    };

    const calcL = chooseBestMove({data, attacker: atkL, defender: defenderLeft, movePool: attackerLeft.movePool || attackerLeft.moves || [], settings: sL, tags: tagsLeft||[]});
    const calcR = chooseBestMove({data, attacker: atkR, defender: defenderRight, movePool: attackerRight.movePool || attackerRight.moves || [], settings: sR, tags: tagsRight||[]});

    return {
      assign: [
        {attacker: attackerLeft, vs: defenderLeft, calc: calcL},
        {attacker: attackerRight, vs: defenderRight, calc: calcR},
      ]
    };
  }

  window.SHRINE_CALC = {
    spriteUrlPokemonDbBW,
    spriteUrlPokemonDbBWStatic,
    computeDamageRange,
    computeGenericDamageRange,
    chooseBestMove,
    bestFromRoster,
    bestAssignmentForPair,
    bestOrderedForPair
  };
})();