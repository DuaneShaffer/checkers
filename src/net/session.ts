import type { Side } from '../engine/types.ts';
import { PROTO } from './protocol.ts';
import type { GameResult, OfferKind, OnlineError, OnlineGame, PendingOffer, Role, WireMsg } from './protocol.ts';
import { reconcile } from './reconcile.ts';
import { applyMoveText, sideToMove, stateDigest } from './rules.ts';

export const MAX_STRIKES = 3;

export type LinkPhase = 'down' | 'open' | 'ready';

export interface SessionState {
  readonly role: Role;
  readonly clientId: string;
  readonly name?: string;
  readonly peerClientId?: string;
  readonly peerName?: string;
  readonly firstHostSide: Side;
  readonly game: OnlineGame | null;
  readonly offer?: PendingOffer;
  readonly link: LinkPhase;
  readonly pingN: number;
  readonly strikes: number;
  readonly error?: OnlineError;
}

export type SessionEvent =
  | { type: 'link-up' }
  | { type: 'link-down' }
  | { type: 'receive'; msg: WireMsg }
  | { type: 'move'; move: string }
  | { type: 'resign' }
  | { type: 'offer'; kind: OfferKind }
  | { type: 'answer'; kind: OfferKind; accept: boolean }
  | { type: 'tick' };

export type Notice =
  | 'peer-joined'
  | 'peer-left'
  | 'game-started'
  | 'resynced'
  | 'peer-resigned'
  | 'draw-offered'
  | 'draw-agreed'
  | 'draw-cancelled'
  | 'draw-declined'
  | 'rematch-offered'
  | 'rematch-declined';

export interface SessionEnv {
  newGameId(seq: number): string;
}

export interface Step {
  state: SessionState;
  send: WireMsg[];
  notices: Notice[];
  ok: boolean;
}

export interface SessionInit {
  role: Role;
  clientId: string;
  name?: string;
  peerClientId?: string;
  peerName?: string;
  firstHostSide: Side;
  game?: OnlineGame | null;
  offer?: PendingOffer;
}

export function createSession(init: SessionInit): SessionState {
  return {
    role: init.role,
    clientId: init.clientId,
    ...(init.name ? { name: init.name } : {}),
    ...(init.peerClientId ? { peerClientId: init.peerClientId } : {}),
    ...(init.peerName ? { peerName: init.peerName } : {}),
    firstHostSide: init.firstHostSide,
    game: init.game ?? null,
    ...(init.offer ? { offer: init.offer } : {}),
    link: 'down',
    pingN: 0,
    strikes: 0,
  };
}

const other = (role: Role): Role => (role === 'host' ? 'guest' : 'host');

export function sideOf(role: Role, game: Pick<OnlineGame, 'hostSide'>): Side {
  return role === 'host' ? game.hostSide : ((1 - game.hostSide) as Side);
}

export function gameSeq(id: string): number {
  const seq = Number.parseInt(id.split('.')[0] ?? '', 36);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : 0;
}

export function isActive(game: OnlineGame | null): game is OnlineGame {
  return !!game && !game.result;
}

export function incomingOffer(s: SessionState): OfferKind | undefined {
  return s.offer && s.offer.from !== s.role ? s.offer.kind : undefined;
}

export function outgoingOffer(s: SessionState): OfferKind | undefined {
  return s.offer && s.offer.from === s.role ? s.offer.kind : undefined;
}

class Stepper {
  state: SessionState;
  readonly send: WireMsg[] = [];
  readonly notices: Notice[] = [];
  ok = true;
  private readonly env: SessionEnv;

  constructor(state: SessionState, env: SessionEnv) {
    this.state = state;
    this.env = env;
  }

  patch(p: Partial<SessionState>): void {
    this.state = { ...this.state, ...p };
  }

  emit(msg: WireMsg): void {
    if (this.state.link === 'ready' || msg.t === 'hello' || msg.t === 'reject') this.send.push(msg);
  }

  setGame(game: OnlineGame | null, offer?: PendingOffer): void {
    const next: SessionState = { ...this.state, game };
    delete (next as { offer?: PendingOffer }).offer;
    if (offer && offerFits(offer, game)) (next as { offer?: PendingOffer }).offer = offer;
    this.state = next;
  }

