import { LEVELS, type LevelId } from '../ai/levels.ts';
import type { AppContext, Screen, ScreenFactory, Settings } from '../app/contracts.ts';
import { LATEST_RESUME, type ResumeRecord, clearResume, loadAiPrefs, loadResume, saveAiPrefs } from '../app/persist.ts';
import { DEFAULT_AI_LEVEL, type SideChoice, aiHash, formatHash } from '../app/router.ts';
import { getSettings, updateSettings } from '../app/settings.ts';
import { hapticsSupported } from '../audio/haptics.ts';
import { Game } from '../engine/game.ts';
import { initialPosition } from '../engine/position.ts';
import type { Side } from '../engine/types.ts';
import { initialIds } from '../game/pieceTracker.ts';
import { isTrainingManifest } from '../shared/formats.ts';
import { type Child, h, icon, iconButton } from './dom.ts';
import { miniBoard } from './miniBoard.ts';
import { openDialog } from './modal.ts';

const LEVEL_IDS: LevelId[] = [1, 2, 3, 4, 5];
const SIDE_CHOICES: { value: SideChoice; label: string; hint: string }[] = [
  { value: 0, label: 'Crimson', hint: 'moves first' },
  { value: 1, label: 'Ivory', hint: 'moves second' },
  { value: 'r', label: 'Random', hint: 'coin flip' },
];

function chipGroup<T>(label: string, options: { value: T; content: Child[]; className?: string }[], initial: T, onPick: (v: T) => void): HTMLElement {
  const buttons = options.map((o) => {
    const b = h('button', { type: 'button', class: `chip ${o.className ?? ''}`.trim(), 'aria-pressed': String(o.value === initial) }, ...o.content);
    b.addEventListener('click', () => {
      for (const other of buttons) other.setAttribute('aria-pressed', String(other === b));
      onPick(o.value);
    });
    return b;
  });
  return h('div', { class: 'chip-group', role: 'group', 'aria-label': label }, ...buttons);
}

function aiCard(ctx: AppContext): HTMLElement {
  const prefs = loadAiPrefs({ level: DEFAULT_AI_LEVEL, side: 0 });
  let level = prefs.level;
  let side = prefs.side;
  const levels = chipGroup('Difficulty', LEVEL_IDS.map((id) => ({
    value: id,
    className: 'chip-level',
    content: [h('span', { class: 'lvl-n' }, String(id)), h('span', { class: 'lvl-name' }, LEVELS[id].name)],
  })), level, (v) => (level = v));
  const sides = chipGroup('Your color', SIDE_CHOICES.map((c) => ({
    value: c.value,
    className: 'chip-side',
    content: [h('span', { class: `swatch swatch-${c.value === 0 ? 'crimson' : c.value === 1 ? 'ivory' : 'random'}`, 'aria-hidden': 'true' }), h('span', {}, c.label)],
  })), side, (v) => (side = v));
  const play = h('button', {
    type: 'button',
    class: 'btn btn-primary btn-block',
    onClick: () => {
      saveAiPrefs({ level, side });
      ctx.navigate(aiHash({ level, side }));
    },
  }, icon('play'), 'Play the AI');
  return h('section', { class: 'card card-ai', 'aria-labelledby': 'ai-card-title' },
    h('div', { class: 'card-head' },
      h('h2', { class: 'card-title', id: 'ai-card-title' }, 'Play the AI'),
      h('p', { class: 'card-sub' }, 'Pick a difficulty and a color'),
    ),
    h('p', { class: 'field-label', 'aria-hidden': 'true' }, 'Difficulty'),
    levels,
    h('p', { class: 'field-label', 'aria-hidden': 'true' }, 'You play'),
    sides,
    play,
  );
}

function menuLink(href: string, iconName: Parameters<typeof icon>[0], title: string, sub: HTMLElement | string): HTMLAnchorElement {
  return h('a', { class: 'menu-link', href },
    h('span', { class: 'menu-icon', 'aria-hidden': 'true' }, icon(iconName)),
    h('span', { class: 'menu-text' }, h('span', { class: 'menu-title' }, title), typeof sub === 'string' ? h('span', { class: 'menu-sub' }, sub) : sub),
    h('span', { class: 'menu-chevron', 'aria-hidden': 'true' }, icon('next')),
  );
}

function describeResume(r: ResumeRecord): { title: string; detail: string; orientation: Side } {
  const moveNo = Math.ceil(r.moves.length / 2);
  if (r.mode === 'ai') {
    return { title: `vs AI · ${LEVELS[r.level ?? DEFAULT_AI_LEVEL].name}`, detail: `Move ${moveNo} · you play ${r.humanSide === 1 ? 'Ivory' : 'Crimson'}`, orientation: r.humanSide ?? 0 };
  }
  return { title: 'Pass & play', detail: `Move ${moveNo}`, orientation: 0 };
}

