import { expect, test, type Page } from '@playwright/test';

const pdnSquare = (pdn: number) => pdn - 1;
const state = (page: Page) => page.evaluate(() => window.__checkers!.state());

async function open(page: Page, hash: string): Promise<void> {
  const route = hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'home';
  await page.goto(`./?test=1${hash}`);
  await page.waitForFunction(
    (r) => document.documentElement.dataset.route === r && document.body.dataset.ready === '1',
    route,
    { timeout: 30_000 },
  );
}

async function tapSquare(page: Page, pdn: number, hasTouch: boolean): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__checkers!.state().idle), { timeout: 15_000 }).toBe(true);
  const { x, y } = await page.evaluate((sq) => window.__checkers!.clientOfSquare(sq), pdnSquare(pdn));
  if (hasTouch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function waitForAiReply(page: Page, plies: number): Promise<void> {
  await expect.poll(async () => {
    const s = await state(page);
    return s.idle ? s.moves.length : -1;
  }, { timeout: 20_000 }).toBe(plies);
}

test('the AI replies to a tapped move using the heuristic fallback', async ({ page, hasTouch }) => {
  await open(page, '#/ai?level=1&side=0');
  await expect(page.locator('.hud-title-main')).toHaveText('vs AI · Novice');
  await expect(page.locator('.hud-title-sub')).toHaveText('Heuristic engine');
  await expect(page.locator('.player-chip[data-pos="top"] .pc-name')).toHaveText('AI · Novice');
  await tapSquare(page, 11, !!hasTouch);
  await tapSquare(page, 15, !!hasTouch);
  await waitForAiReply(page, 2);
  const s = await state(page);
  expect(s.moves[0]).toBe('11-15');
  expect(s.turn).toBe(0);
  expect(s.mode).toBe('ai');
});

test('the AI opens when the human plays Ivory, with nothing to undo yet', async ({ page }) => {
  await open(page, '#/ai?level=2&side=1');
  await waitForAiReply(page, 1);
  expect((await state(page)).turn).toBe(1);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
});

test('reloading mid-game resumes it instead of starting over', async ({ page }) => {
  await open(page, '#/ai?level=1&side=1');
  await waitForAiReply(page, 1);
  expect(await page.evaluate(() => window.__checkers!.playMove('22-18'))).toBe(true);
  await waitForAiReply(page, 3);
  const before = (await state(page)).moves;
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/resume=g\w+/);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.route === 'ai' && document.body.dataset.ready === '1');
  await expect.poll(async () => (await state(page)).moves).toEqual(before);
  await expect(page.locator('.hud-title-main')).toHaveText('vs AI · Novice');
  await expect(page.locator('.player-chip[data-pos="bottom"] .pc-name')).toHaveText('You');
  expect((await state(page)).turn).toBe(1);
});

test('going back to a replaced game starts fresh instead of opening the newer one', async ({ page }) => {
  await open(page, '#/ai?level=1&side=0');
  expect(await page.evaluate(() => window.__checkers!.playMove('11-15'))).toBe(true);
  await waitForAiReply(page, 2);
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/resume=g\w+/);
  const oldGame = await page.evaluate(() => location.hash);
  await page.evaluate(() => (location.hash = '#/ai?level=5&side=1'));
  await waitForAiReply(page, 1);
  expect(await page.evaluate(() => window.__checkers!.playMove('22-18'))).toBe(true);
  await waitForAiReply(page, 3);
  const newer = await page.evaluate(() => localStorage.getItem('checkers:resume'));
  await page.evaluate((h) => (location.hash = h), oldGame);
  await expect(page.locator('.toast')).toContainText('no longer available');
  await expect(page.locator('.hud-title-main')).toHaveText('vs AI · Novice');
  expect((await state(page)).moves).toEqual([]);
  expect(await page.evaluate(() => location.hash)).toBe('#/ai?level=1&side=0');
  expect(await page.evaluate(() => localStorage.getItem('checkers:resume'))).toBe(newer);
});

test('a failed engine load can be retried', async ({ page }) => {
  let blocked = 0;
  await page.route('**/src/ai/client.ts*', (route) => (blocked++ === 0 ? route.abort() : route.continue()));
  await open(page, '#/ai?level=1&side=1');
  const stall = page.getByRole('dialog', { name: 'The AI couldn’t move' });
  await expect(stall).toBeVisible({ timeout: 20_000 });
  await expect(stall.getByRole('button', { name: 'Undo my move' })).toHaveCount(0);
  await expect(page.locator('.hud-title-sub')).toHaveText('Engine unavailable');
  await stall.getByRole('button', { name: 'Try again' }).click();
  await waitForAiReply(page, 1);
  await expect(stall).toHaveCount(0);
  await expect(page.locator('.hud-title-sub')).toHaveText('Heuristic engine');
});

test('a fresh game does not overwrite the saved one until the human moves', async ({ page }) => {
  await open(page, '#/ai?level=3&side=0');
  await page.evaluate(() => window.__checkers!.playMove('9-13'));
  await waitForAiReply(page, 2);
  const saved = await page.evaluate(() => localStorage.getItem('checkers:resume'));
  await open(page, '#/ai?level=1&side=1');
  await waitForAiReply(page, 1);
  expect(await page.evaluate(() => localStorage.getItem('checkers:resume'))).toBe(saved);
});

test('review after a flipped loss still reports the loss', async ({ page }) => {
  await open(page, '#/ai?level=1&side=0');
  await page.getByRole('button', { name: 'Flip board' }).click();
  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('dialog', { name: 'Resign this game?' }).getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('dialog', { name: 'You lose' }).getByRole('button', { name: 'Review' }).click();
  await page.waitForFunction(() => document.documentElement.dataset.route === 'review' && document.body.dataset.ready === '1');
  await expect(page.locator('.hud-title-sub')).toHaveText('vs AI · Novice · You lose');
});

test('undo takes back the AI reply and the human move', async ({ page }) => {
  await open(page, '#/ai?level=1&side=0');
  expect(await page.evaluate(() => window.__checkers!.playMove('11-15'))).toBe(true);
  await waitForAiReply(page, 2);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await state(page)).moves).toEqual([]);
});

test('an AI game resumes with the same side and level', async ({ page }) => {
  await open(page, '#/ai?level=3&side=0');
  await page.evaluate(() => window.__checkers!.playMove('9-13'));
  await waitForAiReply(page, 2);
  const before = (await state(page)).moves;
  await open(page, '#/');
  await expect(page.locator('.resume-title')).toHaveText('vs AI · Club');
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect.poll(async () => (await state(page)).moves).toEqual(before);
  await expect(page.locator('.hud-title-main')).toHaveText('vs AI · Club');
});

test('resigning against the AI shows a loss', async ({ page }) => {
  await open(page, '#/ai?level=1&side=0');
  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('dialog', { name: 'Resign this game?' }).getByRole('button', { name: 'Resign' }).click();
  const dialog = page.getByRole('dialog', { name: 'You lose' });
  await expect(dialog).toContainText('Crimson resigned');
  await dialog.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: 'Checkers', level: 1 })).toBeVisible();
});
