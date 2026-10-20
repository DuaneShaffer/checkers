# Repo structure, build, tests, CI/CD, and execution plan

## Decisions
- Run the trainer with Node 24's built-in TypeScript type stripping (`node training/train.ts`) instead of tsx/esbuild. It was verified locally (`process.features.typescript === 'strip'`), works in worker_threads without loader hacks, and adds no dependency. Cost: `.ts` import extensions and erasable-only syntax (no enums), enforced by `erasableSyntaxOnly`.
- Use a single tsconfig with `moduleResolution: bundler` and `allowImportingTsExtensions`. One config serves Vite, Vitest and Node, and engine purity is enforced by a test instead of separate tsconfigs.
- Keep the repo on /mnt/c, because the user chose it. Training I/O goes to ext4 at `~/checkers-runs/<run>`, and node_modules is not symlinked, because Vite's fs.allow and realpath resolution break that.
- Use hash routing with Vite `base: '/checkers/'`. All asset URLs go through `import.meta.env.BASE_URL`, so no 404.html or .nojekyll is needed with artifact deploys.
- Deploy with actions/checkout@v7, setup-node@v7, upload-pages-artifact@v5 and deploy-pages@v5. Enable Pages with `gh api -X POST repos/DuaneShaffer/checkers/pages -f build_type=workflow`. configure-pages is unnecessary.
- Only unit tests and the build gate the deploy. E2E runs in a parallel CI job so a flaky WebGL or WebRTC check cannot block a release.
- A runtime `?peer=host:port` query param overrides the PeerJS broker, so the P2P e2e test runs against a local `peer` server in CI and locally without the public broker or a second build.
- Training runs only locally. `export-replays` curates at most about 60 generations × 3–4 showcase arena games and about 5 weight checkpoints (which double as AI difficulty levels) into public/, under a 5 MB budget enforced by assets.test.ts. That test also replays every move for legality.
- Before any trained weights exist, the browser AI falls back to a heuristic eval, so UI work and e2e tests are not blocked on training.
- Only the lead agent runs npm or edits package.json, configs, contracts and the workflow. Parallel agents own disjoint directories to avoid conflicts and node_modules corruption.
- Start the long training run in the background right after the pilot run validates learning. It is resumable, checkpoints every generation, and allows interim exports, so UI integration proceeds in parallel with real data.
- Run `git config core.fileMode false` and add .gitattributes (`eol=lf`, `*.bin binary`), because drvfs reports every file as 777.

## Risks
- Playwright's Chromium is not installed, and `install-deps` needs sudo. The user may need to run `sudo npx playwright install-deps chromium`. Fallback for manual checks: the Playwright MCP browser tools.
- TypeScript 7 (native port) is new, so some option or edge case may fail. Fallback: pin typescript@~6.0 with the same config.
- Node type stripping forbids enums, parameter properties and namespaces, and requires `.ts` import extensions. An agent that writes those breaks the trainer only at runtime. Mitigation: `erasableSyntaxOnly` in tsconfig, plus the smoke test runs real workers.
- /mnt/c 9p I/O makes npm ci, Vite and Vitest cold starts slow, and Windows-side edits are not seen by inotify. Mitigation: `POLL=1 npm run dev`. If it is unbearable, moving the repo to ~/checkers is the escape hatch, with user consent.
- Long training on WSL is interrupted by Windows sleep, reboots or `wsl --shutdown`. Mitigation: per-generation checkpoints, `train:resume`, and asking the user to disable sleep during the overnight run.
- Throughput estimates (about 5+ games/s with 11 workers) are guesses until the pilot run measures them. If the network or search depth is too slow, cut depth or network size before the long run.
- The P2P e2e test uses loopback WebRTC between two contexts. mDNS host candidates can block it, so launch with `--disable-features=WebRtcHideLocalIpsWithMdns`. Real-world NAT traversal (cellular, symmetric NAT) without TURN may fail and can only be checked manually.
- The first Pages workflow run can fail if Pages is not yet enabled when the first push lands. Re-run with `gh workflow run deploy.yml` after the `gh api` enable call.
- Headless WebGL uses SwiftShader, so FPS-based checks in CI are only a loose sanity floor. Real mobile performance needs a device check or post-deploy Lighthouse.
- Parallel agents editing src/web/main.ts or router.ts could conflict. Ownership is B-only, and C and D expose `mount*()` functions.

