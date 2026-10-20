import '../../styles/online.css';
import type { AppContext, RouteParams, Screen, ScreenFactory } from '../../app/contracts.ts';
import { updateSettings } from '../../app/settings.ts';
import type { Side } from '../../engine/types.ts';
import { inviteUrl, replyUrl } from '../../net/invite.ts';
import type { SignalPayload } from '../../net/protocol.ts';
import { deliverAnswerToWaitingTab } from '../../net/roomChannel.ts';
import { formatRoomCode, generateRoomCode, parseRoomCode } from '../../net/roomCode.ts';
import { deleteRoom, getClientId, loadRoom, pruneRooms, saveRoom } from '../../net/roomStore.ts';
import type { RoomRecord } from '../../net/roomStore.ts';
import { PendingInvite, acquireRoomLock, answerInvite, pendingInvite, stashLiveLink } from '../../net/rooms.ts';
import type { HandshakeStatus, RoomLock } from '../../net/rooms.ts';
import { webRtcSupported } from '../../net/rtcTransport.ts';
import { decodeSignal } from '../../net/signal.ts';
import { h } from '../dom.ts';
import { OnlineGameView } from './gameView.ts';
import {
  ACCEPT_MESSAGES, COPY, aboutOnlinePlay, actions, button, callout, choiceChips, heading, linkButton, linkPanel, nameField, pasteBox, screenShell, spinner, statusLine, steps,
} from './parts.ts';
import type { ScreenShell } from './parts.ts';

const REPLY_HINT_AFTER_MS = 45_000;

function defaultName(ctx: AppContext): string {
  return ctx.settings().name ?? '';
}

function rememberName(ctx: AppContext, name: string | undefined): void {
  if ((name ?? '') !== ctx.settings().name) updateSettings({ name: name ?? '' });
}

function routeArg(params: RouteParams): string {
  return params.path[1] ?? '';
}


function unsupported(shell: ScreenShell): void {
  shell.setContent(heading('Play a friend', 'Can’t connect from this browser'), callout('error', COPY.unsupported), actions(linkButton('Home', '#/', 'primary')));
}

function badLink(shell: ScreenShell, eyebrow: string): void {
  shell.setContent(
    heading(eyebrow, 'That link didn’t work'),
    callout('error', COPY.badLink),
    actions(linkButton('Play a friend', '#/friend', 'primary'), linkButton('Home', '#/', 'ghost')),
  );
}

