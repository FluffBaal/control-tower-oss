import { chromium } from 'playwright';

const PORT = process.env.PORT ?? '4885';
const BASE = `http://127.0.0.1:${PORT}`;
const O = { Origin: BASE };
async function tok() { return (await (await fetch(`${BASE}/api/session`, { headers: O })).json()).token; }
async function api(p, t) { const r = await fetch(`${BASE}${p}`, { headers: { ...O, 'X-Tower-Token': t } }); return { ok: r.ok, status: r.status }; }

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1300, height: 880 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
  // Endpoint battery across all milestones
  const t = await tok();
  const eps = ['/api/health', '/api/adapters', '/api/security', '/api/projects', '/api/terminals',
    '/api/attention', '/api/identities', '/api/profiles', '/api/testruns', '/api/audit', '/api/observability'];
  const results = await Promise.all(eps.map((e) => api(e, t)));
  const allOk = results.every((r) => r.ok);
  console.log(`ENDPOINTS: ${results.filter((r) => r.ok).length}/${eps.length} ok`);

  // UI: Mission Control renders
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByText('Control Tower').first().waitFor({ timeout: 8000 });
  const missionOk = await page.getByRole('button', { name: /Mission Control/ }).first().isVisible();

  // Accounts & Identities view → Health + Recent activity render
  await page.getByRole('button', { name: /Accounts & Identities/ }).click();
  await page.getByText('Health', { exact: true }).waitFor({ timeout: 6000 });
  await page.getByText('Recent activity').waitFor({ timeout: 6000 });
  const healthOk = await page.getByText('disk free').isVisible();
  const auditOk = (await page.locator('.audit-action').count()) > 0;

  // Service worker registered (PWA)
  await page.waitForTimeout(800);
  const swRegistered = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.length > 0;
  });

  await page.screenshot({ path: '/tmp/ct-final.png' });
  console.log(`UI: mission=${missionOk} health=${healthOk} audit=${auditOk} sw=${swRegistered}`);
  console.log(`CONSOLE ERRORS: ${errors.length}`);

  const pass = allOk && missionOk && healthOk && auditOk && errors.length === 0;
  console.log(pass ? 'FINAL E2E: PASS' : 'FINAL E2E: FAIL');
  if (!pass) { console.log(errors.join('\n')); process.exitCode = 1; }
} catch (err) {
  console.log('FINAL E2E: FAIL', err.message);
  console.log(errors.join('\n'));
  await page.screenshot({ path: '/tmp/ct-final-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
