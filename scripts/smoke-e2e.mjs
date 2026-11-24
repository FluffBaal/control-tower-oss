import { chromium } from 'playwright';
import { existsSync, rmSync } from 'node:fs';

const PORT = process.env.PORT ?? '4871';
const BASE = `http://127.0.0.1:${PORT}`;
const PROOF = `/tmp/ct-proof-${Date.now()}`;
if (existsSync(PROOF)) rmSync(PROOF);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const logs = [];
page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByText('Control Tower').first().waitFor({ timeout: 8000 });
  console.log('RENDER: app shell painted');

  // Add a project
  await page.getByRole('button', { name: '+ project' }).click();
  await page.getByPlaceholder('name').fill('e2e');
  await page.getByPlaceholder('/abs/path/to/repo').fill('/tmp/ct-demo-repo');
  await page.getByRole('button', { name: 'add' }).click();
  await page.getByText('e2e', { exact: true }).waitFor({ timeout: 8000 });
  console.log('PROJECT: created and listed');

  // Create a terminal
  await page.getByRole('button', { name: '+ terminal' }).click();
  await page.locator('.xterm-screen').waitFor({ timeout: 10000 });
  console.log('TERMINAL: xterm mounted');

  // Type a command into the terminal that leaves a filesystem proof.
  await page.locator('.xterm-helper-textarea').focus();
  await page.waitForTimeout(600);
  await page.keyboard.type(`touch ${PROOF} && echo CT_STREAM_OK`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);

  await page.screenshot({ path: '/tmp/ct-e2e.png' });

  const ok = existsSync(PROOF);
  console.log(`STREAM_ROUNDTRIP: ${ok ? 'PASS' : 'FAIL'} (browser keystrokes -> ws -> tmux -> shell executed: ${PROOF})`);
  if (ok) rmSync(PROOF);
  console.log(ok ? 'E2E: PASS' : 'E2E: FAIL');
} catch (err) {
  console.log('E2E: FAIL', err.message);
  console.log(logs.join('\n'));
  await page.screenshot({ path: '/tmp/ct-e2e-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
