import {
  DIRECTIONS, FAMILIES, PATTERN_BY_ID, PATTERNS, add, distance, hexKey,
  type Hex, type PatternId, type UnitFamily,
} from './patterns';
import { UNIT_PROFILES, patternFingerprint, type UnitProfile } from './config';

// Learned per-unit deltas. Training writes these; a changed pattern geometry
// clears them, so the AI always re-adapts to whatever rules you authored.
type ProfileOverlays = Partial<Record<PatternId, Partial<UnitProfile>>>;
let profileOverlays: [ProfileOverlays, ProfileOverlays] = [{}, {}];

export function setProfileOverlays(overlays: ProfileOverlays = {}): void {
  profileOverlays = [overlays, overlays];
}

export function setTeamProfileOverlays(overlays: [ProfileOverlays, ProfileOverlays]): void {
  profileOverlays = overlays;
}

function autoIdealRange(unit: Unit): number {
  const pattern = PATTERN_BY_ID[unit.type];
  const offsets = pattern.brown.length ? pattern.brown : pattern.blue.length ? pattern.blue : pattern.red;
  if (!offsets.length) return 1;
  const cached = idealRanges.get(offsets);
  if (cached !== undefined) return cached;
  const radii = offsets.map((offset) => distance({ q: 0, r: 0 }, offset)).sort((a, b) => a - b);
  const middle = Math.floor(radii.length / 2);
  const ideal = radii.length % 2 ? radii[middle] : (radii[middle - 1] + radii[middle]) / 2;
  idealRanges.set(offsets, ideal);
  return ideal;
}

const idealRanges = new WeakMap<Hex[], number>();

export function effectiveProfile(unit: Unit): UnitProfile {
  const base = UNIT_PROFILES[unit.type];
  const delta = profileOverlays[unit.team][unit.type];
  const merged = delta ? { ...base, ...delta } : base;
  // 0 means "track the geometry": when the authored firing range changes,
  // the spacing heuristic follows without any retraining.
  if (merged.idealRange > 0) return merged;
  return { ...merged, idealRange: autoIdealRange(unit) };
}

export type Team = 0 | 1;
export type TurnMode = 'sequential' | 'simultaneous';
export type WinReason = 'capture' | 'elimination' | 'attrition' | 'mutual';
export type Policy = {
  kill: number;
  safety: number;
  city: number;
  advance: number;
  range: number;
  mobility: number;
  initiative: number;
};

export const DEFAULT_POLICY: Policy = {
  kill: 2.25, safety: 1.75, city: 1.45, advance: 1.0,
  range: 0.82, mobility: 0.42, initiative: 0.88,
};

// Offset layout: 18 columns by 14 rows. (The previous arena was 12 x 9.)
export const BOARD_WIDTH = 18;
export const BOARD_HEIGHT = 14;
// Search depth uses a smaller cap; actual games have an emergency ceiling and
// are resolved by a decisive attrition tiebreak, never reported as a time draw.
export const MAX_ROUNDS = 120;

export type Unit = {
  uid: number;
  type: PatternId;
  team: Team;
  pos: Hex;
  alive: boolean;
  acted: boolean;
  kills: number;
  shots: number;
  moves: number;
};

export type GameState = {
  units: Unit[];
  cities: [Hex, Hex];
  mountains: Hex[];
  terrain: Set<string>;
  round: number;
  stage: number;
  mode: TurnMode;
  /** Which side opens a round (sequential mode only). */
  firstSide: Team;
  winner: Team | null;
  reason: WinReason | null;
  finished: boolean;
};

export type Action = {
  uid: number;
  kind: 'move' | 'attack' | 'wait';
  channel: 'green' | 'red' | 'brown' | 'blue' | 'wait';
  target: Hex;
};

export type UnitResult = {
  type: PatternId;
  team: Team;
  kills: number;
  survived: boolean;
  shots: number;
  moves: number;
};

export type BoardSnapshot = {
  units: Pick<Unit, 'uid' | 'type' | 'team' | 'pos'>[];
  cities: [Hex, Hex];
  mountains: Hex[];
  round: number;
  stage: number;
  mode: TurnMode;
};

export type GameResult = {
  winner: Team | null;
  reason: WinReason;
  rounds: number;
  stage: number;
  units: UnitResult[];
  snapshot: BoardSnapshot;
};

export type ScenarioOptions = {
  stage?: number;
  duel?: [PatternId, PatternId];
  mode?: TurnMode;
  maxRounds?: number;
  lookahead?: boolean;
  /** Which team's pieces move first in phased simultaneous rounds. */
  firstSide?: Team;
};

export class Random {
  private state: number;
  constructor(seed: number) { this.state = (seed >>> 0) || 0x6d2b79f5; }
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 4294967296;
  }
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)); }
  pick<T>(items: T[]): T { return items[Math.floor(this.next() * items.length)]; }
  shuffle<T>(items: T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
}

export function offsetToHex(col: number, row: number): Hex {
  return { q: col - Math.floor(row / 2), r: row };
}

export function hexToOffset(hex: Hex): { col: number; row: number } {
  return { col: hex.q + Math.floor(hex.r / 2), row: hex.r };
}

export function onBoard(hex: Hex): boolean {
  const col = hex.q + Math.floor(hex.r / 2);
  return hex.r >= 0 && hex.r < BOARD_HEIGHT && col >= 0 && col < BOARD_WIDTH;
}

const ALL_BOARD_HEXES: Hex[] = (() => {
  const hexes: Hex[] = [];
  for (let row = 0; row < BOARD_HEIGHT; row++) {
    for (let col = 0; col < BOARD_WIDTH; col++) hexes.push(offsetToHex(col, row));
  }
  return hexes;
})();

export function boardHexes(): Hex[] {
  return ALL_BOARD_HEXES.slice();
}

function occupancy(state: GameState): Map<string, Unit> {
  const map = new Map<string, Unit>();
  for (const unit of state.units) if (unit.alive) map.set(hexKey(unit.pos), unit);
  return map;
}

function blocked(state: GameState, hex: Hex): boolean {
  return !onBoard(hex) || state.terrain.has(hexKey(hex));
}

// A long move can take any shortest path, but it may never pass through a unit or obstacle.
function clearMovePath(state: GameState, start: Hex, end: Hex, occupied: Map<string, Unit>): boolean {
  const remaining = distance(start, end);
  if (remaining <= 1) return true;
  const frontier: Hex[] = [start];
  const seen = new Set<string>([hexKey(start)]);
  for (let step = remaining; step > 1; step--) {
    const next: Hex[] = [];
    for (const from of frontier) {
      for (const direction of DIRECTIONS) {
        const hex = add(from, direction);
        const key = hexKey(hex);
        if (distance(hex, end) !== step - 1 || seen.has(key) || blocked(state, hex) || occupied.has(key)) continue;
        seen.add(key);
        next.push(hex);
      }
    }
    if (next.length === 0) return false;
    frontier.splice(0, frontier.length, ...next);
  }
  return frontier.some((from) => DIRECTIONS.some((dir) => {
    const hex = add(from, dir);
    return hex.q === end.q && hex.r === end.r;
  }));
}

