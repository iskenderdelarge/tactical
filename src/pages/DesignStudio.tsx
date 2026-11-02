import { useMemo, useState } from 'react';
import { ArrowLeft, Check, Eraser, RotateCcw, Save, Sparkles } from 'lucide-react';
import {
  ERA_BANDS, FACTORY_PROFILES, UNIT_PROFILES, replacePatternGeometry, type UnitProfile,
  resetCustomization, resetPattern, saveCustomization, setEraBand, stageEra, updateUnlock,
  type EraKey,
} from '../sim/config';
import { PATTERNS, PATTERN_BY_ID, distance, hexKey, type Hex, type PatternId } from '../sim/patterns';

type Brush = 'green' | 'red' | 'brown' | 'blue';
const BRUSHES: { key: Brush; label: string; hint: string; color: string }[] = [
  { key: 'green', label: 'Move only', hint: 'Legal move, never an attack', color: '#7da88c' },
  { key: 'red', label: 'Move + kill', hint: 'Move, capture and occupy', color: '#bc735f' },
  { key: 'brown', label: 'Ranged', hint: 'Kill without occupying', color: '#bb9564' },
  { key: 'blue', label: 'Enemy only', hint: 'Capture only an occupied enemy hex', color: '#5e96a8' },
];

const CELLS: Hex[] = [];
for (let q = -4; q <= 4; q++) for (let r = -4; r <= 4; r++) {
  if (distance({ q: 0, r: 0 }, { q, r }) <= 4) CELLS.push({ q, r });
}

const points = (x: number, y: number, radius: number) => Array.from({ length: 6 }, (_, i) => {
  const angle = (Math.PI / 180) * (60 * i - 90);
  return `${x + radius * Math.cos(angle)},${y + radius * Math.sin(angle)}`;
}).join(' ');
const center = (hex: Hex) => ({ x: 300 + (hex.q + hex.r / 2) * 43, y: 220 + hex.r * 37.2 });