export const friendScreen: ScreenFactory = (ctx) => {
  const shell = screenShell(ctx.root, 'ol-friend');
  let disposed = false;
  let invite: PendingInvite | null = null;
  let lock: RoomLock | null = null;
  let handedOff = false;
  let offStatus: (() => void) | null = null;
  let inviteCode: string | null = null;
  pruneRooms();

  if (!webRtcSupported()) unsupported(shell);
  else showSetup();

  function showSetup() {
    const name = nameField(defaultName(ctx));
    const side = choiceChips<'0' | '1' | 'r'>('You play', [
      { value: '0', label: 'Crimson · moves first', swatch: 'crimson' },
      { value: '1', label: 'Ivory', swatch: 'ivory' },
      { value: 'r', label: 'Random', swatch: 'random' },
    ], '0');
    shell.setContent(
      heading('Play a friend', 'Invite a friend', 'You’ll get a link to send. Your friend opens it and sends a link back — then you’re playing. No account, no server.'),
      name.el,
      side.el,
      actions(
        button('Create invite link', () => void create(name.value(), side.value()), 'primary', { 'data-action': 'create-invite' }),
        linkButton('Back', '#/', 'ghost'),
      ),
      aboutOnlinePlay(),
    );
  }

  function discardInvite() {
    offStatus?.();
    offStatus = null;
    invite?.cancel();
    invite = null;
    lock?.release();
    lock = null;
    if (inviteCode) deleteRoom(inviteCode);
    inviteCode = null;
  }

  async function create(name: string | undefined, choice: '0' | '1' | 'r') {
    discardInvite();
    rememberName(ctx, name);
    shell.setContent(heading('Play a friend', 'Preparing your invite…'), spinner('Finding a route to the internet (a few seconds)…'));
    const code = generateRoomCode();
    const firstHostSide = (choice === 'r' ? crypto.getRandomValues(new Uint8Array(1))[0] & 1 : Number(choice)) as Side;
    const now = Date.now();
    const record: RoomRecord = { v: 1, code, role: 'host', clientId: getClientId(), firstHostSide, game: null, createdAt: now, updatedAt: now };
    if (name) record.name = name;
    saveRoom(record);
    inviteCode = code;
    lock = await acquireRoomLock(code);
    if (disposed) {
      lock?.release();
      return;
    }
    try {
      invite = await PendingInvite.create({ code, role: 'host', name });
    } catch (err) {
      console.error(err);
      if (!disposed) {
        shell.setContent(
          heading('Play a friend', 'Couldn’t create an invite'),
          callout('error', 'Something went wrong preparing the connection. Check that you’re online and try again.'),
          actions(button('Try again', showSetup, 'primary'), linkButton('Home', '#/', 'ghost')),
        );
      }
      return;
    }
    if (disposed) {
      invite.cancel();
      lock?.release();
      return;
    }
    showInvite(invite, record, name);
  }

  function showInvite(inv: PendingInvite, record: RoomRecord, name: string | undefined) {
    const status = statusLine('Waiting for your friend’s reply…');
    const paste = pasteBox({ label: 'Got their reply? Paste it here', onSubmit: (text) => void submit(text) });
    const failure = h('div', { class: 'ol-failure' });
    shell.setContent(
      heading('Play a friend', 'Send this invite', h('span', {}, 'Room ', h('span', { class: 'mono ol-code', 'data-room-code': record.code }, formatRoomCode(record.code)))),
      steps('Send this link to your friend.', 'They’ll send you a reply link.', 'Open their reply on this device — or paste it below.'),
      linkPanel({
        url: inviteUrl(inv.blob),
        kind: 'invite',
        toast: ctx.toast,
        shareTitle: 'Checkers',
        shareText: `${name ?? 'Your friend'} invited you to a game of checkers`,
      }),
      callout('warn', COPY.keepOpen),
      paste.el,
      status.el,
      failure,
      actions(button('Cancel', () => ctx.navigate('#/'), 'ghost')),
      aboutOnlinePlay(),
    );

    async function submit(text: string) {
      paste.setBusy(true);
      const res = await inv.accept(text);
      if (disposed) return;
      if (res === 'ok' || res === 'duplicate') {
        paste.clear();
        return;
      }
      paste.setBusy(false);
      ctx.toast(ACCEPT_MESSAGES[res], 'error');
    }

    offStatus = inv.onStatus((s) => {
      if (disposed) return;
      if (s === 'connecting') {
        paste.setBusy(true);
        status.set(`Connecting${inv.peerName ? ` to ${inv.peerName}` : ''}…`);
      } else if (s === 'open') {
        handedOff = true;
        stashLiveLink(record.code, inv.handOff());
        ctx.navigate(`#/play/${record.code}`);
      } else if (s === 'timeout' || s === 'closed') {
        status.set(s === 'timeout' ? 'Still trying…' : 'Connection closed', 'error');
        failure.replaceChildren(
          callout('error', COPY.timeout),
          actions(button('Create a new invite', showSetup, 'primary'), linkButton('Home', '#/', 'ghost')),
        );
      }
    });
  }

  return {
    dispose() {
      disposed = true;
      offStatus?.();
      if (handedOff) return;
      invite?.orphan();
      lock?.release();
    },
  };
};

type JoinKind = 'fresh' | 'resume';

