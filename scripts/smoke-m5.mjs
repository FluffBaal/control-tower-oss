import { chromium } from 'playwright';

const PORT = process.env.PORT ?? '4882';
const BASE = `http://127.0.0.1:${PORT}`;
const O = { Origin: BASE };
async function tok() { return (await (await fetch(`${BASE}/api/session`, { headers: O })).json()).token; }
async function api(p, t) { return (await fetch(`${BASE}${p}`, { headers: { ...O, 'X-Tower-Token': t } })).json(); }

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByText('Control Tower').first().waitFor({ timeout: 8000 });

  await page.getByRole('button', { name: '+ project' }).click();
  await page.getByPlaceholder('name').fill('m5');
  await page.getByPlaceholder('/abs/path/to/repo').fill('/tmp/ct-demo');
  await page.getByRole('button', { name: 'add' }).click();
  await page.getByText('m5', { exact: true }).waitFor({ timeout: 8000 });

  // Command palette via Ctrl-K
  await page.keyboard.press('Control+k');
  await page.locator('.palette').waitFor({ timeout: 4000 });
  await page.locator('.palette-input').fill('Accounts');
  const paletteHasAccounts = await page.getByText('Go to Accounts & Identities').isVisible();
  console.log(`PALETTE: opened, filters to Accounts=${paletteHasAccounts}`);
  await page.keyboard.press('Escape');

  // Create a shell terminal, open memory tab, edit + save
  await page.getByRole('button', { name: '+ terminal ▾' }).first().click();
  await page.getByRole('button', { name: 'Shell' }).click();
  await page.locator('.xterm-screen').waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'memory', exact: true }).click();
  await page.locator('.memory-text').waitFor({ timeout: 4000 });
  await page.locator('.memory-text').fill('DECISION: use worktree-per-task.');
  await page.getByRole('button', { name: 'save' }).click();
  await page.waitForTimeout(400);

  // Verify persisted via API — use the terminal's actual project (may be sandbox).
  const t = await tok();
  const terms = await api('/api/terminals', t);
  const shell = terms.find((x) => x.provider === 'shell' && x.state !== 'killed');
  const mem = await api(`/api/memory/${shell.projectId}`, t);
  const persisted = (mem['decisions.md'] ?? '').includes('worktree-per-task');
  console.log(`MEMORY: persisted=${persisted} (project ${shell.projectId})`);

  await page.screenshot({ path: '/tmp/ct-m5.png' });
  const pass = paletteHasAccounts && persisted;
  console.log(pass ? 'E2E: PASS' : 'E2E: FAIL');
  if (!pass) process.exitCode = 1;
} catch (err) {
  console.log('E2E: FAIL', err.message);
  console.log(logs.slice(-10).join('\n'));
  await page.screenshot({ path: '/tmp/ct-m5-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
