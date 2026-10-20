import { expect, test, type Page } from '@playwright/test';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

async function open(page: Page, hash = '#/'): Promise<void> {
  const route = hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'home';
  await page.goto(`./?test=1${hash}`);
  await page.waitForFunction(
    (r) => document.documentElement.dataset.route === r && document.body.dataset.ready === '1',
    route,
    { timeout: 30_000 },
  );
}

test('home renders its menu without console errors', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  await expect(page.getByRole('heading', { name: 'Checkers', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play the AI' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Difficulty' }).getByRole('button')).toHaveCount(5);
  await expect(page.getByRole('link', { name: /Play a friend/ })).toBeAttached();
  await expect(page.getByRole('link', { name: /Pass & play/ })).toBeAttached();
  await expect(page.getByRole('link', { name: /Training Lab/ })).toBeAttached();
  await expect(page.locator('#stage canvas')).toHaveCount(1);
  expect(await page.evaluate(() => document.body.dataset.ready)).toBe('1');
  expect(errors).toEqual([]);
});

test('test hook reports the opening position on home', async ({ page }) => {
  await open(page);
  const state = await page.evaluate(() => window.__checkers!.state());
  expect(state).toMatchObject({ moves: [], turn: 0, mode: 'home', status: { over: false } });
  expect(state.fen).toBe('B:W21,22,23,24,25,26,27,28,29,30,31,32:B1,2,3,4,5,6,7,8,9,10,11,12');
});

test('menu links open each game screen without console errors', async ({ page }) => {
  test.slow();
  const errors = collectErrors(page);
  await open(page);
  await page.getByRole('link', { name: /Pass & play/ }).click();
  await expect(page.locator('.game-screen[data-mode="local"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__checkers!.state().mode)).toBe('local');
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: 'Checkers', level: 1 })).toBeVisible();
  await page.getByRole('group', { name: 'Difficulty' }).getByRole('button', { name: /Novice/ }).click();
  await page.getByRole('button', { name: 'Play the AI' }).click();
  await expect(page.locator('.game-screen[data-mode="ai"]')).toBeVisible();
  await expect(page.locator('.hud-title-main')).toHaveText('vs AI · Novice');
  expect(errors).toEqual([]);
});

test('settings open in a dialog and persist', async ({ page }) => {
  test.slow();
  await open(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  const sound = dialog.getByRole('switch').first();
  await expect(sound).toBeChecked();
  await sound.uncheck();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('checkers:settings') ?? '{}'));
  expect(stored.sound).toBe(false);
});

test('unknown routes fall back to home and review has an empty state', async ({ page }) => {
  await page.goto('./?test=1#/definitely-not-a-route');
  await page.evaluate(() => window.__checkers!.ready);
  await expect(page.getByRole('heading', { name: 'Checkers', level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.route)).toBe('home');
  await open(page, '#/review');
  await expect(page.getByRole('heading', { name: 'Nothing to review yet' })).toBeVisible();
});