function resumeCard(ctx: AppContext, r: ResumeRecord, onDiscard: () => void): HTMLElement | null {
  let game: Game;
  try {
    game = Game.fromMoves(r.moves, { startFen: r.startFen });
  } catch {
    clearResume();
    return null;
  }
  const d = describeResume(r);
  const last = game.moves[game.moves.length - 1];
  const resume = r.id ?? LATEST_RESUME;
  const href = r.mode === 'ai' ? aiHash({ resume }) : formatHash(['local'], { resume });
  const card = h('section', { class: 'card card-resume', 'aria-label': 'Resume your game' },
    h('div', { class: 'resume-thumb' }, miniBoard(game.position, { orientation: d.orientation, lastMove: last ? [last.from, last.to] : null, label: 'Saved position' })),
    h('div', { class: 'resume-text' },
      h('p', { class: 'eyebrow' }, 'Unfinished game'),
      h('p', { class: 'resume-title' }, d.title),
      h('p', { class: 'resume-detail' }, d.detail),
    ),
    h('div', { class: 'resume-actions' },
      h('button', { type: 'button', class: 'btn btn-primary', onClick: () => ctx.navigate(href) }, icon('resume'), 'Resume'),
      iconButton('close', 'Discard saved game', () => {
        clearResume();
        onDiscard();
      }, { class: 'icon-btn btn-quiet' }),
    ),
  );
  return card;
}

function labSubtitle(): HTMLElement {
  const el = h('span', { class: 'menu-sub' }, 'Watch the AI learn, generation by generation');
  void fetch(`${import.meta.env.BASE_URL}training/manifest.json`, { cache: 'no-cache' })
    .then((res) => (res.ok ? res.json() : null))
    .then((m: unknown) => {
      if (!isTrainingManifest(m) || m.generations.length === 0) return;
      const latest = m.generations[m.generations.length - 1];
      el.textContent = `Gen ${latest.gen} · Elo ${Math.round(latest.elo)} · ${m.totalGames.toLocaleString()} self-play games`;
    })
    .catch(() => undefined);
  return el;
}

function switchRow(label: string, hint: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', role: 'switch', class: 'switch-input' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'setting-row' }, h('span', { class: 'setting-text' }, h('span', {}, label), h('span', { class: 'setting-hint' }, hint)), input);
}

export function openSettings(): void {
  const s = getSettings();
  const quality = h('select', { class: 'select', 'aria-label': 'Graphics quality' },
    ...(['auto', 'high', 'low'] as Settings['quality'][]).map((q) => {
      const o = h('option', { value: q }, q === 'auto' ? 'Automatic' : q === 'high' ? 'High' : 'Battery saver');
      o.selected = q === s.quality;
      return o;
    }),
  );
  quality.addEventListener('change', () => updateSettings({ quality: quality.value as Settings['quality'] }));
  const name = h('input', { type: 'text', class: 'text-input', maxlength: 24, placeholder: 'Shown to friends online', autocomplete: 'nickname', 'aria-label': 'Your name' });
  name.value = s.name;
  name.addEventListener('change', () => updateSettings({ name: name.value.trim() }));
  const body = h('div', { class: 'settings-body' },
    switchRow('Sound', 'Wood clicks and chimes', s.sound, (v) => updateSettings({ sound: v })),
    hapticsSupported() ? switchRow('Vibration', 'Haptic taps on moves', s.haptics, (v) => updateSettings({ haptics: v })) : null,
    h('label', { class: 'setting-row' }, h('span', { class: 'setting-text' }, h('span', {}, 'Graphics'), h('span', { class: 'setting-hint' }, 'Battery saver lowers resolution and shadows')), quality),
    h('label', { class: 'setting-row setting-stack' }, h('span', { class: 'setting-text' }, h('span', {}, 'Your name')), name),
  );
  openDialog({ title: 'Settings', body, actions: [{ label: 'Done', kind: 'primary' }], className: 'settings-dialog' });
}

export const homeScreen: ScreenFactory = (ctx): Screen => {
  const slot = h('div', { class: 'board-slot home-board', 'aria-hidden': 'true' });
  const resumeHolder = h('div', { class: 'resume-holder' });
  const renderResume = () => {
    const r = loadResume();
    resumeHolder.replaceChildren(...(r ? [resumeCard(ctx, r, renderResume)].filter((x): x is HTMLElement => !!x) : []));
  };
  renderResume();

  const el = h('section', { class: 'screen home-screen' },
    h('header', { class: 'home-head' },
      h('div', { class: 'home-brand' },
        h('h1', { class: 'display home-title' }, 'Checkers'),
        h('p', { class: 'home-tagline' }, 'An engine that taught itself'),
      ),
      iconButton('gear', 'Settings', openSettings, { class: 'icon-btn home-gear' }),
    ),
    slot,
    h('nav', { class: 'home-menu', 'aria-label': 'Play' },
      resumeHolder,
      aiCard(ctx),
      h('div', { class: 'card menu-list' },
        menuLink('#/friend', 'link', 'Play a friend', 'Send a link — no account, no server'),
        menuLink('#/local', 'users', 'Pass & play', 'Two players on this device'),
        menuLink('#/lab', 'flask', 'Training Lab', labSubtitle()),
      ),
    ),
  );
  ctx.root.append(el);

  let disposed = false;
  void ctx.board().then(
    (board) => {
      if (disposed) return;
      board.setBoardSlot(slot);
      void board.setOrientation(0, false);
      board.setPosition(initialPosition(), initialIds(initialPosition()));
      board.setHighlights({});
      board.setVisible(true);
    },
    (err) => console.warn('3D board unavailable', err),
  );

  return {
    dispose() {
      disposed = true;
      el.remove();
    },
  };
};
