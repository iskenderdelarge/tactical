import assert from 'node:assert/strict';
import {
  applySingle, cityCoverage, createScenario, effectiveProfile, legalActions, openingThreats, resolveSimultaneous, safeToDeploy,
  setProfileOverlays, setTeamProfileOverlays, simulateGame,
  type Action, type GameState, type Team, type Unit,
} from '../src/sim/engine';
import { PATTERNS, add, distance, hexKey, type Hex, type PatternId } from '../src/sim/patterns';
import { adaptLearningToPatterns, evaluateTrainingTrial, initialLearning } from '../src/sim/batch';
import { applyRuleset, captureRuleset, replacePatternGeometry } from '../src/sim/config';
import { fromWire, isRoomSnapshot, simultaneousTransition, singleTransition, toWire, validateOrders } from '../src/online/match';
import { DEFAULT_POLICY } from '../src/sim/engine';

const at = (q: number, r: number): Hex => ({ q, r });
const unit = (uid: number, type: PatternId, team: Team, pos: Hex): Unit => ({
  uid, type, team, pos, alive: true, acted: false, kills: 0, shots: 0, moves: 0,
});
const state = (units: Unit[], mode: GameState['mode'] = 'sequential', mountains: Hex[] = []): GameState => {
  const cities: [Hex, Hex] = [at(1, 2), at(9, 5)];
  return { units, mode, cities, mountains, terrain: new Set([...cities, ...mountains].map(hexKey)),
    round: 0, stage: 13, firstSide: 0, winner: null, reason: null, finished: false };
};
const includes = (actions: Action[], kind: Action['kind'], target: Hex, channel: Action['channel']) =>
  actions.some((action) => action.kind === kind && action.channel === channel
    && action.target.q === target.q && action.target.r === target.r);

assert.equal(PATTERNS.length, 13);
const counts: Record<PatternId, [number, number, number, number]> = {
  melee1: [0, 4, 0, 0], light1: [4, 6, 0, 0], ranged1: [4, 0, 6, 0],
  melee2: [0, 6, 0, 0], anti: [12, 0, 0, 12], heavy1: [0, 12, 0, 0],
  melee3: [0, 12, 0, 0], ranged2: [6, 0, 12, 0], sniper: [6, 0, 12, 0],
  light2: [6, 12, 0, 0], melee4: [0, 18, 0, 0], heavy2: [0, 12, 12, 0],
  harrier: [26, 6, 0, 0],
};
for (const pattern of PATTERNS) {
  assert.deepEqual([pattern.green.length, pattern.red.length, pattern.brown.length, pattern.blue.length], counts[pattern.id]);
  const offsets = [...pattern.green, ...pattern.red, ...pattern.brown, ...pattern.blue];
  assert.equal(offsets.length, new Set(offsets.map(hexKey)).size, `overlap in ${pattern.id}`);
  for (const offset of offsets) assert.ok(distance(at(0, 0), offset) <= 4);
}

const hunter = PATTERNS.find((pattern) => pattern.id === 'anti')!;
const lightTwo = PATTERNS.find((pattern) => pattern.id === 'light2')!;
const keys = (offsets: Hex[]) => offsets.map(hexKey).sort();
assert.deepEqual(keys(hunter.green), keys([
  { q: 1, r: -2 }, { q: -1, r: -1 }, { q: 0, r: -1 }, { q: 1, r: -1 }, { q: 2, r: -1 },
  { q: -1, r: 0 }, { q: 1, r: 0 }, { q: -2, r: 1 }, { q: -1, r: 1 }, { q: 0, r: 1 },
  { q: 1, r: 1 }, { q: -1, r: 2 },
]));
assert.deepEqual(keys(hunter.blue), keys([
  { q: 2, r: -4 }, { q: -2, r: -2 }, { q: 0, r: -2 }, { q: 2, r: -2 }, { q: 4, r: -2 },
  { q: -2, r: 0 }, { q: 2, r: 0 }, { q: -4, r: 2 }, { q: -2, r: 2 }, { q: 0, r: 2 },
  { q: 2, r: 2 }, { q: -2, r: 4 },
]));
assert.deepEqual(keys(lightTwo.green), keys([
  { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 },
  { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 },
]));

