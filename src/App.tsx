import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity, ArrowUpRight, Check, Copy, Download, FlaskConical,
  Gamepad2, GitCompareArrows, History, Layers3, Palette, RotateCcw, ScanSearch, Shield, Swords, Target, X,
} from 'lucide-react';
import { FieldBoard, UnitAtlas } from './components/HexVisuals';
import { DesignStudio } from './pages/DesignStudio';
import { PlayLab } from './pages/PlayLab';
import { RunControls } from './components/RunControls';
import { DuelTable, EconomyTable, GameFlow, MatchupMatrix, OutcomeBar, RosterTable, type SortBy } from './components/ResultsContent';
import { findings, percent, verdict } from './sim/analysis';
import {
  adaptLearningToPatterns, buildGamePlan, emptyStats, initialLearning, isLearningState, mergeStats, runBatch, runTraining,
  type BatchResult, type BatchStats, type LearningState, type Progress, type RunSettings,
  type SliceResult, type TrainingTrial, type TrialExecutor,
} from './sim/batch';
import { createPool, type SimPool } from './sim/pool';
import { createScenario, setProfileOverlays, snapshot, type BoardSnapshot } from './sim/engine';
import { captureRuleset, loadCustomization, patternFingerprint } from './sim/config';
import type { PatternId } from './sim/patterns';
import baselineData from './data/baseline.json';
import simultaneousData from './data/baseline-simultaneous.json';
import modeComparison from './data/mode-comparison.json';

loadCustomization();

const BASELINE = baselineData as unknown as BatchResult;
const SIMULTANEOUS_BASELINE = simultaneousData as unknown as BatchResult;
// Version the keys so a study created on the old 12 x 9 arena cannot be
// mistaken for results from the current 18 x 14 deployment.
const LEARNING_KEY = 'hexfield-learning-v2';
const HISTORY_KEY = 'hexfield-runs-v2';

function storedLearning(): LearningState {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(LEARNING_KEY) || 'null');
    if (isLearningState(stored)) return adaptLearningToPatterns(stored);
  } catch { /* Continue with the measured reference policy. */ }
  return adaptLearningToPatterns(BASELINE.learning);
}

function storedRuns(): BatchResult[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (Array.isArray(stored)) return stored.filter((run): run is BatchResult =>
      !!run && typeof run === 'object' && !!run.stats && !!run.settings && typeof run.stats.games === 'number').slice(0, 8);
  } catch { /* Continue without saved history. */ }
  return [];
}


