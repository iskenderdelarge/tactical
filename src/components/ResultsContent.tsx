import { useMemo } from 'react';
import { ArrowUpRight, ChevronDown } from 'lucide-react';
import { matchupSummary, percent } from '../sim/analysis';
import { stageEra } from '../sim/config';
import { confidenceMargin, duelAggregate, duelScore, fieldWinRate, type BatchStats } from '../sim/batch';
import { PATTERNS, PATTERN_BY_ID, type PatternId } from '../sim/patterns';

export type SortBy = 'unlock' | 'field' | 'duel';

export function OutcomeBar({ stats }: { stats: BatchStats }) {
  const total = Math.max(1, stats.rosterGames);
  return (
    <div className="outcome-area">
      <div className="outcome-header"><span>ROSTER BATTLE OUTCOMES</span><span>{stats.rosterGames.toLocaleString()} GAMES</span></div>
      <div className="outcome-bar" role="img" aria-label={`Army A ${stats.wins[0]} wins, Army B ${stats.wins[1]} wins, ${stats.draws} draws`}>
        <div className="outcome-a" style={{ width: `${stats.wins[0] / total * 100}%` }} />
        <div className="outcome-b" style={{ width: `${stats.wins[1] / total * 100}%` }} />
        <div className="outcome-draw" style={{ width: `${stats.draws / total * 100}%` }} />
      </div>
      <div className="outcome-key">
        <span><i className="legend-dot teal" /> Army A <b>{percent(stats.wins[0] / total)}</b></span>
        <span><i className="legend-dot coral" /> Army B <b>{percent(stats.wins[1] / total)}</b></span>
        <span><i className="legend-dot grey" /> Draw <b>{percent(stats.draws / total)}</b></span>
      </div>
    </div>
  );
}

export function RosterTable({ stats, sortBy, setSortBy, onSelect }: {
  stats: BatchStats;
  sortBy: SortBy;
  setSortBy: (sort: SortBy) => void;
  onSelect: (id: PatternId) => void;
}) {
  const rows = useMemo(() => {
    const sorted = [...PATTERNS];
    if (sortBy === 'field') sorted.sort((a, b) => fieldWinRate(stats.units[b.id]) - fieldWinRate(stats.units[a.id]));
    if (sortBy === 'duel') sorted.sort((a, b) => duelScore(duelAggregate(stats, b.id)) - duelScore(duelAggregate(stats, a.id)));
    return sorted;
  }, [stats, sortBy]);
  return <>
    <div className="data-toolbar"><p>Field win counts a draw as half a win. Select a unit for direct matchups.</p>
      <div className="sort-wrap"><span>SORT</span><select value={sortBy}
        onChange={(event) => setSortBy(event.target.value as SortBy)} aria-label="Sort units">
        <option value="unlock">Unlock order</option><option value="field">Field win</option><option value="duel">Duel score</option>
      </select><ChevronDown size={13} /></div></div>
    <div className="table-scroll">
      <div className="unit-table">
        <div className="table-heading"><span>UNIT / FAMILY</span><span>TECH</span><span>FIELD WIN</span><span>DEPLOYED</span><span>KILLS / GAME</span><span>DUEL SCORE</span></div>
        {rows.map((pattern) => {
          const data = stats.units[pattern.id];
          const rate = fieldWinRate(data);
          const duel = duelAggregate(stats, pattern.id);
          return <button key={pattern.id} className={`unit-row ${data.deployed === 0 ? 'unit-row-empty' : ''}`}
            onClick={() => onSelect(pattern.id)} aria-label={`Compare ${pattern.name} with other units`}>
            <span className="unit-name-cell"><span className="unit-mark">{pattern.short}</span>
              <span><strong>{pattern.name}</strong><small>{pattern.family}</small></span></span>
            <span className="tech-cell">{String(pattern.unlock).padStart(2, '0')}</span>
            <span className="field-rate-cell"><b>{data.deployed ? percent(rate) : '--'}</b>
              <span className="mini-track"><span style={{ width: `${data.deployed ? rate * 100 : 0}%` }} /></span></span>
            <span className="numeric-cell">{data.deployed.toLocaleString()}</span>
            <span className="numeric-cell">{data.deployed ? (data.kills / data.deployed).toFixed(2) : '--'}</span>
            <span className="numeric-cell duel-cell">{duel.games ? percent(duelScore(duel)) : '--'}<ArrowUpRight size={13} /></span>
          </button>;
        })}
      </div>
    </div>
    <p className="table-footnote">Field results are conditional on era-matched rosters, not normalized for production cost. Exact win/loss/draw counts and every pattern are in the downloadable data.</p>
  </>;
}

