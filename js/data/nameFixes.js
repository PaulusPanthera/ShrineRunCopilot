// js/data/nameFixes.js
// alpha_v1_sim v1.0.0
// Project source file.

export const NAME_FIX = {
  "Snub +": "Snubbull",
  "Snubb +": "Snubbull",
  "Charm": "Charmeleon",
};

export function fixName(s){
  return NAME_FIX[s] || s;
}