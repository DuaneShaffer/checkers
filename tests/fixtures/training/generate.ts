// Regenerate with: node tests/fixtures/training/generate.ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Game,
  Rng,
  TRAIN_MAX_PLIES,
  allOpenings,
  applyMove,
  legalMoves,
  moveToString,
  popcount,
  resultString,
  type Move,
  type Position,
  type Side,
} from '../../../src/engine/index.ts';
import {
  CKN1_MAGIC,
  CKN1_VERSION,
  DEFAULT_LAYERS,
  ckn1HeaderBytes,
  ckn1ParamCount,
  type BaselineId,
  type GameRecord,
  type GenFile,
  type GenerationSummary,
  type PlayerId,
  type TrainingManifest,
  type WDL,
} from '../../../src/shared/formats.ts';

const OUT = dirname(fileURLToPath(import.meta.url));
const GENERATIONS = 40;
const GAMES_PER_GEN = 2000;
const NET_GENS = new Set([0, 10, GENERATIONS - 1]);
const BASELINES: { id: BaselineId; name: string; elo: number }[] = [
  { id: 'random', name: 'Random mover', elo: 412 },
  { id: 'heur2', name: 'Heuristic d2', elo: 768 },
  { id: 'heur4', name: 'Heuristic d4', elo: 1000 },
  { id: 'heur6', name: 'Heuristic d6', elo: 1163 },
];

const rng = new Rng(20261019);
const openings = allOpenings(3);

function eloAt(gen: number): number {
  const t = gen / (GENERATIONS - 1);
  const curve = 330 + 1050 / (1 + Math.exp(-7 * (t - 0.38)));
  return Math.round(curve + (rng.next() - 0.5) * 36);
}

function material(p: Position, side: Side): number {
  const own = side === 0 ? p.black : p.white;
  const opp = side === 0 ? p.white : p.black;
  const score = (b: number) => popcount(b) + 0.5 * popcount(b & p.kings);
  return score(own) - score(opp);
}

function replyWorst(p: Position, side: Side): number {
  let worst = Infinity;
  for (const reply of legalMoves(p)) worst = Math.min(worst, material(applyMove(p, reply), side));
  return worst === Infinity ? 100 : worst;
}

function chooseMove(game: Game, skill: number): { move: Move; explored: boolean } {
  const moves = game.legalMoves();
  const p = game.position;
  if (rng.next() >= skill) return { move: rng.pick(moves), explored: rng.next() < 0.3 };
  let best: Move[] = [];
  let bestScore = -Infinity;
  for (const m of moves) {
    const score = replyWorst(applyMove(p, m), p.turn) + rng.next() * 0.2;
    if (score > bestScore + 1e-9) { bestScore = score; best = [m]; }
    else if (Math.abs(score - bestScore) < 1e-9) best.push(m);
  }
  return { move: rng.pick(best), explored: false };
}

function evalOf(p: Position, skill: number): number {
  const m = material(p, 0);
  const noise = (rng.next() - 0.5) * (40 - 30 * skill);
  return Math.max(-100, Math.min(100, Math.round(100 * Math.tanh(m / 3) + noise)));
}

function playGame(id: string, kind: GameRecord['kind'], black: PlayerId, white: PlayerId, skill: [number, number]): GameRecord {
  const game = new Game({ maxPlies: TRAIN_MAX_PLIES });
  const opening = kind === 'selfplay' ? rng.pick(openings) : [];
  const evals: number[] = [];
  const explore: number[] = [];
  for (const mv of opening) {
    evals.push(evalOf(game.position, 0));
    game.play(mv);
  }
  while (!game.status().over) {
    const side = game.position.turn;
    evals.push(evalOf(game.position, skill[side]));
    const { move, explored } = chooseMove(game, skill[side]);
    if (explored) explore.push(game.ply);
    game.play(move);
  }
  const status = game.status();
  if (!status.over) throw new Error('unreachable');
  const rec: GameRecord = {
    id,
    kind,
    black,
    white,
    moves: game.moves.map(moveToString),
    result: resultString(status.winner),
    reason: status.reason,
    evals,
  };
  if (opening.length) rec.random = opening.map((_, i) => i);
  if (explore.length) rec.explore = explore;
  return rec;
}

function skillOf(gen: number): number {
  return Math.min(0.92, 0.15 + 0.8 * (gen / (GENERATIONS - 1)));
}

function wdlFor(diff: number, n: number, drawRate: number): WDL {
  const expected = 1 / (1 + 10 ** (-diff / 400));
  const d = Math.round(n * drawRate * (1 - Math.abs(expected - 0.5)));
  const w = Math.max(0, Math.min(n - d, Math.round(expected * n - d / 2)));
  return { w, d, l: n - w - d };
}

