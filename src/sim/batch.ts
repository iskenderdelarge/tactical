import {
  DEFAULT_POLICY, Random, createScenario, setProfileOverlays, setTeamProfileOverlays, simulateGame, snapshot,
  type BoardSnapshot, type GameResult, type Policy, type TurnMode,
} from './engine';
import { PATTERNS, PATTERN_IDS, type PatternId } from './patterns';
import { ERA_BANDS, UNIT_PROFILES, patternFingerprint, stageEra, type EraKey, type UnitProfile } from './config';

export type EraScope = 'all' | 'opening' | 'middle' | 'late';
export type RunSettings = { games: number; mode: TurnMode; era: EraScope; seed: number };

export type UnitMetrics = {
  deployed: number; wins: number; draws: number; losses: number;
  kills: number; deaths: number; survived: number; shots: number; moves: number;
};
export type DuelMetrics = { games: number; wins: number; draws: number; losses: number; rounds: number };
export type StageMetrics = { games: number; wins: number; draws: number; captures: number };

export type BatchStats = {
  games: number;
  rosterGames: number;
  duelGames: number;
  wins: [number, number];
  draws: number;
  captures: number;
  eliminations: number;
  attritionWins: number;
  mutualDraws: number;
  totalRounds: number;
  totalSurvivors: number;
  totalKills: number;
  minRounds: number | null;
  maxRounds: number | null;
  units: Record<PatternId, UnitMetrics>;
  unitEra: Record<PatternId, Record<EraKey, UnitMetrics>>;
  duels: Record<PatternId, Record<PatternId, DuelMetrics>>;
  stages: Record<number, StageMetrics>;
};

export type TrainingRecord = {
  generation: number;
  promoted: boolean;
  candidateScore: number;
  validationScore: number;
  games: number;
  version: number;
  adapted: boolean;
};

/** Learned per-unit behavior weights, applied on top of the authored table. */
export type ProfileDeltas = Partial<Record<PatternId, Partial<UnitProfile>>>;

export type LearningState = {
  generation: number;
  version: number;
  champion: Policy;
  trainingGames: number;
  history: TrainingRecord[];
  /** Fingerprint of the authored patterns when the weights were learned. */
  patternFingerprint: string;
  profileDeltas: ProfileDeltas;
};

export type GamePlanItem =
  | { kind: 'roster'; stage: number; seed: number }
  | { kind: 'duel'; pair: [PatternId, PatternId]; seed: number };

export type SliceResult = {
  stats: BatchStats;
  preview: BoardSnapshot;
  completed: number;
};

export type BatchResult = {
  settings: RunSettings;
  stats: BatchStats;
  learning: LearningState;
  training: TrainingRecord;
  preview: BoardSnapshot;
  generatedAt: string;
  durationMs: number;
};

export type Progress = {
  phase: 'training' | 'rosters' | 'duels';
  completed: number;
  total: number;
  trainingCompleted: number;
  trainingTotal: number;
  stats?: BatchStats;
  preview?: BoardSnapshot;
};

const PROFILE_FIELDS = ['aggression', 'caution', 'objective', 'spacing', 'focus',
  'intercept', 'mobility', 'defense', 'attackPriority'] as const;

const emptyUnit = (): UnitMetrics => ({
  deployed: 0, wins: 0, draws: 0, losses: 0, kills: 0, deaths: 0, survived: 0, shots: 0, moves: 0,
});
const emptyDuel = (): DuelMetrics => ({ games: 0, wins: 0, draws: 0, losses: 0, rounds: 0 });

