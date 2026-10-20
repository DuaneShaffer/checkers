export interface PairResult {
  a: string;
  b: string;
  w: number;
  d: number;
  l: number;
}

export interface Rating {
  elo: number;
  err: number;
  games: number;
}

export interface EloOptions {
  anchor: string;
  anchorElo: number;
  priorDraws: number;
  maxIterations: number;
  tolerance: number;
}

export const DEFAULT_ELO: EloOptions = {
  anchor: 'heur4',
  anchorElo: 1000,
  priorDraws: 1,
  maxIterations: 100,
  tolerance: 1e-3,
};

const ELO_PER_NAT = 400 / Math.LN10;
const MAX_STEP = 400 / ELO_PER_NAT;
const RIDGE = 1e-9;

interface Pairing {
  i: number;
  j: number;
  score: number;
  games: number;
}

function aggregate(results: readonly PairResult[], index: Map<string, number>, priorDraws: number): Pairing[] {
  const byPair = new Map<string, Pairing>();
  for (const r of results) {
    const n = r.w + r.d + r.l;
    if (n === 0 || r.a === r.b) continue;
    const [i, j] = [index.get(r.a)!, index.get(r.b)!];
    const flip = i > j;
    const key = flip ? `${j},${i}` : `${i},${j}`;
    const score = r.w + 0.5 * r.d;
    let p = byPair.get(key);
    if (!p) {
      p = { i: Math.min(i, j), j: Math.max(i, j), score: 0.5 * priorDraws, games: priorDraws };
      byPair.set(key, p);
    }
    p.score += flip ? n - score : score;
    p.games += n;
  }
  return [...byPair.values()];
}

/** Bradley-Terry maximum likelihood with draws as half points; errors come from the inverse Fisher information. */
export function fitElo(results: readonly PairResult[], options: Partial<EloOptions> = {}): Map<string, Rating> {
  const opts = { ...DEFAULT_ELO, ...options };
  const ids: string[] = [opts.anchor];
  const index = new Map<string, number>([[opts.anchor, 0]]);
  const games = new Map<string, number>();
  for (const r of results) {
    for (const id of [r.a, r.b]) {
      if (!index.has(id)) {
        index.set(id, ids.length);
        ids.push(id);
      }
    }
    const n = r.w + r.d + r.l;
    games.set(r.a, (games.get(r.a) ?? 0) + n);
    games.set(r.b, (games.get(r.b) ?? 0) + n);
  }
  const pairs = aggregate(results, index, opts.priorDraws);
  const theta = new Float64Array(ids.length);
  const free = ids.length - 1;
  let info = new Float64Array(free * free);

  for (let iter = 0; iter < opts.maxIterations && free > 0; iter++) {
    const grad = new Float64Array(free);
    info = new Float64Array(free * free);
    for (const p of pairs) {
      const prob = 1 / (1 + Math.exp(theta[p.j] - theta[p.i]));
      const g = p.score - p.games * prob;
      const h = p.games * prob * (1 - prob);
      const fi = p.i - 1;
      const fj = p.j - 1;
      if (fi >= 0) {
        grad[fi] += g;
        info[fi * free + fi] += h;
      }
      if (fj >= 0) {
        grad[fj] -= g;
        info[fj * free + fj] += h;
      }
      if (fi >= 0 && fj >= 0) {
        info[fi * free + fj] -= h;
        info[fj * free + fi] -= h;
      }
    }
    for (let k = 0; k < free; k++) {
      info[k * free + k] += RIDGE;
      grad[k] -= RIDGE * theta[k + 1];
    }
    const step = solve(info, grad, free);
    let maxStep = 0;
    for (let k = 0; k < free; k++) maxStep = Math.max(maxStep, Math.abs(step[k]));
    const scale = maxStep > MAX_STEP ? MAX_STEP / maxStep : 1;
    for (let k = 0; k < free; k++) theta[k + 1] += scale * step[k];
    if (maxStep * ELO_PER_NAT < opts.tolerance) break;
  }

  const covDiag = free > 0 ? inverseDiagonal(info, free) : new Float64Array(0);
  const ratings = new Map<string, Rating>();
  ids.forEach((id, k) => {
    ratings.set(id, {
      elo: opts.anchorElo + theta[k] * ELO_PER_NAT,
      err: k === 0 ? 0 : Math.sqrt(Math.max(0, covDiag[k - 1])) * ELO_PER_NAT,
      games: games.get(id) ?? 0,
    });
  });
  return ratings;
}

function solve(matrix: Float64Array, rhs: Float64Array, n: number): Float64Array {
  return solveCholesky(cholesky(matrix, n), rhs, n);
}

function solveCholesky(l: Float64Array, rhs: Float64Array, n: number): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = rhs[i];
    for (let k = 0; k < i; k++) s -= l[i * n + k] * y[k];
    y[i] = s / l[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= l[k * n + i] * x[k];
    x[i] = s / l[i * n + i];
  }
  return x;
}

function cholesky(a: Float64Array, n: number): Float64Array {
  const l = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i * n + j];
      for (let k = 0; k < j; k++) s -= l[i * n + k] * l[j * n + k];
      if (i === j) l[i * n + i] = Math.sqrt(Math.max(s, 1e-12));
      else l[i * n + j] = s / l[j * n + j];
    }
  }
  return l;
}

function inverseDiagonal(a: Float64Array, n: number): Float64Array {
  const l = cholesky(a, n);
  const diag = new Float64Array(n);
  const e = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    e.fill(0);
    e[k] = 1;
    diag[k] = solveCholesky(l, e, n)[k];
  }
  return diag;
}

export function expectedScore(eloA: number, eloB: number): number {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}