  clearOffer(): void {
    if (!this.state.offer) return;
    const next = { ...this.state };
    delete (next as { offer?: PendingOffer }).offer;
    this.state = next;
  }

  setOffer(offer: PendingOffer): void {
    this.patch({ offer });
  }

  finish(result: GameResult): void {
    const game = this.state.game;
    if (!game) return;
    this.setGame({ ...game, result });
  }

  syncMsg(): WireMsg {
    const { game, offer } = this.state;
    return { t: 'sync', game, ...(offer ? { offer } : {}) };
  }

  strike(): void {
    const strikes = this.state.strikes + 1;
    this.patch({ strikes });
    if (strikes >= MAX_STRIKES) this.patch({ error: { kind: 'desync' } });
  }

  startNewGame(): void {
    const prev = this.state.game;
    const seq = prev ? gameSeq(prev.id) + 1 : 0;
    const hostSide: Side = prev ? ((1 - prev.hostSide) as Side) : this.state.firstHostSide;
    const id = this.env.newGameId(seq);
    this.setGame({ id, hostSide, moves: [] });
    this.emit({ t: 'start', game: { id, hostSide } });
    this.notices.push('game-started');
  }

  mySide(): Side | null {
    return this.state.game ? sideOf(this.state.role, this.state.game) : null;
  }

  afterMoves(moves: string[], result: GameResult | undefined): void {
    const game = this.state.game!;
    const offer = this.state.offer;
    this.setGame({ id: game.id, hostSide: game.hostSide, moves, ...(result ? { result } : {}) }, offer);
  }
}

function offerFits(offer: PendingOffer, game: OnlineGame | null): boolean {
  if (!game || offer.gameId !== game.id) return false;
  if (offer.kind === 'draw') return !game.result && offer.ply === game.moves.length;
  return !!game.result;
}

function onHello(st: Stepper, msg: Extract<WireMsg, { t: 'hello' }>): void {
  const s = st.state;
  if ((msg.proto as number) !== PROTO) {
    st.emit({ t: 'reject', reason: 'proto-mismatch' });
    st.patch({ error: { kind: 'proto-mismatch' } });
    return;
  }
  if (msg.role === s.role || (s.peerClientId && s.peerClientId !== msg.clientId) || msg.clientId === s.clientId) {
    st.emit({ t: 'reject', reason: 'room-full' });
    return;
  }
  const wasReady = s.link === 'ready';
  st.patch({ peerClientId: msg.clientId, link: 'ready', ...(msg.name ? { peerName: msg.name } : {}) });
  if (!wasReady) st.notices.push('peer-joined');
  if (s.role === 'host' && !s.game) st.startNewGame();
  st.emit(st.syncMsg());
}

function onSync(st: Stepper, msg: Extract<WireMsg, { t: 'sync' }>): void {
  const outcome = reconcile(st.state.game, msg.game, st.state.role);
  switch (outcome.kind) {
    case 'equal':
      st.patch({ strikes: 0 });
      break;
    case 'adopt': {
      const undone = undoneResult(st.state.game, outcome.game);
      st.setGame(outcome.game, st.state.offer);
      st.patch({ strikes: 0 });
      if (undone?.reason === 'agreement') st.notices.push('draw-cancelled');
      else if (undone || outcome.relation === 'diverged') st.notices.push('resynced');
      break;
    }
    case 'push':
      st.emit(st.syncMsg());
      return;
    case 'invalid':
      st.strike();
      if (st.state.role === 'host') st.emit(st.syncMsg());
      return;
  }
  syncOffers(st, msg.offer);
}

function undoneResult(local: OnlineGame | null, adopted: OnlineGame): GameResult | undefined {
  return local?.result && local.id === adopted.id && !adopted.result ? local.result : undefined;
}

function syncOffers(st: Stepper, remote: PendingOffer | undefined): void {
  const s = st.state;
  const peer = other(s.role);
  if (remote && remote.from === peer && offerFits(remote, s.game)) {
    if (s.offer?.from !== peer || s.offer.kind !== remote.kind) onOffer(st, { t: 'offer', kind: remote.kind, gameId: remote.gameId, ply: remote.ply });
    return;
  }
  if (s.offer?.from === peer) st.clearOffer();
  const mine = st.state.offer;
  if (mine && mine.from === s.role && offerFits(mine, s.game) && !(remote && remote.from === s.role && remote.kind === mine.kind)) {
    st.emit({ t: 'offer', kind: mine.kind, gameId: mine.gameId, ply: mine.ply });
  }
}

