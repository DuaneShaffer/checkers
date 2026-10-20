import { describe, expect, it } from 'vitest';
import type { WireMsg } from '../../src/net/protocol.ts';
import { positionHash } from '../../src/net/rules.ts';
import { createSession, incomingOffer, outgoingOffer, step } from '../../src/net/session.ts';
import type { SessionEvent, SessionState, Step } from '../../src/net/session.ts';

let ids = 0;
const env = { newGameId: (seq: number) => `${seq.toString(36)}.t${ids++}` };

const host0 = () => createSession({ role: 'host', clientId: 'host-id', name: 'Hana', firstHostSide: 0 });
const guest0 = () => createSession({ role: 'guest', clientId: 'guest-id', name: 'Gus', firstHostSide: 0 });

function run(s: SessionState, ...events: SessionEvent[]): Step {
  let out: Step = { state: s, send: [], notices: [], ok: true };
  const send: WireMsg[] = [];
  const notices: Step['notices'] = [];
  for (const e of events) {
    out = step(out.state, e, env);
    send.push(...out.send);
    notices.push(...out.notices);
  }
  return { ...out, send, notices };
}

const recv = (msg: WireMsg): SessionEvent => ({ type: 'receive', msg });
const hello = (role: 'host' | 'guest', clientId: string, name?: string): WireMsg => ({ t: 'hello', proto: 1, clientId, role, ...(name ? { name } : {}) });

function pump(hs: SessionState, gs: SessionState, toG: WireMsg[], toH: WireMsg[], guestNotices: Step['notices'] = []): [SessionState, SessionState] {
  const q: { to: 'h' | 'g'; msg: WireMsg }[] = [...toG.map((msg) => ({ to: 'g' as const, msg })), ...toH.map((msg) => ({ to: 'h' as const, msg }))];
  for (let i = 0; q.length && i < 200; i++) {
    const { to, msg } = q.shift()!;
    const r = run(to === 'h' ? hs : gs, recv(msg));
    if (to === 'h') hs = r.state;
    else {
      gs = r.state;
      guestNotices.push(...r.notices);
    }
    q.push(...r.send.map((m) => ({ to: to === 'h' ? ('g' as const) : ('h' as const), msg: m })));
  }
  return [hs, gs];
}

function reconnect(h: SessionState, g: SessionState): [SessionState, SessionState] {
  const a = run(h, { type: 'link-down' }, { type: 'link-up' });
  const b = run(g, { type: 'link-down' }, { type: 'link-up' });
  return pump(a.state, b.state, a.send, b.send);
}

function connect(): [SessionState, SessionState] {
  return reconnect(host0(), guest0());
}

function deliver(from: Step, to: SessionState): Step {
  return run(to, ...from.send.map(recv));
}

describe('session handshake', () => {
  it('sends hello on link up', () => {
    const r = run(host0(), { type: 'link-up' });
    expect(r.send).toEqual([{ t: 'hello', proto: 1, clientId: 'host-id', role: 'host', name: 'Hana' }]);
    expect(r.state.link).toBe('open');
  });

  it('host starts the first game after the guest hello and both agree', () => {
    const [h, g] = connect();
    expect(h.link).toBe('ready');
    expect(g.link).toBe('ready');
    expect(h.peerClientId).toBe('guest-id');
    expect(g.peerClientId).toBe('host-id');
    expect(h.peerName).toBe('Gus');
    expect(g.peerName).toBe('Hana');
    expect(h.game).toEqual({ id: expect.stringMatching(/^0\./), hostSide: 0, moves: [] });
    expect(g.game).toEqual(h.game);
  });

  it('only the host sends start', () => {
    const r = run(guest0(), { type: 'link-up' }, recv(hello('host', 'host-id')));
    expect(r.send.some((m) => m.t === 'start')).toBe(false);
    const hostIgnores = run({ ...host0(), link: 'ready', peerClientId: 'guest-id' }, recv({ t: 'start', game: { id: '9.x', hostSide: 1 } }));
    expect(hostIgnores.state.game).toBeNull();
  });

  it('rejects a third client once the seat is claimed', () => {
    const [h] = connect();
    const r = run({ ...h, link: 'open' }, recv(hello('guest', 'intruder')));
    expect(r.send).toEqual([{ t: 'reject', reason: 'room-full' }]);
    expect(r.state.peerClientId).toBe('guest-id');
    expect(r.state.link).toBe('open');
  });

  it('rejects a peer claiming the same role', () => {
    const r = run(run(host0(), { type: 'link-up' }).state, recv(hello('host', 'other-host')));
    expect(r.send).toEqual([{ t: 'reject', reason: 'room-full' }]);
  });

  it('rejects and flags protocol mismatches', () => {
    const r = run(run(guest0(), { type: 'link-up' }).state, recv({ t: 'hello', proto: 2 as 1, clientId: 'h', role: 'host' }));
    expect(r.send).toEqual([{ t: 'reject', reason: 'proto-mismatch' }]);
    expect(r.state.error).toEqual({ kind: 'proto-mismatch' });
  });

  it('records reject errors', () => {
    const r = run(run(guest0(), { type: 'link-up' }).state, recv({ t: 'reject', reason: 'room-full' }));
    expect(r.state.error).toEqual({ kind: 'room-full' });
  });

  it('ignores game messages before hello', () => {
    const r = run(run(guest0(), { type: 'link-up' }).state, recv({ t: 'start', game: { id: '0.x', hostSide: 0 } }));
    expect(r.state.game).toBeNull();
  });
});