const melee = state([unit(0, 'melee1', 0, at(4, 4)), unit(1, 'melee2', 1, at(5, 4))]);
assert.ok(!includes(legalActions(melee, melee.units[0]), 'attack', at(5, 4), 'red'), 'Melee I cannot strike horizontally');
assert.ok(includes(legalActions(melee, melee.units[0]), 'move', at(4, 3), 'red'));

const cavalry = state([unit(0, 'light1', 0, at(4, 4)), unit(1, 'melee1', 1, at(5, 2))]);
assert.ok(includes(legalActions(cavalry, cavalry.units[0]), 'attack', at(5, 2), 'red'));
const blockedCharge = state([unit(0, 'light1', 0, at(4, 4)), unit(1, 'melee1', 1, at(5, 2))], 'sequential', [at(4, 3), at(5, 3)]);
assert.ok(!includes(legalActions(blockedCharge, blockedCharge.units[0]), 'attack', at(5, 2), 'red'), 'both shortest charge routes are obstructed');

const friendlyScreen = state([unit(0, 'ranged1', 0, at(4, 4)), unit(1, 'melee2', 0, at(5, 4)), unit(2, 'melee2', 1, at(6, 4))]);
const shot = legalActions(friendlyScreen, friendlyScreen.units[0]).find((action) => includes([action], 'attack', at(6, 4), 'brown'));
assert.ok(shot, 'friendlies must be transparent to ranged fire');
applySingle(friendlyScreen, shot);
assert.equal(friendlyScreen.units[2].alive, false);
assert.deepEqual(friendlyScreen.units[0].pos, at(4, 4), 'a brown attack never advances');
const enemyScreen = state([unit(0, 'ranged1', 0, at(4, 4)), unit(1, 'melee2', 1, at(5, 4)), unit(2, 'melee2', 1, at(6, 4))]);
assert.ok(!includes(legalActions(enemyScreen, enemyScreen.units[0]), 'attack', at(6, 4), 'brown'));
const mountainScreen = state([unit(0, 'ranged1', 0, at(4, 4)), unit(1, 'melee2', 1, at(6, 4))], 'sequential', [at(5, 4)]);
assert.ok(!includes(legalActions(mountainScreen, mountainScreen.units[0]), 'attack', at(6, 4), 'brown'));

const counter = state([unit(0, 'anti', 0, at(5, 4)), unit(1, 'melee2', 1, add(at(5, 4), { q: 2, r: -4 }))]);
assert.ok(includes(legalActions(counter, counter.units[0]), 'attack', counter.units[1].pos, 'blue'));
counter.units[1].alive = false;
assert.ok(!includes(legalActions(counter, counter.units[0]), 'move', counter.units[1].pos, 'blue'), 'blue cannot move onto an empty hex');

// Contested hex: two enemies racing for the same empty tile — nothing happens.
const collisionA = state([unit(0, 'melee2', 0, at(3, 4)), unit(1, 'melee2', 1, at(5, 4))], 'simultaneous');
resolveSimultaneous(collisionA, [
  { uid: 0, kind: 'move', channel: 'red', target: at(4, 4) },
  { uid: 1, kind: 'move', channel: 'red', target: at(4, 4) },
]);
assert.deepEqual(collisionA.units.map((u) => u.pos), [at(3, 4), at(5, 4)], 'contested hex cancels both moves');
const collisionB = state([unit(0, 'melee2', 0, at(3, 4)), unit(1, 'melee2', 1, at(5, 4))], 'simultaneous');
resolveSimultaneous(collisionB, [
  { uid: 0, kind: 'move', channel: 'red', target: at(4, 4) },
  { uid: 1, kind: 'move', channel: 'red', target: at(4, 4) },
]);
assert.deepEqual(collisionB.units.map((u) => u.pos), [at(3, 4), at(5, 4)], 'no first-mover side exists in simultaneous mode');

