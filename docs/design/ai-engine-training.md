# Rules engine, AI search, value network, TD-Leaf self-play training, evaluation and replay data export

## Decisions
- 32-bit bitboards (bit i = square i+1, Black on 1-12 moving to higher squares, moving first) with exact branch-free direction shifts; mask constants derived and checked against the 7 legal first moves
- Copy-make positions (3 uint32 + turn) plus a typed-array MoveList per ply; the object Move API is a thin wrapper for UI and network code
- Duplicate capture paths are not deduplicated, matching the published perft convention; perft 1-11 from Bik/Cash used as tests
- Draw rules: threefold repetition, 80 plies with no man move or capture, training-only 300-ply cap; side to move with no moves loses
- Two 32-bit Zobrist halves (index + verification) because JS lacks fast 64-bit integers
- Search is PVS + iterative deepening + TT + killers/history with capture quiescence that has no stand-pat (captures are mandatory); no null-move pruning because of zugzwang
- TT cutoffs disabled at PV nodes so the PV leaf is exact for TD-Leaf
- Value net 132 -> 64 -> 32 -> 1 (ReLU, ReLU, tanh) on side-to-move-relative inputs; the 180-degree flip is a 32-bit bit-reversal; no mirror augmentation because the board is not mirror-symmetric
- TD-Leaf(lambda) over plain TD(0): it learns on the quiet leaves search actually evaluates (KnightCap, Schaeffer et al.)
- Offline lambda-returns per game with trace cuts at exploratory moves, turned into MSE regression with frozen per-generation weights; generation-synchronous worker pool with main-thread Adam, which is deterministic and easy to resume
- Self-play depth 4 for gens 1-150, then 6; 2000 games/generation; 11 workers
- Elo by Bradley-Terry maximum likelihood over all gauntlet results, anchored at Heuristic-d4 = 1000; champion = best Elo of the last 20 gens
- Ship weights as a raw float32 .bin with a small header (42.5 KB) rather than JSON; ship up to 28 log-spaced checkpoints plus per-generation replay JSON under a 3 MB budget
- Browser search runs in a module Web Worker with time-based levels; cancellation via terminate() because GitHub Pages cannot enable SharedArrayBuffer (no COOP/COEP)
- Node 24 native TypeScript stripping (.ts import extensions, erasableSyntaxOnly) so the trainer shares engine code with no build step; tsx as fallback

## Risks
- Network eval in JS may be slower than the ~3 us estimate, cutting games/hour; mitigate with an NNUE-style incremental first-layer accumulator, hidden 32, or depth 3. Run bench before choosing games-per-gen
- TD self-play can stagnate in draw-heavy king-shuffling or overfit to its own style; mitigate with random 3-ply openings, epsilon exploration, the replay buffer, gauntlet monitoring and keeping the best-Elo champion rather than the latest
- Without endgame tablebases, technical wins (e.g. 2 kings vs 1) may hit the 80-ply no-progress draw, so the net may undervalue them
- Perft beyond depth 11 depends on the duplicate-capture convention; only test up to 11
- Bitwise sign bugs in JS (always >>> 0, use Math.clz32); a dedicated incremental-hash vs full-hash test catches make-move bugs
- Node type-stripping limits (no enums or parameter properties, explicit .ts imports, worker_threads loading .ts) must be respected in shared src code or Vite/Node behaviour diverges
- Mobile CPUs are 3-5x slower; time-based levels keep latency bounded but Max will be weaker on phones
- Repo bloat if the exporter's size budget is not enforced; run directories must be gitignored
- WSL /mnt/c file I/O is slow; the run directory should optionally live on the Linux filesystem (--out ~/checkers-runs)
- Training-time strength estimates (hours to good play) are extrapolations from the literature, not measurements

## Interfaces

// src/engine (shared by UI, P2P, worker, trainer)
type Side = 0 | 1;  // 0 = Black: moves first, starts on squares 1-12 (bits 0-11), promotes on 29-32
interface Position { black: number; white: number; kings: number; turn: Side }  // uint32 bitboards, bit i = square i+1
interface Move { from: number; to: number; path: number[]; captured: number; promotes: boolean } // 0-based squares
initialPosition(): Position; legalMoves(p): Move[]; applyMove(p, m): Position; hasCapture(p, side): boolean
squareToRowCol(sq0to31): { row: number; col: number }  // row = sq>>2; col = row even ? 2*(sq&3)+1 : 2*(sq&3); row 0 = Black's back rank
moveToString(m): string  // "11-15", "15x24x31" (1-based)
parseMove(p, s): Move | null; movesWithPrefix(moves, path0based): Move[]
toFen(p): string; fromFen(s): Position  // PDN FEN "B:W21,...,K32:B1,...,12"
type EndReason = 'no-moves'|'repetition'|'no-progress'|'max-plies'|'resign'|'disconnect'|'timeout'
interface GameStatus { over: boolean; winner: Side | null; reason?: EndReason }
class Game { constructor(startFen?: string, opts?: { maxPlies?: number }); moves: Move[]; position(): Position; legalMoves(): Move[]; play(m: Move | string): Move; undo(): void; status(): GameStatus }

