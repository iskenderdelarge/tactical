import {
  applySingle, finishSequentialRound, legalActions, resolveSimultaneous,
  type Action, type GameState, type ResolutionPhase, type Team,
} from '../sim/engine';
import type { RulesetSnapshot } from '../sim/config';
import { PATTERN_IDS, distance, type Hex } from '../sim/patterns';

export type WireGame = Omit<GameState, 'terrain'> & { terrain: string[] };
export type AttackEffect = { from: Hex; to: Hex; channel: Action['channel'] };
export type PlayFrame = { phase: ResolutionPhase | 'action'; game: GameState; attacks: AttackEffect[] };
export type WireFrame = Omit<PlayFrame, 'game'> & { game: WireGame };
export type RoomSnapshot = {
  game: WireGame;
  phase: 'setup' | 'battle';
  turnMode: GameState['mode'];
  firstSide: Team;
  activeSide: Team;
  ready: [boolean, boolean];
  revision: number;
  seed: number;
  stage: number;
  rules: RulesetSnapshot;
  frames?: WireFrame[];
};

export type RoomMessage =
  | { type: 'snapshot'; snapshot: RoomSnapshot }
  | { type: 'action'; revision: number; action: Action }
  | { type: 'orders'; revision: number; orders: Action[] }
  | { type: 'rejected'; message: string };

function isHex(value: unknown): value is Hex {
  if (!value || typeof value !== 'object') return false;
  const hex = value as Partial<Hex>;
  return Number.isInteger(hex.q) && Number.isInteger(hex.r)
    && Math.abs(hex.q!) <= 64 && Math.abs(hex.r!) <= 64;
}

function isWireGame(value: unknown, compact = true): value is WireGame {
  if (!value || typeof value !== 'object') return false;
  const game = value as Partial<WireGame>;
  const ids = new Set<number>();
  return Array.isArray(game.units) && game.units.length <= 30 && game.units.every((unit, index) => {
    if (!unit || !Number.isInteger(unit.uid) || unit.uid < 0 || unit.uid >= 256 || ids.has(unit.uid)
      || (compact && unit.uid !== index) || !PATTERN_IDS.includes(unit.type)
      || (unit.team !== 0 && unit.team !== 1) || !isHex(unit.pos)
      || typeof unit.alive !== 'boolean' || typeof unit.acted !== 'boolean') return false;
    ids.add(unit.uid);
    return true;
  })
    && Array.isArray(game.cities) && game.cities.length === 2 && game.cities.every(isHex)
    && Array.isArray(game.mountains) && game.mountains.length <= 252 && game.mountains.every(isHex)
    && Array.isArray(game.terrain) && game.terrain.length <= 254 && game.terrain.every((tile) => typeof tile === 'string')
    && Number.isInteger(game.round) && (game.round ?? -1) >= 0 && typeof game.finished === 'boolean';
}

// A room is peer-hosted, but remote messages still need shape and size checks
// before they are turned into board or editor state.
export function isRoomSnapshot(value: unknown): value is RoomSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<RoomSnapshot>;
  const rules = snapshot.rules;
  if (!isWireGame(snapshot.game, snapshot.phase === 'battle') || !Number.isInteger(snapshot.revision) || (snapshot.revision ?? -1) < 0
    || (snapshot.phase !== 'setup' && snapshot.phase !== 'battle')
    || (snapshot.turnMode !== 'sequential' && snapshot.turnMode !== 'simultaneous')
    || (snapshot.firstSide !== 0 && snapshot.firstSide !== 1)
    || (snapshot.activeSide !== 0 && snapshot.activeSide !== 1)
    || !Array.isArray(snapshot.ready) || snapshot.ready.length !== 2 || !snapshot.ready.every((ready) => typeof ready === 'boolean')
    || !Number.isInteger(snapshot.seed) || !Number.isInteger(snapshot.stage) || (snapshot.stage ?? 0) < 1 || (snapshot.stage ?? 0) > 40
    || !rules || !Array.isArray(rules.patterns) || rules.patterns.length !== PATTERN_IDS.length
    || !rules.profiles || !rules.eras) return false;
  const ids = new Set<string>();
  for (const pattern of rules.patterns) {
    if (!pattern || !PATTERN_IDS.includes(pattern.id) || ids.has(pattern.id)
      || !Number.isInteger(pattern.unlock) || pattern.unlock < 1 || pattern.unlock > 40) return false;
    ids.add(pattern.id);
    for (const channel of ['green', 'red', 'brown', 'blue'] as const) {
      if (!Array.isArray(pattern[channel]) || pattern[channel].length > 60
        || !pattern[channel].every((hex) => isHex(hex) && distance({ q: 0, r: 0 }, hex) <= 4)) return false;
    }
    const profile = rules.profiles[pattern.id];
    if (!profile || typeof profile.siege !== 'boolean' || !Array.isArray(profile.preferredTargets)) return false;
    for (const key of ['aggression', 'caution', 'objective', 'spacing', 'focus', 'intercept', 'mobility', 'idealRange', 'defense', 'attackPriority'] as const) {
      if (!Number.isFinite(profile[key]) || profile[key] < 0 || profile[key] > 4) return false;
    }
  }
  for (const key of ['opening', 'middle', 'late'] as const) {
    const era = rules.eras[key];
    if (!era || !Number.isInteger(era.start) || !Number.isInteger(era.end) || era.start < 1 || era.end > 40 || era.start > era.end) return false;
  }
  if (snapshot.frames && (!Array.isArray(snapshot.frames) || snapshot.frames.length > 6
    || !snapshot.frames.every((frame) => isWireGame(frame.game) && Array.isArray(frame.attacks)
      && frame.attacks.length <= 30 && frame.attacks.every((effect) => isHex(effect.from) && isHex(effect.to)
        && ['green', 'red', 'brown', 'blue', 'wait'].includes(effect.channel))))) return false;
  return true;
}

