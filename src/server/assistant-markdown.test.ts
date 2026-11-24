// The dock's markdown pass (src/web/markdown.tsx). Everything asserts element SHAPE, not
// markup strings, because the renderer's safety property is structural: no HTML parse step,
// string-only leaf children, and <a href> as the single gated sink. Hostile inputs are
// asserted INERT (no img/script element can exist, no <a> for a non-http(s) scheme, no node
// carries dangerouslySetInnerHTML) — plus a source-level scan pinning the sink inventory.
// Lives in the server tree because the test glob only picks up src/server/*.test.ts (same
// web-module import precedent as skills-governance.test.ts → ../web/skills-diff.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, renderRowBody } from '../web/markdown.js';

// ---- React-element introspection (no DOM, no renderer — shape only) ----

interface ElLike {
  type: unknown;
  props: { [k: string]: unknown; children?: unknown };
}
const isEl = (n: unknown): n is ElLike =>
  !!n && typeof n === 'object' && 'type' in (n as object) && 'props' in (n as object);

/** Depth-first visit of every element in a ReactNode tree. */
function walk(node: unknown, visit: (el: ElLike) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (isEl(node)) {
    visit(node);
    walk(node.props.children, visit);
  }
}

function elsOfType(node: unknown, type: string): ElLike[] {
  const hits: ElLike[] = [];
  walk(node, (el) => {
    if (el.type === type) hits.push(el);
  });
  return hits;
}

/** Concatenated string content of a tree — what the user would read. */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isEl(node)) return textOf(node.props.children);
  return '';
}

/** Every leaf in the tree must be a string (or an element recursing to strings) — the
 *  structural guarantee that React escapes all content. */
function assertStringLeaves(node: unknown, ctx: string): void {
  if (node === null || node === undefined || typeof node === 'string') return;
  if (Array.isArray(node)) {
    for (const n of node) assertStringLeaves(n, ctx);
    return;
  }
  assert.ok(isEl(node), `${ctx}: non-string, non-element leaf: ${JSON.stringify(node)}`);
  assertStringLeaves(node.props.children, ctx);
}

const className = (el: ElLike): string => String(el.props.className ?? '');

// ---- block + inline shape ----

test('inline styling maps to typed elements with string children', () => {
  const out = renderMarkdown('mix of **bold**, *ital*, `code` here');
  assert.equal(out.length, 1);
  const p = out[0] as ElLike;
  assert.equal(p.type, 'div');
  assert.equal(className(p), 'md-p');
  const strong = elsOfType(out, 'strong');
  assert.equal(strong.length, 1);
  assert.equal(strong[0]!.props.children, 'bold');
  const em = elsOfType(out, 'em');
  assert.equal(em.length, 1);
  assert.equal(em[0]!.props.children, 'ital');
  const code = elsOfType(out, 'code');
  assert.equal(code.length, 1);
  assert.equal(className(code[0]!), 'md-code mono');
  assert.equal(code[0]!.props.children, 'code');
  assert.equal(textOf(out), 'mix of bold, ital, code here');
});

test('fenced block renders raw content as one string child of <pre>', () => {
  const out = renderMarkdown('before\n```ts\nconst a = 1;\n**not bold**\n```\nafter');
  assert.equal(out.length, 3);
  const pre = elsOfType(out, 'pre');
  assert.equal(pre.length, 1);
  assert.equal(className(pre[0]!), 'md-pre mono');
  // Raw — the fence body is NEVER inline-tokenized, and the language tag is dropped.
  assert.equal(pre[0]!.props.children, 'const a = 1;\n**not bold**');
  assert.equal(elsOfType(out, 'strong').length, 0);
  assert.equal(textOf(out[0]), 'before');
  assert.equal(textOf(out[2]), 'after');
});

test('an unclosed fence swallows to EOF without crashing', () => {
  const out = renderMarkdown('```\ndangling');
  assert.equal(out.length, 1);
  assert.equal((out[0] as ElLike).type, 'pre');
  assert.equal((out[0] as ElLike).props.children, 'dangling');
});

test('headings map # levels to md-h1..md-h3 divs', () => {
  const out = renderMarkdown('# one\n## two\n### three');
  assert.equal(out.length, 3);
  const classes = out.map((n) => className(n as ElLike));
  assert.deepEqual(classes, ['md-h1', 'md-h2', 'md-h3']);
  for (const n of out) assert.equal((n as ElLike).type, 'div');
  assert.equal(textOf(out), 'onetwothree');
});

test('list runs group into one ul/ol with an li per line', () => {
  const out = renderMarkdown('- a\n- b\n\n1. one\n2. two');
  assert.equal(out.length, 2);
  const ul = elsOfType(out, 'ul');
  const ol = elsOfType(out, 'ol');
  assert.equal(ul.length, 1);
  assert.equal(ol.length, 1);
  const ulis = elsOfType(ul, 'li');
  assert.deepEqual(ulis.map((li) => textOf(li.props.children)), ['a', 'b']);
  const olis = elsOfType(ol, 'li');
  assert.deepEqual(olis.map((li) => textOf(li.props.children)), ['one', 'two']);
});

