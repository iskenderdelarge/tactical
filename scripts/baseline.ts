import { mkdirSync, writeFileSync } from 'node:fs';
import { runBatch, initialLearning } from '../src/sim/batch';
import { PATTERNS } from '../src/sim/patterns';

const games = Number(process.argv[2] || 5000);
const seed = Number(process.argv[3] || 20260417);
const mode = process.argv[4] === 'simultaneous' ? 'simultaneous' : 'sequential';
if (!Number.isInteger(games) || games < 100) throw new Error('Provide at least 100 games.');

const result = await runBatch({ games, seed, era: 'all', mode }, initialLearning(), (progress) => {
  if (progress.completed && progress.completed % 500 === 0) {
    console.log(`${progress.completed}/${games} measured games, ${progress.stats?.captures ?? 0} city captures`);
  }
});
if (!result) throw new Error('Benchmark unexpectedly cancelled.');

mkdirSync('src/data', { recursive: true });
writeFileSync(mode === 'sequential' ? 'src/data/baseline.json' : 'src/data/baseline-simultaneous.json', JSON.stringify(result));
console.log(`Saved ${result.stats.games} measured games (${result.stats.rosterGames} rosters + ${result.stats.duelGames} duels).`);
console.log(`Roster results: ${result.stats.wins.join('-')} side wins, ${result.stats.draws} draws, ${result.stats.captures} captures, ${result.stats.eliminations} eliminations.`);
console.log(`Training: ${result.training.games} fixtures, champion v${result.learning.version}, ${result.training.promoted ? 'promoted' : 'retained'}.`);
for (const pattern of PATTERNS) {
  const metric = result.stats.units[pattern.id];
  const rate = metric.deployed ? (metric.wins + metric.draws * 0.5) / metric.deployed : 0;
  console.log(`${pattern.name.padEnd(19)} ${(rate * 100).toFixed(1).padStart(5)}% field win | n=${String(metric.deployed).padStart(4)} | kills=${metric.kills}`);
}