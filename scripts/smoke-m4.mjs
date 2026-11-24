import { chromium } from 'playwright';

const PORT = process.env.PORT ?? '4877';
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

  // Security banner visible on Mission Control
  const banner = await page.locator('.security-banner').innerText({ timeout: 6000 }).catch(() => '');
  console.log(`SECURITY BANNER: "${banner.replace(/\s+/g, ' ').trim().slice(0, 60)}…"`);

  // Go to Accounts & Identities
  await page.getByRole('button', { name: /Accounts & Identities/ }).click();
  await page.getByText('GitHub identities').waitFor({ timeout: 6000 });

  // Create an identity
  await page.getByPlaceholder('label', { exact: true }).fill('work');
  await page.getByPlaceholder('git name').fill('Work Dev');
  await page.getByPlaceholder('git email').fill('work@example.com');
  await page.getByRole('button', { name: 'add identity' }).click();
  await page.getByText('work@example.com').waitFor({ timeout: 6000 });
  console.log('IDENTITY: created');

  // Add a token
  await page.getByRole('button', { name: 'add token' }).click();
  await page.getByPlaceholder('paste PAT').fill('ghp_ui_test_secret');
  await page.getByRole('button', { name: 'save' }).click();
  await page.getByText('token set').waitFor({ timeout: 6000 });
  console.log('TOKEN: stored (shows "token set")');

  // Confirm via API the credential is stored and NOT readable back
  const t = await tok();
  const ids = await api('/api/identities', t);
  const hasCred = ids[0]?.hasCredential === true;
  const noTokenInApi = !JSON.stringify(ids).includes('ghp_ui_test_secret');
  console.log(`API: hasCredential=${hasCred} tokenNotReadableBack=${noTokenInApi}`);

  await page.screenshot({ path: '/tmp/ct-m4.png' });
  const pass = banner.includes('single-UID') && hasCred && noTokenInApi;
  console.log(pass ? 'E2E: PASS' : 'E2E: FAIL');
  if (!pass) process.exitCode = 1;
} catch (err) {
  console.log('E2E: FAIL', err.message);
  console.log(logs.slice(-10).join('\n'));
  await page.screenshot({ path: '/tmp/ct-m4-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