const swap = state([unit(0, 'melee2', 0, at(3, 4)), unit(1, 'melee2', 0, at(4, 4)), unit(2, 'melee2', 1, at(8, 3))], 'simultaneous');
resolveSimultaneous(swap, [
  { uid: 0, kind: 'move', channel: 'red', target: at(4, 4) },
  { uid: 1, kind: 'move', channel: 'red', target: at(3, 4) },
]);
assert.deepEqual(swap.units.slice(0, 2).map((u) => u.pos), [at(4, 4), at(3, 4)]);

const mutual = state([unit(0, 'melee2', 0, at(3, 4)), unit(1, 'melee2', 1, at(4, 4))], 'simultaneous');
resolveSimultaneous(mutual, [
  { uid: 0, kind: 'attack', channel: 'red', target: at(4, 4) },
  { uid: 1, kind: 'attack', channel: 'red', target: at(3, 4) },
]);
assert.equal(mutual.reason, 'mutual');
assert.ok(mutual.units.every((u) => !u.alive));

const focusedFire = state([
  unit(0, 'melee2', 0, at(3, 4)), unit(1, 'melee2', 0, at(4, 3)),
  unit(2, 'melee2', 1, at(4, 4)), unit(3, 'melee2', 1, at(8, 3)),
], 'simultaneous');
resolveSimultaneous(focusedFire, [
  { uid: 0, kind: 'attack', channel: 'red', target: at(4, 4) },
  { uid: 1, kind: 'attack', channel: 'red', target: at(4, 4) },
]);
assert.equal(focusedFire.units[0].kills + focusedFire.units[1].kills, 1, 'one victim gets one kill credit');
assert.equal(focusedFire.units[0].shots + focusedFire.units[1].shots, 2);

const interceptTarget = add(at(4, 4), { q: 2, r: -4 });
const intercept = state([unit(0, 'anti', 0, at(4, 4)), unit(1, 'light1', 1, interceptTarget)], 'simultaneous');
resolveSimultaneous(intercept, [
  { uid: 0, kind: 'attack', channel: 'blue', target: interceptTarget },
  { uid: 1, kind: 'move', channel: 'green', target: add(interceptTarget, { q: 1, r: 0 }) },
]);
assert.equal(intercept.units[1].alive, false, 'Hunter priority cannot whiff when the target retreats');
assert.deepEqual(intercept.units[0].pos, interceptTarget, 'Hunter occupies the intercepted square');

// Attacks beat movement: a unit targeted this round cannot move away.
const trapped = state([unit(0, 'melee2', 0, at(4, 4)), unit(1, 'melee2', 1, at(5, 4))], 'simultaneous');
resolveSimultaneous(trapped, [
  { uid: 0, kind: 'move', channel: 'red', target: at(3, 4) },
  { uid: 1, kind: 'attack', channel: 'red', target: at(4, 4) },
]);
assert.equal(trapped.units[0].alive, false, 'the targeted unit dies even though it ordered a retreat');
assert.deepEqual(trapped.units[1].pos, at(4, 4), 'the attacker occupies the victim\'s hex');

// Ranged attacks are instant too: the target's move order is void.
const rangedShot = state([unit(0, 'ranged2', 0, at(3, 4)), unit(1, 'melee2', 1, at(5, 4))], 'simultaneous');
resolveSimultaneous(rangedShot, [
  { uid: 0, kind: 'attack', channel: 'brown', target: at(5, 4) },
  { uid: 1, kind: 'move', channel: 'red', target: at(6, 4) },
]);
assert.equal(rangedShot.units[1].alive, false, 'ranged fire still kills a retreating target');
assert.deepEqual(rangedShot.units[0].pos, at(3, 4), 'the ranged attacker does not advance');

