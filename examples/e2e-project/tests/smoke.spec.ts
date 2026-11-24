import { test, expect } from '@playwright/test';

// A trivial browser test proving the kit can run real Playwright suites.
test('smoke: browser launches', async ({ page }) => {
  await page.goto('about:blank');
  await page.setContent('<h1 id="t">Control Tower</h1>');
  await expect(page.locator('#t')).toHaveText('Control Tower');
});