// src/ai
interface LevelSpec { maxDepth: number; timeMs: number; temperature: number; blunderRate: number; threatExtension: boolean; lmr: boolean }
LEVELS: Record<'easy'|'medium'|'hard'|'max', LevelSpec>
class AiClient { loadNet(netId: string, url: string): Promise<void>; think(game: Game, netId: string | 'heuristic', level: LevelSpec): Promise<{ move: string; score: number; depth: number; nodes: number; pv: string[]; ms: number }>; cancel(): void }
Worker protocol: AiRequest = {type:'loadNet',netId,url} | {type:'think',reqId,netId,startFen,moves:string[],level,seed?}; AiResponse = {type:'netLoaded',netId,gen} | {type:'move',reqId,move,score,depth,nodes,pv,ms} | {type:'error',reqId?,message}
Score units: int, side-to-move perspective, eval in ±1000, mate = 30000 - ply

// Static data under public/ (URLs via import.meta.env.BASE_URL, i.e. /checkers/)
training/manifest.json: { format:1, rules, run, updated, net:{layers}, totalGames, hours, champion:number, anchors, generations:[{gen,games,hours,depth,elo,eloErr,vsRandom,vsHeur4,vsPrev,avgPlies,decisive,loss,replay:string,net:string|null}] }
training/gens/gen-NNNN.json: { gen, games:[{ id, kind:'selfplay'|'gauntlet', black:number|string, white:number|string, result:'1-0'|'0-1'|'1/2-1/2', reason:EndReason, random:number[], explore:number[], moves:string /* space-separated notation */, evals:number[] /* per-ply, Black perspective, ±100 */ }] }
training/nets/gen-NNNN.bin: 'CKN1', u32 version, u32 gen, u32 nLayers, u32[] sizes, f32 params (W1 transposed [in][out], b1, W2[out][in], b2, W3, b3), little-endian
Default play net = manifest.champion's net file.

## Design

# Engine, AI and training design (English draughts)

The project directory is empty, so everything below is greenfield. Code lives in three places:

- `src/engine/`: pure TypeScript with no DOM or Node APIs. The browser and the trainer share it.
- `src/ai/`: forward-only network, evaluators, search and the browser Web Worker. Also shared.
- `trainer/`: Node only. Covers backprop, Adam, `worker_threads` self-play, gauntlet, Elo and export.

**TypeScript setup.** All imports use explicit `.ts` extensions so that both Vite and Node 24 native type stripping can run the code without a build step. Set `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax` and `noEmit` in tsconfig. That rules out `enum`, `namespace` and constructor parameter properties; use `as const` unions instead. If `.ts` workers misbehave under stripping, run the trainer with `tsx`.

---
## 1. Rules engine

### 1.1 Board and bit layout
- Square numbering is the standard 1..32. Internally, bit `i` is square `i+1`.
- Row `r = i>>2` and slot `p = i&3`.
  - Even rows (squares 1-4, 9-12, 17-20, 25-28): column `= 2p+1`.
  - Odd rows: column `= 2p`.
  - Viewed from White's side, row 0 is at the top. Square 29 is the bottom-left (single corner) and squares 28/32 are White's double corner.
- **Black (side 0)** moves first. It starts on 1-12 (`0x00000FFF`) and moves toward larger numbers. It promotes on row 7 (`0xF0000000`).
- **White (side 1)** starts on 21-32 (`0xFFF00000`) and promotes on row 0 (`0x0000000F`).
- The UI may render Black as red. Square to (row, col) for 3D placement uses the formula above.

```ts
export type Side = 0 | 1;                     // 0 = Black (first mover), 1 = White
export interface Position { black: number; white: number; kings: number; turn: Side }   // uint32 via >>> 0
```

Neighbour shifts are exact and branch-free. Every result is `>>> 0`.
```ts
const DR = (b) => (((b & 0x07070707) << 5) | ((b & 0x00F0F0F0) << 4)) >>> 0;
const DL = (b) => (((b & 0x0F0F0F0F) << 4) | ((b & 0x00E0E0E0) << 3)) >>> 0;
const UR = (b) => (((b & 0x07070700) >>> 3) | ((b & 0xF0F0F0F0) >>> 4)) >>> 0;
const UL = (b) => (((b & 0x0F0F0F00) >>> 4) | ((b & 0xE0E0E0E0) >>> 5)) >>> 0;
```
- Black men use DL/DR. White men use UL/UR. Kings use all four.
- Capture test per direction: `D(D(movers) & opp) & empty`. This drives `hasCapture(pos, side)`, which in turn feeds mandatory capture, quiescence and a network feature.
- Quiet movers: `empty`-reverse shifts, e.g. `UL(empty) & ...`, or plain table iteration.
- Bit helpers:
  - lsb index: `31 - Math.clz32(b & -b)`
  - popcount: SWAR
  - Iterate with `b &= b - 1`.