export function emptyStats(): BatchStats {
  const units = {} as Record<PatternId, UnitMetrics>;
  const unitEra = {} as Record<PatternId, Record<EraKey, UnitMetrics>>;
  const duels = {} as Record<PatternId, Record<PatternId, DuelMetrics>>;
  for (const id of PATTERN_IDS) {
    units[id] = emptyUnit();
    unitEra[id] = { opening: emptyUnit(), middle: emptyUnit(), late: emptyUnit() };
    duels[id] = {} as Record<PatternId, DuelMetrics>;
    for (const opponent of PATTERN_IDS) duels[id][opponent] = emptyDuel();
  }
  const stages = {} as Record<number, StageMetrics>;
  const maxStage = Math.max(13, ...Object.values(ERA_BANDS).map((band) => band.end));
  for (let stage = 1; stage <= maxStage; stage++) stages[stage] = { games: 0, wins: 0, draws: 0, captures: 0 };
  return { games: 0, rosterGames: 0, duelGames: 0, wins: [0, 0], draws: 0,
    captures: 0, eliminations: 0, attritionWins: 0, mutualDraws: 0, totalRounds: 0,
    totalSurvivors: 0, totalKills: 0, minRounds: null, maxRounds: null,
    units, unitEra, duels, stages };
}

export function initialLearning(): LearningState {
  return {
    generation: 0, version: 1, champion: { ...DEFAULT_POLICY }, trainingGames: 0,
    history: [], patternFingerprint: patternFingerprint(), profileDeltas: {},
  };
}

/**
 * If the authored geometry changed since the weights were learned, drop the
 * learned per-unit weights so the AI starts from the authored behavior table.
 */
export function adaptLearningToPatterns(learning: LearningState): LearningState {
  const current = patternFingerprint();
  if (learning.patternFingerprint === current) return learning;
  return { ...learning, patternFingerprint: current, profileDeltas: {} };
}

export function stagesForEra(era: EraScope): number[] {
  const band = era === 'all' ? null : ERA_BANDS[era];
  const start = band ? band.start : 1;
  const end = band ? band.end : Math.max(13, ...Object.values(ERA_BANDS).map((item) => item.end));
  return Array.from({ length: Math.max(1, end - start + 1) }, (_, index) => start + index);
}

function playableStages(era: EraScope): number[] {
  const stages = stagesForEra(era).filter((stage) => PATTERNS.some((pattern) => pattern.unlock <= stage));
  if (!stages.length) throw new Error('No units are unlocked in this tech window. Adjust unlocks or choose another era.');
  return stages;
}

function recordRoster(stats: BatchStats, result: GameResult): void {
  stats.games++;
  stats.rosterGames++;
  stats.totalRounds += result.rounds;
  if (!stats.stages[result.stage]) stats.stages[result.stage] = { games: 0, wins: 0, draws: 0, captures: 0 };
  stats.stages[result.stage].games++;
  stats.totalSurvivors += result.units.filter((unit) => unit.survived).length;
  stats.totalKills += result.units.reduce((sum, unit) => sum + unit.kills, 0);
  stats.minRounds = stats.minRounds === null ? result.rounds : Math.min(stats.minRounds, result.rounds);
  stats.maxRounds = stats.maxRounds === null ? result.rounds : Math.max(stats.maxRounds, result.rounds);
  if (result.winner === null) {
    stats.draws++;
    stats.stages[result.stage].draws++;
  } else {
    stats.wins[result.winner]++;
    stats.stages[result.stage].wins++;
  }
  if (result.reason === 'capture') {
    stats.captures++;
    stats.stages[result.stage].captures++;
  }
  if (result.reason === 'elimination') stats.eliminations++;
  if (result.reason === 'attrition') stats.attritionWins++;
  if (result.reason === 'mutual') stats.mutualDraws++;
  for (const unit of result.units) {
    const metric = stats.units[unit.type];
    metric.deployed++;
    if (result.winner === null) metric.draws++;
    else if (unit.team === result.winner) metric.wins++;
    else metric.losses++;
    metric.kills += unit.kills;
    metric.deaths += Number(!unit.survived);
    metric.survived += Number(unit.survived);
    metric.shots += unit.shots;
    metric.moves += unit.moves;
    const eraMetric = stats.unitEra[unit.type][stageEra(result.stage)];
    eraMetric.deployed++;
    if (result.winner === null) eraMetric.draws++;
    else if (unit.team === result.winner) eraMetric.wins++;
    else eraMetric.losses++;
    eraMetric.kills += unit.kills;
    eraMetric.deaths += Number(!unit.survived);
    eraMetric.survived += Number(unit.survived);
    eraMetric.shots += unit.shots;
    eraMetric.moves += unit.moves;
  }
}