## Interfaces

// src/engine/types.ts (lead-owned contract). Squares: 0..31 internally, bit i = PDN square i+1; Black (dark) starts on 1..12 and moves first.
export type Color = 'b' | 'w';
export interface Position { readonly black: number; readonly white: number; readonly kings: number; readonly turn: Color } // uint32 bitboards (>>>0)
export interface Move { readonly from: number; readonly to: number; readonly path: readonly number[]; readonly captures: readonly number[]; readonly promotes: boolean }
export type DrawReason = 'no-progress' | 'repetition' | 'max-plies' | 'agreement';
export type Outcome = { winner: Color; reason: 'no-moves' | 'resign' | 'disconnect' } | { winner: null; reason: DrawReason };
// engine/board.ts, movegen.ts, notation.ts, game.ts
export declare function initialPosition(): Position;
export declare function legalMoves(p: Position): Move[];
export declare function applyMove(p: Position, m: Move): Position;
export declare function hashPosition(p: Position): bigint | number; // zobrist
export declare function formatMove(m: Move): string;               // "11-15" | "22x15x8" (1-based)
export declare function parseMove(p: Position, s: string): Move | null;
export declare function perft(p: Position, depth: number): number;
export declare class Game { constructor(start?: Position); readonly position: Position; readonly moves: readonly Move[]; readonly pliesSinceProgress: number; legalMoves(): Move[]; play(m: Move | string): void; outcome(): Outcome | null; static fromMoves(moves: readonly string[]): Game; }
export const NO_PROGRESS_PLY_LIMIT = 80; export const MAX_PLIES = 400;
// engine/nn.ts, features.ts, search.ts
export interface Net { readonly layers: readonly { inSize: number; outSize: number; w: Float32Array; b: Float32Array; act: 'relu' | 'tanh' | 'linear' }[] }
export declare function encodeFeatures(p: Position, out: Float32Array): void;
export declare function evaluate(net: Net, p: Position): number;   // [-1,1], side-to-move perspective
export declare function serializeNet(net: Net): { manifest: WeightsManifest; data: Float32Array };
export declare function deserializeNet(manifest: WeightsManifest, data: ArrayBuffer): Net;
export type EvalFn = (p: Position) => number;
export interface SearchOptions { maxDepth: number; timeMs?: number; maxNodes?: number; temperature?: number; rng?: () => number }
export interface SearchResult { move: Move; score: number; depth: number; nodes: number; pv: Move[] }
export declare function search(p: Position, evalFn: EvalFn, opts: SearchOptions): SearchResult;
// src/shared/weights-format.ts
export interface WeightsManifest { version: 1; features: string; layers: { inSize: number; outSize: number; act: 'relu' | 'tanh' | 'linear' }[]; paramCount: number }
export interface AiManifest { version: 1; best: string | null; levels: { id: string; name: string; gen: number; file: string; depth: number; timeMs: number; elo: number | null; weights: WeightsManifest }[] } // file relative to BASE_URL + 'ai/'
// src/shared/replay-format.ts
export type ResultStr = '1-0' | '0-1' | '1/2-1/2'; // 1-0 = black wins
export interface ReplayGame { id: string; gen: number; black: string; white: string; moves: string[]; result: ResultStr; reason: Outcome['reason']; plies: number }
export interface ReplayGeneration { version: 1; gen: number; gamesTrained: number; createdAt: string; elo: number | null; vsRandom: number | null; vsHeuristic: number | null; games: ReplayGame[] }
export interface ReplayIndex { version: 1; runId: string; generatedAt: string; generations: { gen: number; file: string; gamesTrained: number; elo: number | null; vsRandom: number | null; vsHeuristic: number | null }[] } // file relative to BASE_URL + 'replays/'
// src/shared/protocol.ts (P2P over PeerJS DataConnection, JSON)
export type NetMsg =
  | { t: 'hello'; v: 1; name?: string }
  | { t: 'start'; guestColor: Color; moves: string[] }
  | { t: 'move'; ply: number; move: string }
  | { t: 'sync'; moves: string[] }
  | { t: 'resign' } | { t: 'draw-offer' } | { t: 'draw-accept' }
  | { t: 'rematch' } | { t: 'rematch-accept' }
  | { t: 'ping'; at: number } | { t: 'pong'; at: number };
