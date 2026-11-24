// Records a demo walkthrough of the running Tower (the "Flightline" UI) to a .webm,
// converted to a GIF alongside the video by the wrapper. Expects a Tower already listening on
// PORT with at least one project and a couple of seeded terminals (a worktree run makes
// the Review tab meaningful). Env: PORT, OUTDIR.
//
// Regenerate end-to-end with:  bash scripts/record-demo.sh
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.PORT ?? '4870';
const OUTDIR = process.env.OUTDIR ?? mkdtempSync(join(tmpdir(), 'ct-demo-video-'));
const BASE = `http://127.0.0.1:${PORT}`;
const VW = 1280, VH = 800;

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: VW, height: VH },
  recordVideo: { dir: OUTDIR, size: { width: VW, height: VH } },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const pause = (ms) => page.waitForTimeout(ms);

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByText('Flightline').first().waitFor({ timeout: 8000 });
  await pause(1800); // land on the Flightline

  // 1. Open a run's Cockpit — a live shell streaming.
  const strip = page.locator('.strip').first();
  if (await strip.count()) {
    await strip.click();
    await page.locator('.term-host').waitFor({ timeout: 8000 });
    await pause(700);
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('echo "hello from Control Tower" && ls', { delay: 45 });
    await page.keyboard.press('Enter');
    await pause(1600);

    // 2. Review & Land tab (if this run has a worktree).
    const reviewTab = page.locator('.cp-tab', { hasText: 'review' });
    if (await reviewTab.count()) {
      await reviewTab.click();
      await pause(2000);
    }
    // Back to the Flightline.
    await page.locator('.cp-back').click();
    await pause(1200);
  }

  // 3. Per-project isolation shield popover.
  const shield = page.locator('.shield-chip').first();
  if (await shield.count()) {
    await shield.click();
    await page.locator('.pop').waitFor({ timeout: 4000 });
    await pause(2200);
    await page.keyboard.press('Escape');
    await pause(400);
  }

  // 4. Command palette (Cmd/Ctrl-K).
  await page.keyboard.press('Control+k');
  await page.locator('.palette').waitFor({ timeout: 4000 });
  await page.locator('.palette input').type('new', { delay: 55 });
  await pause(1600);
  await page.keyboard.press('Escape');
  await pause(400);

  // 5. New run — the loop composer (the headline: iterate-until-done).
  const ghost = page.locator('.ghost').first();
  if (await ghost.count()) {
    await ghost.click();
    await page.locator('.modal').waitFor({ timeout: 4000 });
    await pause(2400);
    await page.keyboard.press('Escape');
    await pause(600);
  }
} finally {
  await context.close(); // finalizes the webm
  await browser.close();
}

console.log(await page.video().path());
