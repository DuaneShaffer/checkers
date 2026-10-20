import { expect, test, type Page } from '@playwright/test';
import { Game } from '../../src/engine/game.ts';

const pdnSquare = (pdn: number) => pdn - 1;

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
  await expect.poll(() => page.evaluate(() => window.__checkers!.state().idle)).toBe(true);
  const { x, y } = await page.evaluate((sq) => window.__checkers!.clientOfSquare(sq), pdnSquare(pdn));
  if (hasTouch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function playByTaps(page: Page, move: string, hasTouch: boolean): Promise<void> {
  const before = (await page.evaluate(() => window.__checkers!.state())).moves.length;
  for (const pdn of move.split(/[-x]/).map(Number)) await tapSquare(page, pdn, hasTouch);
  await expect.poll(() => page.evaluate(() => window.__checkers!.state().moves.length)).toBe(before + 1);
}

const state = (page: Page) => page.evaluate(() => window.__checkers!.state());

test('plays several moves, including captures, by tapping squares', async ({ page, hasTouch }) => {
  await open(page, '#/local');
  const moves = ['9-13', '22-17', '13x22', '25x18', '11-15', '18x11', '7x16'];
  for (const m of moves) await playByTaps(page, m, !!hasTouch);
  const s = await state(page);
  expect(s.moves).toEqual(moves);
  expect(s.fen).toBe(Game.fromMoves(moves).fen());
  expect(s.turn).toBe(1);
  await expect(page.locator('#announcer-polite')).toHaveText(/Crimson jumps 7 to 16, captures 1/);
  await expect(page.locator('.player-chip[data-pos="bottom"] .pc-count')).toHaveText('×2');
  await expect(page.locator('.player-chip[data-pos="top"] .pc-count')).toHaveText('×2');
});

test('jumps through a multi-capture with intermediate taps', async ({ page, hasTouch }) => {
  await open(page, `#/local?fen=${encodeURIComponent('B:W6,15,23,24,14:B1,9')}`);
  await tapSquare(page, 1, !!hasTouch);
  await tapSquare(page, 10, !!hasTouch);
  expect((await state(page)).moves).toEqual([]);
  await tapSquare(page, 19, !!hasTouch);
  expect((await state(page)).moves).toEqual([]);
  await tapSquare(page, 28, !!hasTouch);
  await expect.poll(async () => (await state(page)).moves).toEqual(['1x10x19x28']);
});

test('mandatory capture is explained when another piece is tapped', async ({ page, hasTouch }) => {
  await open(page, '#/local');
  await playByTaps(page, '9-13', !!hasTouch);
  await playByTaps(page, '22-17', !!hasTouch);
  await tapSquare(page, 11, !!hasTouch);
  await expect(page.locator('.toast')).toContainText('captures are mandatory');
  await expect(page.locator('.hud-status')).toContainText('jump required');
});

test('undo takes back one ply in pass and play', async ({ page, hasTouch }) => {
  await open(page, '#/local');
  await playByTaps(page, '11-15', !!hasTouch);
  await playByTaps(page, '23-19', !!hasTouch);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await state(page)).moves).toEqual(['11-15']);
  await playByTaps(page, '24-20', !!hasTouch);
  expect((await state(page)).moves).toEqual(['11-15', '24-20']);
});

test('a game in progress can be resumed from home', async ({ page, hasTouch }) => {
  await open(page, '#/local');
  await playByTaps(page, '11-15', !!hasTouch);
  await playByTaps(page, '23-19', !!hasTouch);
  await open(page, '#/');
  const resume = page.getByRole('button', { name: 'Resume' });
  await expect(resume).toBeVisible();
  await resume.click();
  await expect.poll(async () => (await state(page)).moves).toEqual(['11-15', '23-19']);
  expect((await state(page)).mode).toBe('local');
});

test('reloading mid-game resumes it', async ({ page, hasTouch }) => {
  test.slow();
  await open(page, '#/local');
  await playByTaps(page, '11-15', !!hasTouch);
  await playByTaps(page, '23-19', !!hasTouch);
  await playByTaps(page, '8-11', !!hasTouch);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.route === 'local' && document.body.dataset.ready === '1', undefined, { timeout: 60_000 });
  await expect.poll(async () => (await state(page)).moves).toEqual(['11-15', '23-19', '8-11']);
});

test('an invalid position link keeps the saved game and explains itself', async ({ page, hasTouch }) => {
  await open(page, '#/local');
  await playByTaps(page, '11-15', !!hasTouch);
  const saved = await page.evaluate(() => localStorage.getItem('checkers:resume'));
  await open(page, '#/local?fen=nonsense');
  await expect(page.locator('.toast')).toContainText('position link is invalid');
  expect((await state(page)).moves).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('checkers:resume'))).toBe(saved);
});

test('game over shows the result and offers a rematch', async ({ page, hasTouch }) => {
  await open(page, `#/local?fen=${encodeURIComponent('B:W14:B10')}`);
  await playByTaps(page, '10-17', !!hasTouch);
  const dialog = page.getByRole('dialog', { name: 'Crimson wins' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Ivory has no pieces left');
  expect((await state(page)).status).toEqual({ over: true, winner: 0, reason: 'no-moves' });
  await expect(page.locator('#announcer-assertive')).toContainText('Crimson wins');
  await expect(dialog.getByRole('button', { name: 'Review' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Play again' }).click();
  await expect.poll(async () => (await state(page)).fen).toBe(Game.fromMoves([]).fen());
  expect(await page.evaluate(() => localStorage.getItem('checkers:resume'))).toBeNull();
});

test('resigning ends the game for the side to move', async ({ page }) => {
  await open(page, '#/local');
  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('dialog', { name: 'Resign this game?' }).getByRole('button', { name: 'Resign' }).click();
  await expect(page.getByRole('dialog', { name: 'Ivory wins' })).toContainText('Crimson resigned');
});

test('keyboard selects and moves a piece', async ({ page, hasTouch }) => {
  test.skip(!!hasTouch, 'keyboard play is a desktop feature');
  await open(page, '#/local');
  await page.locator('.board-slot').focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  const selected = await page.evaluate(() => window.__checkers!.state());
  expect(selected.moves).toEqual([]);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).moves.length).toBe(1);
});

test('clicking a HUD button hands the arrow keys back to the board', async ({ page, hasTouch }) => {
  test.skip(!!hasTouch, 'keyboard play is a desktop feature');
  await open(page, '#/local');
  await page.getByRole('button', { name: 'Flip board' }).click();
  await expect(page.locator('.board-slot')).toBeFocused();
});