// Web integration seams (B owns router; C/D export mounts)
// src/web/ai/ai-client.ts:  createAi(level: AiManifest['levels'][number] | 'heuristic'): { chooseMove(moves: string[]): Promise<string>; dispose(): void }
// src/web/net/peer-session.ts: hostSession(opts?: { peer?: string }): Promise<{ inviteUrl: string; session: PeerSession }>; joinSession(peerId: string, opts?): Promise<PeerSession>; PeerSession { send(m: NetMsg): void; onMessage(cb): void; onStatus(cb: (s: 'connecting'|'open'|'closed'|'error') => void): void; close(): void }
// Test hook (?e2e=1): window.__checkers = { state(): { moves: string[]; turn: Color; outcome: Outcome | null; mode: string; net?: string }; squareToScreen(sq1to32: number): { x: number; y: number } }
// Runs dir: ${CHECKERS_RUNS:-$HOME/checkers-runs}/<run>/{state.json, weights/gen-XXXX.bin, games/gen-XXXX.jsonl, metrics.jsonl, train.log}
// npm scripts: dev, build, preview, typecheck, test, test:watch, perft, train, train:resume, train:smoke, export-replays, e2e, e2e:install, peer

## Design

# Repo, build, tests, CI/CD, and execution plan

## 0. What I checked (read-only, 2026-10-19)
- `/mnt/c/Users/dlshaffer/Documents/dlshaffer/checkers` is empty and is not a git repo yet. `DuaneShaffer/checkers` does not exist on GitHub yet.
- `gh` 2.96 is logged in as DuaneShaffer with token scopes `repo` and `workflow`. Pushing `.github/workflows/*` will work.
- Git identity is set: `dlshaffer <dlshaffer@alaska.edu>`.
- Node v24.13.0 / npm 11.6. `process.features.typescript === "strip"`, so Node runs `.ts` files natively and **no tsx is needed**. Running TS from stdin also worked.
- Latest versions: actions/checkout **v7**, actions/setup-node **v7**, actions/upload-pages-artifact **v5**, actions/deploy-pages **v5**, actions/configure-pages v6 (not needed). npm: vite 8.3, three 0.186, @types/three 0.186, peerjs 1.5.5, peer 1.0.2 (local PeerServer for tests), vitest 5.0 (peer dep vite ^8 ok), @playwright/test 1.64, typescript 7.0 (native port), @types/node 26.
- Playwright browsers are **not installed** (`~/.cache/ms-playwright` is missing).
- On /mnt/c, the 9p filesystem is very slow. A recursive `ls` of the parent Documents tree did not finish within 120 s.
- WSL reports 15 GB RAM. /mnt/c shows every entry as mode 777, so git would treat every file as executable unless `core.fileMode=false` is set.
- Perft reference values for 8x8 checkers from the start position (Aart Bik, talkchess): d1..d10 = 7, 49, 302, 1469, 7361, 36768, 179740, 845931, 3963680, 18391564.

