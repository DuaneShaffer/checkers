# 3D frontend, UX (mobile + desktop), and the Training Lab replay viewer

## Decisions
- Use three r186 WebGLRenderer (WebGL2), not WebGPURenderer: smaller, mature, works with addons, and mobile Safari WebGPU is still uneven.
- Use PCFShadowMap with shadow.radius, because r186 removed PCFSoftShadowMap (verified in the r186 source).
- Use NeutralToneMapping so the crimson and ivory piece colors render accurately; AgX/ACES desaturate or shift hue.
- Render on demand and only update the shadow map while pieces animate. This saves mobile battery, and the light is fixed in world space so orbiting never invalidates shadows.
- Keep one full-screen transparent canvas behind the UI. Each layout's CSS grid has an empty .board-slot element, and the camera frames the board into it with setViewOffset. CSS owns the layout; the camera only adapts.
- Pick squares with ray/plane math instead of mesh raycasts. It's deterministic and unit-testable, and the same math gives clientOfSquare for keyboard and e2e tests.
- Arbitrate gestures with a capture-phase pointerdown on the canvas parent that disables OrbitControls whenever the touch starts on an actionable square. This solves the tap-vs-orbit conflict on phones.
- Multi-jump selection is a pure state machine over legal-move path prefixes with auto-advance when unambiguous. Nothing commits until the full path is chosen, so network and AI moves stay atomic.
- Make the piece-rim reeding a canvas normal map instead of geometry, which keeps the lathe at 64 segments and the vertex count low.
- Captured pieces fly to rail trays instead of fading out. It avoids transparency sorting, looks physical, and supplies the pieces used for traditional crowning.
- Generate all textures procedurally on canvas, with fonts self-hosted through Fontsource. No external art assets and no third-party CDN requests.
- Hand-roll the SVG Elo chart and W/D/L bars instead of using uPlot. The needs are small and the chart is easier to style and make accessible.
- Use hash routes for every screen so GitHub Pages never returns a 404 and replay plies can be deep-linked.
- Load PeerJS, QR and Lab code as lazy chunks, and give three its own long-cache chunk through Vite 8 rolldownOptions.output.codeSplitting.
- Stepping forward in a replay animates; scrubbing, stepping back or jumping snaps through piece-id snapshot syncs, so seeking is fast and correct.
- Use Crimson vs Ivory on walnut/maple with brass accents, and Fraunces + Geist + Geist Mono type, for a premium dark 'Midnight Parlor' look.
- Use three quality tiers with an initial heuristic and a frame-time governor that steps down DPR, then shadows, then materials. Antialias can only change at context creation, so it applies on the next load.

## Risks
- On mobile, one-finger orbit vs tap/drag on pieces can still feel ambiguous near piece edges. Mitigations are an 8 px slop, a recenter button, and possibly making one-finger orbit opt-in on very small screens if testing shows mis-hits.
- iOS Safari: WebAudio must be unlocked by a gesture, navigator.vibrate is missing, dvh and safe-area quirks exist, backdrop-filter is costly, and WebGL memory is limited on old iPhones.
- Headless WebGL screenshots (SwiftShader) can differ slightly from run to run. Keep canvas thresholds lenient, generate baselines only on the CI Linux runner, and lean on DOM assertions and the test hooks.
- Thin pieces on a board can show shadow acne or peter-panning; bias/normalBias need tuning per tier.
- Procedural wood and lacquer can look 'CG' without iteration. Budget time for visual polish passes with screenshots at both viewports.
- Training artifacts (per-gen weights plus sampled games) can bloat the repo and the Pages deploy. Only export weights for milestone generations and cap sampled games per generation.
- TypeScript 7 (native port) is new and some tooling may expect the TS 5/6 JS API. Pin 6.0.x if anything breaks.
- Vite 8 on Rolldown renamed its chunking options (rollupOptions to rolldownOptions, manualChunks to codeSplitting). Older blog examples will mislead.
- Project files live on /mnt/c under WSL2, so Vite file watching may miss edits made from Windows and I/O is slow. Polling may be needed.
- Live gen-vs-gen and AI play depend on the AI area's worker protocol and weight format landing as specified. Ship a random-move stub so the frontend isn't blocked.

## Interfaces

// ===== Engine (owned by engine area; frontend consumes) =====
type Side = 0 | 1;                 // 0 = first mover = PDN squares 1..12 at start; UI renders as Crimson. 1 = Ivory.
type Sq = number;                  // 0..31 ; PDN number = sq + 1
interface Move { from: Sq; path: Sq[]; captures: Sq[]; promotes: boolean }  // path = landing squares in order; path uniquely identifies a move
interface PieceInfo { side: Side; king: boolean }
// position is opaque to frontend apart from these:
sqToRowCol(sq: Sq): [row: number, col: number]   // row = floor(sq/4) (row 0 = side 0 home edge); col = 2*(sq%4) + (row % 2 === 0 ? 1 : 0)
initialPosition(): Position; sideToMove(p): Side; pieceAt(p, sq): PieceInfo | null;
legalMoves(p): Move[];  applyMove(p, m): Position;
toFen(p): string; fromFen(s): Position;              // PDN FEN e.g. "B:W21,...:B1,..."
moveToPdn(m): string;  pdnToMove(p, s): Move | null;   // "11-15", "22x15x8" (full hop path)
class Game { position; moves: Move[]; play(m): void; undo(): Move | undefined; legalMoves(): Move[]; status(): GameStatus }
type EndReason = 'no-moves'|'no-pieces'|'draw-40'|'repetition'|'max-plies'|'resign'|'disconnect'|'agreement';
type GameStatus = { over: false } | { over: true; winner: Side | null; reason: EndReason };

