// SPEC-TERMINAL-OPS §2 — the pre-spawn credential probe's verdict matrix. This is the wave's motivating
// security decision (present / unverifiable / MISSING→refuse), and it was the one pure-ish helper in
// terminal-manager left un-table-tested while terminalCapacity and shouldReapTerminal were extracted and
// tested precisely so their policy could be exercised. A regression that returns 'present' for an absent
// credential reintroduces the 30-minute silent-wedged terminal the wave exists to remove — so the
// security direction is mutation-checked below (a 'present'-when-absent mutant MUST fail a test).
//
// credentialVerdict reads process.env directly (byte-identical to the inline code it was extracted from),
// so each case runs under a SCRUBBED env (every key the probe reads is cleared, the case's patch applied,
// then restored) — otherwise the host machine's own ANTHROPIC_API_KEY / gcloud ADC file would leak in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderDef, ProviderId, CustomProviderId } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-credverdict-test-'));
process.env.CT_HOME = home;
const { credentialVerdict } = await import('./terminal-manager.js');

// Every env var the probe reads — scrubbed around each case so the host env can't leak a false 'present'
// (and CLOUDSDK_CONFIG is pointed at an empty scratch dir so gcloud's ADC well-known file can't be found).
const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_GENAI_USE_VERTEXAI', 'CT_SKIP_AUTH_PROBE', 'CLOUDSDK_CONFIG', 'MY_KEY',
];
function withEnv<T>(patch: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.CLOUDSDK_CONFIG = mkdtempSync(join(tmpdir(), 'ct-gcloud-')); // empty ⇒ no ADC well-known file
  for (const [k, v] of Object.entries(patch)) process.env[k] = v;
  try { return fn(); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

let n = 0;
const dir = (): string => mkdtempSync(join(tmpdir(), `ct-cfg-${n++}-`));
const noSecret = (): boolean => false;
const emptyRepo = (): string => mkdtempSync(join(tmpdir(), 'ct-repo-'));
const envDef = (keys: string[]): ProviderDef => ({ id: 'custom:x' as CustomProviderId, auth: { mode: 'env' }, secretEnvKeys: keys } as unknown as ProviderDef);
const loginDef = (): ProviderDef => ({ id: 'custom:y' as CustomProviderId, auth: { mode: 'login' } } as unknown as ProviderDef);
const noneDef = (): ProviderDef => ({ id: 'custom:z' as CustomProviderId, auth: { mode: 'none' } } as unknown as ProviderDef);

const verdictOf = (v: ReturnType<typeof credentialVerdict>): string => v.verdict;

test('credentialVerdict — the present/unverifiable/missing matrix', async (t) => {
  await t.test('claude-code: .credentials.json present ⇒ present', () => {
    const cfg = dir();
    writeFileSync(join(cfg, '.credentials.json'), '{}');
    withEnv({}, () => assert.equal(verdictOf(credentialVerdict('claude-code', cfg, emptyRepo(), undefined, undefined, noSecret)), 'present'));
  });

  await t.test('claude-code: ANTHROPIC_API_KEY set ⇒ present', () => {
    withEnv({ ANTHROPIC_API_KEY: 'sk-x' }, () => assert.equal(verdictOf(credentialVerdict('claude-code', dir(), emptyRepo(), undefined, undefined, noSecret)), 'present'));
  });

  await t.test('claude-code: ANTHROPIC_AUTH_TOKEN set ⇒ present', () => {
    withEnv({ ANTHROPIC_AUTH_TOKEN: 't' }, () => assert.equal(verdictOf(credentialVerdict('claude-code', dir(), emptyRepo(), undefined, undefined, noSecret)), 'present'));
  });

  await t.test('claude-code: CLAUDE_CODE_USE_BEDROCK truthy ⇒ present', () => {
    withEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }, () => assert.equal(verdictOf(credentialVerdict('claude-code', dir(), emptyRepo(), undefined, undefined, noSecret)), 'present'));
  });

  // THE envFlagOn pin (caught earlier in the arc): a string "0"/"false" is OFF, not a truthy credential.
  await t.test('claude-code: CLAUDE_CODE_USE_BEDROCK="0" is OFF ⇒ missing (not present)', () => {
    withEnv({ CLAUDE_CODE_USE_BEDROCK: '0' }, () => assert.equal(verdictOf(credentialVerdict('claude-code', dir(), emptyRepo(), undefined, undefined, noSecret)), 'missing'));
  });
  await t.test('claude-code: CLAUDE_CODE_USE_BEDROCK="false" is OFF ⇒ missing (not present)', () => {
    withEnv({ CLAUDE_CODE_USE_BEDROCK: 'false' }, () => assert.equal(verdictOf(credentialVerdict('claude-code', dir(), emptyRepo(), undefined, undefined, noSecret)), 'missing'));
  });

  await t.test('claude-code: settings.json apiKeyHelper ⇒ present (claudeSettingsCarryAuth)', () => {
    const cfg = dir();
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ apiKeyHelper: 'get-key.sh' }));
    withEnv({}, () => assert.equal(verdictOf(credentialVerdict('claude-code', cfg, emptyRepo(), undefined, undefined, noSecret)), 'present'));
  });
  await t.test('claude-code: settings.json env ANTHROPIC_* ⇒ present', () => {
    const cfg = dir();
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-y' } }));
    withEnv({}, () => assert.equal(verdictOf(credentialVerdict('claude-code', cfg, emptyRepo(), undefined, undefined, noSecret)), 'present'));
  });

  await t.test('claude-code: NOTHING found, CT_SKIP unset ⇒ missing (refuse), no missingKeys', () => {
    const v = withEnv({}, () => credentialVerdict('claude-code', dir(), emptyRepo(), undefined, undefined, noSecret));
    assert.equal(v.verdict, 'missing');
    assert.equal((v as { missingKeys?: string[] }).missingKeys, undefined, 'a built-in no-credential is missing WITHOUT named keys');
  });
  await t.test('claude-code: NOTHING found + CT_SKIP_AUTH_PROBE=1 ⇒ unverifiable (spawn, warn)', () => {
    const v = withEnv({ CT_SKIP_AUTH_PROBE: '1' }, () => credentialVerdict('claude-code', dir(), emptyRepo(), undefined, undefined, noSecret));
    assert.equal(v.verdict, 'unverifiable');
    assert.equal((v as { reason: string }).reason, 'CT_SKIP_AUTH_PROBE is set');
  });

  await t.test('codex: auth.json present ⇒ present; absent ⇒ missing', () => {
    const cfg = dir();
    writeFileSync(join(cfg, 'auth.json'), '{}');
    withEnv({}, () => {
      assert.equal(verdictOf(credentialVerdict('codex', cfg, emptyRepo(), undefined, undefined, noSecret)), 'present');
      assert.equal(verdictOf(credentialVerdict('codex', dir(), emptyRepo(), undefined, undefined, noSecret)), 'missing');
    });
  });
  await t.test('codex: config.toml declaring env_key ⇒ present', () => {
    const cfg = dir();
    writeFileSync(join(cfg, 'config.toml'), '[model_providers.azure]\nenv_key = "AZURE_KEY"\n');
    withEnv({}, () => assert.equal(verdictOf(credentialVerdict('codex', cfg, emptyRepo(), undefined, undefined, noSecret)), 'present'));
  });

  await t.test('gemini: oauth_creds present ⇒ present', () => {
    const cfg = dir();
    mkdirSync(join(cfg, '.gemini'), { recursive: true });
    writeFileSync(join(cfg, '.gemini', 'oauth_creds.json'), '{}');
    withEnv({}, () => assert.equal(verdictOf(credentialVerdict('gemini-cli', cfg, emptyRepo(), undefined, undefined, noSecret)), 'present'));
  });
  await t.test('gemini: GOOGLE_APPLICATION_CREDENTIALS set ⇒ present', () => {
    withEnv({ GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json' }, () => assert.equal(verdictOf(credentialVerdict('gemini-cli', dir(), emptyRepo(), undefined, undefined, noSecret)), 'present'));
  });
  await t.test('gemini: GOOGLE_GENAI_USE_VERTEXAI truthy ⇒ present', () => {
    withEnv({ GOOGLE_GENAI_USE_VERTEXAI: 'true' }, () => assert.equal(verdictOf(credentialVerdict('gemini-cli', dir(), emptyRepo(), undefined, undefined, noSecret)), 'present'));
  });
  await t.test('gemini: NOTHING found ⇒ missing (the scrubbed CLOUDSDK_CONFIG hides the host ADC file)', () => {
    withEnv({}, () => assert.equal(verdictOf(credentialVerdict('gemini-cli', dir(), emptyRepo(), undefined, undefined, noSecret)), 'missing'));
  });

  await t.test('custom env-mode: declared key present via hasSecret ⇒ present', () => {
    const has = (id: CustomProviderId, k: string): boolean => id === 'custom:x' && k === 'MY_KEY';
    withEnv({}, () => assert.equal(verdictOf(credentialVerdict('custom:x' as ProviderId, dir(), emptyRepo(), envDef(['MY_KEY']), undefined, has)), 'present'));
  });
  await t.test('custom env-mode: key present via process.env ⇒ present', () => {
    withEnv({ MY_KEY: 'v' } as Record<string, string>, () => assert.equal(verdictOf(credentialVerdict('custom:x' as ProviderId, dir(), emptyRepo(), envDef(['MY_KEY']), undefined, noSecret)), 'present'));
  });
  await t.test('custom env-mode: declared key ABSENT ⇒ missing, and names the key (ignores CT_SKIP_AUTH_PROBE)', () => {
    const v = withEnv({ CT_SKIP_AUTH_PROBE: '1' }, () => credentialVerdict('custom:x' as ProviderId, dir(), emptyRepo(), envDef(['MY_KEY']), undefined, noSecret));
    assert.equal(v.verdict, 'missing', 'a positively-disproved env key is missing even under CT_SKIP_AUTH_PROBE');
    assert.deepEqual((v as { missingKeys?: string[] }).missingKeys, ['MY_KEY']);
  });
  await t.test('custom login-mode ⇒ unverifiable (spawn, do not refuse)', () => {
    const v = withEnv({}, () => credentialVerdict('custom:y' as ProviderId, dir(), emptyRepo(), loginDef(), undefined, noSecret));
    assert.equal(v.verdict, 'unverifiable');
  });
  await t.test('custom none-mode ⇒ present (a local model needs no credential)', () => {
    withEnv({}, () => assert.equal(verdictOf(credentialVerdict('custom:z' as ProviderId, dir(), emptyRepo(), noneDef(), undefined, noSecret)), 'present'));
  });

  await t.test('a deleted def (tombstone) ⇒ unverifiable, not a refusal', () => {
    const v = withEnv({}, () => credentialVerdict('custom:gone' as ProviderId, dir(), emptyRepo(), undefined, undefined, noSecret));
    assert.equal(v.verdict, 'unverifiable');
    assert.equal((v as { reason: string }).reason, 'provider definition is gone');
  });

  await t.test('purpose:login and provider:shell ⇒ present (never refuse a login/shell pane)', () => {
    withEnv({}, () => {
      // A login pane on an unauthenticated account must NOT be refused — it exists to CREATE the credential.
      assert.equal(verdictOf(credentialVerdict('claude-code', dir(), emptyRepo(), undefined, 'login', noSecret)), 'present');
      assert.equal(verdictOf(credentialVerdict('shell', dir(), emptyRepo(), undefined, undefined, noSecret)), 'present');
    });
  });
});

process.on('exit', () => { rmSync(home, { recursive: true, force: true }); });