- For multi-jump recursion and notation paths, precompute `NEXT: Int8Array(4*32)` (direction × square, -1 if off-board).
- **Rotating 180° is a 32-bit bit-reversal** (square i becomes 31-i). Swapping colours with it gives the side-to-move-relative view. I verified this mapping against the layout above.

### 1.2 Move generation
- If any capture exists, only captures are legal. Otherwise all quiet moves are legal.
- Jumps are generated by DFS from each capturing piece:
  1. Remove the mover from occupancy first, so a king can land back on its origin square in a loop.
  2. Captured pieces **stay on the board until the move completes**. They block landing and cannot be jumped twice (tracked in a `captured` mask).
  3. A man that lands on the promotion row stops immediately, even if more jumps would be available (promotion ends the move).
  4. Emit a move only when no continuation exists, so sequences are always completed.
- No majority-capture rule: any capture sequence is legal.
- Duplicate capture paths (same from, to and captured set reached by different paths) are **not** deduplicated. This matches the published perft convention. Duplicates first appear at depth 12.

```ts
export interface Move { from: number; to: number; path: number[]; captured: number; promotes: boolean } // path = squares incl. from, 0-based
export function legalMoves(p: Position): Move[];
export function hasCapture(p: Position, side: Side): boolean;
export function applyMove(p: Position, m: Move): Position;          // copy-make, tiny object
```

**Fast path for search.** `MoveList` is a struct of arrays with capacity 128: `from`/`to` as `Uint8Array`, `captured` as `Uint32Array`, `flags` as `Uint8Array`, and `pathStart`/`pathLen` pointing into a shared `Uint8Array` path pool. One list is preallocated per ply. The functions are `genMoves(pos, list)` and `makeInto(dst, src, list, i)`, which also updates the hash and the no-progress counter incrementally. `legalMoves` is just a wrapper that builds objects for the UI and network code.

### 1.3 Notation
- Quiet moves use 1-based squares: `"11-15"`.
- Captures list the full path: `"15x24x31"`.
- `parseMove(pos, s)` accepts the full path or the short `"15x31"` form. It matches against the legal list and returns `Move | null`. Short-form ambiguity resolves to the first match.
- PDN FEN uses `"B:W21,22,...,32:B1,...,12"` with a `K` prefix for kings (`toFen`/`fromFen`).
- Peer-to-peer play sends notation strings, and the receiver validates them with `parseMove`.
- UI helper `movesWithPrefix(moves, prefixPath)` supports click-by-click multi-jump input.

### 1.4 Game and draw rules
`Game` holds the start FEN, the move list, a position list, a Zobrist history and a `quiet` counter (plies since the last man move or capture).

```ts
export type EndReason = 'no-moves' | 'repetition' | 'no-progress' | 'max-plies' | 'resign' | 'disconnect' | 'timeout';
export interface GameStatus { over: boolean; winner: Side | null; reason?: EndReason }
export class Game { constructor(startFen?: string, opts?: { maxPlies?: number });
  readonly moves: Move[]; position(): Position; legalMoves(): Move[]; play(m: Move | string): Move; undo(): void;
  status(): GameStatus; historyHashes(): Uint32Array /* since last irreversible move */; }
```
- **Loss:** the side to move has no legal moves, either because it has no pieces or because it is blocked.
- **Draw by repetition:** the same position with the same side to move occurs a third time. Only positions since the last irreversible move are scanned.
- **Draw by no progress:** 80 plies (40 moves each) with no man move and no capture. This is the ACF 40-move style rule, applied automatically.
- **Max plies:** 300, used in training only. The UI leaves it off.

### 1.5 Zobrist hashing
- Two independent 32-bit keys (`hi` for indexing, `lo` for verification).
- Key tables are `Int32Array(4*32)` per half for {black man, white man, black king, white king} × square, plus a side-to-move key.
- Keys come from a seeded `mulberry32(0xC0FFEE)` in `src/engine/rng.ts`, which the trainer also reuses.
- Hashes are updated incrementally inside `makeInto`. A unit test checks that the incremental hash equals the full recomputation over random games.

### 1.6 Perft verification
Source: Aart Bik's 8x8 checkers perft from the initial position, independently confirmed by Murray Cash ([talkchess](https://talkchess.com/viewtopic.php?p=482292)). These are standard counts with no duplicate-capture elimination.

