import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';

const PORT = process.env.PORT ?? '4875';
const CTH = process.env.CTH ?? '/tmp/ct-m3e';
const REPO = process.env.REPO ?? '/tmp/ct-repo';
const BASE = `http://127.0.0.1:${PORT}`;
const O = { Origin: BASE };
const git = (args, cwd = REPO) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

async function tok() {
  return (await (await fetch(`${BASE}/api/session`, { headers: O })).json()).token;
}
async function api(path, token) {
  return (await fetch(`${BASE}${path}`, { headers: { ...O, 'X-Tower-Token': token } })).json();
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1300, height: 860 } });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByText('Control Tower').first().waitFor({ timeout: 8000 });

  await page.getByRole('button', { name: '+ project' }).click();
  await page.getByPlaceholder('name').fill('m3');
  await page.getByPlaceholder('/abs/path/to/repo').fill(REPO);
  await page.getByRole('button', { name: 'add' }).click();
  await page.getByText('m3', { exact: true }).waitFor({ timeout: 8000 });
  console.log('PROJECT: ok');

  // Create a worktree terminal via the menu
  await page.getByRole('button', { name: '+ terminal ▾' }).click();
  await page.locator('.nt-check input[type=checkbox]').check();
  await page.locator('.nt-label').fill('add login');
  await page.getByRole('button', { name: 'Shell' }).click();
  await page.locator('.xterm-screen').waitFor({ timeout: 10000 });
  console.log('WORKTREE TERMINAL: created');

  // Find the worktree path and simulate the agent committing work
  const token = await tok();
  const terms = await api('/api/terminals', token);
  const t = terms.find((x) => x.worktreePath);
  if (!t) throw new Error('no worktree terminal');
  execFileSync('bash', ['-c', `echo "login page" > "${t.worktreePath}/login.js" && git -C "${t.worktreePath}" add -A && git -C "${t.worktreePath}" commit -q -m "add login page"`]);
  console.log(`AGENT COMMIT: on ${t.branch}`);

  // Open the Review tab
  await page.getByRole('button', { name: 'review', exact: true }).click();
  await page.locator('.file-row').first().waitFor({ timeout: 8000 });
  const fileText = await page.locator('.file-row').first().innerText();
  const diffText = await page.locator('.review-diff').innerText();
  console.log(`REVIEW: file="${fileText.replace(/\s+/g, ' ').trim()}" diffHasLogin=${diffText.includes('login page')}`);

  await page.screenshot({ path: '/tmp/ct-m3.png' });

  // Land via merge
  await page.getByRole('button', { name: 'merge', exact: true }).click();
  await page.getByText(/merged into base/).waitFor({ timeout: 8000 });
  const mainLog = git(['log', '--oneline', 'main']);
  const landed = /add login page/.test(mainLog);
  console.log(`LAND(merge): mainHasCommit=${landed}`);

  const pass = fileText.includes('login.js') && diffText.includes('login page') && landed;
  console.log(pass ? 'E2E: PASS' : 'E2E: FAIL');
  if (!pass) process.exitCode = 1;
} catch (err) {
  console.log('E2E: FAIL', err.message);
  console.log(logs.slice(-10).join('\n'));
  await page.screenshot({ path: '/tmp/ct-m3-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
