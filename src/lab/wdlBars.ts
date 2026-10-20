import type { GenerationSummary, TrainingManifest, WDL } from '../shared/formats.ts';
import { opponentLabel, orderedOpponents } from './data.ts';
import { h } from './dom.ts';

export function wdlScore(r: WDL): number {
  const n = r.w + r.d + r.l;
  return n ? (r.w + r.d / 2) / n : 0;
}

function pct(n: number, total: number): string {
  return `${Math.round((n / total) * 100)}%`;
}

function segment(kind: 'w' | 'd' | 'l', n: number, total: number): HTMLElement | null {
  if (!n) return null;
  const share = n / total;
  const seg = h('span', { class: `wdl-seg wdl-${kind}`, style: `flex-grow:${n}` });
  if (share >= 0.14) seg.append(h('span', { class: 'wdl-seg-label' }, String(n)));
  return seg;
}

export function wdlBars(m: TrainingManifest, g: GenerationSummary): HTMLElement {
  const keys = orderedOpponents(g.vs);
  const wrap = h('div', { class: 'wdl', 'data-testid': 'wdl-bars' });
  if (!keys.length) {
    wrap.append(h('p', { class: 'lab-muted' }, 'No gauntlet results recorded for this generation.'));
    return wrap;
  }
  wrap.append(h('div', { class: 'wdl-legend', 'aria-hidden': 'true' },
    h('span', { class: 'wdl-key wdl-w' }, 'Win'),
    h('span', { class: 'wdl-key wdl-d' }, 'Draw'),
    h('span', { class: 'wdl-key wdl-l' }, 'Loss')));
  const list = h('ul', { class: 'wdl-list' });
  for (const key of keys) {
    const r = g.vs[key]!;
    const total = r.w + r.d + r.l;
    const name = opponentLabel(m, key, g.gen);
    const summary = `${r.w} wins, ${r.d} draws, ${r.l} losses against ${name}; score ${pct(r.w + r.d / 2, total)}`;
    list.append(h('li', { class: 'wdl-row', title: summary },
      h('span', { class: 'wdl-name' }, name),
      h('span', { class: 'wdl-bar', role: 'img', 'aria-label': summary },
        segment('w', r.w, total), segment('d', r.d, total), segment('l', r.l, total)),
      h('span', { class: 'wdl-score lab-num', 'aria-hidden': 'true' }, pct(r.w + r.d / 2, total))));
  }
  wrap.append(list);
  return wrap;
}
