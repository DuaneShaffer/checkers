import { h, icon } from './dom.ts';

export interface DialogAction {
  label: string;
  kind?: 'primary' | 'danger' | 'ghost';
  onSelect?: () => void;
  keepOpen?: boolean;
}

export interface DialogOptions {
  title: string;
  eyebrow?: string;
  message?: string;
  body?: Node;
  actions: DialogAction[];
  dismissible?: boolean;
  className?: string;
  onClose?: () => void;
}

export interface DialogHandle {
  readonly el: HTMLDialogElement;
  close(): void;
}

const open = new Set<DialogHandle>();

export function openDialog(opts: DialogOptions): DialogHandle {
  const dismissible = opts.dismissible ?? true;
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const el = h('dialog', { class: `dialog ${opts.className ?? ''}`.trim(), 'aria-labelledby': titleId });
  let closed = false;
  const handle: DialogHandle = {
    el,
    close() {
      if (closed) return;
      closed = true;
      open.delete(handle);
      if (el.open) el.close();
      el.remove();
      opts.onClose?.();
    },
  };
  const actions = opts.actions.map((a) =>
    h('button', {
      type: 'button',
      class: `btn ${a.kind ? `btn-${a.kind}` : ''}`.trim(),
      onClick: () => {
        a.onSelect?.();
        if (!a.keepOpen) handle.close();
      },
    }, a.label),
  );
  el.append(
    h('div', { class: 'dialog-card' },
      dismissible ? h('button', { type: 'button', class: 'icon-btn dialog-close', 'aria-label': 'Close', onClick: () => handle.close() }, icon('close')) : null,
      opts.eyebrow ? h('p', { class: 'dialog-eyebrow' }, opts.eyebrow) : null,
      h('h2', { class: 'dialog-title', id: titleId }, opts.title),
      opts.message ? h('p', { class: 'dialog-message' }, opts.message) : null,
      opts.body ?? null,
      h('div', { class: 'dialog-actions' }, ...actions),
    ),
  );
  el.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (dismissible) handle.close();
  });
  el.addEventListener('click', (e) => {
    if (dismissible && e.target === el) handle.close();
  });
  document.body.append(el);
  open.add(handle);
  if (typeof el.showModal === 'function') el.showModal();
  else el.setAttribute('open', '');
  (actions.find((_, i) => opts.actions[i].kind === 'primary') ?? actions[0])?.focus();
  return handle;
}

export function confirmDialog(opts: { title: string; message?: string; confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    openDialog({
      title: opts.title,
      message: opts.message,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: opts.confirm, kind: opts.danger ? 'danger' : 'primary', onSelect: () => { answered = true; resolve(true); } },
      ],
      onClose: () => queueMicrotask(() => { if (!answered) resolve(false); }),
    });
  });
}

export function closeAllDialogs(): void {
  for (const d of [...open]) d.close();
}

export function anyDialogOpen(): boolean {
  return open.size > 0;
}