// ===== AI worker protocol (owned by AI area; frontend wraps in src/ai/aiClient.ts) =====
type AiRequest =
  | { type: 'load'; netId: string; url: string }                         // weights URL under BASE_URL
  | { type: 'think'; id: number; netId: string; fen: string; history: string[]; level?: 1|2|3|4|5; timeMs?: number; depth?: number }
  | { type: 'cancel'; id: number };
type AiResponse =
  | { type: 'loaded'; netId: string }
  | { type: 'move'; id: number; move: string; eval: number /* side-to-move win prob 0..1 */; depth: number; nodes: number; pv: string[] }
  | { type: 'error'; id?: number; message: string };
// worker created with: new Worker(new URL('../ai/ai.worker.ts', import.meta.url), { type: 'module' })

// ===== Training artifacts (owned by trainer; served from public/training/, read by src/lab/data.ts) =====
interface TrainingManifest {
  version: 1; runId: string; updatedAt: string;
  ratingAnchor: string;                                   // e.g. "random=0"
  baselines: { id: string; name: string; elo: number }[];
  generations: GenerationSummary[];                       // ascending gen
}
interface GenerationSummary {
  gen: number; trainedGames: number; trainedAt: string;
  elo: number; eloLo?: number; eloHi?: number;
  bench?: Record<string, { w: number; d: number; l: number }>;   // keyed by baseline id or 'prev'
  weights?: string;                                       // relative path, present only for milestone gens
  games: string; gameCount: number;                       // relative path to GameRecord[] JSON
}
type PlayerTag = { kind: 'gen'; gen: number } | { kind: 'baseline'; id: string } | { kind: 'human'; name?: string };
interface GameRecord {
  id: string; kind: 'selfplay' | 'bench' | 'live' | 'human';
  players: [PlayerTag, PlayerTag];                        // index = Side
  startFen?: string;
  moves: string[];                                        // PDN with full hop path
  evals?: number[];                                       // per ply after the move, side-0 win prob 0..1 (2-decimal)
  winner: Side | null; reason: EndReason;
}

// ===== Net session (owned by network area; consumed by src/ui/lobby.ts + RemotePlayer) =====
createHostSession(opts: { side: Side | 'random' }): Promise<{ session: NetSession; link: string }>; // link = origin + BASE_URL + '#/join/' + peerId
joinSession(peerId: string): Promise<NetSession>;
interface NetSession {
  role: 'host' | 'guest'; mySide: Side;
  on(ev: 'ready'|'move'|'resign'|'drawOffer'|'drawReply'|'rematch'|'peerLeft'|'peerBack'|'error', cb: (payload?: any) => void): () => void;
  sendMove(pdn: string, ply: number): void; resign(): void; offerDraw(): void; replyDraw(ok: boolean): void; requestRematch(): void; close(): void;
}

// ===== Frontend-internal contracts shared by game + lab =====
type PieceIds = Int16Array;   // length 32, piece id per square or -1 (from pieceTracker)
interface Highlights { movable?: Sq[]; targets?: Sq[]; captureTargets?: Sq[]; pending?: Sq[]; lastMove?: [Sq, Sq] | null; cursor?: Sq | null; selected?: Sq | null }
interface BoardView {
  setPosition(pos: Position, ids?: PieceIds): void;
  sync(pos: Position, ids: PieceIds, opts?: { duration?: number }): Promise<void>;
  playMove(move: Move, opts?: { speed?: number; fromHop?: number }): Promise<void>;
  previewHop(from: Sq, to: Sq, captured: Sq | null): Promise<void>; cancelPreview(): void;
  setHighlights(h: Highlights): void;
  setOrientation(side: Side, animate: boolean): Promise<void>;
  squareAtClient(x: number, y: number): Sq | null; clientOfSquare(sq: Sq): { x: number; y: number };
}
interface Player { kind: 'human' | 'ai' | 'remote'; requestMove(game: Game, signal: AbortSignal): Promise<Move>; dispose(): void }
// test hook (only with ?test=1): window.__checkers = { ready: Promise<void>, clientOfSquare(sq), fen(): string, route(): string }

## Design

# Frontend / 3D / UX / Training Lab design