| d | perft | d | perft |
|---|---|---|---|
| 1 | 7 | 7 | 179740 |
| 2 | 49 | 8 | 845931 |
| 3 | 302 | 9 | 3963680 |
| 4 | 1469 | 10 | 18391564 |
| 5 | 7361 | 11 | 85242128 |
| 6 | 36768 | 12 | 388623673 |

- Vitest checks depths 1-8 by default.
- `PERFT_DEEP=1` adds depths 9-11.
- `npm run perft -- --depth 10 --divide` prints a per-move breakdown.
- Sanity check: depth 1 must produce exactly 9-13, 9-14, 10-14, 10-15, 11-15, 11-16 and 12-16.

Hand-written FEN rule tests:
- a promotion-ends-capture case
- a king loop capture that returns to its origin
- the no-double-jump-over-same-piece rule
- mandatory capture overriding quiet moves
- no-progress and threefold draws

---
## 2. Search (`src/ai/search.ts`)

- Negamax with PVS and iterative deepening (1..maxDepth).
- Aspiration window of ±60 from depth 4 on.
- Time is checked every 2048 nodes. An aborted iteration falls back to the previous iteration's move.
- Scores are integers:
  - Evaluation is in ±1000 (net tanh × 1000, or the heuristic clamped to the same range).
  - `MATE = 30000`, and a loss scores `-(MATE - ply)`.
  - A repetition on the path or in game history, or no-progress ≥ 80, scores 0.
- **Quiescence.** Captures are mandatory in checkers, so there is **no stand-pat when captures exist**.
  - At depth ≤ 0, if the side to move has a capture, search all captures at depth 0, with a quiescence ply cap of 40.
  - Otherwise evaluate.
  - Optional `threatExtension` (on for play, off for training): at depth ≤ 0 with no capture for us but one for the opponent, search one more full ply. At most 2 such extensions per path.
- **Single-reply extension:** depth is not decremented when only one legal move exists (bounded by ply < 64).
- **Transposition table** (`ttBits` = 20 in the browser and per trainer worker):
  - Parallel arrays: `Int32Array` lock (hash lo), `Int16Array` score, `Uint8Array` depth|flag<<6, `Uint16Array` move (from | to<<5).
  - About 9 bytes per entry, so roughly 9 MB.
  - Index is `hi & mask`. Replacement is depth-preferred with an age byte.
  - **No TT cutoffs at PV nodes.** This keeps the PV leaf exact, which TD-Leaf needs.
- **Move ordering:** TT move, then captures by pieces captured (descending), then 2 killers per ply, then a history table `[side][from][to]`.
- No null-move pruning, because zugzwang is common in checkers. Optional LMR (reduce by 1 for the 5th+ quiet move, non-PV, depth ≥ 3) applies to Hard and Max only, never to training.
- **PV leaf tracking.** A `leaf[ply]` Position stack holds the position at the node where the evaluation happened. On a new best move, copy `leaf[ply+1]` into `leaf[ply]`. The result reports `leaf` and whether it is terminal.

```ts
export interface Evaluator { evaluate(p: Position): number }   // int, side-to-move perspective, ±1000
export interface SearchOptions { maxDepth: number; timeMs?: number; nodeLimit?: number; history?: Uint32Array;
  threatExtension?: boolean; lmr?: boolean; rootScores?: boolean }
export interface SearchResult { move: Move; score: number; depth: number; nodes: number; pv: Move[];
  leaf: Position | null; leafTerminal: boolean; rootScores?: { move: Move; score: number }[]; ms: number }
export class Searcher { constructor(ev: Evaluator, opts?: { ttBits?: number });
  search(p: Position, o: SearchOptions): SearchResult; clear(): void; setEvaluator(ev: Evaluator): void }
export function pickMove(r: SearchResult, level: LevelSpec, rng: () => number): Move;  // softmax/blunder for low levels
```

### Difficulty levels (`src/ai/levels.ts`)
Levels are time-based, so slow phones simply search shallower. Each level is a `LevelSpec` of `{maxDepth, timeMs, temperature, blunderRate, threatExtension, lmr}`.

| Level | Depth / time | Randomness | Other |
|---|---|---|---|
| Easy | depth 2, 150 ms | rootScores on, softmax T = 0.20 (score/1000 units), blunderRate 0.10 (uniform random legal move) | |
| Medium | depth 5, 400 ms | rootScores on, T = 0.04 | |
| Hard | depth 14, 1200 ms | T = 0 | threatExtension |
| Max | depth 40, 3000 ms | T = 0 | threatExtension, lmr |

- Desktop browsers should manage about 200-500k nodes/s, so Max reaches roughly depth 12-16.
- Opponent choice is orthogonal to level: the default is the "champion" net, but any shipped generation or "Classic" (the heuristic) can be selected.

---
## 3. Value network (`src/ai/network.ts`, `src/ai/features.ts`)

**Perspective.** Everything is evaluated from the side to move. If White is to move, reverse the bits of all boards (180° rotation) and swap colours. Checkers has **no left-right mirror symmetry** (single and double corners differ), so mirror augmentation is not used.