function onStart(st: Stepper, msg: Extract<WireMsg, { t: 'start' }>): void {
  if (st.state.role !== 'guest' || st.state.game?.id === msg.game.id) return;
  st.setGame({ id: msg.game.id, hostSide: msg.game.hostSide, moves: [] });
  st.notices.push('game-started');
}

function onMove(st: Stepper, msg: Extract<WireMsg, { t: 'move' }>): void {
  const game = st.state.game;
  if (!game || game.id !== msg.gameId) {
    st.emit(st.syncMsg());
    return;
  }
  const len = game.moves.length;
  if (msg.ply < len) {
    if (game.moves[msg.ply] !== msg.move) st.emit(st.syncMsg());
    return;
  }
  if (msg.ply > len || game.result) {
    st.emit(st.syncMsg());
    return;
  }
  const peerSide = sideOf(other(st.state.role), game);
  const applied = sideToMove(game.moves) === peerSide ? applyMoveText(game.moves, msg.move) : null;
  if (!applied) {
    st.emit(st.syncMsg());
    return;
  }
  st.afterMoves(applied.moves, applied.result);
  if (applied.hash !== msg.hash) {
    st.strike();
    st.emit(st.syncMsg());
  }
}

function onResign(st: Stepper, msg: Extract<WireMsg, { t: 'resign' }>): void {
  const game = st.state.game;
  if (!game || game.id !== msg.gameId) return;
  if (msg.ply > game.moves.length) {
    st.emit(st.syncMsg());
    return;
  }
  if (game.result) return;
  st.finish({ winner: sideOf(st.state.role, game), reason: 'resign' });
  st.notices.push('peer-resigned');
}

function onOffer(st: Stepper, msg: Extract<WireMsg, { t: 'offer' }>): void {
  const s = st.state;
  const game = s.game;
  const offer: PendingOffer = { kind: msg.kind, gameId: msg.gameId, ply: msg.ply, from: other(s.role) };
  if (!offerFits(offer, game)) return;
  const mine = s.offer?.from === s.role && s.offer.kind === msg.kind && offerFits(s.offer, game);
  if (mine) {
    acceptOffer(st, offer);
    return;
  }
  st.setOffer(offer);
  st.notices.push(msg.kind === 'draw' ? 'draw-offered' : 'rematch-offered');
}

function acceptOffer(st: Stepper, offer: PendingOffer): void {
  st.clearOffer();
  if (offer.kind === 'draw') {
    st.finish({ winner: null, reason: 'agreement' });
    st.emit({ t: 'answer', kind: 'draw', gameId: offer.gameId, ply: offer.ply, accept: true });
    st.notices.push('draw-agreed');
    return;
  }
  if (st.state.role === 'host') {
    st.startNewGame();
  } else {
    st.emit({ t: 'answer', kind: 'rematch', gameId: offer.gameId, ply: offer.ply, accept: true });
  }
}

function onAnswer(st: Stepper, msg: Extract<WireMsg, { t: 'answer' }>): void {
  const s = st.state;
  const mine = s.offer;
  if (!mine || mine.from !== s.role || mine.kind !== msg.kind || mine.gameId !== msg.gameId || mine.ply !== msg.ply) return;
  st.clearOffer();
  if (!msg.accept) {
    st.notices.push(msg.kind === 'draw' ? 'draw-declined' : 'rematch-declined');
    return;
  }
  if (msg.kind === 'draw') {
    if (isActive(s.game) && s.game.moves.length === msg.ply) {
      st.finish({ winner: null, reason: 'agreement' });
      st.notices.push('draw-agreed');
    }
    return;
  }
  if (s.role === 'host') st.startNewGame();
}

function onPing(st: Stepper, msg: Extract<WireMsg, { t: 'ping' | 'pong' }>): void {
  const digest = stateDigest(st.state.game);
  if (msg.t === 'ping') st.emit({ t: 'pong', n: msg.n, ply: st.state.game?.moves.length ?? 0, hash: digest });
  if (msg.t === 'ping' && msg.hash !== digest) st.emit(st.syncMsg());
}