// ---- the whitespace decision, verified via element shape ----
// .amsg keeps white-space:pre-wrap. That stays double-space-free only if the renderer (a)
// CONSUMES blank separator lines (no whitespace text nodes between blocks — gaps are .md-p
// margins) and (b) PRESERVES single newlines inside a paragraph as string content.

test('a \\n\\n boundary yields exactly two md-p divs and no loose text nodes', () => {
  const out = renderMarkdown('first paragraph\n\nsecond paragraph');
  assert.equal(out.length, 2);
  for (const n of out) {
    assert.ok(isEl(n), 'top level must be elements only — a stray string would re-add the gap under pre-wrap');
    assert.equal((n as ElLike).type, 'div');
    assert.equal(className(n as ElLike), 'md-p');
  }
  assert.equal(textOf(out[0]), 'first paragraph');
  assert.equal(textOf(out[1]), 'second paragraph');
});

test('a single newline stays inside one paragraph (pre-wrap renders the break)', () => {
  const out = renderMarkdown('line one\nline two');
  assert.equal(out.length, 1);
  assert.equal(className(out[0] as ElLike), 'md-p');
  assert.equal(textOf(out[0]), 'line one\nline two');
});

// ---- XSS: hostile input must be inert BY SHAPE ----

test('html in the text can only exist as a string child — never an element', () => {
  const hostile = 'x <img src=x onerror=alert(1)> y <script>alert(2)</script> z';
  const out = renderMarkdown(hostile);
  assert.equal(elsOfType(out, 'img').length, 0);
  assert.equal(elsOfType(out, 'script').length, 0);
  assertStringLeaves(out, 'hostile html');
  assert.equal(textOf(out), hostile); // fully preserved, purely as text
});

test('non-http(s) link schemes yield NO <a> — the literal text renders instead', () => {
  const bad = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '/relative/path',
    'ftp://host/file',
  ];
  for (const url of bad) {
    const out = renderMarkdown(`click [here](${url}) now`);
    assert.equal(elsOfType(out, 'a').length, 0, `no <a> for ${url}`);
    assert.ok(textOf(out).includes(`[here](${url})`), `literal text kept for ${url}`);
  }
});

test('http and https links pass the gate with the hardened rel/target', () => {
  for (const url of ['https://example.com/docs?a=1', 'http://example.com/x']) {
    const out = renderMarkdown(`see [the docs](${url})`);
    const a = elsOfType(out, 'a');
    assert.equal(a.length, 1);
    assert.equal(a[0]!.props.href, url);
    assert.equal(a[0]!.props.target, '_blank');
    assert.equal(a[0]!.props.rel, 'noopener noreferrer');
    assert.equal(a[0]!.props.children, 'the docs'); // label is a string, never re-parsed
  }
});

// ---- the role gate (the dock's bubble span renders through renderRowBody, not
// renderMarkdown) — the user branch must return the RAW string, so a gating mutant that
// markdowns user text fails on both the type and the bytes ----

test('renderRowBody: assistant text is markdown, user/system text is the literal string', () => {
  const a = renderRowBody('assistant', 'x **y**');
  assert.ok(Array.isArray(a), 'assistant branch returns the element tree');
  assert.equal(elsOfType(a, 'strong').length, 1);
  assert.equal(textOf(a), 'x y');
  const userText = '**x** and [l](https://e.com) and `c`';
  const u = renderRowBody('user', userText);
  assert.equal(typeof u, 'string', 'user branch must return a string, never a tree');
  assert.equal(u, userText, 'user text comes back byte-identical — no styling, no link');
  const s = renderRowBody('system', '**x**');
  assert.equal(s, '**x**');
});

test('the dock renders bubble bodies ONLY through the role gate (source pin)', () => {
  // AssistantDock is not unit-mountable, so the call site is pinned at the source level
  // (same source-invariant idiom as the import-graph assert in skills-governance.test.ts):
  // the msg span must go through renderRowBody, and the dock must never call renderMarkdown
  // directly — otherwise the user-text-stays-plain gate stops being the only path.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../web/AssistantDock.tsx'), 'utf8');
  assert.ok(src.includes('renderRowBody(row.role, row.text)'), 'the msg span renders via the role gate');
  assert.ok(!src.includes('renderMarkdown('), 'no direct renderMarkdown call in the dock');
});

test('no node carries dangerouslySetInnerHTML (tree + source scan)', () => {
  const kitchenSink =
    '# h\n**b** *i* `c` [l](https://e.com) [j](javascript:x)\n\n- li **x**\n\n```\n<img src=x onerror=1>\n```\n\npara <b>tag</b>';
  const out = renderMarkdown(kitchenSink);
  let seen = 0;
  walk(out, (el) => {
    seen++;
    assert.ok(!('dangerouslySetInnerHTML' in el.props), `dangerouslySetInnerHTML on <${String(el.type)}>`);
  });
  assert.ok(seen >= 8, `kitchen sink should produce a real tree (saw ${seen} elements)`);
  assertStringLeaves(out, 'kitchen sink');
  // Source-level pin: the renderer and the dock must never grow an HTML-string sink.
  // Comments are stripped first — markdown.tsx's header NAMES the forbidden sink.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const file of ['../web/markdown.tsx', '../web/AssistantDock.tsx']) {
    const src = readFileSync(join(here, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    assert.ok(!src.includes('innerHTML'), `${file} must not touch innerHTML in code`);
  }
});
