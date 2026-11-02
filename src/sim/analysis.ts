import { confidenceMargin, duelAggregate, duelScore, fieldWinRate, type BatchStats, type RunSettings } from './batch';
import { PATTERNS, PATTERN_BY_ID, type PatternId } from './patterns';

export type Finding = { tag: string; title: string; body: string; tone: 'warning' | 'neutral' | 'positive' };

export const percent = (value: number, digits = 1): string => `${(value * 100).toFixed(digits)}%`;

export function findings(stats: BatchStats, settings: RunSettings): Finding[] {
  const games = Math.max(1, stats.rosterGames);
  const captureRate = stats.captures / games;
  const drawRate = stats.draws / games;
  const candidates = PATTERNS.filter((pattern) => stats.units[pattern.id].deployed >= 40)
    .sort((a, b) => fieldWinRate(stats.units[b.id]) - fieldWinRate(stats.units[a.id]));
  const best = candidates[0];
  const weakest = candidates[candidates.length - 1];
  const result: Finding[] = [];

  result.push({
    tag: '01 / OBJECTIVE',
    title: captureRate < 0.12 ? 'The city is rarely the finish line.' : 'City pressure is deciding fights.',
    body: `${percent(captureRate)} of ${stats.rosterGames.toLocaleString()} roster battles ended by encirclement; ${percent(stats.eliminations / games)} ended by elimination. The six-hex requirement plus one physical occupier makes the city goal ${captureRate < 0.12 ? 'hard to complete before the armies are gone.' : 'a real alternative to killing every unit.'}`,
    tone: captureRate < 0.12 ? 'warning' : 'positive',
  });

  if (best && weakest && best.id !== weakest.id) {
    const top = stats.units[best.id];
    const bottom = stats.units[weakest.id];
    result.push({
      tag: '02 / ROSTER SIGNAL',
      title: `${best.name} leads the fielded results.`,
      body: `${percent(fieldWinRate(top))} across ${top.deployed} deployments versus ${percent(fieldWinRate(bottom))} for ${weakest.name} across ${bottom.deployed}. These are outcomes when fielded in era-matched rosters, not cost-normalized unit power. Use the controlled duels below to inspect the matchup itself.`,
      tone: 'neutral',
    });
  } else {
    result.push({ tag: '02 / SAMPLE', title: 'More roster games will sharpen the comparison.',
      body: 'Run a larger all-eras batch to get meaningful samples for every unlock and veteran variant.', tone: 'neutral' });
  }

  const specialistIds = ['anti', 'sniper', 'harrier'] as PatternId[];
  const specialists = specialistIds.map((id) => ({ id, aggregate: duelAggregate(stats, id) }))
    .filter(({ aggregate }) => aggregate.games >= 40);
  if (specialists.length === specialistIds.length) {
    const names = specialists.map(({ id }) => PATTERN_BY_ID[id].name);
    const scores = specialists.map(({ aggregate }) => duelScore(aggregate));
    const low = Math.min(...scores);
    const high = Math.max(...scores);
    const specialistDeployed = specialistIds.reduce((sum, id) => sum + stats.units[id].deployed, 0);
    result.push({
      tag: '03 / SPECIALISTS',
      title: low < 0.45 && high < 0.6 ? 'Specialist geometry needs another pass.' : 'Specialists trade evenly in isolation.',
      body: `${names[0]}, ${names[1]} and ${names[2]} score ${scores.map((score) => percent(score)).join(', ')} across ${specialists.reduce((sum, item) => sum + item.aggregate.games, 0)} alternating duels; they appear in ${specialistDeployed.toLocaleString()} deployments. The Hunter's ${PATTERN_BY_ID.anti.blue.length} enemy-only pounces, the Sniper's fixed firing lanes, and the Harrier's limited attacks make positioning especially important. Roster results are not cost-normalized.`,
      tone: low < 0.45 ? 'warning' : 'neutral',
    });
  }

  result.push({
    tag: '04 / TEMPO',
    title: drawRate > 0.25 ? 'Positioning can become a stalemate.' : 'Exchanges are decisive, sometimes abruptly.',
    body: `${percent(drawRate)} of roster games reached a draw. In ${settings.mode === 'simultaneous' ? 'simultaneous' : 'alternating'} resolution, one-hit kills and exact attack lanes make ${drawRate > 0.25 ? 'missed orders, mutual threats and blocked approaches a real pacing risk.' : 'every exposed move matter. A mistake can erase a unit immediately, so human playtests should check whether losses feel earned.'}`,
    tone: drawRate > 0.25 ? 'warning' : 'neutral',
  });

  return result;
}

export function verdict(stats: BatchStats): { title: string; text: string } {
  const games = Math.max(1, stats.rosterGames);
  const drawRate = stats.draws / games;
  const cityRate = stats.captures / games;
  const attritionRate = (stats.attritionWins || 0) / games;
  if (attritionRate > 0.25) return {
    title: 'Tactics land. Watch the stalemates.',
    text: `${percent(attritionRate)} of roster battles needed a repetition or round-limit adjudication. The one-hit geometry creates sharp decisions, but a high adjudication rate suggests that some armies cannot force contact. Human playtests should check whether the pacing and city objective feel satisfying.`,
  };
  if (cityRate < 0.1 || drawRate > 0.25) return {
    title: 'Promising tactics. An underused objective.',
    text: 'Distinct movement geometry creates readable matchups and sharp positioning decisions. As tested, however, most battles are won by removal rather than the advertised city condition. Try a softer encirclement threshold or a multi-round siege clock, then rerun the same seeds. AI self-play measures outcomes, not whether humans enjoy the tension.',
  };
  return {
    title: 'A strong tactical foundation.',
    text: 'The unit silhouettes create different positioning problems and cities provide another route to victory. Check upgrade costs, production pacing and human decision time before treating AI win rates as a verdict on fun.',
  };
}

export function matchupSummary(stats: BatchStats, selected: PatternId): string {
  const aggregate = duelAggregate(stats, selected);
  if (!aggregate.games) return 'No controlled duels in this run.';
  const uncertainty = confidenceMargin(duelScore(aggregate), aggregate.games);
  const name = PATTERN_BY_ID[selected].name;
  return `${name} scores ${percent(duelScore(aggregate))} across ${aggregate.games} controlled duel observations under alternating resolution (rough 95% margin +/-${percent(uncertainty)}). Draws count as half a win.`;
}