## 0. Versions (checked on the npm registry on 2026-10-19)
| package | version | notes |
|---|---|---|
| three | **0.186.1** (r186, 2026-09-24) | `@types/three` 0.186.0. Use `WebGLRenderer` (WebGL2), not WebGPU. **r186 removed `PCFSoftShadowMap`** (it now warns and falls back). Use `PCFShadowMap` + `light.shadow.radius`, which r186 implements as a Vogel-disk soft filter. `RoomEnvironment()` takes no constructor args. Addons are imported from `three/addons/...` |
| vite | **8.3.4** | Built on Rolldown 1.2. `build.rollupOptions` is deprecated, so use `build.rolldownOptions`. `manualChunks` is deprecated, so use `output.codeSplitting.groups`. Needs Node ≥22.12 (we have 24.13) |
| typescript | **7.0.2** (native port) | Only for `tsc --noEmit` typechecks, because Vite transpiles itself. Fall back to 6.0.3 if any tool needs the old JS API |
| vitest | 5.0.5 | |
| @playwright/test | 1.64.1 | |
| peerjs | 1.5.5 | Lazy chunk, friend routes only |
| uqr | 0.1.3 | ~4 KB SVG QR code for the share link |
| @fontsource-variable/fraunces, /geist, /geist-mono | 5.3.0 | Self-hosted fonts, no Google CDN request |
No chart library. A hand-rolled SVG chart covers the needs at about 3 KB. uPlot (1.6.32) isn't worth a dependency here.

## 1. Visual direction: "Midnight Parlor"
- Mood: a lacquered walnut board under one warm lamp in a dark room. The UI is quiet glass panels with brass accents. The 3D board is the hero and stays visible behind the menus.
- Board: walnut frame with a chamfered bevel and a thin brass inlay line around the field. Playing (dark) squares are stained walnut `#4a2c1a`, light squares are maple `#d6b98c`. Grain is procedural.
- Pieces: **Crimson** lacquer `#a3161f` and **Ivory** `#ece2cb`. Both use clearcoat. The rim has vertical reeding, and the top face has concentric grooves. Kings are two stacked pieces with a gold crown emblem on top. Crimson moves first (side 0).
- UI tokens (`styles/tokens.css`):
  `--bg-0:#0c0b0a; --bg-1:#141210; --surface:rgba(26,23,20,.72); --surface-solid:#1b1815; --line:rgba(255,240,220,.08); --text:#f3ede2; --text-2:#b5aa99; --text-3:#7d7466; --brass:#c9a45c; --brass-hi:#e6c787; --crimson:#d0454c; --ivory:#efe6d3; --ok:#5fb3a1; --danger:#e0604f; --r-sm:10px; --r-md:14px; --r-lg:22px;`
  The backdrop is a CSS radial gradient (warm `#2a1e14` at 30% opacity toward the board center, fading to `--bg-0`). The canvas is transparent (`alpha:true`), so CSS owns the room.
- Type: **Fraunces** variable (display, opsz high, weight 600, SOFT 50) for titles and results. **Geist** for UI at 400/500/600. **Geist Mono** with tabular numbers for move lists, Elo and ply counters. Sizes are fluid with `clamp()`. Only the latin subset is imported.
- Highlights are told apart by shape as well as color, so they work for color-blind users:
  - Movable pieces get a brass halo ring.
  - Quiet-move targets get a brass dot.
  - Capture targets get a crimson-orange ring.
  - The last move gets a soft warm tint on its from/to squares.
  - The keyboard cursor is a white square outline.

## 2. Module layout (`src/`)
```
index.html                 viewport-fit=cover, theme-color, <canvas> host, #ui root, aria-live regions
vite.config.ts             base '/checkers/', target es2022, worker.format 'es', codeSplitting group 'three'
src/main.ts                boot: settings → Stage → router → fonts; ?test mode hooks
src/app/router.ts          hash router: parse/format routes, route change events (pure, unit-tested)
src/app/store.ts           tiny typed event emitter + app state (current screen, modal)
src/app/settings.ts        localStorage 'checkers.settings.v1' (sound, haptics, quality, autoRotateLocal, coords)
src/app/persist.ts         saved in-progress game (vs AI / local) for "Resume"
src/scene/stage.ts         WebGLRenderer, scene, camera, on-demand loop, resize, context-loss, quality tier apply
src/scene/environment.ts   PMREM(RoomEnvironment), key light + shadow, rim light, contact-shadow quad
src/scene/textures.ts      procedural CanvasTextures: board field (squares+grain+inlay), frame wood, piece reeding normal map, blob shadow
src/scene/boardModel.ts    frame (RoundedBoxGeometry), field plane, captured trays; coord <-> world helpers
src/scene/pieceModel.ts    LatheGeometry profile, crown ExtrudeGeometry, materials per tier
src/scene/pieces.ts        PieceViews: Map<pieceId, Mesh>, sync(snapshot), tray placement, king stacking
src/scene/highlights.ts    one InstancedMesh (32 instances x kinds) for rings/dots/tints/cursor
src/scene/tween.ts         tiny tween engine (easing, promises, global speed, finishAll)
src/scene/moveAnimator.ts  hop/slide/capture-to-tray/promotion sequences (async)
src/scene/cameraRig.ts     OrbitControls config, fit-to-rect math, orientation flips, attract orbit
src/scene/picking.ts       pointer → square via ray/plane math, tap vs drag vs orbit arbitration
src/scene/quality.ts       tier table, initial heuristic, frame-time governor
src/scene/boardView.ts     facade used by game + lab (API in Interfaces)
src/game/pieceTracker.ts   stable piece ids across moves (pure)
src/game/selection.ts      selection/multi-jump state machine (pure)
src/game/controller.ts     GameController: players loop, history, undo, status, persistence
src/game/players.ts        HumanPlayer, AiPlayer, RemotePlayer, (ReplayDriver lives in lab)
src/game/keyboard.ts       cursor movement relative to orientation, Enter/Space/Esc/U/F
src/game/announcer.ts      aria-live text formatting (pure formatting + DOM sink)
src/audio/sfx.ts           WebAudio synth: tap, clack, capture, crown chime, select, illegal, win, lose
src/audio/haptics.ts       navigator.vibrate patterns, feature-detected
src/ai/aiClient.ts         promise wrapper over the AI area's worker (min think display time)
src/ui/dom.ts              h() element helper, icon set (inline SVG strings)
src/ui/home.ts             menu cards, difficulty, side picker, resume, settings sheet
src/ui/hud.ts              player chips, turn/thinking, capture counts, actions, move list sheet
src/ui/lobby.ts            friend: create link / share / QR / waiting / joining / disconnect banner
src/ui/modal.ts            <dialog> wrapper: game over, confirm resign, draw offer
src/ui/toast.ts            transient notices ("Capture is mandatory")
src/ui/miniBoard.ts        SVG 8x8 thumbnail renderer (lab cards, a11y fallback)
src/lab/data.ts            fetch manifest/games/weights under BASE_URL + 'training/'; cache
src/lab/labView.ts         overview layout: chart + gen picker + gen details + game list
src/lab/eloChart.ts        SVG line+band chart, baselines, crosshair, keyboard select
src/lab/wdlBars.ts         per-gen W/D/L vs benchmark bars
src/lab/replayTimeline.ts  precomputed positions/snapshots/evals per ply (pure)
src/lab/replayView.ts      transport dock, scrubber w/ eval sparkline, speed, move list
src/lab/liveMatch.ts       gen A vs gen B driver using AI worker(s), series score
src/styles/{tokens,base,layout,home,hud,lab,lobby}.css
tests/unit/*.test.ts       vitest (selection, router, cameraFit, pieceTracker, replayTimeline, keyboard)
tests/e2e/*.spec.ts        playwright smoke + visual
tests/fixtures/training/   tiny manifest + 3 gens of games for lab tests
playwright.config.ts
```
The engine code (`src/engine/*`), the AI worker, and `src/net/*` belong to the other areas. The frontend imports only the interfaces listed below.