function cubeRound(q: number, r: number): Hex {
  let x = Math.round(q);
  let z = Math.round(r);
  const y = Math.round(-q - r);
  const dx = Math.abs(x - q);
  const dy = Math.abs(y + q + r);
  const dz = Math.abs(z - r);
  if (dx > dy && dx > dz) x = -y - z;
  else if (dz > dy) z = -x - y;
  return { q: x, r: z };
}

function lineOfSight(state: GameState, from: Hex, to: Hex, team: Team, occupied: Map<string, Unit>): boolean {
  const length = distance(from, to);
  for (let i = 1; i < length; i++) {
    const t = i / length;
    const hex = cubeRound(from.q + (to.q - from.q) * t + 0.000001, from.r + (to.r - from.r) * t + 0.000001);
    const key = hexKey(hex);
    if (blocked(state, hex)) return false;
    const unit = occupied.get(key);
    // Friendly bodies do not block shots. Enemy bodies and terrain do.
    if (unit && unit.team !== team) return false;
  }
  return true;
}

function hasOffset(offsets: Hex[], from: Hex, to: Hex): boolean {
  const q = to.q - from.q;
  const r = to.r - from.r;
  let keys = offsetLookup.get(offsets);
  if (!keys) {
    keys = new Set(offsets.map(hexKey));
    offsetLookup.set(offsets, keys);
  }
  return keys.has(`${q},${r}`);
}

// Pattern arrays are replaced (not mutated) by the editor, so a WeakMap stays
// correct after edits while avoiding thousands of repeated linear scans.
const offsetLookup = new WeakMap<Hex[], Set<string>>();
const offsetRadius = new WeakMap<Hex[], number>();

function maxOffsetRadius(offsets: Hex[]): number {
  let radius = offsetRadius.get(offsets);
  if (radius === undefined) {
    radius = offsets.reduce((max, hex) => Math.max(max, distance({ q: 0, r: 0 }, hex)), 0);
    offsetRadius.set(offsets, radius);
  }
  return radius;
}

export function legalActions(state: GameState, unit: Unit, occupied = occupancy(state)): Action[] {
  if (!unit.alive) return [];
  const pattern = PATTERN_BY_ID[unit.type];
  const actions: Action[] = [];
  const addMovement = (offsets: Hex[], channel: 'green' | 'red') => {
    for (const offset of offsets) {
      const target = add(unit.pos, offset);
      if (blocked(state, target)) continue;
      const other = occupied.get(hexKey(target));
      if (other && (other.team === unit.team && state.mode !== 'simultaneous' || channel === 'green' && other.team !== unit.team)) continue;
      if (!clearMovePath(state, unit.pos, target, occupied)) continue;
      if (other && other.team === unit.team) actions.push({ uid: unit.uid, kind: 'move', channel, target });
      else actions.push({ uid: unit.uid, kind: other ? 'attack' : 'move', channel, target });
    }
  };
  addMovement(pattern.green, 'green');
  addMovement(pattern.red, 'red');
  for (const offset of pattern.blue) {
    const target = add(unit.pos, offset);
    const victim = occupied.get(hexKey(target));
    if (victim && victim.team !== unit.team && clearMovePath(state, unit.pos, target, occupied)) {
      actions.push({ uid: unit.uid, kind: 'attack', channel: 'blue', target });
    }
  }
  for (const offset of pattern.brown) {
    const target = add(unit.pos, offset);
    const victim = occupied.get(hexKey(target));
    if (victim && victim.team !== unit.team && lineOfSight(state, unit.pos, target, unit.team, occupied)) {
      actions.push({ uid: unit.uid, kind: 'attack', channel: 'brown', target });
    }
  }
  return actions;
}

/** Every lethal opening attack; used by both random and manual deployment. */
export function openingThreats(state: GameState): { attacker: Unit; victim: Unit }[] {
  const occupied = occupancy(state);
  const threats: { attacker: Unit; victim: Unit }[] = [];
  for (const attacker of state.units) {
    if (!attacker.alive) continue;
    for (const action of legalActions(state, attacker, occupied)) {
      if (action.kind !== 'attack') continue;
      const victim = occupied.get(hexKey(action.target));
      if (victim && victim.team !== attacker.team) threats.push({ attacker, victim });
    }
  }
  return threats;
}

export function safeToDeploy(state: GameState, proposed: Unit): boolean {
  if (!onBoard(proposed.pos) || state.terrain.has(hexKey(proposed.pos))
    || state.units.some((unit) => unit.alive && hexKey(unit.pos) === hexKey(proposed.pos))) return false;
  if (state.units.every((unit) => !unit.alive || unit.team === proposed.team
    || distance(unit.pos, proposed.pos) > 4)) return true;
  const trial: GameState = { ...state, units: [...state.units, proposed] };
  return openingThreats(trial).length === 0;
}

function canAttack(state: GameState, attacker: Unit, target: Unit, occupied: Map<string, Unit>): boolean {
  const pattern = PATTERN_BY_ID[attacker.type];
  if (hasOffset(pattern.red, attacker.pos, target.pos) || hasOffset(pattern.blue, attacker.pos, target.pos)) {
    return clearMovePath(state, attacker.pos, target.pos, occupied);
  }
  return hasOffset(pattern.brown, attacker.pos, target.pos) && lineOfSight(state, attacker.pos, target.pos, attacker.team, occupied);
}

function attacksCityHex(state: GameState, unit: Unit, hex: Hex, occupied: Map<string, Unit>): boolean {
  const pattern = PATTERN_BY_ID[unit.type];
  if (hasOffset(pattern.red, unit.pos, hex) && clearMovePath(state, unit.pos, hex, occupied)) return true;
  // Blue requires an actual enemy at the destination. Green and brown never threaten a city.
  const occupant = occupied.get(hexKey(hex));
  return !!occupant && occupant.team !== unit.team && hasOffset(pattern.blue, unit.pos, hex)
    && clearMovePath(state, unit.pos, hex, occupied);
}

