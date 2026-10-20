import { h, type Child, type Props } from '../ui/dom.ts';

export function button(label: Child | Child[], onClick: (ev: MouseEvent) => void, props: Props = {}): HTMLButtonElement {
  const b = h('button', { type: 'button', ...props }, ...(Array.isArray(label) ? label : [label]));
  b.addEventListener('click', onClick);
  return b;
}

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

export function edgeFades(el: HTMLElement): () => void {
  el.classList.add('lab-fade-x');
  const update = () => {
    const max = el.scrollWidth - el.clientWidth;
    el.toggleAttribute('data-fade-start', max > 1 && el.scrollLeft > 1);
    el.toggleAttribute('data-fade-end', max > 1 && el.scrollLeft < max - 1);
  };
  el.addEventListener('scroll', update, { passive: true });
  const ro = new ResizeObserver(update);
  ro.observe(el);
  if (el.firstElementChild) ro.observe(el.firstElementChild);
  update();
  return () => {
    el.removeEventListener('scroll', update);
    ro.disconnect();
  };
}
