import type { BaselineId, GenerationSummary, TrainingManifest } from '../shared/formats.ts';
import { compactNumber, h, s, signed } from './dom.ts';

export interface EloChartOptions {
  manifest: TrainingManifest;
  selected: number | null;
  onSelect(gen: number): void;
  onOpen(gen: number): void;
}

export interface EloChart {
  readonly el: HTMLElement;
  setSelected(gen: number | null): void;
  dispose(): void;
}

const MARGIN = { top: 14, right: 14, bottom: 30, left: 46 };

export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const mag = 10 ** Math.floor(Math.log10(span / Math.max(1, target)));
  const steps = [1, 2, 2.5, 5, 10].map((k) => k * mag);
  const step = steps.reduce((best, st) => (Math.abs(span / st - target) < Math.abs(span / best - target) ? st : best));
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

export interface EloLayout {
  x(gen: number): number;
  y(elo: number): number;
  genAtX(px: number): GenerationSummary | null;
  yTicks: number[];
  xTicks: number[];
  plot: { left: number; right: number; top: number; bottom: number };
}

export function eloLayout(m: TrainingManifest, width: number, height: number): EloLayout {
  const gens = m.generations;
  const plot = { left: MARGIN.left, right: Math.max(MARGIN.left + 10, width - MARGIN.right), top: MARGIN.top, bottom: Math.max(MARGIN.top + 10, height - MARGIN.bottom) };
  let lo = Infinity, hi = -Infinity;
  for (const g of gens) {
    lo = Math.min(lo, g.elo - g.eloErr);
    hi = Math.max(hi, g.elo + g.eloErr);
  }
  for (const b of m.baselines) {
    lo = Math.min(lo, b.elo);
    hi = Math.max(hi, b.elo);
  }
  if (!Number.isFinite(lo)) { lo = 900; hi = 1100; }
  const pad = Math.max(20, (hi - lo) * 0.06);
  const coarse = niceTicks(lo - pad, hi + pad, 5);
  const step = coarse.length > 1 ? coarse[1] - coarse[0] : 100;
  const yMin = Math.floor((lo - pad) / step) * step;
  const yMax = Math.ceil((hi + pad) / step) * step;
  const yTicks = niceTicks(yMin, yMax, height < 220 ? 3 : 5);
  const g0 = gens[0]?.gen ?? 0;
  const g1 = gens.at(-1)?.gen ?? 1;
  const xMin = g0 === g1 ? g0 - 1 : g0;
  const xMax = g0 === g1 ? g1 + 1 : g1;
  const x = (gen: number) => plot.left + ((gen - xMin) / (xMax - xMin)) * (plot.right - plot.left);
  const y = (elo: number) => plot.bottom - ((elo - yMin) / (yMax - yMin)) * (plot.bottom - plot.top);
  const xTicks = niceTicks(xMin, xMax, Math.max(2, Math.min(8, Math.floor((plot.right - plot.left) / 70)))).filter((t) => Number.isInteger(t) && t >= xMin && t <= xMax);
  const genAtX = (px: number): GenerationSummary | null => {
    let best: GenerationSummary | null = null;
    let bestDist = Infinity;
    for (const g of gens) {
      const d = Math.abs(x(g.gen) - px);
      if (d < bestDist) { bestDist = d; best = g; }
    }
    return best;
  };
  return { x, y, genAtX, yTicks, xTicks, plot };
}

function linePath(points: [number, number][]): string {
  return points.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
}