export function cityCoverage(state: GameState, team: Team, occupied = occupancy(state)): { covered: number; occupied: number } {
  let covered = 0;
  let physicallyOccupied = 0;
  const city = state.cities[1 - team];
  const allies = state.units.filter((unit) => unit.alive && unit.team === team);
  for (const direction of DIRECTIONS) {
    const hex = add(city, direction);
    const occupant = occupied.get(hexKey(hex));
    if (occupant?.team === team) {
      physicallyOccupied++;
      covered++;
    } else if (allies.some((unit) => attacksCityHex(state, unit, hex, occupied))) {
      covered++;
    }
  }
  return { covered, occupied: physicallyOccupied };
}

function checkVictory(state: GameState): void {
  const alive = [0, 0];
  for (const unit of state.units) if (unit.alive) alive[unit.team]++;
  if (!alive[0] || !alive[1]) {
    state.winner = alive[0] === alive[1] ? null : (alive[0] ? 0 : 1);
    state.reason = alive[0] === alive[1] ? 'mutual' : 'elimination';
    state.finished = true;
    return;
  }
  const occupied = occupancy(state);
  const captures = ([0, 1] as Team[]).map((team) => {
    const pressure = cityCoverage(state, team, occupied);
    return pressure.covered === 6 && pressure.occupied > 0;
  });
  if (captures[0] || captures[1]) {
    state.winner = captures[0] === captures[1] ? null : (captures[0] ? 0 : 1);
    state.reason = captures[0] === captures[1] ? 'mutual' : 'capture';
    state.finished = true;
  }
}

function cloneState(state: GameState): GameState {
  return { ...state, units: state.units.map((unit) => ({ ...unit })) };
}

export function applySingle(state: GameState, action: Action): void {
  const unit = state.units[action.uid];
  if (!unit?.alive || unit.acted) return;
  unit.acted = true;
  if (action.kind === 'wait') return;
  if (action.kind === 'attack') {
    const victim = state.units.find((other) => other.alive && other.pos.q === action.target.q && other.pos.r === action.target.r);
    if (!victim || victim.team === unit.team) return;
    victim.alive = false;
    unit.kills++;
    unit.shots++;
    if (action.channel !== 'brown') unit.pos = action.target;
  } else {
    const occupied = state.units.some((other) => other.alive && other.uid !== unit.uid && other.pos.q === action.target.q && other.pos.r === action.target.r);
    if (!occupied) {
      unit.pos = action.target;
      unit.moves++;
    }
  }
  checkVictory(state);
}

export type ResolutionPhase = 'attack' | 'move' | 'action';
export type PhaseObserver = (phase: ResolutionPhase, state: GameState, attacks: Action[]) => void;

/**
 * Simultaneous rounds resolve in two phases.
 * 1. ATTACKS — every legal attack is committed against the pre-move board, so
 *    a targeted unit cannot move away; mutual attacks kill both; melee and
 *    pounce attackers advance into the victim's hex. Attacks take priority
 *    over movement, so a targeted unit's move order is void.
 * 2. MOVEMENT — only survivors move. When two or more units target the same
 *    hex, the collision cancels all of those moves; allied swaps still work.
 */
export function resolveSimultaneous(state: GameState, orders: Action[], observe?: PhaseObserver): void {
  const before = occupancy(state);
  const attacks: { attacker: Unit; victim: Unit; action: Action }[] = [];
  for (const action of orders) {
    if (action.kind !== 'attack') continue;
    const attacker = state.units[action.uid];
    if (!attacker?.alive) continue;
    const victim = before.get(hexKey(action.target));
    if (!victim || victim.team === attacker.team) continue;
    const pattern = PATTERN_BY_ID[attacker.type];
    if (action.channel === 'red' && !hasOffset(pattern.red, attacker.pos, victim.pos)
      || action.channel === 'blue' && !hasOffset(pattern.blue, attacker.pos, victim.pos)
      || action.channel === 'brown' && !hasOffset(pattern.brown, attacker.pos, victim.pos)
      || action.channel === 'green' || action.channel === 'wait') continue;
    if (!canAttack(state, attacker, victim, before)) continue;
    attacks.push({ attacker, victim, action });
  }
  const credited = new Set<number>();
  for (const { attacker, victim } of attacks) {
    attacker.shots++;
    if (!credited.has(victim.uid)) {
      attacker.kills++;
      credited.add(victim.uid);
    }
  }
  for (const { victim } of attacks) victim.alive = false;
  const advances = new Set<string>();
  for (const { attacker, victim, action } of attacks) {
    if (action.channel === 'brown' || !attacker.alive || advances.has(hexKey(victim.pos))) continue;
    attacker.pos = victim.pos;
    advances.add(hexKey(victim.pos));
  }
  checkVictory(state);
  if (attacks.length) observe?.('attack', state, attacks.map(({ action }) => action));
  if (state.finished) return;

  // Movement is validated on the post-attack board; remote orders are
  // re-checked against the movement table because they are untrusted input.
  const board = occupancy(state);
  const moveOrders = new Map<number, Action>();
  for (const action of orders) {
    const mover = state.units[action.uid];
    if (action.kind !== 'move' || !mover?.alive) continue;
    const pattern = PATTERN_BY_ID[mover.type];
    if (blocked(state, action.target)) continue;
    if (!hasOffset(pattern.green, mover.pos, action.target) && !hasOffset(pattern.red, mover.pos, action.target)) continue;
    if (!clearMovePath(state, mover.pos, action.target, board)) continue;
    moveOrders.set(action.uid, action);
  }
  const destinations = new Map<string, number>();
  for (const action of moveOrders.values()) destinations.set(hexKey(action.target), (destinations.get(hexKey(action.target)) || 0) + 1);
  const allowed = new Map<number, boolean>();
  const visiting = new Set<number>();
  const canMove = (uid: number): boolean => {
    const decided = allowed.get(uid);
    if (decided !== undefined) return decided;
    if (visiting.has(uid)) { allowed.set(uid, true); return true; } // allied swap cycle
    const mover = state.units[uid];
    const targetKey = hexKey(moveOrders.get(uid)!.target);
    let result = (destinations.get(targetKey) || 0) === 1; // contested hex: nothing happens
    if (result) {
      const blocker = board.get(targetKey);
      if (blocker && blocker.team !== mover.team) result = false;
      else if (blocker) {
        const allyOrder = moveOrders.get(blocker.uid);
        result = !!allyOrder && allyOrder.target.q === mover.pos.q && allyOrder.target.r === mover.pos.r
          && (visiting.add(uid), canMove(blocker.uid), visiting.delete(uid));
      }
    }
    allowed.set(uid, result);
    return result;
  };
  let moved = false;
  for (const uid of moveOrders.keys()) {
    if (!canMove(uid)) continue;
    const mover = state.units[uid];
    mover.pos = moveOrders.get(uid)!.target;
    mover.moves++;
    moved = true;
  }
  if (moved) checkVictory(state);
  if (moved) observe?.('move', state, []);
}