const siegeRing = [at(10, 5), at(9, 6), at(8, 6), at(8, 5), at(10, 4)];
const siege = state([
  ...siegeRing.map((pos, uid) => unit(uid, 'ranged2', 0, pos)),
  unit(5, 'ranged2', 0, at(9, 3)), unit(6, 'melee2', 1, at(3, 4)),
], 'simultaneous');
resolveSimultaneous(siege, [{ uid: 5, kind: 'move', channel: 'green', target: at(9, 4) }]);
assert.equal(siege.winner, 0, 'city capture is checked after simultaneous movement');
assert.equal(siege.reason, 'capture');

const opening = state([unit(0, 'ranged1', 0, at(4, 4))]);
assert.equal(safeToDeploy(opening, unit(1, 'melee2', 1, at(6, 4))), false,
  'a unit cannot deploy into a ranged opening shot');
assert.equal(safeToDeploy(opening, unit(1, 'melee2', 1, at(8, 4))), true,
  'a safe placement remains possible');
const meleeOpening = state([unit(0, 'melee2', 0, at(4, 4))]);
assert.equal(safeToDeploy(meleeOpening, unit(1, 'melee2', 1, at(5, 4))), false,
  'a unit cannot deploy into a melee opening strike');

// Illegal link-style orders (outside the authored movement table) are ignored.
const forged = state([unit(0, 'melee2', 0, at(4, 4))], 'simultaneous');
resolveSimultaneous(forged, [{ uid: 0, kind: 'move', channel: 'red', target: at(7, 4) }], 0);
assert.deepEqual(forged.units[0].pos, at(4, 4), 'forged move orders are rejected');

// Learned per-unit overlays and geometry-adaptive ideal range.
const sniperTest = state([unit(0, 'sniper', 0, at(4, 4)), unit(1, 'melee2', 1, at(8, 4))], 'simultaneous');
const sniperUnit = sniperTest.units[0];
assert.ok(effectiveProfile(sniperUnit).idealRange === 4, 'sniper auto-tracks its authored fourth-ring geometry');
setProfileOverlays({ sniper: { idealRange: 2, caution: 1.9 } });
assert.equal(effectiveProfile(sniperUnit).idealRange, 2, 'learned delta overrides auto range');
setTeamProfileOverlays([{ sniper: { caution: 0.5 } }, { sniper: { caution: 2.5 } }]);
assert.equal(effectiveProfile(sniperUnit).caution, 0.5, 'candidate profile applies to its own team');
assert.equal(effectiveProfile({ ...sniperUnit, team: 1 }).caution, 2.5, 'opponent retains its own profile');
setProfileOverlays({});

// Editing a pattern invalidates learned unit-specific overlays. Ruleset
// snapshots must restore the editor and worker inputs exactly.
const originalRules = captureRuleset();
const originalLearning = initialLearning();
originalLearning.profileDeltas = { sniper: { caution: 3 } };
replacePatternGeometry('sniper', { brown: [{ q: 2, r: 0 }] });
assert.deepEqual(adaptLearningToPatterns(originalLearning).profileDeltas, {}, 'changed geometry invalidates learned deltas');
assert.equal(effectiveProfile(sniperUnit).idealRange, 2, 'automatic range follows the edited pattern');
applyRuleset(originalRules);
assert.equal(effectiveProfile(sniperUnit).idealRange, 4, 'ruleset snapshot restores original geometry');

const identicalTrial = evaluateTrainingTrial({
  mode: 'sequential', seed: 12345, stage: 7, candidate: DEFAULT_POLICY, champion: DEFAULT_POLICY,
  candidateDeltas: {}, championDeltas: {},
});
assert.equal(identicalTrial, 1, 'identical policies score exactly one point in a mirrored pair');
setProfileOverlays({});

// The online host validates each side, keeps stable unit ids, and emits
// animation frames from actual game resolution rather than planned moves.
const onlineGame = state([unit(0, 'melee2', 0, at(3, 4)), unit(1, 'melee2', 1, at(5, 4))], 'simultaneous');
const roundTrip = fromWire(toWire(onlineGame));
assert.deepEqual(roundTrip, onlineGame, 'network snapshots preserve terrain and units');
const roomSnapshot = { game: toWire(onlineGame), phase: 'battle' as const, turnMode: 'simultaneous' as const,
  firstSide: 0 as const, activeSide: 0 as const, ready: [false, false] as [boolean, boolean],
  revision: 1, seed: 4, stage: 13, rules: captureRuleset() };