export function DesignStudio({ onBack, onChanged }: { onBack: () => void; onChanged: () => void }) {
  const [selected, setSelected] = useState<PatternId>('melee1');
  const [brush, setBrush] = useState<Brush>('red');
  const [draft, setDraft] = useState<Record<Brush, Set<string>>>(() => makeDraft('melee1'));
  const [unlock, setUnlock] = useState(PATTERN_BY_ID.melee1.unlock);
  const [profile, setProfile] = useState<UnitProfile>(() => ({ ...UNIT_PROFILES.melee1 }));
  const [eras, setEras] = useState(() => ({ ...ERA_BANDS }));
  const [saved, setSaved] = useState('');
  const pattern = PATTERN_BY_ID[selected];

  function makeDraft(id: PatternId) {
    const target = PATTERN_BY_ID[id];
    return {
      green: new Set(target.green.map(hexKey)),
      red: new Set(target.red.map(hexKey)),
      brown: new Set(target.brown.map(hexKey)),
      blue: new Set(target.blue.map(hexKey)),
    };
  }

  const selectUnit = (id: PatternId) => {
    setSelected(id);
    setDraft(makeDraft(id));
    setUnlock(PATTERN_BY_ID[id].unlock);
    setProfile({ ...UNIT_PROFILES[id] });
  };

  const cellChannel = useMemo(() => {
    const map = new Map<string, Brush>();
    for (const channel of BRUSHES) for (const key of draft[channel.key]) map.set(key, channel.key);
    return map;
  }, [draft]);

  const paint = (hex: Hex) => {
    if (hex.q === 0 && hex.r === 0) return;
    setDraft((previous) => {
      const next: Record<Brush, Set<string>> = {
        green: new Set(previous.green), red: new Set(previous.red),
        brown: new Set(previous.brown), blue: new Set(previous.blue),
      };
      const key = hexKey(hex);
      const already = next[brush].has(key);
      for (const channel of BRUSHES) next[channel.key].delete(key);
      if (!already) next[brush].add(key);
      return next;
    });
  };

  const save = () => {
    const channels = Object.fromEntries(BRUSHES.map(({ key }) => [key, [...draft[key]]
      .map((value) => value.split(',').map(Number))
      .map(([q, r]) => ({ q, r }))]));
    replacePatternGeometry(selected, channels);
    updateUnlock(selected, unlock);
    Object.assign(UNIT_PROFILES[selected], profile);
    for (const key of ['opening', 'middle', 'late'] as EraKey[]) setEraBand(key, eras[key].start, eras[key].end);
    setEras({ ...ERA_BANDS });
    saveCustomization();
    setSaved(`${pattern.name} geometry and era bands saved for future simulations.`);
    onChanged();
  };

  const restore = (id: PatternId) => {
    resetPattern(id);
    Object.assign(UNIT_PROFILES[id], FACTORY_PROFILES[id]);
    selectUnit(id);
    saveCustomization();
    onChanged();
    setSaved(`${PATTERN_BY_ID[id].name} restored to factory geometry.`);
  };

  const resetAll = () => {
    resetCustomization();
    setEras({ ...ERA_BANDS });
    setDraft(makeDraft(selected));
    setProfile({ ...UNIT_PROFILES[selected] });
    setUnlock(PATTERN_BY_ID[selected].unlock);
    onChanged();
    setSaved('All patterns and era bands restored to factory defaults.');
  };

  return (
    <div className="design-page">
      <div className="subpage-head">
        <div><button className="back-link" onClick={onBack}><ArrowLeft size={15} /> Back to lab</button>
          <span className="micro-label">DESIGN STUDIO / RULESET AUTHORING</span>
          <h1>Shape the <em>rules.</em></h1>
          <p>Paint attack geometry, adjust tech unlocks, and move the era boundaries. Saved rules are used by every new simulation and playable match.</p></div>
        <div className="design-actions"><button onClick={resetAll}><RotateCcw size={14} /> Restore factory</button><button className="primary" onClick={save}><Save size={14} /> Save rules</button></div>
      </div>
      {saved && <div className="saved-banner"><Check size={15} /> {saved}</div>}

      <div className="design-grid">
        <section className="designer-panel">
          <div className="designer-title"><div><span className="micro-label">PATTERN EDITOR</span><h2>{pattern.name}</h2></div>
            <button className="mini-action" onClick={() => restore(selected)}><RotateCcw size={12} /> Reset unit</button></div>
          <div className="layout-rule"><span>TECH STAGE</span><input type="number" min={1} max={40} value={unlock}
            onChange={(event) => setUnlock(Number(event.target.value))} /><small>Era: {stageEra(unlock)}</small></div>
          <div className="brush-row" role="group" aria-label="Pattern paint channel">
            {BRUSHES.map((item) => <button key={item.key} className={brush === item.key ? 'is-active' : ''}
              style={{ '--brush': item.color } as React.CSSProperties} onClick={() => setBrush(item.key)}>
              <i /> {item.label}<small>{draft[item.key].size}</small>
            </button>)}
            <span className="brush-hint"><Eraser size={12} /> Click a painted hex to erase. Each hex has exactly one channel.</span>
          </div>
          <div className="pattern-canvas">
            <svg viewBox="0 0 600 440" role="img" aria-label={`${pattern.name} editable attack pattern`}>
              {CELLS.map((hex) => {
                const { x, y } = center(hex);
                const origin = hex.q === 0 && hex.r === 0;
                const channel = cellChannel.get(hexKey(hex));
                const color = origin ? '#9a78b0' : channel ? BRUSHES.find((item) => item.key === channel)!.color : '#2b3934';
                return <g key={hexKey(hex)} className="pattern-cell" onClick={() => paint(hex)} role="button" tabIndex={0}
                  onKeyDown={(event) => { if (event.key === 'Enter') paint(hex); }} aria-label={`${hex.q},${hex.r} ${channel || 'empty'}`}>
                  <polygon points={points(x, y, 23)} fill={color} fillOpacity={origin ? 1 : channel ? 0.94 : 0.8}
                    stroke={origin ? '#f7e7ff' : channel ? '#e8ead7' : '#526257'} strokeWidth={origin ? 1.6 : 0.9} />
                  {origin && <text x={x} y={y + 4} textAnchor="middle" className="pattern-center">{pattern.short}</text>}
                </g>;
              })}
            </svg>
            <div className="pattern-key">{BRUSHES.map((item) => <span key={item.key}><i style={{ background: item.color }} />{item.label}<b>{draft[item.key].size}</b></span>)}</div>
          </div>
          <div className="profile-editor">
            <div className="profile-title"><div><span className="micro-label">TACTICAL BEHAVIOR TABLE</span><h3>This unit's AI weights</h3></div>
              <label className="siege-toggle"><input type="checkbox" checked={profile.siege} onChange={(event) => { const next = { ...profile, siege: event.target.checked }; setProfile(next); Object.assign(UNIT_PROFILES[selected], next); }} /> Siege objective</label></div>
            <p className="design-help">Every unit evaluates moves with this table, not one shared heuristic. Higher aggression advances; higher caution avoids predicted enemy moves. Objective is multiplied only when siege is enabled.</p>
            <div className="profile-grid">
              {([['aggression', 'Aggression'], ['caution', 'Caution'], ['objective', 'Objective'], ['spacing', 'Cohesion'], ['focus', 'Focus fire'], ['intercept', 'Intercept'], ['mobility', 'Mobility'], ['idealRange', 'Ideal range'], ['defense', 'Defense'], ['attackPriority', 'Attack priority']] as const).map(([key, label]) =>
                <label key={key}><span>{label}</span><input type="number" min={0} max={key === 'idealRange' ? 4 : 4} step={key === 'idealRange' ? 1 : 0.05} value={profile[key]}
                  onChange={(event) => { const next = { ...profile, [key]: Number(event.target.value) }; setProfile(next); Object.assign(UNIT_PROFILES[selected], next); }} /><i style={{ width: `${Math.min(100, (profile[key] / (key === 'idealRange' ? 4 : 2.5)) * 100)}%` }} /></label>)}
            </div>
            <div className="profile-foot"><span>Preferred targets: {profile.preferredTargets.length ? profile.preferredTargets.join(' / ') : 'value-based'}</span><span>{profile.siege ? 'Can invest in city encirclement' : 'Ignores city encirclement / hunts units'}</span></div>
          </div>
        </section>

        <aside className="design-side">
          <section className="design-box"><span className="micro-label">UNIT LOADOUT</span>
            <p className="design-help">Select a unit to edit its geometry. Tech order is editable below.</p>
            <div className="design-unit-list">{PATTERNS.map((unit) => <button key={unit.id}
              className={selected === unit.id ? 'is-selected' : ''} onClick={() => selectUnit(unit.id)}>
              <span className="unit-mark tiny">{unit.short}</span><span>{unit.name}<small>T{String(unit.unlock).padStart(2, '0')} / {stageEra(unit.unlock)}</small></span>
            </button>)}</div>
          </section>
          <section className="design-box"><span className="micro-label">ERA WINDOWS</span>
            <p className="design-help">These boundaries define “Opening”, “Middle” and “Late” in rosters and reports.</p>
            {(['opening', 'middle', 'late'] as EraKey[]).map((key) => <div className="era-editor-row" key={key}>
              <strong>{ERA_BANDS[key].label}</strong><label>From<input type="number" min={1} max={39} value={eras[key].start}
                onChange={(event) => setEras((current) => ({ ...current, [key]: { ...current[key], start: Number(event.target.value) } }))} /></label>
              <label>To<input type="number" min={2} max={40} value={eras[key].end}
                onChange={(event) => setEras((current) => ({ ...current, [key]: { ...current[key], end: Number(event.target.value) } }))} /></label>
            </div>)}
            <p className="design-note"><Sparkles size={13} /> Save rules applies both geometry and era windows.</p>
          </section>
        </aside>
      </div>
      <div className="design-note-footer">
        <span>Factory reference retained</span>
        <span>Patterns within radius 4</span>
        <span>Changes apply to new runs, not retroactively to saved studies</span>
      </div>
    </div>
  );
}
