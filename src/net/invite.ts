export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

export function appBaseUrl(): string {
  return location.origin + import.meta.env.BASE_URL;
}

export function inviteUrl(blob: string): string {
  return `${appBaseUrl()}#/join/${blob}`;
}

export function replyUrl(blob: string): string {
  return `${appBaseUrl()}#/answer/${blob}`;
}

export function canShare(url: string): boolean {
  try {
    return typeof navigator.share === 'function' && (typeof navigator.canShare !== 'function' || navigator.canShare({ url }));
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return legacyCopy(text);
  }
}

function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export async function shareLink(url: string, title: string, text: string): Promise<ShareOutcome> {
  if (canShare(url)) {
    try {
      await navigator.share({ title, text, url });
      return 'shared';
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
    }
  }
  return (await copyText(url)) ? 'copied' : 'failed';
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export async function qrSvg(text: string, label: string): Promise<SVGSVGElement> {
  const { encode } = await import('uqr');
  const qr = encode(text, { ecc: 'L', border: 2 });
  let d = '';
  qr.data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`;
    });
  });
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${qr.size} ${qr.size}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', String(qr.size));
  bg.setAttribute('height', String(qr.size));
  bg.setAttribute('fill', '#fff');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#111');
  svg.append(bg, path);
  return svg;
}
