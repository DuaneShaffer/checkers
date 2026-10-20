import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const FIXTURES = join(import.meta.dirname, '../fixtures/training');
const ENTRY = process.env.LAB_E2E_HARNESS ? './tests/fixtures/training/harness/index.html?test=1' : './?test=1';
const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8')) as { generations: { gen: number }[]; champion: number };

async function serveFixtures(page: Page, opts: { empty?: boolean } = {}): Promise<void> {
  await page.route((url) => url.pathname.includes('/training/') && !url.pathname.includes('/tests/fixtures/'), async (route) => {
    const rel = new URL(route.request().url()).pathname.replace(/^.*\/training\//, '');
    const file = rel === 'manifest.json' && opts.empty ? 'manifest-empty.json' : rel;
    try {
      const body = readFileSync(join(FIXTURES, file));
      await route.fulfill({ status: 200, body, contentType: file.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    } catch {
      await route.fulfill({ status: 404, body: 'not found' });
    }
  });
}

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`${ENTRY}${hash}`);
}

const BOARD_READY_MS = 45_000;
const SETTLE_MS = 15_000;

async function openReplay(page: Page, hash: string): Promise<void> {
  await open(page, hash);
  await expect(page.getByTestId('lab-replay')).toHaveAttribute('data-board', 'ready', { timeout: BOARD_READY_MS });
}

async function expectTouchFriendly(page: Page): Promise<void> {
  const problems = await page.locator('.lab-screen').evaluate((root) => {
    const out: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>('button, a, select, input, summary')) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (!r.width || !r.height || style.visibility === 'hidden') continue;
      if (r.width < 43.5 || r.height < 43.5) out.push(`${el.tagName}.${el.className} "${el.textContent?.trim().slice(0, 20)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) out.push(`horizontal overflow ${doc.scrollWidth} > ${doc.clientWidth}`);
    return out;
  });
  expect(problems).toEqual([]);
}

test.describe('Training Lab', () => {
  test('overview renders the Elo chart, stats and W/D/L bars from fixtures', async ({ page }) => {
    await serveFixtures(page);
    await open(page, '#/lab');
    const chart = page.getByTestId('elo-chart');
    await expect(chart.locator('.elo-point')).toHaveCount(manifest.generations.length);
    await expect(chart.locator('.elo-baseline')).toHaveCount(4);
    await expect(chart.locator('.elo-band')).toHaveCount(1);
    await expect(page.getByTestId('lab-stats')).toContainText('40');
    await expect(page.getByTestId('gen-panel')).toContainText(`Gen ${manifest.champion}`);
    await expect(page.getByTestId('wdl-bars').locator('.wdl-row')).not.toHaveCount(0);
    await expectTouchFriendly(page);
  });

  test('generation picker updates the selected generation', async ({ page }) => {
    await serveFixtures(page);
    await open(page, '#/lab?gen=12');
    const panel = page.getByTestId('gen-panel');
    await expect(panel.locator('.gen-name')).toHaveText('Gen 12');
    await page.getByRole('button', { name: 'Next generation' }).click();
    await expect(panel.locator('.gen-name')).toHaveText('Gen 13');
    await expect(page).toHaveURL(/#\/lab\?gen=13$/);
    await page.getByTestId('open-gen').click();
    await expect(page).toHaveURL(/#\/lab\/13$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Generation 13');
  });

  test('tapping a chart point opens that generation', async ({ page, isMobile }) => {
    await serveFixtures(page);
    await open(page, '#/lab');
    const point = page.locator('.elo-point[data-gen="20"]');
    await expect(point).toHaveCount(1);
    const box = (await point.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    if (isMobile) {
      await page.touchscreen.tap(x, y);
      await expect(page.locator('.elo-tooltip')).toContainText('Gen 20');
      await expect(page.getByTestId('gen-panel').locator('.gen-name')).toHaveText('Gen 20');
      await page.touchscreen.tap(x, y);
    } else {
      await page.mouse.move(x, y);
      await expect(page.locator('.elo-tooltip')).toContainText('Gen 20');
      await page.mouse.click(x, y);
    }
    await expect(page).toHaveURL(/#\/lab\/20$/);
  });

  test('generation detail lists sampled games and opens a replay', async ({ page }) => {
    await serveFixtures(page);
    await open(page, '#/lab/5');
    const cards = page.getByTestId('game-card');
    await expect(cards).toHaveCount(6);
    await page.locator('[data-filter="gauntlet"]').click();
    await expect(cards).toHaveCount(2);
    await page.locator('[data-filter="all"]').click();
    await expect(cards.first()).toContainText('Gen 5');
    await expectTouchFriendly(page);
    await cards.first().click();
    await expect(page).toHaveURL(/#\/lab\/5\/g5-s1/);
    await expect(page.getByTestId('replay-ply')).toHaveText(/^Ply 0 \/ \d+$/);
  });

  test('replay steps, scrubs, uses the keyboard and deep links by ply', async ({ page }) => {
    test.slow();
    await serveFixtures(page);
    await openReplay(page, '#/lab/20/g20-s1');
    const ply = page.getByTestId('replay-ply');
    await expect(ply).toHaveText(/^Ply 0 \/ (\d+)$/);
    const total = Number((await ply.textContent())!.split('/')[1]);

    await page.getByTestId('replay-forward').click();
    await expect(ply).toHaveText(`Ply 1 / ${total}`);
    await expect(page.getByTestId('replay-moves').locator('.lab-move.is-current')).toHaveAttribute('data-ply', '1');

    await page.getByTestId('replay-forward').click();
    await expect(ply).toHaveText(`Ply 2 / ${total}`);
    await page.getByTestId('replay-back').click();
    await expect(ply).toHaveText(`Ply 1 / ${total}`);

    const scrub = page.getByTestId('replay-scrub');
    await scrub.fill('30');
    await expect(ply).toHaveText(`Ply 30 / ${total}`);
    await expect(page).toHaveURL(/\?ply=30$/, { timeout: SETTLE_MS });

    await page.locator('body').press('ArrowRight');
    await expect(ply).toHaveText(`Ply 31 / ${total}`);
    await page.locator('body').press('ArrowLeft');
    await page.locator('body').press('ArrowLeft');
    await expect(ply).toHaveText(`Ply 29 / ${total}`);
    await page.locator('body').press('End');
    await expect(ply).toHaveText(`Ply ${total} / ${total}`);
    await page.locator('body').press('Home');
    await expect(ply).toHaveText(`Ply 0 / ${total}`);

    await page.getByTestId('replay-moves').locator('.lab-move[data-ply="12"]').click();
    await expect(ply).toHaveText(`Ply 12 / ${total}`);
    await expectTouchFriendly(page);

    await openReplay(page, '#/lab/20/g20-s1?ply=17');
    await expect(ply).toHaveText(`Ply 17 / ${total}`);
    await expect(page.getByTestId('replay-scrub')).toHaveValue('17');
  });

  test('replay autoplay advances and pauses', async ({ page }) => {
    test.slow();
    await serveFixtures(page);
    await openReplay(page, '#/lab/3/g3-s2');
    const ply = page.getByTestId('replay-ply');
    await expect(ply).toHaveText(/^Ply 0 \//);
    const fastest = page.locator('[data-speed="4"]');
    if (await fastest.isVisible()) await fastest.click();
    else {
      const cycle = page.locator('.speed-cycle');
      while ((await cycle.textContent()) !== '4×') await cycle.click();
    }
    await page.getByTestId('replay-play').click();
    await expect(ply).not.toHaveText(/^Ply 0 \//, { timeout: 10_000 });
    await expect(ply).not.toHaveText(/^Ply 1 \//, { timeout: 10_000 });
    await page.getByRole('button', { name: 'Pause' }).click();
    const paused = await ply.textContent();
    await page.waitForTimeout(800);
    await expect(ply).toHaveText(paused!);
  });

  test('shows the empty state when training has not run', async ({ page }) => {
    await serveFixtures(page, { empty: true });
    await open(page, '#/lab');
    await expect(page.getByTestId('lab-empty')).toContainText("Training hasn't run yet");
    await expect(page.getByTestId('elo-chart')).toHaveCount(0);
    await expectTouchFriendly(page);
  });

  test('reports an unknown generation', async ({ page }) => {
    await serveFixtures(page);
    await open(page, '#/lab/999');
    await expect(page.getByTestId('lab-error')).toContainText('999');
  });

  test('live match picker offers only generations with networks', async ({ page }) => {
    await serveFixtures(page);
    await open(page, '#/lab/live');
    const picker = page.getByTestId('live-picker');
    await expect(picker.locator('#live-a option')).toHaveCount(4);
    await picker.locator('#live-a').selectOption('39');
    await picker.locator('#live-b').selectOption('0');
    await expect(picker.getByTestId('live-start')).toBeEnabled();
    await picker.getByTestId('live-start').click();
    await expect(page).toHaveURL(/#\/lab\/live\/39\/0$/);
  });

  test('live match plays moves between two generations', async ({ page }) => {
    test.slow();
    await serveFixtures(page);
    await open(page, '#/lab/live/39/10?ms=150');
    if (process.env.LAB_E2E_HARNESS) {
      await expect(page.getByTestId('harness-live-moves')).toHaveText(/^([2-9]|\d{2,}) plies/, { timeout: 60_000 });
      return;
    }
    await page.waitForFunction(() => (window as unknown as { __checkers?: { state(): { moves: string[]; mode: string } } }).__checkers?.state().moves.length! >= 2, null, { timeout: 90_000 });
    const state = await page.evaluate(() => (window as unknown as { __checkers: { state(): { mode: string } } }).__checkers.state());
    expect(state.mode).toBe('live-match');
  });
});
