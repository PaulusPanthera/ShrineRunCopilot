# Shrine Run Copilot — Roster Planner (alpha v1)

Local-first, browser-based planner for the **Abundant Shrine** challenge (PokeMMO / LNY event ruleset):
- Build and edit your **active roster**
- Plan **waves** (defenders + starters + overrides)
- Track **bag/shop** items and consumables
- Browse **Pokédex/Unlocked** species and view one-shot tables

Built by **[MÜSH] PaulusTFT**. Runs fully in the browser (no backend, no accounts).

---

## Run locally

Because this uses ES modules, open it via a local server (not `file://`).

### Python
```bash
python -m http.server 8000
```
Open: `http://localhost:8000`

### Node (optional)
```bash
npx serve
```

---

## Project structure

- `index.html` — app shell
- `styles.css` — global UI styling
- `calc.js` — damage/calc helper layer (planner previews + scoring)
- `js/main.js` — entry point
- `js/app/app.js` — app bootstrap + render coordinator
- `js/domain/*` — battle + wave logic (simulation + rules)
- `js/ui/tabs/*` — tab UIs (waves / roster / bag / settings / unlocked)
- `js/ui/dexApi.js` — shared PokéAPI cache helpers (used across tabs)
- `data/*.json` — dex, moves, typing, rules, stages, wave slots, claimed sets
- `assets/*` — background + icon sprites

---

## Persistence / Export / Import

State is saved automatically in your browser:

- **localStorage key:** `abundantShrinePlanner_state_v13`

You can:
- **Export** a JSON snapshot (top-right button)
- **Import** that snapshot on another device/browser
- **Reset** wipes local state

> Clearing browser storage/cache will remove your local state unless you exported.

---

## PokéAPI caching (Dex / Unlocked tab)

Some UI panels pull metadata (dex #, genus, height/weight, Gen 5 typing) from PokéAPI.
Caching is centralized via `js/ui/dexApi.js` so all tabs share the same behavior and avoid duplicated fetch logic.

If PokéAPI looks stale or you want to reset:
- Clear site data for `localhost`
- Or remove relevant localStorage keys for cached dex/meta (if present)

---

## Notes

- This tool is an unofficial fan utility and is not affiliated with Nintendo / Creatures / GAME FREAK / PokeMMO.
- See **REPORT.md** for the patch history and implemented rules/mechanics.