## 3. Scene and stage
- Units: 1 world unit = 1 square. The field is centered at the origin and the board top is at y=0. Square `sq` → (row, col) via the engine's `sqToRowCol`, then world `x = col - 3.5`, `z = row - 3.5`. Row 0 (side 0's home, PDN 1–4) is at −z.
- Renderer settings:
  - `new WebGLRenderer({ antialias, alpha:true, powerPreference:'high-performance', preserveDrawingBuffer: testMode })`
  - `toneMapping = NeutralToneMapping` (Khronos PBR Neutral keeps the crimson accurate), `toneMappingExposure 1.0`
  - Default sRGB output; every CanvasTexture gets `colorSpace = SRGBColorSpace` except the normal and roughness maps
- Environment: `scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture` with `scene.environmentIntensity ≈ 0.55`. No background.
- Lights:
  - Key light: a warm `DirectionalLight` (`#ffe6c7`, ~2.4), placed high and slightly to the side. It casts shadows into a tight orthographic frustum (±5.2) around the board, with `shadow.bias -0.0005`, `normalBias 0.02` and `radius 4`.
  - Rim light: a cool `DirectionalLight` (`#9db4ff`, 0.35) with no shadow.
  - The lights are fixed in world space, so orbiting never invalidates the shadow map. That allows **`renderer.shadowMap.autoUpdate = false`**, with `needsUpdate = true` set only while pieces animate.
- Board:
  - Frame: `RoundedBoxGeometry(9.5, 0.55, 9.5, 4, 0.14)` with its top at y=0. The walnut map comes from a 1024² canvas (stretched-noise strokes) plus a matching roughness map.
  - Field: a 8.6×8.6 `PlaneGeometry` at y=0.002 with one 2048² canvas (1024² on mobile). The canvas holds the squares, grain, the brass inlay line and optional coordinates. That's one draw call.
  - Underside: a contact-shadow quad below the board (radial gradient texture, MeshBasic, transparent).
  - Captured trays: recessed strips on the frame's left and right rails, at x=±4.45. Pieces stack in 2 columns of 6.
