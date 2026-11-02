import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronDown, Copy, Crosshair, Eye, Flag, Link2, Play, RotateCcw, Shuffle, Skull, Trash2, User, Users, Wifi } from 'lucide-react';
import {
  BOARD_HEIGHT, BOARD_WIDTH, boardHexes, chooseAIAction, chooseSimultaneousOrders,
  createScenario, effectiveProfile, hexToOffset, legalActions, openingThreats, safeToDeploy,
  setProfileOverlays,
  type Action, type GameState, type Team, type TurnMode, type Unit,
} from '../sim/engine';
import { adaptLearningToPatterns, type LearningState } from '../sim/batch';
import { applyRuleset, captureRuleset, ERA_BANDS } from '../sim/config';
import { DIRECTIONS, PATTERN_BY_ID, PATTERNS, add, distance, hexKey, type Hex, type PatternId } from '../sim/patterns';
import {
  cloneGame, fromWire, fromWireFrames, isRoomSnapshot, simultaneousTransition, singleTransition,
  toWire, validateOrders,
  type AttackEffect, type PlayFrame, type RoomMessage,
} from '../online/match';
import { usePeerRoom } from '../online/usePeerRoom';

const TEAM_NAMES = ['Army A', 'Army B'];
const COLORS = { a: '#91d6bd', b: '#e8a488' };
const CHANNEL_COLORS = { green: '#72a88c', red: '#c87c5f', brown: '#bb9564', blue: '#5e96a8', wait: '#72a88c' };
const RADIUS = 22;
const COL_STEP = RADIUS * Math.sqrt(3);
const ROW_STEP = RADIUS * 1.5;
const MAP_W = 68 + (BOARD_WIDTH - 1) * COL_STEP + COL_STEP / 2;
const MAP_H = 68 + (BOARD_HEIGHT - 1) * ROW_STEP;
const center = (hex: Hex) => {
  const { col, row } = hexToOffset(hex);
  return { x: 34 + col * COL_STEP + (row % 2) * COL_STEP / 2, y: 34 + row * ROW_STEP };
};
const points = (x: number, y: number, radius: number) => Array.from({ length: 6 }, (_, index) => {
  const angle = (Math.PI / 180) * (60 * index - 90);
  return `${x + radius * Math.cos(angle)},${y + radius * Math.sin(angle)}`;
}).join(' ');
const BOARD = boardHexes();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Opponent = 'ai' | 'hotseat' | 'online';
type LogRow = { id: number; round: number; who: string; action: string; target: string };
type Effect = { id: number; kind: 'shot' | 'impact'; from: { x: number; y: number }; to: { x: number; y: number } };
type Glide = { uid: number; type: PatternId; team: Team; from: { x: number; y: number }; to: { x: number; y: number } };

const freshMap = (seed: number, stage: number, mode: TurnMode = 'sequential'): GameState =>
  ({ ...createScenario(seed, { stage, mode }), units: [], round: 0, winner: null, reason: null, finished: false });

const shuffled = <T,>(values: T[]): T[] => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
};

const orderVerb = (order: Action) =>
  order.kind === 'wait' ? 'HOLD'
  : order.kind === 'attack' ? (order.channel === 'brown' ? 'SHOOT' : order.channel === 'blue' ? 'POUNCE' : 'STRIKE')
  : 'MOVE';

const unitLabel = (unit: Unit) => `${PATTERN_BY_ID[unit.type].short}\u00b7${unit.team === 0 ? 'A' : 'B'}`;
const coord = (hex: Hex) => {
  const { col, row } = hexToOffset(hex);
  return `${col},${row}`;
};

function rowsFromAction(prev: GameState, action: Action, final: GameState): Omit<LogRow, 'id'>[] {
  const unit = prev.units.find((candidate) => candidate.uid === action.uid);
  if (!unit || action.kind === 'wait') return [];
  const rows: Omit<LogRow, 'id'>[] = [{ round: prev.round + 1, who: unitLabel(unit), action: orderVerb(action), target: coord(action.target) }];
  for (const victim of prev.units.filter((candidate) => candidate.alive)) {
    if (!final.units.find((candidate) => candidate.uid === victim.uid)?.alive) {
      rows.push({ round: prev.round + 1, who: unitLabel(victim), action: 'KILLED', target: '\u2014' });
    }
  }
  return rows;
}

function rowsFromOrders(prev: GameState, orders: Action[], final: GameState): Omit<LogRow, 'id'>[] {
  const round = prev.round + 1;
  const rows: Omit<LogRow, 'id'>[] = [];
  for (const order of orders) {
    const unit = prev.units.find((candidate) => candidate.uid === order.uid);
    if (!unit?.alive || order.kind === 'wait') continue;
    let target = coord(order.target);
    if (order.kind === 'move') {
      const now = final.units.find((candidate) => candidate.uid === order.uid);
      if (now?.alive && (now.pos.q !== order.target.q || now.pos.r !== order.target.r)) target = 'blocked';
    }
    rows.push({ round, who: unitLabel(unit), action: orderVerb(order), target });
  }
  for (const victim of prev.units.filter((candidate) => candidate.alive)) {
    if (!final.units.find((candidate) => candidate.uid === victim.uid)?.alive) {
      rows.push({ round, who: unitLabel(victim), action: 'KILLED', target: '\u2014' });
    }
  }
  return rows;
}

function rowsFromFrames(prev: GameState, frames: PlayFrame[], final: GameState): Omit<LogRow, 'id'>[] {
  const round = prev.round + 1;
  const rows: Omit<LogRow, 'id'>[] = [];
  for (const frame of frames) for (const effect of frame.attacks) {
    const attacker = prev.units.find((candidate) => candidate.alive && candidate.pos.q === effect.from.q && candidate.pos.r === effect.from.r);
    rows.push({ round, who: attacker ? unitLabel(attacker) : '\u2014', action: orderVerb({ kind: 'attack', channel: effect.channel } as Action), target: coord(effect.to) });
  }
  for (const unit of prev.units.filter((candidate) => candidate.alive)) {
    const now = final.units.find((candidate) => candidate.uid === unit.uid);
    if (!now?.alive) rows.push({ round, who: unitLabel(unit), action: 'KILLED', target: '\u2014' });
    else if (now.pos.q !== unit.pos.q || now.pos.r !== unit.pos.r) rows.push({ round, who: unitLabel(unit), action: 'MOVE', target: `${coord(unit.pos)} \u2192 ${coord(now.pos)}` });
  }
  return rows;
}