function recordDuel(stats: BatchStats, result: GameResult, pair: [PatternId, PatternId]): void {
  stats.games++;
  stats.duelGames++;
  const [left, right] = pair;
  const leftCell = stats.duels[left][right];
  const rightCell = stats.duels[right][left];
  for (const [cell, team] of [[leftCell, 0], [rightCell, 1]] as [DuelMetrics, number][]) {
    cell.games++;
    cell.rounds += result.rounds;
    if (result.winner === null) cell.draws++;
    else if (result.winner === team) cell.wins++;
    else cell.losses++;
  }
}

export function mergeStats(target: BatchStats, source: BatchStats): void {
  target.games += source.games;
  target.rosterGames += source.rosterGames;
  target.duelGames += source.duelGames;
  target.wins[0] += source.wins[0];
  target.wins[1] += source.wins[1];
  target.draws += source.draws;
  target.captures += source.captures;
  target.eliminations += source.eliminations;
  target.attritionWins += source.attritionWins;
  target.mutualDraws += source.mutualDraws;
  target.totalRounds += source.totalRounds;
  target.totalSurvivors += source.totalSurvivors;
  target.totalKills += source.totalKills;
  if (source.minRounds !== null) target.minRounds = target.minRounds === null ? source.minRounds : Math.min(target.minRounds, source.minRounds);
  if (source.maxRounds !== null) target.maxRounds = target.maxRounds === null ? source.maxRounds : Math.max(target.maxRounds, source.maxRounds);
  const mergeUnits = (a: UnitMetrics, b: UnitMetrics) => {
    a.deployed += b.deployed; a.wins += b.wins; a.draws += b.draws; a.losses += b.losses;
    a.kills += b.kills; a.deaths += b.deaths; a.survived += b.survived; a.shots += b.shots; a.moves += b.moves;
  };
  for (const id of PATTERN_IDS) {
    mergeUnits(target.units[id], source.units[id]);
    for (const era of ['opening', 'middle', 'late'] as EraKey[]) mergeUnits(target.unitEra[id][era], source.unitEra[id][era]);
    for (const opponent of PATTERN_IDS) {
      const a = target.duels[id][opponent];
      const b = source.duels[id][opponent];
      a.games += b.games; a.wins += b.wins; a.draws += b.draws; a.losses += b.losses; a.rounds += b.rounds;
    }
  }
  for (const stage of Object.keys(source.stages)) {
    const key = Number(stage);
    if (!target.stages[key]) target.stages[key] = { games: 0, wins: 0, draws: 0, captures: 0 };
    target.stages[key].games += source.stages[key].games;
    target.stages[key].wins += source.stages[key].wins;
    target.stages[key].draws += source.stages[key].draws;
    target.stages[key].captures += source.stages[key].captures;
  }
}

function mutateGlobal(champion: Policy, rng: Random, index: number): Policy {
  const fields = Object.keys(champion) as (keyof Policy)[];
  const result = { ...champion };
  const first = fields[(index + rng.int(0, fields.length - 1)) % fields.length];
  const second = rng.pick(fields.filter((field) => field !== first));
  for (const field of [first, second]) {
    const change = (rng.next() < 0.5 ? -1 : 1) * (0.13 + rng.next() * 0.25);
    result[field] = Math.max(0.22, Math.min(3.6, +(result[field] * (1 + change)).toFixed(3)));
  }
  return result;
}

/**
 * A challenger differs from the champion in two ways: two global policy
 * weights AND two per-unit behavior weights, so the search can specialize
 * units individually (e.g. making the Sniper braver while the Harrier slows down).
 */
const PROFILE_FIELD_LIST = PROFILE_FIELDS as readonly (keyof UnitProfile)[];

