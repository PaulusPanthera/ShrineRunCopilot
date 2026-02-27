# REPORT

This file is the single source of truth for **patch notes + sanity audits** for the **alpha v1** tool.

---

## Patch: headers_reports_alpha_v1
- **Base zip:** `alpha_v1_src.zip`
- **Date:** 2026-02-27
- **Scope:** Header/version-string cleanup + report consolidation
- **Feature changes:** **None** (comments/docs only)

### Sanity findings (no mechanic changes)
- **AoE spread multiplier (×0.75)** is applied **exactly once** in all relevant paths:
  - Fight plan preview (`js/app/app.js`) applies `spreadMult(targetsDamaged)` **once** to the base damage range.
  - Auto x4 scoring (`js/domain/waves.js`) applies `spreadMult(damagedTargets)` **once** during scoring.
  - Battle step resolution (`js/domain/battle.js`) applies `spreadMult(targetsDamaged)` **once** when resolving an AoE hit.
  - `calc.computeDamageRange()` returns **single-target** damage% and does **not** apply spread.
- **Overkill is not clamped pre-spread:** damage% may exceed 100 and is multiplied by spread after (e.g., `150% → 112.5%` still OHKOs).
- **Low Kick / Grass Knot are weight-based (Gen 5 brackets)** via `weightBasedPowerKg()` in `calc.js`:
  - `<10→20`, `<25→40`, `<50→60`, `<100→80`, `<200→100`, `≥200→120` BP.

### Required verification: Simisage + Strength Charm (Low Kick, Gen 5 weight BP)
Assumptions (tool defaults):
- Attacker: **Simisage** Lv50, IV31, **EV85** (Strength Charm), move **Low Kick**
- Defenders: IV0 / EV0, wave levels as listed

Results (single-target, min/max roll):
- **Smeargle (Lv47, 58.0kg → 80 BP):** **194.4% – 229.6%** (min-roll OHKO ✅)
- **Whismur (Lv47, 16.3kg → 40 BP):** **129.1% – 152.1%** (min-roll OHKO ✅)
- **Absol (Lv48, 47.0kg → 60 BP):** **79.2% – 93.3%** (min-roll OHKO ❌)

### Version/header cleanup performed
- Removed all `v1.0.x` strings from headers and comments.
- Standardized JS headers to:
  1. `// <relative path>`
  2. `// alpha v1`
  3. `// short comment`
- Updated non-JS file headers (HTML/CSS) to match **alpha v1** naming.
- Deprecated `reports/*.txt` as authoritative patch notes (kept only as archival docs).

### Touched files
- `calc.js`
- `index.html`
- `js/app/app.js`
- `js/data/loadData.js`
- `js/data/moveFixes.js`
- `js/data/nameFixes.js`
- `js/domain/battle.js`
- `js/domain/items.js`
- `js/domain/roster.js`
- `js/domain/shrineRules.js`
- `js/domain/waves.js`
- `js/main.js`
- `js/services/pokeApi.js`
- `js/services/storage.js`
- `js/state/defaultState.js`
- `js/state/migrate.js`
- `js/state/store.js`
- `js/ui/dom.js`
- `js/ui/eggGame.js`
- `reports/sanity_report.txt`
- `reports/weather_ball_drizzle_report.txt`
- `styles.css`
- `REPORT.md` (new)


---

## Patch: ui_reinf_order_preview_text_alpha_v1
- **Base zip:** `alpha_v1_sim_headers_reports_alpha_v1.zip`
- **Date:** 2026-02-27
- **Scope:** UI clarity in Waves/Battle (reinforcement join order) + remove leftover “sim” wording in user-facing copy
- **Feature changes:** **UI-only** (no battle mechanics / solver changes)

