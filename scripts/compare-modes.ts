import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_POLICY, Random, simulateGame, type TurnMode } from '../src/sim/engine';

const pairedSeeds = Number(process.argv[2] || 1000);
const rng = new Random(20260419);
const summary = (mode: TurnMode) => ({ mode, games: 0, wins: [0, 0], draws: 0,
  captures: 0, eliminations: 0, mutual: 0, attrition: 0, totalRounds: 0 });
const alternating = summary('sequential');
const simultaneous = summary('simultaneous');
const started = Date.now();

for (let i = 0; i < pairedSeeds; i++) {
  const seed = rng.int(1, 0x7fffffff);
  const stage = rng.int(1, 13);
  for (const record of [alternating, simultaneous]) {
    const result = simulateGame(seed, { stage, mode: record.mode }, [DEFAULT_POLICY, DEFAULT_POLICY]);
    record.games++;
    record.totalRounds += result.rounds;
    if (result.winner === null) record.draws++;
    else record.wins[result.winner]++;
    if (result.reason === 'capture') record.captures++;
    if (result.reason === 'elimination') record.eliminations++;
    if (result.reason === 'mutual') record.mutual++;
    if (result.reason === 'attrition') record.attrition++;
  }
  if ((i + 1) % 200 === 0) console.log(`${i + 1}/${pairedSeeds} matched seeds evaluated`);
}

mkdirSync('src/data', { recursive: true });
writeFileSync('src/data/mode-comparison.json', JSON.stringify({
  method: 'Same seeded city, terrain, roster, and tech setups in both modes; default policy on both sides; no training fixtures.',
  seed: 20260419, pairedSeeds, alternating, simultaneous, durationMs: Date.now() - started,
}));
console.log({ alternating, simultaneous, durationMs: Date.now() - started });