// Broker — the ephemeral land-push grant (acquireDaemonPush) and the socket that serves it. The grant
// path is what routes the Tower's OWN `git push` in land() PR mode through the credential broker with an
// identity-scoped token, fail-open. A typecheck says nothing about the lifecycle or the auth boundary.
//
// CT_HOME is set before the modules load: paths.ts freezes it at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ct-broker-daemon-'));
process.env.CT_HOME = home;

const { ensureDirs, paths } = await import('./paths.js');
ensureDirs();
const { Broker, BROKER_SOCK } = await import('./broker.js');
const { Accounts } = await import('./accounts.js');
const { Store } = await import('./store.js');

/** Read a required env key, asserting it is present (narrows string | undefined → string under
 *  the test config's noUncheckedIndexedAccess). */
function need(env: Record<string, string>, key: string): string {
  const v = env[key];
  assert.ok(v, `env.${key} must be set`);
  return v;
}

/** One request/response round-trip against the broker unix socket. */
function ask(req: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const c = net.connect(BROKER_SOCK, () => c.write(`${JSON.stringify(req)}\n`));
    let buf = '';
    c.on('data', (d) => (buf += d.toString()));
    c.on('end', () => {
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve(buf);
      }
    });
    c.on('error', reject);
  });
}

test('acquireDaemonPush: falsy/unknown/credential-less → undefined; with a credential → grant, then release revokes', () => {
  const store = new Store();
  const accounts = new Accounts();
  const broker = new Broker(store, accounts);

  assert.equal(broker.acquireDaemonPush(undefined), undefined, 'undefined identity → no grant');
  assert.equal(broker.acquireDaemonPush(''), undefined, 'empty identity → no grant');
  assert.equal(broker.acquireDaemonPush('no-such-identity'), undefined, 'unknown identity → no grant');

  const idn = accounts.createIdentity('landbot', 'Land Bot', 'land@example.com');
  assert.equal(idn.hasCredential, false);
  assert.equal(broker.acquireDaemonPush(idn.id), undefined, 'credential-less identity → no grant');

  accounts.setCredential(idn.id, 'ghp_TESTLANDTOKEN');
  const grant = broker.acquireDaemonPush(idn.id);
  assert.ok(grant, 'a credentialed identity yields a grant');
  // Exactly the 7 env keys the daemon push needs.
  assert.equal(Object.keys(grant.env).length, 7);
  assert.equal(grant.env.GIT_CONFIG_COUNT, '2');
  assert.equal(grant.env.GIT_CONFIG_KEY_0, 'credential.helper');
  assert.equal(grant.env.GIT_CONFIG_VALUE_0, '', 'entry 0 RESETS any global credential.helper');
  assert.equal(grant.env.GIT_CONFIG_KEY_1, 'credential.helper');
  assert.ok(need(grant.env, 'GIT_CONFIG_VALUE_1').length > 0, 'entry 1 points at the broker helper');
  assert.ok(need(grant.env, 'TOWER_BROKER_SOCK').length > 0);

  const tokFile = need(grant.env, 'TOWER_BROKER_TOKEN_FILE');
  assert.ok(tokFile.includes('landtok-'), 'the token file is a landtok-* file');
  assert.equal(existsSync(tokFile), true);
  assert.equal(statSync(tokFile).mode & 0o777, 0o600, 'the token file is 0600');

  grant.release();
  assert.equal(existsSync(tokFile), false, 'release removes the token file');
});

test('broker socket serves a land grant for github over https, and the auth boundary runs before token resolution', async () => {
  const store = new Store();
  const accounts = new Accounts();
  const idn = accounts.createIdentity('landbot2', 'Land Bot 2', 'land2@example.com');
  accounts.setCredential(idn.id, 'ghp_LANDTOKEN2');
  const broker = new Broker(store, accounts);
  broker.start();
  try {
    const grant = broker.acquireDaemonPush(idn.id);
    assert.ok(grant);
    const token = readFileSync(need(grant.env, 'TOWER_BROKER_TOKEN_FILE'), 'utf8').trim();

    // Happy path: a land token + https + github.com → the PAT (username x-access-token).
    assert.deepEqual(
      await ask({ token, host: 'github.com', protocol: 'https' }),
      { username: 'x-access-token', password: 'ghp_LANDTOKEN2' },
    );

    // Off-boundary requests are denied — and the host/protocol checks run BEFORE token resolution, so a
    // BOGUS token to a non-GitHub host still trips 'host not allowed' (never 'no credential').
    assert.deepEqual(await ask({ token: 'bogus', host: 'evil.example', protocol: 'https' }), { error: 'host not allowed' });
    assert.deepEqual(await ask({ token, host: 'evil.example', protocol: 'https' }), { error: 'host not allowed' });
    assert.deepEqual(await ask({ token, host: 'github.com', protocol: 'http' }), { error: 'protocol not allowed' });

    // After release the same token no longer resolves to a credential.
    grant.release();
    assert.deepEqual(await ask({ token, host: 'github.com', protocol: 'https' }), { error: 'no credential' });
  } finally {
    broker.stop();
  }
});

test('start() sweeps stale landtok-* files', async () => {
  const store = new Store();
  const accounts = new Accounts();
  const stale = join(paths.secrets, 'landtok-old');
  writeFileSync(stale, 'leftover', { mode: 0o600 });
  assert.equal(existsSync(stale), true);
  const broker = new Broker(store, accounts);
  broker.start();
  try {
    assert.equal(existsSync(stale), false, 'a crashed-land leftover token file is swept at start');
  } finally {
    broker.stop();
  }
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
