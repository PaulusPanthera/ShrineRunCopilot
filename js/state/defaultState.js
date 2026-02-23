// js/state/defaultState.js
// v13 — default state factory

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
      movesPerMon: 3,
      stabBonus: 2,
      conservePower: true,
      hideCleared: false,

      claimedLevel: n(data?.rules?.Claimed_Level, 50),
      claimedIV: n(data?.rules?.Claimed_IV_All, 31),
      claimedEV: n(data?.rules?.Claimed_EV_All, 0),
      strengthEV: n(data?.rules?.StrengthCharm_EV_All, 85),

      wildIV: n(data?.rules?.Wild_IV_Default, 0),
      wildEV: n(data?.rules?.Wild_EV_Default, 0),

      otherMult: 1,

      // Run order: which animal wave starts each phase (rotates wave display order only)
      startAnimal: 'Goat',
    },
    unlocked: {},
    cleared: {},
    roster: [],
    // Shared team bag (team run). Defaults: 2 Evo + 2 Strength TOTAL.
    bag: {
      'Evo Charm': 2,
      'Strength Charm': 2,
    },
    evoCache: {},
    baseCache: {},
    evoLineCache: {},
    wavePlans: {},
    // Battle simulator state per waveKey
    battles: {},
    // Persistent PP tracking for roster moves (id -> moveName -> {cur,max})
    pp: {},

    // Politoed shop (buy/sell bag items)
    shop: { gold: 0, ledger: [] },
    ui: {
      tab: 'waves',
      waveExpanded: {},
      selectedRosterId: null,
      searchRoster: '',
      searchUnlocked: '',
      dexDetailBase: null,
      dexSelectedForm: null,
      dexReturnTab: null,
      simWaveKey: null,
      dexDefenderLevelByBase: {},
      attackOverview: null, // {defender, level, tags, source}
      overviewCollapsed: true,
    },
  };
}
