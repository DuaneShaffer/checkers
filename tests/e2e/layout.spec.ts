import { expect, test, type Page } from '@playwright/test';

const VIEWPORTS = [
  { width: 360, height: 640 },
  { width: 1440, height: 900 },
];

const SCREENS: { name: string; hash: string; selector: string }[] = [
  { name: 'home', hash: '#/', selector: '.home-screen' },
  { name: 'local game', hash: '#/local', selector: '.game-screen' },
  { name: 'AI game', hash: '#/ai?level=1&side=0', selector: '.game-screen' },
];

interface Problem {
  what: string;
  rect: { x: number; y: number; w: number; h: number };
}

async function openRoute(page: Page, hash: string): Promise<void> {
  const route = hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'home';
  await page.goto(`./?test=1${hash}`);
  await page.waitForFunction(
    (r) => document.documentElement.dataset.route === r && document.body.dataset.ready === '1',
    route,
    { timeout: 30_000 },
  );
}

async function layoutProblems(page: Page): Promise<{ overflow: number; small: Problem[]; offscreen: Problem[] }> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const describe = (el: Element) => {
      const label = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? '';
      return `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').split(' ')[0]} "${label}"`;
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const targets = [...document.querySelectorAll('button, a[href], select, input:not([type="checkbox"]), [role="button"], label:has(input[type="checkbox"])')]
      .filter(visible);
    const small: Problem[] = [];
    const offscreen: Problem[] = [];
    for (const el of targets) {
      const r = el.getBoundingClientRect();
      const rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      if (r.width < 43.5 || r.height < 43.5) small.push({ what: describe(el), rect });
      if (r.left < -0.5 || r.right > vw + 0.5) offscreen.push({ what: describe(el), rect });
    }
    for (const el of document.querySelectorAll('.ui *')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 0.5) offscreen.push({ what: describe(el), rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
    }
    return { overflow: document.documentElement.scrollWidth - vw, small, offscreen };
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    for (const screen of SCREENS) {
      test(`${screen.name}: no horizontal overflow and touch-sized controls`, async ({ page }) => {
        await openRoute(page, screen.hash);
        await expect(page.locator(screen.selector)).toBeVisible();
        const result = await layoutProblems(page);
        expect(result.overflow).toBeLessThanOrEqual(0);
        expect(result.small).toEqual([]);
        expect(result.offscreen).toEqual([]);
      });
    }

    test('settings dialog controls are touch-sized', async ({ page }) => {
      await openRoute(page, '#/');
      await page.getByRole('button', { name: 'Settings' }).click();
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
      const result = await layoutProblems(page);
      expect(result.small).toEqual([]);
      expect(result.overflow).toBeLessThanOrEqual(0);
    });

    test('game-over dialog fits and its buttons are touch-sized', async ({ page }) => {
      await openRoute(page, `#/local?fen=${encodeURIComponent('B:W14:B10')}`);
      await page.evaluate(() => window.__checkers!.playMove('10x17'));
      const dialog = page.getByRole('dialog', { name: 'Crimson wins' });
      await expect(dialog).toBeVisible();
      const result = await layoutProblems(page);
      expect(result.small).toEqual([]);
      expect(result.offscreen).toEqual([]);
      expect(result.overflow).toBeLessThanOrEqual(0);
    });
  });
}

test.describe('320px wide', () => {
  test.use({ viewport: { width: 320, height: 568 } });

  for (const screen of SCREENS) {
    test(`${screen.name}: no horizontal overflow`, async ({ page }) => {
      await openRoute(page, screen.hash);
      const result = await layoutProblems(page);
      expect(result.overflow).toBeLessThanOrEqual(0);
      expect(result.offscreen).toEqual([]);
    });
  }
});

for (const vp of [{ width: 640, height: 360 }, { width: 568, height: 320 }]) {
  test.describe(`small landscape ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test('the board keeps most of the height and controls stay in view', async ({ page }) => {
      await openRoute(page, '#/local');
      const slot = await page.locator('.board-slot').boundingBox();
      expect(slot!.width).toBeGreaterThanOrEqual(0.85 * (vp.height - 20));
      expect(slot!.height).toBeGreaterThanOrEqual(0.85 * (vp.height - 20));
      const result = await layoutProblems(page);
      expect(result.small).toEqual([]);
      expect(result.offscreen).toEqual([]);
      expect(result.overflow).toBeLessThanOrEqual(0);
    });
  });
}

test.describe('landscape phone', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test('game HUD sits in side rails beside the board', async ({ page }) => {
    await openRoute(page, '#/local');
    const slot = await page.locator('.board-slot').boundingBox();
    const a = await page.locator('.hud-a').boundingBox();
    const b = await page.locator('.hud-b').boundingBox();
    expect(slot && a && b).toBeTruthy();
    expect(a!.x + a!.width).toBeLessThanOrEqual(slot!.x + 1);
    expect(b!.x).toBeGreaterThanOrEqual(slot!.x + slot!.width - 1);
    const result = await layoutProblems(page);
    expect(result.small).toEqual([]);
    expect(result.overflow).toBeLessThanOrEqual(0);
  });
});