**Inputs (132).** The 128 sparse binary inputs are:
- own men: index i
- own kings: 32 + i
- opponent men: 64 + i
- opponent kings: 96 + i

The 4 dense extras are:
- [128] (ownMen − oppMen)/12
- [129] (ownKings − oppKings)/12
- [130] total pieces/24, a game-phase signal
- [131] whether the opponent would have a capture if it were to move (a horizon-threat signal; leaves are quiet for the side to move)

`encode(p, activeOut: Int32Array, extrasOut: Float32Array): number` returns the count of active inputs (at most 24).

**Architecture.** 132 → 64 (ReLU) → 32 (ReLU) → 1 (tanh).
- That is 132·64 + 64 + 64·32 + 32 + 32 + 1 = **10,625 parameters**, or 42.5 KB as float32.
- The first layer is stored transposed (`W1T[in*64 + j]`) so each active input adds one contiguous 64-float row.
- One forward pass is about 24·64 + 4·64 + 2048 + 32 ≈ 3.9k multiply-adds, roughly 2-4 µs in V8.
- The layer sizes come from the header, so a larger net can be configured with `--hidden 96,32`.

**Initialisation.** He-uniform for the ReLU layers, U(−0.01, 0.01) for the output layer so V ≈ 0 at gen 0, and biases at 0.

**Binary format `.bin` (little-endian).**
- Header: magic `CKN1` (4 bytes), u32 version = 1, u32 gen, u32 nLayers = 4, then u32 sizes [132, 64, 32, 1].
- Followed by f32: W1T, b1, W2[out][in], b2, W3, b3.
- The browser loads it with `fetch` into an `ArrayBuffer` and creates `Float32Array` views. No JSON, because JSON is roughly 3× larger.

```ts
export class Network { readonly sizes: number[]; readonly params: Float32Array; gen: number;
  static fromBinary(buf: ArrayBuffer): Network; toBinary(): ArrayBuffer; static random(sizes: number[], rng): Network;
  value(p: Position): number /* float (-1,1), stm */ }
export class NetEvaluator implements Evaluator { constructor(net: Network) }        // round(value*1000)
export class HeuristicEvaluator implements Evaluator {}  // "Classic"/baseline
```

**Heuristic baseline** (scaled to ±1000, clamped):
- man 100, king 140
- +8 per man on its own back-rank guard squares (Black 1, 3; White 30, 32)
- +5 per man on 14, 15, 18, 19
- +1 per row advanced for men once total pieces ≤ 12
- result computed as (own − opp)

---
## 4. Training: TD-Leaf(λ), generation-batched (`trainer/`)

