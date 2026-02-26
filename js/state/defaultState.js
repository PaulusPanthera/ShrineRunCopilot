// js/state/defaultState.js
// v2.0.0-beta
// Default state factory + initial settings

export const STATE_VERSION = 13;
export const STORAGE_KEY = 'abundantShrinePlanner_state_v13';
export const OLD_KEYS = [
  'abundantShrinePlanner_state_v12',
  'abundantShrinePlanner_state_v11',
  'abundantShrinePlanner_state_v10',
  'abundantShrinePlanner_state_v9',
];

function n(x, fallback){
  const v = Number(x);
  return Number.isFinite(v) ? v : fallback;
}

export function createDefaultState(data){
  return {
    version: STATE_VERSION,
    settings: {
      // Per-wave mods are stored in wavePlans.monMods; these remain as defaults + global constants.
      defenderHpFrac: 1.0,
      atkStage: 0,
      spaStage: 0,
      enemyDefStage: 0,
      enemySpdStage: 0,
      speStage: 0,
      enemySpeStage: 0,
      autoMatch: true, // forced ON

      // Threat model defaults (enemy hits you)
      threatModelEnabled: true,
      enemyAssumedPower: 80,
      enemySpeedTieActsFirst: true,

      // Default per-mon wave modifiers when no custom value exists yet
      defaultAtkMods: {hpPct:100, atkStage:0, spaStage:0, defStage:0, spdStage:0, speStage:0},
      defaultDefMods: {hpPct:100, atkStage:0, spaStage:0, defStage:0, spdStage:0, speStage:0},
      applyINT: true,
      applySTU: true,
      // Auto: when a STU (Sturdy) defender is present alongside a non-STU defender,
      // try to solve the turn using AoE (if available) to OHKO the partner and chip STU,
      // then finish STU with the other attacker (or set it up for next turn).
      sturdyAoeSolve: true,
      // If OFF (default), auto move selection will avoid AoE spread moves that could KO your partner.
      // Manual/forced moves can still friendly-fire, but the log will warn.
      allowFriendlyFire: false,
      movesPerMon: 3,
      stabBonus: 2,
      conservePower: true,
      hideCleared: false,
      startWaveAnimal: 'Goat',

      // v20+ alias (some builds store this name instead)
      startAnimal: 'Goat',

      // Auto-solver: how much worse (avg prioØ) alternatives are allowed when cycling.
      // 0 = best-only. Example: 0.5 will include solutions up to bestAvg+0.5.
      autoAltAvgSlack: 0,

      // Variation controls (used by auto-solver + large alternative lists)
      // - variationLimit: how many alternatives we keep for cycling and default displays
      // - variationGenCap: safety cap on how many candidate schedules we generate/sim-rank per solve
      variationLimit: 8,
      variationGenCap: 5000,

      claimedLevel: n(data?.rules?.Claimed_Level, 50),
      claimedIV: n(data?.rules?.Claimed_IV_All, 31),
      claimedEV: n(data?.rules?.Claimed_EV_All, 0),
      strengthEV: n(data?.rules?.StrengthCharm_EV_All, 85),

      wildIV: n(data?.rules?.Wild_IV_Default, 0),
      wildEV: n(data?.rules?.Wild_EV_Default, 0),

      otherMult: 1,
    },
    unlocked: {},
    cleared: {},
    roster: [],
    // Shared team bag (team run). Defaults: 2 Evo + 2 Strength TOTAL.
    bag: {
      'Evo Charm': 2,
      'Strength Charm': 2,
    },
    // Simple currency (sell loot for gold; shop later)
    wallet: {
      gold: 0,
    },

    // Politoed shop (buy/sell bag items)
    shop: { gold: 0, ledger: [] },
    evoCache: {},
    baseCache: {},
    evoLineCache: {},
    // Pokédex live caches (PokeAPI)
    dexMetaCache: {},
    dexApiCache: {},
    dexMoveCache: {},
    wavePlans: {},
    ui: {
      tab: 'waves',
      waveExpanded: {},
      selectedRosterId: null,
      searchRoster: '',
      searchUnlocked: '',
      dexDetailBase: null,
      dexSelectedForm: null,
      // Pokédex detail-layer navigation
      dexReturnTab: null,
      dexReturnRosterId: null,
      lastNonDexTab: 'waves',
      // Per-base remembered defender level (for one-shot table)
      dexDefenderLevelByBase: {},
      // Grid resolve job flags (avoids jitter while prefetching Pokédex ids)
      dexGridReady: false,
      dexGridBuiltN: 0,
      dexDefenderLevel: null,
      attackOverview: null, // {defender, level, tags, source}
      overviewCollapsed: true,
      fightLog: {},
      fightUndo: {},
      bagUndo: [],
      settingsDefaultsTab: 'atk',
    },
  };
}