function onReceive(st: Stepper, msg: WireMsg): void {
  if (msg.t === 'hello') return onHello(st, msg);
  if (msg.t === 'reject') {
    st.patch({ error: { kind: msg.reason } });
    return;
  }
  if (st.state.link !== 'ready') return;
  switch (msg.t) {
    case 'sync': return onSync(st, msg);
    case 'start': return onStart(st, msg);
    case 'move': return onMove(st, msg);
    case 'resign': return onResign(st, msg);
    case 'offer': return onOffer(st, msg);
    case 'answer': return onAnswer(st, msg);
    case 'ping':
    case 'pong': return onPing(st, msg);
    case 'bye':
      st.patch({ link: 'open' });
      st.notices.push('peer-left');
      return;
    case 'ice-restart':
      return;
  }
}

function localMove(st: Stepper, text: string): void {
  const game = st.state.game;
  const side = st.mySide();
  if (!isActive(game) || side === null || sideToMove(game.moves) !== side) {
    st.ok = false;
    return;
  }
  const applied = applyMoveText(game.moves, text);
  if (!applied) {
    st.ok = false;
    return;
  }
  const ply = game.moves.length;
  st.afterMoves(applied.moves, applied.result);
  st.emit({ t: 'move', gameId: game.id, ply, move: applied.move, hash: applied.hash });
}

function localResign(st: Stepper): void {
  const game = st.state.game;
  const side = st.mySide();
  if (!isActive(game) || side === null) {
    st.ok = false;
    return;
  }
  st.finish({ winner: (1 - side) as Side, reason: 'resign' });
  st.emit({ t: 'resign', gameId: game.id, ply: game.moves.length });
}

function localOffer(st: Stepper, kind: OfferKind): void {
  const s = st.state;
  const game = s.game;
  if (!game) {
    st.ok = false;
    return;
  }
  const offer: PendingOffer = { kind, gameId: game.id, ply: game.moves.length, from: s.role };
  if (!offerFits(offer, game) || s.offer?.from === s.role) {
    st.ok = false;
    return;
  }
  if (s.offer && s.offer.kind === kind && offerFits(s.offer, game)) {
    acceptOffer(st, s.offer);
    return;
  }
  st.setOffer(offer);
  st.emit({ t: 'offer', kind, gameId: offer.gameId, ply: offer.ply });
}

function localAnswer(st: Stepper, kind: OfferKind, accept: boolean): void {
  const offer = st.state.offer;
  if (!offer || offer.from === st.state.role || offer.kind !== kind || !offerFits(offer, st.state.game)) {
    st.ok = false;
    return;
  }
  if (accept) {
    acceptOffer(st, offer);
    return;
  }
  st.clearOffer();
  st.emit({ t: 'answer', kind, gameId: offer.gameId, ply: offer.ply, accept: false });
}

function helloMsg(s: SessionState): WireMsg {
  return { t: 'hello', proto: PROTO, clientId: s.clientId, role: s.role, ...(s.name ? { name: s.name } : {}) };
}

export function step(state: SessionState, event: SessionEvent, env: SessionEnv): Step {
  const st = new Stepper(state, env);
  switch (event.type) {
    case 'link-up': {
      const next = { ...state, link: 'open' as const, strikes: 0 };
      delete (next as { error?: OnlineError }).error;
      st.state = next;
      st.emit(helloMsg(state));
      break;
    }
    case 'link-down':
      st.patch({ link: 'down' });
      break;
    case 'receive':
      if (state.error?.kind === 'desync') break;
      onReceive(st, event.msg);
      break;
    case 'move':
      localMove(st, event.move);
      break;
    case 'resign':
      localResign(st);
      break;
    case 'offer':
      localOffer(st, event.kind);
      break;
    case 'answer':
      localAnswer(st, event.kind, event.accept);
      break;
    case 'tick':
      if (state.link === 'open' && !state.error) {
        st.emit(helloMsg(state));
      } else if (state.link === 'ready') {
        const n = state.pingN + 1;
        st.patch({ pingN: n });
        st.emit({ t: 'ping', n, ply: state.game?.moves.length ?? 0, hash: stateDigest(state.game) });
      }
      break;
  }
  return { state: st.state, send: st.send, notices: st.notices, ok: st.ok };
}
