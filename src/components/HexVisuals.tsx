import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Mountain, MousePointer2 } from 'lucide-react';
import {
  BOARD_HEIGHT, BOARD_WIDTH, boardHexes, hexToOffset, legalActions,
  type BoardSnapshot, type GameState, type Unit,
} from '../sim/engine';
import { DIRECTIONS, FAMILIES, PATTERN_BY_ID, PATTERNS, add, distance, hexKey, type Hex, type Pattern, type PatternId } from '../sim/patterns';

const PALETTE = {
  red: '#bc735f', green: '#7da88c', brown: '#bb9564', blue: '#5e96a8', purple: '#9a78b0',
  team0: '#91d6bd', team1: '#e8a488',
};

function points(x: number, y: number, radius: number): string {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 180) * (60 * index - 90);
    return `${(x + radius * Math.cos(angle)).toFixed(2)},${(y + radius * Math.sin(angle)).toFixed(2)}`;
  }).join(' ');
}

const HEX_RADIUS = 22;
const COL_STEP = HEX_RADIUS * Math.sqrt(3);
const ROW_STEP = HEX_RADIUS * 1.5;
const MAP_WIDTH = 68 + (BOARD_WIDTH - 1) * COL_STEP + COL_STEP / 2;
const MAP_HEIGHT = 68 + (BOARD_HEIGHT - 1) * ROW_STEP;

function mapCenter(hex: Hex): { x: number; y: number } {
  const { col, row } = hexToOffset(hex);
  return { x: 34 + col * COL_STEP + (row % 2) * COL_STEP / 2, y: 34 + row * ROW_STEP };
}

function stateFromSnapshot(preview: BoardSnapshot): GameState {
  const units: Unit[] = preview.units.map((unit) => ({ ...unit, alive: true, acted: false, kills: 0, shots: 0, moves: 0 }));
  const terrain = new Set([...preview.cities, ...preview.mountains].map(hexKey));
  return { units, cities: preview.cities, mountains: preview.mountains, terrain,
    round: preview.round, stage: preview.stage, mode: preview.mode, firstSide: 0,
    winner: null, reason: null, finished: false };
}

export function FieldBoard({ preview }: { preview: BoardSnapshot }) {
  const [selectedUid, setSelectedUid] = useState<number | null>(preview.units[0]?.uid ?? null);
  const state = useMemo(() => stateFromSnapshot(preview), [preview]);
  useEffect(() => {
    setSelectedUid((current) => preview.units.some((unit) => unit.uid === current)
      ? current : preview.units[0]?.uid ?? null);
  }, [preview]);
  const selected = state.units.find((unit) => unit.uid === selectedUid) || state.units[0];
  const available = selected ? legalActions(state, selected) : [];
  const actionTiles = new Map(available.map((action) => [hexKey(action.target), action]));
  const mountains = new Set(preview.mountains.map(hexKey));
  const cities = new Map(preview.cities.map((city, team) => [hexKey(city), team]));
  const surrounding = new Set(preview.cities.flatMap((city) => DIRECTIONS.map((direction) => hexKey(add(city, direction)))));

  return (
    <div className="field-wrap">
      <AnimatePresence mode="wait">
        <motion.svg
          key={`${preview.stage}-${preview.round}-${preview.units.map((unit) => unit.uid + hexKey(unit.pos)).join('|')}`}
          className="field-svg" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} role="img"
          aria-label={`${BOARD_WIDTH} by ${BOARD_HEIGHT} hex battlefield, tech stage ${preview.stage}, round ${preview.round}, ${preview.units.length} surviving units`}
          initial={{ opacity: 0.52, scale: 0.992 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0.5 }}
          transition={{ duration: 0.32, ease: 'easeOut' }}
        >
          <defs>
            <filter id="unit-glow" x="-70%" y="-70%" width="240%" height="240%">
              <feGaussianBlur stdDeviation="5" />
            </filter>
          </defs>
          {boardHexes().map((hex) => {
            const { x, y } = mapCenter(hex);
            const key = hexKey(hex);
            const mountain = mountains.has(key);
            const cityTeam = cities.get(key);
            const action = actionTiles.get(key);
            return (
              <g key={key}>
                <polygon points={points(x, y, HEX_RADIUS - 0.4)}
                  fill={mountain ? '#334542' : cityTeam !== undefined ? '#554c3d' : (hex.q + hex.r) % 3 === 0 ? '#283936' : '#263632'}
                  stroke={surrounding.has(key) ? '#786a51' : '#3a4b45'}
                  strokeWidth={surrounding.has(key) ? 1.15 : 0.75} strokeOpacity={surrounding.has(key) ? 0.7 : 0.72}
                />
                {action && action.channel !== 'wait' && <polygon points={points(x, y, HEX_RADIUS - 3)} fill={PALETTE[action.channel]}
                  fillOpacity="0.36" stroke={PALETTE[action.channel]} strokeOpacity="0.8" strokeWidth="1" />}
                {mountain && <path d={`M${x - 9} ${y + 6} l6 -11 4 6 3 -4 6 10Z`} fill="#789087" opacity="0.68" />}
                {cityTeam !== undefined && (
                  <g>
                    <circle cx={x} cy={y} r="14" fill="#bba47c" opacity="0.25" />
                    <path d={`M${x - 7} ${y + 5} v-10 l7 -4 7 4 v10Z`} fill="none" stroke="#dfc79b" strokeWidth="1.5" />
                    <text x={x} y={y + 2.5} textAnchor="middle" className="city-letter">{cityTeam === 0 ? 'A' : 'B'}</text>
                  </g>
                )}
              </g>
            );
          })}
          {preview.units.map((unit) => {
            const { x, y } = mapCenter(unit.pos);
            const active = selected?.uid === unit.uid;
            const color = unit.team === 0 ? PALETTE.team0 : PALETTE.team1;
            return (
              <g key={unit.uid} className="field-unit" onClick={() => setSelectedUid(unit.uid)}
                role="button" tabIndex={0} aria-label={`${unit.team === 0 ? 'A' : 'B'} ${PATTERN_BY_ID[unit.type].name}`}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedUid(unit.uid); }}>
                {active && <circle cx={x} cy={y} r="21" fill={color} opacity="0.24" filter="url(#unit-glow)" />}
                <circle cx={x} cy={y} r={active ? 15.5 : 14.2} fill="#182723" stroke={color} strokeWidth={active ? 2.4 : 1.7} />
                <text x={x} y={y + 3.3} textAnchor="middle" className="unit-letter" fill={color}>{PATTERN_BY_ID[unit.type].short}</text>
                {active && <circle cx={x} cy={y} r="19.7" fill="none" stroke={color} opacity="0.64" strokeWidth="0.8" />}
              </g>
            );
          })}
          <text x="16" y="22" className="map-coordinate">N 08 / {BOARD_WIDTH} COLS x {BOARD_HEIGHT} ROWS</text>
          <text x={MAP_WIDTH - 12} y={MAP_HEIGHT - 17} textAnchor="end" className="map-coordinate">TACTICAL PROJECTION / {BOARD_WIDTH * BOARD_HEIGHT} HEXES</text>
        </motion.svg>
      </AnimatePresence>
      <div className="board-bottom">
        <div className="board-legend">
          <span><i className="legend-dot teal" /> Army A</span>
          <span><i className="legend-dot coral" /> Army B</span>
          <span><Mountain size={12} strokeWidth={1.8} /> Obstacle</span>
        </div>
        <div className="board-selection"><MousePointer2 size={12} /> {selected
          ? `${PATTERN_BY_ID[selected.type].name} / ${available.length} legal actions`
          : 'Select a unit to inspect actions'}</div>
      </div>
    </div>
  );
}

