import type { Dispatch, SetStateAction } from 'react';
import { Activity, ArrowRight, ChevronDown, Play, Settings2, Shield, Square } from 'lucide-react';
import type { EraScope, LearningState, Progress, RunSettings } from '../sim/batch';
import { ERA_BANDS } from '../sim/config';

export function RunControls({
  settings, setSettings, runCount, setRunCount, seriesIndex, lowPower, setLowPower, workerCount, onRun, onCancel, running, progress, learning, notice,
}: {
  settings: Omit<RunSettings, 'seed'>;
  setSettings: Dispatch<SetStateAction<Omit<RunSettings, 'seed'>>>;
  runCount: number;
  setRunCount: (value: number) => void;
  seriesIndex: number;
  lowPower: boolean;
  setLowPower: (value: boolean) => void;
  workerCount: number;
  onRun: () => void;
  onCancel: () => void;
  running: boolean;
  progress: Progress | null;
  learning: LearningState;
  notice: string;
}) {
  const last = learning.history[learning.history.length - 1];
  const fraction = progress?.phase === 'training'
    ? 0.12 * progress.trainingCompleted / Math.max(1, progress.trainingTotal)
    : progress ? 0.12 + 0.88 * progress.completed / Math.max(1, progress.total) : 0;
  return (
    <div className="controls-inner">
      <div className="section-kicker"><span className="section-index">02</span> SIMULATION SETUP <Settings2 size={14} /></div>
      <h2>Put the rules<br /><em>to work.</em></h2>
      <p className="control-intro">Run a series. Each run trains candidates, declares the stronger validated model champion, then measures the new champion on fresh battles.</p>

      <div className="control-fields">
        <label className="form-field">
          <span className="field-label">BATTLES PER RUN <span>01 / 03</span></span>
          <div className="number-input-wrap">
            <input type="number" min="100" max="5000" step="100" value={settings.games}
              onChange={(event) => setSettings((current) => ({ ...current, games: Number(event.target.value) }))}
              disabled={running} aria-label="Battles per run" />
            <span>GAMES</span>
          </div>
        </label>

        <label className="form-field">
          <span className="field-label">CONSECUTIVE RUNS <span>02 / 04</span></span>
          <div className="number-input-wrap">
            <input type="number" min="1" max="20" step="1" value={runCount}
              onChange={(event) => setRunCount(Math.max(1, Math.min(20, Number(event.target.value))))}
              disabled={running} aria-label="Consecutive runs" />
            <span>RUNS</span>
          </div>
        </label>

        <div className="form-field">
          <span className="field-label">TURN RESOLUTION <span>03 / 04</span></span>
          <div className="segmented" role="group" aria-label="Turn resolution">
            <button className={settings.mode === 'sequential' ? 'is-active' : ''} disabled={running}
              onClick={() => setSettings((current) => ({ ...current, mode: 'sequential' }))}>Alternating</button>
            <button className={settings.mode === 'simultaneous' ? 'is-active' : ''} disabled={running}
              onClick={() => setSettings((current) => ({ ...current, mode: 'simultaneous' }))}>Simultaneous</button>
          </div>
        </div>

        <label className="form-field">
          <span className="field-label">TECH WINDOW <span>04 / 04</span></span>
          <div className="select-wrap">
            <select value={settings.era} disabled={running} aria-label="Tech window"
              onChange={(event) => setSettings((current) => ({ ...current, era: event.target.value as EraScope }))}>
              <option value="all">All stages / 01-{String(Math.max(13, ...Object.values(ERA_BANDS).map((band) => band.end))).padStart(2, '0')}</option>
              <option value="opening">Opening / {String(ERA_BANDS.opening.start).padStart(2, '0')}-{String(ERA_BANDS.opening.end).padStart(2, '0')}</option>
              <option value="middle">Middle / {String(ERA_BANDS.middle.start).padStart(2, '0')}-{String(ERA_BANDS.middle.end).padStart(2, '0')}</option>
              <option value="late">Late / {String(ERA_BANDS.late.start).padStart(2, '0')}-{String(ERA_BANDS.late.end).padStart(2, '0')}</option>
            </select>
            <ChevronDown size={16} />
          </div>
        </label>
      </div>

      <label className="power-setting">
        <input type="checkbox" checked={lowPower} disabled={running} onChange={(event) => setLowPower(event.target.checked)} />
        <span><strong>Low power</strong><small>{lowPower ? 'One simulation worker' : `Up to ${workerCount} parallel workers`}</small></span>
      </label>

      <button className="run-button" onClick={running ? onCancel : onRun}>
        <span className="run-icon">{running ? <Square size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</span>
        <span>{running ? 'Stop series' : `Run ${runCount} × ${Math.max(0, settings.games || 0).toLocaleString()} battles`}</span>
        <ArrowRight size={18} className="run-arrow" />
      </button>

      <div className={`run-status ${running ? 'is-running' : ''}`} aria-live="polite">
        {running && progress ? <>
          <div className="run-status-line"><span className="live-signal" />
            <strong>{progress.phase === 'training' ? 'Evolving tactical policy' : 'Measuring real outcomes'}</strong><em>RUN {seriesIndex + 1} / {runCount}</em>
            <span>{progress.phase === 'training'
              ? `${progress.trainingCompleted} / ${progress.trainingTotal}`
              : `${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()}`}</span>
          </div>
          <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.max(1, fraction * 100)}%` }} /></div>
        </> : <div className="status-idle"><Activity size={15} /> {notice || 'Ready to simulate. Each run uses a fresh seed.'}</div>}
      </div>

      <div className="policy-footer">
        <div><span className="micro-label">TACTICAL POLICY</span><strong>Version {String(learning.version).padStart(2, '0')}</strong></div>
        <div><span className="micro-label">LEARNING CYCLE</span><strong>{String(learning.generation).padStart(2, '0')} runs</strong></div>
        <div><span className="micro-label">CURRENT GAMES</span><strong>{settings.games.toLocaleString()}</strong></div>
      </div>
      <div className="policy-detail">
        <Shield size={15} />
        <span>{last
          ? `${last.promoted ? 'Challenger promoted' : 'Champion retained'}: ${Math.round(last.candidateScore * 100)}% training, ${Math.round(last.validationScore * 100)}% unseen validation (${last.games} games). Three moves ahead for both sides.`
          : 'Three moves ahead for both sides, pessimistic over the opponent\'s best replies. Training survives reloads.'}</span>
      </div>
    </div>
  );
}