describe('moves', () => {
  it('applies a legal move on my turn and sends it with ply and hash', () => {
    const [h] = connect();
    const r = run(h, { type: 'move', move: '11-15' });
    expect(r.ok).toBe(true);
    expect(r.state.game!.moves).toEqual(['11-15']);
    expect(r.send).toEqual([{ t: 'move', gameId: h.game!.id, ply: 0, move: '11-15', hash: positionHash(['11-15']) }]);
  });

  it('refuses illegal or out-of-turn local moves', () => {
    const [h, g] = connect();
    expect(run(h, { type: 'move', move: '11-17' }).ok).toBe(false);
    expect(run(g, { type: 'move', move: '22-18' }).ok).toBe(false);
    expect(run(g, { type: 'move', move: '11-15' }).ok).toBe(false);
  });

  it('accepts peer moves, ignores duplicates and resyncs on gaps', () => {
    const [h, g] = connect();
    const m1 = run(h, { type: 'move', move: '11-15' });
    const g1 = deliver(m1, g);
    expect(g1.state.game!.moves).toEqual(['11-15']);
    expect(g1.send).toEqual([]);
    const dup = deliver(m1, g1.state);
    expect(dup.state.game!.moves).toEqual(['11-15']);
    expect(dup.send).toEqual([]);
    const m2 = run(g1.state, { type: 'move', move: '23-19' });
    const h2 = run(m1.state, ...m2.send.map(recv));
    const m3 = run(h2.state, { type: 'move', move: '8-11' });
    const m4 = run(m3.state, { type: 'move', move: '22-17' });
    expect(m4.ok).toBe(false);
    const gap = run(g, ...m3.send.map(recv));
    expect(gap.state.game!.moves).toEqual([]);
    expect(gap.send.map((m) => m.t)).toEqual(['sync']);
  });

  it('moves while the link is down are delivered by sync on reconnect', () => {
    const [h, g] = connect();
    const hDown = run(h, { type: 'link-down' }, { type: 'move', move: '11-15' });
    expect(hDown.send).toEqual([]);
    expect(hDown.state.game!.moves).toEqual(['11-15']);
    const [h2, g2] = reconnect(hDown.state, g);
    expect(g2.game).toEqual(h2.game);
    expect(g2.game!.moves).toEqual(['11-15']);
  });

  it('rejects a peer move for my own side', () => {
    const [h] = connect();
    const r = run(h, recv({ t: 'move', gameId: h.game!.id, ply: 0, move: '11-15', hash: positionHash(['11-15']) }));
    expect(r.state.game!.moves).toEqual([]);
    expect(r.send.map((m) => m.t)).toEqual(['sync']);
  });

  it('flags desync after repeated hash mismatches', () => {
    let [h, g] = connect();
    const lines = ['11-15', '23-19', '8-11', '22-17', '9-13', '17-14'];
    for (let i = 0; i < 6; i += 2) {
      const hm = run(h, { type: 'move', move: lines[i] });
      h = hm.state;
      const bad = hm.send.map((m) => (m.t === 'move' ? { ...m, hash: '1234' } : m));
      g = run(g, ...bad.map(recv)).state;
      const gm = run(g, { type: 'move', move: lines[i + 1] });
      g = gm.state;
      h = run(h, ...gm.send.map(recv)).state;
    }
    expect(g.error).toEqual({ kind: 'desync' });
    expect(g.strikes).toBe(3);
  });

  it('records engine results', () => {
    const [h, g] = connect();
    const won = run({ ...h, game: { ...h.game!, moves: [] } }, { type: 'resign' });
    expect(won.state.game!.result).toEqual({ winner: 1, reason: 'resign' });
    expect(won.send).toEqual([{ t: 'resign', gameId: h.game!.id, ply: 0 }]);
    const gr = deliver(won, g);
    expect(gr.state.game!.result).toEqual({ winner: 1, reason: 'resign' });
    expect(gr.notices).toContain('peer-resigned');
  });
});