function valueOf(type: PatternId): number {
  const pattern = PATTERN_BY_ID[type];
  return 0.85 + Math.min(pattern.red.length + pattern.blue.length * 0.55 + pattern.brown.length * 0.65, 20) * 0.035
    + Math.min(pattern.green.length, 18) * 0.012;
}

type ThreatCache = { immediate: Map<string, number[]>; predicted: Map<string, number[]> };
const makeThreatCache = (): ThreatCache => ({ immediate: new Map(), predicted: new Map() });

function dangerAt(state: GameState, unit: Unit, pos: Hex, killedUid = -1,
  occupied = occupancy(state), cache?: ThreatCache): number {
  const key = `${unit.team}:${hexKey(pos)}`;
  let threats = cache?.immediate.get(key);
  if (!threats) {
    threats = [];
    for (const enemy of state.units) {
      if (!enemy.alive || enemy.team === unit.team) continue;
      const pattern = PATTERN_BY_ID[enemy.type];
      if (distance(enemy.pos, pos) > Math.max(maxOffsetRadius(pattern.red), maxOffsetRadius(pattern.blue), maxOffsetRadius(pattern.brown))) continue;
      const melee = (hasOffset(pattern.red, enemy.pos, pos) || hasOffset(pattern.blue, enemy.pos, pos))
        && clearMovePath(state, enemy.pos, pos, occupied);
      const ranged = hasOffset(pattern.brown, enemy.pos, pos)
        && lineOfSight(state, enemy.pos, pos, enemy.team, occupied);
      if (melee || ranged) threats.push(enemy.uid);
    }
    cache?.immediate.set(key, threats);
  }
  return threats.reduce((count, uid) => count + Number(uid !== killedUid), 0);
}

function nearestEnemyDistance(state: GameState, unit: Unit, pos: Hex, killedUid = -1): number {
  let nearest = 20;
  for (const enemy of state.units) {
    if (enemy.alive && enemy.team !== unit.team && enemy.uid !== killedUid) nearest = Math.min(nearest, distance(pos, enemy.pos));
  }
  return nearest;
}

function cityThreatsFrom(state: GameState, unit: Unit, pos: Hex, occupied: Map<string, Unit>): number {
  const pattern = PATTERN_BY_ID[unit.type];
  const city = state.cities[1 - unit.team];
  let threats = 0;
  for (const direction of DIRECTIONS) {
    const ringHex = add(city, direction);
    if (hasOffset(pattern.red, pos, ringHex)) {
      threats++;
    } else {
      const occupant = occupied.get(hexKey(ringHex));
      if (occupant && occupant.team !== unit.team && hasOffset(pattern.blue, pos, ringHex)) threats++;
    }
  }
  // Standing on the ring is itself one of the six physical links in the siege.
  if (DIRECTIONS.some((direction) => {
    const ringHex = add(city, direction);
    return ringHex.q === pos.q && ringHex.r === pos.r;
  })) threats++;
  return threats;
}

function edgeDistance(pos: Hex): number {
  const { col, row } = hexToOffset(pos);
  return Math.min(col, BOARD_WIDTH - 1 - col, row, BOARD_HEIGHT - 1 - row);
}

function canReachInOneTurn(state: GameState, enemy: Unit, destination: Hex, occupied: Map<string, Unit>): boolean {
  if (enemy.pos.q === destination.q && enemy.pos.r === destination.r) return true;
  const pattern = PATTERN_BY_ID[enemy.type];
  // Prediction node: reachability from the unit's own movement table, with
  // occupancy/border/terrain filters. Full path validation happens on actions.
  if (!hasOffset(pattern.green, enemy.pos, destination) && !hasOffset(pattern.red, enemy.pos, destination)) return false;
  if (blocked(state, destination)) return false;
  const blocker = occupied.get(hexKey(destination));
  if (blocker && (blocker.team === enemy.team || !hasOffset(pattern.red, enemy.pos, destination))) return false;
  return clearMovePath(state, enemy.pos, destination, occupied);
}

// "Where can an enemy be next turn and still reach this square?" This is the
// one-ply anticipation layer. Five-ply search then tests the consequences.
function predictedDangerAt(state: GameState, team: Team, pos: Hex, occupied: Map<string, Unit>,
  excludedUid = -1, cache?: ThreatCache): number {
  const key = `${team}:${hexKey(pos)}`;
  let threats = cache?.predicted.get(key);
  if (!threats) {
    threats = [];
    for (const enemy of state.units) {
      if (!enemy.alive || enemy.team === team) continue;
      const pattern = PATTERN_BY_ID[enemy.type];
      const moveRadius = Math.max(maxOffsetRadius(pattern.green), maxOffsetRadius(pattern.red));
      const attackRadius = Math.max(maxOffsetRadius(pattern.red), maxOffsetRadius(pattern.blue), maxOffsetRadius(pattern.brown));
      if (distance(enemy.pos, pos) > moveRadius + attackRadius) continue;
      const canThreaten = (offset: Hex, ranged: boolean) => {
        const origin = { q: pos.q - offset.q, r: pos.r - offset.r };
        if (!canReachInOneTurn(state, enemy, origin, occupied)) return false;
        return ranged ? lineOfSight(state, origin, pos, enemy.team, occupied)
          : clearMovePath(state, origin, pos, occupied);
      };
      if (pattern.red.some((offset) => canThreaten(offset, false))
        || pattern.blue.some((offset) => canThreaten(offset, false))
        || pattern.brown.some((offset) => canThreaten(offset, true))) threats.push(enemy.uid);
    }
    cache?.predicted.set(key, threats);
  }
  return threats.reduce((count, uid) => count + Number(uid !== excludedUid), 0);
}

function friendlySupport(state: GameState, unit: Unit, pos: Hex): number {
  let support = 0;
  for (const ally of state.units) {
    if (!ally.alive || ally.uid === unit.uid || ally.team !== unit.team) continue;
    if (distance(ally.pos, pos) <= 1) support += 0.24;
    else if (distance(ally.pos, pos) <= 2) support += 0.1;
  }
  return support;
}

function coverAdjacency(state: GameState, pos: Hex): number {
  return DIRECTIONS.some((direction) => state.terrain.has(hexKey(add(pos, direction)))) ? 1 : 0;
}