function mutateProfileDeltas(champion: ProfileDeltas, rng: Random): ProfileDeltas {
  const result: ProfileDeltas = {};
  for (const [id, delta] of Object.entries(champion)) {
    if (delta) result[id as PatternId] = { ...delta };
  }
  for (const id of rng.shuffle([...PATTERN_IDS]).slice(0, 2)) {
    const field = rng.pick([...PROFILE_FIELD_LIST]);
    const current = champion[id]?.[field];
    const baseValue = UNIT_PROFILES[id][field];
    const value = (typeof current === 'number' ? current : typeof baseValue === 'number' ? baseValue : 1)
      * (1 + (rng.next() < 0.5 ? -1 : 1) * (0.1 + rng.next() * 0.2));
    const delta = (result[id] ||= {}) as Record<string, number | boolean | undefined>;
    delta[field] = Math.max(0, Math.min(3.2, +value.toFixed(3)));
  }
  return result;
}

function outcome(result: GameResult, candidateTeam: 0 | 1): number {
  return result.winner === null ? 0.5 : result.winner === candidateTeam ? 1 : 0;
}

async function yieldControl(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export type TrainingResult = { learning: LearningState; training: TrainingRecord };
export type TrainingTrial = {
  mode: TurnMode;
  seed: number;
  stage: number;
  candidate: Policy;
  candidateDeltas: ProfileDeltas;
  champion: Policy;
  championDeltas: ProfileDeltas;
};
export type TrialExecutor = (trials: TrainingTrial[], onCompleted: () => void) => Promise<Array<number | null>>;

// A trial is a matched pair of genuine candidate-vs-champion games. The
// candidate changes seats while the seed, map and roster stay the same.
export function evaluateTrainingTrial(trial: TrainingTrial): number {
  const options = { stage: trial.stage, mode: trial.mode, maxRounds: 30, firstSide: (trial.seed % 2) as 0 | 1 };
  setTeamProfileOverlays([trial.candidateDeltas, trial.championDeltas]);
  const first = outcome(simulateGame(trial.seed, options, [trial.candidate, trial.champion]), 0);
  setTeamProfileOverlays([trial.championDeltas, trial.candidateDeltas]);
  const second = outcome(simulateGame(trial.seed, options, [trial.champion, trial.candidate]), 1);
  return first + second;
}

export async function runTraining(
  settings: RunSettings,
  startingLearning: LearningState,
  onProgress: (progress: Progress) => void = () => {},
  isCancelled: () => boolean = () => false,
  executeTrials?: TrialExecutor,
): Promise<TrainingResult | null> {
  let learning: LearningState = {
    ...startingLearning,
    champion: { ...startingLearning.champion },
    profileDeltas: JSON.parse(JSON.stringify(startingLearning.profileDeltas || {})),
    history: [...startingLearning.history],
  };
  const adapted = learning.patternFingerprint !== patternFingerprint();
  learning = adaptLearningToPatterns(learning);
  const stages = playableStages(settings.era);
  const fixtureCount = 6;
  const trainingTotal = 4 * fixtureCount * 2;
  let trainingCompleted = 0;
  const rng = new Random(settings.seed);
  const fixtures = Array.from({ length: fixtureCount }, () => ({ seed: rng.int(1, 0x7fffffff), stage: rng.pick(stages) }));
  const validation = Array.from({ length: fixtureCount }, () => ({ seed: rng.int(1, 0x7fffffff), stage: rng.pick(stages) }));
  const candidates = Array.from({ length: 3 }, (_, index) => ({
    policy: mutateGlobal(learning.champion, rng, index + learning.generation),
    deltas: mutateProfileDeltas(learning.profileDeltas, rng),
  }));
  const makeTrial = (candidate: typeof candidates[number], fixture: { seed: number; stage: number }): TrainingTrial => ({
    mode: settings.mode, ...fixture, candidate: candidate.policy, candidateDeltas: candidate.deltas,
    champion: learning.champion, championDeltas: learning.profileDeltas,
  });
  const completed = () => {
    trainingCompleted += 2;
    onProgress({ phase: 'training', completed: 0, total: settings.games, trainingCompleted, trainingTotal });
  };
  const evaluate = async (trials: TrainingTrial[]) => {
    if (executeTrials) return executeTrials(trials, completed);
    const scores: Array<number | null> = [];
    for (const trial of trials) {
      if (isCancelled()) return [...scores, null];
      scores.push(evaluateTrainingTrial(trial));
      completed();
      await yieldControl();
    }
    return scores;
  };
  const scores = await evaluate(candidates.flatMap((candidate) => fixtures.map((fixture) => makeTrial(candidate, fixture))));
  if (isCancelled() || scores.length !== candidates.length * fixtures.length || scores.some((score) => score === null)) {
    setProfileOverlays(learning.profileDeltas);
    return null;
  }
  let bestIndex = 0;
  let bestScore = -Infinity;
  for (let index = 0; index < candidates.length; index++) {
    const score = (scores.slice(index * fixtureCount, (index + 1) * fixtureCount) as number[])
      .reduce((sum, value) => sum + value, 0) / (fixtureCount * 2);
    if (score > bestScore) { bestScore = score; bestIndex = index; }
  }
  const bestPolicy = candidates[bestIndex].policy;
  const bestDeltas = candidates[bestIndex].deltas;
  const validationResults = await evaluate(validation.map((fixture) => makeTrial(candidates[bestIndex], fixture)));
  if (isCancelled() || validationResults.length !== validation.length || validationResults.some((score) => score === null)) {
    setProfileOverlays(learning.profileDeltas);
    return null;
  }
  let validationScore = (validationResults as number[]).reduce((sum, value) => sum + value, 0);
  // Restore overlays to the champion before returning; the measurement phase
  // resets them explicitly, but training fixtures must never leak overlays.
  setProfileOverlays(learning.profileDeltas);
  validationScore /= validation.length * 2;
  const promoted = bestScore >= 0.56 && validationScore >= 0.54 && (bestScore + validationScore) / 2 > 0.56;
  learning.generation++;
  learning.trainingGames += trainingTotal;
  if (promoted) {
    learning.version++;
    learning.champion = bestPolicy;
    learning.profileDeltas = bestDeltas;
    setProfileOverlays(learning.profileDeltas);
  }
  const training: TrainingRecord = {
    generation: learning.generation, promoted, candidateScore: bestScore,
    validationScore, games: trainingTotal, version: learning.version, adapted,
  };
  learning.history = [...learning.history.slice(-19), training];
  return { learning, training };
}

export function buildGamePlan(settings: RunSettings): GamePlanItem[] {
  const rng = new Random(settings.seed);
  const stages = playableStages(settings.era);
  const available = PATTERNS.filter((pattern) => pattern.unlock <= Math.max(...stages));
  const pairs: [PatternId, PatternId][] = [];
  for (let i = 0; i < available.length; i++) {
    for (let j = i; j < available.length; j++) pairs.push([available[i].id, available[j].id]);
  }
  const shuffled = rng.shuffle(pairs);
  const duelTarget = Math.min(Math.floor(settings.games * 0.38), settings.games - 1);
  const plan: GamePlanItem[] = [];
  let duelDone = 0;
  let previousDuelSeed = 1;
  for (let i = 0; i < settings.games; i++) {
    const shouldDuel = duelDone < Math.floor(((i + 1) * duelTarget) / settings.games);
    if (shouldDuel) {
      const pair = shuffled[Math.floor(duelDone / 2) % shuffled.length];
      const mirrored: [PatternId, PatternId] = duelDone % 2 === 0 ? pair : [pair[1], pair[0]];
      const seed = duelDone % 2 === 0 ? rng.int(1, 0x7fffffff) : previousDuelSeed;
      previousDuelSeed = seed;
      plan.push({ kind: 'duel', pair: mirrored, seed });
      duelDone++;
    } else {
      plan.push({ kind: 'roster', stage: rng.pick(stages), seed: rng.int(1, 0x7fffffff) });
    }
  }
  return plan;
}

export async function runSlice(
  settings: RunSettings,
  learning: LearningState,
  plan: GamePlanItem[],
  from: number,
  to: number,
  onProgress: (progress: Progress) => void = () => {},
  isCancelled: () => boolean = () => false,
): Promise<SliceResult | null> {
  const stats = emptyStats();
  setProfileOverlays(learning.profileDeltas);
  const champion: [Policy, Policy] = [learning.champion, learning.champion];
  const span = to - from;
  let preview = emptyPreview(settings);
  for (let i = from; i < to; i++) {
    const item = plan[i];
    if (item.kind === 'duel') {
      // A lone duel in simultaneous mode is dominated by mutual evasion. Keep
      // controlled comparisons in alternating order so geometry reaches contact.
      const result = simulateGame(item.seed, { duel: item.pair, mode: 'sequential', maxRounds: 20,
        firstSide: (item.seed % 2) as 0 | 1 }, champion);
      recordDuel(stats, result, item.pair);
    } else {
      const result = simulateGame(item.seed, { stage: item.stage, mode: settings.mode,
        firstSide: (item.seed % 2) as 0 | 1 }, champion);
      recordRoster(stats, result);
      if (i % 40 === 0) preview = result.snapshot;
    }
    const completed = i - from + 1;
    if (completed % 8 === 0 || completed === span) {
      // postMessage already clones the data. Avoid an additional JSON
      // serialization on every worker update.
      if (completed % 24 === 0 || completed === span) onProgress({
        phase: item.kind === 'duel' ? 'duels' : 'rosters',
        completed, total: span, trainingCompleted: 0, trainingTotal: 0,
        stats, preview,
      });
      await yieldControl();
      if (isCancelled()) return null;
    }
  }
  return { stats, preview, completed: span };
}

function emptyPreview(settings: RunSettings): BoardSnapshot {
  const rng = new Random(settings.seed + 777);
  const stages = playableStages(settings.era);
  return snapshot(createScenario(rng.int(1, 0x7fffffff), { stage: rng.pick(stages), mode: settings.mode }));
}

export async function runBatch(
  settings: RunSettings,
  startingLearning: LearningState,
  onProgress: (progress: Progress) => void = () => {},
  isCancelled: () => boolean = () => false,
): Promise<BatchResult | null> {
  const started = Date.now();
  const training = await runTraining(settings, startingLearning, onProgress, isCancelled);
  if (!training) return null;
  const plan = buildGamePlan(settings);
  const slice = await runSlice(settings, training.learning, plan, 0, plan.length, onProgress, isCancelled);
  if (!slice) return null;
  return {
    settings, stats: slice.stats, learning: training.learning, training: training.training,
    preview: slice.preview, generatedAt: new Date().toISOString(), durationMs: Date.now() - started,
  };
}

export function fieldWinRate(unit: UnitMetrics): number {
  return unit.deployed ? (unit.wins + 0.5 * unit.draws) / unit.deployed : 0;
}

export function duelScore(cell: DuelMetrics): number {
  return cell.games ? (cell.wins + 0.5 * cell.draws) / cell.games : 0.5;
}

export function duelAggregate(stats: BatchStats, id: PatternId): DuelMetrics {
  const result = emptyDuel();
  for (const opponent of PATTERN_IDS) {
    if (id === opponent) continue;
    const cell = stats.duels[id][opponent];
    result.games += cell.games;
    result.wins += cell.wins;
    result.draws += cell.draws;
    result.losses += cell.losses;
    result.rounds += cell.rounds;
  }
  return result;
}

export function confidenceMargin(score: number, games: number): number {
  return games ? 1.96 * Math.sqrt(Math.max(0.01, score * (1 - score)) / games) : 0;
}

export function isLearningState(value: unknown): value is LearningState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<LearningState>;
  return typeof state.generation === 'number' && typeof state.version === 'number'
    && !!state.champion && (Object.keys(DEFAULT_POLICY) as (keyof Policy)[])
      .every((key) => typeof state.champion?.[key] === 'number' && Number.isFinite(state.champion[key]));
}