### What changed
- **Selected enemies:** slot labels now read **Lead #1 / Lead #2 / Reinf #3 / Reinf #4** (join order is obvious).
- **Selection summary:** “Order” → **“Join order”** and uses the Lead/Reinf labels.
- **Battle reinforcements:** chooser now **defaults to the next bench entry (join order)** (still overrideable).
- **Copy cleanup:** removed “sim assumes …” and replaced “Simulate/Re-sim” wording with **Preview/Re-run** where it was user-facing.

### Sanity
- `node --check` passes (no syntax errors).
- AoE spread ×0.75 and Low Kick weight brackets are untouched.

### Touched files
- `js/app/app.js`
- `REPORT.md`

---

## Folded archive: REPORT_FEATURES.md (deprecated)
# REPORT_FEATURES.md (DEPRECATED)

This file is kept for archive. Canonical patch notes + audits live in **/REPORT.md**.

## Implemented (Prompt 2 — steps 1–3)

### Step 1 — Default prio strength respects AoE ×0.75 (classification only)
- Updated the **default prio estimator (prioØ)** so **AoE moves use `effectiveBP = BP * 0.75`** when calculating the *strength* used for tiering.
- This is **only inside the default prio assignment** logic and **does not touch damage** (spread is still handled only in the battle sim).

### Step 2 — Bug/Fighting “importance” rule stays
- Kept the existing scalable rules:
  - **STAB Bug/Fighting → P5** (reserve for bosses)
  - **Strong non‑STAB Bug coverage (Megahorn-ish) stays late**

### Step 3 — Dynamic low‑PP prio bump (lazy conserve)
- Added a new setting: **`Auto-bump prio when PP ≤ 5 (lazy conserve)`** (default **ON**).
- Behavior:
  - When a move’s PP becomes **≤ 5**, its **prio increases by +1 tier** (clamped to **max P5**).
  - Only applies if **`prioAuto === true`** and **`lowPpBumped !== true`**.
  - Sets **`lowPpBumped: true`** on the move so it won’t re-trigger.
  - **No auto-revert** when PP rises again.
- Trigger points covered:
  - PP changes from **battle usage** (PP decrement)
  - PP changes from **manual PP editing** (when enabled)

### Migration — ensure updated defaults apply broadly
- Added a one-time migration flag **`state.ui._prioDefaultsAoe075Applied`** to recompute **only auto-managed** priorities (`prioAuto=true`) so the AoE ×0.75 classification change applies to existing saves.
- Manual prios (`prioAuto=false`) are preserved.

## Files touched
- `js/domain/roster.js`
- `js/domain/battle.js`
- `js/state/defaultState.js`
- `js/state/migrate.js`
- `js/app/app.js`

## Follow-up patch — STAB folded into strength (requested)
- Default prio tiering now treats **STAB as a pure math multiplier (×1.5)** inside the same strength formula.
- Typing is only used for **special reserve rules**:
  - **STAB Bug/Fighting → P5**
  - **Non‑STAB Bug ≥100 BP → P4**
  - **Strong non‑STAB Fighting (strength ≥125) → at least P4**
- Added migration flag **`state.ui._prioDefaultsStabMathApplied`** to refresh **auto** prios without overwriting manual prios (and skipping `lowPpBumped` moves).

## Follow-up patch — Strength thresholds tuned (requested)
- Updated strength-to-tier thresholds to:
  - **P1**: strength < **85**
  - **P2**: < **100**
  - **P3**: < **115**
  - **P4**: < **130**
  - **P5**: ≥ **130**
- Refined Bug/Fighting reserve rules to stay **type-aware but narrow**:
  - **STAB Bug/Fighting → P5 only if strength ≥ 100** (so very weak Bug/Fighting isn’t forced to P5)
  - **Strong non‑STAB Bug/Fighting** reserve uses **strength ≥ 115** (instead of BP-only)
- Added migration flag **`state.ui._prioDefaultsStrengthThresholdsV2Applied`** to refresh **auto** prios without overwriting manual prios (and skipping `lowPpBumped` moves).

