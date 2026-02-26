// js/services/storage.js
// alpha_v1_sim v1.0.0
// Project source file.

export function loadStoredState(storageKey, oldKeys=[]){
  try{
    let raw = localStorage.getItem(storageKey);
    if (!raw){
      for (const k of oldKeys){
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

export function saveStoredState(storageKey, state){
  try{
    localStorage.setItem(storageKey, JSON.stringify(state));
  }catch(e){
    console.warn('Failed saving state', e);
  }
}

export function downloadJson(obj, filename){
  const blob = new Blob([JSON.stringify(obj, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function readJsonFile(file){
  const txt = await file.text();
  const s = JSON.parse(txt);
  if (!s || typeof s !== 'object') throw new Error('Bad JSON');
  return s;
}