function cityRingLink(state: GameState, unit: Unit, pos: Hex, occupied: Map<string, Unit>): number {
  const pattern = PATTERN_BY_ID[unit.type];
  if (!effectiveProfile(unit).siege) return 0;
  const city = state.cities[1 - unit.team];
  let links = 0;
  for (const direction of DIRECTIONS) {
    const hex = add(city, direction);
    if (hex.q === pos.q && hex.r === pos.r) links += 1;
    else if (hasOffset(pattern.red, pos, hex)) links += 1;
    else {
      const occupant = occupied.get(hexKey(hex));
      if (occupant && occupant.team !== unit.team && hasOffset(pattern.blue, pos, hex)) links += 1;
    }
  }
  return links;
}

function actionScore(state: GameState, action: Action, policy: Policy, occupied = occupancy(state), cache?: ThreatCache): number {
  const unit = state.units[action.uid];
  const profile = effectiveProfile(unit);
  const target = state.units.find((other) => other.alive && other.team !== unit.team
    && other.pos.q === action.target.q && other.pos.r === action.target.r);
  if (action.kind === 'wait') return -4;
  const finalPos = action.kind === 'move' || action.channel !== 'brown' ? action.target : unit.pos;
  const killedUid = action.kind === 'attack' ? target?.uid ?? -1 : -1;
  const beforeEnemy = nearestEnemyDistance(state, unit, unit.pos);
  const afterEnemy = nearestEnemyDistance(state, unit, finalPos, killedUid);
  const beforeCity = distance(unit.pos, state.cities[1 - unit.team]);
  const afterCity = distance(finalPos, state.cities[1 - unit.team]);
  const unitValue = valueOf(unit.type);
  let score = 0;

  if (target && action.kind === 'attack') {
    const preferred = profile.preferredTargets.includes(PATTERN_BY_ID[target.type].family);
    const targetThreat = dangerAt(state, unit, unit.pos, -1, occupied, cache) ? 1.4 : 1;
    score += policy.kill * valueOf(target.type) * (3.8 + profile.attackPriority * 0.55) * targetThreat;
    if (preferred) score += policy.kill * profile.intercept * 2.3;
    // Value-based intercept: when a unit has no family preference, its
    // intercept weight rewards taking the most valuable enemy it can reach.
    if (!profile.preferredTargets.length && profile.intercept > 1) {
      let bestReachable = 0;
      for (const enemy of state.units) {
        if (!enemy.alive || enemy.team === unit.team) continue;
        const enemyPattern = PATTERN_BY_ID[unit.type];
        if (hasOffset(enemyPattern.red, unit.pos, enemy.pos) || hasOffset(enemyPattern.blue, unit.pos, enemy.pos)
          || hasOffset(enemyPattern.brown, unit.pos, enemy.pos)) bestReachable = Math.max(bestReachable, valueOf(enemy.type));
      }
      if (bestReachable > 0 && valueOf(target.type) >= bestReachable - 0.0001) {
        score += policy.kill * (profile.intercept - 1) * 2.3;
      }
    }
    score += policy.kill * profile.focus * (target.alive ? 0.22 : 0);
  }

  score += policy.advance * Math.max(-3, Math.min(3, beforeEnemy - afterEnemy)) * profile.aggression
    * (beforeEnemy < 12 ? 1.5 : 0.6);

  if (profile.siege) {
    score += policy.city * profile.objective * (beforeCity - afterCity) * (afterEnemy === 20 ? 1.2 : 0.55);
    if (distance(finalPos, state.cities[1 - unit.team]) === 1) score += policy.city * profile.objective * 1.25;
    score += policy.city * profile.objective * cityRingLink(state, unit, finalPos, occupied) * 0.9;
    score += policy.city * profile.objective * cityThreatsFrom(state, unit, finalPos, occupied) * 0.35;
  }

  const immediateDanger = dangerAt(state, unit, finalPos, killedUid, occupied, cache);
  const anticipatedDanger = predictedDangerAt(state, unit.team, finalPos, occupied, killedUid, cache);
  const exposure = immediateDanger * 1.1 + anticipatedDanger * 0.9;
  if (exposure > 0) score -= policy.safety * profile.caution * unitValue * (0.3 + Math.min(exposure, 4) * 0.29);
  if (exposure === 0 && dangerAt(state, unit, unit.pos, -1, occupied, cache) > 0) score += policy.safety * profile.caution * 1.05;

  // Terrain, borders and cohesion shape formation. These are not cosmetic:
  // they prevent corner traps and let fragile ranged units keep a screen.
  const edge = edgeDistance(finalPos);
  if (edge === 0) score -= policy.safety * profile.caution * 0.8;
  if (edge === 1) score -= policy.safety * profile.caution * 0.25;
  score += coverAdjacency(state, finalPos) * profile.defense * 0.12;
  score += friendlySupport(state, unit, finalPos) * profile.spacing;
  if (profile.idealRange > 1) {
    const adjacentAllies = state.units.filter((ally) => ally.alive && ally.team === unit.team && ally.uid !== unit.uid
      && distance(ally.pos, finalPos) === 1).length;
    score -= adjacentAllies * profile.spacing * 0.18;
  }

  const pattern = PATTERN_BY_ID[unit.type];
  const enemyInRange = state.units.some((enemy) => enemy.alive && enemy.team !== unit.team && enemy.uid !== killedUid
    && (hasOffset(pattern.red, finalPos, enemy.pos) || hasOffset(pattern.blue, finalPos, enemy.pos)
      || hasOffset(pattern.brown, finalPos, enemy.pos)));
  if (enemyInRange) score += policy.initiative * profile.aggression * (exposure ? 0.4 : 0.95);
  if (pattern.brown.length) {
    const ideal = profile.idealRange;
    score -= policy.range * profile.caution * Math.max(0, ideal - afterEnemy) * (exposure ? 1.05 : 0.7);
    if (afterEnemy === ideal && exposure === 0) score += policy.range * 0.75;
    if (afterEnemy < 2) score -= policy.range * profile.caution * 1.3;
  }
  if (action.kind === 'move') score += policy.mobility * profile.mobility * 0.12;
  if (action.kind === 'move' && afterEnemy === beforeEnemy && afterCity === beforeCity) score -= 0.55;
  if (action.kind === 'move' && !profile.siege && distance(finalPos, state.cities[1 - unit.team]) <= 1) {
    score -= policy.city * 1.1; // Specialists deliberately ignore the siege.
  }
  return score;
}

function rankedActions(state: GameState, team: Team, policy: Policy, reserved?: Set<string>): { action: Action; score: number }[] {
  const occupied = occupancy(state);
  const cache = makeThreatCache();
  const result: { action: Action; score: number }[] = [];
  for (const unit of state.units) {
    if (!unit.alive || unit.team !== team || unit.acted) continue;
    for (const action of legalActions(state, unit, occupied)) {
      if (reserved?.has(hexKey(action.target)) && action.kind === 'move') continue;
      result.push({ action, score: actionScore(state, action, policy, occupied, cache) });
    }
  }
  result.sort((a, b) => b.score - a.score || a.action.uid - b.action.uid);
  return result;
}