## Follow-up patch — prioØ uses effective Level stats (requested)
- Default prio strength now uses **effective offensive stats at the run’s claimed Level** (default L50), including:
  - **IV (claimedIV)**
  - **EV (claimedEV / strengthEV)** depending on Strength Charm toggle
  - **Nature multipliers** (e.g., Adamant/Modest; neutral natures remain 1.0)
  - **Limited deterministic ability multipliers** (Huge/Pure Power, Toxic Boost, Iron Fist, Technician, Reckless, Adaptability)
  - **Stable move power tweaks** (Bonemerang/Dual Chop/DoubleSlap/Acrobatics; Low Kick/Grass Knot treated as BP 60)
- Added migration flag **`state.ui._prioDefaultsEffectiveL50Applied`** to refresh **auto** prios without overwriting manual prios (and skipping `lowPpBumped` moves).
- Settings changes to claimed Level/IV/EV/Strength EV now trigger a **live auto-prio refresh** for all roster mons.

## Follow-up patch — Secret Sword + meta-tuned prio bands + Normal tier shift
- **Keldeo move correction**: uses **Secret Sword** and it is modeled as **Special** that **targets Def**.
- **Secret Sword power** set to **90 BP** (tool rules).
- Updated strength-to-tier thresholds to meta-tuned bands:
  - **P1**: strength < **75**
  - **P2**: < **105**
  - **P3**: < **140**
  - **P4**: < **190**
  - **P5**: ≥ **190**
- Updated reserve rules:
  - **STAB Bug/Fighting → P5** when **strength ≥ 115**
  - **Non‑STAB Bug with BP ≥ 100 → at least P4**
  - **Non‑STAB Fighting**: **strength ≥ 160 → at least P4**, **≥ 200 → P5**
- New default-only bias: **Normal-type attacking moves** shift **1 tier earlier** for stronger bands (**P3–P5 → P2–P4**).
- Added migration flag **`state.ui._prioDefaultsMetaBandsApplied`** to refresh **auto** prios without overwriting manual prios (and skipping `lowPpBumped` moves).

## Follow-up patch — Retuned bands (75/110/160/220/260)
- Updated strength-to-tier thresholds to:
  - **P1**: strength < **75**
  - **P2**: < **110**
  - **P3**: < **160**
  - **P4**: < **220**
  - **P5**: ≥ **220** (very strong moves are often ≥ **260**, but remain P5)
- Kept reserve rules + Normal-tier shift unchanged.
- Added migration flag **`state.ui._prioDefaultsMetaBandsAppliedV2`** to refresh **auto** prios without overwriting manual prios (and skipping `lowPpBumped` moves).

## Follow-up patch — Hard roster cap + Dex back reliability
- Enforced a **hard roster size cap of 16** (the tool now prevents adding a 17th mon).
  - Add buttons are disabled when full; Add modal shows a “Roster is full” hint.
  - Migration clamps imported/legacy saves to the first **16** roster entries.
- Fixed Pokédex **Back to Roster** behavior:
  - Navigating within Pokédex (opening other entries) no longer overwrites the original return target.
  - Back button always prefers returning to roster when the Dex session started from a roster mon.

## Follow-up patch — Dex back fix for starters (robust return)

- Persist `ui.dexReturnRosterBase` alongside `ui.dexReturnRosterId` when opening Dex from a roster entry.
- Dex back now resolves the return roster entry by **id** first, then by **base species** as a fallback.
- Switching away from Dex to the Roster via the top nav also preserves this selection.

Files touched:
- `js/app/app.js`

## Patch — UI copy cleanup (remove remaining “Sim” wording)

- Base zip: `alpha_v1_sim_ui_reinf_order_preview_text_alpha_v1.zip`
- Date: 2026-02-27
- What changed:
  - Removed outdated references to a **Sim tab** and replaced “simulate” wording with **run/step/preview** wording.
  - Fight plan log toggle label now says **“Show battle log”** (no “simulated”).