export function cloneGame(state: GameState): GameState {
  return { ...state, cities: state.cities.map((hex) => ({ ...hex })) as [Hex, Hex],
    mountains: state.mountains.map((hex) => ({ ...hex })), terrain: new Set(state.terrain),
    units: state.units.map((unit) => ({ ...unit, pos: { ...unit.pos } })) };
}

export function toWire(state: GameState): WireGame {
  return { ...state, terrain: [...state.terrain], units: state.units.map((unit) => ({ ...unit, pos: { ...unit.pos } })) };
}

export function fromWire(state: WireGame): GameState {
  return { ...state, terrain: new Set(state.terrain), units: state.units.map((unit) => ({ ...unit, pos: { ...unit.pos } })) };
}

function matches(a: Action, b: Action): boolean {
  return a.uid === b.uid && a.kind === b.kind && a.channel === b.channel
    && a.target?.q === b.target.q && a.target?.r === b.target.r;
}

export function validAction(state: GameState, side: Team, action: Action): boolean {
  if (!action || !Number.isInteger(action.uid) || !action.target
    || !Number.isInteger(action.target.q) || !Number.isInteger(action.target.r)) return false;
  const unit = state.units[action.uid];
  if (!unit?.alive || unit.uid !== action.uid || unit.team !== side || unit.acted) return false;
  if (action.kind === 'wait') return action.channel === 'wait';
  return legalActions(state, unit).some((candidate) => matches(candidate, action));
}

export function validateOrders(state: GameState, side: Team, orders: Action[]): Action[] | null {
  if (!Array.isArray(orders) || orders.length > state.units.length) return null;
  const ids = new Set<number>();
  for (const order of orders) {
    if (!validAction(state, side, order) || ids.has(order.uid)) return null;
    ids.add(order.uid);
  }
  return state.units.filter((unit) => unit.alive && unit.team === side).map((unit) =>
    orders.find((order) => order.uid === unit.uid)
      ?? { uid: unit.uid, kind: 'wait', channel: 'wait', target: unit.pos });
}

export function singleTransition(state: GameState, side: Team, action: Action, firstSide: Team):
  { game: GameState; activeSide: Team; frames: PlayFrame[] } | null {
  if (!validAction(state, side, action)) return null;
  const game = cloneGame(state);
  const attacker = game.units[action.uid];
  const attacks = action.kind === 'attack' ? [{ from: { ...attacker.pos }, to: { ...action.target }, channel: action.channel }] : [];
  applySingle(game, action);
  let activeSide = side;
  if (!game.finished) {
    const other = (1 - side) as Team;
    const otherCanAct = game.units.some((unit) => unit.alive && unit.team === other && !unit.acted);
    const ownCanAct = game.units.some((unit) => unit.alive && unit.team === side && !unit.acted);
    if (otherCanAct) activeSide = other;
    else if (!ownCanAct) { finishSequentialRound(game); activeSide = firstSide; }
  }
  return { game, activeSide, frames: [{ phase: 'action', game: cloneGame(game), attacks }] };
}

export function simultaneousTransition(state: GameState, a: Action[], b: Action[]):
  { game: GameState; frames: PlayFrame[] } {
  const game = cloneGame(state);
  const frames: PlayFrame[] = [];
  const starts = new Map(state.units.map((unit) => [unit.uid, { ...unit.pos }]));
  resolveSimultaneous(game, [...a, ...b], (phase, current, attacks) => {
    frames.push({ phase, game: cloneGame(current), attacks: attacks.map((attack) => ({
      from: starts.get(attack.uid) ?? attack.target, to: { ...attack.target }, channel: attack.channel,
    })) });
  });
  game.round++;
  for (const unit of game.units) unit.acted = false;
  if (!frames.length) frames.push({ phase: 'move', game: cloneGame(game), attacks: [] });
  return { game, frames };
}

export function toWireFrames(frames: PlayFrame[]): WireFrame[] {
  return frames.map((frame) => ({ ...frame, game: toWire(frame.game) }));
}

export function fromWireFrames(frames: WireFrame[]): PlayFrame[] {
  return frames.map((frame) => ({ ...frame, game: fromWire(frame.game) }));
}