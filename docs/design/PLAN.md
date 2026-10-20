# 3D Checkers: GitHub Pages, serverless link play, self-trained AI

## Context
This is a greenfield project; the folder `/mnt/c/Users/dlshaffer/Documents/dlshaffer/checkers` is empty. The user wants:
- A good-looking 3D checkers game in the browser, hosted on GitHub Pages, that works on mobile and desktop.
- Live play against a friend through a link, with **no third-party signaling or relay server**.
- An AI that we train ourselves.
- A **Training Lab** for watching the AI's self-play games across generations as it improves.

**Decisions made:**
- **Rules:** American/English draughts.
- **AI:** TypeScript engine shared by the game and the trainer. The trainer runs TD-Leaf(λ) self-play in Node on 12 cores. The GPU (AMD WX 4100) can't run CUDA or ROCm and isn't needed.
- **Repo:** public `DuaneShaffer/checkers`, deployed to Pages by Actions.
- **Link play:** a two-link WebRTC handshake (invite link, then a reply link) using free public STUN only, with **no TURN**.
- **Training:** an overnight run, with Windows sleep disabled by the user.

**Standing rules:**
- **No Claude/AI attribution** in any commit message or PR, including commits made by subagents. Right after approval, save this as a feedback memory in this project's memory dir with a `MEMORY.md` index.
- **Minimal comments**, per the global CLAUDE.md.

**Design source:** a 5-agent design workflow (AI, multiplayer, 3D/UX, ops, plus an integration critic). The full output is at `/tmp/claude-1000/-mnt-c-Users-dlshaffer-Documents-dlshaffer-checkers/88dff4e9-9d73-4fb6-803d-64cbf614dba0/tasks/wesngg1b1.output`, and the reconciled design is in `critique.md` next to it.
- Phase 0 copies both into `docs/design/`, so implementing agents have the full specs: bitboard masks, perft table, TD-Leaf math, scene and UX details.
- This plan overrides those files on the P2P transport. **No PeerJS, Trystero, `peer` server or TURN.**

## Stack (versions verified 2026-10-19)
- **Libraries:** Vite 8.3, TypeScript 7.0 (fall back to ~6.0 if it misbehaves), three 0.186 (WebGLRenderer), Vitest 5, Playwright 1.64 (Chromium only).
- **Trainer:** Node 24 native type stripping, run as `node trainer/x.ts`. That means `.ts` import extensions, `erasableSyntaxOnly`, no enums and no parameter properties.
- **Build:** Vite `base: '/checkers/'` with hash routing. Lazy chunks via dynamic `import()` for the Lab, AI net and QR code.
- **Deploy:** GitHub Actions `checkout@v7`, `setup-node@v7`, `upload-pages-artifact@v5`, `deploy-pages@v5`, `upload-artifact@v7`. Tests and the build gate the deploy; the e2e job is non-blocking.
- **Repo hygiene:** `.gitattributes` sets `eol=lf` and `*.bin binary`. Also run `git config core.fileMode false`, because drvfs reports every file as 777.
- **Training output:** goes to `~/checkers-runs/<run>` on ext4. Only the curated export is committed under `public/training/` (≤ 5 MB).

## File tree
```
.github/workflows/deploy.yml  package.json tsconfig.json vite.config.ts playwright.config.ts index.html README.md docs/design/*
public/training/{manifest.json, gens/gen-NNNN.json, nets/gen-NNNN.bin}   # placeholder manifest until trained
src/main.ts  src/app/{router,settings,persist,testHook,store}.ts
src/engine/{types,bitboard,rng,position,zobrist,movegen,notation,game,perft,openings,index}.ts   # pure, no DOM/Node
src/shared/formats.ts   # TrainingManifest, GenFile, GameRecord, CKN1 header + validators
src/ai/{features,network,heuristic,search,levels}.ts (pure)  src/ai/{ai.worker,client}.ts
src/net/{transport,rtcTransport,signal,protocol,reconcile,session,onlineDriver,roomStore,roomCode,invite}.ts
src/scene/{stage,environment,textures,boardModel,pieceModel,pieces,highlights,tween,moveAnimator,cameraRig,picking,quality,boardView}.ts
src/game/{driver,localDriver,aiDriver,controller,pieceTracker,selection,keyboard,announcer}.ts
src/audio/{sfx,haptics}.ts  src/ui/{dom,home,hud,modal,toast,miniBoard}.ts  src/ui/online/*
src/lab/{data,labView,eloChart,wdlBars,replayTimeline,replayView,liveMatch}.ts  src/styles/*.css
trainer/{train,pool,selfplay-worker,selfplay,nn-train,gauntlet,elo,checkpoint,export,bench,perft-cli}.ts
tests/{engine,ai,trainer,net,frontend}/*.test.ts  tests/{assets,purity}.test.ts  tests/support/loopbackTransport.ts  tests/e2e/*.spec.ts
```

