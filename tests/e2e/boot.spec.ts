import { expect, test } from '@playwright/test';

test('app boots', async ({ page }) => {
  await page.goto('./?test=1');
  await expect(page.locator('#app')).not.toBeEmpty();
});
