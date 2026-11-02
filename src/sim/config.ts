import { angledTwo, diagonalSteps, PATTERNS, PATTERN_BY_ID, straight, type Hex, type PatternId, type UnitFamily } from './patterns';

export type UnitProfile = {
  aggression: number;
  caution: number;
  objective: number;
  spacing: number;
  focus: number;
  intercept: number;
  mobility: number;
  idealRange: number;
  defense: number;
  siege: boolean;
  attackPriority: number;
  preferredTargets: UnitFamily[];
};

const base = (overrides: Partial<UnitProfile> = {}): UnitProfile => ({
  aggression: 1,
  caution: 1,
  objective: 1,
  spacing: 0.65,
  focus: 1.1,
  intercept: 0.8,
  mobility: 0.7,
  idealRange: 1,
  defense: 1,
  siege: true,
  attackPriority: 1,
  preferredTargets: [],
  ...overrides,
});

// These are per-unit behaviour tables used by the action scorer. They are
// intentionally expressive: family defaults are replaced when a unit is a
// specialist rather than falling back to one shared "AI" for every pattern.
export const UNIT_PROFILES: Record<PatternId, UnitProfile> = {
  melee1: base({ aggression: 1.15, caution: 0.95, mobility: 0.55, spacing: 0.45 }),
  light1: base({ aggression: 1.3, caution: 0.8, mobility: 1.25, spacing: 0.5, idealRange: 2 }),
  // idealRange: 0 means AUTO — the engine derives it from the unit's current
  // brown (ranged) geometry, so re-authored patterns are respected instantly.
  ranged1: base({ aggression: 0.8, caution: 1.35, mobility: 0.9, objective: 0, siege: false, idealRange: 0, spacing: 1.05, attackPriority: 1.25 }),
  melee2: base({ aggression: 1.2, caution: 1, mobility: 0.65, spacing: 0.5 }),
  // Hunter: priority pounce attacks, no siege duty, and purely value-based
  // targeting (no family preference). It hunts whatever is worth the most.
  anti: base({ aggression: 1.1, caution: 0.9, mobility: 0.9, objective: 0, siege: false, intercept: 1.6, idealRange: 0, preferredTargets: [], attackPriority: 1.7 }),
  heavy1: base({ aggression: 1.45, caution: 0.72, mobility: 1.05, spacing: 0.4, idealRange: 2 }),
  melee3: base({ aggression: 1.25, caution: 1, mobility: 0.75, spacing: 0.5 }),
  ranged2: base({ aggression: 0.92, caution: 1.2, mobility: 0.95, objective: 0, siege: false, idealRange: 0, spacing: 1, attackPriority: 1.45 }),
  sniper: base({ aggression: 0.7, caution: 1.6, mobility: 0.75, objective: 0, siege: false, idealRange: 0, spacing: 1.4, attackPriority: 1.6 }),
  light2: base({ aggression: 1.35, caution: 0.78, mobility: 1.35, spacing: 0.5, idealRange: 2 }),
  melee4: base({ aggression: 1.3, caution: 1.05, mobility: 0.8, spacing: 0.45 }),
  heavy2: base({ aggression: 1.5, caution: 0.78, mobility: 1.1, idealRange: 0, spacing: 0.5, attackPriority: 1.5 }),
  harrier: base({ aggression: 1.2, caution: 1, mobility: 1.45, objective: 0.8, idealRange: 2, spacing: 0.7, intercept: 1.1 }),
};