## Key contracts
These are summarized here; full signatures are in critique.md §5–8.

### Engine
- **Representation:**
  - `Side = 0|1`: 0 is Black (rendered crimson), moves first, starts on PDN squares 1–12, and promotes on 29–32.
  - `Position {black, white, kings, turn}` uses uint32 bitboards.
  - `Move {from, to, path (includes from), captured bitmask, promotes}`.
- **Move generation:** captures are mandatory and multi-jumps must be completed. A man reaching the back row is promoted and the move ends there. Duplicate capture paths are kept.
- **Draws:** threefold repetition, or 80 plies with no man move or capture. A 300-ply cap applies in training only.
- **Notation:** `moveToString` / `parseMove` (`"11-15"`, `"15x24x31"`), PDN FEN, `Game.fromMoves`, and Zobrist hashing as two 32-bit halves.
- **Perft from the start position**, depths 1–11: 7, 49, 302, 1469, 7361, 36768, 179740, 845931, 3963680, 18391564, 85242128 (Bik/Cash, OEIS A133046).

### AI
- **Value net:** 132→64→32→1 (ReLU, ReLU, tanh). Inputs are side-to-move-relative, and flipping the board is a 32-bit bit-reversal.
- **Search:** PVS with iterative deepening, transposition table, killer and history ordering, and capture quiescence with no stand-pat. No null-move pruning.
- **Difficulty levels** (all on the champion net):

  | Level | Name | Depth | Time |
  |---|---|---|---|
  | 1 | Novice | 2 | 150 ms (plus blunder noise) |
  | 2 | Casual | 3 | 250 ms |
  | 3 | Club | 6 | 500 ms |
  | 4 | Expert | 14 | 1.2 s |
  | 5 | Master | 40 | 3 s |

  "Play vs generation N" is a separate option.
- **Browser runtime:** runs in a Web Worker. Cancelling means `terminate()` and respawning the worker, because there is no SharedArrayBuffer on Pages.
- **Fallback:** a heuristic evaluator until trained nets exist.

### Training
- **Algorithm:**
  - TD-Leaf(λ) with λ-returns computed per game. Traces are cut at exploratory moves.
  - Generation-synchronous: 11 `worker_threads` play about 2000 games per generation with frozen weights, then the main thread runs Adam.
  - Self-play uses depth 4, then depth 6 after generation 150.
  - Each game starts from a random 3-ply opening (302 of them).
- **Gauntlet:** about 240 games per generation against Random, Heur-d2, Heur-d4, Net(g−1), and every 5 generations Net(g−10) and Heur-d6.
- **Elo:** a Bradley–Terry fit with Heur-d4 anchored at 1000. The champion is the best-Elo generation among the last 20.
- **Resumable:** checkpoints every generation, and SIGINT finishes the current generation before stopping.
- **Live preview:** `--publish-every 10` re-exports to `public/training/`, so `npm run dev` shows progress while training runs.

### Training data shipped to the site
- **Weights:** CKN1 little-endian binary, about 42.5 KB per net. At most 28 nets ship: log-spaced generations plus the champion and the latest.
- **Replays:** per generation, 4 self-play games (at least one decisive game when one exists) and 2 gauntlet games, stored as `moves: string[]` with an eval for each ply.
- **Generation 0** (the untrained net) is always exported as the "before" baseline.
- **Assets test:** `tests/assets.test.ts` replays every game for legality, checks results and enforces the size budget.

### Serverless P2P (replaces PeerJS in the design docs)
- **Transport:** `rtcTransport.ts` is a raw `RTCPeerConnection` with one ordered DataChannel.
  - ICE is non-trickle: wait for gathering to complete, with a 3 s cap.
  - `iceServers`: 2–3 public STUN servers only (`stun:stun.l.google.com:19302`, `stun:stun.cloudflare.com:3478`, `stun:stun1.l.google.com:19302`). No TURN.