function greedyAction(state: GameState, team: Team, policy: Policy): Action | null {
  const ranked = rankedActions(state, team, policy);
  if (ranked.length) return ranked[0].action;
  const unit = state.units.find((candidate) => candidate.alive && candidate.team === team && !candidate.acted);
  return unit ? { uid: unit.uid, kind: 'wait', channel: 'wait', target: unit.pos } : null;
}

function evaluateState(state: GameState, team: Team, policy: Policy): number {
  if (state.finished) return state.winner === null ? 0 : state.winner === team ? 1000 + 20 * (MAX_ROUNDS - state.round) : -1000 - 20 * (MAX_ROUNDS - state.round);
  const occupied = occupancy(state);
  const cache = makeThreatCache();
  const frontage = Math.max(8, distance(state.cities[0], state.cities[1])) / 2;
  let score = 0;
  for (const unit of state.units) {
    if (!unit.alive) continue;
    const side = unit.team === team ? 1 : -1;
    const value = valueOf(unit.type);
    const profile = effectiveProfile(unit);
    score += side * policy.kill * value * 3.5;
    if (profile.siege) score += side * policy.advance * (frontage - distance(unit.pos, state.cities[1 - unit.team])) * 0.25;
    const nearest = nearestEnemyDistance(state, unit, unit.pos);
    if (profile.idealRange > 1 && Math.abs(nearest - profile.idealRange) <= 1) score += side * policy.range * 0.55;
    // The terminal value also weighs what an enemy can do on its NEXT turn,
    // so the search never calls a "safe" square safe when it is an ambush.
    const now = dangerAt(state, unit, unit.pos, -1, occupied, cache);
    const soon = predictedDangerAt(state, unit.team, unit.pos, occupied, -1, cache);
    if (now || soon) score -= side * policy.safety * profile.caution * value * (0.3 + Math.min(now + soon, 4) * 0.18);
    // Adjacent allies cover each other; this is what keeps formations intact.
    const covered = state.units.some((ally) => ally.alive && ally.uid !== unit.uid && ally.team === unit.team
      && distance(ally.pos, unit.pos) === 1);
    if (covered) score += side * profile.defense * 0.18;
  }
  for (const side of [0, 1] as Team[]) {
    const coverage = cityCoverage(state, side, occupied);
    score += (side === team ? 1 : -1) * policy.city * (coverage.covered * coverage.covered * 0.3 + coverage.occupied * 0.6);
  }
  return score;
}

function quickOrders(state: GameState, team: Team, policy: Policy, forced?: Action): Action[] {
  const orders: Action[] = [];
  const used = new Set<number>();
  const occupied = occupancy(state);
  const cache = makeThreatCache();
  const localReserved = new Set([...occupied.keys()]);
  if (forced) {
    orders.push(forced);
    used.add(forced.uid);
    if (forced.kind === 'move') localReserved.add(hexKey(forced.target));
  }
  for (const unit of state.units) {
    if (!unit.alive || unit.team !== team || used.has(unit.uid)) continue;
    const choices = legalActions(state, unit, occupied)
      .filter((action) => action.kind !== 'move' || !localReserved.has(hexKey(action.target)))
      .map((action) => ({ action, score: actionScore(state, action, policy, occupied, cache) }))
      .sort((a, b) => b.score - a.score);
    const action = choices[0]?.action || { uid: unit.uid, kind: 'wait' as const, channel: 'wait' as const, target: unit.pos };
    orders.push(action);
    if (action.kind === 'move') localReserved.add(hexKey(action.target));
  }
  return orders;
}

function sequentialPly(state: GameState, action: Action): GameState {
  const next = cloneState(state);
  applySingle(next, action);
  if (!next.finished && !next.units.some((unit) => unit.alive && !unit.acted)) {
    next.round++;
    for (const unit of next.units) unit.acted = false;
  }
  return next;
}

function pendingSide(state: GameState): Team | null {
  let pending: Team | null = null;
  for (const team of [0, 1] as Team[]) {
    if (state.units.some((unit) => unit.alive && unit.team === team && !unit.acted)) {
      if (pending !== null) return null;
      pending = team;
    }
  }
  return pending;
}

// Three-ply rollout. The engine assumes the opponent answers with their BEST
// available option (a pessimistic top-2, mirroring threat-space practice in
// Gomoku solvers), while its own plies take the best option. Deterministic
// rollouts from repeated positions are memoized, which matters in mirrored
// self-play where the same middlegames recur constantly.
const SEARCH_PLYS = 3;
const rolloutMemo = new Map<string, number>();

function policyTag(policies: [Policy, Policy]): string {
  const shape = (policy: Policy) => Object.values(policy).map((value) => value.toFixed(2)).join(',');
  return shape(policies[0]) + '|' + shape(policies[1])
    + JSON.stringify(profileOverlays[0]) + JSON.stringify(profileOverlays[1]) + `|${patternFingerprint()}`;
}

const terrainKeys = new WeakMap<Set<string>, string>();

function positionKey(state: GameState): string {
  let terrain = terrainKeys.get(state.terrain);
  if (!terrain) {
    terrain = [...state.terrain].sort().join(';');
    terrainKeys.set(state.terrain, terrain);
  }
  return state.units
    .filter((unit) => unit.alive)
    .map((unit) => `${unit.uid}${unit.acted ? 'a' : 'p'}${unit.type}@${unit.pos.q},${unit.pos.r}`)
    .join(';') + `|${state.round % 2}|${state.cities.map(hexKey).join('|')}|${terrain}`;
}

function rolloutValue(state: GameState, team: Team, policies: [Policy, Policy], plies: number, tag: string): number {
  if (state.finished || plies <= 0) return evaluateState(state, team, policies[team]);
  const key = `${tag}|${state.mode}|${team}|${plies}|${positionKey(state)}`;
  const cached = rolloutMemo.get(key);
  if (cached !== undefined) return cached;
  let value: number;
  if (state.mode === 'sequential') {
    const actor = pendingSide(state) ?? ((state.round + state.firstSide) % 2) as Team;
    const options = rankedActions(state, actor, policies[actor]).slice(0, 2);
    if (!options.length) value = evaluateState(state, team, policies[team]);
    else {
      let best = -Infinity;
      let worst = Infinity;
      for (const { action } of options) {
        const next = sequentialPly(state, action);
        const nextValue = rolloutValue(next, team, policies, plies - 1, tag);
        if (actor === team) best = Math.max(best, nextValue);
        else worst = Math.min(worst, nextValue);
      }
      value = actor === team ? best : worst;
    }
  } else {
    const next = cloneState(state);
    resolveSimultaneous(next, [...quickOrders(next, 0, policies[0]), ...quickOrders(next, 1, policies[1])]);
    next.round++;
    for (const unit of next.units) unit.acted = false;
    value = rolloutValue(next, team, policies, plies - 1, tag);
  }
  if (rolloutMemo.size > 16000) rolloutMemo.clear();
  rolloutMemo.set(key, value);
  return value;
}

