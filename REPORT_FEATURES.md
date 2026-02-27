# REPORT_FEATURES.md

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
