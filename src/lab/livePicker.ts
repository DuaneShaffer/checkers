import type { TrainingManifest } from '../shared/formats.ts';
import { generationsWithNets } from './data.ts';
import { h } from '../ui/dom.ts';
import { button } from './dom.ts';

export const THINK_PRESETS = [
  { ms: 150, label: 'Quick' },
  { ms: 500, label: 'Normal' },
  { ms: 1500, label: 'Deep' },
] as const;
export const DEFAULT_THINK_MS = 500;

export function liveRoute(a: number, b: number, thinkMs?: number): string {
  return `#/lab/live/${a}/${b}${thinkMs && thinkMs !== DEFAULT_THINK_MS ? `?ms=${thinkMs}` : ''}`;
}

export function matchupPicker(manifest: TrainingManifest, preset: { a?: number; b?: number; thinkMs?: number }, onStart: (a: number, b: number, thinkMs: number) => void): HTMLElement {
  const gens = generationsWithNets(manifest);
  const card = h('section', { class: 'lab-card live-card', 'aria-labelledby': 'live-title', 'data-testid': 'live-picker' },
    h('h2', { id: 'live-title', class: 'lab-card-title' }, 'Watch two generations play'),
    h('p', { class: 'lab-muted' }, 'Pit any two published networks against each other, live, on the board.'));
  if (gens.length === 0) {
    card.append(h('p', { class: 'lab-muted' }, 'No networks have been published yet.'));
    return card;
  }
  const last = gens.at(-1)!.gen;
  const champion = manifest.champion !== null && gens.some((g) => g.gen === manifest.champion) ? manifest.champion : last;
  const pickA = preset.a !== undefined && gens.some((g) => g.gen === preset.a) ? preset.a : champion;
  const pickB = preset.b !== undefined && gens.some((g) => g.gen === preset.b) ? preset.b : gens[0].gen;
  const select = (id: string, label: string, value: number, swatch: string) => {
    const sel = h('select', { id, class: 'select' }, ...gens.map((g) =>
      h('option', { value: g.gen, selected: g.gen === value }, `Gen ${g.gen}${g.gen === manifest.champion ? ' · champion' : ''} · ${Math.round(g.elo)}`)));
    return { sel, field: h('label', { class: 'lab-field', for: id }, h('span', { class: 'lab-field-label' }, h('span', { class: `swatch ${swatch}`, 'aria-hidden': 'true' }), label), sel) };
  };
  const A = select('live-a', 'Crimson', pickA, 'swatch-crimson');
  const B = select('live-b', 'Ivory', pickB, 'swatch-ivory');
  const think = h('select', { id: 'live-ms', class: 'select' }, ...THINK_PRESETS.map((t) =>
    h('option', { value: t.ms, selected: t.ms === (preset.thinkMs ?? DEFAULT_THINK_MS) }, `${t.label} · ${t.ms < 1000 ? `${t.ms} ms` : `${t.ms / 1000} s`}`)));
  card.append(
    h('div', { class: 'live-fields' }, A.field, B.field,
      h('label', { class: 'lab-field', for: 'live-ms' }, h('span', { class: 'lab-field-label' }, 'Think time'), think)),
    button('Watch live', () => onStart(Number(A.sel.value), Number(B.sel.value), Number(think.value)), { class: 'btn btn-primary', 'data-testid': 'live-start' }));
  return card;
}