export function createEloChart(opts: EloChartOptions): EloChart {
  const { manifest } = opts;
  let selected = opts.selected;
  let hovered: number | null = null;
  let layout: EloLayout | null = null;
  let lastPointerType = 'mouse';

  const svg = s('svg', { class: 'elo-svg', role: 'img', 'aria-label': chartSummary(manifest) });
  const tooltip = h('div', { class: 'elo-tooltip', role: 'presentation', hidden: true });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const el = h('div', {
    class: 'elo-chart',
    tabindex: 0,
    'aria-label': 'Elo by generation. Left and right arrows choose a generation, Enter opens it.',
    'data-testid': 'elo-chart',
  }, svg, tooltip, live);

  function render(): void {
    const width = Math.max(240, Math.round(el.clientWidth || 600));
    const height = Math.max(180, Math.round(el.clientHeight || 280));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    const L = (layout = eloLayout(manifest, width, height));
    svg.replaceChildren();
    const { plot } = L;

    const grid = s('g', { class: 'elo-grid' });
    for (const t of L.yTicks) {
      const y = L.y(t);
      grid.append(s('line', { x1: plot.left, x2: plot.right, y1: y, y2: y }));
      grid.append(s('text', { x: plot.left - 8, y, class: 'elo-tick elo-tick-y', 'dominant-baseline': 'middle', 'text-anchor': 'end' }, String(t)));
    }
    for (const t of L.xTicks) {
      grid.append(s('text', { x: L.x(t), y: plot.bottom + 18, class: 'elo-tick', 'text-anchor': 'middle' }, String(t)));
    }
    grid.append(s('line', { x1: plot.left, x2: plot.right, y1: plot.bottom, y2: plot.bottom, class: 'elo-axis' }));
    svg.append(grid);

    const baselines = s('g', { class: 'elo-baselines' });
    const taken: LabelBox[] = [];
    for (const b of manifest.baselines) {
      const y = L.y(b.elo);
      const full = `${b.name} · ${Math.round(b.elo)}`;
      const short = `${BASELINE_SHORT[b.id]} · ${Math.round(b.elo)}`;
      const spot = placeBaselineLabel(manifest, L, y, [full, short], taken);
      taken.push(spot.box);
      baselines.append(s('line', { x1: plot.left, x2: plot.right, y1: y, y2: y, class: 'elo-baseline' }));
      const text = s('text', { x: spot.x, y: spot.baseline, class: 'elo-baseline-label', 'text-anchor': spot.anchor }, spot.text);
      if (spot.text !== full) text.append(s('title', {}, full));
      baselines.append(text);
    }
    svg.append(baselines);

    const gens = manifest.generations;
    if (gens.length > 1) {
      const upper = gens.map((g) => [L.x(g.gen), L.y(g.elo + g.eloErr)] as [number, number]);
      const lower = gens.map((g) => [L.x(g.gen), L.y(g.elo - g.eloErr)] as [number, number]).reverse();
      svg.append(s('path', { d: linePath([...upper, ...lower]) + 'Z', class: 'elo-band' }));
      svg.append(s('path', { d: linePath(gens.map((g) => [L.x(g.gen), L.y(g.elo)])), class: 'elo-line' }));
    } else if (gens.length === 1) {
      const g = gens[0];
      svg.append(s('line', { x1: L.x(g.gen), x2: L.x(g.gen), y1: L.y(g.elo + g.eloErr), y2: L.y(g.elo - g.eloErr), class: 'elo-errbar' }));
    }

    const r = gens.length > 80 ? 2.5 : 3.5;
    const points = s('g', { class: 'elo-points' });
    for (const g of gens) {
      const cls = ['elo-point'];
      if (g.gen === manifest.champion) cls.push('is-champion');
      if (g.net) cls.push('has-net');
      points.append(s('circle', { cx: L.x(g.gen), cy: L.y(g.elo), r, class: cls.join(' '), 'data-gen': g.gen }));
    }
    svg.append(points);

    if (manifest.champion !== null) {
      const champ = gens.find((g) => g.gen === manifest.champion);
      if (champ) {
        const cx = L.x(champ.gen), cy = L.y(champ.elo);
        svg.append(s('circle', { cx, cy, r: 7.5, class: 'elo-champion-ring' }));
        const labelLeft = cx > plot.right - 90;
        svg.append(s('text', { x: labelLeft ? cx - 11 : cx + 11, y: cy - 10, class: 'elo-champion-label', 'text-anchor': labelLeft ? 'end' : 'start' }, 'champion'));
      }
    }

    svg.append(s('g', { class: 'elo-overlay' }));
    svg.append(s('rect', { x: plot.left - 8, y: 0, width: plot.right - plot.left + 16, height: plot.bottom + 8, class: 'elo-hit' }));
    drawOverlay();
  }

  function drawOverlay(): void {
    const overlay = svg.querySelector('.elo-overlay');
    if (!overlay || !layout) return;
    const L = layout;
    overlay.replaceChildren();
    const sel = selected !== null ? manifest.generations.find((g) => g.gen === selected) : undefined;
    if (sel) {
      const x = L.x(sel.gen);
      overlay.append(s('line', { x1: x, x2: x, y1: L.plot.top, y2: L.plot.bottom, class: 'elo-selected-rule' }));
      overlay.append(s('circle', { cx: x, cy: L.y(sel.elo), r: 6, class: 'elo-selected-dot', 'data-testid': 'elo-selected' }));
    }
    const hov = hovered !== null ? manifest.generations.find((g) => g.gen === hovered) : undefined;
    if (hov && hov.gen !== sel?.gen) {
      const x = L.x(hov.gen);
      overlay.append(s('line', { x1: x, x2: x, y1: L.plot.top, y2: L.plot.bottom, class: 'elo-crosshair' }));
      overlay.append(s('circle', { cx: x, cy: L.y(hov.elo), r: 5, class: 'elo-hover-dot' }));
    }
    drawTooltip(hov ?? null);
  }

  function drawTooltip(g: GenerationSummary | null): void {
    if (!g || !layout) {
      tooltip.hidden = true;
      return;
    }
    const prev = manifest.generations[manifest.generations.indexOf(g) - 1];
    const rows: (Node | string)[] = [
      h('div', { class: 'elo-tt-head' }, `Gen ${g.gen}`, g.gen === manifest.champion ? h('span', { class: 'elo-tt-badge' }, 'champion') : null),
      h('div', { class: 'elo-tt-value' }, h('strong', {}, String(Math.round(g.elo))), h('span', {}, ` ± ${Math.round(g.eloErr)} Elo`)),
    ];
    if (prev) rows.push(h('div', { class: 'elo-tt-row' }, h('span', {}, 'vs prev'), h('span', { class: 'lab-num' }, signed(g.elo - prev.elo))));
    rows.push(h('div', { class: 'elo-tt-row' }, h('span', {}, 'games'), h('span', { class: 'lab-num' }, compactNumber(g.games))));
    rows.push(h('div', { class: 'elo-tt-hint' }, openHint(lastPointerType, g.gen === selected)));
    tooltip.replaceChildren(...rows);
    tooltip.hidden = false;
    const x = layout.x(g.gen);
    const y = layout.y(g.elo);
    const w = el.clientWidth;
    const ttW = tooltip.offsetWidth || 150;
    const left = Math.min(Math.max(4, x - ttW / 2), w - ttW - 4);
    const above = y - (tooltip.offsetHeight || 80) - 14;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${above < 0 ? y + 14 : above}px`;
  }

  function genFromEvent(ev: PointerEvent): GenerationSummary | null {
    if (!layout) return null;
    const rect = svg.getBoundingClientRect();
    const scale = rect.width ? (Number(svg.getAttribute('width')) || rect.width) / rect.width : 1;
    return layout.genAtX((ev.clientX - rect.left) * scale);
  }

  function onPointerMove(ev: PointerEvent): void {
    lastPointerType = ev.pointerType || 'mouse';
    if (lastPointerType !== 'mouse') return;
    const g = genFromEvent(ev);
    if (g?.gen !== hovered) {
      hovered = g?.gen ?? null;
      drawOverlay();
    }
  }

  function onPointerLeave(ev: PointerEvent): void {
    if ((ev.pointerType || 'mouse') !== 'mouse') return;
    hovered = null;
    drawOverlay();
  }

  function onPointerUp(ev: PointerEvent): void {
    lastPointerType = ev.pointerType || 'mouse';
    const target = ev.target as Element | null;
    if (!target?.closest('.elo-hit')) return;
    const g = genFromEvent(ev);
    if (!g) return;
    if (lastPointerType === 'mouse' || g.gen === selected) {
      opts.onOpen(g.gen);
      return;
    }
    selected = g.gen;
    hovered = g.gen;
    opts.onSelect(g.gen);
    drawOverlay();
  }

  function onKey(ev: KeyboardEvent): void {
    const gens = manifest.generations;
    if (!gens.length) return;
    const idx = Math.max(0, gens.findIndex((g) => g.gen === selected));
    let next = idx;
    if (ev.key === 'ArrowLeft') next = idx - 1;
    else if (ev.key === 'ArrowRight') next = idx + 1;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = gens.length - 1;
    else if (ev.key === 'Enter' || ev.key === ' ') {
      if (selected !== null) opts.onOpen(selected);
      ev.preventDefault();
      return;
    } else return;
    ev.preventDefault();
    next = Math.max(0, Math.min(gens.length - 1, next));
    const g = gens[next];
    selected = g.gen;
    lastPointerType = 'keyboard';
    hovered = g.gen;
    opts.onSelect(g.gen);
    drawOverlay();
    live.textContent = `Generation ${g.gen}, Elo ${Math.round(g.elo)} plus or minus ${Math.round(g.eloErr)}`;
  }

  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerleave', onPointerLeave);
  svg.addEventListener('pointerup', onPointerUp);
  el.addEventListener('keydown', onKey);
  el.addEventListener('blur', () => {
    if (lastPointerType === 'keyboard') { hovered = null; drawOverlay(); }
  });

  let raf = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(render);
  });
  ro.observe(el);
  queueMicrotask(render);

  return {
    el,
    setSelected(gen) {
      if (gen === selected) return;
      selected = gen;
      drawOverlay();
    },
    dispose() {
      ro.disconnect();
      cancelAnimationFrame(raf);
    },
  };
}

const BASELINE_SHORT: Record<BaselineId, string> = { random: 'Rnd', heur2: 'H2', heur4: 'H4', heur6: 'H6' };
const LABEL_CHAR_PX = 6.2;
const LABEL_INSET = 4;
const LABEL_GAP = 2;
const LABEL_HEIGHT = 14;
const LABEL_DESCENT = 3;
const POINT_PAD = 4;

export interface LabelBox { left: number; right: number; top: number; bottom: number }

export interface BaselineLabelSpot {
  text: string;
  x: number;
  baseline: number;
  anchor: 'start' | 'end';
  box: LabelBox;
}

export function placeBaselineLabel(m: TrainingManifest, L: EloLayout, y: number, texts: readonly string[], taken: readonly LabelBox[] = []): BaselineLabelSpot {
  let best: { spot: BaselineLabelSpot; clearance: number } | null = null;
  for (const text of texts) {
    for (const spot of labelSpots(L, y, text)) {
      const clearance = labelClearance(m, L, spot.box, taken);
      if (clearance >= 0) return spot;
      if (!best || clearance > best.clearance) best = { spot, clearance };
    }
  }
  return best!.spot;
}

function labelSpots(L: EloLayout, y: number, text: string): BaselineLabelSpot[] {
  const width = text.length * LABEL_CHAR_PX;
  const above = y - LABEL_GAP - LABEL_DESCENT;
  const below = y + LABEL_GAP + LABEL_HEIGHT - LABEL_DESCENT;
  const spots: BaselineLabelSpot[] = [];
  for (const baseline of [above, below]) {
    for (const anchor of ['end', 'start'] as const) {
      const x = anchor === 'end' ? L.plot.right - LABEL_INSET : L.plot.left + LABEL_INSET;
      const left = anchor === 'end' ? x - width : x;
      const bottom = baseline + LABEL_DESCENT;
      spots.push({ text, x, baseline, anchor, box: { left, right: left + width, top: bottom - LABEL_HEIGHT, bottom } });
    }
  }
  return spots;
}

function labelClearance(m: TrainingManifest, L: EloLayout, box: LabelBox, taken: readonly LabelBox[]): number {
  if (box.bottom > L.plot.bottom || box.top < 0) return -Infinity;
  let min = Infinity;
  for (const t of taken) {
    if (t.right <= box.left || t.left >= box.right) continue;
    min = Math.min(min, verticalGap(box, t.top, t.bottom));
  }
  const band = bandExtent(m, L, box.left - POINT_PAD, box.right + POINT_PAD);
  if (band) min = Math.min(min, verticalGap(box, band.top - POINT_PAD, band.bottom + POINT_PAD));
  return min;
}

function verticalGap(box: LabelBox, top: number, bottom: number): number {
  if (bottom <= box.top) return box.top - bottom;
  if (top >= box.bottom) return top - box.bottom;
  return -Math.min(bottom - box.top, box.bottom - top);
}

function bandExtent(m: TrainingManifest, L: EloLayout, from: number, to: number): { top: number; bottom: number } | null {
  const gens = m.generations;
  let top = Infinity, bottom = -Infinity;
  const include = (hi: number, lo: number) => {
    top = Math.min(top, hi);
    bottom = Math.max(bottom, lo);
  };
  for (let i = 0; i < gens.length; i++) {
    const x = L.x(gens[i].gen);
    if (x >= from && x <= to) include(L.y(gens[i].elo + gens[i].eloErr), L.y(gens[i].elo - gens[i].eloErr));
    const next = gens[i + 1];
    if (!next) continue;
    const nx = L.x(next.gen);
    for (const edge of [from, to]) {
      if (edge <= x || edge >= nx) continue;
      const k = (edge - x) / (nx - x);
      const lerp = (a: number, b: number) => a + (b - a) * k;
      include(L.y(lerp(gens[i].elo + gens[i].eloErr, next.elo + next.eloErr)), L.y(lerp(gens[i].elo - gens[i].eloErr, next.elo - next.eloErr)));
    }
  }
  return top <= bottom ? { top, bottom } : null;
}

function openHint(pointerType: string, isSelected: boolean): string {
  if (pointerType === 'mouse') return 'Click to open';
  if (pointerType === 'keyboard') return 'Enter to open';
  return isSelected ? 'Tap again to open' : 'Tap to select';
}

function chartSummary(m: TrainingManifest): string {
  const first = m.generations[0];
  const last = m.generations.at(-1);
  if (!first || !last) return 'Elo by generation: no data yet';
  const best = m.generations.reduce((a, b) => (b.elo > a.elo ? b : a));
  return `Elo by generation, ${m.generations.length} generations. Gen ${first.gen} at ${Math.round(first.elo)}, gen ${last.gen} at ${Math.round(last.elo)}, peak ${Math.round(best.elo)} at gen ${best.gen}.`;
}