## 1. File tree
```
checkers/
  .github/workflows/deploy.yml
  .gitattributes                # * text=auto eol=lf ; *.bin binary
  .gitignore                    # node_modules dist test-results playwright-report *.log .vite
  .nvmrc                        # 24
  package.json
  tsconfig.json
  vite.config.ts                # also holds vitest config
  playwright.config.ts
  index.html
  README.md
  src/
    engine/                     # pure TS: no DOM, no node:*, no three; shared by web + trainer
      types.ts                  # CONTRACT (lead writes first)
      board.ts                  # 32-square bitboards, initial position, zobrist
      movegen.ts                # legalMoves / applyMove (mandatory capture, multi-jump, crowning ends move)
      game.ts                   # Game: history, repetition, 40-move-no-progress, max-plies, outcome
      notation.ts               # 1..32 PDN numbering, "11-15", "22x15x8", parse/format
      perft.ts
      features.ts               # position -> Float32Array
      nn.ts                     # MLP forward + (de)serialize Float32 weights
      search.ts                 # iterative-deepening alpha-beta, TT, capture extension
      heuristic.ts              # material/advancement eval (fallback before weights exist + baseline)
      index.ts                  # barrel
    shared/
      replay-format.ts          # CONTRACT: replay JSON types + validators
      protocol.ts               # CONTRACT: P2P message union
      weights-format.ts         # CONTRACT: weights manifest type
    web/
      main.ts, router.ts        # hash routes
      scene/                    # renderer, board3d, pieces, picking, camera, animation
      ui/                       # menu, hud, dialogs, styles.css
      modes/                    # local, vs-ai, p2p, replay controllers
      ai/ai.worker.ts, ai-client.ts
      net/peer-session.ts       # PeerJS wrapper (owned by net agent)
      replay/replay-player.ts
      testhook.ts               # window.__checkers when ?e2e=1
  training/
    train.ts                    # orchestrator (main thread), resume, checkpoints
    selfplay.worker.ts          # worker_threads: plays games, returns TD deltas
    td.ts                       # TD(lambda)/TD-Leaf update math
    arena.ts                    # gen-vs-gen, vs random, vs heuristic baseline -> Elo
    export-replays.ts           # run dir -> public/
    config.ts
    rundir.ts                   # paths, atomic writes (tmp+rename)
  scripts/perft.ts
  public/
    ai/manifest.json            # {levels:[{id,name,gen,file,depth,elo}], best}
    ai/gen-XXXX.bin             # Float32 LE, a few checkpoints only
    replays/index.json          # generation list + elo curve
    replays/gen-XXXX.json       # showcase games of that generation
  tests/
    engine/perft.test.ts, rules.test.ts, notation.test.ts, game.test.ts, nn.test.ts, search.test.ts, purity.test.ts
    training/smoke.test.ts, td.test.ts
    assets.test.ts              # public/ size budget + schema + every replay move is legal
    e2e/smoke.spec.ts, play-ai.spec.ts, replay.spec.ts, mobile.spec.ts, p2p.spec.ts
```

## 2. Toolchain decisions
- **Node runs TypeScript natively** for the trainer (`node training/train.ts`). worker_threads use `new Worker(new URL('./selfplay.worker.ts', import.meta.url))`. This avoids tsx/esbuild and the usual `execArgv` loader problems in workers. Consequences:
  - Relative imports must include the `.ts` extension, everywhere including the engine.
  - Only erasable syntax is allowed: no `enum`, no parameter properties, no namespaces. Use `as const` objects and union types instead.
  - Vite and Vitest handle `.ts` extension imports without problems.
  - Fallback if a Node quirk shows up: add a `train:build` script that runs `esbuild training/*.ts --bundle --platform=node --format=esm --outdir=$RUN/bin`.
- tsconfig.json (single file):
  `{"compilerOptions":{"target":"ES2022","module":"preserve","moduleResolution":"bundler","lib":["ES2023","DOM","DOM.Iterable"],"types":["node","vite/client"],"strict":true,"noEmit":true,"allowImportingTsExtensions":true,"erasableSyntaxOnly":true,"verbatimModuleSyntax":true,"isolatedModules":true,"skipLibCheck":true},"include":["src","training","tests","scripts","*.ts"]}`
  - Typing `postMessage` in the web worker: cast `self as unknown as { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ... }`. This avoids the lib clash between DOM and WebWorker.
  - Engine purity is enforced by `tests/engine/purity.test.ts`, which fails on any `node:`/`three`/`peerjs`/`document`/`window` reference in src/engine.
