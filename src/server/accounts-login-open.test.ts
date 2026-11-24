// The Connections "log in" button must SURFACE the login terminal it spawns. The old handler
// was `act(() => tower.loginProfile(p.id))`: the POST created a "login: <label>" terminal, act()
// awaited + refreshed and DISCARDED it — the button looked dead while orphan login terminals
// piled up. AccountsPanel is a component (not unit-mountable in this suite), so the fix is
// pinned at the source level (the AssistantDock appendSegment / renderRowBody idiom): the bug
// shape must fail HERE if it ever comes back, and tsc guards the onOpenTerminal prop chain
// (App → SettingsView → ConnectionsSection → AccountsPanel) — a missing hop fails typecheck.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const panelSrc = readFileSync(join(here, '../web/AccountsPanel.tsx'), 'utf8');
const settingsSrc = readFileSync(join(here, '../web/SettingsView.tsx'), 'utf8');

/** The source of one `const <name> = async (...) => { ... };` panel handler, by name. */
function handlerBlock(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = async`);
  assert.ok(start >= 0, `handler ${name} exists`);
  const end = src.indexOf('\n  };', start);
  assert.ok(end > start, `handler ${name} closes`);
  return src.slice(start, end);
}

test('log in captures the returned terminal and opens it (source pin)', () => {
  const login = handlerBlock(panelSrc, 'login');
  assert.ok(login.includes('await tower.loginProfile('), 'the handler awaits the login POST');
  assert.ok(login.includes('onOpenTerminal(term.id)'), 'the returned terminal is opened, not discarded');
  // The bug shape: routing loginProfile through act() throws the Terminal away.
  assert.ok(!panelSrc.includes('act(() => tower.loginProfile'), 'the discard-the-terminal form is gone');
});

test('AccountsPanel requires the onOpenTerminal prop', () => {
  assert.ok(panelSrc.includes('onOpenTerminal: (id: string) => void'), 'props type carries the callback');
});

test('ConnectionsSection threads onOpenTerminal into AccountsPanel', () => {
  // Slice the <AccountsPanel …/> JSX block; other children (QuickConnect, ProvidersPanel)
  // already received the prop, so pin the one hop that was missing.
  const open = settingsSrc.indexOf('<AccountsPanel');
  assert.ok(open >= 0, 'the section renders AccountsPanel');
  const close = settingsSrc.indexOf('/>', open);
  const jsx = settingsSrc.slice(open, close);
  assert.ok(jsx.includes('onOpenTerminal={onOpenTerminal}'), 'the hop is wired');
});

test('adopt (use this computer’s login) stays a no-terminal path', () => {
  // adoptMachineLogin copies the machine credential — there is no terminal to open, and the
  // row confirms with the transient "login copied" chip instead.
  const adopt = handlerBlock(panelSrc, 'adopt');
  assert.ok(adopt.includes('tower.adoptMachineLogin('), 'adopt still adopts');
  assert.ok(!adopt.includes('onOpenTerminal'), 'adopt never tries to open a terminal');
});