describe('offers', () => {
  it('draw offer, accept, and both record agreement', () => {
    const [h, g] = connect();
    const offer = run(h, { type: 'offer', kind: 'draw' });
    expect(outgoingOffer(offer.state)).toBe('draw');
    const seen = deliver(offer, g);
    expect(incomingOffer(seen.state)).toBe('draw');
    expect(seen.notices).toEqual(['draw-offered']);
    const accept = run(seen.state, { type: 'answer', kind: 'draw', accept: true });
    expect(accept.state.game!.result).toEqual({ winner: null, reason: 'agreement' });
    const back = deliver(accept, offer.state);
    expect(back.state.game!.result).toEqual({ winner: null, reason: 'agreement' });
    expect(back.state.offer).toBeUndefined();
  });

  it('declined offers clear on both sides', () => {
    const [h, g] = connect();
    const offer = run(g, { type: 'offer', kind: 'draw' });
    const seen = deliver(offer, h);
    const decline = run(seen.state, { type: 'answer', kind: 'draw', accept: false });
    expect(decline.state.offer).toBeUndefined();
    const back = deliver(decline, offer.state);
    expect(back.state.offer).toBeUndefined();
    expect(back.notices).toEqual(['draw-declined']);
    expect(back.state.game!.result).toBeUndefined();
  });

  it('draw offers expire when a move is made', () => {
    const [h, g] = connect();
    const offer = run(h, { type: 'offer', kind: 'draw' }, { type: 'move', move: '11-15' });
    expect(offer.state.offer).toBeUndefined();
    const seen = deliver(offer, g);
    expect(seen.state.offer).toBeUndefined();
    expect(run(seen.state, { type: 'answer', kind: 'draw', accept: true }).ok).toBe(false);
  });

  it('a stale draw acceptance is ignored', () => {
    const [h] = connect();
    const offered = run(h, { type: 'offer', kind: 'draw' });
    const moved = run(offered.state, { type: 'move', move: '11-15' });
    const late = run(moved.state, recv({ t: 'answer', kind: 'draw', gameId: h.game!.id, ply: 0, accept: true }));
    expect(late.state.game!.result).toBeUndefined();
  });

  it('an acceptance that crosses the offerer’s next move is cancelled with a notice', () => {
    let [h, g] = connect();
    const m1 = run(h, { type: 'move', move: '11-15' });
    g = deliver(m1, g).state;
    const m2 = run(g, { type: 'move', move: '23-19' });
    h = deliver(m2, m1.state).state;
    const offer = run(h, { type: 'offer', kind: 'draw' });
    g = deliver(offer, m2.state).state;
    const move = run(offer.state, { type: 'move', move: '8-11' });
    const accept = run(g, { type: 'answer', kind: 'draw', accept: true });
    expect(accept.state.game!.result).toEqual({ winner: null, reason: 'agreement' });
    expect(accept.notices).toEqual(['draw-agreed']);
    const guestSees = deliver(move, accept.state);
    const hostSees = deliver(accept, move.state);
    const guestNotices = [...guestSees.notices];
    const [hf, gf] = pump(hostSees.state, guestSees.state, hostSees.send, guestSees.send, guestNotices);
    expect(hf.game!.moves).toEqual(['11-15', '23-19', '8-11']);
    expect(gf.game).toEqual(hf.game);
    expect(gf.game!.result).toBeUndefined();
    expect(guestNotices).toEqual(['draw-cancelled']);
  });

  it('mutual draw offers become an agreement', () => {
    const [h, g] = connect();
    const ho = run(h, { type: 'offer', kind: 'draw' });
    const go = run(g, { type: 'offer', kind: 'draw' });
    const h2 = deliver(go, ho.state);
    const g2 = deliver(ho, go.state);
    expect(h2.state.game!.result?.reason).toBe('agreement');
    expect(g2.state.game!.result?.reason).toBe('agreement');
  });

  it('rematch swaps colors and only the host creates the game', () => {
    const [h, g] = connect();
    const done = run(h, { type: 'resign' });
    const gDone = deliver(done, g).state;
    const ask = run(gDone, { type: 'offer', kind: 'rematch' });
    expect(ask.send).toEqual([{ t: 'offer', kind: 'rematch', gameId: h.game!.id, ply: 0 }]);
    const hostSees = deliver(ask, done.state);
    expect(incomingOffer(hostSees.state)).toBe('rematch');
    const accept = run(hostSees.state, { type: 'answer', kind: 'rematch', accept: true });
    expect(accept.send.map((m) => m.t)).toEqual(['start']);
    expect(accept.state.game).toEqual({ id: expect.stringMatching(/^1\./), hostSide: 1, moves: [] });
    const guestGets = deliver(accept, ask.state);
    expect(guestGets.state.game).toEqual(accept.state.game);
    expect(guestGets.state.offer).toBeUndefined();
  });

  it('host-offered rematch accepted by guest: guest answers, host starts', () => {
    const [h, g] = connect();
    const done = run(h, { type: 'resign' });
    const gDone = deliver(done, g).state;
    const ask = run(done.state, { type: 'offer', kind: 'rematch' });
    const guestSees = deliver(ask, gDone);
    const accept = run(guestSees.state, { type: 'answer', kind: 'rematch', accept: true });
    expect(accept.send.map((m) => m.t)).toEqual(['answer']);
    expect(accept.state.game!.id).toBe(h.game!.id);
    const hostStarts = deliver(accept, ask.state);
    expect(hostStarts.send.map((m) => m.t)).toEqual(['start']);
    expect(hostStarts.state.game!.hostSide).toBe(1);
    expect(deliver(hostStarts, accept.state).state.game).toEqual(hostStarts.state.game);
  });

  it('rematch cannot be offered during a game and draw cannot be offered after', () => {
    const [h] = connect();
    expect(run(h, { type: 'offer', kind: 'rematch' }).ok).toBe(false);
    const done = run(h, { type: 'resign' });
    expect(run(done.state, { type: 'offer', kind: 'draw' }).ok).toBe(false);
  });

  it('pending offers survive a reconnect through sync', () => {
    const [h, g] = connect();
    const offline = run(h, { type: 'link-down' }, { type: 'offer', kind: 'draw' });
    expect(offline.send).toEqual([]);
    const [, g2] = reconnect(offline.state, g);
    expect(incomingOffer(g2)).toBe('draw');
  });
});

describe('resign while offline and resync', () => {
  it('a resignation made offline reaches the peer by sync', () => {
    const [h, g] = connect();
    const off = run(g, { type: 'link-down' }, { type: 'resign' });
    expect(off.send).toEqual([]);
    const [h2] = reconnect(h, off.state);
    expect(h2.game!.result).toEqual({ winner: 0, reason: 'resign' });
  });

  it('ping digests trigger a sync when states differ', () => {
    const [h, g] = connect();
    const moved = run(h, { type: 'move', move: '11-15' });
    const ping = run(moved.state, { type: 'tick' });
    expect(ping.send).toEqual([{ t: 'ping', n: 1, ply: 1, hash: expect.any(String) }]);
    const r = deliver(ping, g);
    expect(r.send.map((m) => m.t)).toEqual(['pong', 'sync']);
    const healed = deliver(r, ping.state);
    expect(healed.send.map((m) => m.t)).toEqual(['sync']);
    expect(deliver(healed, r.state).state.game!.moves).toEqual(['11-15']);
  });

  it('bye returns the session to not-ready', () => {
    const [h] = connect();
    const r = run(h, recv({ t: 'bye' }));
    expect(r.state.link).toBe('open');
    expect(r.notices).toEqual(['peer-left']);
  });
});