- TypeScript 7 is the native Go port. Pin `typescript@^7.0.2`. If `tsc` misbehaves on any option, pin `typescript@~6.0` (same config).
- vite.config.ts:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  base: '/checkers/',
  build: { target: 'es2022', sourcemap: true },
  worker: { format: 'es' },
  server: { watch: process.env.POLL ? { usePolling: true, interval: 300 } : undefined },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 60_000 },
});
```
  - Every runtime asset URL must be built from `import.meta.env.BASE_URL`, e.g. `fetch(`${import.meta.env.BASE_URL}replays/index.json`)`. Never use a leading `/`.
  - Routing is hash-based (`#/`, `#/ai/<level>`, `#/local`, `#/host`, `#/join/<peerId>`, `#/replays`, `#/replays/<gen>/<n>`). That means no 404.html is needed. Pages artifact deploys do not run Jekyll, so no .nojekyll is needed either.
  - Peer server override is a query string read at runtime, before the hash: `?peer=127.0.0.1:9000`. The default is the PeerJS cloud. E2E tests can therefore use a local broker without a second build.
- package.json (`"type":"module"`, `"engines":{"node":">=24"}`, `"private":true`):
```json
"scripts": {
  "dev": "vite",
  "build": "tsc --noEmit && vite build",
  "preview": "vite preview --port 4173 --strictPort",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "test:watch": "vitest",
  "perft": "node scripts/perft.ts 9",
  "train": "node training/train.ts --run main --new",
  "train:resume": "node training/train.ts --run main --resume",
  "train:smoke": "node training/train.ts --run smoke --new --overwrite --workers 2 --games-per-gen 100 --gens 2",
  "export-replays": "node training/export-replays.ts --run main",
  "e2e": "playwright test",
  "e2e:install": "playwright install chromium",
  "peer": "peerjs --port 9000 --path /"
},
"dependencies": { "three": "^0.186.1", "peerjs": "^1.5.5" },
"devDependencies": { "vite": "^8.3.4", "vitest": "^5.0.5", "typescript": "^7.0.2", "@types/three": "^0.186.0", "@types/node": "^24", "@playwright/test": "^1.64.1", "peer": "^1.0.2" }
```
  - `train` refuses to run if the run dir already exists. `train:resume` refuses if it does not. This prevents an accidental restart from wiping a long run.
  - `train` and `export-replays` take `--run <name>` and resolve it to `${CHECKERS_RUNS:-$HOME/checkers-runs}/<name>`.

## 3. WSL /mnt/c recommendation
- **Keep the repo at /mnt/c**: the user chose that directory and every agent's cwd points there. The costs are bounded:
  - `npm ci` takes a few minutes, once, plus once per dependency change.
  - Vite/Vitest cold start is a few seconds slower.
  - HMR works for edits made from WSL. Use `POLL=1 npm run dev` if the user edits from a Windows editor.
- **Do not symlink node_modules to ext4.** Vite's `server.fs.allow` and realpath dependency resolution break on out-of-root realpaths. It is not worth the risk.
- **Only the lead agent runs npm.** It installs all dependencies in Phase 0. Parallel agents never touch package.json or node_modules; concurrent `npm install` on one tree corrupts it.
- **Training I/O lives on ext4, not /mnt/c**, in `~/checkers-runs/main/`:
  - `state.json` (gen, gamesPlayed, rng seeds, optimizer state, best gen)
  - `weights/gen-XXXX.bin`
  - `games/gen-XXXX.jsonl` (sampled self-play + arena games as move strings)
  - `metrics.jsonl`
  - `train.log`
  
  Writes are atomic (write tmp, then rename). Code loads from /mnt/c once per worker, which costs very little next to the CPU-bound self-play. Only `export-replays` writes into `public/`, and only a small curated subset.
- Git on drvfs: run `git config core.fileMode false` right after `git init`, because every file shows as 777. Also add `.gitattributes` with `* text=auto eol=lf` and `*.bin binary`.

