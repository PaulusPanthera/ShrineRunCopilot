// js/data/claimedSetFixes.js
// alpha v1
// Surgical runtime fixes for pinned claimedSets (to prevent regressions from patch collisions).

export function applyClaimedSetFixes(claimedSets){
  if (!claimedSets || typeof claimedSets !== 'object') return;

  // Nidoqueen pinned set (tool canonical)
  // Correct: Sludge Bomb, Earth Power, Blizzard, Toxic
  if (claimedSets.Nidoqueen && typeof claimedSets.Nidoqueen === 'object'){
    claimedSets.Nidoqueen.moves = ['Sludge Bomb','Earth Power','Blizzard','Toxic'];
  }
}