- **`signal.ts`:**
  - Strips unneeded SDP lines, compresses with `CompressionStream('deflate-raw')` and encodes as base64url.
  - The payload is `{v, code, gameId?, role, sdp}`, with roughly 300–700 characters in the URL fragment.
  - Decoding is strict. A unit test round-trips real Chromium SDPs.
- **Handshake flow:**
  1. The host taps "Play a friend". The app creates an offer and shows the invite link `…/checkers/#/join/<blob>` with Share, Copy and QR options. The host must keep that tab open.
  2. The guest opens the link and the app creates an answer. The guest sees a "Send this back" screen with the reply link `…#/answer/<blob>`, plus Share and Copy buttons.
  3. The host opens the reply link. The new tab posts the answer over `BroadcastChannel('checkers:rtc:<code>')` to the waiting tab and says "Connected — return to your game tab".
     - **Fallback:** the host's waiting screen also has a "paste reply code" box. This covers mobile, where links from messaging apps open in in-app webviews and BroadcastChannel can't reach the waiting tab.
  4. The DataChannel opens, both sides exchange `hello` and `sync`, and the game starts.
- **Reconnect:**
  - Both sides persist the game under `checkers:room:<CODE>`.
  - On disconnect, either player can choose "Resume link". That runs the same two-link handshake carrying the code and gameId, then `reconcile` brings both sides back in step: equal, prefix, behind, or diverged (host wins).
  - Before the channel dies, ICE restart over the still-open channel is attempted.
- **Protocol:** `PROTO=1`, as in critique.md §7: hello / reject / sync / start / move{ply, hash} / resign / offer / answer / ping.
  - Both peers validate every move with the shared engine.
  - Rematch swaps colors.
  - A `navigator.locks` `ifAvailable` lock allows only one tab per room.
- **Failure UX:**
  - Show a clear timeout message: "Couldn't connect directly — some networks (cellular / strict Wi-Fi) block peer-to-peer; try both on Wi-Fi".
  - An "About online play" note discloses that WebRTC reveals each player's IP address to the other player.

### Frontend
- **Game modes:** one `GameDriver` interface (subscribe, submitMove, undo?, resign, offer?, answer?) for Local, AI and Online play. The controller diffs snapshots: one new move is animated, anything else snaps to the new state.
- **Routes:** `#/`, `#/ai?level&side&gen&fen`, `#/local`, `#/friend`, `#/join/<blob>`, `#/answer/<blob>`, `#/play/<CODE>`, `#/lab`, `#/lab/<gen>`, `#/lab/<gen>/<gameId>?ply=`, `#/lab/live/<a>/<b>`.
- **Test hook:** `window.__checkers` when `?test=1`, which also makes animations instant and sets DPR to 1.
- **Scene:**
  - Lighting and color: RoomEnvironment/PMREM, NeutralToneMapping, PCFShadowMap.
  - Rendering: on demand, redrawing only when something changes. The shadow map only updates while pieces animate.
  - Framing: one full-screen canvas, with the camera fitted to a CSS `.board-slot` via `setViewOffset`.
  - Picking: ray/plane math.
  - Animations: pieces hop in an arc, captured pieces fly to rail trays, and a crown drops onto promoted kings.
  - Assets: procedural canvas textures (wood, normal-map reeding on piece rims).
  - Quality: two tiers with a DPR cap and one automatic downgrade step.
  - Touch: on coarse pointers, one finger taps pieces and two fingers orbit or zoom.
- **Look:** "Midnight Parlor": crimson vs ivory pieces on a walnut/maple board, brass accents, and the fonts Fraunces, Geist and Geist Mono via Fontsource (self-hosted).
- **Layout and accessibility:** touch targets ≥ 44 px, safe-area insets, `prefers-reduced-motion`, keyboard play, and an aria-live move announcer. Sound effects are synthesized with WebAudio, and phones get haptics.
- **Training Lab:**
  - A hand-rolled SVG Elo chart with baseline reference lines, plus W/D/L bars per opponent.
  - A generation picker and a replay viewer on the 3D board: play/pause, step, scrub (scrubbing snaps), speed, and an eval bar.
  - A live "gen A vs gen B" match in the worker.
  - An empty state for before training has run.