export function clearSearchMemo(): void {
  rolloutMemo.clear();
}

// Self-play diversity is seeded per game so a seeded match stays reproducible
// while different games still explore different near-tied lines.
let diversityRng = new Random(0x5f356495);

export function setDiversitySeed(seed: number): void {
  diversityRng = new Random((seed ^ 0x5f356495) >>> 0);
}

function strategicAction(state: GameState, team: Team, policies: [Policy, Policy], diverse: boolean): Action | null {
  const ranked = rankedActions(state, team, policies[team]);
  if (!ranked.length) return greedyAction(state, team, policies[team]);
  if (ranked.length === 1) return ranked[0].action;
  // Selective beam: the strongest local action plus two tactical alternatives,
  // each scored by a three-ply rollout of the following exchange.
  const tag = policyTag(policies);
  const scored = ranked.slice(0, 3).map(({ action, score }) => {
    const projected = state.mode === 'sequential'
      ? sequentialPly(state, action)
      : (() => {
        const next = cloneState(state);
        const own = quickOrders(next, team, policies[team], action);
        const other = quickOrders(next, (1 - team) as Team, policies[1 - team]);
        resolveSimultaneous(next, [...own, ...other]);
        next.round++;
        for (const unit of next.units) unit.acted = false;
        return next;
      })();
    return { action, value: rolloutValue(projected, team, policies, SEARCH_PLYS, tag) + score * 0.07 };
  });
  let best = scored[0];
  for (const candidate of scored) if (candidate.value > best.value) best = candidate;
  // Self-play only: sampling a near-tied candidate prevents every generation
  // from collapsing onto one memorized line.
  if (diverse) {
    const near = scored.filter((candidate) => best.value - candidate.value <= 0.15);
    if (near.length > 1) best = near[Math.floor(diversityRng.next() * near.length)];
  }
  return best.action;
}

export function chooseAIAction(state: GameState, team: Team, policy: Policy, opponent: Policy = policy): Action | null {
  return strategicAction(state, team, team === 0 ? [policy, opponent] : [opponent, policy], false);
}

export function chooseSimultaneousOrders(state: GameState, team: Team, policy: Policy, opponent: Policy = policy): Action[] {
  const forced = strategicAction(state, team, team === 0 ? [policy, opponent] : [opponent, policy], false);
  return quickOrders(state, team, policy, forced || undefined);
}

export function finishSequentialRound(state: GameState): void {
  state.round++;
  for (const unit of state.units) unit.acted = false;
}

function pickRoster(stage: number, rng: Random, count: number): PatternId[] {
  const latest = new Map<UnitFamily, PatternId>();
  for (const family of FAMILIES) {
    const available = PATTERNS.filter((pattern) => pattern.family === family && pattern.unlock <= stage)
      .sort((a, b) => a.unlock - b.unlock);
    if (available.length) latest.set(family, available[available.length - 1].id);
  }
  const weights: Partial<Record<UnitFamily, number>> = {
    Melee: 1.55, 'Light cavalry': 1.1, 'Heavy cavalry': 1.05,
    Ranged: 1, Hunter: 0.8, Sniper: 0.75, Harrier: 0.85,
  };
  const pool = [...latest.entries()].flatMap(([family, id]) => Array.from({ length: Math.round((weights[family] || 1) * 10) }, () => id));
  if (!pool.length) throw new Error(`No units are unlocked at tech stage ${stage}.`);
  const roster: PatternId[] = [latest.get('Melee') ?? pool[0]];
  while (roster.length < count) roster.push(rng.pick(pool));
  // Only retained veterans may be older than the version currently buildable at this tech stage.
  let legacyUsed = false;
  const finalRoster = roster.map((id) => {
    const current = PATTERN_BY_ID[id];
    const older = PATTERNS.filter((pattern) => pattern.family === current.family && pattern.unlock < current.unlock);
    if (!legacyUsed && older.length && rng.next() < 0.17) {
      legacyUsed = true;
      return older[older.length - 1].id;
    }
    return id;
  });
  // A city ring has six squares. Keep at most two true Ranged-family units so
  // every one can be deployed adjacent to its own city as specified.
  let ranged = 0;
  const meleeReplacement = latest.get('Melee') ?? pool.find((id) => PATTERN_BY_ID[id].family !== 'Ranged');
  return finalRoster.map((id) => {
    if (PATTERN_BY_ID[id].family !== 'Ranged') return id;
    ranged++;
    return ranged > 2 && meleeReplacement ? meleeReplacement : id;
  });
}