export function DuelTable({ stats, selected, onSelect, onPattern }: {
  stats: BatchStats; selected: PatternId; onSelect: (id: PatternId) => void; onPattern: () => void;
}) {
  const aggregate = duelAggregate(stats, selected);
  const score = duelScore(aggregate);
  return <>
    <div className="duel-intro">
      <div><span className="micro-label">CONTROLLED HEAD-TO-HEAD</span><h3>{PATTERN_BY_ID[selected].name}<span> vs. the field</span></h3>
        <p>{matchupSummary(stats, selected)}</p></div>
      <div className="duel-actions"><div className="select-wrap small"><select value={selected}
        onChange={(event) => onSelect(event.target.value as PatternId)} aria-label="Select unit to compare">
        {PATTERNS.map((pattern) => <option key={pattern.id} value={pattern.id}>{pattern.name}</option>)}</select><ChevronDown size={14} /></div>
        <button onClick={onPattern}>View pattern <ArrowUpRight size={13} /></button></div>
    </div>
    <div className="duel-score-line"><strong>{aggregate.games ? percent(score) : '--'}</strong>
      <span>OVERALL DUEL SCORE <br />{aggregate.games.toLocaleString()} OBSERVATIONS</span>
      <span className="duel-confidence">{aggregate.games ? `Approx. 95% margin +/-${percent(confidenceMargin(score, aggregate.games))}` : 'Run more duels for an estimate.'}</span></div>
    <div className="matchup-head"><span>OPPONENT</span><span>WIN / DRAW / LOSS</span><span>SCORE</span><span>GAMES</span></div>
    {PATTERNS.map((opponent) => {
      const cell = stats.duels[selected][opponent.id];
      const games = Math.max(1, cell.games);
      return <div className="matchup-row" key={opponent.id}>
        <div className="matchup-opponent"><span className="unit-mark tiny">{opponent.short}</span>
          <span>{opponent.name}</span>{selected === opponent.id && <small>mirror</small>}</div>
        <div className="matchup-bar" title={`${cell.wins} wins, ${cell.draws} draws, ${cell.losses} losses`}>
          <span className="matchup-win" style={{ width: `${cell.wins / games * 100}%` }} />
          <span className="matchup-draw" style={{ width: `${cell.draws / games * 100}%` }} />
          <span className="matchup-loss" style={{ width: `${cell.losses / games * 100}%` }} />
        </div>
        <strong>{cell.games ? percent(duelScore(cell), 0) : '--'}</strong><span>{cell.games}</span>
      </div>;
    })}
    <p className="table-footnote">Controlled duels always use alternating resolution so a lone pair reaches contact even when the selected roster mode is simultaneous. Mirrored seeds switch the starting side. A duel tests geometry and survival, not production cost. Draws count as half a win.</p>
  </>;
}
export function EconomyTable({ stats }: { stats: BatchStats }) {
  const eras: import('../sim/config').EraKey[] = ['opening', 'middle', 'late'];
  const priceFor = (id: PatternId, era: import('../sim/config').EraKey) => {
    const eraMetric = stats.unitEra?.[id]?.[era];
    const metric = eraMetric && eraMetric.deployed >= 10 ? eraMetric : stats.units[id];
    const rate = fieldWinRate(metric);
    const games = Math.max(1, metric.deployed);
    const kills = metric.kills / games;
    const duel = duelScore(duelAggregate(stats, id));
    const kit = (PATTERN_BY_ID[id].red.length + PATTERN_BY_ID[id].brown.length * 1.4
      + PATTERN_BY_ID[id].blue.length * 0.7 + PATTERN_BY_ID[id].green.length * 0.25) / 12;
    const fairPrice = Math.round(Math.max(25, Math.min(240,
      55 + (rate - 0.48) * 150 + (duel - 0.5) * 90 + kills * 16 + kit * 9)));
    const winPoints = Math.round(Math.max(1, Math.min(100,
      rate * 58 + duel * 30 + kills * 8 + kit * 4)));
    return { fairPrice, winPoints, rate, n: metric.deployed };
  };
  return <>
    <div className="data-toolbar"><p>Fair price and win points are comparative indices derived from field outcomes, controlled duels and kit surface. They are not production costs and must be tuned against your economy.</p></div>
    <div className="economy-table"><div className="economy-head">
      <span>UNIT / ERA</span>{eras.map((era) => <span key={era}>{era === 'opening' ? 'OPENING' : era === 'middle' ? 'MIDDLE' : 'LATE'}<small>PRICE / WP</small></span>)}
    </div>
      {PATTERNS.map((pattern) => {
        const patternEra = stageEra(pattern.unlock);
        return <div className="economy-row" key={pattern.id}>
          <span className="economy-unit"><span className="unit-mark tiny">{pattern.short}</span><span>{pattern.name}<small>Unlock T{String(pattern.unlock).padStart(2, '0')} / {patternEra}</small></span></span>
          {eras.map((era) => {
            const value = priceFor(pattern.id, era);
            return <span className={`economy-value ${era === patternEra ? 'is-native' : ''}`} key={era}>
              <b>{value.fairPrice}g</b><small>{value.winPoints} wp / n={value.n.toLocaleString()}</small></span>;
          })}
        </div>;
      })}
    </div>
    <p className="table-footnote">The highlighted era is where the unit unlocks. Later-era values show retained veterans only when they were actually deployed. Price index scales with measured win contribution and action surface.</p>
  </>;
}

