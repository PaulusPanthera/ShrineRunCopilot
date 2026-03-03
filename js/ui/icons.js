// js/ui/icons.js
// alpha v1
// Lightweight icon manifest loader for UI item/type sprites.

let ICONS = null;

export async function loadIcons(){
  if (ICONS) return ICONS;
  try{
    const res = await fetch('assets/pokeicons/itemIconMap.json', {cache:'no-store'});
    if (!res.ok) throw new Error(`icon manifest HTTP ${res.status}`);
    ICONS = await res.json();
    return ICONS;
  }catch(e){
    console.warn('Icon manifest failed to load:', e);
    ICONS = {
      itemsBaseUrl: 'assets/pokeicons/items/',
      typesBaseUrl: 'assets/pokeicons/types/',
      itemIcons: {},
      typeIcons: {},
    };
    return ICONS;
  }
}

function safeKey(x){
  if (x == null) return '';
  return String(x);
}

export function getItemIcon(keyOrName){
  if (!ICONS) return '';
  const k = safeKey(keyOrName);
  const rel = ICONS.itemIcons?.[k];
  return rel ? (ICONS.itemsBaseUrl + rel) : '';
}

export function getTypeIcon(typeName){
  if (!ICONS) return '';
  const t = safeKey(typeName);
  const rel = ICONS.typeIcons?.[t];
  return rel ? (ICONS.typesBaseUrl + rel) : '';
}