export function createScenario(seed: number, options: ScenarioOptions = {}): GameState {
  const rng = new Random(seed);
  const stage = options.duel ? Math.max(PATTERN_BY_ID[options.duel[0]].unlock, PATTERN_BY_ID[options.duel[1]].unlock)
    : options.stage ?? rng.int(1, 13);
  // Cities occupy random legal tiles well inside opposite ends of the larger arena.
  let left = offsetToHex(rng.int(1, 5), rng.int(1, BOARD_HEIGHT - 2));
  let right = offsetToHex(rng.int(BOARD_WIDTH - 6, BOARD_WIDTH - 2), rng.int(1, BOARD_HEIGHT - 2));
  for (let attempt = 0; distance(left, right) < 10 && attempt < 30; attempt++) {
    left = offsetToHex(rng.int(1, 5), rng.int(1, BOARD_HEIGHT - 2));
    right = offsetToHex(rng.int(BOARD_WIDTH - 6, BOARD_WIDTH - 2), rng.int(1, BOARD_HEIGHT - 2));
  }
  const cities: [Hex, Hex] = [left, right];
  const all = boardHexes();
  const safe = new Set<string>();
  for (const city of cities) {
    for (const hex of all) if (distance(city, hex) <= 2) safe.add(hexKey(hex));
  }
  const mountainCandidates = rng.shuffle(all.filter((hex) => !safe.has(hexKey(hex))));
  const mountains = mountainCandidates.slice(0, options.duel ? 8 : rng.int(9, 14));
  const terrain = new Set([...mountains, ...cities].map(hexKey));
  const units: Unit[] = [];
  const deployment: GameState = { units, cities, mountains, terrain, round: 0, stage,
    mode: options.mode || 'sequential', firstSide: (options.firstSide ?? 0) as Team,
    winner: null, reason: null, finished: false };
  if (options.duel) {
    // A controlled duel must always produce two combatants. Place a random pair
    // at a distance that lets every pattern reach contact within the round cap,
    // while keeping both units away from the city rings.
    const open = all.filter((hex) => !terrain.has(hexKey(hex))
      && distance(hex, cities[0]) > 2 && distance(hex, cities[1]) > 2);
    const fallback = all.filter((hex) => !terrain.has(hexKey(hex)));
    const candidates = open.length >= 2 ? open : fallback;
    for (const first of rng.shuffle(candidates)) {
      const unitA: Unit = { uid: 0, type: options.duel[0], team: 0, pos: first,
        alive: true, acted: false, kills: 0, shots: 0, moves: 0 };
      units.push(unitA);
      const second = rng.shuffle(candidates).find((hex) => {
        const span = distance(first, hex);
        if (span < 4 || span > 8) return false;
        return safeToDeploy(deployment, { ...unitA, uid: 1, type: options.duel![1], team: 1, pos: hex });
      });
      if (second) {
        units.push({ ...unitA, uid: 1, type: options.duel[1], team: 1, pos: second });
        break;
      }
      units.pop();
    }
    if (units.length !== 2) throw new Error('Could not deploy a safe duel pair.');
  } else {
    const unlocked = PATTERNS.filter((pattern) => pattern.unlock <= stage);
    const onlyRanged = unlocked.length > 0 && unlocked.every((pattern) => pattern.family === 'Ranged');
    const count = rng.int(5, onlyRanged ? 6 : 7);
    const rosters: [PatternId[], PatternId[]] = [pickRoster(stage, rng, count), pickRoster(stage, rng, count)];
    const rings: [Hex[], Hex[]] = [[], []];
    const spaces: [Hex[], Hex[]] = [[], []];
    for (const team of [0, 1] as Team[]) {
      const home = cities[team];
      rings[team] = rng.shuffle(DIRECTIONS.map((direction) => add(home, direction))
        .filter((hex) => onBoard(hex) && !terrain.has(hexKey(hex))));
      // Every true Ranged-family unit starts adjacent to its own city. All
      // other units, including Snipers and Hunters, are randomly seeded
      // anywhere legal on the large board, but never in the enemy's home ring.
      spaces[team] = rng.shuffle(all.filter((hex) => !terrain.has(hexKey(hex))
        && distance(hex, cities[1 - team]) >= 5));
    }
    // Protect the city-adjacent slots first, then interleave teams so neither
    // side's deployment gets the entire board before the other can place.
    const schedule = [true, false].flatMap((ranged) => ([0, 1] as Team[])
      .flatMap((team) => rosters[team].filter((type) => (PATTERN_BY_ID[type].family === 'Ranged') === ranged)
        .map((type) => ({ team, type, ranged }))));
    for (const { team, type, ranged } of schedule) {
      const candidates = ranged ? rings[team] : spaces[team];
      const pos = candidates.find((hex) => safeToDeploy(deployment, {
        uid: units.length, type, team, pos: hex, alive: true, acted: false, kills: 0, shots: 0, moves: 0,
      }));
      if (!pos) throw new Error('Could not deploy the roster without opening attacks.');
      units.push({ uid: units.length, type, team, pos, alive: true, acted: false, kills: 0, shots: 0, moves: 0 });
    }
  }
  return deployment;
}

export function snapshot(state: GameState): BoardSnapshot {
  return { units: state.units.filter((unit) => unit.alive).map(({ uid, type, team, pos }) => ({ uid, type, team, pos })),
    cities: state.cities, mountains: state.mountains, round: state.round, stage: state.stage, mode: state.mode };
}

export function simulateGame(seed: number, options: ScenarioOptions = {}, policies: [Policy, Policy] = [DEFAULT_POLICY, DEFAULT_POLICY]): GameResult {
  const state = createScenario(seed, options);
  setDiversitySeed(seed ^ (state.stage << 16));
  const maximum = options.maxRounds ?? MAX_ROUNDS;
  let preview = snapshot(state);
  const seen = new Set<string>();
  while (!state.finished && state.round < maximum) {
    if (state.mode === 'sequential') {
      // Each round opens with a different side so neither keeps the tempo.
      let side = ((state.firstSide + state.round) % 2) as Team;
      let idle = 0;
      while (!state.finished && idle < 2) {
        const action = options.lookahead !== false
          ? strategicAction(state, side, policies, true) : greedyAction(state, side, policies[side]);
        if (action) {
          applySingle(state, action);
          idle = 0;
        } else idle++;
        side = (1 - side) as Team;
      }
      state.round++;
      for (const unit of state.units) unit.acted = false;
    } else {
      const orders: Action[] = [];
      for (const team of [0, 1] as Team[]) {
        const forced = options.lookahead !== false ? strategicAction(state, team, policies, true) : null;
        orders.push(...quickOrders(state, team, policies[team], forced || undefined));
      }
      resolveSimultaneous(state, orders);
      state.round++;
    }
    if (state.round === 3 || state.round === 6) preview = snapshot(state);
    // A deterministic board repeated at the same turn parity will cycle
    // forever. Adjudicate it now instead of computing the same 120 rounds.
    const position = `${state.round % 2}|${state.units.filter((unit) => unit.alive)
      .map((unit) => `${unit.uid}:${unit.pos.q},${unit.pos.r}`).join(';')}`;
    if (seen.has(position)) break;
    seen.add(position);
  }
  if (!state.finished) {
    // Emergency ceiling only. Material, surviving strength and city pressure
    // decide the winner so a normal simulation cannot end as a time draw.
    let bestSide: Team = 0;
    let bestScore = -Infinity;
    let tied = false;
    for (const team of [0, 1] as Team[]) {
      const alive = state.units.filter((unit) => unit.alive && unit.team === team);
      const material = alive.reduce((sum, unit) => sum + valueOf(unit.type), 0);
      const pressure = cityCoverage(state, team).covered;
      const score = material * 10 + pressure * 2 + alive.length * 0.2;
      if (Math.abs(score - bestScore) < 0.0001) tied = true;
      if (score > bestScore) { bestScore = score; bestSide = team; tied = false; }
    }
    state.finished = true;
    state.reason = 'attrition';
    state.winner = tied ? null : bestSide;
  }
  return {
    winner: state.winner, reason: state.reason!, rounds: state.round, stage: state.stage,
    units: state.units.map(({ type, team, kills, alive, shots, moves }) => ({ type, team, kills, survived: alive, shots, moves })),
    snapshot: preview,
  };
}