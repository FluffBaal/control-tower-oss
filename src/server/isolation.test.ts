// SPEC D14/§14 — the honesty of the isolation status readouts. The bug this pins: the moment the host
// marker appears, securityStatus() must NOT report egressControl:true / residualRisk:null, because the
// Tower does not yet spawn agents under separate UIDs (ENFORCEMENT_IMPLEMENTED === false) — so no
// boundary is actually in force. isolationMode stays a capability signal; egress + residual report
// ENFORCEMENT truth. projectSecurity() already drew that distinction and must stay unchanged.
//
// CT_HOME is set before the modules load: paths.ts freezes it at import time, and the marker lives at
// <CT_HOME>/isolation-enabled, so toggling that file drives hostIsolationAvailable().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-isolation-test-'));
process.env.CT_HOME = home;

const { securityStatus, projectSecurity } = await import('./isolation.js');
const MARKER = join(home, 'isolation-enabled');

function setMarker(present: boolean) {
  if (present) writeFileSync(MARKER, '1');
  else rmSync(MARKER, { force: true });
}

const project = (isolation: Project['isolation']): Project => ({
  id: 'p1', name: 'p', repoPath: '/tmp/x', scaffoldMode: 'zero-footprint', isolation,
  createdAt: new Date().toISOString(),
});

test('securityStatus — marker ABSENT reports single-uid with the setup hint', () => {
  setMarker(false);
  const s = securityStatus(true);
  assert.equal(s.isolationMode, 'single-uid');
  assert.equal(s.egressControl, false, 'no host provisioning → no egress control');
  assert.equal(s.brokerActive, true);
  assert.match(s.residualRisk ?? '', /setup-isolation/, 'points the operator at the provisioning script');
});

test('securityStatus — marker PRESENT is honest: capability up, but egress still off and risk stated', () => {
  setMarker(true);
  const s = securityStatus(true);
  // isolationMode is a CAPABILITY signal — it flips to per-agent-uid once the host CAN isolate.
  assert.equal(s.isolationMode, 'per-agent-uid');
  // …but nothing is enforced yet, so the honest readout keeps egress OFF and states the residual risk.
  assert.equal(s.egressControl, false, 'a provisioned host does NOT imply egress is controlled');
  assert.notEqual(s.residualRisk, null, 'residual risk is NOT cleared by the marker alone');
  assert.match(s.residualRisk ?? '', /NOT yet implemented/, 'names the missing enforcement, not a green state');
});

test('projectSecurity — the per-project mirror is unchanged (requested-but-not-enforced)', () => {
  setMarker(true);
  const ps = projectSecurity(project('per-agent-uid'), true);
  assert.equal(ps.enforced, false, 'intent alone never enforces');
  assert.equal(ps.effective, 'single-uid');
  assert.equal(ps.egressControl, false);
  assert.match(ps.residualRisk ?? '', /NOT yet enforced/, 'the per-project wording is untouched');
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
