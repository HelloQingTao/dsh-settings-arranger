// Regression test for the DSH 0.2.2 settings-nav markup change.
//
// The settings shell renders each nav row roughly as:
//   <button>
//     <span class=navIcon aria-hidden=true>
//       <span data-slot=settings.section.icon><svg/></span>   <-- INLINE slot span
//     </span>
//     <span class=navLabel>General</span>
//   </button>
// `settings.section.icon` is an inline slot, so the outlet is a nested <span>
// inside navIcon. The old `c.querySelector('span:last-child')` identity probe
// resolved to that nested (empty) icon wrapper on EVERY row, so all rows got
// the same empty `data-dsa-id`: groups were pruned and edit mode had nothing
// to drag ("分组失效 + 完全无法编辑").
//
// We exercise the two real functions from client.js (extracted verbatim, so
// the test cannot drift from the shipped code) against a minimal fake DOM.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = await readFile(join(here, '..', 'client.js'), 'utf8');

/** Slice one `function <name>(...) { ... }` declaration out of the bundle by
 *  brace counting (neither target function contains braces inside strings). */
function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `function ${name}() not found in client.js`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.notEqual(end, -1, `unbalanced braces in ${name}()`);
  return source.slice(start, end);
}

const { rowLabelOf, tagRows } = new Function(
  `${extractFunction(SRC, 'rowLabelOf')}\n${extractFunction(SRC, 'tagRows')}\n` +
  'return { rowLabelOf, tagRows };',
)();

// ---------------------------------------------------------------------------
// Minimal DOM stand-in: only the surface rowLabelOf()/tagRows() actually use.
// ---------------------------------------------------------------------------

class FakeEl {
  constructor(tag, { classes = [], attrs = {}, children = [], text = '' } = {}) {
    this.tagName = tag;
    this.children = children;
    this.attrs = new Map(Object.entries(attrs));
    this.classList = { contains: (c) => classes.includes(c) };
    this._text = text;
  }
  get textContent() {
    // Real textContent concatenates descendant text. Our icon subtrees carry
    // none, so this reproduces the shell's rows exactly.
    return this._text || this.children.map((c) => c.textContent).join('');
  }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
}

class FakeList {
  constructor(rows) { this.children = rows; }
  querySelectorAll(selector) {
    return selector === 'button'
      ? this.children.filter((c) => c.tagName === 'BUTTON')
      : [];
  }
}

/** Build one settings nav row. `nestedIcon` reproduces the inline slot outlet. */
function makeRow(label, { nestedIcon = false } = {}) {
  const svg = new FakeEl('SVG');
  const iconChildren = nestedIcon
    ? [new FakeEl('SPAN', {
        attrs: { 'data-slot': 'settings.section.icon' },
        children: [svg],
      })]
    : [svg];
  return new FakeEl('BUTTON', {
    classes: ['navCell'],
    children: [
      new FakeEl('SPAN', {
        classes: ['navIcon'],
        attrs: { 'aria-hidden': 'true' },
        children: iconChildren,
      }),
      new FakeEl('SPAN', { classes: ['navLabel'], text: label }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Regression: nested inline-slot icon span must NOT become the row identity.
// ---------------------------------------------------------------------------

const LABELS = ['通用设置', '检查更新', '手机访问', '模型', '插件', '关于'];

test('tagRows: distinct navLabel ids with the DSH 0.2.2 nested icon slot', () => {
  const rows = LABELS.map((l) => makeRow(l, { nestedIcon: true }));
  tagRows(new FakeList(rows));

  const ids = rows.map((r) => r.getAttribute('data-dsa-id'));
  assert.deepEqual(ids, LABELS, 'every row keeps its own label as identity');
  assert.equal(new Set(ids).size, LABELS.length, 'ids are not all identical');
  assert.ok(ids.every((id) => id.length > 0), 'no empty ids (the old bug)');
});

test('tagRows: same result on the legacy flat-svg icon markup', () => {
  const rows = LABELS.map((l) => makeRow(l, { nestedIcon: false }));
  tagRows(new FakeList(rows));
  assert.deepEqual(rows.map((r) => r.getAttribute('data-dsa-id')), LABELS);
});

test('tagRows: heals a row already stamped with the buggy empty id', () => {
  const rows = LABELS.map((l) => makeRow(l, { nestedIcon: true }));
  rows.forEach((r) => r.setAttribute('data-dsa-id', ''));
  tagRows(new FakeList(rows));
  assert.deepEqual(rows.map((r) => r.getAttribute('data-dsa-id')), LABELS);
});

test('rowLabelOf: ignores trailing empty icon spans, picks the last text span', () => {
  const btn = new FakeEl('BUTTON', {
    children: [
      new FakeEl('SPAN', { classes: ['navIcon'], children: [new FakeEl('SVG')] }),
      new FakeEl('SPAN', { classes: ['navLabel'], text: '  备份与迁移  ' }),
      new FakeEl('SPAN', { attrs: { 'data-slot': 'settings.section.icon' } }),
    ],
  });
  assert.equal(rowLabelOf(btn), '备份与迁移');
});

test('rowLabelOf: falls back to textContent when no labelled span exists', () => {
  const btn = new FakeEl('BUTTON', { text: '裸标签行' });
  assert.equal(rowLabelOf(btn), '裸标签行');
});
