type Attrs = Record<string, string | number | boolean | null | undefined>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

export function setAttrs(el: Element, attrs: Attrs): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) el.removeAttribute(k);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

export function button(label: Child | Child[], onClick: (ev: MouseEvent) => void, attrs: Attrs = {}): HTMLButtonElement {
  const b = h('button', { type: 'button', ...attrs }, ...(Array.isArray(label) ? label : [label]));
  b.addEventListener('click', onClick);
  return b;
}

export function icon(name: IconName): SVGSVGElement {
  return s('svg', { viewBox: '0 0 24 24', class: 'lab-icon', 'aria-hidden': 'true', focusable: 'false' }, s('path', { d: ICONS[name] }));
}

export type IconName = 'back' | 'play' | 'pause' | 'prev' | 'next' | 'first' | 'last' | 'chevronLeft' | 'chevronRight' | 'bolt';

const ICONS: Record<IconName, string> = {
  back: 'M15.5 4.5 8 12l7.5 7.5-1.4 1.4L5.2 12l8.9-8.9z',
  play: 'M7 4.5v15l12.5-7.5z',
  pause: 'M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z',
  prev: 'M16.5 5.2 9.7 12l6.8 6.8-1.4 1.4L6.9 12l8.2-8.2z',
  next: 'M7.5 5.2 14.3 12l-6.8 6.8 1.4 1.4 8.2-8.2-8.2-8.2z',
  first: 'M5 5h2v14H5zM18.5 5.2 11.7 12l6.8 6.8-1.4 1.4L8.9 12l8.2-8.2z',
  last: 'M17 5h2v14h-2zM5.5 5.2 12.3 12l-6.8 6.8 1.4 1.4 8.2-8.2-8.2-8.2z',
  chevronLeft: 'M14.6 6.4 9 12l5.6 5.6-1.4 1.4-7-7 7-7z',
  chevronRight: 'M9.4 6.4 15 12l-5.6 5.6 1.4 1.4 7-7-7-7z',
  bolt: 'M13 2 4.5 13.5H11L10 22l8.5-11.5H12z',
};

export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${trimZero((n / 1e6).toFixed(abs >= 1e7 ? 0 : 1))}M`;
  if (abs >= 1e4) return `${trimZero((n / 1e3).toFixed(abs >= 1e5 ? 0 : 1))}K`;
  return Math.round(n).toLocaleString('en-US');
}

function trimZero(s: string): string {
  return s.replace(/\.0$/, '');
}

export function formatHours(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return '0 h';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  return `${trimZero(h.toFixed(h < 10 ? 1 : 0))} h`;
}

export function signed(n: number): string {
  const r = Math.round(n);
  return r > 0 ? `+${r}` : r < 0 ? `−${-r}` : '±0';
}