- Pieces:
  - A 64-segment `LatheGeometry` (32 on the low tier) with R=0.40 and H=0.13. The profile has rounded bottom and top edges, a straight sidewall, a top rim step and two shallow concentric grooves.
  - Reeding is a canvas **normal map** (vertical stripes, masked to the sidewall band through the lathe's v coordinate) instead of extra vertices.
  - Material: `MeshPhysicalMaterial` with clearcoat 0.7, clearcoatRoughness 0.22, roughness 0.42. The low tier uses `MeshStandardMaterial`.
  - Geometry and materials are shared, and each piece is its own Mesh (simple per-piece animation, ≤24 + ≤12 king tops).
  - Crown: a 5-point `Shape` → `ExtrudeGeometry` (depth 0.015, small bevel) in gold (metalness 1, roughness 0.28), parented to the top piece.
- On-demand rendering: `setAnimationLoop(tick)` renders only when one of these holds: `dirty`, an active tween, OrbitControls damping (`controls.update()` returns true), or attract mode is on. The loop stops on `document.hidden` and while Lab screens hide the board.
- Resizing: a `ResizeObserver` on the host calls `renderer.setSize(w,h,false)` and `setPixelRatio(min(devicePixelRatio, tier.dprCap))`, then re-runs camera fitting.
- Context loss: on `webglcontextlost`, call `preventDefault` and show a toast. On `restored`, rebuild Stage resources (textures are regenerated from deterministic seeds).
- If WebGL2 is unavailable, show a message and offer the SVG miniBoard as a playable 2D fallback (stretch goal).

## 4. Camera rig and layout coupling (the "board-slot" idea)
- The canvas is `position:fixed; inset:0` under the UI layer. Every screen's CSS grid includes an empty **`.board-slot`** element where the board should appear. Stage watches that element's rect (ResizeObserver plus `resize`/`orientationchange`) and frames the board into it. Only the camera moves; the canvas never resizes per layout.
- Fitting (`cameraRig.fitToRect`, pure math, unit-tested):
  1. Pick the polar angle by aspect: slot aspect < 0.8 (portrait) → 24° from vertical; 0.8–1.3 → 32°; landscape → 40°.
  2. Binary-search the distance so all 8 frame corners plus the tray extents project inside the slot rect with 4% padding.
  3. Use `camera.setViewOffset(fullW, fullH, offX, offY, fullW, fullH)` to shift the projection center onto the slot's center.
- Camera: `PerspectiveCamera` with fov 32 (low distortion).
- OrbitControls:
  - `enablePan=false`, `enableDamping=true` (0.08)
  - `minPolarAngle 0.12`, `maxPolarAngle 1.08`
  - Azimuth limited to ±0.6 rad around the home azimuth of the current orientation
  - `minDistance = 0.75·fit`, `maxDistance = 1.5·fit`
  - `touches = { ONE: ROTATE, TWO: DOLLY_ROTATE }`
  - A "recenter" button (and double-tap on empty space) tweens back to the fitted pose.
- Orientation: the human's side is always nearest the camera. Flipping (HUD button / `F` key) tweens the azimuth by π over 700 ms (instant with reduced motion), temporarily lifting the azimuth limits.
- Turn-based auto-rotate: in pass-and-play only, on by default, and only once the move animation has finished.
- Attract mode on Home: a slow orbit at 4°/s while a featured self-play game from the latest generation plays at 0.6×. It's disabled for reduced motion and on the low tier.

## 5. Interaction
- **Picking without mesh raycasts** (`picking.ts`, pure math):
  1. Build a `Raycaster` from the pointer.
  2. Intersect the plane y = 0.10 (piece tops). If that hits a square with a piece, use it.
  3. Otherwise intersect y = 0 → `floor(x+4)`, `floor(z+4)` → (row, col) → dark square or null.
  The same math backs `clientOfSquare()` for keyboard focus rings and e2e tests.
- **Gesture arbitration:** a `pointerdown` listener in the **capture phase on the canvas parent** runs before OrbitControls' canvas listener.
  - If the hit square is actionable (a movable piece, a target, or a piece mid-sequence), it sets `controls.enabled=false` until `pointerup`/`pointercancel`. Otherwise the gesture belongs to the orbit.
  - Tap = moved < 8 px and < 400 ms.
  - A second pointer arriving cancels any drag and hands the gesture to the orbit.
  - The canvas has `touch-action:none`.
- **Drag (optional; tap always works):** once movement passes 8 px on a movable piece, the piece lifts to y=0.35 and follows the y=0.35 plane intersection. The target under the pointer gets an enlarged ring. Release on a valid next-landing square → advance or commit. Release anywhere else → 180 ms spring back.
- **Selection state machine** (`selection.ts`, pure). State is `idle`, or `selected { from, prefix: Sq[], candidates: Move[] }`.
  - Movable pieces = the distinct `from` values of `legalMoves` (the engine already enforces mandatory capture). When a capture is forced, the HUD shows a "Capture required" chip and the announcer says so once.
  - Targets = the distinct `path[prefix.length]` values among candidates.
  - Tapping a target appends it to the prefix and filters candidates. **Auto-advance** continues while every remaining candidate shares the next landing. It commits once exactly one candidate remains and its path is complete.
  - Mid-sequence, the piece visibly hops to each intermediate landing (preview), and jumped pieces are tinted "pending" (dark red emissive, shared material). Esc, the Cancel chip, or a tap on the moving piece reverts the preview. Nothing is committed until the full path is chosen.
  - With an empty prefix, tapping a different movable piece switches the selection. Tapping an illegal square gives a soft "illegal" sound, a short shake of the selected piece, and a toast if a capture is mandatory.
  - The engine guarantees that moves are uniquely identified by their landing path in American rules.
- **Keyboard (desktop):**
  - The canvas host has `tabindex=0`, `role="application"` and an aria-label.
  - Arrow keys move a cursor over the 32 dark squares diagonally in screen space, mapped through the current orientation: Up+Left/Up+Right via arrows, or plain arrows step to the nearest dark square in that direction.
  - Enter/Space selects or confirms, Esc cancels, U undoes, F flips, R recenters, M mutes, and `[`/`]` step during replays.

## 6. Animation (`tween.ts`, `moveAnimator.ts`)
- The tween engine is driven by Stage's clock. It has a global `speed` (replay speed; reduced motion uses 4× plus no arcs). `finishAll()` snaps everything to the end state when scrubbing or when a new move arrives.
- Quiet move: arc lift of 0.22, 260 ms easeInOutCubic. Landing plays the "tap" sound plus a 90 ms squash (scaleY 0.92 → 1).
- Jump: each hop is a 320 ms parabola with height 0.55. At the apex the jumped piece shakes for 80 ms. Each landing plays a "clack", with pitch rising 8% per hop.
- After the final landing, captured pieces fly to the capturer's tray in a 420 ms arc, staggered 70 ms apart. There's no transparency anywhere, which avoids sorting problems.
- Promotion: one of the owner's previously captured pieces flies from the opponent's tray onto the man (traditional crowning). If there is none, a new piece drops from y=1.2 with easeOutBounce over 380 ms. Then a crown flash (emissive pulse, 600 ms), the chime, and a haptic.
- The game ends after a 500 ms beat, then the modal opens.
- Shadow map `needsUpdate` is set every frame while any piece tween runs.

## 7. Sound and haptics
- `sfx.ts` creates its `AudioContext` lazily on the first user gesture (iOS unlock) and routes through a master `GainNode` controlled by the mute setting.
  - tap = 25 ms white-noise burst → bandpass 1.9 kHz (Q 5), exponential decay 70 ms + sine 180 Hz for 40 ms
  - clack = tap ×1.4 gain + bandpass 1.2 kHz
  - crown = sines at 880 and 1320 Hz, 3 cents detuned, 1.1 s decay, light feedback delay
  - select = sine tick at 1.6 kHz, 30 ms
  - illegal = 110 Hz square → lowpass 600 Hz, 120 ms
  - win = rising major arpeggio; lose = falling minor third
- `haptics.ts`: select 8, move 15, capture [25,35,25], crown [15,30,15,30,60], illegal [40]. It's a no-op when `navigator.vibrate` is missing (iOS) or the setting is off.

## 8. Screens and router (hash routing works on GitHub Pages with no 404s)
```
#/                       Home (attract board behind)
#/play/ai?level=1..5&side=0|1|r&gen=N      vs AI (gen optional: "play this generation" from Lab)
#/play/local             pass-and-play
#/play/friend?side=0|1|r host lobby → game
#/join/:peerId           guest → game
#/lab                    overview
#/lab/g/:gen             generation detail
#/lab/g/:gen/:gameId?ply=n   replay
#/lab/live/:a/:b?ms=300  gen A vs gen B live
#/review                 review last finished game (uses replay view on an in-memory record)
```
- **Home:** title "Checkers" in Fraunces, with the line "An engine that taught itself". Cards:
  - **Play the AI**: segmented difficulty 1–5 (Novice, Casual, Club, Expert, Master) and a Crimson/Ivory/Random side picker.
  - **Play a friend**.
  - **Pass & play**.
  - **Training Lab**: an inline Elo sparkline plus "Gen 128".
  - **Resume** (when a saved game exists).
  - A settings gear opens a sheet: sound, haptics, quality (Auto/High/Medium/Low), auto-rotate in pass & play, show coordinates.
- **HUD:**
  - Player chips show a color swatch, a name ("You", "AI · Club", "Gen 40", "Friend") and a capture count.
  - The active chip has a brass underline that glides across, plus three animated dots while the AI is thinking.
  - Actions: Undo (vs AI = back to your previous turn, 2 plies; local = 1 ply; hidden for friend games), Flip, Recenter, Resign (confirm dialog), Offer draw (friend only), Sound.
  - Move list in PDN notation: a side panel on desktop, a pull-up sheet on portrait phones.
- **Friend lobby:**
  1. The host picks a side, then sees "Setting up table…".
  2. Then a card with the link `https://duaneshaffer.github.io/checkers/#/join/<peerId>`, **Share** (`navigator.share`) / **Copy** buttons, a uqr QR code, and a pulsing "Waiting for your friend…".
  3. The guest sees "Connecting…" then enters the game.
  - Disconnect: a banner "Opponent disconnected — waiting (0:45)" with a Leave button.
  - Rematch needs both players to accept, and colors swap.
- **Game over** (`<dialog>` with `showModal`, native focus trap): a Fraunces headline ("You win" / "Crimson wins" / "Draw"), a reason line (no moves, no pieces, 40-move rule, repetition, resignation, disconnect, agreement), stats (moves, captures, duration), and buttons **Rematch**, **Review game** (replay view), **Copy PDN**, **Home**.

## 9. Training Lab
- Data (`lab/data.ts`): fetches `import.meta.env.BASE_URL + 'training/manifest.json'` and then per-gen `games.json` lazily. Weights are fetched only for live mode or "play this gen". Formats are in Interfaces.
- Overview layout:
  - Desktop: a 2-column grid with the chart, W/D/L bars and gen timeline on the left, and the gen detail with its game list on the right.
  - Mobile: stacked, with a sticky gen picker.
  - The 3D stage is paused and hidden here.
- **Elo chart** (`eloChart.ts`, SVG):
  - The x axis is generation (with a toggle to "games trained"). The y axis is Elo with a CI band (`eloLo..eloHi`).
  - Baselines (random mover, greedy material, material αβ) are dashed horizontal reference lines with right-edge labels.
  - The crosshair snaps to the nearest gen and shows a tooltip. Clicking or tapping a point selects that gen and routes to `#/lab/g/:gen`.
  - The chart is focusable; ←/→ change the selected gen. Its size comes from a ResizeObserver plus `viewBox`.
  - Follow the dataviz skill guidance when implementing it.
- **W/D/L bars:** stacked horizontal bars per gen against each benchmark.
- **Gen picker:** a horizontally scrolling chip timeline with a range slider (mobile also gets a native `<select>`).
- **Gen detail:**
  - Header: the gen's Elo, games trained, timestamp, and its delta against the previous gen.
  - Buttons: **Play vs this gen**, **Watch vs…**.
  - A list of sampled games as cards. Each card shows a miniBoard SVG of the final position, players, result, ply count, end reason and an opening tag (first 3 moves). Filters: All, Decisive, Draws, plus Selfplay vs Bench.
- **Replay view** (board visible, dock at the bottom):
  - Transport: ⏮ ◀ ▶/❚❚ ▶ ⏭.
  - The **scrubber** sits over an eval sparkline (side-0 win probability per ply from `evals`) with capture and crown tick marks.
  - Speed: 0.5×, 1×, 2×, 4×. Ply readout "Ply 23 / 71 · 11-15".
  - Clickable move list.
  - Actions: **Next game**, **Play from here vs AI** (forks the position into `#/play/ai`).
  - Keys: Space, ←/→, Home/End.
- Replay mechanics: `replayTimeline.ts` precomputes `positions[]`, `snapshots[]` (piece-id arrays from `pieceTracker`) and evals.
  - Stepping forward one ply runs the full move animation.
  - Stepping back, scrubbing or jumping calls `pieces.sync(snapshot)`: pieces with the same id slide 120 ms, removed pieces go to the tray, new ones pop in. Autoplay waits 650 ms / speed between plies.
  - The `ply` query parameter keeps the position deep-linkable via `history.replaceState`, with no router churn.
- **Live gen A vs gen B** (`liveMatch.ts`):
  - Two gen selects (only gens that have weights) and a think time (100 ms to 2 s).
  - The worker(s) from the AI area load both nets and alternate `think` requests, and the main thread animates each move.
  - It runs a series of best-of-N games with colors swapped, showing a running W-D-L.
  - The scrubber allows rewinding through played plies. A "Follow live" toggle snaps back to the head.
  - Stretch: a "Quick series ×20" mode runs headless games across `navigator.hardwareConcurrency - 1` workers and shows only result bars.

## 10. Responsive CSS (no framework)
- `html,body{height:100%;overscroll-behavior:none}`, `.app{position:fixed;inset:0}`, `100dvh`, `env(safe-area-inset-*)` padding on every screen container.
- The UI layer uses `pointer-events:none` on layout containers and `auto` on controls, so touches in `.board-slot` reach the canvas.
- Layout modes:
  - **Portrait / phones (default):** `grid-template: "top" auto "board" 1fr "bottom" auto / 1fr`. The opponent chip is on top; your chip and an icon action bar are at the bottom.
  - **Landscape phones** (`(orientation:landscape) and (max-height:520px)`): `"left board right" / auto 1fr auto`. Chips sit in the left rail and actions in the right rail, with no text labels.
  - **Desktop/tablet** (`(min-width:900px) and (min-aspect-ratio:5/4)`): `"board side" / 1fr clamp(300px,26vw,380px)`. The side panel holds players, move list and actions.
- Touch targets: `min-height:44px; min-width:44px` everywhere, and 48 px for primary buttons under `(pointer:coarse)`. Buttons use `touch-action:manipulation` and `-webkit-tap-highlight-color:transparent`. Hover styles only apply under `(hover:hover)`.
- Glass panels use `backdrop-filter: blur(14px) saturate(1.2)`, with a solid `--surface-solid` fallback under `@supports not` and on the low tier (the `.tier-low` class).
- `prefers-reduced-motion: reduce` turns off CSS transitions, attract mode, arcs and camera tweens. `prefers-contrast: more` makes highlights thicker and opaque.

## 11. Performance budget and quality tiers
- Bundles (gzip):
  - Initial load (three ≈150 KB, app ≈40 KB, CSS ≈8 KB) at ≤ 230 KB JS, plus fonts at ≤ 70 KB woff2.
  - Lazy chunks: `lab` ≤ 25 KB, `friend` (peerjs + uqr) ≈ 45 KB, the AI worker owned by the AI area.
  - Three gets its own long-cache chunk via `rolldownOptions.output.codeSplitting.groups:[{name:'three',test:/node_modules[\\/]three/}]`.
- GPU: main pass ≤ 60 draw calls and the shadow pass ≤ 40, ≤ 120k triangles, ≤ 40 MB of textures. Procedural textures are generated once and take < 80 ms on a mid phone, done in `requestIdleCallback` after the first frame with a flat-color first paint.

| tier | DPR cap | antialias* | shadows | piece material | lathe segs | backdrop blur |
|---|---|---|---|---|---|---|
| high | 2 | on if DPR<2 | PCF 2048, radius 4 | Physical + clearcoat | 64 | on |
| medium | 1.5 | on if DPR<2 | PCF 1024, radius 3 | Physical + clearcoat | 48 | on |
| low | 1 | off | off → instanced blob-shadow quads | Standard | 32 | off |

\*The antialias flag only takes effect when the context is created, so tier changes apply it on the next load.
- Initial tier: desktop (`pointer:fine` and width ≥ 900) → high. Otherwise medium, or low when `deviceMemory ≤ 2` or `hardwareConcurrency ≤ 4`.
- Governor: it samples frame times only during continuous rendering. If the p90 exceeds 28 ms over 90 frames, it steps down one tier (DPR first, then shadows, then materials) and persists the result. It upgrades at most once per session, and only when the user chooses it.

## 12. Accessibility
- There are two `aria-live` regions:
  - **Polite**, for moves: "Crimson 11 to 15", "Ivory jumps 22 to 15 to 8, captures 2", "Crimson crowned on 3", "Your turn, capture required".
  - **Assertive**, for game over and disconnects.
- An off-screen "Legal moves" list (buttons such as "Jump 22 to 15 to 8") lets screen-reader users play the whole game without the canvas. It is focusable with a skip link.
- All controls are real `<button>` elements with labels. Dialogs are native `<dialog>`. Focus is visible (2 px brass outline). The color pair contrasts in luminance as well as hue.

## 13. Testing
- **Vitest (node env, pure modules):**
  - `selection.test.ts`: prefix filtering, auto-advance, branch points, cancel
  - `router.test.ts`
  - `cameraFit.test.ts`: corners land inside the slot for portrait, landscape and desktop aspects
  - `pieceTracker.test.ts`: ids survive jumps and promotion
  - `replayTimeline.test.ts`
  - `keyboard.test.ts`: cursor mapping under both orientations
  - `picking.test.ts`: ray/plane → square round-trips with `clientOfSquare`
- **Playwright** (`playwright.config.ts`):
  - `webServer: vite preview --base /checkers/`
  - Chromium launch args `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist` so WebGL works headless
  - Projects: `desktop` (Chromium 1440×900), `phone` (Pixel 7 portrait), `phone-landscape` (915×412), `iphone` (WebKit, iPhone 15; DOM assertions, canvas masked)
- `?test=1` mode:
  - Fixed seeds, DPR 1, `animations:'instant'`, attract mode off, `preserveDrawingBuffer`.
  - Exposes `window.__checkers = { ready: Promise<void>, clientOfSquare(sq), fen(), route() }` and sets `document.body.dataset.ready='1'`.
- Specs:
  - `home.spec` (screenshot per project)
  - `layout.spec` (every visible button ≥ 44×44, no horizontal overflow, board-slot not covered by controls)
  - `play-local.spec` (taps via `clientOfSquare`; checks the aria-live text and the FEN)
  - `play-ai.spec` (level 1 reply arrives)
  - `keyboard.spec` (desktop only)
  - `lab.spec` (fixtures via `page.route('**/training/**')`; the chart has N points; open a replay; step forward → the ply counter increments; screenshot)
  - `friend.spec` (tagged `@net`: two contexts against a local PeerServer from the network area; skipped by default in CI)
- Screenshot thresholds: `maxDiffPixelRatio` 0.01 for DOM-only and 0.03 for canvas. Baselines are generated on the Linux CI runner, which is the source of truth.

## 14. Implementation sequence
1. Scaffold: Vite + TS config with base `/checkers/`, tokens/base CSS, fonts, router, settings.
2. Stage, environment, textures, board model and piece model rendering the engine's initial position, plus camera fitting to `.board-slot` in all 3 layout modes.
3. pieceTracker, selection, picking and gesture arbitration, then local pass-and-play end to end (the engine API is needed here).
4. tween, moveAnimator, sfx and haptics, promotion and trays, reduced motion.
5. HUD, game-over modal, undo, persist/resume, announcer and keyboard, then Vitest and the first Playwright smoke run.
6. aiClient integration with difficulty levels and the "thinking" state once the AI worker exists. Ship a stub that plays random legal moves first.
7. Lobby UI wired to the network area's session API.
8. Lab: data loader against fixtures, chart, game list, replay view, then live match.
9. Quality governor, low-tier fallbacks, performance pass against the budget, final visual polish, GitHub Pages smoke test.
- WSL note: the project is on `/mnt/c`, and inotify may miss edits made from the Windows side. If HMR misses changes, set `server.watch.usePolling` (interval ~300 ms).

### Critical Files for Implementation
- /mnt/c/Users/dlshaffer/Documents/dlshaffer/checkers/src/scene/boardView.ts
- /mnt/c/Users/dlshaffer/Documents/dlshaffer/checkers/src/scene/stage.ts
- /mnt/c/Users/dlshaffer/Documents/dlshaffer/checkers/src/game/selection.ts
- /mnt/c/Users/dlshaffer/Documents/dlshaffer/checkers/src/game/controller.ts
- /mnt/c/Users/dlshaffer/Documents/dlshaffer/checkers/src/lab/replayView.ts

