import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

interface OnlineView {
  status: string;
  role: string;
  moves: string[];
  mySides: number[];
  result?: { winner: number | null; reason: string };
  incoming?: string;
}

// Software-rendered WebGL in two contexts can stall a page's main thread for 40 s or more.
const PEER_TIMEOUT = 75_000;

const withTestFlag = (url: string) => url.replace('/#/', '/?test=1#/');

async function online(page: Page): Promise<OnlineView | null> {
  return page.evaluate(() => {
    const o = window.__checkersOnline;
    if (!o) return null;
    const s = o.snapshot();
    return { status: o.status(), role: o.role, moves: s.moves, mySides: s.mySides, result: s.result, incoming: s.online?.incomingOffer };
  });
}

const statusOf = async (page: Page) => (await online(page))?.status ?? 'none';

async function playMove(page: Page, move: string): Promise<boolean> {
  return page.evaluate((m) => {
    const shell = window.__checkers;
    if (shell && shell.state().mode === 'online') return shell.playMove(m);
    return window.__checkersOnline?.playMove(m) ?? false;
  }, move);
}

const openContexts = new Set<BrowserContext>();

test.afterEach(async () => {
  for (const c of openContexts) await c.close().catch(() => {});
  openContexts.clear();
});

async function newPlayer(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext();
  openContexts.add(context);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  page.on('pageerror', (err) => console.log(`[${name} pageerror]`, err.message));
  if (process.env.E2E_CONSOLE) page.on('console', (msg) => console.log(`[${name} ${msg.type()}]`, msg.text()));
  return page;
}

async function createInvite(host: Page, name: string): Promise<string> {
  await host.goto('./?test=1#/friend');
  await host.getByLabel('Your name').fill(name);
  await host.getByRole('button', { name: 'Create invite link' }).click();
  const link = host.locator('[data-link-kind="invite"]');
  await expect(link).toBeVisible({ timeout: 20_000 });
  await expect(host.getByText('Keep this tab open')).toBeVisible();
  return (await link.getAttribute('data-url'))!;
}

async function acceptInvite(guest: Page, invite: string, name: string): Promise<string> {
  await guest.goto(withTestFlag(invite));
  await guest.getByLabel('Your name').fill(name);
  await guest.getByRole('button', { name: 'Join game' }).click();
  const reply = guest.locator('[data-link-kind="reply"]');
  await expect(reply).toBeVisible({ timeout: 20_000 });
  return (await reply.getAttribute('data-url'))!;
}

async function pasteReply(page: Page, reply: string): Promise<void> {
  const input = page.getByLabel('Got their reply? Paste it here');
  await input.fill(reply);
  await input.press('Enter');
}

async function expectConnected(...pages: Page[]): Promise<void> {
  for (const page of pages) await expect.poll(() => statusOf(page), { timeout: PEER_TIMEOUT }).toBe('connected');
}

async function expectMoves(moves: string[], ...pages: Page[]): Promise<void> {
  for (const page of pages) await expect.poll(async () => (await online(page))?.moves, { timeout: PEER_TIMEOUT }).toEqual(moves);
}