function ShotDot({ effect, onDone }: { effect: Effect; onDone: (id: number) => void }) {
  const ref = useRef<SVGCircleElement | null>(null);
  useEffect(() => {
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 850);
      const eased = t * t * (3 - 2 * t);
      const node = ref.current;
      if (node) node.setAttribute('transform', `translate(${effect.from.x + (effect.to.x - effect.from.x) * eased}, ${effect.from.y + (effect.to.y - effect.from.y) * eased})`);
      if (t < 1) frame = requestAnimationFrame(tick);
      else onDone(effect.id);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <circle ref={ref} r="5" fill="#e8c56a" stroke="#7d5f18" strokeWidth="1.2" pointerEvents="none" />;
}

function GlidingUnit({ glide }: { glide: Glide }) {
  const ref = useRef<SVGGElement | null>(null);
  useEffect(() => {
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 900);
      const eased = t * t * (3 - 2 * t);
      ref.current?.setAttribute('transform', `translate(${glide.from.x + (glide.to.x - glide.from.x) * eased} ${glide.from.y + (glide.to.y - glide.from.y) * eased})`);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [glide]);
  const color = glide.team === 0 ? COLORS.a : COLORS.b;
  return <g ref={ref} transform={`translate(${glide.from.x} ${glide.from.y})`} pointerEvents="none" data-gliding-unit={glide.uid}>
    <circle r="15" fill="#172721" stroke={color} strokeWidth="2.5" />
    <text y="3.5" textAnchor="middle" className="unit-letter" fill={color}>{PATTERN_BY_ID[glide.type].short}</text>
  </g>;
}

export function PlayLab({ learning, onBack, initialRoom, legacyInvite }: {
  learning: LearningState;
  onBack: () => void;
  initialRoom?: string | null;
  legacyInvite?: boolean;
}) {
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 2_000_000_000) + 1);
  const [stage, setStage] = useState(13);
  const [game, setGame] = useState<GameState>(() => freshMap(seed, 13));
  const [phase, setPhase] = useState<'setup' | 'battle'>('setup');
  const [opponent, setOpponent] = useState<Opponent>(initialRoom || legacyInvite ? 'online' : 'ai');
  const [turnMode, setTurnMode] = useState<TurnMode>('sequential');
  const [firstSide, setFirstSide] = useState<Team>(0);
  const [setupSide, setSetupSide] = useState<Team>(0);
  const [unitType, setUnitType] = useState<PatternId>('melee2');
  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [side, setSide] = useState<Team>(0);
  const [orderSide, setOrderSide] = useState<Team>(0);
  const [orders, setOrders] = useState<Record<number, Action>>({});
  const [ready, setReady] = useState<[boolean, boolean]>([false, false]);
  const [thinking, setThinking] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [effects, setEffects] = useState<Effect[]>([]);
  const [glides, setGlides] = useState<Glide[]>([]);
  const [showReach, setShowReach] = useState(false);
  const [log, setLog] = useState<LogRow[]>([]);
  const [message, setMessage] = useState('Place both armies, then start the match.');
  const [setupSnapshot, setSetupSnapshot] = useState<Unit[] | null>(null);
  const [linkInput, setLinkInput] = useState('');
  const [copied, setCopied] = useState(false);
  const [requestPending, setRequestPending] = useState(false);
  const room = usePeerRoom();
  const revision = useRef(0);
  const lastReceived = useRef(-1);
  const locked = useRef<[Action[] | null, Action[] | null]>([null, null]);
  const animatingRef = useRef(false);
  const logId = useRef(0);
  const effectId = useRef(0);
  const aiBusy = useRef(false);
  const gameRef = useRef(game);
  const guestRules = useRef(captureRuleset());
  const wasGuest = useRef(false);

  useEffect(() => { gameRef.current = game; }, [game]);

  const holderSide: Team = opponent === 'online' ? (room.role === 'guest' ? 1 : 0)
    : opponent === 'ai' && turnMode === 'simultaneous' ? 0
    : turnMode === 'simultaneous' ? orderSide : side;
  const occupier = useMemo(() => new Map(game.units.filter((unit) => unit.alive)
    .map((unit) => [hexKey(unit.pos), unit])), [game]);
  const selected = game.units.find((unit) => unit.uid === selectedUid && unit.alive);
  const isEnemyInspect = !!selected && selected.team !== holderSide;
  const onlineReady = opponent !== 'online' || room.status === 'connected';
  const canOrder = phase === 'battle' && !game.finished && !animating && !requestPending && onlineReady
    && !thinking && (opponent !== 'online' || !ready[holderSide]);
  const canAct = canOrder && !!selected && !selected.acted && selected.team === holderSide
    && (opponent !== 'online' || (turnMode === 'simultaneous' || side === holderSide));
  type Channel = Action['channel'];
  const actions = canAct && selected ? legalActions(game, selected, occupier) : [];
  const inspectActions = selected && isEnemyInspect ? legalActions(game, selected, occupier) : [];
  const actionMap = new Map(actions.map((action) => [hexKey(action.target), action]));
  const inspectMap = new Map(inspectActions.map((action) => [hexKey(action.target), action.channel]));
  const cityMap = new Map(game.cities.map((city, team) => [hexKey(city), team]));
  const mountain = new Set(game.mountains.map(hexKey));
  const orderedUnits = game.units.filter((unit) => unit.alive && unit.team === holderSide && orders[unit.uid]).length;
  const activeUnits = game.units.filter((unit) => unit.alive && unit.team === holderSide).length;

  const orderTiles = useMemo(() => {
    const map = new Map<string, { channel: Channel; primary: boolean }>();
    if (phase !== 'battle') return map;
    for (const [uid, order] of Object.entries(orders)) {
      const unit = game.units.find((candidate) => candidate.uid === Number(uid) && candidate.alive);
      if (!unit || order.kind === 'wait') continue;
      map.set(hexKey(order.target), { channel: order.channel, primary: unit.uid === selectedUid });
    }
    return map;
  }, [orders, game, phase, selectedUid]);

  const orderLines = useMemo(() => Object.values(orders).flatMap((order) => {
    const unit = game.units.find((candidate) => candidate.alive && candidate.uid === order.uid);
    if (!unit || order.kind === 'wait') return [];
    return [{ uid: unit.uid, from: center(unit.pos), to: center(order.target),
      color: order.kind === 'move' ? '#72a88c' : order.channel === 'brown' ? '#e8c56a' : '#d9826c' }];
  }), [orders, game]);

  const enemyReach = useMemo(() => {
    const map = new Map<string, Channel>();
    if (!showReach || phase !== 'battle' || game.finished) return map;
    for (const unit of game.units) {
      if (!unit.alive || unit.team === holderSide) continue;
      for (const action of legalActions(game, unit)) map.set(hexKey(action.target), action.channel);
    }
    return map;
  }, [showReach, phase, game, holderSide]);

  const pushLog = useCallback((rows: Omit<LogRow, 'id'>[]) => {
    if (!rows.length) return;
    setLog((prev) => [...rows.map((row) => ({ ...row, id: ++logId.current })), ...prev].slice(0, 80));
  }, []);

  const buildEffects = useCallback((attacks: AttackEffect[]): Effect[] =>
    attacks.map((attack) => ({
      id: ++effectId.current,
      kind: attack.channel === 'brown' ? 'shot' as const : 'impact' as const,
      from: center(attack.from),
      to: center(attack.to),
    })), []);

  const playFrames = useCallback(async (frames: PlayFrame[], finalGame: GameState) => {
    animatingRef.current = true;
    setAnimating(true);
    let visible = gameRef.current;
    for (const frame of frames) {
      const moving: Glide[] = visible.units.flatMap((unit) => {
        if (!unit.alive) return [];
        const next = frame.game.units.find((candidate) => candidate.uid === unit.uid && candidate.alive);
        return next && (unit.pos.q !== next.pos.q || unit.pos.r !== next.pos.r)
          ? [{ uid: unit.uid, type: unit.type, team: unit.team, from: center(unit.pos), to: center(next.pos) }]
          : [];
      });
      setGlides(moving);
      setEffects(buildEffects(frame.attacks));
      // Hold the old board beneath the moving pieces. Committing the resolved
      // board here used to unmount captured units and made movement teleport.
      await sleep(950);
      visible = frame.game;
      gameRef.current = visible;
      setGame(visible);
      setGlides([]);
      setEffects([]);
      await sleep(35);
    }
    gameRef.current = finalGame;
    setGame(finalGame);
    setAnimating(false);
    animatingRef.current = false;
  }, [buildEffects]);

  const clearLogIfNewGame = (nextGame: GameState) => {
    if (nextGame.round < gameRef.current.round) setLog([]);
  };

  const snapshotForRoom = useCallback((nextGame: GameState, nextPhase: 'setup' | 'battle', nextSide: Team,
    nextReady: [boolean, boolean], frames: PlayFrame[] = []) => ({
    game: toWire(nextGame), phase: nextPhase, turnMode, firstSide, activeSide: nextSide,
    ready: nextReady, revision: revision.current, seed, stage, rules: captureRuleset(),
    frames: frames.length ? frames.map((frame) => ({ ...frame, game: toWire(frame.game) })) : undefined,
  }), [firstSide, seed, stage, turnMode]);

  const sendSnapshot = useCallback((nextGame: GameState, nextPhase: 'setup' | 'battle', nextSide: Team,
    nextReady: [boolean, boolean], frames: PlayFrame[] = []) => {
    room.send({ type: 'snapshot', snapshot: snapshotForRoom(nextGame, nextPhase, nextSide, nextReady, frames) });
  }, [room.send, snapshotForRoom]);

  const commitSingle = useCallback((action: Action, actor: Team, broadcast: boolean) => {
    const prevGame = gameRef.current;
    const transition = singleTransition(prevGame, actor, action, firstSide);
    if (!transition) {
      if (broadcast) room.send({ type: 'rejected', message: 'That action is no longer legal. Select a unit and try again.' });
      setRequestPending(false);
      return;
    }
    pushLog(rowsFromAction(prevGame, action, transition.game));
    setSide(transition.activeSide);
    setSelectedUid(null);
    setRequestPending(false);
    if (broadcast) {
      revision.current++;
      sendSnapshot(transition.game, 'battle', transition.activeSide, [false, false], transition.frames);
    }
    void playFrames(transition.frames, transition.game);
  }, [firstSide, playFrames, pushLog, room.send, sendSnapshot]);

  const lockedOrdersBoth = (): Action[] => {
    const mine = locked.current[room.role === 'host' ? 0 : 1] ?? [];
    const theirs = locked.current[room.role === 'host' ? 1 : 0] ?? [];
    return [...mine, ...theirs];
  };

  const lockOnlineOrders = useCallback((actor: Team, requested: Action[]) => {
    if (animatingRef.current || phase !== 'battle' || turnMode !== 'simultaneous' || locked.current[actor]) return;
    const prevGame = gameRef.current;
    const valid = validateOrders(prevGame, actor, requested);
    if (!valid) {
      room.send({ type: 'rejected', message: 'One or more orders are illegal. Please select the orders again.' });
      setRequestPending(false);
      return;
    }
    locked.current[actor] = valid;
    const nextReady: [boolean, boolean] = [!!locked.current[0], !!locked.current[1]];
    setReady(nextReady);
    setRequestPending(false);
    if (nextReady[0] && nextReady[1]) {
      const bothOrders = lockedOrdersBoth();
      const transition = simultaneousTransition(prevGame, locked.current[0]!, locked.current[1]!);
      locked.current = [null, null];
      revision.current++;
      setReady([false, false]);
      setOrders({});
      setSelectedUid(null);
      pushLog(rowsFromOrders(prevGame, bothOrders, transition.game));
      setMessage(`Round ${transition.game.round} resolved. Set your next orders.`);
      sendSnapshot(transition.game, 'battle', firstSide, [false, false], transition.frames);
      void playFrames(transition.frames, transition.game);
    } else {
      setMessage(`${TEAM_NAMES[actor]} locked orders. Waiting for the other player.`);
      sendSnapshot(prevGame, 'battle', side, nextReady);
    }
  }, [firstSide, phase, playFrames, pushLog, room.role, room.send, sendSnapshot, side, turnMode]);

  useEffect(() => {
    if (initialRoom) room.join(initialRoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRoom]);

  useEffect(() => {
    if (room.role === 'guest') wasGuest.current = true;
  }, [room.role]);

  useEffect(() => () => {
    if (wasGuest.current) {
      applyRuleset(guestRules.current);
      setProfileOverlays(adaptLearningToPatterns(learning).profileDeltas);
    }
  }, [learning]);

  useEffect(() => {
    room.setHandler((payload: RoomMessage) => {
      if (payload.type === 'snapshot' && room.role === 'guest') {
        if (!isRoomSnapshot(payload.snapshot) || payload.snapshot.revision < lastReceived.current) return;
        const incoming = payload.snapshot;
        const nextGame = fromWire(incoming.game);
        const changed = incoming.revision !== lastReceived.current;
        const prevGame = gameRef.current;
        applyRuleset(incoming.rules);
        guestRules.current = captureRuleset();
        lastReceived.current = incoming.revision;
        revision.current = incoming.revision;
        setSeed(incoming.seed); setStage(incoming.stage); setTurnMode(incoming.turnMode);
        setFirstSide(incoming.firstSide); setSide(incoming.activeSide); setReady(incoming.ready);
        setPhase(incoming.phase); setRequestPending(false);
        if (changed) { setOrders({}); setSelectedUid(null); clearLogIfNewGame(nextGame); }
        if (changed && incoming.frames?.length) {
          const frames = fromWireFrames(incoming.frames);
          pushLog(rowsFromFrames(prevGame, frames, nextGame));
          void playFrames(frames, nextGame);
        } else if (changed) setGame(nextGame);
        if (incoming.phase === 'setup') setMessage('Connected. The host is setting up both armies.');
        else if (incoming.turnMode === 'simultaneous') setMessage(incoming.ready[1]
          ? 'Orders locked. Waiting for Army A.' : 'Set your orders, then lock them for the round.');
        else setMessage(incoming.activeSide === 1 ? 'Your turn as Army B.' : 'Waiting for Army A to move.');
      } else if (payload.type === 'action' && room.role === 'host') {
        if (payload.revision !== revision.current || phase !== 'battle' || turnMode !== 'sequential' || side !== 1 || animatingRef.current) {
          room.send({ type: 'rejected', message: 'Not your turn or the board changed. Wait for the next update.' });
          return;
        }
        commitSingle(payload.action, 1, true);
      } else if (payload.type === 'orders' && room.role === 'host') {
        if (payload.revision !== revision.current) {
          room.send({ type: 'rejected', message: 'The round changed. Please enter your orders again.' });
          return;
        }
        lockOnlineOrders(1, payload.orders);
      } else if (payload.type === 'rejected' && room.role === 'guest') {
        setRequestPending(false);
        setMessage(payload.message);
      }
    });
  }, [commitSingle, lockOnlineOrders, phase, playFrames, pushLog, room.role, room.send, room.setHandler, side, turnMode]);

  useEffect(() => {
    if (opponent === 'online' && room.role === 'host' && room.status === 'connected' && phase === 'setup') {
      revision.current++;
      sendSnapshot(game, phase, firstSide, [false, false]);
    }
  }, [opponent, room.role, room.status, phase, game, firstSide, sendSnapshot]);

  useEffect(() => {
    if (opponent === 'online' && room.role === 'host' && room.status === 'connected' && phase === 'battle') {
      sendSnapshot(game, phase, side, ready);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.status, room.role, opponent]);

  const perform = useCallback((action: Action) => {
    if (!canAct) return;
    if (opponent === 'online' && room.role === 'guest') {
      if (room.send({ type: 'action', revision: revision.current, action })) setRequestPending(true);
    } else {
      commitSingle(action, holderSide, opponent === 'online' && room.role === 'host');
    }
  }, [canAct, commitSingle, holderSide, opponent, room.role, room.send]);

  useEffect(() => {
    if (phase !== 'battle' || game.finished || opponent !== 'ai' || turnMode !== 'sequential' || side !== 1 || animating || aiBusy.current) return;
    aiBusy.current = true;
    setThinking(true);
    const timer = setTimeout(() => {
      const action = chooseAIAction(game, 1, learning.champion, learning.champion);
      if (action) commitSingle(action, 1, false);
      setThinking(false);
      aiBusy.current = false;
    }, 260);
    return () => { clearTimeout(timer); setThinking(false); aiBusy.current = false; };
  }, [animating, commitSingle, game, learning.champion, opponent, phase, side, turnMode]);

  const holdUnit = () => {
    if (!selected || !canAct || isEnemyInspect) return;
    const action: Action = { uid: selected.uid, kind: 'wait', channel: 'wait', target: selected.pos };
    if (turnMode === 'simultaneous') setOrders((previous) => ({ ...previous, [action.uid]: action }));
    else perform(action);
  };

  const endTurn = () => {
    if (!canOrder || turnMode !== 'simultaneous') return;
    const prevGame = gameRef.current;
    const ownOrders = Object.values(orders).filter((action) => prevGame.units[action.uid]?.team === holderSide);
    if (opponent === 'online') {
      if (room.role === 'guest') {
        if (room.send({ type: 'orders', revision: revision.current, orders: ownOrders })) setRequestPending(true);
      } else if (room.role === 'host') lockOnlineOrders(0, ownOrders);
      return;
    }
    if (opponent === 'ai') {
      setThinking(true);
      setTimeout(() => {
        const aiOrders = chooseSimultaneousOrders(game, 1, learning.champion, learning.champion);
        const transition = simultaneousTransition(prevGame, ownOrders, aiOrders);
        pushLog(rowsFromOrders(prevGame, [...ownOrders, ...aiOrders], transition.game));
        setOrders({}); setSelectedUid(null); setThinking(false);
        setMessage(`Round ${transition.game.round} resolved. Set your next orders.`);
        void playFrames(transition.frames, transition.game);
      }, 10);
      return;
    }
    const aOrders = Object.values(orders).filter((action) => prevGame.units[action.uid]?.team === 0);
    const bOrders = Object.values(orders).filter((action) => prevGame.units[action.uid]?.team === 1);
    const transition = simultaneousTransition(prevGame, aOrders, bOrders);
    pushLog(rowsFromOrders(prevGame, [...aOrders, ...bOrders], transition.game));
    setOrders({}); setSelectedUid(null);
    setMessage(`Round ${transition.game.round} resolved. Set your next orders.`);
    void playFrames(transition.frames, transition.game);
  };

  const clickHex = (hex: Hex) => {
    const occupant = game.units.find((unit) => unit.alive && hexKey(unit.pos) === hexKey(hex));
    if (phase === 'setup') {
      if (opponent === 'online' && room.role === 'guest' || game.terrain.has(hexKey(hex))) return;
      if (occupant) {
        if (occupant.team === setupSide) setGame((previous) => ({ ...previous, units: previous.units.filter((unit) => unit.uid !== occupant.uid) }));
        return;
      }
      const nextUid = Math.max(0, ...game.units.map((unit) => unit.uid)) + 1;
      const placed: Unit = { uid: nextUid, type: unitType, team: setupSide, pos: hex,
        alive: true, acted: false, kills: 0, shots: 0, moves: 0 };
      if (!safeToDeploy(game, placed)) {
        setMessage('Deployment blocked: that tile creates an immediate attack for either army.');
        return;
      }
      setGame((previous) => ({ ...previous, units: [...previous.units, placed] }));
      return;
    }
    const action = actionMap.get(hexKey(hex));
    if (action && canAct) {
      if (turnMode === 'simultaneous') setOrders((previous) => ({ ...previous, [action.uid]: action }));
      else perform(action);
      return;
    }
    setSelectedUid(occupant?.uid ?? null);
  };

  const randomArmy = () => {
    if (opponent === 'online' && room.role === 'guest') return;
    const next = cloneGame(game);
    next.units = next.units.filter((unit) => unit.team !== setupSide);
    const pool = PATTERNS.filter((pattern) => pattern.unlock <= stage);
    if (!pool.length) return;
    const take = 5 + Math.floor(Math.random() * 3);
    const types = Array.from({ length: take }, () => pool[Math.floor(Math.random() * pool.length)].id);
    if (!types.some((id) => PATTERN_BY_ID[id].family === 'Melee')) types[0] = pool[0].id;
    const home = next.cities[setupSide];
    const ring = shuffled(DIRECTIONS.map((direction) => add(home, direction))
      .filter((hex) => !next.terrain.has(hexKey(hex))));
    const free = shuffled(BOARD.filter((hex) => !next.terrain.has(hexKey(hex))
      && distance(hex, next.cities[1 - setupSide]) >= 5));
    let ranged = 0;
    const fallback = pool.find((pattern) => pattern.family !== 'Ranged')?.id;
    const roster = types.map((type) => {
      if (PATTERN_BY_ID[type].family !== 'Ranged') return type;
      ranged++;
      return ranged <= 2 || !fallback ? type : fallback;
    });
    roster.sort((a, b) => Number(PATTERN_BY_ID[b].family === 'Ranged') - Number(PATTERN_BY_ID[a].family === 'Ranged'));
    for (const type of roster) {
      const candidates = PATTERN_BY_ID[type].family === 'Ranged' ? ring : free;
      const pos = candidates.find((hex) => safeToDeploy(next, {
        uid: -1, type, team: setupSide, pos: hex, alive: true, acted: false, kills: 0, shots: 0, moves: 0,
      }));
      if (!pos) break;
      const uid = Math.max(0, ...next.units.map((unit) => unit.uid)) + 1;
      next.units.push({ uid, type, team: setupSide, pos, alive: true, acted: false, kills: 0, shots: 0, moves: 0 });
    }
    setGame(next);
    const placed = next.units.filter((unit) => unit.team === setupSide).length;
    setMessage(placed >= 5 ? `${TEAM_NAMES[setupSide]} deployed safely. No opening attacks.`
      : `Only ${placed} safe slots were available. Try a new map or adjust the other army.`);
  };

  const newMap = () => {
    if (opponent === 'online' && room.role === 'guest') return;
    const nextSeed = Math.floor(Math.random() * 2_000_000_000) + 1;
    setSeed(nextSeed); setGame(freshMap(nextSeed, stage, turnMode)); setPhase('setup');
    setSelectedUid(null); setOrders({}); setReady([false, false]); setLog([]); locked.current = [null, null];
    setMessage('Fresh cities and terrain. Place both armies.');
  };

  const start = () => {
    if (opponent === 'online' && (room.role !== 'host' || room.status !== 'connected')) {
      setMessage('Create a room and wait for your opponent before starting.'); return;
    }
    const a = game.units.filter((unit) => unit.team === 0).length;
    const b = game.units.filter((unit) => unit.team === 1).length;
    if (a < 5 || a > 7 || b < 5 || b > 7) { setMessage('Each army must contain 5 to 7 units before the match.'); return; }
    if (openingThreats(game).length) {
      setMessage('Deployment has immediate attacks. Move the threatened units before starting.');
      return;
    }
    const clean = cloneGame(game);
    clean.mode = turnMode;
    clean.firstSide = firstSide;
    clean.units = clean.units.filter((unit) => unit.alive)
      .map((unit, uid) => ({ ...unit, uid, acted: false, kills: 0, shots: 0, moves: 0 }));
    clean.round = 0; clean.winner = null; clean.reason = null; clean.finished = false;
    setSetupSnapshot(clean.units.map((unit) => ({ ...unit })));
    setGame(clean); setPhase('battle'); setSide(firstSide); setOrderSide(firstSide);
    setSelectedUid(null); setOrders({}); setReady([false, false]); setLog([]); locked.current = [null, null];
    setMessage(turnMode === 'simultaneous'
      ? 'Every unit takes an order. All attacks resolve before any movement.'
      : `${TEAM_NAMES[firstSide]} acts first.`);
    if (opponent === 'online') { revision.current++; sendSnapshot(clean, 'battle', firstSide, [false, false]); }
  };

  const rematch = () => {
    if (!setupSnapshot || opponent === 'online' && room.role === 'guest') return;
    const next = cloneGame(game);
    next.units = setupSnapshot.map((unit) => ({ ...unit, pos: { ...unit.pos }, alive: true, acted: false, kills: 0, shots: 0, moves: 0 }));
    next.round = 0; next.winner = null; next.reason = null; next.finished = false;
    setGame(next); setPhase('battle'); setSide(firstSide); setOrderSide(firstSide); setSelectedUid(null);
    setOrders({}); setReady([false, false]); setLog([]); locked.current = [null, null];
    setMessage('Rematch from the same deployment.');
    if (opponent === 'online') { revision.current++; sendSnapshot(next, 'battle', firstSide, [false, false]); }
  };

  const editDeployment = () => {
    if (!setupSnapshot || opponent === 'online' && room.role === 'guest') return;
    const next = cloneGame(game);
    next.units = setupSnapshot.map((unit) => ({ ...unit, pos: { ...unit.pos }, alive: true, acted: false, kills: 0, shots: 0, moves: 0 }));
    next.round = 0; next.winner = null; next.reason = null; next.finished = false;
    setGame(next); setPhase('setup'); setSelectedUid(null); setOrders({}); setReady([false, false]); locked.current = [null, null];
    setMessage('Deployment restored. Adjust either army.');
  };

  const copyLink = async () => {
    if (!room.invite) return;
    try { await navigator.clipboard.writeText(room.invite); setCopied(true); setTimeout(() => setCopied(false), 1400); }
    catch { setMessage('Select and copy the room link below.'); }
  };

  const leaveOnline = () => {
    room.close();
    if (wasGuest.current) {
      applyRuleset(guestRules.current);
      setProfileOverlays(adaptLearningToPatterns(learning).profileDeltas);
      wasGuest.current = false;
    }
  };

  const stageUnits = PATTERNS.filter((pattern) => pattern.unlock <= stage);
  const maxStage = Math.min(40, Math.max(13, ...PATTERNS.map((pattern) => pattern.unlock), ...Object.values(ERA_BANDS).map((band) => band.end)));
  const setupLocked = opponent === 'online' && room.role === 'guest';
  const battleLocked = phase === 'battle';
  const canHost = opponent !== 'online' || room.role === 'host';

  return (
    <div className="play-page">
      <div className="subpage-head">
        <div><button className="back-link" onClick={onBack}><span aria-hidden="true">←</span> Back to lab</button>
          <span className="micro-label">BATTLE TABLE / HUMAN VS MACHINE VS HUMAN</span>
          <h1>Take the <em>field.</em></h1>
          <p>Deploy both armies, then play the champion, use hotseat, or invite a friend into a live online room.</p></div>
        <div className="champion-badge"><Crosshair size={16} /><span>ACTIVE CHAMPION<strong>Policy v{String(learning.version).padStart(2, '0')}</strong></span><small>{learning.generation} learning cycles</small></div>
      </div>

      <div className="play-toolbar">
        <div className="play-mode">
          <button className={opponent === 'ai' ? 'is-active' : ''} disabled={battleLocked} onClick={() => { leaveOnline(); setOpponent('ai'); }}><Bot size={15} /> vs Champion AI</button>
          <button className={opponent === 'hotseat' ? 'is-active' : ''} disabled={battleLocked} onClick={() => { leaveOnline(); setOpponent('hotseat'); }}><Users size={15} /> Hotseat</button>
          <button className={opponent === 'online' ? 'is-active' : ''} disabled={battleLocked} onClick={() => setOpponent('online')}><Link2 size={15} /> Online link</button>
        </div>
        <div className="play-mode second">
          <button className={turnMode === 'sequential' ? 'is-active' : ''} disabled={battleLocked || setupLocked} onClick={() => { setTurnMode('sequential'); setGame((previous) => ({ ...previous, mode: 'sequential' })); }}>Alternating turns</button>
          <button className={turnMode === 'simultaneous' ? 'is-active' : ''} disabled={battleLocked || setupLocked} onClick={() => { setTurnMode('simultaneous'); setGame((previous) => ({ ...previous, mode: 'simultaneous' })); }}>Simultaneous turns</button>
          {turnMode === 'sequential' && <label className="play-stage">FIRST<select value={firstSide} disabled={battleLocked || setupLocked} onChange={(event) => setFirstSide(Number(event.target.value) as Team)} aria-label="First mover"><option value={0}>Army A</option><option value={1}>Army B</option></select></label>}
          {phase === 'battle' && <button className={`reach-toggle ${showReach ? 'is-active' : ''}`} onClick={() => setShowReach((value) => !value)} title="Show every square enemy units can move or attack"><Eye size={14} /> Enemy reach</button>}
        </div>
        {phase === 'setup' ? <div className="setup-switcher"><span>DEPLOYING</span><button className={setupSide === 0 ? 'is-active a' : ''} disabled={setupLocked} onClick={() => setSetupSide(0)}>Army A</button><button className={setupSide === 1 ? 'is-active b' : ''} disabled={setupLocked} onClick={() => setSetupSide(1)}>Army B</button></div>
          : <div className="battle-turn"><span className="turn-dot" style={{ background: holderSide === 0 ? COLORS.a : COLORS.b }} />
            {animating ? 'Resolving actions' : opponent === 'online' ? `${TEAM_NAMES[holderSide]} (you) / ${turnMode === 'simultaneous' ? (ready[holderSide] ? 'orders locked' : 'planning') : side === holderSide ? 'your turn' : 'waiting'}`
              : opponent === 'ai' ? (turnMode === 'simultaneous' ? 'Set your orders / AI responds' : side === 0 ? 'Your action' : 'Army B / Champion searching')
                : `${TEAM_NAMES[holderSide]} ${turnMode === 'simultaneous' ? 'orders' : 'acts'}`}
            <b>ROUND {game.round + 1}</b></div>}
        <div className="play-actions"><label className="play-stage">TECH<select value={stage} disabled={battleLocked || setupLocked} onChange={(event) => { const value = Number(event.target.value); setStage(value); setGame(freshMap(seed, value, turnMode)); }}>{Array.from({ length: maxStage }, (_, index) => index + 1).map((value) => <option key={value} value={value}>T{value}</option>)}</select></label><button onClick={newMap} disabled={setupLocked || animating}><Shuffle size={14} /> New map</button>
          {phase === 'setup' ? <button className="primary" onClick={start} disabled={setupLocked || opponent === 'online' && room.status !== 'connected'}><Play size={14} fill="currentColor" /> {setupLocked ? 'Waiting for host' : 'Start battle'}</button>
            : <><button onClick={rematch} disabled={!canHost || animating}><RotateCcw size={14} /> Rematch</button><button onClick={editDeployment} disabled={!canHost || animating}><Flag size={14} /> Edit setup</button></>}</div>
      </div>

      <div className="play-grid">
        <section className="play-board-panel">
          <div className="play-board-top"><span>{BOARD_WIDTH} × {BOARD_HEIGHT} ARENA / SEED {seed}</span>
            <span>{showReach && phase === 'battle' ? 'ENEMY REACH SHOWN / FAINT SQUARES'
              : phase === 'setup' ? (setupLocked ? 'HOST IS DEPLOYING' : 'CLICK EMPTY HEX TO PLACE / CLICK OWN UNIT TO REMOVE')
                : isEnemyInspect ? 'ENEMY PATTERN REVEALED / WHITE MARKER IS THE ASSIGNED ORDER'
                  : turnMode === 'simultaneous' ? 'ASSIGN ORDERS, WHITE MARKER IS THE ACTIVE ORDER' : 'SELECT A UNIT, THEN CLICK A HIGHLIGHTED DESTINATION'}</span></div>
          <div className="play-board-wrap"><svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} className="play-board" role="img" aria-label="Interactive hex battlefield">
            {BOARD.map((hex) => {
              const { x, y } = center(hex);
              const key = hexKey(hex);
              const city = cityMap.get(key);
              const isMountain = mountain.has(key);
              const action = actionMap.get(key);
              const inspect = inspectMap.get(key);
              const orderTile = orderTiles.get(key);
              const reach = enemyReach.get(key);
              return <g key={key} onClick={() => clickHex(hex)} className="battle-cell" data-hex={key}>
                <polygon points={points(x, y, RADIUS - 0.4)}
                  fill={isMountain ? '#344641' : city !== undefined ? '#554b3b' : (hex.q + hex.r) % 3 === 0 ? '#283936' : '#253530'}
                  stroke={selected?.pos.q === hex.q && selected.pos.r === hex.r ? '#f2d7b1' : '#405149'} strokeWidth="0.9" />
                {reach && <polygon points={points(x, y, RADIUS - 4.5)} fill={CHANNEL_COLORS[reach]} fillOpacity="0.16" stroke={CHANNEL_COLORS[reach]} strokeOpacity="0.45" strokeWidth="0.8" strokeDasharray="3 3" pointerEvents="none" />}
                {(action || inspect) && <polygon points={points(x, y, RADIUS - 3.2)} fill={CHANNEL_COLORS[action?.channel ?? inspect!]}
                  fillOpacity={action ? 0.62 : 0.4} stroke={CHANNEL_COLORS[action?.channel ?? inspect!]} strokeWidth="1" />}
                {orderTile && <g pointerEvents="none">
                  <polygon points={points(x, y, RADIUS - 5.5)} fill="none" stroke="#f4efe2"
                    strokeWidth={orderTile.primary ? 2.8 : 1.5} strokeDasharray={orderTile.primary ? '6 4' : undefined}
                    className={orderTile.primary ? 'order-pulse' : undefined} />
                  <circle cx={x} cy={y} r="4.5" fill="#f4efe2" opacity="0.95" />
                </g>}
                {isMountain && <path d={`M${x - 10} ${y + 7} l7 -13 4 7 4 -5 7 11Z`} fill="#809991" opacity=".68" />}
                {city !== undefined && <g><circle cx={x} cy={y} r="15" fill="#c7aa7c" opacity=".24" /><path d={`M${x - 8} ${y + 5} v-11 l8 -4 8 4 v11Z`} fill="none" stroke="#e5c997" strokeWidth="1.5" /><text x={x} y={y + 3} textAnchor="middle" className="city-letter">{city === 0 ? 'A' : 'B'}</text></g>}
              </g>;
            })}
            {orderLines.map((line) => <line key={`order-${line.uid}`}
              x1={line.from.x} y1={line.from.y} x2={line.to.x} y2={line.to.y}
              stroke={line.color} strokeWidth="1.5" strokeOpacity="0.95" pointerEvents="none"
              data-order-line={line.uid} />)}
            {game.units.filter((unit) => unit.alive).map((unit) => {
              const { x, y } = center(unit.pos);
              const color = unit.team === 0 ? COLORS.a : COLORS.b;
              const chosen = unit.uid === selectedUid;
              const order = orders[unit.uid];
              return <g key={unit.uid} className="battle-unit" data-team={unit.team} data-uid={unit.uid} role="button" tabIndex={0}
                transform={`translate(${x} ${y})`}
                style={{ opacity: glides.some((glide) => glide.uid === unit.uid) ? 0 : 1 }}
                onClick={() => clickHex(unit.pos)} onKeyDown={(event) => { if (event.key === 'Enter') clickHex(unit.pos); }}
                aria-label={`${TEAM_NAMES[unit.team]} ${PATTERN_BY_ID[unit.type].name}`}>
                <circle r={chosen ? 16 : 14.2} fill="#172721" stroke={color} strokeWidth={chosen ? 2.5 : 1.7} />
                <text y={3.5} textAnchor="middle" className="unit-letter" fill={color}>{PATTERN_BY_ID[unit.type].short}</text>
                {order && <circle cx={11} cy={-10} r="4" fill={CHANNEL_COLORS[order.channel]} />}
                {unit.acted && phase === 'battle' && turnMode === 'sequential' && <circle cx={11} cy={-10} r="3" fill="#293c33" stroke="#859d8d" />}
              </g>;
            })}
            {glides.map((glide) => <GlidingUnit key={`glide-${glide.uid}`} glide={glide} />)}
            {effects.map((effect) => effect.kind === 'shot'
              ? <ShotDot key={effect.id} effect={effect} onDone={(id) => setEffects((previous) => previous.filter((candidate) => candidate.id !== id))} />
              : <g key={effect.id} pointerEvents="none">
                  <circle className="impact-ring" cx={effect.to.x} cy={effect.to.y} r="17" fill="none" stroke="#f2c98f" strokeWidth="3.5" />
                  <line x1={effect.from.x} y1={effect.from.y} x2={effect.to.x} y2={effect.to.y} stroke="#f2c98f" strokeWidth="2.5" strokeDasharray="5 4" className="impact-line" />
                </g>)}
            <text x="16" y="22" className="map-coordinate">BATTLE TABLE / {BOARD_WIDTH} × {BOARD_HEIGHT}</text>
          </svg></div>
          <div className="play-board-foot"><span><i className="legend-dot teal" /> Army A {game.units.filter((u) => u.team === 0 && u.alive).length}</span>
            <span><i className="legend-dot coral" /> Army B {game.units.filter((u) => u.team === 1 && u.alive).length}</span>
            <span className="shape-legend"><i className="legend-dot green" /> move<i className="legend-dot red" /> strike<i className="legend-dot brown" /> shoot<i className="legend-dot blue" /> pounce<i className="legend-dot white" /> order</span>
            <strong aria-live="polite">{message}</strong></div>
        </section>

        <aside className="play-side">
          {opponent === 'online' && <section className="play-box link-box">
            <span className="micro-label"><Wifi size={12} /> LIVE ONLINE / {room.status.toUpperCase()}</span>
            <p className="play-help">{room.message || (legacyInvite
              ? 'This is an old snapshot link, not a live room. Ask the host to create a new online invitation, then paste it below.'
              : 'Create a room or paste an invitation below. The host sets up the armies and stays connected while you play.')}</p>
            {room.invite && <><div className="link-field">{room.invite}</div><button className="link-copy" onClick={copyLink}><Copy size={13} /> {copied ? 'Copied' : 'Copy invitation'}</button></>}
            {phase === 'setup' && room.status !== 'connected' && <>
              <div className="link-open"><input value={linkInput} placeholder="Paste an invitation link or room code" onChange={(event) => setLinkInput(event.target.value)} aria-label="Paste invitation link" />
                <button onClick={() => room.join(linkInput)}>Join</button></div>
              <button className="link-copy room-create" onClick={room.create} disabled={room.status === 'connecting'}><Link2 size={13} /> Create room</button>
            </>}
            {room.status === 'connected' && <div className="online-status"><span className="live-signal" /> {room.role === 'host' ? 'You: Army A / host' : 'You: Army B / guest'}{turnMode === 'simultaneous' && phase === 'battle' ? ` / A ${ready[0] ? 'ready' : 'planning'} \u00b7 B ${ready[1] ? 'ready' : 'planning'}` : ''}</div>}
            {room.invite && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname) && <p className="play-help">This page is on localhost. Share a publicly reachable HTTPS deployment; your friend cannot open your localhost.</p>}
            <p className="network-note">Both browsers must stay open. Uses PeerJS signaling and a direct WebRTC connection; restrictive networks may require a TURN relay.</p>
          </section>}
          {phase === 'setup' ? <section className="play-box"><span className="micro-label">DEPLOYMENT / ARMY {setupSide === 0 ? 'A' : 'B'}</span>
            <div className="deploy-type"><div className="select-wrap"><select value={unitType} disabled={setupLocked} onChange={(event) => setUnitType(event.target.value as PatternId)} aria-label="Unit to place">
              {stageUnits.map((pattern) => <option key={pattern.id} value={pattern.id}>{pattern.name} / {pattern.family}</option>)}
            </select><ChevronDown size={14} /></div><button onClick={randomArmy} disabled={setupLocked}><Shuffle size={14} /> Auto army</button></div>
            <p className="play-help">{setupLocked ? 'The host is deploying both armies.' : 'Place units on empty hexes or generate an army. Both sides need 5 to 7 units.'}</p>
            <div className="placed-list">{([0, 1] as Team[]).map((team) => <div key={team}><span className="micro-label">{TEAM_NAMES[team].toUpperCase()} / {game.units.filter((unit) => unit.team === team).length}</span>
              <div className="placed-chips">{game.units.filter((unit) => unit.team === team).map((unit) => <button key={unit.uid} disabled={setupLocked}
                onClick={() => { setSetupSide(team); setUnitType(unit.type); setGame((previous) => ({ ...previous, units: previous.units.filter((item) => item.uid !== unit.uid) })); }} title="Remove unit"><span>{PATTERN_BY_ID[unit.type].short}</span><Trash2 size={10} /></button>)}</div></div>)}</div>
            <div className="start-hint"><User size={14} /> Ranged units auto-deploy next to their own city.</div>
          </section> : <>
            {turnMode === 'simultaneous' ? <section className="play-box"><span className="micro-label">ORDERS / {TEAM_NAMES[holderSide].toUpperCase()} ({orderedUnits}/{activeUnits})</span>
              {opponent === 'hotseat' && <div className="order-side"><button className={orderSide === 0 ? 'is-active a' : ''} onClick={() => { setOrderSide(0); setSelectedUid(null); }}>Ordering A</button><button className={orderSide === 1 ? 'is-active b' : ''} onClick={() => { setOrderSide(1); setSelectedUid(null); }}>Ordering B</button></div>}
              {selected && selected.team === holderSide ? <div className="unit-readout"><span className="unit-mark">{PATTERN_BY_ID[selected.type].short}</span><div><strong>{PATTERN_BY_ID[selected.type].name}</strong><small>{orders[selected.uid] ? orderVerb(orders[selected.uid]) : 'no order yet'}</small></div>{orders[selected.uid] && <button className="order-clear" disabled={!canAct} onClick={() => setOrders((previous) => { const next = { ...previous }; delete next[selected.uid]; return next; })} title="Clear order"><Trash2 size={12} /></button>}</div>
                : <p className="play-help">Select a friendly unit and a highlighted destination to assign its order. Unordered units hold. All attacks resolve before any movement — a targeted unit cannot move away.</p>}
              <div className="order-chips">{game.units.filter((unit) => unit.alive && unit.team === holderSide).map((unit) => <button key={unit.uid} className={orders[unit.uid] ? 'is-ordered' : ''} onClick={() => setSelectedUid(unit.uid)}><i style={{ background: unit.team === 0 ? COLORS.a : COLORS.b }} /><span>{PATTERN_BY_ID[unit.type].short}</span><small>{orders[unit.uid] ? orderVerb(orders[unit.uid]) : '\u2014'}</small></button>)}</div>
              <div className="order-actions"><button disabled={!canOrder} onClick={() => setOrders({})}>Clear orders</button>
                <button className="primary" onClick={endTurn} disabled={!canOrder}>{opponent === 'online' ? (ready[holderSide] ? 'Orders locked' : 'Lock orders') : 'End turn / resolve'}</button></div>
            </section> : <section className="play-box"><span className="micro-label">SELECTED / {TEAM_NAMES[holderSide].toUpperCase()}</span>
              {selected && selected.team === holderSide ? <div className="unit-readout"><span className="unit-mark">{PATTERN_BY_ID[selected.type].short}</span><div><strong>{PATTERN_BY_ID[selected.type].name}</strong><small>{PATTERN_BY_ID[selected.type].family} / {effectiveProfile(selected).siege ? 'siege objective' : 'unit elimination priority'}</small></div></div>
                : <p className="play-help">Select a friendly unit to act, or click an enemy to reveal its full pattern.</p>}
              <div className="action-summary"><div><b>{actions.filter((action) => action.kind === 'attack').length}</b><span>attacks available</span></div><div><b>{actions.filter((action) => action.kind === 'move').length}</b><span>moves available</span></div></div>
              <div className="turn-note">{thinking ? <><Bot size={14} /> Champion is calculating three moves ahead\u2026</> : <><Crosshair size={14} /> Click a highlighted hex to act.</>}</div>
              <button className="hold-button" onClick={holdUnit} disabled={!selected || isEnemyInspect || !canAct}>Hold this unit / pass</button>
            </section>}
            {isEnemyInspect && selected && <section className="play-box enemy-box"><span className="micro-label">ENEMY PATTERN / {PATTERN_BY_ID[selected.type].name.toUpperCase()}</span>
              <p className="play-help">Highlighted squares are legal on the current board. In simultaneous mode every attack resolves before movement — a targeted unit cannot move away.</p>
              <div className="shape-counts"><div><b>{inspectActions.filter((action) => action.kind === 'move').length}</b><span>moves</span></div><div><b>{inspectActions.filter((action) => action.kind === 'attack').length}</b><span>attacks</span></div></div>
            </section>}
            <section className="play-box battle-log"><span className="micro-label">MATCH STATE</span>
              <div className="battle-stats"><div><span>ROUND</span><b>{game.round + 1}</b></div><div><span>ARMY A</span><b>{game.units.filter((unit) => unit.team === 0 && unit.alive).length}</b></div><div><span>ARMY B</span><b>{game.units.filter((unit) => unit.team === 1 && unit.alive).length}</b></div></div>
              <div className="battle-units">{game.units.filter((unit) => unit.alive).map((unit) => <div key={unit.uid} className={unit.acted && turnMode === 'sequential' ? 'is-spent' : ''}><i style={{ background: unit.team === 0 ? COLORS.a : COLORS.b }} /><span>{PATTERN_BY_ID[unit.type].short}</span><small>{unit.team === 0 ? 'A' : 'B'}</small><b>{unit.kills}K</b></div>)}</div>
            </section>
            <section className="play-box score-sheet"><span className="micro-label">SCORE SHEET</span>
              {log.length === 0 ? <p className="play-help">Moves, attacks and kills appear here as the battle unfolds.</p>
                : <div className="sheet-table"><div className="sheet-head"><span>RD</span><span>UNIT</span><span>ACTION</span><span>TARGET</span></div>
                  {log.map((row) => <div className={`sheet-row ${row.action === 'KILLED' ? 'is-killed' : ''}`} key={row.id}><span>{row.round}</span><span>{row.who}</span><span>{row.action}</span><span>{row.target}</span></div>)}
                </div>}
            </section>
          </>}
        </aside>
      </div>

      {game.finished && !animating && <div className="battle-overlay"><div className="battle-result"><Skull size={25} /><span className="micro-label">BATTLE CONCLUDED</span>
        <h2>{game.winner === null ? 'Mutual destruction.' : `${TEAM_NAMES[game.winner]} wins.`}</h2><p>{game.winner === null ? 'Both commands were eliminated.' : `Victory by ${game.reason}.`}</p>
        <div><button onClick={rematch} disabled={!canHost}><RotateCcw size={14} /> Rematch</button><button className="primary" onClick={editDeployment} disabled={!canHost}>Adjust deployment</button></div></div></div>}
    </div>
  );
}
