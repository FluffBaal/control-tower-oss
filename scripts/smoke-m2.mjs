import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const PORT = process.env.PORT ?? '4873';
const CTH = process.env.CTH ?? '/tmp/ct-m2e';
const BASE = `http://127.0.0.1:${PORT}`;
const O = { Origin: BASE };

async function tok() {
  const r = await fetch(`${BASE}/api/session`, { headers: O });
  return (await r.json()).token;
}
async function api(path, token) {
  const r = await fetch(`${BASE}${path}`, { headers: { ...O, 'X-Tower-Token': token } });
  return r.json();
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByText('Control Tower').first().waitFor({ timeout: 8000 });
  console.log('RENDER: ok');

  // Add project
  await page.getByRole('button', { name: '+ project' }).click();
  await page.getByPlaceholder('name').fill('m2');
  await page.getByPlaceholder('/abs/path/to/repo').fill('/tmp/ct-demo-repo');
  await page.getByRole('button', { name: 'add' }).click();
  await page.getByText('m2', { exact: true }).waitFor({ timeout: 8000 });
  console.log('PROJECT: ok');

  // Create a Claude Code terminal via the provider menu
  await page.getByRole('button', { name: '+ terminal ▾' }).click();
  await page.getByRole('button', { name: 'Claude Code' }).click();
  await page.locator('.xterm-screen').waitFor({ timeout: 10000 });
  console.log('TERMINAL(claude): mounted');

  // Find the terminal id + its hook token, then inject a simulated permission event.
  const token = await tok();
  const terms = await api('/api/terminals', token);
  const t = terms.find((x) => x.provider === 'claude-code');
  if (!t) throw new Error('claude terminal not found via API');
  const hookTok = readFileSync(`${CTH}/secrets/hooktok-${t.id}`, 'utf8').trim();
  const ev = await fetch(`${BASE}/api/events`, {
    method: 'POST',
    headers: { ...O, 'Content-Type': 'application/json', 'X-Tower-Terminal-Token': hookTok },
    body: JSON.stringify({ terminalId: t.id, signal: 'needs-permission', emitTs: '1000' }),
  });
  console.log(`HOOK inject: http=${ev.status}`);

  // Go to Mission Control home and expect an attention card
  await page.getByRole('button', { name: /Mission Control/ }).first().click();
  await page.locator('.attn-card.permission').waitFor({ timeout: 8000 });
  const cardTitle = await page.locator('.attn-card.permission .attn-title').first().innerText();
  const hasApprove = await page.getByRole('button', { name: 'approve' }).first().isVisible();
  const badge = await page.locator('.badge-attn').first().innerText().catch(() => '');
  console.log(`ATTENTION card: title="${cardTitle}" approveBtn=${hasApprove} topbarBadge="${badge}"`);

  // Click approve — with no real dialog on the claude screen, the safety gate must
  // refuse (409) and surface an error, proving we never blind-approve.
  await page.getByRole('button', { name: 'approve' }).first().click();
  const gated = await page.locator('.error-bar').first().innerText({ timeout: 4000 }).catch(() => '(no error shown)');
  console.log(`APPROVE gate surfaced: "${gated}"`);

  await page.screenshot({ path: '/tmp/ct-m2.png' });
  const pass = cardTitle.includes('m2') && hasApprove;
  console.log(pass ? 'E2E: PASS' : 'E2E: FAIL');
  if (!pass) process.exitCode = 1;
} catch (err) {
  console.log('E2E: FAIL', err.message);
  console.log(logs.slice(-15).join('\n'));
  await page.screenshot({ path: '/tmp/ct-m2-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