## Execution: all orchestrated with workflows
**Phase 0, lead only, sequential:**
1. Scaffold the configs, `docs/design`, and the contracts (`types.ts`, `formats.ts`, `protocol.ts`).
2. Write a real `bitboard.ts` and `position.ts`, plus stubs elsewhere and a placeholder manifest.
3. Run `npm install` and `npx playwright install chromium`.
4. `git init`, then `gh repo create DuaneShaffer/checkers --public`.
5. Enable Pages with `gh api -X POST repos/DuaneShaffer/checkers/pages -f build_type=workflow`, then push and deploy the placeholder.
6. Accept when `curl -I https://duaneshaffer.github.io/checkers/` returns 200.

**Phase 1, implementation workflow:**
- Parallel write-capable agents, each owning a disjoint set of files. Only the lead edits `package.json`, configs and contracts, and runs `npm install` and git commits.
- Units and their acceptance criteria are in critique.md §9, adjusted for serverless P2P:

  | Unit | Area | Notes |
  |---|---|---|
  | U1 | Engine | Critical path. Perft 1–8 by default, 9–11 with `PERFT_DEEP`, plus rule cases. |
  | U2 | AI | |
  | U3 | Trainer | Includes the smoke run, then export, then the assets test. |
  | U4 | Scene | Includes the orientation test: single corner and double corner on the correct sides. |
  | U5 | Shell, UI, game drivers | |
  | U6 | Online | `signal.ts` round-trip, a 500-seed loopback fault simulation, and a Playwright two-context test of the full invite/reply handshake on localhost. No server needed. |
  | U7 | Training Lab | Built from fixtures. |

- **Order:** start U1, U4, U5, U6 (pure parts) and U7 together. U2 follows U1, and U3 follows U2.
- Each unit's agent runs its tests until they pass. An adversarial review stage per unit checks that unit's work against the rules and contracts.

**Training kickoff, as soon as U3 passes:**
1. `npm run bench` and a pilot run of ≤ 60 min.
2. **Gate:** at least 15 self-play games/s, at least 95% wins against Random, and results against Heur-d4 improving. If the gate misses, cut the network to hidden size 32 or self-play depth to 3.
3. Launch the overnight run in the background (`run_in_background`) with `--publish-every 10`, while integration continues.

**Optional laptop training host** (the user's laptop is about 4 years newer):
1. Once U3 passes, push the repo. On the laptop, run `git clone`, then `npm ci`, then `npm run bench`.
2. Run the overnight training on whichever machine benchmarks faster. Keep the laptop plugged in with sleep disabled, and watch for thermal throttling.
3. The run directory stays on that machine. Only the `npm run export` output (`public/training/`) gets committed and pushed back.
4. **Don't develop code on two machines at once.** All code changes happen in this session.

**Phase 2, integration, visual polish and review workflow:**
- Wire the AI into the UI and the Lab into the interim exports.
- Polish visuals by taking Playwright MCP screenshots at 360×640, 390×844, 844×390 and 1440×900 and iterating.
- Run a multi-lens adversarial code review: rules correctness, P2P robustness, mobile UX, performance and bundle size, assets budget.

**Phase 3, after training:**
1. `npm run export` and the full test suite.
2. Commit `public/training`, push, and confirm the deploy.
3. Hand off to the user for a real-device test: phone vs desktop over the reply-link flow.

## Verification
- **Unit tests (`npm test`):**
  - Engine: perft, rule edge cases (promotion ends a capture, king loop captures, no double-jumping a piece, mandatory capture, draw rules), and notation/FEN round-trips.
  - Hashing: incremental hash equals a full recompute.
  - AI: flip symmetry, CKN1 round-trip, tactical searches, TT on/off equivalence.
  - Trainer: λ-target hand cases, a gradient check, Elo fit.
  - Online: `signal` round-trip, reconcile, session simulation.
  - Other: assets test, purity test.
- **Build checks:** `npm run typecheck`, `npm run build`, `npm run train:smoke`, then `npm run export`.
- **E2E** (`npm run e2e`, Chromium with `--use-angle=swiftshader --disable-features=WebRtcHideLocalIpsWithMdns`):
  - smoke, layout (no overflow, targets ≥ 44 px) at phone and desktop viewports.
  - Local play, play vs AI and the Lab replay.
  - Online across two contexts: invite, reply, moves, guest reload with resume handshake, resign/draw/rematch.
- **Visual:** check screenshots of each screen at four viewports with the Playwright MCP.
- **Live site:** `curl` the Pages URL, `manifest.json` and one net `.bin` after deploy, plus a quick Playwright run against the live URL.
- **Manual:** the user plays phone vs desktop over the link handshake.