## 4. Trainer output -> public/ -> commit
- CI never trains. The user's machine trains, `npm run export-replays` curates, and the user commits and pushes. Pages then redeploys.
- export-replays picks:
  - Generations: all of them if there are ≤60. Otherwise gen 0, a log-spaced set, a uniform set, and the last 10, capped at 60.
  - Per generation: 3–4 showcase games. These are arena games played at low temperature from randomized 2-ply openings (not the noisy exploration games). Each is stored as move strings plus result and reason.
  - AI levels: about 5 weight checkpoints (gen 0 = "untrained", early, mid, late, best-by-arena-Elo). Each is paired with a search depth.
- Replay index format: `index.json = {version:1, runId, generatedAt, generations:[{gen, file, gamesTrained, elo, vsRandom, vsHeuristic}]}`.
- Size budget, enforced by `tests/assets.test.ts`:
  - public/ total < 5 MB
  - each replay file < 300 KB
  - each weights file < 512 KB, and its byte length equals the manifest's param count × 4
  - every replay game replays legally through the engine and ends in the recorded result
  
  Expected sizes are about 1 KB per game × 4 × 60 ≈ 250 KB, plus 5 × ~40–200 KB weights. This is far under the GitHub file limit (100 MB) and the Pages site limit (1 GB).
- Before any trained weights exist, the browser AI falls back to `heuristic.ts`. The UI is usable from day one, and assets.test passes when `public/ai/manifest.json` has zero levels.

## 5. CI/CD (.github/workflows/deploy.yml)
```yaml
name: deploy
on: { push: { branches: [main] }, pull_request: {}, workflow_dispatch: {} }
permissions: { contents: read }
concurrency: { group: pages-${{ github.ref }}, cancel-in-progress: false }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm test
      - run: npm run build
      - uses: actions/upload-pages-artifact@v5
        if: github.ref == 'refs/heads/main'
        with: { path: dist }
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run e2e
      - uses: actions/upload-artifact@v4   # verify current major at implementation time
        if: failure()
        with: { name: playwright-report, path: playwright-report }
  deploy:
    if: github.ref == 'refs/heads/main'
    needs: build
    runs-on: ubuntu-latest
    permissions: { pages: write, id-token: write }
    environment: { name: github-pages, url: ${{ steps.d.outputs.page_url }} }
    steps:
      - id: d
        uses: actions/deploy-pages@v5
```
- Deploy is gated on unit tests and the build. E2E runs in parallel and reports, but does not block a deploy.
- One-time repository setup, run by the lead once there is a first commit:
```
cd /mnt/c/Users/dlshaffer/Documents/dlshaffer/checkers
git init -b main && git config core.fileMode false
git add -A && git commit -m "Scaffold checkers project"
gh repo create DuaneShaffer/checkers --public --source=. --remote=origin --push
gh api -X POST repos/DuaneShaffer/checkers/pages -f build_type=workflow   # if 409: gh api -X PUT repos/DuaneShaffer/checkers/pages -f build_type=workflow
gh workflow run deploy.yml && gh run watch --exit-status
gh api repos/DuaneShaffer/checkers/pages --jq '.html_url,.build_type'
```
  If the first push's run fails because Pages was not enabled yet, `gh workflow run` re-runs it.
- No commit attribution lines.

## 6. Shared contracts (lead writes these before parallel work starts)
- `src/engine/types.ts`, `src/shared/replay-format.ts`, `src/shared/protocol.ts`, `src/shared/weights-format.ts`. Exact shapes are in the interfaces field.
- Rule: only the lead edits contract files. Agents ask for changes instead of editing them.

## 7. Execution plan and parallel ownership

**Phase 0: Scaffold (lead, sequential)**
- Write the configs above, contract files, engine function stubs that throw, a placeholder `index.html` + `main.ts` that renders a spinning Three.js board placeholder, and the empty `public/ai/manifest.json` and `public/replays/index.json`.
- `npm install` all dependencies, then `npx playwright install chromium`. If system libraries are missing, `npx playwright install-deps chromium` needs sudo, so ask the user. Fallback: the Playwright MCP browser tools for manual checks.
- git init, create the repo, enable Pages, deploy the placeholder.
- Acceptance:
  - `npm run build`, `npm test` (purity + assets) and `npm run typecheck` pass.
  - `curl -sI https://duaneshaffer.github.io/checkers/` returns 200.
  - Running deploy early validates the whole pipeline before features land.