### 4.1 Why TD-Leaf rather than plain TD(0)
- Captures are forced in checkers, so many root positions are mid-exchange. Plain TD on root positions learns from tactically unresolved states that search never evaluates.
- TD-Leaf instead trains the net on the **quiet PV leaf** that the search actually evaluated. This is the method of Baxter, Tridgell and Weaver (KnightCap: [arXiv cs/9901002](https://arxiv.org/pdf/cs/9901002)). KnightCap went from about 1650 to about 2100 within roughly 300 games.
- Schaeffer, Hlynka and Jussila, "Temporal Difference Learning Applied to a High-Performance Game-Playing Program" ([IJCAI 2001](https://mlanthology.org/ijcai/2001/schaeffer2001ijcai-temporal)), applied TD learning to the checkers program Chinook. The abstract reports that the learned weights were competitive with Chinook's hand-tuned ones. I did not access the full paper, so I could not confirm which TD variant it used.
- Background, from memory and not checked in this session:
  - Blondie24 (Chellapilla and Fogel) evolved a 32-40-10-1 network to expert-level checkers with no TD.
  - TD-Gammon needed hundreds of thousands of games.
  - Chinook weakly solved checkers in 2007; the starting position is a draw with perfect play, so draw-heavy self-play is expected. The weakly-solved/draw result is also stated in [Wikipedia: English draughts](https://en.wikipedia.org/wiki/English_draughts).
- Possible future upgrade, also from memory: TreeStrap (Veness et al., NIPS 2009), which learns from all interior nodes.

### 4.2 Self-play game (`trainer/selfplay.ts`)
1. **Opening:** plies 0-2 are uniformly random legal moves. That gives a 3-move-ballot-like spread of about 300 starts. Each ply 3-5 is also random with probability 0.3. These plies produce no samples.
2. **Every later ply t:** `Searcher.search(pos, {maxDepth: D, threatExtension: false, lmr: false})`. Defaults are `D = 4` for gens 1-150 and `D = 6` after (`--depth-schedule 1:4,151:6`). The TT is cleared each game. Record:
   - `J_t`: the float net value of the PV leaf, converted to **Black's perspective** (negate if the leaf has White to move). If the leaf is terminal, use the exact result (±1 or 0) and emit no sample.
   - `leaf_t`
   - `explored_t`
3. **Exploration:** with probability ε = 0.03 (only if there are ≥ 2 legal moves), play a uniformly random non-best move and set `explored_t = true`.
4. **Game end:** the rules in §1.4, with maxPlies 300. The result is `z ∈ {+1, 0, −1}` from Black's perspective.

### 4.3 Targets: offline λ-return, equivalent to forward-view TD(λ)
```
G_next = z
for t = N-1 down to t0:
   G_t   = explored_t ? J_t : G_next          // trace cut at exploratory moves (Watkins-style)
   G_next = (1-λ)·J_t + λ·G_t                  // value seen by ply t-1
sample_t = { leaf_t, target = (leaf_t.turn===0 ? G_t : -G_t) }   // back to leaf's stm perspective
```
- This is exactly the offline TD(λ) update Σ(G_t^λ − J_t)∇J_t with a single terminal reward, turned into regression: minimise ½(net(leaf) − target)².
- Targets are computed with the frozen weights of the generation that played the game, which acts like a target network.
- λ is 0.9 for gens 1-10 (faster signal propagation from random play), then 0.7 (the KnightCap value). Override with `--lambda`.

### 4.4 Orchestration (`trainer/train.ts`, `trainer/pool.ts`, `trainer/selfplay-worker.ts`)
**Generation-synchronous loop.** Workers play with frozen weights and the main thread applies all updates. This makes runs deterministic per seed, needs no locking, and makes checkpointing trivial.
```
for gen = state.gen+1 .. --gens:
  pool.broadcast({type:'weights', params})           // Float32Array copy, 42.5KB
  tasks = split(--games-per-gen 2000, 25 games/task); seeds = hash(seed, gen, taskId)
  results = pool.run(tasks)                          // samples packed: Uint32Array 4/sample (black,white,kings,turn) + Float32Array targets
  buffer.push(gen, samples); keep last --replay-gens 2
  train(net, adam, buffer): --epochs 2, --batch 256, Adam β=(0.9,0.999), L2 1e-5, grad-norm clip 1.0
  lr(gen) = 1e-3 (≤100), 5e-4 (≤200), 2.5e-4 after          // --lr overrides base
  save checkpoint; gauntlet every --gauntlet-every 1; recompute Elo; write replay + stats
```
- **Workers:** `--workers 11` (one core left for the main thread and OS), each with its own Searcher (TT at 2^20, about 9 MB) and Network.
- **Messages:**
  - `{type:'weights', params, gen}`
  - `{type:'selfplay', taskId, games, seed, depth, lambda, epsilon}` returns `{samples, targets, games: GameRecord[], stats}`
  - `{type:'match', taskId, a: PlayerSpec, b: PlayerSpec, openings, depth}` returns results and game records
- **Training cost:** about 160k new samples per generation (2000 games × ~80 recorded plies), with the replay buffer giving about 320k samples × 2 epochs. Each sample is about 12k multiply-adds forward plus backward, so 5-15 s per generation on the main thread. Backprop and Adam (`trainer/nn-train.ts`) stay out of the browser bundle.
- **Checkpoints and resume.** Layout is `training-runs/<run>/` (gitignored):
  - `state.json`: gen, rng state, lr, totalGames, elapsedSec, config
  - `nets/gen-NNNN.bin` (every gen, about 42 KB, so about 13 MB per 300 gens)
  - `adam.bin` (m, v)
  - `games/gen-NNNN.json` (sampled records)
  - `stats.jsonl`, `results.jsonl` (gauntlet pairings)
  - `state.json` is written last, via temp file + rename.
  - `--resume` reloads the latest net, Adam state and rng. At most one in-progress generation is lost (1-3 min).
  - SIGINT sets a flag so the run finishes the current generation and then exits cleanly.
  - The run directory may be placed under `~/` with `--out` to avoid slow /mnt/c I/O. Its write volume is small anyway.
- **CLI:** `node trainer/train.ts --run main [--resume] --gens 300 --games-per-gen 2000 --workers 11 --depth-schedule 1:4,151:6 --lambda 0.7 --epsilon 0.03 --lr 1e-3 --batch 256 --epochs 2 --replay-gens 2 --hidden 64,32 --gauntlet-every 1 --gauntlet-openings 50 --seed 1 --out training-runs`

### 4.5 Throughput and expected hours
These are estimates; measure them with `npm run bench`, which reports perft nodes/s, eval/s and search nodes/s, before fixing `--games-per-gen`.
- **Search speed:** about 5 µs per searched node (movegen + make + net eval), so about 200k nodes/s per core.
- **Self-play cost:** depth 4 plus capture search is about 400-800 nodes per move, i.e. 2-4 ms. A game of about 90 plies takes about 0.3 s per core.
- **Per generation:** 11 workers give about 35 games/s, so about 60 s for 2000 games, plus training and gauntlet: **about 1.5-2 min per generation**. Depth 6 costs about 4-5× more per game.
- **Expected milestones:**
  - Gen 1-5 (~10 min): beats Random almost 100%.
  - Gen 20-40 (~1 h, ~60k games): beats Heuristic-d4 consistently at equal depth.
  - Gen 150 (~5 h): clearly stronger than Heuristic-d6.
  - **Overnight, 10-14 h (gen 150 at depth 4 plus about 50 at depth 6, roughly 400k games):** strong play. Improvements flatten into draws, which is expected for checkers.

---
## 5. Evaluation (`trainer/gauntlet.ts`, `trainer/elo.ts`)
**Players:** `PlayerSpec = {kind:'random'} | {kind:'heuristic', depth} | {kind:'net', gen, depth}`.

**Gauntlet each generation** (all at depth 4 with no exploration unless noted):
- Openings: 50 drawn from the fixed list of all 302 three-ply openings (seeded per gen). Each opening is played twice with colours swapped, so 100 games per opponent.
- Opponents:
  - Random: 20 games; dropped after 3 consecutive generations at 100%.
  - Heuristic-d2
  - Heuristic-d4
  - Heuristic-d6 (from gen 20)
  - Net(g−1)
  - Net(g−10)
- Cost is about 400 games, roughly 10-20 s on 11 workers.

**Elo:**
- Bradley-Terry maximum likelihood over the cumulative `results.jsonl`, with a draw counted as half a win and half a loss.
- Fit by Newton or gradient iteration to convergence, anchored at **Heuristic-d4 = 1000**.
- ±error comes from the inverse Fisher information.
- Recomputed fully each generation; this is cheap.

**Per-generation stats line:** `{gen, games, avgPlies, decisive, blackScore, samples, loss, lr, depth, lambda, secPlay, secTrain, vsRandom, vsHeur2, vsHeur4, vsHeur6, vsPrev, vsPrev10, elo, eloErr, totalGames, hours}`.

**Champion:** the generation with the highest Elo among the last 20 (requiring ≥ 100 rated games). It is what the browser uses as the default net.

---
## 6. Replay data for the website (`trainer/export.ts`, `npm run export -- --run main`)
The exporter copies a bounded subset of the run into `public/training/`, which is committed. The total budget is **≤ 3 MB**.

**`public/training/manifest.json`** (≤ 60 KB):
```json
{ "format": 1, "rules": "english-draughts", "run": "main", "updated": "2026-10-20T07:00:00Z",
  "net": { "layers": [132, 64, 32, 1] }, "totalGames": 412000, "hours": 12.4, "champion": 197,
  "anchors": { "heur4": 1000 },
  "generations": [ { "gen": 1, "games": 2000, "hours": 0.03, "depth": 4, "elo": 612, "eloErr": 35,
      "vsRandom": 0.99, "vsHeur4": 0.08, "vsPrev": 0.71, "avgPlies": 88, "decisive": 0.81, "loss": 0.19,
      "replay": "gens/gen-0001.json", "net": "nets/gen-0001.bin" } ] }
```
`net` is `null` when that generation's weights are not shipped.

**`public/training/gens/gen-NNNN.json`** (about 4-6 KB each, 300 gens ≈ 1.5 MB). Each file holds 4 sampled self-play games, all from worker 0's first task so they are deterministic, plus 2 gauntlet games (vs Net(g−1) and vs Heuristic-d4).
```json
{ "gen": 42, "games": [ { "id": "sp-42-0", "kind": "selfplay", "black": 42, "white": 42, "result": "1-0",
   "reason": "no-moves", "random": [0,1,2], "explore": [37], "moves": "11-15 23-19 8-11 ... 15x24x31",
   "evals": [0, 3, -2, 15] } ] }
```
- `result` is one of `"1-0"`, `"0-1"`, `"1/2-1/2"`. Black is the first player.
- `moves` is space-separated standard notation, and the viewer replays it with `Game.play`.
- `evals` holds root search scores from Black's perspective in ±100 units, one integer per ply, for an eval bar or graph.
- `random` and `explore` give ply indices of non-search moves so the viewer can mark them.
- Gauntlet games set `black`/`white` to `"heur4"` or a gen number.

**`public/training/nets/gen-NNNN.bin`:** about 42.5 KB each. Ship gens {0, 1, 2, 3, 5, 8, 12, 20, 30, 50, 75, 100, 125, 150, 200, 250, 300, ...every 50} plus the champion plus the latest, capped at 28 files (≈ 1.2 MB). This lets the viewer pit **any two shipped generations live** in the browser.

All URLs are built from `import.meta.env.BASE_URL` (`/checkers/`).

---
## 7. Browser AI (`src/ai/ai.worker.ts`, `src/ai/client.ts`)
- Created with `new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' })`, which Vite bundles.
- The worker keeps a `Map<netId, Network>` and one Searcher (ttBits 20; 18 if `navigator.deviceMemory` ≤ 2).
- **Messages:**
```ts
type AiRequest =
  | { type: 'loadNet'; netId: string; url: string }
  | { type: 'think'; reqId: number; netId: string | 'heuristic'; startFen: string; moves: string[]; level: LevelSpec; seed?: number };
type AiResponse =
  | { type: 'netLoaded'; netId: string; gen: number }
  | { type: 'move'; reqId: number; move: string; score: number; depth: number; nodes: number; pv: string[]; ms: number }
  | { type: 'error'; reqId?: number; message: string };
```
- The worker rebuilds the `Game` from `startFen` plus `moves`, which gives repetition history for free.
- **Cancellation:** GitHub Pages cannot send COOP/COEP headers, so SharedArrayBuffer stop flags are unavailable. The client calls `worker.terminate()` and respawns, and responses carry a `reqId` so stale ones are ignored.
- **Generation-vs-generation viewer:** load two nets, then alternate `think` calls with different `netId`s on the same worker (`clear()` the TT on each switch).
- `client.ts` exposes `class AiClient { loadNet(id, url): Promise<void>; think(game: Game, netId, level): Promise<{move: string, score: number, ...}>; cancel(): void }`.
- A minimum display delay (about 350 ms) for UI pacing is the UI's concern.

---
## 8. Module layout
```
src/engine/bitboard.ts    masks, DL/DR/UL/UR, popcount, lsb, reverseBits, squareToRowCol(sq)->{row,col}
src/engine/rng.ts         mulberry32(seed), splitmix seed mixer
src/engine/position.ts    Position, Side, initialPosition(), toFen/fromFen, flip(p), equals
src/engine/zobrist.ts     KEYS_HI/LO, hashOf(p): [hi, lo], incremental helpers
src/engine/movegen.ts     MoveList (SoA), genMoves(p, list), makeInto(dst, src, list, i), hasCapture(p, side), legalMoves(p), applyMove(p, m)
src/engine/notation.ts    moveToString(m), parseMove(p, s), movesWithPrefix(moves, path)
src/engine/game.ts        Game, GameStatus, EndReason, draw rules (rep 3x, quiet 80 plies, maxPlies)
src/engine/perft.ts       perft(p, depth), divide(p, depth)
src/engine/openings.ts    allOpenings(plies=3): string[][] (302 lines), deterministic order
src/ai/features.ts        encode(p, active, extras) -> count; INPUTS = 132
src/ai/network.ts         Network (forward only, binary IO), NetEvaluator
src/ai/heuristic.ts       HeuristicEvaluator
src/ai/search.ts          Searcher, SearchOptions, SearchResult, pickMove
src/ai/levels.ts          LevelSpec, LEVELS {easy, medium, hard, max}
src/ai/ai.worker.ts       browser worker; src/ai/client.ts AiClient
trainer/train.ts          CLI entry, generation loop, lr/λ/depth schedules, SIGINT
trainer/pool.ts           WorkerPool(n, url): broadcast(msg), run<T>(tasks): Promise<T[]>
trainer/selfplay-worker.ts worker_threads entry: weights | selfplay | match
trainer/selfplay.ts       playSelfPlayGame(searcher, net, opts, rng): {record, samples}; lambdaTargets(J, explored, z, λ)
trainer/nn-train.ts       forwardBackward(net, sample, grad), Adam {m, v, step}, trainEpochs(net, adam, buf, opts) -> loss
trainer/gauntlet.ts       PlayerSpec, playMatch(a, b, openings, depth, rng), runGauntlet(gen)
trainer/elo.ts            fitElo(results, anchor='heur4', anchorElo=1000) -> Map<player,{elo,err}>
trainer/checkpoint.ts     saveGen/loadLatest/writeStateAtomic, run dir layout
trainer/export.ts         run -> public/training (manifest, gens, nets selection, size budget check)
trainer/bench.ts          perft nps, eval/s, search nps, games/s at depth 4/6
tests/engine/*.test.ts    perft (1-8, deep 9-11 via PERFT_DEEP), rules FEN cases, notation and FEN round trips, zobrist incremental==full, draw rules
tests/ai/*.test.ts        features flip symmetry (eval(p) for Black == eval of flipped mirror pos for White), net binary round trip, search finds 2-for-1 shots / forced wins, TT on/off same score at fixed depth
tests/trainer/*.test.ts   lambdaTargets hand-computed cases (incl. explore cut, terminal leaf), finite-difference gradient check, Elo fit on synthetic data
```
`package.json` scripts: `train`, `bench`, `perft`, `export` (each `node trainer/<x>.ts`), `test` (vitest).