const atlasCells: Hex[] = [];
for (let q = -4; q <= 4; q++) {
  for (let r = -4; r <= 4; r++) {
    if (distance({ q: 0, r: 0 }, { q, r }) <= 4) atlasCells.push({ q, r });
  }
}

function atlasCenter(hex: Hex) {
  return { x: 255 + (hex.q + hex.r / 2) * 37.6, y: 183 + hex.r * 32.6 };
}

function PatternDiagram({ pattern }: { pattern: Pattern }) {
  const colors = new Map<string, keyof typeof PALETTE>();
  for (const hex of pattern.green) colors.set(hexKey(hex), 'green');
  for (const hex of pattern.red) colors.set(hexKey(hex), 'red');
  for (const hex of pattern.brown) colors.set(hexKey(hex), 'brown');
  for (const hex of pattern.blue) colors.set(hexKey(hex), 'blue');
  colors.set('0,0', 'purple');
  return (
    <motion.svg key={pattern.id} viewBox="0 0 510 365" className="atlas-svg" role="img"
      aria-label={`${pattern.name} movement and attack diagram`}
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28 }}>
      {atlasCells.map((hex) => {
        const { x, y } = atlasCenter(hex);
        const color = colors.get(hexKey(hex));
        return <g key={hexKey(hex)}>
          <polygon points={points(x, y, 20.8)} fill={color ? PALETTE[color] : '#2b3934'}
            fillOpacity={color ? 0.92 : 0.82} stroke={color ? '#d4ceb7' : '#47574e'}
            strokeOpacity={color ? 0.36 : 0.7} strokeWidth="0.85" />
          {color === 'purple' && <text x={x} y={y + 4.2} textAnchor="middle" className="atlas-center-label">{pattern.short}</text>}
          {color && color !== 'purple' && <circle cx={x} cy={y} r="1.6" fill="#1d2a27" opacity="0.55" />}
        </g>;
      })}
    </motion.svg>
  );
}

export function UnitAtlas({ selected, onSelect }: { selected: PatternId; onSelect: (id: PatternId) => void }) {
  const pattern = PATTERN_BY_ID[selected];
  return (
    <div className="atlas-layout">
      <div className="atlas-list" aria-label="Unit patterns">
        {FAMILIES.map((family) => (
          <div key={family} className="atlas-family">
            <div className="atlas-family-label">{family}</div>
            {PATTERNS.filter((item) => item.family === family).map((item) => (
              <button key={item.id} className={`atlas-unit-option ${selected === item.id ? 'is-selected' : ''}`}
                onClick={() => onSelect(item.id)}>
                <span>{item.name}</span><span className="atlas-tech">T{String(item.unlock).padStart(2, '0')}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="atlas-detail">
        <div className="atlas-detail-top">
          <div><span className="micro-label">PATTERN {String(pattern.unlock).padStart(2, '0')} / 13</span>
            <h3>{pattern.name}</h3></div>
          <span className="atlas-code">{pattern.short}</span>
        </div>
        <PatternDiagram pattern={pattern} />
        <p className="atlas-description">{pattern.description}</p>
        <div className="pattern-legend">
          <span><i className="legend-dot green" /> Move only <b>{pattern.green.length}</b></span>
          <span><i className="legend-dot red" /> Move / kill <b>{pattern.red.length}</b></span>
          <span><i className="legend-dot brown" /> Shoot <b>{pattern.brown.length}</b></span>
          <span><i className="legend-dot blue" /> Kill / occupy <b>{pattern.blue.length}</b></span>
        </div>
      </div>
    </div>
  );
}