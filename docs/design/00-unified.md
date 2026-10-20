# Unified checkers design (integration review)

The four area designs are mostly compatible. The main work is renaming and aligning interfaces, choosing one artifact format and one P2P library, and cutting test and robustness scaffolding.

I checked these facts on 2026-10-19:
- **npm:** three 0.186.1, @types/three 0.186.0, vite 8.3.4, vitest 5.0.5, typescript 7.0.2, @playwright/test 1.64.1, peerjs 1.5.5 (registry last modified 2025-06-07), peer 1.0.2, trystero 0.26.0 (registry last modified 2026-10-04).
- **GitHub Actions latest tags:** checkout v7.0.1, setup-node v7.1.0, upload-pages-artifact v5.0.0, deploy-pages v5.0.1, upload-artifact **v7.0.2**. The repo design's `upload-artifact@v4` is out of date; use v7.
- **Perft 1-11** (7 … 18391564, 85242128) matches [talkchess](https://talkchess.com/viewtopic.php?p=482292) and [OEIS A133046](https://oeis.org/A133046). OEIS confirms that duplicate king captures are counted separately, which is the engine design's convention.
- **Bitboard masks:** I derived the DL/DR/UL/UR masks by hand and they are correct. Bit-reversal as a 180° rotation is also correct.
- **Project directory** is empty.

---

## 1. Conflicts and resolutions

| # | Conflict | Resolution |
|---|---|---|
| C1 | P2P library: the user chose **PeerJS**; the P2P design switched to Trystero; the frontend and repo designs assume PeerJS. | **Default to PeerJS 1.5.5**, behind the P2P design's `Transport` interface. That respects the user's explicit choice. Handle `unavailable-id` with host-ID retry and backoff (§5). The lead should put a one-line question to the user ("Trystero/Nostr has no single broker; switch?"). A Trystero adapter is about 100 lines behind the same interface and needs no session or UI changes. |
| C2 | Side naming: `Side 0\|1` (engine), `'dark'\|'light'` (P2P), `'b'\|'w'` (repo). | **`Side = 0 \| 1` everywhere.** 0 = Black = first mover = PDN 1-12, rendered Crimson. Notation result `'1-0'` means side 0 wins. |
| C3 | `Move` shape: engine has `path` including `from` plus a `captured` bitmask; frontend has `path` = landings only plus `captures: Sq[]`; repo has `captures: number[]`. | Use the **engine shape**: `path` includes `from`, `captured` is a bitmask. Add helpers `capturedSquares(m): Sq[]` (in hop order) and `jumpedSquare(a, b)`. The frontend selection code uses `path.slice(1)`. |
| C4 | Notation names: `moveToString`/`formatMove`/`moveToPdn`; `parseMove`/`pdnToMove`. | Use `moveToString` and `parseMove`. |
| C5 | `Game` API: `position()` method vs property; `status()` vs `outcome()`; constructor takes a FEN or a Position. | One `Game` class, defined in §3. |
| C6 | `EndReason` sets differ (`no-pieces`, `draw-40`, `disconnect`, `timeout`, `abandoned`, `draw-agreed`). | `'no-moves'\|'repetition'\|'no-progress'\|'max-plies'\|'resign'\|'agreement'`. The UI derives the "no pieces" wording from the position. A disconnect never ends the game in v1. |
| C7 | Three incompatible training-artifact layouts: `public/training/*` (engine), `TrainingManifest` (frontend), `public/ai` plus `public/replays` (repo). | Keep **one layout, `public/training/`**, using the engine's structure. Add the frontend's needs to it: baseline Elo values for the chart's reference lines, W/D/L per opponent, and `moves` as `string[]` rather than a space-joined string. Drop `public/ai/manifest.json`; difficulty levels come from search settings, not from separate checkpoints. Formats are in §4. |
| C8 | Weights format: CKN1 binary with a header (engine) vs a JSON manifest plus raw f32 (repo). | **CKN1** (self-describing). The assets test checks `byteLength == header + 4·Σparams`. |
| C9 | Eval units in replays: ints ±100 from Black's view (engine) vs win probability 0..1 (frontend). | Store ints in ±100 from Black's (side 0) view. The UI computes `p = (e/100 + 1) / 2`; mate scores clamp to ±100. |
| C10 | Difficulty: 4 levels (engine), 5 named levels (frontend), weaker checkpoints as levels (repo). | **5 levels** using the frontend names, each a `LevelSpec` on the champion net. "Play vs gen N" is a separate choice. |
| C11 | Worker protocol: `loadNet`/`think{startFen, moves, level: LevelSpec}` (engine) vs `load`/`think{fen, history, level: 1-5}` plus `cancel` (frontend). | Use the **engine protocol**. `cancel` means `terminate()` + respawn, since GitHub Pages has no COOP/COEP and so no SharedArrayBuffer. Only one client module: `src/ai/client.ts`. |
| C12 | Directory names: `trainer/` vs `training/`; `src/web/**` vs `src/{scene,game,ui,lab}`; `test/` vs `tests/`; `heuristic.ts` in `engine` vs `ai`; `nn`/`search` in `engine` vs `ai`. | `trainer/`; the frontend's `src/{app,scene,game,ui,lab,audio}`; `tests/` only; `src/ai/*` holds features, network, heuristic and search. File tree in §2. |
| C13 | Routes: `#/play/:code` (P2P) vs `#/join/:peerId` (frontend and repo); `#/ai` vs `#/play/ai`; `#/replays` vs `#/lab`. | One router, `src/app/router.ts`; routes in §6. |
| C14 | Test hooks: `window.__ck` with `--mode e2e`, `window.__checkers` with `?test=1`, and `?e2e=1`. | One hook: `window.__checkers` when `?test=1` (§6). No separate e2e build. |
| C15 | Two different `GameRecord` types (P2P room record vs training replay). | The P2P type is renamed `OnlineGame`. `GameRecord` means the replay type only. |
| C16 | Frontend "Player" model (`requestMove`) vs the P2P `GameDriver` (snapshot subscription). | **Use `GameDriver` for every mode** (local, AI, online). The view controller diffs snapshots: if the move list grew by one, animate; anything else, snap via `sync`. This handles P2P resync and resume for free. Drop `Player`. |
| C17 | localStorage keys: `checkers.settings.v1` vs the `checkers:` prefix. | All keys use the `checkers:` prefix: `checkers:settings`, `checkers:resume`, `checkers:clientId`, `checkers:name`, `checkers:room:<CODE>`. |
| C18 | Generation sizing: 2000 games/gen × 300 gens (engine) vs 5000 × 40-80 (repo). Size budget 3 MB vs 5 MB. | 2000 games/gen, adjusted after `npm run bench`. **5 MB budget** for `public/training`, enforced by the assets test. |
| C19 | Max plies: 300 vs 400. | 300, training only. The UI has no cap. |
| C20 | Run directory: `training-runs/` in the repo vs `~/checkers-runs`. | `${CHECKERS_RUNS:-$HOME/checkers-runs}/<run>` on ext4. |
| C21 | Elo anchor: `random=0` vs `heur4=1000`. | `heur4 = 1000`. Baselines are listed with their fitted Elo. |
| C22 | Playwright WebKit iPhone project, but only Chromium is installable without sudo. | Use Chromium device emulation (`Pixel 7`, `iPhone 13` profile with `browserName: 'chromium'`). |

## 2. Corrections and cuts

**Corrections**
- **`actions/upload-artifact`:** use v7, not v4.
- **Vite 8 chunk options:** the frontend's `rolldownOptions.output.codeSplitting` is unverified. Don't hand-tune chunks. Dynamic `import()` for net, lab and QR gives lazy chunks on default config.
- **TypeScript 7.0.2:** it exists. It is only used for `tsc --noEmit`. If any option misbehaves, pin `~6.0`.
- **Frontend `friend.spec`:** it is already consistent with PeerJS plus a local `peer` server.

**Cuts (over-engineering)**
- **P2P:**
  - bridge transport, ws-relay real-WebRTC suite and the nightly live smoke test go. E2E runs real PeerJS against a local `peerjs --port 9000` server, with `?peer=127.0.0.1:9000`.
  - The Web Locks steal flow becomes a simple `navigator.locks` `ifAvailable` check that shows "open in another tab". No steal.
  - Emotes go.
  - The app-SHA warning goes; the proto check stays.
- **Frontend:**
  - Three quality tiers plus a governor become **two tiers** (high and low) plus a DPR cap and a one-step automatic downgrade.
  - Drag-to-move becomes a stretch goal; tap-tap always works.
  - "Traditional crowning from the tray" becomes a simple drop-on crown.
  - The live-match "Quick series ×20" goes.
- **Engine and AI:** LMR goes. Aspiration windows are deferred until after bench.
- **Gauntlet:** trimmed to about 240 games/gen:
  - Random: 20 games, dropped once saturated.
  - Heur-d2: 40.
  - Heur-d4: 100 (50 openings × 2).
  - Net(g−1): 60.
  - Net(g−10) and Heur-d6: every 5 generations.
- **Repo:** Lighthouse becomes a manual post-deploy check only.

**Mobile simplification**
- On `(pointer: coarse)`, set `controls.touches = { ONE: null, TWO: DOLLY_ROTATE }`.
- One finger never orbits, so tap-vs-orbit arbitration is only needed for the mouse. This removes the main mobile risk the frontend design identified.

## 3. Missing pieces

1. **Board correctness test.** For each orientation, the human's near-left corner must be a dark square and the single corner (side 0: square 4, side 1: square 29). The double corner (1/5 or 28/32) must be on the right. Dark squares satisfy `(row + col) % 2 == 1`. This catches a mirrored camera or canvas, which is the most likely way the board ends up "looking wrong".
2. **Watching training as it improves, before a push.**
   - Add `trainer/train.ts --publish-every 10`. It runs the exporter into `public/training/` (the budget still applies), so `npm run dev` shows live progress.
   - `npm run export` is the final curation step. Commit and push to update Pages.
3. **Gen 0 (untrained net) self-play games must be exported** as the "before" state. Without them, improvement isn't visible, because depth-4 search with capture quiescence already plays tactically.
4. **Replay selection.** Per generation, export 4 self-play games, preferring at least one decisive game if any exist, plus 2 gauntlet games (vs Net(g−1) and vs Heur-d4). Late generations are draw-heavy, and all-draw replays look like "no improvement".
5. **Empty state before training.** Ship a placeholder `public/training/manifest.json` with `generations: []` and `champion: null`. The AI falls back to the heuristic, and the Lab shows "Training hasn't run yet".
6. **Resume** for vs-AI and local games via `checkers:resume`.
7. **"Play from here vs AI"** needs a FEN start, which `Game({ startFen })` supports.
8. **Pre-overnight gate.** After a pilot run (≤ 60 min): self-play throughput ≥ 15 games/s, vs Random ≥ 95%, vs Heur-d4 rising. If it misses, cut to hidden 32 or depth 3 before the long run.
9. **Training hygiene:** tell the user to disable Windows sleep during the run. SIGINT finishes the current generation and checkpoints.
10. **TURN.** Without it, roughly 10-20% of real pairings (cellular, symmetric NAT) fail. Keep the optional `VITE_TURN_CRED_URL` (Metered apiKey, a GitHub repo variable) and feed it into PeerJS `config.iceServers`. Ask the user whether to sign up.

---

## 4. Final file tree

```
checkers/
  .github/workflows/deploy.yml   .gitattributes (* text=auto eol=lf, *.bin binary)  .gitignore  .nvmrc(24)
  package.json  tsconfig.json  vite.config.ts  playwright.config.ts  index.html  README.md
  public/training/manifest.json            # placeholder until training
  public/training/gens/gen-NNNN.json  public/training/nets/gen-NNNN.bin
  src/main.ts
  src/app/{router,settings,persist,testHook,store}.ts
  src/engine/{types,bitboard,rng,position,zobrist,movegen,notation,game,perft,openings,index}.ts   # pure
  src/shared/formats.ts                    # TrainingManifest, GenFile, GameRecord, CKN1 consts + validators
  src/ai/{features,network,heuristic,search,levels}.ts   # pure
  src/ai/{ai.worker,client}.ts
  src/net/{transport,peerjsTransport,iceServers,protocol,reconcile,session,connection,onlineDriver,roomStore,roomCode,invite}.ts
  src/scene/{stage,environment,textures,boardModel,pieceModel,pieces,highlights,tween,moveAnimator,cameraRig,picking,quality,boardView}.ts
  src/game/{driver,localDriver,aiDriver,controller,pieceTracker,selection,keyboard,announcer}.ts
  src/audio/{sfx,haptics}.ts
  src/ui/{dom,home,hud,modal,toast,miniBoard}.ts  src/ui/online/{createGameSheet,invitePanel,connectionBadge,onlineDialogs}.ts
  src/lab/{data,labView,eloChart,wdlBars,replayTimeline,replayView,liveMatch}.ts
  src/styles/{tokens,base,layout,home,hud,lab,online}.css
  trainer/{train,pool,selfplay-worker,selfplay,nn-train,gauntlet,elo,checkpoint,export,bench,perft-cli}.ts
  tests/engine/*.test.ts  tests/ai/*.test.ts  tests/trainer/*.test.ts  tests/net/*.test.ts  tests/frontend/*.test.ts
  tests/assets.test.ts  tests/purity.test.ts  tests/support/loopbackTransport.ts  tests/fixtures/training/**
  tests/e2e/{smoke,layout,play-local,play-ai,lab,online}.spec.ts
```

**Toolchain**
- **tsconfig:** use the repo design's single tsconfig, with `include: ["src", "trainer", "tests", "*.ts"]`.
- **All relative imports use `.ts` extensions.** Erasable syntax only: no `enum`, no parameter properties, no namespaces.
- **Trainer** runs with `node trainer/x.ts` (Node 24 type stripping).
- **`tests/purity.test.ts`** forbids `node:`, `three`, `peerjs`, `document` and `window` in `src/engine/**` and in `src/ai/{features,network,heuristic,search,levels}.ts`.

**package.json**
- **dependencies:** `three@^0.186.1`, `peerjs@1.5.5` (exact).
- **devDependencies:** `vite@^8.3.4`, `vitest@^5.0.5`, `typescript@^7.0.2`, `@types/three@^0.186.0`, `@types/node@^24`, `@playwright/test@^1.64.1`, `peer@^1.0.2`.
- **Optional devDependencies:** `uqr`, and Fontsource Fraunces, Geist and Geist Mono (versions to check at install time).
- **scripts:** `dev`, `build` (`tsc --noEmit && vite build`), `preview`, `typecheck`, `test`, `perft`, `bench`, `train`, `train:resume`, `train:smoke`, `export`, `e2e`, `peer`.

## 5. Shared engine API (`src/engine/types.ts` plus modules)

```ts
export type Side = 0 | 1;                 // 0 = Black/Crimson, first mover, PDN 1-12, promotes on 29-32
export type Sq = number;                  // 0..31, PDN = sq + 1, bit sq in bitboards
export interface Position { readonly black: number; readonly white: number; readonly kings: number; readonly turn: Side }
export interface Move { readonly from: Sq; readonly to: Sq; readonly path: readonly Sq[]; readonly captured: number; readonly promotes: boolean } // path includes from
export type EndReason = 'no-moves' | 'repetition' | 'no-progress' | 'max-plies' | 'resign' | 'agreement';
export type GameStatus = { over: false } | { over: true; winner: Side | null; reason: EndReason };
export type ResultStr = '1-0' | '0-1' | '1/2-1/2';
export const NO_PROGRESS_PLIES = 80, TRAIN_MAX_PLIES = 300;

// bitboard.ts / position.ts
initialPosition(): Position; sqToRowCol(sq): { row: number; col: number };  // row = sq>>2, col = row even ? 2*(sq&3)+1 : 2*(sq&3)
rowColToSq(row, col): Sq | null; pieceAt(p, sq): { side: Side; king: boolean } | null; flip(p): Position;
toFen(p): string; fromFen(s): Position;                                   // PDN FEN, "B:W21,...,K32:B1,...,12"
// movegen.ts
legalMoves(p): Move[]; applyMove(p, m): Position; hasCapture(p, side): boolean;
capturedSquares(m): Sq[]; jumpedSquare(a: Sq, b: Sq): Sq;
genMoves(p, list: MoveList): number; makeInto(dst, src, list, i): void;  // search fast path
// notation.ts
moveToString(m): string;  // "11-15", "15x24x31"
parseMove(p, s): Move | null; movesWithPrefix(moves, prefix: readonly Sq[]): Move[];  // prefix starts with from
// zobrist.ts: hashOf(p): [hi: number, lo: number]
// game.ts
export class Game {
  constructor(opts?: { startFen?: string; maxPlies?: number });
  static fromMoves(moves: readonly string[], opts?: { startFen?: string }): Game;  // throws with index on illegal
  readonly startFen: string; readonly moves: readonly Move[];
  get position(): Position; get quietPlies(): number;
  notation(): string[]; legalMoves(): Move[];
  play(m: Move | string): Move; undo(): Move | undefined;
  status(): GameStatus; historyHashes(): Uint32Array;
}
// perft.ts perft(p, d), divide(p, d); openings.ts allOpenings(3): string[][] (302)
```

The P2P design's needs map onto this API:

| P2P needs | Provided by |
|---|---|
| `positionKey` | `toFen` |
| `replay` | `Game.fromMoves` |
| `sideToMove` | `position.turn` |

**AI API (`src/ai`)**
- `Evaluator`, `Searcher`, `SearchOptions`, `SearchResult` and `pickMove` are as in the engine design, minus `lmr`.
- `Network.fromBinary` / `toBinary` / `value`, `NetEvaluator`, `HeuristicEvaluator`.
- `type LevelId = 1|2|3|4|5`, and `LEVELS: Record<LevelId, LevelSpec & { name: string }>`:

| Level | Name | Depth | Time | Temperature | Blunder rate | Threat extension |
|---|---|---|---|---|---|---|
| 1 | Novice | 2 | 150 ms | 0.20 | 0.15 | no |
| 2 | Casual | 3 | 250 ms | 0.08 | — | no |
| 3 | Club | 6 | 500 ms | 0.02 | — | no |
| 4 | Expert | 14 | 1200 ms | 0 | — | yes |
| 5 | Master | 40 | 3000 ms | 0 | — | yes |

**Worker protocol**

```ts
type AiRequest = { type: 'loadNet'; netId: string; url: string }
  | { type: 'think'; reqId: number; netId: string | 'heuristic'; startFen: string; moves: string[]; level: LevelSpec; seed?: number };
type AiResponse = { type: 'netLoaded'; netId: string; gen: number }
  | { type: 'move'; reqId: number; move: string; score: number; depth: number; nodes: number; pv: string[]; ms: number }
  | { type: 'error'; reqId?: number; message: string };
class AiClient { loadNet(id, url): Promise<void>; think(game: Game, netId: string | 'heuristic', level: LevelSpec): Promise<AiMove>; cancel(): void } // cancel = terminate + respawn
```
- `score` is an int from the side to move's view: ±1000 eval, mate = 30000 − ply.
- The UI's win probability is `(clamp(score, ±1000)/1000 + 1) / 2`.

## 6. Data formats (`src/shared/formats.ts`)

```ts
type BaselineId = 'random' | 'heur2' | 'heur4' | 'heur6';
type PlayerId = number /* gen */ | BaselineId | 'human';
interface WDL { w: number; d: number; l: number }
interface TrainingManifest {
  format: 1; rules: 'english-draughts'; run: string; updated: string;
  net: { layers: number[] }; totalGames: number; hours: number; champion: number | null;
  anchor: { id: 'heur4'; elo: 1000 }; baselines: { id: BaselineId; name: string; elo: number }[];
  generations: { gen: number; games: number /*cumulative*/; hours: number; depth: number; elo: number; eloErr: number;
    vs: Partial<Record<BaselineId | 'prev' | 'prev10', WDL>>; avgPlies: number; decisive: number; loss: number;
    replay: string | null; net: string | null }[];         // paths relative to BASE_URL + 'training/'
}
interface GenFile { format: 1; gen: number; games: GameRecord[] }
interface GameRecord { id: string; kind: 'selfplay' | 'gauntlet'; black: PlayerId; white: PlayerId; startFen?: string;
  moves: string[]; result: ResultStr; reason: EndReason; evals?: number[] /* per ply, side 0 view, ±100 */;
  random?: number[]; explore?: number[] /* ply indices */ }
```

**Weights file `nets/gen-NNNN.bin` (little-endian)**
- Header: `'CKN1'`, u32 version = 1, u32 gen, u32 nLayers, u32 sizes[].
- Body: f32 `W1T[in][out]`, b1, W2[out][in], b2, W3, b3.
- Default layers 132-64-32-1, which is 10,625 parameters (about 42.5 KB).

**Budgets**
- Ship at most 28 nets, chosen log-spaced plus the champion plus the latest.
- `public/training` ≤ 5 MB; each gen file ≤ 300 KB.
- The assets test replays every game through `Game.fromMoves` and checks that `result` matches.

## 7. P2P

**Transport and link**
- **Transport:** `{ selfId; join(code, opts); send(msg); onMessage; onPeerJoin; onPeerLeave; onError(kind: 'signaling' | 'ice'); leave() }`.
- **PeerJS adapter:**
  - Host registers ID `ck1-<CODE>-h`. Guest registers `ck1-<CODE>-g<rand>` and dials the host.
  - On `unavailable-id`, retry with backoff of 2, 4, 8 then 15 s (capped), showing "Reconnecting".
  - `?peer=host:port` overrides the broker at runtime, for e2e.
  - `iceServers` = Google and Cloudflare STUN, plus optional Metered TURN from `VITE_TURN_CRED_URL`.
  - The PeerJS chunk is lazy-loaded.
- **Room code:** 10 Crockford base32 characters, shown as `XXXXX-XXXXX`. The link is `…/checkers/#/play/<CODE>`.
- **Roles:** the creator is the host, and the host record lives in `checkers:room:<CODE>`. Anyone opening a link with no local record for that code is the guest.

**Wire messages** (`PROTO = 1`; JSON; ≤ 64 KB; strict `decode`)

```ts
type WireMsg =
 | { t: 'hello'; proto: 1; clientId: string; role: 'host' | 'guest'; name?: string }
 | { t: 'reject'; reason: 'room-full' | 'proto-mismatch' }
 | { t: 'sync'; game: OnlineGame | null; offer?: { kind: OfferKind; gameId: string; ply: number; from: Role } }
 | { t: 'start'; game: { id: string; hostSide: Side } }                 // host only; rematch swaps
 | { t: 'move'; gameId: string; ply: number; move: string; hash: string } // hash = fnv1a32(toFen(pos after)).toString(16)
 | { t: 'resign'; gameId: string; ply: number }
 | { t: 'offer'; kind: OfferKind; gameId: string; ply: number }
 | { t: 'answer'; kind: OfferKind; gameId: string; ply: number; accept: boolean }
 | { t: 'ping' | 'pong'; n: number; ply: number; hash: string } | { t: 'bye' };
type OfferKind = 'draw' | 'rematch';
interface OnlineGame { id: string; hostSide: Side; moves: string[]; result?: GameResult }
```

**Behaviour carried over from the P2P design:**
- `reconcile` handles four cases: equal, prefix, behind, and diverged (host wins).
- Seat rule: the first guest clientId gets the seat; later ones get `room-full`.
- Ping every 3 s. Lost after 10 s, then rejoin with backoff.
- Moves made while the opponent is disconnected are queued and delivered by `sync`.
- `bye` never forfeits.

## 8. Frontend contracts

**GameDriver**

```ts
type GameResult = { winner: Side | null; reason: EndReason };
interface DriverSnapshot { startFen: string; moves: string[]; mySides: Side[]; result?: GameResult; thinking?: boolean;
  online?: { status: ConnStatus; rttMs?: number; role: Role; peerName?: string; incomingOffer?: OfferKind; outgoingOffer?: OfferKind; error?: OnlineError } }
interface GameDriver { subscribe(fn: (s: DriverSnapshot) => void): () => void; submitMove(move: string): boolean;
  undo?(): void; resign(): void; offer?(k: OfferKind): void; answer?(k: OfferKind, accept: boolean): void; dispose(): void }
```
- Implementations: `LocalDriver`, `AiDriver` (min 350 ms think display), `OnlineDriver`.
- `BoardView` is the frontend design's version, with `Move` as defined in §5.

**Routes**

| Route | Screen |
|---|---|
| `#/` | home |
| `#/ai?level=1-5&side=0\|1\|r&gen=N&fen=` | vs AI |
| `#/local` | pass and play |
| `#/friend` | create game |
| `#/play/<CODE>` | online game |
| `#/lab` | Training Lab overview |
| `#/lab/<gen>` | generation detail |
| `#/lab/<gen>/<gameId>?ply=n` | replay |
| `#/lab/live/<a>/<b>` | gen A vs gen B live |
| `#/review` | review last game |

**Test hook** (`?test=1`; also gives instant animations and DPR 1)

```ts
window.__checkers = { ready: Promise<void>, state(): { fen: string; moves: string[]; turn: Side; status: GameStatus; mode: string; online?: ConnStatus }, clientOfSquare(sq: Sq): { x: number; y: number }, playMove(s: string): boolean }
```

## 9. Build plan

**Phase 0: lead only, sequential**
- Write configs, `.gitattributes` and `git config core.fileMode false`.
- Write `types.ts`, `formats.ts` and `protocol.ts` types.
- Implement `bitboard.ts` and `position.ts` for real, so the frontend is never blocked: `initialPosition`, `sqToRowCol`, `pieceAt`, FEN.
- Stub everything else, plus a placeholder manifest.
- Run `npm install` and `npx playwright install chromium`.
- `gh repo create`, enable Pages (`build_type=workflow`), deploy the placeholder.
- **Accept when:** `npm test`, `typecheck` and `build` pass, and `curl -I https://duaneshaffer.github.io/checkers/` returns 200.

**Phase 1: parallel units.** Each unit edits only its own files. Only the lead touches `package.json`, configs and contracts.

**U1 Engine rules**
- **Owns:** `src/engine/{movegen,notation,zobrist,game,perft,openings,rng}.ts`, `trainer/perft-cli.ts`, `tests/engine/*`, `tests/purity.test.ts`.
- **Accept when:**
  - perft 1-8 passes by default, and 9-11 with `PERFT_DEEP`; perft(8) runs in < 5 s.
  - The 7 first moves are exact.
  - Rule FEN cases pass: promotion ends the capture, king loop capture, no double-jump over the same piece, mandatory capture, choice among captures, draw rules.
  - Notation and FEN round-trip for every legal move.
  - Incremental hash equals full hash.
- This is the **critical path**.

**U2 AI core** (needs U1 for its tests; start against stubs)
- **Owns:** `src/ai/{features,network,heuristic,search,levels,ai.worker,client}.ts`, `tests/ai/*`.
- **Accept when:**
  - The flip-symmetry test passes.
  - CKN1 round-trips exactly.
  - Search finds forced shots and wins.
  - TT on and TT off give the same score at fixed depth.
  - The worker returns a level-1 move with the heuristic in < 300 ms.

**U3 Trainer** (needs U1 and U2)
- **Owns:** `trainer/*` except `perft-cli.ts`, plus `tests/trainer/*`.
- **Accept when:**
  - `lambdaTargets` hand cases pass.
  - The finite-difference gradient check passes.
  - Elo fit on synthetic data is correct.
  - `train:smoke` (2 workers, 2 gens × 100 games) finishes in < 2 min, then `export` produces output that passes `assets.test.ts`.
  - `bench` reports nodes/s.
- **Then the pilot gate** (§3 item 8), then the overnight run launched in the background with `--publish-every 10`.

**U4 Scene**
- **Owns:** `src/scene/*`, `tests/frontend/{cameraFit,picking,orientation}.test.ts`.
- **Accept when:**
  - The initial position renders.
  - Board-slot fitting works at 360×640, 390×844, 844×390 and 1440×900.
  - The single-corner and double-corner orientation test passes.
  - Picking round-trips with `clientOfSquare`.
  - Animations cover hop, capture-to-tray and crown.
  - On-demand rendering is idle when nothing moves.

**U5 Game shell and UI**
- **Owns:** `src/app/*`, `src/main.ts`, `src/game/*`, `src/ui/*` except `online/`, `src/audio/*`, styles, `index.html` body.
- **Accept when:**
  - Selection, pieceTracker, router and keyboard tests pass.
  - Local pass-and-play works end to end.
  - vs AI works with levels 1-5 and the heuristic fallback.
  - Resume, the game-over modal and the announcer work.
  - Every button is ≥ 44 px, with no horizontal overflow.

**U6 Online** (needs U1)
- **Owns:** `src/net/*`, `src/ui/online/*`, `tests/net/*`, `tests/support/loopbackTransport.ts`, `tests/e2e/online.spec.ts`.
- **Accept when:**
  - Code, decode, reconcile and session unit tests pass.
  - A 500-seed loopback fault simulation converges.
  - Playwright passes with two contexts against `npm run peer`: invite link, move exchange, guest reload restores state, room-full, draw/resign/rematch with color swap, phone-viewport Share/Copy.

**U7 Training Lab** (needs `formats.ts`, and U4/U5 for replay)
- **Owns:** `src/lab/*`, `tests/fixtures/training/*`, `tests/frontend/replayTimeline.test.ts`, `tests/e2e/lab.spec.ts`.
- **Accept when:**
  - The Elo chart, W/D/L bars and generation picker work from fixtures.
  - Replay stepping animates and scrubbing snaps.
  - Deep links use `?ply`.
  - Live gen-vs-gen works with two nets.
  - The empty state renders.

**U8 CI and e2e** (lead)
- **Owns:** `.github/workflows/deploy.yml`, `playwright.config.ts`, `tests/e2e/{smoke,layout,play-local,play-ai}.spec.ts`.
- **Workflow:**
  - The deploy is gated on `npm test` and `build`.
  - The e2e job runs in parallel and does not block the deploy.
  - Chromium runs with `--use-angle=swiftshader --enable-unsafe-swiftshader --disable-features=WebRtcHideLocalIpsWithMdns`.
  - It uses `upload-artifact@v7`.

**Order:**
1. Phase 0.
2. Start U1, U4, U5 shell, U6 pure parts and U7 fixtures in parallel.
3. Once U1 lands: U2, then U3.
4. Run the pilot as soon as U3 passes, because training needs wall-clock time.
5. While training runs: AI integration in U5, U6 end to end, U7 on interim exports.

**Phase 2: lead**
- Final `npm run export` and `npm test`.
- Commit `public/training`, push, and confirm the deploy.
- Real-device check: phone on cellular vs desktop, with and without TURN.

**Questions for the user**
- Keep PeerJS or switch to Trystero?
- Should we configure a Metered TURN key?
- Can Windows sleep be disabled during the overnight run?

### Critical Files for Implementation
- /mnt/c/Users/dlshaffer/Documents/dlshaffer/checkers/src/engine/types.ts
- /mnt/c/Users/dlshaffer/Documents/dlshaffer/checkers/src/engine/movegen.ts
- /mnt/c/Users/dlshaffer/Documents/dlshaffer/checkers/src/shared/formats.ts
- /mnt/c/Users/dlshaffer/Documents/dlshaffer/checkers/trainer/train.ts
- /mnt/c/Users/dlshaffer/Documents/dlshaffer/checkers/src/game/driver.ts

Sources:
- [talkchess: perft for 8x8 checkers](https://talkchess.com/viewtopic.php?p=482292)
- [OEIS A133046](https://oeis.org/A133046)