export const joinScreen: ScreenFactory = async (ctx, params) => {
  const shell = screenShell(ctx.root, 'ol-join');
  let disposed = false;
  let handedOff = false;
  let lock: RoomLock | null = null;
  let reply: { close(): void } | null = null;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  const screen: Screen = {
    dispose() {
      disposed = true;
      clearTimeout(hintTimer);
      if (handedOff) return;
      reply?.close();
      lock?.release();
    },
  };

  shell.setContent(spinner('Opening invite…'));
  const blob = routeArg(params);
  let offer: SignalPayload;
  try {
    offer = await decodeSignal(blob);
  } catch {
    if (!disposed) badLink(shell, 'Invitation');
    return screen;
  }
  if (disposed) return screen;
  if (!webRtcSupported()) {
    unsupported(shell);
    return screen;
  }

  const existing = loadRoom(offer.code);
  if (existing && existing.role === offer.role) showOwnLink(existing);
  else if (existing) showConfirm('resume', existing);
  else if (offer.role === 'guest' || offer.gameId) showNotHere();
  else showConfirm('fresh', null);
  return screen;

  function peerLabel(record: RoomRecord | null): string {
    return offer.name ?? record?.peerName ?? 'your friend';
  }

  function showOwnLink(record: RoomRecord) {
    shell.setContent(
      heading('Invitation', 'This is your own invite', 'Send this link to your friend — they need to open it on their device.'),
      linkPanel({ url: inviteUrl(blob), kind: 'invite', toast: ctx.toast, shareTitle: 'Checkers', shareText: 'Join my game of checkers' }),
      actions(
        record.game ? linkButton('Back to the game', `#/play/${record.code}`, 'primary') : null,
        linkButton('Home', '#/', record.game ? 'ghost' : 'primary'),
      ),
    );
  }

  function showNotHere() {
    shell.setContent(
      heading('Reconnect', 'Open this link where you were playing', 'This link continues a game that isn’t saved in this browser. If you opened it from a chat app, open it in the browser you played in — or copy it and paste it into that browser’s address bar.'),
      linkPanel({ url: inviteUrl(blob), kind: 'invite', toast: ctx.toast, shareTitle: 'Checkers', shareText: 'Checkers game link' }),
      actions(linkButton('Home', '#/', 'ghost')),
    );
  }

  function showConfirm(kind: JoinKind, record: RoomRecord | null) {
    const name = kind === 'fresh' ? nameField(defaultName(ctx)) : null;
    const who = peerLabel(record);
    shell.setContent(
      kind === 'fresh'
        ? heading('Invitation', offer.name ? `${offer.name} invited you to play` : 'You’re invited to play checkers', 'Join to get a reply link, then send it back to your friend. They need to keep their invite page open.')
        : heading('Reconnect', `Reconnect with ${who}`, 'Your game is saved on this device. Tap Reconnect, then send the reply link back.'),
      name?.el,
      actions(
        button(kind === 'fresh' ? 'Join game' : 'Reconnect', () => void join(kind, record, name?.value()), 'primary', { 'data-action': 'join' }),
        linkButton('Not now', '#/', 'ghost'),
      ),
      aboutOnlinePlay(),
    );
  }

  async function join(kind: JoinKind, existing: RoomRecord | null, name: string | undefined) {
    shell.setContent(heading('Invitation', kind === 'fresh' ? 'Joining…' : 'Reconnecting…'), spinner('Preparing your reply (a few seconds)…'));
    lock = await acquireRoomLock(offer.code, true);
    if (disposed) return;
    if (!lock) {
      shell.setContent(heading('Invitation', 'Game open elsewhere'), callout('error', COPY.otherTab), actions(button('Try again', () => void join(kind, existing, name), 'primary')));
      return;
    }
    let record = existing ?? loadRoom(offer.code);
    if (!record) {
      if (kind === 'fresh') rememberName(ctx, name);
      const now = Date.now();
      record = { v: 1, code: offer.code, role: 'guest', clientId: getClientId(), firstHostSide: 0, game: null, createdAt: now, updatedAt: now };
      if (name) record.name = name;
      if (offer.name) record.peerName = offer.name;
      saveRoom(record);
    }
    let result: Awaited<ReturnType<typeof answerInvite>>;
    try {
      result = await answerInvite(offer, { code: record.code, role: record.role, gameId: record.game?.id, name: record.name });
    } catch (err) {
      console.error(err);
      if (!disposed) {
        shell.setContent(
          heading('Invitation', 'This invite can’t be used'),
          callout('error', 'The invite may be from an incompatible browser or damaged. Ask your friend for a new invite link.'),
          actions(linkButton('Home', '#/', 'primary')),
        );
      }
      return;
    }
    if (disposed) {
      result.link.close();
      return;
    }
    reply = result.link;
    showReply(record, result.link, result.blob);
  }

  function showReply(record: RoomRecord, link: Awaited<ReturnType<typeof answerInvite>>['link'], replyBlob: string) {
    const who = peerLabel(record);
    const status = statusLine(`Waiting for ${who} to open your reply…`);
    const hint = h('div', { class: 'ol-hint' });
    shell.setContent(
      heading('Almost there', 'Send this link back', `${who === 'your friend' ? 'Your friend needs' : `${who} needs`} your reply to finish connecting. Send it back the same way you got the invite.`),
      linkPanel({
        url: replyUrl(replyBlob),
        kind: 'reply',
        toast: ctx.toast,
        shareTitle: 'Checkers reply',
        shareText: 'Here’s my reply — open it to start our game',
      }),
      status.el,
      hint,
      actions(button('Cancel', () => ctx.navigate('#/'), 'ghost')),
    );
    hintTimer = setTimeout(() => {
      hint.replaceChildren(callout('info', `Still waiting? ${who === 'your friend' ? 'Your friend' : who} must open your reply on the device where they made the invite, or paste it into that page. If they closed it, ask for a new invite.`));
    }, REPLY_HINT_AFTER_MS);
    const go = () => {
      handedOff = true;
      clearTimeout(hintTimer);
      stashLiveLink(record.code, link);
      ctx.navigate(`#/play/${record.code}`);
    };
    if (link.state === 'open') return go();
    link.onState((s) => {
      if (disposed) return;
      if (s === 'open') go();
      else if (s === 'closed') {
        status.set('Connection closed', 'error');
        hint.replaceChildren(callout('error', COPY.timeout), actions(linkButton('Home', '#/', 'ghost')));
      }
    });
  }
};

