// js/data/nameFixes.js
// alpha v1
// Name normalization helpers (species/moves/forms).

export const NAME_FIX = {
  "Snub +": "Snubbull",
  "Snubb +": "Snubbull",
  "Charm": "Charmeleon",
};

export function fixName(s){
  return NAME_FIX[s] || s;
}
