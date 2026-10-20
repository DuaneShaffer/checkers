import type { Side } from '../../engine/types.ts';
import { canShare, copyText, qrSvg, shareLink } from '../../net/invite.ts';
import type { AcceptResult } from '../../net/rooms.ts';
import { cleanName } from '../../net/wire.ts';
import { h } from '../dom.ts';
import type { Child } from '../dom.ts';

export const COPY = {
  timeout: 'Couldn’t connect directly — some networks (cellular / strict Wi-Fi) block peer-to-peer; try both on Wi-Fi.',
  keepOpen: 'Keep this tab open — the invite only works while this page stays open.',
  badLink: 'That link looks incomplete or damaged. Ask your friend to send it again.',
  roomFull: 'This game already has two players.',
  protoMismatch: 'You and your friend are on different versions of the game — both of you refresh the page.',
  desync: 'Your two games got out of step and couldn’t be repaired automatically.',
  otherTab: 'This game is open in another tab.',
  unsupported: 'This browser can’t make direct connections (WebRTC is unavailable). Try a current Chrome, Firefox, Safari or Edge.',
};

export const SIDE_LABEL: Record<Side, string> = { 0: 'Crimson', 1: 'Ivory' };

export const ACCEPT_MESSAGES: Record<Exclude<AcceptResult, 'ok' | 'duplicate'>, string> = {
  'bad-link': 'That doesn’t look like a complete reply link. Ask your friend to send it again.',
  'wrong-room': 'That reply belongs to a different invite.',
  'own-link': 'That’s your own link — paste the reply your friend sends back.',
  expired: 'This invite isn’t waiting for a reply anymore. Create a new one.',
};

export interface ScreenShell {
  el: HTMLElement;
  card: HTMLElement;
  setContent(...children: Child[]): void;
}

export function screenShell(root: HTMLElement, className = ''): ScreenShell {
  const card = h('div', { class: 'card ol-card' });
  const el = h('section', { class: `screen ol-screen ${className}`.trim() }, card);
  root.append(el);
  return {
    el,
    card,
    setContent(...children) {
      card.replaceChildren();
      for (const c of children) if (c) card.append(c);
      card.scrollTop = 0;
    },
  };
}

export function heading(eyebrow: string, title: string, lede?: Child): HTMLElement {
  return h('header', { class: 'ol-head' },
    h('p', { class: 'eyebrow' }, eyebrow),
    h('h1', { class: 'display ol-title' }, title),
    lede ? h('p', { class: 'ol-lede' }, lede) : null,
  );
}

export function callout(kind: 'warn' | 'error' | 'info' | 'ok', ...children: Child[]): HTMLElement {
  return h('p', { class: `ol-callout ol-callout-${kind}`, role: kind === 'error' ? 'alert' : null }, ...children);
}

export function actions(...children: Child[]): HTMLElement {
  return h('div', { class: 'ol-actions' }, ...children);
}

export function button(label: string, onClick: () => void, kind: 'primary' | 'ghost' | 'plain' = 'plain', props: Record<string, string> = {}): HTMLButtonElement {
  const cls = kind === 'plain' ? 'btn' : `btn btn-${kind}`;
  return h('button', { type: 'button', class: cls, onClick, ...props }, label);
}

export function linkButton(label: string, href: string, kind: 'primary' | 'ghost' | 'plain' = 'plain'): HTMLAnchorElement {
  return h('a', { class: kind === 'plain' ? 'btn' : `btn btn-${kind}`, href }, label);
}

export function spinner(label: string): HTMLElement {
  return h('div', { class: 'ol-progress', role: 'status' }, h('span', { class: 'ol-spinner', 'aria-hidden': 'true' }), h('span', {}, label));
}

export interface StatusLine {
  el: HTMLElement;
  set(text: string, tone?: 'wait' | 'ok' | 'error'): void;
}

export function statusLine(text: string): StatusLine {
  const label = h('span', {}, text);
  const el = h('p', { class: 'ol-status', 'data-tone': 'wait', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'ol-dot', 'aria-hidden': 'true' }), label);
  return {
    el,
    set(next, tone = 'wait') {
      label.textContent = next;
      el.dataset.tone = tone;
    },
  };
}

export function aboutOnlinePlay(): HTMLElement {
  return h('details', { class: 'ol-about' },
    h('summary', {}, 'About online play'),
    h('div', { class: 'ol-about-body' },
      h('p', {}, 'Your browser connects straight to your friend’s — there’s no game server and no account. Both of you need to be online with the game open at the same time.'),
      h('p', {}, 'Because the connection is direct, each player’s IP address is visible to the other. Only play with people you trust with that.'),
      h('p', {}, 'Some networks (cellular data, school or office Wi-Fi) block direct connections. If you can’t connect, try both on home Wi-Fi.'),
    ),
  );
}

export interface LinkPanelOptions {
  url: string;
  kind: 'invite' | 'reply';
  toast: (message: string, kind?: 'info' | 'error' | 'success') => void;
  shareTitle: string;
  shareText: string;
}