export const answerScreen: ScreenFactory = async (ctx, params) => {
  const shell = screenShell(ctx.root, 'ol-answer');
  let disposed = false;
  let handedOff = false;
  let off: (() => void) | null = null;
  let local: PendingInvite | undefined;
  const screen: Screen = {
    dispose() {
      disposed = true;
      off?.();
      if (!handedOff) local?.orphan();
    },
  };
  shell.setContent(spinner('Delivering reply…'));
  const blob = routeArg(params);
  let payload: SignalPayload;
  try {
    payload = await decodeSignal(blob);
  } catch {
    if (!disposed) badLink(shell, 'Reply');
    return screen;
  }
  if (disposed) return screen;
  const code = payload.code;
  const record = loadRoom(code);
  if (record && record.role === payload.role && !pendingInvite(code)) {
    shell.setContent(
      heading('Reply', 'This is your own reply link', `Send it to ${record.peerName ?? 'your friend'} — they need to open it (or paste it) on the device where they made the invite.`),
      linkPanel({ url: replyUrl(blob), kind: 'reply', toast: ctx.toast, shareTitle: 'Checkers reply', shareText: 'Here’s my reply — open it to start our game' }),
      actions(record.game ? linkButton('Back to the game', `#/play/${code}`, 'primary') : null, linkButton('Home', '#/', record.game ? 'ghost' : 'primary')),
    );
    return screen;
  }

  local = pendingInvite(code);
  if (local) {
    local.adopt();
    const inv = local;
    const res = await inv.accept(blob);
    if (disposed) return screen;
    if (res !== 'ok' && res !== 'duplicate') {
      shell.setContent(heading('Reply', 'That reply didn’t work'), callout('error', ACCEPT_MESSAGES[res]), actions(linkButton('Home', '#/', 'primary')));
      return screen;
    }
    const status = statusLine(`Connecting${payload.name ? ` to ${payload.name}` : ''}…`);
    shell.setContent(heading('Reply', 'Connecting…'), status.el);
    const onStatus = (s: HandshakeStatus) => {
      if (disposed) return;
      if (s === 'open') {
        handedOff = true;
        stashLiveLink(code, inv.handOff());
        ctx.navigate(`#/play/${code}`);
      } else if (s === 'timeout' || s === 'closed') {
        status.set('Couldn’t connect', 'error');
        shell.card.append(callout('error', COPY.timeout), actions(linkButton('Play a friend', '#/friend', 'primary'), linkButton('Home', '#/', 'ghost')));
      }
    };
    off = inv.onStatus(onStatus);
    if (inv.status !== 'waiting') onStatus(inv.status);
    return screen;
  }

  const ack = await deliverAnswerToWaitingTab(code, blob);
  if (disposed) return screen;
  if (ack === true) {
    shell.setContent(
      heading('Reply delivered', 'Connected — return to your game tab', 'Your game continues in the tab where you created the invite. You can close this tab.'),
      actions(button('Close this tab', () => window.close(), 'primary'), linkButton('Home', '#/', 'ghost')),
    );
    setTimeout(() => window.close(), 1500);
  } else if (ack === false) {
    shell.setContent(
      heading('Reply', 'Your game tab couldn’t use this reply'),
      callout('error', 'That invite already connected or expired. If you’re not playing yet, create a new invite.'),
      actions(linkButton('Play a friend', '#/friend', 'primary'), linkButton('Home', '#/', 'ghost')),
    );
  } else {
    shell.setContent(
      heading('Reply', 'Paste this into your invite page', 'We couldn’t find the page that’s waiting for this reply in this browser. Copy the reply and paste it into the “Paste it here” box on the invite page.'),
      linkPanel({ url: replyUrl(blob), kind: 'reply', toast: ctx.toast, shareTitle: 'Checkers reply', shareText: 'Checkers reply link' }),
      callout('info', 'If you closed the invite page, that invite has expired — create a new one and send it again.'),
      actions(linkButton('Play a friend', '#/friend', 'primary'), linkButton('Home', '#/', 'ghost')),
    );
  }
  return screen;
};