test.describe('online play over a two-link handshake', () => {
  test.beforeEach(({}, info) => info.skip(info.project.name !== 'desktop', 'two-context WebRTC flow runs on the desktop project'));
  test.setTimeout(420_000);

  test('paste reply, play, reload + resume, draw, rematch with color swap, resign', async ({ browser }) => {
    const host = await newPlayer(browser, 'host');
    const guest = await newPlayer(browser, 'guest');

    const invite = await createInvite(host, 'Hana');
    expect(invite).toMatch(/\/checkers\/#\/join\/[A-Za-z0-9_-]+$/);
    expect(invite.length).toBeLessThan(1100);
    const reply = await acceptInvite(guest, invite, 'Gus');
    expect(reply).toMatch(/\/checkers\/#\/answer\/[A-Za-z0-9_-]+$/);

    await pasteReply(host, reply);
    await expect(host).toHaveURL(/#\/play\/[0-9A-Z]{10}$/, { timeout: 30_000 });
    await expect(guest).toHaveURL(/#\/play\/[0-9A-Z]{10}$/, { timeout: 30_000 });
    await expectConnected(host, guest);
    const code = host.url().split('/').pop()!;
    expect(guest.url().endsWith(code)).toBe(true);

    expect((await online(host))!.mySides).toEqual([0]);
    expect((await online(guest))!.mySides).toEqual([1]);
    await expect(host.getByText('vs Gus')).toBeVisible();
    await expect(guest.getByText('vs Hana')).toBeVisible();

    expect(await playMove(guest, '11-15')).toBe(false);
    expect(await playMove(host, '11-15')).toBe(true);
    await expectMoves(['11-15'], host, guest);
    expect(await playMove(guest, '23-19')).toBe(true);
    await expectMoves(['11-15', '23-19'], host, guest);
    expect(await playMove(host, '8-11')).toBe(true);
    await expectMoves(['11-15', '23-19', '8-11'], host, guest);

    await guest.reload();
    await expect.poll(() => statusOf(guest), { timeout: PEER_TIMEOUT }).toBe('disconnected');
    await expectMoves(['11-15', '23-19', '8-11'], guest);
    await expect.poll(() => statusOf(host), { timeout: PEER_TIMEOUT }).toBe('disconnected');

    await guest.getByRole('button', { name: 'Resume link' }).first().click();
    const resumeLink = guest.locator('.ol-resume-dialog [data-link-kind="invite"]');
    await expect(resumeLink).toBeVisible({ timeout: 20_000 });
    const resumeUrl = (await resumeLink.getAttribute('data-url'))!;

    await host.goto(withTestFlag(resumeUrl));
    await expect(host.getByText('Reconnect with Gus')).toBeVisible();
    await host.getByRole('button', { name: 'Reconnect' }).click();
    const resumeReply = host.locator('[data-link-kind="reply"]');
    await expect(resumeReply).toBeVisible({ timeout: 20_000 });
    await pasteReply(guest, (await resumeReply.getAttribute('data-url'))!);
    await expect(host).toHaveURL(new RegExp(`#/play/${code}$`), { timeout: 30_000 });
    await expectConnected(host, guest);
    await expectMoves(['11-15', '23-19', '8-11'], host, guest);

    expect(await playMove(guest, '22-17')).toBe(true);
    await expectMoves(['11-15', '23-19', '8-11', '22-17'], host, guest);

    await host.evaluate(() => window.__checkersOnline!.offer('draw'));
    await expect.poll(async () => (await online(guest))?.incoming).toBe('draw');
    const drawDialog = guest.getByRole('dialog').filter({ hasText: 'offers a draw' });
    await expect(drawDialog).toBeVisible();
    await drawDialog.getByRole('button', { name: 'Accept' }).click();
    for (const page of [host, guest]) await expect.poll(async () => (await online(page))?.result).toEqual({ winner: null, reason: 'agreement' });

    await expect(host.locator('dialog.result-dialog')).toBeVisible();
    const guestResult = guest.locator('dialog.result-dialog');
    await expect(guestResult).toBeVisible();
    await guestResult.getByRole('button', { name: 'Play again' }).click();
    await expect.poll(async () => (await online(host))?.incoming).toBe('rematch');
    const rematchDialog = host.getByRole('dialog').filter({ hasText: 'wants a rematch' });
    await expect(rematchDialog).toBeVisible();
    await rematchDialog.getByRole('button', { name: 'Accept' }).click();
    for (const page of [host, guest]) {
      await expect.poll(async () => (await online(page))?.moves).toEqual([]);
      await expect.poll(async () => (await online(page))?.result).toBeUndefined();
    }
    expect((await online(host))!.mySides).toEqual([1]);
    expect((await online(guest))!.mySides).toEqual([0]);

    expect(await playMove(guest, '9-13')).toBe(true);
    await expectMoves(['9-13'], host, guest);

    await host.evaluate(() => window.__checkersOnline!.resign());
    for (const page of [host, guest]) await expect.poll(async () => (await online(page))?.result).toEqual({ winner: 0, reason: 'resign' });

  });

  test('reply opened in a new tab reaches the waiting tab over BroadcastChannel', async ({ browser }) => {
    const host = await newPlayer(browser, 'host');
    const guest = await newPlayer(browser, 'guest');
    const invite = await createInvite(host, 'Hana');
    const reply = await acceptInvite(guest, invite, 'Gus');

    const replyTab = await host.context().newPage();
    await replyTab.goto(withTestFlag(reply));
    await expect(replyTab.getByText('Connected — return to your game tab')).toBeVisible({ timeout: 15_000 });

    await expect(host).toHaveURL(/#\/play\/[0-9A-Z]{10}$/, { timeout: 30_000 });
    await expectConnected(host, guest);
    expect(await playMove(host, '10-14')).toBe(true);
    await expectMoves(['10-14'], host, guest);
    expect(await playMove(guest, '24-20')).toBe(true);
    await expectMoves(['10-14', '24-20'], host, guest);

  });

  test('reply opened in the waiting tab itself still connects', async ({ browser }) => {
    const host = await newPlayer(browser, 'host');
    const guest = await newPlayer(browser, 'guest');
    const invite = await createInvite(host, 'Hana');
    const reply = await acceptInvite(guest, invite, 'Gus');
    await host.goto(withTestFlag(reply));
    await expect(host).toHaveURL(/#\/play\/[0-9A-Z]{10}$/, { timeout: 30_000 });
    await expectConnected(host, guest);
    await guest.goto(withTestFlag(reply));
    await expect(guest.getByText('This is your own reply link')).toBeVisible();
  });

  test('a stale or foreign reply shows a clear message', async ({ browser }) => {
    const host = await newPlayer(browser, 'host');
    const invite = await createInvite(host, 'Hana');
    await pasteReply(host, invite);
    await expect(host.getByText('That’s your own link')).toBeVisible();

    const stranger = await newPlayer(browser, 'stranger');
    await stranger.goto(withTestFlag(invite.replace('#/join/', '#/answer/')));
    await expect(stranger.getByText(/Paste this into your invite page|didn’t work|couldn’t use/)).toBeVisible({ timeout: 15_000 });
    await stranger.goto('./?test=1#/join/not-a-real-blob');
    await expect(stranger.getByText('That link didn’t work')).toBeVisible();

  });
});

test.describe('online screens on a phone', () => {
  test.beforeEach(({}, info) => info.skip(info.project.name !== 'phone', 'layout check runs on the phone project'));

  test('invite screen fits and has large touch targets', async ({ page }) => {
    await page.goto('./?test=1#/friend');
    await page.getByRole('button', { name: 'Create invite link' }).click();
    await expect(page.locator('[data-link-kind="invite"]')).toBeVisible({ timeout: 20_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.ol-screen button, .ol-screen a.btn, .ol-screen summary')]
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({ text: el.textContent, ...el.getBoundingClientRect().toJSON() }))
        .filter((r) => r.height < 44 || r.width < 44),
    );
    expect(small).toEqual([]);
  });
});