**Phase 1: parallel. Agents only edit files they own.**

| Agent | Owns | Acceptance |
|---|---|---|
| A Engine rules | src/engine/{board,movegen,game,notation,perft,heuristic}.ts, scripts/perft.ts, tests/engine/{perft,rules,notation,game,purity}.test.ts | see Engine acceptance below |
| B 3D/UI | src/web/** except net/ and ai/, tests/e2e/{smoke,replay,mobile}.spec.ts | see 3D/UI acceptance below |
| D P2P | src/web/net/**, tests/e2e/p2p.spec.ts | see P2P acceptance below |
| C AI (starts with engine-free parts) | src/engine/{features,nn,search}.ts, training/**, src/web/ai/**, tests/training/**, tests/engine/{nn,search}.test.ts, public/ai/**, public/replays/** | see AI acceptance below |

- **Engine acceptance**
  - perft(1..9) matches 7/49/302/1469/7361/36768/179740/845931/3963680. perft(8) runs in under 5 s.
  - Edge cases:
    - capture is mandatory, but the player may choose among captures (no majority rule)
    - multi-jump must continue to the end
    - a man that crowns mid-jump stops there
    - a king captures backward
    - a piece cannot jump the same piece twice
    - a jumped piece is removed only after the whole sequence (no Turkish strike)
    - no legal moves means a loss
    - 40-move (80 plies) without a capture or man move is a draw
    - threefold repetition is a draw
    - the max-plies cap gives a draw
  - The notation round-trips for every legal move.
- **3D/UI acceptance**
  - Board, pieces, picking, move highlights and animations work in local 2-player mode with the real engine once A's movegen merges. Until then, B develops against the stubs plus a scripted fake.
  - The responsive layout works at 360×640, 390×844 portrait, 844×390 landscape and 1920×1080.
  - The replay viewer works against fixture replay JSON.
  - `window.__checkers` test hook exposes `state()` and `squareToScreen(sq)`.
- **P2P acceptance**
  - The host gets an invite link `https://duaneshaffer.github.io/checkers/#/join/<peerId>`. The guest connects, colors are assigned, and moves sync, with validation on both sides through the engine.
  - Disconnect and reconnect are handled with a `sync` resend. Resign and rematch work.
  - The two-context Playwright test passes against a local `peer` server.
- **C, early part:** nn forward/serialize, features, and search written against `types.ts`. The trainer skeleton with worker pool, run dir and resume can be built before movegen exists.

**Phase 2: AI + training (C, once A is merged)**
- Acceptance:
  - nn and search tests pass: search finds forced shots in tactical positions; nn serialize round-trips exactly.
  - `npm run train:smoke` passes in under 2 min, and `tests/training/smoke.test.ts` runs a 2-gen in-process run under 60 s.
  - The browser AI worker answers in under 1.5 s per move at its top level on desktop.
- Pilot run of 30–60 min with `npm run train`:
  - Throughput is logged: target about 5+ games/s with 11 workers at shallow depth.
  - Win rate vs random exceeds 95% and vs heuristic depth-2 exceeds 60% by the end of the pilot. If not, tune before the long run.
- **Then start the long run in the background:** `npm run train:resume`, launched with Bash `run_in_background` or `setsid nohup ... > ~/checkers-runs/main/train.log 2>&1 &`.
  - 11 workers (`availableParallelism()-1`).
  - One generation is about 5,000 games, plus a 40-game arena each generation against the previous best and fixed baselines.
  - It checkpoints every generation and handles SIGINT gracefully (finishes the round, then checkpoints).
  - Plan for 8–12 h (overnight). Expect roughly 150k–400k games and 40–80 generations.
  - The user should disable Windows sleep and avoid `wsl --shutdown` during the run.
  - It is resumable at any time, and interim `export-replays` runs are allowed during the day.

**Phase 3: integration (B + C + D while training runs)**
- B wires the vs-AI levels from the manifest, the replay browser with its Elo-over-generations chart, and the P2P mode screens from D.
- C runs interim `export-replays` so B and the e2e tests use real data.
- Acceptance: all e2e specs green locally, no console errors, JS bundle gzip ≤ 300 KB (three is most of it).

**Phase 4: final (lead)**
- Once training ends: `npm run export-replays`, then `npm test` (assets test validates legality and size), commit `public/`, push.
- Verify the deploy, and do a real-device check (see §8).

**Conflict avoidance**
- Only the lead edits package.json, configs, contracts, index.html and the workflow.
- `src/web/main.ts` and `router.ts` belong to B. D and C export `mount*()` functions that B calls.
- Each agent works on its own files in the shared tree. If agents use git worktrees, each merges via the lead.

## 8. Verification
- **Unit tests (Vitest):** perft, rule edge cases, notation round-trip, draw rules, nn serialize round-trip and forward-pass golden value, search tactics, TD update sign/shape, smoke training, assets/replay legality, engine purity.
- **Trainer smoke:** `npm run train:smoke`. It must produce `state.json`, 2 weight files, metrics lines and games JSONL in `~/checkers-runs/smoke`. Then `node training/export-replays.ts --run smoke --out <scratch dir>` produces schema-valid JSON.
- **Playwright** (playwright.config.ts):
  - `webServer` runs two processes:
    - `npm run build && npm run preview` at `http://localhost:4173/checkers/`
    - `npx peerjs --port 9000 --path /`
  - Projects:
    - desktop chromium 1280×800
    - 'Pixel 7'
    - 'iPhone 13' with `browserName: 'chromium'` (only chromium is installed)
  - Chromium launch args: `--use-gl=angle --use-angle=swiftshader`, plus `--disable-features=WebRtcHideLocalIpsWithMdns` so loopback WebRTC works between contexts.
  - Specs:
    - smoke: menu renders, canvas exists, no console errors
    - play-ai: make a move by clicking `squareToScreen` coordinates; the AI replies; the ply count is 2
    - replay: open #/replays, pick a generation, step and autoplay advance plies
    - mobile:
      - no horizontal overflow (`scrollWidth <= innerWidth`)
      - the board's projected corners lie inside the viewport in portrait and landscape
      - all buttons are ≥ 44×44 px
      - screenshots are saved for review
    - p2p (tag @p2p):
      - two `browser.newContext()` sessions; the host opens `?peer=127.0.0.1:9000#/host` and reads the invite link
      - the guest opens it and both show connected
      - alternate 4 moves and check that both `state()` values match
      - close the guest and check that the host shows disconnected
- **Mobile performance / Lighthouse-ish:**
  - The mobile spec counts rAF frames over 3 s as a loose sanity floor (SwiftShader is slow).
  - Post-deploy: `npx lighthouse https://duaneshaffer.github.io/checkers/ --form-factor=mobile --only-categories=performance,accessibility,best-practices --chrome-flags=--headless` using Playwright's chromium via `CHROME_PATH`. Targets: performance ≥ 80, accessibility ≥ 90.
  - Ask the user to try once on a real phone against desktop over cellular to check NAT traversal.
- **Deploy check:**
```
gh run watch --exit-status
curl -sfI https://duaneshaffer.github.io/checkers/ | head -1
curl -sf https://duaneshaffer.github.io/checkers/ | grep -o 'assets/[^"]*\.js' | head -1 | xargs -I{} curl -sfI https://duaneshaffer.github.io/checkers/{} | head -1
curl -sf https://duaneshaffer.github.io/checkers/replays/index.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).generations.length))"
curl -sfI https://duaneshaffer.github.io/checkers/ai/manifest.json | head -1
```
  Then run the Playwright smoke and replay specs against the live URL with `BASE_URL=https://duaneshaffer.github.io/checkers/ npx playwright test smoke replay --project=chromium`. The config honors `BASE_URL` and skips its webServer when it is set.