// A compact hash of every authored pattern (geometry + unlock). Training
// records the fingerprint; if it changes, learned per-unit weights are cleared
// so the AI re-adapts to the new rules instead of carrying stale habits.
export function patternFingerprint(): string {
  let hash = 2166136261;
  const text = PATTERNS.map((pattern) => {
    const section = (offsets: Hex[]) => offsets.map((offset) => `${offset.q},${offset.r}`).sort().join('.');
    const profile = UNIT_PROFILES[pattern.id];
    return `${pattern.id}:${pattern.unlock}|${section(pattern.green)}|${section(pattern.red)}|${section(pattern.brown)}|${section(pattern.blue)}|${JSON.stringify(profile)}`;
  }).join(';');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export type EraKey = 'opening' | 'middle' | 'late';
export type EraBand = { key: EraKey; label: string; start: number; end: number };
export const ERA_BANDS: Record<EraKey, EraBand> = {
  opening: { key: 'opening', label: 'Opening', start: 1, end: 4 },
  middle: { key: 'middle', label: 'Middle', start: 5, end: 8 },
  late: { key: 'late', label: 'Late', start: 9, end: 13 },
};

export type RulesetSnapshot = {
  patterns: Array<Pick<(typeof PATTERNS)[number], 'id' | 'unlock' | 'description' | 'green' | 'red' | 'brown' | 'blue'>>;
  profiles: Record<PatternId, UnitProfile>;
  eras: Record<EraKey, EraBand>;
};

// Workers and online guests live in separate JS contexts: they need an
// explicit copy of the authored rules instead of their bundled defaults.
export function captureRuleset(): RulesetSnapshot {
  return {
    patterns: PATTERNS.map(({ id, unlock, description, green, red, brown, blue }) => ({
      id, unlock, description, green: green.map((hex) => ({ ...hex })), red: red.map((hex) => ({ ...hex })),
      brown: brown.map((hex) => ({ ...hex })), blue: blue.map((hex) => ({ ...hex })),
    })),
    profiles: structuredClone(UNIT_PROFILES),
    eras: structuredClone(ERA_BANDS),
  };
}

export function applyRuleset(rules: RulesetSnapshot): void {
  for (const pattern of rules.patterns) {
    if (!PATTERN_BY_ID[pattern.id]) continue;
    const target = PATTERN_BY_ID[pattern.id];
    target.unlock = pattern.unlock;
    target.description = pattern.description;
    for (const channel of ['green', 'red', 'brown', 'blue'] as const) {
      target[channel] = pattern[channel].map((hex) => ({ ...hex }));
    }
  }
  for (const id of Object.keys(UNIT_PROFILES) as PatternId[]) {
    if (rules.profiles[id]) Object.assign(UNIT_PROFILES[id], rules.profiles[id]);
  }
  for (const key of ['opening', 'middle', 'late'] as EraKey[]) {
    if (rules.eras[key]) Object.assign(ERA_BANDS[key], rules.eras[key]);
  }
}

const PATTERN_KEY = 'hexfield-patterns-v3';
const ERA_KEY = 'hexfield-eras-v3';
const PROFILE_KEY = 'hexfield-profiles-v3';

export const FACTORY_PATTERNS = PATTERNS.map((pattern) => ({
  id: pattern.id,
  unlock: pattern.unlock,
  description: pattern.description,
  green: pattern.green.map((hex) => ({ ...hex })),
  red: pattern.red.map((hex) => ({ ...hex })),
  brown: pattern.brown.map((hex) => ({ ...hex })),
  blue: pattern.blue.map((hex) => ({ ...hex })),
}));
export const FACTORY_ERAS = Object.fromEntries((Object.keys(ERA_BANDS) as EraKey[])
  .map((key) => [key, { ...ERA_BANDS[key] }])) as Record<EraKey, EraBand>;
export const FACTORY_PROFILES = Object.fromEntries(Object.entries(UNIT_PROFILES).map(([id, profile]) =>
  [id, { ...profile, preferredTargets: [...profile.preferredTargets] }])) as Record<PatternId, UnitProfile>;

export function resetPattern(id: PatternId): void {
  const factory = FACTORY_PATTERNS.find((pattern) => pattern.id === id);
  if (!factory) return;
  PATTERN_BY_ID[id].unlock = factory.unlock;
  PATTERN_BY_ID[id].description = factory.description;
  for (const channel of ['green', 'red', 'brown', 'blue'] as const) {
    PATTERN_BY_ID[id][channel] = factory[channel].map((hex) => ({ ...hex }));
  }
}

export function setEraBand(key: EraKey, start: number, end: number): void {
  const safeStart = Math.max(1, Math.min(39, Math.round(start)));
  const safeEnd = Math.max(safeStart + 1, Math.min(40, Math.round(end)));
  ERA_BANDS[key].start = safeStart;
  ERA_BANDS[key].end = safeEnd;
}

export function replacePatternGeometry(id: PatternId, channels: Partial<Record<'green' | 'red' | 'brown' | 'blue', Hex[]>>): void {
  const pattern = PATTERN_BY_ID[id];
  for (const channel of ['green', 'red', 'brown', 'blue'] as const) {
    if (channels[channel]) pattern[channel] = channels[channel]!.map(({ q, r }) => ({ q, r }));
  }
  pattern.description = 'Custom geometry: ' + (['green', 'red', 'brown', 'blue'] as const)
    .filter((channel) => pattern[channel].length)
    .map((channel) => `${channel} ${pattern[channel].length}`).join(', ');
}

export function updateUnlock(id: PatternId, stage: number): void {
  PATTERN_BY_ID[id].unlock = Math.max(1, Math.min(40, Math.round(stage)));
}

export function saveCustomization(): void {
  try {
    localStorage.setItem(PATTERN_KEY, JSON.stringify(PATTERNS.map((pattern) => ({
      id: pattern.id, unlock: pattern.unlock, green: pattern.green, red: pattern.red,
      brown: pattern.brown, blue: pattern.blue,
    }))));
    localStorage.setItem(ERA_KEY, JSON.stringify(ERA_BANDS));
    localStorage.setItem(PROFILE_KEY, JSON.stringify(UNIT_PROFILES));
  } catch { /* Persistence is optional. */ }
}

export function loadCustomization(): void {
  try {
    const storedPatterns: unknown = JSON.parse(localStorage.getItem(PATTERN_KEY) || 'null');
    if (Array.isArray(storedPatterns)) {
      for (const value of storedPatterns) {
        if (!value || typeof value !== 'object' || !('id' in value)) continue;
        const id = (value as { id: PatternId }).id;
        if (!PATTERN_BY_ID[id]) continue;
        updateUnlock(id, Number((value as { unlock?: number }).unlock || PATTERN_BY_ID[id].unlock));
        // Old saves contained every factory pattern, even if a user never
        // edited that unit. Migrate only an exact old default; keep custom art.
        const saved = value as Record<string, unknown>;
        const sameOffsets = (actual: unknown, expected: Hex[]) => Array.isArray(actual)
          && actual.length === expected.length
          && expected.every((hex) => actual.some((other: Hex) => other?.q === hex.q && other?.r === hex.r));
        const oldHunterBlue = [
          { q: 2, r: -4 }, { q: 1, r: -3 }, { q: 2, r: -3 },
          { q: -2, r: -2 }, { q: -1, r: -2 }, { q: 3, r: -2 }, { q: 4, r: -2 },
          { q: -2, r: -1 }, { q: 3, r: -1 }, { q: -3, r: 1 }, { q: 2, r: 1 },
          { q: -4, r: 2 }, { q: -3, r: 2 }, { q: 1, r: 2 }, { q: 2, r: 2 },
          { q: -2, r: 3 }, { q: -1, r: 3 }, { q: -2, r: 4 },
        ];
        const legacyHunter = id === 'anti' && sameOffsets(saved.green, straight(1))
          && sameOffsets(saved.blue, oldHunterBlue) && sameOffsets(saved.red, []) && sameOffsets(saved.brown, []);
        const legacyLight = id === 'light2' && sameOffsets(saved.green, diagonalSteps)
          && sameOffsets(saved.red, [...angledTwo, ...straight(3)])
          && sameOffsets(saved.blue, []) && sameOffsets(saved.brown, []);
        if (legacyHunter || legacyLight) continue;
        for (const channel of ['green', 'red', 'brown', 'blue'] as const) {
          const offsets = (value as Record<string, unknown>)[channel];
          if (Array.isArray(offsets)) {
            replacePatternGeometry(id, { [channel]: offsets.filter((hex): hex is Hex =>
              !!hex && typeof hex === 'object' && Number.isFinite((hex as Hex).q) && Number.isFinite((hex as Hex).r)) });
          }
        }
      }
    }
    const storedProfiles: unknown = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
    if (storedProfiles && typeof storedProfiles === 'object') {
      for (const [id, value] of Object.entries(storedProfiles)) {
        if (!UNIT_PROFILES[id as PatternId] || !value || typeof value !== 'object') continue;
        const target = UNIT_PROFILES[id as PatternId];
        for (const key of ['aggression', 'caution', 'objective', 'spacing', 'focus', 'intercept', 'mobility', 'idealRange', 'defense', 'attackPriority'] as const) {
          const number = Number((value as Record<string, unknown>)[key]);
          if (Number.isFinite(number)) target[key] = Math.max(0, Math.min(4, number));
        }
        if (typeof (value as { siege?: unknown }).siege === 'boolean') target.siege = (value as { siege: boolean }).siege;
      }
    }
    const storedEras: unknown = JSON.parse(localStorage.getItem(ERA_KEY) || 'null');
    if (storedEras && typeof storedEras === 'object') {
      for (const key of ['opening', 'middle', 'late'] as EraKey[]) {
        const band = (storedEras as Record<string, Partial<EraBand>>)[key];
        if (band && Number.isFinite(band.start) && Number.isFinite(band.end)) {
          ERA_BANDS[key].start = Math.max(1, Math.min(39, Number(band.start)));
          ERA_BANDS[key].end = Math.max(ERA_BANDS[key].start + 1, Math.min(40, Number(band.end)));
        }
      }
    }
  } catch { /* Corrupt customization should not block simulation. */ }
}

export function stageEra(stage: number): EraKey {
  if (stage <= ERA_BANDS.opening.end) return 'opening';
  if (stage <= ERA_BANDS.middle.end) return 'middle';
  return 'late';
}

export function resetCustomization(): void {
  for (const pattern of FACTORY_PATTERNS) resetPattern(pattern.id);
  for (const key of Object.keys(FACTORY_ERAS) as EraKey[]) setEraBand(key, FACTORY_ERAS[key].start, FACTORY_ERAS[key].end);
  for (const id of Object.keys(FACTORY_PROFILES) as PatternId[]) Object.assign(UNIT_PROFILES[id], FACTORY_PROFILES[id], { preferredTargets: [...FACTORY_PROFILES[id].preferredTargets] });
  try { localStorage.removeItem(PATTERN_KEY); localStorage.removeItem(ERA_KEY); localStorage.removeItem(PROFILE_KEY); } catch { /* optional */ }
}