function genFile(gen: number): GenFile {
  const games: GameRecord[] = [];
  const skill = skillOf(gen);
  let decisive = 0;
  for (let i = 0; games.length < 4; i++) {
    const rec = playGame(`g${gen}-s${games.length + 1}`, 'selfplay', gen, gen, [skill, skill]);
    const isDecisive = rec.result !== '1/2-1/2';
    if (!isDecisive && decisive === 0 && games.length === 3 && i < 12) continue;
    if (isDecisive) decisive++;
    games.push(rec);
  }
  const opp: PlayerId = gen === 0 ? 'random' : gen - 1;
  const oppSkill = gen === 0 ? 0 : skillOf(gen - 1);
  games.push(playGame(`g${gen}-x1`, 'gauntlet', gen, 'heur4', [skill, 0.85]));
  games.push(playGame(`g${gen}-x2`, 'gauntlet', opp, gen, [oppSkill, skill]));
  return { format: 1, gen, games };
}

function netBytes(gen: number): Uint8Array {
  const layers = [...DEFAULT_LAYERS];
  const header = ckn1HeaderBytes(layers.length);
  const buf = new ArrayBuffer(header + 4 * ckn1ParamCount(layers));
  const view = new DataView(buf);
  for (let i = 0; i < 4; i++) view.setUint8(i, CKN1_MAGIC.charCodeAt(i));
  view.setUint32(4, CKN1_VERSION, true);
  view.setUint32(8, gen, true);
  view.setUint32(12, layers.length, true);
  layers.forEach((n, i) => view.setUint32(16 + 4 * i, n, true));
  const netRng = new Rng(1000 + gen);
  for (let off = header; off < buf.byteLength; off += 4) view.setFloat32(off, (netRng.next() - 0.5) * 0.2, true);
  return new Uint8Array(buf);
}

function main(): void {
  rmSync(join(OUT, 'gens'), { recursive: true, force: true });
  rmSync(join(OUT, 'nets'), { recursive: true, force: true });
  mkdirSync(join(OUT, 'gens'), { recursive: true });
  mkdirSync(join(OUT, 'nets'), { recursive: true });

  const generations: GenerationSummary[] = [];
  let prevElo = 0;
  const elos: number[] = [];
  for (let gen = 0; gen < GENERATIONS; gen++) {
    const elo = eloAt(gen);
    elos.push(elo);
    const file = genFile(gen);
    const name = `gen-${String(gen).padStart(4, '0')}`;
    writeFileSync(join(OUT, 'gens', `${name}.json`), JSON.stringify(file));
    const vs: GenerationSummary['vs'] = {
      random: wdlFor(elo - BASELINES[0].elo, 20, 0.1),
      heur2: wdlFor(elo - BASELINES[1].elo, 40, 0.35),
      heur4: wdlFor(elo - BASELINES[2].elo, 100, 0.5),
    };
    if (gen > 0) vs.prev = wdlFor(elo - prevElo, 60, 0.6);
    if (gen >= 10 && gen % 5 === 0) {
      vs.prev10 = wdlFor(elo - elos[gen - 10], 40, 0.5);
      vs.heur6 = wdlFor(elo - BASELINES[3].elo, 40, 0.55);
    }
    const plies = file.games.reduce((n, g) => n + g.moves.length, 0) / file.games.length;
    generations.push({
      gen,
      games: (gen + 1) * GAMES_PER_GEN,
      hours: Math.round((gen + 1) * 0.21 * 100) / 100,
      depth: 4,
      elo,
      eloErr: Math.round(70 - 40 * (gen / (GENERATIONS - 1)) + rng.next() * 6),
      vs,
      avgPlies: Math.round(plies * 10) / 10,
      decisive: Math.round((0.92 - 0.55 * (gen / GENERATIONS)) * 1000) / 1000,
      loss: Math.round((0.9 * Math.exp(-gen / 12) + 0.18) * 1000) / 1000,
      replay: `gens/${name}.json`,
      net: null,
    });
    prevElo = elo;
  }

  const recent = generations.slice(-20);
  const champion = recent.reduce((a, b) => (b.elo > a.elo ? b : a)).gen;
  for (const g of generations) {
    if (!NET_GENS.has(g.gen) && g.gen !== champion) continue;
    const name = `gen-${String(g.gen).padStart(4, '0')}.bin`;
    writeFileSync(join(OUT, 'nets', name), netBytes(g.gen));
    g.net = `nets/${name}`;
  }

  const last = generations.at(-1)!;
  const manifest: TrainingManifest = {
    format: 1,
    rules: 'english-draughts',
    run: 'fixture-run',
    updated: '2026-10-19T08:30:00Z',
    net: { layers: [...DEFAULT_LAYERS] },
    totalGames: last.games,
    hours: last.hours,
    champion,
    anchor: { id: 'heur4', elo: 1000 },
    baselines: BASELINES,
    generations,
  };
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
  const empty: TrainingManifest = { ...manifest, run: '', updated: '', totalGames: 0, hours: 0, champion: null, baselines: [], generations: [] };
  writeFileSync(join(OUT, 'manifest-empty.json'), JSON.stringify(empty, null, 1));
  console.log(`wrote ${GENERATIONS} generations, champion ${champion}, nets ${generations.filter((g) => g.net).map((g) => g.gen).join(',')}`);
}

main();