function saveJson(result: BatchResult) {
  const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `hexfield-${result.settings.mode}-${result.settings.seed}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  const invitation = useMemo(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return { room: params.get('room'), legacy: params.has('g') };
    } catch { return { room: null, legacy: false }; }
  }, []);
  const [page, setPage] = useState<'lab' | 'design' | 'play'>(invitation.room || invitation.legacy ? 'play' : 'lab');
  const [settings, setSettings] = useState<Omit<RunSettings, 'seed'>>({ games: 500, mode: 'sequential', era: 'all' });
  const [runCount, setRunCount] = useState(1);
  const [lowPower, setLowPower] = useState(false);
  const [seriesIndex, setSeriesIndex] = useState(0);
  const [learning, setLearning] = useState<LearningState>(storedLearning);
  const [history, setHistory] = useState<BatchResult[]>(storedRuns);
  const [current, setCurrent] = useState<BatchResult>(BASELINE);
  const [boardPreview, setBoardPreview] = useState<BoardSnapshot>(() => snapshot(createScenario(28571591, { stage: 12 })));
  const [progress, setProgress] = useState<Progress | null>(null);
  const [activeSettings, setActiveSettings] = useState<RunSettings | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState('Ready to simulate. Each run uses a fresh seed.');
  const [view, setView] = useState<'field' | 'atlas'>('field');
  const [selectedUnit, setSelectedUnit] = useState<PatternId>('heavy2');
  const [resultView, setResultView] = useState<'roster' | 'economy' | 'matrix' | 'duels' | 'flow'>('roster');
  const [sortBy, setSortBy] = useState<SortBy>('unlock');
  const [showHistory, setShowHistory] = useState(false);
  const [copied, setCopied] = useState(false);
  const cancelRef = useRef(false);
  const runningRef = useRef(false);
  const learningRef = useRef(learning);
  learningRef.current = learning;
  const poolRef = useRef<SimPool | null | undefined>(undefined);
  const coresRef = useRef(1);

  useEffect(() => () => { cancelRef.current = true; poolRef.current?.dispose(); }, []);

  useEffect(() => { try { localStorage.setItem(LEARNING_KEY, JSON.stringify(learning)); } catch { /* Persistence is optional. */ } }, [learning]);
  useEffect(() => { setProfileOverlays(adaptLearningToPatterns(learning).profileDeltas); }, [learning]);
  useEffect(() => { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* Persistence is optional. */ } }, [history]);

  const live = running && !!progress?.stats;
  const stats = live && progress?.stats ? progress.stats : current.stats;
  const shownSettings = live && activeSettings ? activeSettings : current.settings;
  const historical = !live && current.learning?.patternFingerprint !== patternFingerprint();
  const activeFindings = useMemo(() => findings(stats, shownSettings), [stats, shownSettings]);
  const judgment = useMemo(() => verdict(stats), [stats]);
  const usableGames = Number.isFinite(settings.games) ? Math.max(100, Math.min(5000, Math.round(settings.games))) : 500;

  // One measured run: train a champion, then fan the game plan out over the
  // worker pool. Falls back to the main thread if workers are unavailable.
  const runSeriesRun = async (
    next: RunSettings,
    startLearning: LearningState,
    pool: SimPool | null,
    cores: number,
  ): Promise<BatchResult | null> => {
    const started = Date.now();
    if (pool) {
      try {
        const rules = captureRuleset();
        const plan = buildGamePlan(next);
        // Pair fixtures are independent, so training can use the same worker
        // pool as measurement without reducing search depth or sample size.
        const executeTrials: TrialExecutor = async (trials, onCompleted) => {
          const results: Array<number | null> = Array(trials.length).fill(null);
          let cursor = 0;
          await Promise.all(Array.from({ length: Math.min(cores, trials.length) }, async (_, worker) => {
            while (!cancelRef.current) {
              const index = cursor++;
              if (index >= trials.length) break;
              results[index] = await pool.run<number>(worker, { type: 'trial', trial: trials[index] as TrainingTrial, rules });
              if (results[index] !== null) onCompleted();
            }
          }));
          return results;
        };
        const training = await runTraining(next, startLearning, (progress) => setProgress(progress),
          () => cancelRef.current, executeTrials);
        if (!training) return null;
        const champion = training.learning;
        const spans: [number, number][] = [];
        const per = Math.max(1, Math.ceil(plan.length / cores));
        for (let from = 0; from < plan.length; from += per) spans.push([from, Math.min(plan.length, from + per)]);
        const partials = new Map<number, BatchStats | undefined>();
        const finals = new Map<number, BatchStats | undefined>();
        let lastPreview: BoardSnapshot | undefined;
        let phase: Progress['phase'] = 'rosters';
        const recompute = () => {
          const merged = emptyStats();
          for (const partial of [...finals.values(), ...partials.values()]) if (partial) mergeStats(merged, partial);
          setProgress({
            phase, completed: merged.games, total: plan.length,
            trainingCompleted: 48, trainingTotal: 48, stats: merged, preview: lastPreview,
          });
        };
        let workerIndex = 0;
        const slices = await Promise.all(spans.map(([from, to]) => {
          const worker = workerIndex++;
          return pool.run<SliceResult, Progress>(
            worker,
            { type: 'slice', settings: next, learning: champion, rules, plan, from, to },
            (progress) => {
              phase = progress.phase;
              if (progress.preview) { lastPreview = progress.preview; setBoardPreview(lastPreview); }
              partials.set(worker, progress.stats);
              recompute();
            },
          ).then((slice) => {
            if (slice) {
              finals.set(worker, slice.stats);
              partials.delete(worker);
              if (slice.preview) { lastPreview = slice.preview; setBoardPreview(slice.preview); }
              recompute();
            }
            return slice;
          });
        }));
        if (slices.some((slice) => !slice)) return null; // Cancelled.
        const stats = emptyStats();
        for (const final of finals.values()) if (final) mergeStats(stats, final);
        return {
          settings: next, stats, learning: champion, training: training.training,
          preview: lastPreview ?? snapshot(createScenario(next.seed, { stage: 8, mode: next.mode })),
          generatedAt: new Date().toISOString(), durationMs: Date.now() - started,
        };
      } catch (error) {
        if (cancelRef.current) return null;
        pool.cancelAll();
        pool.dispose();
        poolRef.current = undefined;
        coresRef.current = 1;
        console.warn('Worker pool failed; falling back to main thread.', error);
      }
    }
    return runBatch(next, startLearning, (progress) => {
      setProgress({ ...progress, stats: progress.stats ? { ...progress.stats } : undefined });
      if (progress.preview && progress.preview.units.length >= 2) setBoardPreview(progress.preview);
    }, () => cancelRef.current);
  };

  const run = async () => {
    if (runningRef.current) return;
    const randomSeed = () => {
      const random = typeof crypto !== 'undefined' && crypto.getRandomValues
        ? crypto.getRandomValues(new Uint32Array(1))[0] : Math.floor(Math.random() * 0xffffffff);
      return (random % 0x7ffffffe) + 1;
    };
    setSettings((previous) => ({ ...previous, games: usableGames }));
    setRunCount((previous) => Math.max(1, Math.min(20, previous)));
    cancelRef.current = false;
    runningRef.current = true;
    setRunning(true);
    setNotice('Starting a simulation series. Every run trains and can promote a new champion.');
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    let activeLearning = learningRef.current;
    const wantedCores = lowPower ? 1 : Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4));
    if (poolRef.current && poolRef.current.cores !== wantedCores) {
      poolRef.current.dispose();
      poolRef.current = undefined;
    }
    if (poolRef.current === undefined) poolRef.current = createPool(lowPower);
    coresRef.current = poolRef.current?.cores ?? 1;
    try {
      for (let index = 0; index < Math.max(1, runCount); index++) {
        if (cancelRef.current) break;
        setSeriesIndex(index);
        const next: RunSettings = { ...settings, games: usableGames, seed: randomSeed() };
        setActiveSettings(next);
        setProgress({ phase: 'training', completed: 0, total: usableGames, trainingCompleted: 0, trainingTotal: 48 });
        const result = await runSeriesRun(next, activeLearning, poolRef.current, coresRef.current);
        if (!result) break;
        activeLearning = result.learning;
        setCurrent(result);
        setHistory((previous) => [result, ...previous].slice(0, 12));
        setLearning(result.learning);
        learningRef.current = result.learning;
        if (result.preview.units.length >= 2) setBoardPreview(result.preview);
        setNotice(`Run ${index + 1} / ${runCount}: ${result.training.promoted ? `champion promoted to v${result.learning.version}` : 'champion retained'} across ${coresRef.current} cores.`);
        setShowHistory(false);
      }
      setNotice(cancelRef.current
        ? 'Series stopped. Completed runs and the current champion are saved.'
        : `${runCount} run${runCount === 1 ? '' : 's'} complete using ${poolRef.current ? `${coresRef.current} worker${coresRef.current === 1 ? '' : 's'}` : 'the main-thread fallback'}. Champion v${activeLearning.version} is now on the field.`);
    } catch (error) {
      setNotice(`Simulation error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      runningRef.current = false;
      setRunning(false);
      setProgress(null);
      setActiveSettings(null);
    }
  };

  const chooseStudy = (result: BatchResult) => {
    setCurrent(result);
    setShowHistory(false);
    setResultView('roster');
    setBoardPreview(result.preview.units.length
      ? result.preview
      : snapshot(createScenario(result.settings.seed ^ 0x2db913,
        { stage: Math.min(12, Math.max(3, result.preview.stage)), mode: result.settings.mode })));
  };

  const openAtlas = (id: PatternId) => {
    setSelectedUnit(id);
    setView('atlas');
    document.getElementById('workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const copySeed = async () => {
    try {
      await navigator.clipboard.writeText(String(shownSettings.seed));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { setNotice(`Seed: ${shownSettings.seed}`); }
  };

  return (
    <div className="app-shell">
      <aside className="rail" aria-label="Primary navigation">
        <a className="rail-logo" href="#top" aria-label="Hexfield home"><span>H</span><i /></a>
        <nav className="rail-nav">
          <button className={`rail-link ${page === 'lab' ? 'is-current' : ''}`} title="Simulation lab" onClick={() => { setPage('lab'); window.scrollTo({ top: 0 }); }}><ScanSearch size={20} strokeWidth={1.7} /><span>Lab</span></button>
          <button className={`rail-link ${page === 'design' ? 'is-current' : ''}`} title="Design studio" onClick={() => { setPage('design'); window.scrollTo({ top: 0 }); }}><Palette size={20} strokeWidth={1.7} /><span>Design</span></button>
          <button className={`rail-link ${page === 'play' ? 'is-current' : ''}`} title="Play a match" onClick={() => { setPage('play'); window.scrollTo({ top: 0 }); }}><Gamepad2 size={20} strokeWidth={1.7} /><span>Play</span></button>
          <button className={`rail-link ${page === 'lab' ? '' : ''}`} title="Unit atlas" onClick={() => { setPage('lab'); openAtlas(selectedUnit); }}><Layers3 size={20} strokeWidth={1.7} /><span>Atlas</span></button>
          <button className={`rail-link ${page === 'lab' ? '' : ''}`} title="Reports" onClick={() => { setPage('lab'); setTimeout(() => document.getElementById('results')?.scrollIntoView({ behavior: 'smooth' }), 30); }}><Activity size={20} strokeWidth={1.7} /><span>Reports</span></button>
        </nav>
        <div className="rail-foot"><span className="rail-dot" /> V 1.0</div>
      </aside>

      <main id="top" className="main-content">
        {page === 'design' ? <DesignStudio onBack={() => setPage('lab')} onChanged={() => {
          const next = adaptLearningToPatterns(learningRef.current);
          setLearning(next);
          setProfileOverlays(next.profileDeltas);
        }} />
          : page === 'play' ? <PlayLab learning={learning} onBack={() => setPage('lab')} initialRoom={invitation.room} legacyInvite={invitation.legacy} />
          : <>
        <div className="topline"><span>HEXFIELD <b>/</b> TACTICAL RESEARCH DESK</span>
          <div><span className="topline-dot" /> SYSTEM ONLINE <span className="topline-divider">/</span> SELECTIVE 3-PLY SEARCH</div></div>

        <header className="page-heading">
          <div className="heading-copy">
            <div className="eyebrow"><span className="eyebrow-line" /> CIVILIZATION COMBAT, UNDER THE MICROSCOPE</div>
            <h1>HEX<span>FIELD</span><em>.</em></h1>
            <p>A self-learning war room for testing every move, every matchup, and the balance in between.</p>
          </div>
          <div className="heading-aside"><span>{historical ? 'HISTORICAL STUDY' : 'THE CURRENT STUDY'}</span><strong>{current.stats.games.toLocaleString()}</strong><small>measured battles on record</small></div>
        </header>

        <section id="workspace" className="workspace-grid" aria-label="Tactical field and simulation controls">
          <div className="field-panel">
            <div className="field-panel-header"><div><span className="section-index light">01</span><span>{view === 'field' ? 'THE TACTICAL FIELD' : 'THE UNIT ATLAS'}</span>
              {view === 'field' && <span className="field-meta">ARENA 18 x 14 / ROUND {String(boardPreview.round).padStart(2, '0')} / TECH {String(boardPreview.stage).padStart(2, '0')}</span>}</div>
              <div className="view-toggle" role="group" aria-label="Field view">
                <button className={view === 'field' ? 'is-active' : ''} onClick={() => setView('field')}><Swords size={14} /> Field</button>
                <button className={view === 'atlas' ? 'is-active' : ''} onClick={() => setView('atlas')}><Layers3 size={14} /> Atlas</button>
              </div></div>
            {view === 'field' ? <FieldBoard preview={boardPreview} /> : <UnitAtlas selected={selectedUnit} onSelect={setSelectedUnit} />}
          </div>

          <div className="controls-panel"><RunControls settings={settings} setSettings={setSettings}
            runCount={runCount} setRunCount={setRunCount} seriesIndex={seriesIndex}
            lowPower={lowPower} setLowPower={setLowPower} workerCount={Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4))}
            onRun={run} onCancel={() => { cancelRef.current = true; poolRef.current?.cancelAll(); setNotice('Stopping after the current simulation chunk...'); }}
            running={running} progress={progress} learning={learning} notice={notice} /></div>
        </section>

        <section id="results" className="results-section">
          <div className="section-title-row"><div><div className="section-kicker"><span className="section-index">03</span> THE EVIDENCE</div>
            <h2>What the battles <em>actually</em> say.</h2></div>
            <div className="result-tools"><div className="history-wrap"><button className="text-tool" disabled={running} onClick={() => setShowHistory((value) => !value)}
              aria-expanded={showHistory}><History size={16} /> Run history</button>
              {showHistory && <div className="history-menu"><div className="history-menu-head">COMPLETED STUDIES <button onClick={() => setShowHistory(false)} aria-label="Close history"><X size={15} /></button></div>
                {history.map((result, index) => <button key={`${result.settings.seed}-${index}`} onClick={() => chooseStudy(result)}>
                  <strong>Run {String(history.length - index).padStart(2, '0')}</strong><span>{result.settings.mode} / {result.stats.games.toLocaleString()} games</span></button>)}
                <button onClick={() => chooseStudy(BASELINE)}><strong>Reference / A</strong><span>Alternating / {BASELINE.stats.games.toLocaleString()} games</span></button>
                <button onClick={() => chooseStudy(SIMULTANEOUS_BASELINE)}><strong>Reference / B</strong><span>Simultaneous / {SIMULTANEOUS_BASELINE.stats.games.toLocaleString()} games</span></button>
                <div className="history-reset"><button onClick={() => { if (window.confirm('Reset the learned AI to its original policy? Saved studies will remain.')) { setLearning(initialLearning()); setNotice('AI policy reset to version 01.'); setShowHistory(false); } }}>
                  <RotateCcw size={13} /> Reset learned AI</button></div>
              </div>}</div>
              <button className="text-tool" disabled={running} onClick={() => saveJson(current)}><Download size={16} /> Export data</button></div></div>

          <div className="study-overview">
            <div className="study-id"><span className="micro-label">{live ? 'PARTIAL LIVE RESULTS' : historical ? 'HISTORICAL RULES / RUN AGAIN' : 'SELECTED STUDY'} / {shownSettings.mode.toUpperCase()}</span>
              <div><strong>{stats.games.toLocaleString()}</strong><span>measured<br />battles</span></div>
              <button className="seed-button" onClick={copySeed}>{copied ? <Check size={12} /> : <Copy size={12} />} SEED {shownSettings.seed}</button>
            </div>
            <OutcomeBar stats={stats} />
            <div className="study-context"><span className="micro-label">WIN CONDITION MIX</span><strong>{percent(stats.captures / Math.max(1, stats.rosterGames))}</strong>
              <span>city captures</span><small>{stats.captures} captures / {stats.eliminations} eliminations</small></div>
          </div>

          <div className="analysis-grid">
            <div className="data-main">
              <div className="data-heading"><div><span className="micro-label">BALANCE INTELLIGENCE / 13 VARIANTS</span><h3>{resultView === 'roster' ? 'The roster ledger.' : resultView === 'economy' ? 'Fair price by era.' : resultView === 'matrix' ? 'The whole matchup grid.' : resultView === 'flow' ? 'How battles flow.' : 'Every head-to-head.'}</h3></div>
                <div className="data-tabs" role="tablist" aria-label="Analysis view">
                  {([['roster', 'Roster'], ['economy', 'Economy'], ['matrix', 'Matrix'], ['duels', 'Duels'], ['flow', 'Game flow']] as const).map(([key, label]) =>
                    <button key={key} role="tab" aria-selected={resultView === key} className={resultView === key ? 'is-active' : ''}
                      onClick={() => setResultView(key)}>{label}</button>)}
                </div>
              </div>
              <AnimatePresence mode="wait"><motion.div key={resultView} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: 0.2 }}>
                {resultView === 'roster' ? <RosterTable stats={stats} sortBy={sortBy} setSortBy={setSortBy} onSelect={(id) => { setSelectedUnit(id); setResultView('duels'); }} />
                  : resultView === 'economy' ? <EconomyTable stats={stats} />
                  : resultView === 'matrix' ? <MatchupMatrix stats={stats} selected={selectedUnit} onSelect={(id) => { setSelectedUnit(id); setResultView('duels'); }} />
                  : resultView === 'flow' ? <GameFlow stats={stats} />
                  : <DuelTable stats={stats} selected={selectedUnit} onSelect={setSelectedUnit} onPattern={() => openAtlas(selectedUnit)} />}
              </motion.div></AnimatePresence>
            </div>

            <aside className="findings-panel" aria-label="Balance assessment">
              <div className="findings-title"><FlaskConical size={19} strokeWidth={1.6} /><span>ANALYST NOTES</span></div>
              <h3>Read the<br /><em>signal.</em></h3>
              <div className="finding-list">{activeFindings.map((finding) => <article key={finding.tag} className={`finding finding-${finding.tone}`}>
                <span>{finding.tag}</span><h4>{finding.title}</h4><p>{finding.body}</p></article>)}</div>
              <div className="verdict"><span>DESIGN VERDICT</span><h4>{judgment.title}</h4><p>{judgment.text}</p></div>
            </aside>
          </div>
        </section>

        <section id="method" className="method-section">
          <div className="method-head"><div className="section-kicker"><span className="section-index">04</span> HOW TO READ THIS LAB</div>
            <h2>Measured, not guessed.</h2><p>Clear assumptions matter as much as the numbers.</p></div>
          <div className="method-grid">
            <div className="method-column"><Target size={22} /><span>01 / THE RULES</span><h3>Diagram-faithful geometry.</h3>
              <p>All 13 variants across seven families use explicit axial hex offsets. Red moves or kills and occupies; green only moves; brown kills without advancing; blue kills and occupies only an enemy-filled hex. In simultaneous rounds every attack resolves before any movement, so a targeted unit cannot move away, and two units fighting for one hex both stay put. Obstacles stop movement and charges; enemy bodies and terrain block ranged sight, friendly bodies do not.</p></div>
            <div className="method-column"><GitCompareArrows size={22} /><span>02 / THE SAMPLE</span><h3>Two different tests.</h3>
              <p>Era-matched rosters use the latest buildable variant, with an occasional retained older veteran. The 18 × 14 arena, both cities, obstacles, and every unit position are randomized from a fresh seed. The ledger measures fielded outcomes; mirrored one-on-one trials isolate direct matchups under alternating resolution. Training games are excluded from both samples.</p></div>
            <div className="method-column"><Shield size={22} /><span>03 / THE SEARCH</span><h3>Learning with a holdout.</h3>
              <p>At each alternating action the AI scores its top three candidates against three moves ahead for both armies. Opponent plies are evaluated pessimistically over their two best replies, rollout results are memoized by position, and near-tied candidates are sampled during self-play to avoid single-line collapse. It is a selective rollout, not an exhaustive solve. Each run tests challengers against the champion on mirrored seeds and validates on unseen seeds.</p></div>
          </div>

          <div className="mode-comparison"><div className="mode-copy"><span className="micro-label">HISTORICAL MATCHED RULE EXPERIMENT</span><h3>Turn order changes everything.</h3>
            <p>These {modeComparison.pairedSeeds.toLocaleString()} matched setups used an earlier ruleset. Run new studies after changing patterns; historical outcomes are not measurements of the current design.</p></div>
            <div className="mode-rates">
              <div><span>ALTERNATING</span><strong>{percent(modeComparison.alternating.captures / modeComparison.alternating.games)}</strong><small>city finishes / {(modeComparison.alternating.totalRounds / modeComparison.alternating.games).toFixed(1)} avg rounds</small><i style={{ width: `${modeComparison.alternating.captures / modeComparison.alternating.games * 100}%` }} /></div>
              <div><span>SIMULTANEOUS</span><strong>{percent(modeComparison.simultaneous.captures / modeComparison.simultaneous.games)}</strong><small>city finishes / {(modeComparison.simultaneous.totalRounds / modeComparison.simultaneous.games).toFixed(1)} avg rounds</small><i style={{ width: `${modeComparison.simultaneous.captures / modeComparison.simultaneous.games * 100}%` }} /></div>
            </div>
          </div>
          <div className="learning-ledger">
            <div className="learning-copy"><span className="micro-label">PERSISTENT POLICY / LOCAL TRAINING TRACE</span>
              <h3>Every run leaves a trace.</h3>
              <p>These are the latest generations stored in this browser. Training and unseen-validation scores are separate from the measured battle sample. A challenger becomes champion only after clearing both gates; otherwise the incumbent is retained.</p></div>
            <div className="learning-trace">
              <div className="learning-head"><span>GEN</span><span>TRAINING</span><span>HELD OUT</span><span>OUTCOME</span></div>
              {learning.history.length === 0
                ? <div className="learning-empty"><History size={16} /> Run a simulation to start the policy trace.</div>
                : [...learning.history].slice(-7).reverse().map((record) => <div className="learning-row" key={`${record.generation}-${record.version}`}>
                  <span className="learning-gen">{String(record.generation).padStart(2, '0')}</span>
                  <span className="learning-meter"><i style={{ width: `${record.candidateScore * 100}%` }} /><b>{Math.round(record.candidateScore * 100)}%</b></span>
                  <span className="learning-meter held"><i style={{ width: `${record.validationScore * 100}%` }} /><b>{Math.round(record.validationScore * 100)}%</b></span>
                  <span className={`learning-outcome ${record.promoted ? 'is-promoted' : ''}`}>{record.promoted ? `Promoted / v${record.version}` : 'Retained'}</span>
                </div>)}
            </div>
          </div>
          <div className="method-note"><span><ScanSearch size={15} /> IMPORTANT LIMIT</span>
            <p>No production costs, terrain bonuses, economy, fog of war, or human preferences were supplied. AI win rates test this combat specification, not the fun of a full 1-2 hour game. The supplied list contains 13 variants despite describing them as 12.</p></div>
        </section>

        <footer className="site-footer"><div><span className="footer-brand">HEXFIELD<span>.</span></span><span>TACTICAL RESEARCH DESK</span></div>
          <span>SIMULATE / COMPARE / REFINE <ArrowUpRight size={14} /></span></footer>
        </>}
      </main>
    </div>
  );
}
