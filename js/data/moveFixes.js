// js/data/moveFixes.js
// alpha v1
// Move data normalization and targeted fixes.

export const MOVE_FIX = {
  'Thunderbold': 'Thunderbolt',
  'Dragons Blessing': "Dragon's Blessing",
  'Dragon´s Blessing': "Dragon's Blessing",
  'Horses Protection': "Horse's Protection",
  'Serpents Fear': "Serpent's Fear",
  'U-Turn': 'U-turn',
  'U-TURN': 'U-turn',
  'Quick Quard': 'Quick Guard',
  'Proitective Aura': 'Protective Aura',
  'Flamethrowe': 'Flamethrower',
};

function capType(t){
  const s = String(t||'').trim().toLowerCase();
  if (!s) return '';
  return s[0].toUpperCase()+s.slice(1);
}

export function fixMoveName(name){
  if (!name) return name;
  let s = String(name).trim();
  if (!s) return s;
  // normalize apostrophes
  s = s.replace(/´|’/g, "'");
  if (MOVE_FIX[s]) return MOVE_FIX[s];

  // Hidden Power shorthand: "HP Rock" -> "Hidden Power (Rock)"
  const m1 = s.match(/^HP\s+([A-Za-z]+)$/i);
  if (m1){
    return `Hidden Power (${capType(m1[1])})`;
  }
  const m2 = s.match(/^Hidden\s*Power\s*\(?\s*([A-Za-z]+)\s*\)?$/i);
  if (m2 && !/\(/.test(s)){
    return `Hidden Power (${capType(m2[1])})`;
  }

  return s;
}