- No feature/mechanics changes.

Files touched:
- `js/app/app.js`
- `js/state/migrate.js`

## Follow-up patch — Deterministic Dex origin + remove duplicate Dex button

- Replaced fragile Dex return inference with a deterministic `ui.dexOrigin` state:
  - Top-nav Pokédex starts a fresh **browsing** session (`dexOrigin='unlocked'`).
  - Opening Dex from a roster mon sets `dexOrigin='roster'` with roster id + base fallback.
  - Dex detail back button now routes strictly based on origin:
    - `roster` → returns to **Roster** (and reselects the originating mon when possible)
    - otherwise → returns to **Pokédex grid**
- Removed the duplicate **Dex** button in the roster list rows (next to **Edit**). Opening Dex is still possible via:
  - clicking the roster sprite, or
  - using the Dex button next to **Remove** in the details panel.

Files touched:
- `js/app/app.js`
- `js/state/defaultState.js`
- `js/state/migrate.js`

## Follow-up patch — Fix “Back” buttons that sometimes do nothing (lost click on rerender)

- Back buttons in Pokédex detail now trigger on **pointerdown/mousedown** (not just click), to prevent lost-click issues when the Dex detail view re-renders due to async cache updates.
- Same pointerdown wiring added to **open Dex** actions from Roster (sprite + row title + details Dex button) to make navigation reliable for starters and any species.
- Open-Dex routing now uses a safe base fallback: `baseSpecies || effectiveSpecies`.

Files touched:
- `js/app/app.js`

## Patch — UI layout pack (Roster details grid + Bag tabs + Fight log actions)

- Base zip: `alpha_v1_sim_ui_copy_cleanup_alpha_v1.zip`
- Date: 2026-02-27
- What was changed / checked:
  - **Roster**: Roster details panel now uses a **two-column layout** (left: charms/items/mods, right: move pool + add move) to reduce wasted space.
  - **Bag**: Added simple **category tabs** (All / Charms / Held / Plates / Gems). This is UI-only filtering.
  - **Waves → Fight log**: Each entry now shows **status + turns + PP spent**, and adds quick actions:
    - **Set starters** (apply attackers from that log entry)
    - **Select enemies** (apply defenders from that log entry)
  - No solver / mechanics changes.

Files touched:
- `js/app/app.js`
- `styles.css`

## Patch — Waves toolbar (non-clutter) + Fight log PP breakdown

- Base zip: `alpha_v1_sim_ui_layout_pack_alpha_v1.zip`
- Date: 2026-02-27
- What was changed / checked:
  - **Waves**: Moved the wave-level controls (**Undo**, **Auto x4**, **All combos**, **Expand/Collapse all**) into a compact **wave toolbar** inside the **Fight plan** panel (keeps the Fight log panel simpler for newbies).
  - **Fight log**: Added per-attacker **PP breakdown** (shown in the expanded entry as `PP spent: Keldeo-1 · Virizion-1`, and as a tooltip on the `PP -X` pill).
  - **Fight log**: When item overrides are used, expanded entries now show an `Items: ...` line (UI metadata only).
  - No solver / prio / PP mechanics changes.

Files touched:
- `js/app/app.js`

## Patch — IN tooltip min–max + optional crit worst-case (UI-only)

- Base zip: `alpha_v1_sim_wave_toolbar_pp_breakdown_alpha_v1.zip`
- Date: 2026-02-27
- What was changed / checked:
  - **Waves → Fight plan (Incoming pills)**: Tooltip now shows **min–max damage range** (and for AoE, worst-target range + per-target breakdown when available).
  - **Settings → Threat model**: Added a toggle **“IN tooltip: show crit worst-case (approx ×2)”**.
    - This is **display-only** and explicitly notes that crits are not modeled by the core engine.
  - No solver / prio / PP mechanics changes.

Files touched:
- `js/app/app.js`
- `js/state/defaultState.js`
