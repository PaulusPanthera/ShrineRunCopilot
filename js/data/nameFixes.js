// js/data/nameFixes.js
// v13 — name normalization for sheet quirks

export const NAME_FIX = {
  "Snub +": "Snubbull",
  "Snubb +": "Snubbull",
  "Charm": "Charmeleon",
};

export function fixName(s){
  return NAME_FIX[s] || s;
}