export const onlineGameScreen: ScreenFactory = async (ctx, params) => {
  const code = parseRoomCode(routeArg(params));
  const record = code ? loadRoom(code) : null;
  let disposed = false;
  let view: OnlineGameView | null = null;
  let shell: ScreenShell | null = null;
  const screen: Screen = {
    dispose() {
      disposed = true;
      view?.dispose();
      shell?.el.remove();
    },
  };

  if (!code || !record) {
    shell = screenShell(ctx.root, 'ol-missing');
    shell.setContent(
      heading('Online game', 'No saved game here', code ? `Room ${formatRoomCode(code)} isn’t saved in this browser. Open the game in the browser you played in, or start a new one.` : 'That game link isn’t valid.'),
      actions(linkButton('Play a friend', '#/friend', 'primary'), linkButton('Home', '#/', 'ghost')),
    );
    return screen;
  }

  const start = (lock: RoomLock) => {
    shell?.el.remove();
    shell = null;
    view = new OnlineGameView(ctx, code, lock, () => showMoved());
  };

  const showBusy = (moved: boolean) => {
    shell?.el.remove();
    shell = screenShell(ctx.root, 'ol-busy');
    shell.setContent(
      heading('Online game', moved ? 'This game moved to another tab' : COPY.otherTab, 'Only one tab can play a game at a time.'),
      actions(button('Use this tab', () => void takeOver(), 'primary', { 'data-action': 'use-this-tab' }), linkButton('Home', '#/', 'ghost')),
    );
  };

  const showMoved = () => {
    view?.dispose();
    view = null;
    if (!disposed) showBusy(true);
  };

  const takeOver = async () => {
    const lock = await acquireRoomLock(code, true);
    if (disposed) {
      lock?.release();
      return;
    }
    if (lock) start(lock);
    else ctx.toast('The other tab didn’t let go — close it and try again.', 'error');
  };

  const lock = await acquireRoomLock(code);
  if (disposed) {
    lock?.release();
    return screen;
  }
  if (lock) start(lock);
  else showBusy(false);
  return screen;
};
