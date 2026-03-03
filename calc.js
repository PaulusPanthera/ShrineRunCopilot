// calc.js
// alpha v1
// Damage calc core and helpers.

(function(){
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const isNum = (x) => typeof x === 'number' && !Number.isNaN(x) && Number.isFinite(x);

// Moves with secondary effects boosted by Sheer Force (planning approximation).
const SHEER_FORCE_MOVES = new Set([
  'Body Slam','Waterfall','Ice Punch','Fire Punch','ThunderPunch','Crunch','Sludge Wave','Ice Beam',
  'Flamethrower','Thunderbolt','Discharge','Psychic','Air Slash','Rock Slide','Icy Wind','Muddy Water',
  'Zen Headbutt','Signal Beam','Shadow Ball','Scald','Dragon Rush','Extrasensory','Iron Tail','Poison Jab',
  'Sludge Bomb','Gunk Shot','Headbutt','Heat Wave'
]);


  function sheerForceEligible(moveName, data){
    const mv = data?.moves?.[String(moveName||'')];
    if (mv && typeof mv.sheerForce === 'boolean') return !!mv.sheerForce;
    if (mv && typeof mv.sf === 'boolean') return !!mv.sf;
    try{
      const meta = (typeof window !== 'undefined') ? (window.SHRINE_MOVE_META || window.__alphaMoveMeta || null) : null;
      const rec = meta ? meta[String(moveName||'')] : null;
      if (rec && typeof rec.sheerForce === 'boolean') return !!rec.sheerForce;
      if (rec && typeof rec.sf === 'boolean') return !!rec.sf;
    }catch(e){ /* ignore */ }
    // Fallback for offline / missing metadata.
    return SHEER_FORCE_MOVES.has(String(moveName||''));
  }


  function floor(n){ return Math.floor(n); }

  function damageRolls16(base, rules){
    const lo = Math.round((rules?.RandMin ?? 0.85) * 100);
    const hi = Math.round((rules?.RandMax ?? 1.00) * 100);
    // Gen-style rand factor is 16 discrete steps. Prefer integer bounds if they match 16 steps.
    let a=lo, b=hi;
    if ((b - a) !== 15){
      // fallback to standard 85..100
      a=85; b=100;
    }
    const out=[]
    for (let r=a; r<=b; r++){
      out.push(Math.floor(base * r / 100));
    }
    return out;
  }

  function ohkoChanceFromRolls(rolls, hp){
    if (!rolls || !rolls.length) return 0;
    let k=0;
    for (const d of rolls){
      if (d >= hp) k++;
    }
    return k / rolls.length;
  }


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

  function critStageFromItem(item){
    if (!item) return 0;
    if (item === 'Scope Lens') return 1;
    return 0;
  }

  function critChanceFromStage(stage){
    const s = clamp(Number(stage)||0, 0, 4);
    if (s <= 0) return 1/16;
    if (s === 1) return 1/8;
    if (s === 2) return 1/4;
    if (s === 3) return 1/3;
    return 1/2;
  }

  function itemOffenseMult(item, moveType, category, eff){
    if (!item) return 1;
    let m = 1;
    // Type boosts
    if (typeof item === 'string' && item.endsWith(' Plate')){
      const raw = item.replace(/ Plate$/, '');
      const plateToType = {Earth:'Ground', Meadow:'Grass', Fist:'Fighting', Toxic:'Poison', Dark:'Dark'};
      const t = plateToType[raw] || raw;
      if (t && t === moveType) m *= 1.2;
    }
    if (typeof item === 'string' && item.endsWith(' Gem')){
      const t = item.replace(/ Gem$/, '');
      // Planner uses the same magnitude as the battle sim (×1.5) to avoid preview drift.
      // (Still modeled as always-on here for speed; battle sim consumes Gems per battle.)
      if (t && t === moveType) m *= 1.5;
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

  function applyDefensiveItemMult(item, category, D, settings){
    if (!item) return D;
    if (item === 'Assault Vest' && category === 'Special'){
      return Math.max(1, Math.floor(D * 1.5));
    }
    if (item === 'Eviolite' && (settings?.defenderCanEvolve === true)){
      // Eviolite boosts both Def and SpD by 1.5× for Pokémon that can still evolve.
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

// Variable-power base power moves
function returnPower(settings){
  const bp = Number(settings?.assumedReturnBp);
  if (Number.isFinite(bp) && bp > 0) return bp;
  return 102; // default max friendship planning
}

// Reversal base power depends on the USER's current HP fraction.
// Brackets (Gen 5): <=4.17%:200, <=10.42%:150, <=20.83%:100, <=35.42%:80, <=68.75%:40, else 20
function reversalPowerFromHpFrac(hpFrac){
  const f = Number(hpFrac);
  const x = (Number.isFinite(f) ? f : 1);
  if (x <= (1/24)) return 200;
  if (x <= (5/48)) return 150;
  if (x <= (1/4.8)) return 100; // 0.20833
  if (x <= (17/48)) return 80;
  if (x <= (33/48)) return 40;
  return 20;
}

function reversalPower(settings){
  const bp = Number(settings?.assumedReversalBp);
  if (Number.isFinite(bp) && bp > 0) return bp;
  const cur = settings?.attackerCurHpFrac ?? settings?.attackerHpFrac ?? 1;
  return reversalPowerFromHpFrac(cur);
}

function weatherFromAbilityLc(abLc){
  const a = String(abLc||'').trim().toLowerCase();
  if (a === 'drizzle') return 'rain';
  if (a === 'drought') return 'sun';
  if (a === 'sand stream') return 'sand';
  if (a === 'snow warning') return 'hail';
  return null;
}

  function computeDamageRange({data, attacker, defender, moveName, settings, tags}){
    const {dex, moves, typing, rules, stages} = data;
    const mv = moves[moveName];
    const isWeightVarPower = (moveName === 'Low Kick' || moveName === 'Grass Knot');
    const isReturn = (moveName === 'Return');
    const isReversal = (moveName === 'Reversal');
    const isVarPower = (isWeightVarPower || isReturn || isReversal);
    if (!mv || !mv.type || !mv.category || (!isVarPower && (!isNum(mv.power) || mv.power <= 0))) {
      return {ok:false, reason:"non-damaging"};
    }
    const atkMon = dex[attacker.species];
    const defMon = dex[defender.species];
    if (!atkMon || !defMon) return {ok:false, reason:"missing species"};

    const abRaw = (settings && (settings.attackerAbility ?? settings.atkAbility)) ?? attacker.ability;
    const ab = String(abRaw || '').trim();
    const abLc = ab.toLowerCase();

    // Defender ability is often omitted in planner paths; fall back to the pinned ability
    // from claimed sets (locked shrine sets) to keep immunity previews consistent.
    let defAbRaw = (settings && (settings.defenderAbility ?? settings.defAbility)) ?? defender.ability;
    if (!defAbRaw){
      const pinned = data?.claimedSets?.[defender.species]?.ability;
      if (pinned) defAbRaw = pinned;
    }
    const defAb = String(defAbRaw || '').trim();
    const defAbLc = defAb.toLowerCase();
    const weather = String(settings?.weather || weatherFromAbilityLc(abLc) || weatherFromAbilityLc(defAbLc) || '').trim().toLowerCase() || null;


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

    // INT: Intimidate effects are modeled by the caller by adjusting atkStage/spaStage in settings.
    let A0 = (uses === 'Atk')
      ? statOther(atkMon.base.atk, L, atkIV, atkEV)
      : statOther(atkMon.base.spa, L, atkIV, atkEV);

    // Item-specific stat doublers
    const atkItem = settings?.attackerItem || null;
    if (atkItem === 'Light Ball' && String(attacker.species||'') === 'Pikachu'){
      A0 = Math.floor(A0 * 2);
    }
    if (atkItem === 'Thick Club' && uses === 'Atk'){
      const sp = String(attacker.species||'');
      if (sp === 'Cubone' || sp === 'Marowak') A0 = Math.floor(A0 * 2);
    }

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
    D = applyDefensiveItemMult(settings.defenderItem, defCat, D, settings);
// Base damage (Gen5-ish rounding)
let moveType = mv.type;

// Base power per hit (before multi-hit scaling)
let powerPerHit = isNum(mv.power) ? mv.power : 0;

if (isWeightVarPower){
  const wKg = (settings && (settings.defenderWeightKg ?? (isNum(settings.defenderWeightHg) ? (settings.defenderWeightHg/10) : null))) ?? null;
  const wp = weightBasedPowerKg(wKg);
  powerPerHit = wp ? wp : 60; // safe mid default when weight is unknown
} else if (isReturn){
  powerPerHit = returnPower(settings);
} else if (isReversal){
  powerPerHit = reversalPower(settings);
}

// Weather Ball: type changes + power doubles in weather (Gen 5)
if (moveName === 'Weather Ball' && weather){
  if (weather === 'rain'){ moveType = 'Water'; powerPerHit = 100; }
  else if (weather === 'sun'){ moveType = 'Fire'; powerPerHit = 100; }
  else if (weather === 'sand'){ moveType = 'Rock'; powerPerHit = 100; }
  else if (weather === 'hail'){ moveType = 'Ice'; powerPerHit = 100; }
}

// Acrobatics: double BP when attacker holds no item.
if (moveName === 'Acrobatics' && !(settings.attackerItem)) powerPerHit = powerPerHit * 2;

// Multi-hit moves (deterministic): model as fixed hit count when known.
// NOTE: For STU (Sturdy) at full HP, deterministic multi-hit moves can break STU on later hits.
// We therefore skip the STU "leave 1 HP" cap for deterministic multi-hit moves.
// This keeps fight-plan + solver decisions consistent with the intended "Bonemerang beats STU" rule.
const hitCount = (()=>{
  const atkItem2 = settings?.attackerItem || null;
  const hasSkillLink = (abLc === 'skill link');
  const hasLoadedDice = (atkItem2 === 'Loaded Dice');
  if (moveName === 'Bonemerang') return 2;
  if (moveName === 'Dual Chop') return 2;
  if (moveName === 'DoubleSlap') return hasSkillLink ? 5 : (hasLoadedDice ? 4 : 2);
  if (moveName === 'Tail Slap') return hasSkillLink ? 5 : (hasLoadedDice ? 4 : 2);
  if (moveName === 'Bullet Seed') return hasSkillLink ? 5 : (hasLoadedDice ? 4 : 2);
  return 1;
})();

let power = powerPerHit * hitCount;
    const base1 = Math.floor((2 * L) / 5) + 2;
    let dmg = Math.floor(Math.floor(Math.floor(base1 * power * A / D) / 50) + 2);

    // Modifiers
    const stab = (atkMon.types || []).includes(moveType);
    const stabMult = stab ? ((abLc === 'adaptability') ? 2.0 : rules.STAB) : 1;


    // Defender ability modifiers (minimal shrine set): immunities + Thick Fat.
    // Only applied when the caller provides settings.defenderAbility (incoming threat model).
    let defAbTypeMult = 1;
    if (defAbLc === 'levitate' && moveType === 'Ground') defAbTypeMult = 0;
    if ((defAbLc === 'lightning rod' || defAbLc === 'motor drive' || defAbLc === 'volt absorb') && moveType === 'Electric') defAbTypeMult = 0;
    if (defAbLc === 'flash fire' && moveType === 'Fire') defAbTypeMult = 0;
    if ((defAbLc === 'water absorb' || defAbLc === 'storm drain' || defAbLc === 'dry skin') && moveType === 'Water') defAbTypeMult = 0;
    if (defAbLc === 'sap sipper' && moveType === 'Grass') defAbTypeMult = 0;
    if (defAbLc === 'thick fat' && (moveType === 'Fire' || moveType === 'Ice')) defAbTypeMult *= 0.5;

    const effBase = getEffectiveness(typing.chart, moveType, defMon.types || []);
    const eff = effBase * defAbTypeMult;
    // Helping Hand should only apply when explicitly modeled as a buff on the attacker.
    // NOTE: 'HH' is also used as a tag meaning the Pokémon *has* Helping Hand in its moveset.
    // Do NOT auto-apply the multiplier based on defender tags.
    const hhActive = !!(settings && settings.helpingHandActive);
    const hhMult = (hhActive ? rules.HelpingHand_Mult : 1);

const other = settings.otherMult ?? 1;

let weatherMult = 1;
if (weather === 'rain'){
  if (moveType === 'Water') weatherMult *= 1.5;
  if (moveType === 'Fire') weatherMult *= 0.5;
} else if (weather === 'sun'){
  if (moveType === 'Fire') weatherMult *= 1.5;
  if (moveType === 'Water') weatherMult *= 0.5;
}

    // Ability multipliers (deterministic; assumes ability is active for planning).
    let abMult = 1;
    if (abLc === 'technician' && Number(powerPerHit) <= 60) abMult *= 1.5;
    if (abLc === 'sheer force' && sheerForceEligible(moveName, data)) abMult *= 1.3;
    if (mv.category === 'Physical' && abLc === 'toxic boost') abMult *= 1.5;
    if (abLc === 'iron fist'){
      const punch = new Set(['Drain Punch','ThunderPunch','Fire Punch','Ice Punch','DynamicPunch','Bullet Punch','Mach Punch']);
      if (punch.has(moveName)) abMult *= 1.2;
    }
    if (abLc === 'reckless'){
      const reckless = new Set(['Brave Bird','Double-Edge','Head Smash','Jump Kick','High Jump Kick','Take Down','Wild Charge']);
      if (reckless.has(moveName)) abMult *= 1.2;
    }

    const itemMult = itemOffenseMult(settings.attackerItem, moveType, mv.category, eff);
    // Optional explicit power multiplier (used by the battle engine for consumables like Gems).
    // Must default to 1 so planner behavior stays unchanged.
    const powerMult = Number(settings?.powerMult ?? settings?.gemMult ?? 1) || 1;
    const modifier = stabMult * eff * hhMult * other * weatherMult * itemMult * abMult * powerMult;

    dmg = Math.floor(dmg * modifier);

    let min = Math.floor(dmg * rules.RandMin);
    let max = Math.floor(dmg * rules.RandMax);

    // STU: Sturdy blocks any KO from full HP by capping damage to leave 1 HP.
    // Applies whenever the defender is at full HP (curFrac ~= 1) and ANY roll could KO.
    // Discrete 16-roll distribution (Gen-style). Useful for risk view / OHKO chance.
    const rolls = damageRolls16(dmg, rules);
    // Apply STU cap to each roll if needed (skip for deterministic multi-hit)
    const isMultiHitDet = (hitCount > 1);
    if (!isMultiHitDet && (settings.applySTU ?? true) && tags.includes('STU') && curFrac >= 0.999){
      const cap = Math.max(0, curHP - 1);
      for (let i=0;i<rolls.length;i++){
        if (rolls[i] >= curHP) rolls[i] = Math.min(rolls[i], cap);
      }
    }

    // Focus Sash: from full HP, prevent a KO once by leaving 1 HP (like STU),
    // but deterministic multi-hit moves can break it (so skip when hitCount>1).
    if (!isMultiHitDet && String(settings?.defenderItem||'') === 'Focus Sash' && curFrac >= 0.999){
      const cap = Math.max(0, curHP - 1);
      for (let i=0;i<rolls.length;i++){
        if (rolls[i] >= curHP) rolls[i] = Math.min(rolls[i], cap);
      }
    }

    // Keep returned min/max/minPct/maxPct consistent with the roll distribution,
    // especially when STU is active (rolls are capped but raw min/max are not).
    // For non-STU cases, this is a no-op.
    min = Math.min(...rolls);
    max = Math.max(...rolls);
// Crit (optional)
const calcCrit = !!(settings && settings.calcCrit);
const critStageBase = Number(settings?.critStage ?? 0) || 0;
const critStageItem = critStageFromItem(settings?.attackerItem || null);
const critStage = clamp(critStageBase + critStageItem, 0, 4);
const critChance = critChanceFromStage(critStage);
let critMult = Number(settings?.critMult ?? 1.5);
if (abLc === 'sniper') critMult *= 1.5;
let critMin = null, critMax = null, critRolls = null;
if (calcCrit && Number.isFinite(critMult) && critMult > 1){
  // Crit ignores attacker negative stages and defender positive stages (Gen5-style).
  const atkStageCrit = Math.max(0, atkStage);
  const defStageCrit = Math.min(0, defStage);
  let Acrit = Math.floor(A0 * stageMultiplier(stages, atkStageCrit));
  if (uses === 'Atk' && (abLc === 'huge power' || abLc === 'pure power')) Acrit = Math.floor(Acrit * 2);
  let Dcrit = Math.max(1, Math.floor(D0 * stageMultiplier(stages, defStageCrit)));
  Dcrit = applyDefensiveItemMult(settings.defenderItem, defCat, Dcrit, settings);
  let dmgCrit = Math.floor(Math.floor(Math.floor(base1 * power * Acrit / Dcrit) / 50) + 2);
  dmgCrit = Math.floor(dmgCrit * modifier);
  dmgCrit = Math.floor(dmgCrit * critMult);
  critRolls = damageRolls16(dmgCrit, rules);
  // STU cap for crit rolls (skip for deterministic multi-hit)
  if (!isMultiHitDet && (settings.applySTU ?? true) && tags.includes('STU') && curFrac >= 0.999){
    const cap = Math.max(0, curHP - 1);
    for (let i=0;i<critRolls.length;i++){
      if (critRolls[i] >= curHP) critRolls[i] = Math.min(critRolls[i], cap);
    }
  }

  if (!isMultiHitDet && String(settings?.defenderItem||'') === 'Focus Sash' && curFrac >= 0.999){
    const cap = Math.max(0, curHP - 1);
    for (let i=0;i<critRolls.length;i++){
      if (critRolls[i] >= curHP) critRolls[i] = Math.min(critRolls[i], cap);
    }
  }
  critMin = Math.min(...critRolls);
  critMax = Math.max(...critRolls);
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
      moveType: moveType,
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
      slower: atkSpe < defSpe,

      // Roll distributions (16 steps)
      rolls,
      ohkoChanceRoll: ohkoChanceFromRolls(rolls, curHP),
      critMin,
      critMax,
      critMinPct: (critMin!=null) ? (critMin / maxHP) * 100 : null,
      critMaxPct: (critMax!=null) ? (critMax / maxHP) * 100 : null,
      critRolls,
      ohkoChanceCrit: (critRolls ? ohkoChanceFromRolls(critRolls, curHP) : 0),
      critStage,
      critChance,
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

    // Defender ability is often omitted in threat model/planner paths; fall back to pinned ability.
    let defAbRaw = (settings && (settings.defenderAbility ?? settings.defAbility)) ?? defender.ability;
    if (!defAbRaw){
      const pinned = data?.claimedSets?.[defender.species]?.ability;
      if (pinned) defAbRaw = pinned;
    }
    const defAbLc = String(defAbRaw || '').trim().toLowerCase();
    const abRaw = (settings && (settings.attackerAbility ?? settings.atkAbility)) ?? attacker.ability;
    const abLc = String(abRaw || '').trim().toLowerCase();
    const weather = String(settings?.weather || weatherFromAbilityLc(abLc) || weatherFromAbilityLc(defAbLc) || '').trim().toLowerCase() || null;


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

    // INT: Intimidate effects are modeled by the caller by adjusting atkStage/spaStage in settings.

    const A0 = (uses === 'Atk')
      ? statOther(atkMon.base.atk, L, atkIV, atkEV)
      : statOther(atkMon.base.spa, L, atkIV, atkEV);
    let A = Math.floor(A0 * stageMultiplier(stages, atkStage));
    if (uses === 'Atk' && (abLc === 'huge power' || abLc === 'pure power')) A = Math.floor(A * 2);

    // Defense
    const isSpecial = (category === 'Special');
    const D0 = isSpecial
      ? statOther(defMon.base.spd, levelDef, defIV, defEV)
      : statOther(defMon.base.def, levelDef, defIV, defEV);

    const defStage = isSpecial ? (settings.enemySpdStage ?? 0) : (settings.enemyDefStage ?? 0);
    let D = Math.max(1, Math.floor(D0 * stageMultiplier(stages, defStage)));
    D = applyDefensiveItemMult(settings.defenderItem, category, D, settings);

    // Base damage
    const base1 = Math.floor((2 * L) / 5) + 2;
    let dmg = Math.floor(Math.floor(Math.floor(base1 * power * A / D) / 50) + 2);

    const stab = (atkMon.types || []).includes(moveType);
    const stabMult = stab ? ((abLc === 'adaptability') ? 2.0 : rules.STAB) : 1;

    // Defender ability modifiers (minimal shrine set): immunities + Thick Fat.
    let defAbTypeMult = 1;
    if (defAbLc === 'levitate' && moveType === 'Ground') defAbTypeMult = 0;
    if ((defAbLc === 'lightning rod' || defAbLc === 'motor drive' || defAbLc === 'volt absorb') && moveType === 'Electric') defAbTypeMult = 0;
    if (defAbLc === 'flash fire' && moveType === 'Fire') defAbTypeMult = 0;
    if ((defAbLc === 'water absorb' || defAbLc === 'storm drain' || defAbLc === 'dry skin') && moveType === 'Water') defAbTypeMult = 0;
    if (defAbLc === 'sap sipper' && moveType === 'Grass') defAbTypeMult = 0;
    if (defAbLc === 'thick fat' && (moveType === 'Fire' || moveType === 'Ice')) defAbTypeMult *= 0.5;

    const effBase = getEffectiveness(typing.chart, moveType, defMon.types || []);
    const eff = effBase * defAbTypeMult;
    // Helping Hand multiplier is opt-in (see computeDamageRange).
    const hhActive = !!(settings && settings.helpingHandActive);
    const hhMult = (hhActive ? rules.HelpingHand_Mult : 1);
    const other = settings.otherMult ?? 1;

    let weatherMult = 1;
    if (weather === 'rain'){
      if (moveType === 'Water') weatherMult *= 1.5;
      if (moveType === 'Fire') weatherMult *= 0.5;
    } else if (weather === 'sun'){
      if (moveType === 'Fire') weatherMult *= 1.5;
      if (moveType === 'Water') weatherMult *= 0.5;
    }

    let abMult = 1;
    if (abLc === 'technician' && Number(power) <= 60) abMult *= 1.5;

    const itemMult = itemOffenseMult(settings.attackerItem, moveType, category, eff);
    // Optional explicit power multiplier (used by the battle engine for consumables like Gems).
    const powerMult = Number(settings?.powerMult ?? settings?.gemMult ?? 1) || 1;
    const modifier = stabMult * eff * hhMult * other * weatherMult * itemMult * abMult * powerMult;
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