export function linkPanel(opts: LinkPanelOptions): HTMLElement {
  const field = h('textarea', {
    class: 'ol-link-text mono',
    readonly: true,
    rows: 3,
    spellcheck: 'false',
    'aria-label': opts.kind === 'invite' ? 'Invite link' : 'Reply link',
  });
  field.value = opts.url;
  field.addEventListener('focus', () => field.select());
  const qrHolder = h('div', { class: 'ol-qr', hidden: true });
  let qrLoaded = false;

  const copy = async () => {
    if (await copyText(opts.url)) opts.toast('Link copied', 'success');
    else {
      field.focus();
      field.select();
      opts.toast('Select the link and copy it', 'info');
    }
  };
  const share = async () => {
    const outcome = await shareLink(opts.url, opts.shareTitle, opts.shareText);
    if (outcome === 'copied') opts.toast('Link copied', 'success');
    else if (outcome === 'failed') {
      field.focus();
      field.select();
    }
  };
  const qrButton = button('QR code', () => void toggleQr(), 'plain', { 'aria-expanded': 'false' });
  const toggleQr = async () => {
    const show = qrHolder.hidden;
    qrHolder.hidden = !show;
    qrButton.setAttribute('aria-expanded', String(show));
    if (show && !qrLoaded) {
      qrLoaded = true;
      try {
        qrHolder.replaceChildren(await qrSvg(opts.url, opts.kind === 'invite' ? 'QR code for the invite link' : 'QR code for the reply link'));
      } catch {
        qrHolder.replaceChildren(h('p', { class: 'ol-fine' }, 'QR code unavailable.'));
      }
    }
  };

  const shareable = canShare(opts.url);
  return h('div', { class: 'ol-link', 'data-link-kind': opts.kind, 'data-url': opts.url },
    field,
    h('div', { class: 'ol-link-buttons' },
      shareable ? button('Share…', () => void share(), 'primary') : null,
      button('Copy link', () => void copy(), shareable ? 'plain' : 'primary'),
      qrButton,
    ),
    qrHolder,
  );
}

export interface PasteBoxOptions {
  label: string;
  onSubmit: (text: string) => void;
}

export function pasteBox(opts: PasteBoxOptions): { el: HTMLElement; setBusy(busy: boolean): void; clear(): void } {
  const id = `paste-${Math.random().toString(36).slice(2, 8)}`;
  const input = h('input', {
    id,
    type: 'text',
    class: 'text-input ol-paste-input mono',
    placeholder: 'Paste link or code',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    inputmode: 'url',
  });
  const submit = () => {
    const text = input.value.trim();
    if (text) opts.onSubmit(text);
  };
  const go = button('Connect', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  input.addEventListener('paste', () => setTimeout(submit, 0));
  const el = h('div', { class: 'ol-paste' },
    h('label', { class: 'ol-field-label', for: id }, opts.label),
    h('div', { class: 'ol-paste-row' }, input, go),
  );
  return {
    el,
    setBusy(busy) {
      input.disabled = busy;
      go.disabled = busy;
    },
    clear() {
      input.value = '';
    },
  };
}

export function nameField(initial: string): { el: HTMLElement; value(): string | undefined } {
  const id = `name-${Math.random().toString(36).slice(2, 8)}`;
  const input = h('input', {
    id,
    type: 'text',
    class: 'text-input',
    maxlength: 24,
    autocomplete: 'nickname',
    placeholder: 'Optional',
  });
  input.value = initial;
  return {
    el: h('div', { class: 'ol-field' }, h('label', { class: 'ol-field-label', for: id }, 'Your name'), input),
    value: () => cleanName(input.value),
  };
}

export function choiceChips<T extends string>(label: string, options: { value: T; label: string; swatch?: string }[], initial: T): { el: HTMLElement; value(): T } {
  let current = initial;
  const chips = options.map((o) =>
    h('button', {
      type: 'button',
      class: 'chip ol-chip',
      'aria-pressed': String(o.value === initial),
      'data-value': o.value,
      onClick: () => {
        current = o.value;
        for (const c of chips) c.setAttribute('aria-pressed', String(c.dataset.value === o.value));
      },
    }, o.swatch ? h('span', { class: `swatch swatch-${o.swatch}`, 'aria-hidden': 'true' }) : null, o.label),
  );
  const groupLabel = `grp-${Math.random().toString(36).slice(2, 8)}`;
  return {
    el: h('div', { class: 'ol-field' },
      h('p', { class: 'ol-field-label', id: groupLabel }, label),
      h('div', { class: 'ol-chips', role: 'group', 'aria-labelledby': groupLabel }, ...chips),
    ),
    value: () => current,
  };
}

export function steps(...items: string[]): HTMLElement {
  return h('ol', { class: 'ol-steps' }, ...items.map((t) => h('li', {}, t)));
}