export function MatchupMatrix({ stats, selected, onSelect }: { stats: BatchStats; selected: PatternId; onSelect: (id: PatternId) => void }) {
  return <>
    <div className="data-toolbar"><p>Full controlled matchup matrix. Each cell is the row unit's score against the column unit; darker green is stronger, darker coral is weaker.</p></div>
    <div className="matrix-scroll"><div className="matrix-grid">
      <span className="matrix-corner">ROW VS COL</span>
      {PATTERNS.map((column) => <button key={column.id} className={`matrix-head ${selected === column.id ? 'is-active' : ''}`}
        title={column.name} onClick={() => onSelect(column.id)}>{column.short}</button>)}
      {PATTERNS.map((row) => <div className="matrix-line" key={row.id}>
        <button className={`matrix-row-name ${selected === row.id ? 'is-active' : ''}`} onClick={() => onSelect(row.id)}>
          <span className="unit-mark tiny">{row.short}</span><span>{row.name}</span></button>
        {PATTERNS.map((column) => {
          const cell = row.id === column.id ? null : stats.duels[row.id]?.[column.id];
          const score = cell ? duelScore(cell) : 0.5;
          const strength = Math.round((score - 0.5) * 2 * 100);
          return <button key={column.id} className={`matrix-cell ${score > 0.56 ? 'better' : score < 0.44 ? 'worse' : ''}`}
            style={{ background: score >= 0.5 ? `rgba(91,145,118,${0.08 + (score - 0.5) * 1.7})` : `rgba(187,108,80,${0.08 + (0.5 - score) * 1.7})` }}
            onClick={() => onSelect(row.id)} title={`${row.name} vs ${column.name}: ${cell?.games ? percent(score) : 'no sample'} (${cell?.games || 0} games)`}>
            {row.id === column.id ? '—' : cell?.games ? `${strength > 0 ? '+' : ''}${strength}` : '·'}
          </button>;
        })}
      </div>)}
    </div></div>
    <p className="table-footnote">Positive values are percentage points above a 50% draw baseline. Select a row to open the detailed matchup cards. All controlled duels use alternating resolution and mirrored sides.</p>
  </>;
}

export function GameFlow({ stats }: { stats: BatchStats }) {
  const roster = Math.max(1, stats.rosterGames);
  const fields = [
    { label: 'AVG ROUNDS', value: (stats.totalRounds / roster).toFixed(1), note: `range ${stats.minRounds ?? '—'}–${stats.maxRounds ?? '—'}` },
    { label: 'CITY CAPTURE', value: percent(stats.captures / roster), note: `${stats.captures} sieges finished` },
    { label: 'ELIMINATION', value: percent(stats.eliminations / roster), note: `${stats.eliminations} armies removed` },
    { label: 'ATTRITION', value: percent((stats.attritionWins || 0) / roster), note: 'emergency material decision' },
    { label: 'AVG SURVIVORS', value: (stats.totalSurvivors / roster).toFixed(1), note: 'per completed roster battle' },
    { label: 'KILLS / GAME', value: (stats.totalKills / roster).toFixed(1), note: 'all units, both armies' },
    { label: 'DRAW RATE', value: percent(stats.draws / roster), note: `${stats.mutualDraws} mutual annihilation` },
    { label: 'SIDE WIN SPLIT', value: `${percent(stats.wins[0] / roster, 0)} / ${percent(stats.wins[1] / roster, 0)}`, note: 'Army A / Army B' },
  ];
  return <>
    <div className="data-toolbar"><p>Game-flow telemetry from roster battles only. Controlled duels do not affect these rates.</p></div>
    <div className="flow-grid">{fields.map((field) => <div className="flow-card" key={field.label}><span>{field.label}</span><strong>{field.value}</strong><small>{field.note}</small></div>)}</div>
    <div className="flow-verdict"><span className="micro-label">READING THE FLOW</span>
      <p>{stats.captures / roster < 0.1 ? 'Cities are finishing fewer than one in ten roster battles. Elimination is the real objective; a softer siege rule or siege clock is worth testing.' : 'City pressure is a meaningful share of finishes. Confirm that defenders still have time to react before tightening the rule.'} {stats.draws / roster > 0.25 ? 'The draw rate is high enough to threaten session pacing.' : 'Most battles now produce a winner, which is healthier for a 1–2 hour campaign.'} {stats.attritionWins > stats.captures ? 'Attrition is acting as a safety valve rather than a showcase objective.' : 'The emergency attrition rule is rarely needed.'}</p></div>
  </>;
}