assert.ok(isRoomSnapshot(roomSnapshot), 'valid peer snapshot is accepted');
assert.ok(!isRoomSnapshot({ ...roomSnapshot, game: { ...roomSnapshot.game, terrain: null } }), 'malformed network snapshots are rejected');
const aMove: Action = { uid: 0, kind: 'move', channel: 'red', target: at(4, 4) };
const bMove: Action = { uid: 1, kind: 'move', channel: 'red', target: at(4, 4) };
assert.equal(validateOrders(onlineGame, 1, [aMove]), null, 'guest cannot submit the host unit');
assert.ok(validateOrders(onlineGame, 0, [aMove]), 'legal host order is accepted');
assert.ok(singleTransition({ ...onlineGame, mode: 'sequential' }, 1, aMove, 0) === null, 'wrong-side action is rejected');
const animation = simultaneousTransition(onlineGame, [aMove], [bMove]);
assert.deepEqual(animation.game.units.map((candidate) => candidate.pos), [at(3, 4), at(5, 4)], 'contested moves cancel in the network transition');
assert.ok(animation.frames.length >= 1, 'the transition emits animation frames');

const city = state([unit(0, 'ranged2', 0, at(8, 5)), unit(1, 'melee2', 1, at(4, 4))]);
assert.deepEqual(cityCoverage(city, 0), { covered: 1, occupied: 1 }, 'brown ranged squares cannot encircle');

for (let i = 0; i < 250; i++) {
  const scenario = createScenario(i * 104729 + 31, { stage: 1 + i % 13 });
  const teamA = scenario.units.filter((unit) => unit.team === 0);
  const teamB = scenario.units.filter((unit) => unit.team === 1);
  assert.ok(teamA.length >= 5 && teamA.length <= 7, 'Army A must field 5 to 7 units');
  assert.ok(teamB.length >= 5 && teamB.length <= 7, 'Army B must field 5 to 7 units');
  const positions = scenario.units.map((fielded) => hexKey(fielded.pos));
  assert.equal(new Set(positions).size, positions.length, 'two units cannot deploy on one hex');
  assert.equal(openingThreats(scenario).length, 0, 'random rosters have no lethal opening attacks');
  for (const fielded of scenario.units) {
    const pattern = PATTERNS.find((candidate) => candidate.id === fielded.type)!;
    assert.ok(pattern.unlock <= scenario.stage, 'a unit cannot appear before its unlock');
    assert.ok(!scenario.terrain.has(hexKey(fielded.pos)), 'units cannot deploy in terrain or a city');
    if (pattern.family === 'Ranged') {
      assert.equal(distance(scenario.cities[fielded.team], fielded.pos), 1, 'Ranged-family units must start adjacent to their city');
    }
  }
}

for (let i = 0; i < 650; i++) {
  const duel: [PatternId, PatternId] = [
    PATTERNS[i % PATTERNS.length].id,
    PATTERNS[(i * 7 + 3) % PATTERNS.length].id,
  ];
  const scenario = createScenario(i * 7919 + 17, { duel });
  assert.equal(scenario.units.length, 2, 'every controlled duel must field exactly two units');
  assert.notEqual(hexKey(scenario.units[0].pos), hexKey(scenario.units[1].pos));
  assert.ok(distance(scenario.units[0].pos, scenario.units[1].pos) >= 4, 'duelists need room to use their patterns');
  assert.equal(openingThreats(scenario).length, 0, 'controlled duels have no opening attacks');
}

const first = simulateGame(7654321);
const second = simulateGame(7654321);
assert.deepEqual(first, second, 'seeded self-play must be reproducible');

console.log('Engine checks passed: 13 patterns, paths, LoS, attacks, simultaneous resolution, capture coverage, tech and determinism.');