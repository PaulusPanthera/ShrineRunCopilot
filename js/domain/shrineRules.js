// js/domain/shrineRules.js
// alpha v1
// Run rules/constants for shrine planning.

export function defaultNatureForSpecies(species){
  const s = String(species || '').trim();
  // Special case: Politoed side-boss is always Modest (user-confirmed).
  if (s === 'Politoed') return 'Modest';
  if (s === 'Keldeo') return 'Modest';
  if (s === 'Cobalion' || s === 'Terrakion' || s === 'Virizion') return 'Adamant';
  return 'Bashful';
}

const MOVESET_OVERRIDES = {
  // Replace a single move within the default 4.
  Serperior: {
    replace: {
      'Twister': 'Dragon Pulse',
    },
  },
  Charizard: {
    replace: {
      'HP Fly': 'Air Slash',
      'HP Flying': 'Air Slash',
      'Hidden Power Fly': 'Air Slash',
      'Hidden Power Flying': 'Air Slash',
      'Hidden Power (Flying)': 'Air Slash',
    },
  },

  // Fully specified 4-move sets (rare cases).
  Simipour: { set: ['Acrobatics', 'Water Pledge', 'Hidden Power (Ground)', 'Ice Beam'] },
  Hoppip: { set: ['Acrobatics', 'Leaf Storm', 'Stun Spore', 'Mending Prayer'] },
  // Nidoking: only Thunderbolt specified so far — do NOT invent the other 3.
};

function normKey(s){
  return String(s || '').trim().toLowerCase();
}

export function applyMovesetOverrides(species, moves){
  if (!species || !Array.isArray(moves)) return moves;
  const ov = MOVESET_OVERRIDES[String(species).trim()];
  if (!ov) return moves;

  if (ov.set && Array.isArray(ov.set) && ov.set.length){
    return ov.set.slice(0, 4);
  }

  const base = moves.slice(0, 4);
  if (!ov.replace) return base;

  const repl = {};
  for (const [k, v] of Object.entries(ov.replace)) repl[normKey(k)] = v;
  return base.map(m => repl[normKey(m)] || m);
}
