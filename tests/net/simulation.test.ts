import { describe, expect, it } from 'vitest';
import { Game, moveToString, mulberry32 } from '../../src/engine/index.ts';
import { OnlineDriver } from '../../src/net/onlineDriver.ts';
import type { RoomRecord } from '../../src/net/roomStore.ts';
import { isLegalLine } from '../../src/net/rules.ts';
import { LoopbackNetwork, NO_FAULTS, Scheduler } from '../support/loopbackTransport.ts';
import type { LoopbackTransport } from '../support/loopbackTransport.ts';

const CODE = 'ABCDE12345';

interface Peer {
  name: 'host' | 'guest';
  record: RoomRecord;
  driver: OnlineDriver;
  link: LoopbackTransport | null;
}

function baseRecord(role: 'host' | 'guest', firstHostSide: 0 | 1): RoomRecord {
  return { v: 1, code: CODE, role, clientId: `${role}-client`, name: role, firstHostSide, game: null, createdAt: 0, updatedAt: 0 };
}

function simulate(seed: number) {
  const rand = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const scheduler = new Scheduler();
  const faults = {
    drop: rand() * 0.2,
    duplicate: rand() * 0.15,
    minDelay: 1,
    maxDelay: 1 + Math.floor(rand() * 150),
  };
  const net = new LoopbackNetwork(scheduler, rand, faults);
  const clock = scheduler.clock();
  const firstHostSide = (rand() < 0.5 ? 0 : 1) as 0 | 1;
  let ids = 0;

  const newDriver = (peer: Peer) =>
    new OnlineDriver({
      record: peer.record,
      clock,
      save: (r) => {
        peer.record = r;
      },
      newGameId: (seq) => `${seq.toString(36)}.s${seed}x${ids++}`,
    });

  const makePeer = (record: RoomRecord, name: Peer['name']): Peer => {
    const peer = { name, record, link: null } as unknown as Peer;
    peer.driver = newDriver(peer);
    return peer;
  };

  const host = makePeer(baseRecord('host', firstHostSide), 'host');
  const guest = makePeer(baseRecord('guest', firstHostSide), 'guest');
  const peers = [host, guest];

  const connect = () => {
    host.driver.detach();
    guest.driver.detach();
    const [a, b] = net.connect(1 + Math.floor(rand() * 20));
    host.link = a;
    guest.link = b;
    host.driver.attach(a);
    guest.driver.attach(b);
  };

  const reload = (peer: Peer) => {
    peer.driver.dispose();
    peer.driver = newDriver(peer);
  };

  let chaos = true;
  let gamesFinished = 0;

  const act = (peer: Peer) => {
    const d = peer.driver;
    const snap = d.snapshot();
    const online = snap.online!;
    if (online.incomingOffer && rand() < 0.5) {
      d.answer(online.incomingOffer, rand() < 0.6);
      return;
    }
    if (snap.result) {
      if (!online.outgoingOffer && rand() < 0.3 && gamesFinished < 4) d.offer('rematch');
      return;
    }
    if (snap.mySides.length === 0) return;
    const game = Game.fromMoves(snap.moves);
    if (game.position.turn !== snap.mySides[0]) {
      if (rand() < 0.01) d.resign();
      return;
    }
    const r = rand();
    if (r < 0.006) d.resign();
    else if (r < 0.02 && !online.outgoingOffer) d.offer('draw');
    else {
      const moves = game.legalMoves();
      if (moves.length) expect(d.submitMove(moveToString(pick(moves)))).toBe(true);
    }
  };

  const schedulePlayer = (peer: Peer) => {
    const tick = () => {
      if (!chaos) return;
      act(peer);
      if (peer.driver.snapshot().result) gamesFinished = Math.max(gamesFinished, gameCount(peer));
      scheduler.after(20 + Math.floor(rand() * 400), tick);
    };
    scheduler.after(Math.floor(rand() * 200), tick);
  };

  const gameCount = (peer: Peer) => {
    const id = peer.driver.state.game?.id;
    return id ? Number.parseInt(id.split('.')[0], 36) + 1 : 0;
  };

  const scheduleChaos = () => {
    const tick = () => {
      if (!chaos) return;
      const r = rand();
      if (r < 0.25) {
        host.link?.close();
        scheduler.after(50 + Math.floor(rand() * 3000), connect);
      } else if (r < 0.4) {
        const victim = pick(peers);
        victim.link?.close();
        reload(victim);
        scheduler.after(100 + Math.floor(rand() * 2000), connect);
      }
      scheduler.after(500 + Math.floor(rand() * 4000), tick);
    };
    scheduler.after(1000 + Math.floor(rand() * 3000), tick);
  };

  connect();
  for (const p of peers) schedulePlayer(p);
  scheduleChaos();

  const chaosEnd = 40_000 + Math.floor(rand() * 40_000);
  scheduler.runUntil(chaosEnd);
  chaos = false;
  net.faults = NO_FAULTS;
  connect();
  scheduler.runUntil(chaosEnd + 20_000);

  return { host: host.driver, guest: guest.driver, net };
}

describe('loopback fault simulation', () => {
  const SEEDS = Number(process.env.SIM_SEEDS ?? 500);

  it(`converges to identical games across ${SEEDS} seeds`, () => {
    let totalMoves = 0;
    let finished = 0;
    let rematches = 0;
    let dropped = 0;
    const reasons = new Set<string>();
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { host, guest, net } = simulate(seed);
      dropped += net.dropped;
      const h = host.state;
      const g = guest.state;
      expect(h.game, `seed ${seed}: host has a game`).not.toBeNull();
      expect(g.game, `seed ${seed}: guest game`).toEqual(h.game);
      expect(isLegalLine(h.game!.moves), `seed ${seed}: legal`).toBe(true);
      expect(host.status, `seed ${seed}: host status`).toBe('connected');
      expect(guest.status, `seed ${seed}: guest status`).toBe('connected');
      totalMoves += h.game!.moves.length;
      if (h.game!.result) {
        finished++;
        reasons.add(h.game!.result.reason);
      }
      if (!h.game!.id.startsWith('0.')) rematches++;
      host.dispose();
      guest.dispose();
    }
    expect(totalMoves).toBeGreaterThan(SEEDS * 10);
    expect(finished).toBeGreaterThan(SEEDS / 10);
    expect(rematches).toBeGreaterThan(SEEDS / 10);
    expect(dropped).toBeGreaterThan(SEEDS);
    expect([...reasons]).toEqual(expect.arrayContaining(['resign', 'agreement']));
    if (process.env.SIM_STATS) console.log({ totalMoves, finished, rematches, dropped, reasons: [...reasons] });
  }, 600_000);
});
