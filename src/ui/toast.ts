import { h } from './dom.ts';

export type ToastKind = 'info' | 'error' | 'success';

const MAX_VISIBLE = 3;

export interface Toaster {
  show(message: string, kind?: ToastKind): void;
}

export function createToaster(region: HTMLElement): Toaster {
  const recent = new Map<string, number>();
  return {
    show(message, kind = 'info') {
      const key = `${kind}:${message}`;
      const now = Date.now();
      if ((recent.get(key) ?? 0) > now - 1500) return;
      recent.set(key, now);
      const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
      region.append(el);
      while (region.children.length > MAX_VISIBLE) region.firstElementChild?.remove();
      const ttl = kind === 'error' ? 5200 : 3200;
      setTimeout(() => {
        el.classList.add('leaving');
        setTimeout(() => el.remove(), 260);
      }, ttl);
    },
  };
}
