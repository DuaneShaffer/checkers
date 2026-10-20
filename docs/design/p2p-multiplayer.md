> **OVERRIDDEN (see PLAN.md, 'Serverless P2P'):** the user rejected any third-party signaling server. No PeerJS, Trystero, peer server or TURN. Transport = raw RTCPeerConnection + DataChannel, signaled by a two-link handshake (invite link carries the compressed offer SDP, reply link carries the answer). Session/protocol/reconcile/persistence ideas below still apply.

# Live P2P multiplayer via invite link (static GitHub Pages, WebRTC)

## Decisions
- Use Trystero 0.26.0 (Nostr signaling, pinned exactly) instead of PeerJS 1.5.5 + 0.peerjs.com. Many independent relays mean no single point of failure, there is no 'unavailable-id' peer-ID reclaim problem on refresh, it is actively maintained, SDP is encrypted, and onJoinError reports TURN problems. It is still live P2P only. Flag this change to the user.
- Put the transport behind a Transport interface, so PeerJS, ws-relay or a test bridge can be swapped in without touching session logic.
- Optional Metered TURN via its browser-safe apiKey, baked in at build time from a GitHub repo variable. This rescues mobile and symmetric-NAT pairings while staying static-only. Checkers sends a few KB per game, so the free quota is effectively unlimited. Cloudflare TURN (1 TB free) is deferred because minting credentials needs a server or Worker.
- Hash routing #/play/<code>: no Pages 404 hacks, and the fragment is never sent to servers or in Referer headers.
- The 10-character Crockford base32 code (50 bits) is both the room ID and the SDP password. The link is the capability.
- Identity comes from a persistent per-browser clientId, not transport peer IDs. The first joiner claims the guest seat and later joiners get room-full. No spectators in v1.
- No authoritative server. Both peers validate with the shared engine. Results are derived locally, except resign (sender's own color only) and agreed draws (offer and accept at the same ply).
- Ply-indexed moves plus a full move-list sync on every (re)connect. Because the game is turn-based, divergence cannot happen legitimately; if it does, the host's list wins as tiebreak. Desync is detected with FNV-1a of the engine positionKey on every move and ping.
- Only the host sends `start` (first game and rematches), which avoids gameId races. Rematch swaps colors.
- Moves made while the opponent is offline are queued and delivered by sync. bye/disconnect never forfeits a game in v1.
- Use Web Locks so only one tab per room can play. The game is persisted to localStorage after every change, with an in-memory fallback.
- Keep session.ts a pure reducer with side effects in connection.ts, so a seeded fault-injection simulation over LoopbackTransport covers most reconnection logic in Vitest.
- E2E: a Playwright-bridged transport in two browser contexts for deterministic CI, plus a real-WebRTC suite against a local @trystero-p2p/ws-relay server, plus a nightly non-blocking smoke test against production on real Nostr relays.

## Risks
- The user's earlier choice was PeerJS. Switching to Trystero needs confirmation, though it still matches 'live P2P only'. The Transport interface keeps a PeerJS fallback cheap.
- Trystero breaks its API often (0.23 through 0.26 each had breaking changes, and the wire format changed in 0.26). Pin the exact version and keep all Trystero calls inside trysteroTransport.ts. Both peers must run the same build, which the proto/app check covers.
- Public Nostr relays can rate-limit, drop out or prune. Mitigations: relay redundancy, Trystero's backoff, the nightly smoke test, and switching to the MQTT or torrent strategies by changing one import.
- Without TURN, a real minority of pairings (mobile CGNAT, symmetric NAT, school/corporate Wi-Fi) will fail ICE. Clear onJoinError messaging helps, but only TURN fixes it. Metered's free quota numbers conflict (20 GB vs 500 MB), so check when signing up.
- Whether 0.26 exposes relay-socket state (to detect 'signaling unreachable') is unverified. If it doesn't, fall back to a heuristic timeout with softer copy.
- The ws-relay README shows wss:// URLs. A local CI relay may need ws:// to be accepted, or a self-signed cert plus Playwright ignoreHTTPSErrors. Verify when implementing. On localhost, Chromium's mDNS candidate obfuscation may need the --disable-features=WebRtcHideLocalIpsWithMdns flag.
- If the host clears storage or switches devices, they cannot reclaim the host seat (the stored guest record will not match). Accepted v1 limitation, with a clear message.
- Both players must be online at the same time, by design: no async fallback. The guest copy has to explain 'your friend needs this page open'.
- WebRTC exposes IP addresses to the opponent. Disclose this in an 'About online play' note.
- Mobile browsers suspend background tabs. Reconnect after visibilitychange takes a few seconds, and the UI must not look broken during that time.

## Interfaces

Needed from the RULES ENGINE (shared src/engine), all deterministic and identical on both peers:
```ts
type Color = 'dark' | 'light'            // naming to be fixed by engine area; dark moves first
initialState(): GameState
legalMoves(s: GameState): Move[]
applyMove(s: GameState, m: Move): GameState
moveToString(m: Move): string           // standard 1-32 notation: "11-15", "15x24x31"
parseMove(s: GameState, str: string): Move | null   // match against legalMoves
sideToMove(s: GameState): Color
outcome(s: GameState): { winner: Color | null; reason: 'no-moves' | 'draw-rule' } | null
positionKey(s: GameState): string        // canonical incl. side to move; used for hash + repetition
replay(moves: string[]): { state: GameState; ok: boolean; failedAt?: number }
```

GameDriver, shared by the game screen for vs-AI, online, and possibly replay viewing:
```ts
interface DriverSnapshot {
  state: GameState; moves: string[]; lastMove?: string;
  myColors: Color[];                       // colors the local user may move ([] for spectating/replay)
  result?: GameResult;
  online?: { status: ConnStatus; rttMs?: number; peerName?: string; myRole: Role;
             incomingOffer?: OfferKind; outgoingOffer?: OfferKind; error?: OnlineError };
}
interface GameDriver {
  subscribe(fn: (s: DriverSnapshot) => void): () => void;
  submitMove(move: string): boolean;       // board UI emits notation; driver validates
  resign(): void;
  offer?(kind: OfferKind): void; answer?(kind: OfferKind, accept: boolean): void;
  dispose(): void;
}
```
The board/3D area should give: `setPosition(state)`, `animateMove(state, move)`, `setOrientation(color)`, `setInteractive(colors)`, and an `onMoveIntent(move: string)` callback.

Router (src/app/router.ts): routes `#/`, `#/ai`, `#/play/new`, `#/play/:code`, `#/watch/...`. Exports `navigate(path)` and `onRoute(cb)`.

Net types:
```ts
type Role = 'host' | 'guest'
type ConnStatus = 'idle'|'signaling'|'waiting-peer'|'connecting'|'open'|'peer-lost'|'reconnecting'|'failed'
type OnlineError = 'signaling'|'ice'|'room-full'|'proto-mismatch'|'bad-link'|'invalid-moves'|'tab-conflict'
type GameResult = { winner: Color | null; reason: 'no-moves'|'resign'|'draw-agreed'|'draw-rule'|'abandoned' }
interface Transport {
  readonly selfId: string;
  join(roomCode: string, opts: { iceServers?: RTCIceServer[]; turn?: RTCIceServer[] }): void;
  send(msg: WireMsg, peerId?: string): void;
  onMessage?: (raw: unknown, peerId: string) => void;
  onPeerJoin?: (peerId: string) => void; onPeerLeave?: (peerId: string) => void;
  onError?: (e: { kind: 'signaling' | 'ice'; detail?: unknown }) => void;
  leave(): void;
}
```
WireMsg is as given in the design, section 3 (PROTO = 1, single Trystero action 'm').

Storage keys: `checkers:clientId`, `checkers:name`, `checkers:room:<CODE>` (RoomRecord v1). Other areas must not use the `checkers:room:` prefix.

Build/env: Vite `base:'/checkers/'`. `import.meta.env.VITE_TURN_CRED_URL` is optional (GitHub repo variable). `__APP_VERSION__` (git SHA) is defined in vite.config. `--mode e2e` enables `window.__ck` test hooks and `?transport=bridge|wsrelay`.

Dependencies: `trystero@0.26.0` (exact; ws-relay `@trystero-p2p/ws-relay@0.26.0` as a devDependency for the e2e relay server), `@playwright/test` (dev), optional `qrcode-generator`.

## Design

# Live P2P multiplayer via invite link

## 0. Research findings (checked 2026-10-19)

**PeerJS**
- `npm view peerjs`: latest is **1.5.5**. The registry metadata was last modified 2025-06-07. `2.0.0-beta.3` is tagged beta and appears stalled. The 0.3.x line is long dead.
- The default broker is the free PeerServer Cloud (`0.peerjs.com:443`). It is a single, community-run server with no SLA, so if it goes down, nobody can be matched.
- Known problem: after a refresh or network drop, reclaiming the same peer ID often fails with `unavailable-id` ("ID is taken") until the server times out the old socket. This works directly against the "refresh or phone sleep, then reconnect with the same IDs" requirement.
- No TURN servers are included by default.

**Trystero** (dmotz/trystero)
- `npm view trystero`: latest is **0.26.0**, published 2026-10-04. Releases come out about monthly.
- It is a serverless WebRTC matchmaker. Signaling runs over public **Nostr** relays (the default in the root `trystero` package, also available as `@trystero-p2p/nostr`, "hundreds of relays"). Other strategies: MQTT (`@trystero-p2p/mqtt`), BitTorrent trackers (`@trystero-p2p/torrent`), and a self-hostable WebSocket relay (`@trystero-p2p/ws-relay`, whose server is `createWsRelayServer` from `@trystero-p2p/ws-relay/server`).
- Features that matter here:
  - `joinRoom({appId, password, relayConfig:{urls, redundancy}, rtcConfig, turnConfig, maxReceiveBytes}, roomId, {onJoinError, onPeerHandshake})`
  - `room.makeAction(id)` returns `{send, onMessage}`
  - `room.onPeerJoin` / `room.onPeerLeave` are assignable properties
  - `selfId`
  - SDP is encrypted with AES-GCM using a key from `password`
  - Nostr backs off from rate-limited relays and restores subscriptions after relay reconnects (0.25.x)
  - `onJoinError` fires when SDP was exchanged but ICE failed, which is exactly the "you need TURN" signal
  - 0.26 hardened signaling, payload validation and bounded queues
- Downside: the API changes often. 0.23, 0.24, 0.25 and 0.26 each had breaking changes, so pin it **exactly**.
- Size: about 75 KB unpacked for `@trystero-p2p/nostr` plus `@noble/secp256k1`. Load it with a dynamic import so it only loads on the play-a-friend route.

**TURN**
- With STUN only, a real minority of pairings fail, especially mobile carrier-grade NAT, symmetric NAT and strict corporate or school Wi-Fi. A figure of 10-20% is commonly cited.
- **Metered / Open Relay:** sign up for a free account to get an `apiKey`. Metered documents the `apiKey` as credential-scoped and **safe for the browser**. The frontend fetches `https://<app>.metered.live/api/v1/turn/credentials?apiKey=KEY`, which returns `iceServers`. TURN listens on 80 and 443, including TURNS, so it gets through firewalls. The quota is unclear: the Open Relay page says 20 GB/month, but the pricing page and a 2025 free-for-dev commit say 500 MB. Either amount is effectively unlimited for checkers, which sends a few KB per game.
- **Cloudflare Realtime TURN:** 1,000 GB free and the best documented. But credentials must be minted server-side with a bearer token (`POST rtc.live.cloudflare.com/v1/turn/keys/{id}/credentials/generate-ice-servers`), so it needs a Worker. That breaks "static only". It is a future upgrade path, not v1.
- Static `openrelayproject` credentials are no longer documented. Do not rely on them.

### Recommendation: Trystero (Nostr strategy) behind a `Transport` interface, with optional Metered TURN

The data still goes directly over a WebRTC data channel, browser to browser. Only the signaling changes: many independent Nostr relays instead of the single `0.peerjs.com` server.

Why:
1. No single broker to fail.
2. No peer-ID reclaim problem. Rejoining is just `joinRoom(code)` again, and our own persistent `clientId` handles identity.
3. Actively maintained; PeerJS is effectively in maintenance mode.
4. Built-in SDP encryption with a room password.
5. `onJoinError` gives a precise error when TURN is needed.
6. A local `ws-relay` server gives deterministic CI tests over real WebRTC.

**This changes the earlier "PeerJS" choice. Flag it to the user.** It still meets their "live P2P only" decision. The `Transport` interface keeps the swap cheap: a PeerJS adapter would be about 80 lines (host ID `dsck-<code>-h`, guest connects to it), but it would inherit the `unavailable-id`-on-refresh problem (workaround: a suffix that changes per epoch).

Pin `trystero` or `@trystero-p2p/nostr` at `0.26.0` exactly. Keep the default relay list, with `relayConfig.redundancy` around 4-5.

## 1. Link format and routing

- URL: `https://duaneshaffer.github.io/checkers/#/play/K7Q2M-9XA3T`. Hash routing means no GitHub Pages 404s and no `404.html` trick. The fragment is never sent to any server or in a `Referer`, so the room code stays out of logs.
- Vite `base: '/checkers/'`.
- Routes, owned by a shared `src/app/router.ts`:
  - `#/` home
  - `#/ai` vs AI
  - `#/play/new` create dialog
  - `#/play/:code` online game
  - `#/watch/...` training replays
- **Room code:** 10 Crockford base32 characters (50 bits) from `crypto.getRandomValues`, shown as `XXXXX-XXXXX`.
  - `parseRoomCode` uppercases, strips `-` and spaces, maps I/L to 1 and O to 0, and validates length and alphabet.
  - The code is used as the Trystero `roomId` and also as `password` (as `'ck1:' + code`), so relay operators cannot read the SDP.
  - `appId = 'duaneshaffer-checkers'`.
- **Host = creator.**
  - Home → "Play a friend" → sheet: color choice (Dark moves first / Light / Random) and an optional display name (saved in localStorage).
  - Create the code, write the `RoomRecord` with `role:'host'`, then navigate to `#/play/<code>`.
- **Invitee:** opening a link with no local record for that code automatically means "guest". The guest auto-joins and the game auto-starts when the host's hello arrives. There is no ready button.
- **Invite panel** (host, while waiting):
  - Large read-only link field.
  - **Share** button: `navigator.share({title:'Checkers', text:'Play checkers with me', url})`, shown when `navigator.canShare?.({url})`. This is mainly mobile.
  - **Copy** button: `navigator.clipboard.writeText`, falling back to `input.select()` plus "Press Ctrl+C". Shows a "Copied" toast.
  - Optional QR code on wide screens, for desktop-to-phone. Use `qrcode-generator` loaded by dynamic import.
  - Status text: "Waiting for your friend to open the link. Keep this page open."
  - The board stays rendered behind the panel and is oriented to the host's color.

## 2. Identity, seats and persistence (`roomStore.ts`)

- `checkers:clientId` is a persistent random UUID per browser. `checkers:name` holds the display name.
- `checkers:room:<code>` holds a `RoomRecord`:
  - `{v:1, code, role, clientId, peerClientId?, peerName?, hostColor, games: GameRecord[], updatedAt}`
  - `GameRecord = {id, hostColor, moves: MoveStr[], result?: GameResult, startedAt}`
  - Saved after every state change. This is cheap because a game is at most about 2 KB.
- Records not updated for 14 days are pruned on startup.
- If localStorage throws (some private modes), fall back to in-memory storage and show a banner: "Refreshing will lose this game".
- **One tab per room:** `navigator.locks.request('ck-room-'+code, {ifAvailable:true}, ...)`. If the lock is not granted, show "This game is open in another tab" with a "Use this tab" button that steals the lock with `steal:true`. The other tab watches for that and shows "moved to another tab".
- **Seat claim:**
  - The host owns the seat table.
  - The first `hello` from a clientId other than the host's, with `role:'guest'`, claims the guest seat. Both sides store `peerClientId`.
  - Later hellos from other clientIds get `reject{reason:'room-full'}` and are ignored from then on.
  - Guests ignore hellos with `role:'guest'`, so a third party who arrives while the host is offline just waits and is rejected once the host is back.
  - v1 does not support spectators. The protocol leaves room for a future read-only `spectate` role.

## 3. Protocol (`protocol.ts`), version `PROTO = 1`

There is one Trystero action, `'m'`. Payloads are JSON objects `{t, ...}`.
- `maxReceiveBytes` is about 64 KB.
- `decode(raw): WireMsg | null` is a hand-written type guard. Unknown or malformed messages are dropped and counted. Strings have length caps: names ≤ 24 characters, rendered with `textContent` only.
- `MoveStr` is the engine's standard 1-32 notation: `"11-15"`, `"15x24x31"`. In American draughts the sequence of landing squares is unambiguous.

```ts
type Role = 'host' | 'guest'
type MoveStr = string
type GameResult = { winner: Color | null; reason: 'no-moves' | 'resign' | 'draw-agreed' | 'draw-rule' | 'abandoned' }
type GameSnapshot = { id: string; hostColor: Color; moves: MoveStr[]; result?: GameResult }
type OfferKind = 'draw' | 'rematch'
type WireMsg =
  | { t: 'hello'; proto: 1; app: string; clientId: string; role: Role; name?: string }
  | { t: 'reject'; reason: 'room-full' | 'proto-mismatch' }
  | { t: 'sync'; game: GameSnapshot | null; offer?: { kind: OfferKind; gameId: string; ply: number; from: Role } }
  | { t: 'start'; game: { id: string; hostColor: Color } }            // host-only; first game and rematches
  | { t: 'move'; gameId: string; ply: number; move: MoveStr; hash: string }
  | { t: 'resign'; gameId: string; ply: number }
  | { t: 'offer'; kind: OfferKind; gameId: string; ply: number }
  | { t: 'answer'; kind: OfferKind; gameId: string; ply: number; accept: boolean }
  | { t: 'emote'; id: number }                                          // optional, small fixed set
  | { t: 'ping'; n: number; ply: number; hash: string }
  | { t: 'pong'; n: number; ply: number; hash: string }
  | { t: 'bye' }
```

**Handshake:** on `onPeerJoin`, both sides send `hello`.
- If `proto` differs, send `reject proto-mismatch`. UI: "You and your friend are on different versions. Both refresh the page."
- If `app` (the build SHA) differs but `proto` matches, only warn.
- After a successful hello, both send `sync`. The host sends `start` if no game exists yet (this is the first game).

**Moves:** `ply` = index into `moves`, starting at 0.
- `move.ply === local.length` and the engine finds it legal: apply it, then compare `hash`.
- `ply < length` and the move matches the stored move: duplicate, ignore.
- `ply > length`: gap, send `sync`.
- Illegal or mismatched: send `sync`. Three strikes → "Your opponent's game sent invalid moves", and the session ends.
- `hash = fnv1a32(engine.positionKey(state)).toString(16)`.
- `ping`/`pong` also carry `ply` and `hash`, so a desync is caught every 3 s even when nobody moves.

**Authority:** there is no server. Both peers run the same engine and validate everything. Results from no-moves and the draw rule are computed locally by both sides. A resign only takes effect for the sender's own color. Agreed draws need an offer and an accept at the same `ply`.

**Reconcile** (`reconcile.ts`), run on every `sync`:
- equal: nothing.
- local is a strict prefix of remote: validate and replay the remote tail, then adopt it.
- remote is behind: send our `sync`, but only when the states differ, so syncs cannot loop.
- diverged: the host's list wins as the tiebreak. The guest replays it and shows the toast "Game resynchronized". If the host's list is illegal for the guest's engine, end the session with an error.

Because the game is turn-based, divergence cannot happen legitimately:
- A player can make their move while the opponent is disconnected. It is queued in the record and delivered by `sync`.
- The opponent cannot move until that move arrives.
- A resign while disconnected is carried as `result` in the sync.

**Offers:**
- Each side can have one draw offer outstanding at a time.
- An offer expires automatically when `moves.length` changes.
- A rematch offer is only valid after a result.
- A rematch is created only by the host, which avoids ID races:
  - If the guest accepts the host's offer, the guest sends `answer` and the host then sends `start`.
  - If the host accepts the guest's offer, the host sends `answer` and then `start`.
- Rematches swap colors: `hostColor = opposite(previous)`.
- Pending offers are included in `sync` so they survive a reconnect.

**Leaving:** on `pagehide`, try to send `bye`. The peer shows "Opponent left" instead of "connection lost". `bye` does not forfeit the game. There is no abandonment rule in v1, only an explicit Resign.

## 4. Connection lifecycle (`connection.ts`)

`ConnStatus = 'idle' | 'signaling' | 'waiting-peer' | 'connecting' | 'open' | 'peer-lost' | 'reconnecting' | 'failed'`

1. **Start.**
   - Fetch ICE servers (`iceServers.ts`):
     - STUN: Trystero's defaults plus `stun:stun.cloudflare.com:3478`.
     - If `import.meta.env.VITE_TURN_CRED_URL` is set (a Metered URL with the browser-safe apiKey, stored as a GitHub repo **variable** and baked in at build time), fetch it with a 3 s timeout and cache the result in sessionStorage for 12 h.
     - If the fetch fails, continue with STUN only.
   - Pass the TURN entries as `turnConfig` so the default STUN servers stay.
   - Call `joinRoom`.
2. **Timers:**
   - No relay socket connected within 10 s: `failed:signaling`. Check this through the Trystero relay-socket accessor if 0.26 exposes one. Otherwise infer it from "no onPeerJoin and navigator.onLine" and show a softer message.
   - Waiting for a peer has no hard timeout. The guest sees "Looking for the host… they need to have this game open". After 20 s a hint appears.
   - Between `onPeerJoin` and the first valid `hello`: 8 s timeout, then rejoin.
   - `onJoinError`: `failed:ice`.
3. **Liveness:** send `ping` every 3 s while open. No `pong` for 10 s, or `onPeerLeave` → `peer-lost`. Trystero re-announces on its own. If there is still no peer 15 s after `peer-lost`, or right away on `online` or `visibilitychange→visible` when a probe ping gets no reply within 3 s → `reconnecting`: `room.leave()` and then `joinRoom` again. Backoff 1, 2, 4, 8, 15 s (capped), repeating indefinitely while the page is visible. Pause while hidden to save battery.
4. **Refresh / phone sleep:**
   - The route loads the record, replays `moves` through the engine, renders, and joins.
   - On hello+sync, both converge.
   - The same `clientId` makes reclaiming the seat automatic. There are no broker IDs to fight over.

## 5. Failure UX (copy)

- **Signaling:** "Can't reach the matchmaking network. Check your internet connection." [Retry]
- **ICE failed:** "Found your friend, but your networks won't let you connect directly. This often happens on mobile data or school/work Wi-Fi. Try switching one device to a different Wi-Fi network." [Retry]. If TURN is not configured, add a dev-console hint.
- **room-full:** "This game already has two players." [Start your own game]
- **proto-mismatch:** "Different game versions — both of you refresh the page." [Refresh]
- **Bad link:** "That invite link looks incomplete." [Home]
- **Badge** in the HUD: a dot and label. Green "Connected · 42 ms", amber "Reconnecting…", red "Opponent offline — your game is saved". Input stays enabled on your turn while disconnected, and the move is delivered later.
- Dialogs: draw offer (Accept/Decline), opponent resigned, rematch offered, "Resign?" confirmation.

## 6. Security and privacy

- **The link is the capability.** The 50-bit code cannot be enumerated, and it sits in the fragment.
- **Seating:** the first joiner gets the seat. Everyone else is rejected and ignored. Never auto-seat a different clientId.
- **Input handling:** all input passes through `decode` with size caps and is never put in `innerHTML`. Moves are validated by the engine, and results are computed locally. A tampered client cannot create illegal positions or claim wins, apart from resigning itself.
- **Not preventable:** engine-assisted play. Note it.
- **Rate limits:** inbound messages over 30/s from a peer are dropped. Repeated invalid messages end the session.
- **Privacy:** WebRTC reveals each player's IP to the other player (and to the TURN provider if a relay is used). Nostr relays see an opaque topic and encrypted SDP. Put one line in an "About online play" note.
- **TURN key:** the Metered `apiKey` in the bundle is browser-safe by design. Abuse can only use up our quota. Rotate it if needed.

## 7. Module layout

```
src/net/
  transport.ts          Transport interface + TransportError kinds
  trysteroTransport.ts  Nostr strategy (prod) / ws-relay strategy (e2e-webrtc), dynamic-imported
  bridgeTransport.ts    e2e-only: talks to Playwright via window bindings (fault injection)
  iceServers.ts         STUN list, optional Metered TURN fetch + cache
  protocol.ts           WireMsg types, PROTO, decode/encode guards, limits
  reconcile.ts          pure prefix/diverge reconciliation using engine
  session.ts            pure reducer: (NetSession, SessionEvent) -> { state, out: Outgoing[], effects }
  connection.ts         lifecycle, ping/pong, timers, visibility/online, backoff; emits ConnStatus
  onlineGame.ts         OnlineGameDriver: wires connection+session+roomStore, implements GameDriver
  roomStore.ts          clientId, RoomRecord CRUD, pruning, memory fallback, Web Locks
  roomCode.ts           generate/format/parse codes
  invite.ts             inviteUrl(code), shareInvite(), copyInvite()
src/ui/online/
  createGameSheet.ts    color/name choice
  invitePanel.ts        link, Share/Copy/QR, waiting state
  connectionBadge.ts
  onlineDialogs.ts      offers, errors, resign confirm
test/net/               vitest: roomCode, protocol, reconcile, session, simulation (LoopbackTransport)
test/support/loopbackTransport.ts  in-memory pair with drop/delay/duplicate/disconnect
e2e/online.spec.ts, e2e/online-webrtc.spec.ts, e2e/fixtures/bridge.ts, e2e/global-setup.ts (ws-relay)
```

`session.ts` is pure: no timers, no storage, no DOM. That makes most behavior unit-testable. `connection.ts` and `onlineGame.ts` are thin and handle the side effects.

## 8. Testing

**Unit tests (Vitest, Node):**
- Codes: format, normalization, and rejection of bad codes.
- `decode`: rejects bad shapes, oversize payloads and unknown `t`.
- `reconcile`: all four cases, plus an illegal tail.
- `session`: seat claim, third-peer reject, duplicate and gap moves, offer expiry, rematch color swap and host-only start, resign while offline delivered via sync.
- **Simulation test:** two sessions over `LoopbackTransport` with a seeded PRNG. Play random legal games while injecting drops, delays, duplicates, disconnects, and "reloads" (rebuild a session from its saved RoomRecord). Assert both sides end with identical move lists and results. Run about 500 seeds.

**E2E (Playwright, Chromium):**
- Build with `vite build --mode e2e`, which enables the `window.__ck` test API (`playMove('11-15')`, `getState()`) and transport overrides via `?transport=bridge|wsrelay`. Production builds strip these via `import.meta.env.MODE`.
- Use two `browser.newContext()`s, so each has its own localStorage and therefore its own clientId.
- `online.spec.ts` (bridge transport; deterministic; required in CI):
  - Host creates a game; the test reads the link from the `data-invite-url` attribute.
  - The guest opens the link; both see the board with the correct orientation.
  - Alternate moves.
  - Reload the guest mid-game: the position is restored.
  - Cut the bridge: both show "reconnecting", then they recover and the queued move is delivered.
  - A third context gets room-full.
  - Draw offer and accept; resign; rematch swaps colors.
  - Mobile viewport project (iPhone 14 emulation): the invite panel layout and Share button path, with `navigator.share` stubbed.
- `online-webrtc.spec.ts` (real WebRTC):
  - `globalSetup` starts `createWsRelayServer({port: 8787})`.
  - Chromium arg `--disable-features=WebRtcHideLocalIpsWithMdns`.
  - Checks that host and guest connect and exchange moves.
- **CI:**
  - The `ci.yml` jobs run lint, typecheck and vitest, then `npx playwright install --with-deps chromium` and both e2e specs.
  - The Pages deploy job `needs` these.
  - A separate `live-smoke.yml` runs nightly (`schedule`) against the deployed URL with real Nostr. It is `continue-on-error` and only alerts, because public relays are outside our control.
- **Manual check:** a phone on cellular data plus a desktop on Wi-Fi, with and without the TURN variable set.

## 9. Sequencing

1. `roomCode`, `protocol`, `reconcile`, `session` and the loopback simulation tests. These only need the engine API.
2. `roomStore` and Web Locks.
3. `transport` + `trysteroTransport` + `iceServers`, then `connection`.
4. `onlineGame` (GameDriver) + router route + UI panels.
5. Bridge transport + Playwright specs + CI.
6. Optional: TURN repo variable, QR code, emotes.

