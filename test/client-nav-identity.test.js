// Regression test for the "Settings groups appear on top of the directory
// picker" bug (reported 2026-11-08).
//
// Root cause: findNavList() accepted ANY aria-modal dialog whose marker
// container held ≥3 <button> children. @zfgcta/dsh-multi-folder's directory
// browser is also role="dialog"/aria-modal, and its breadcrumb row
// (.mf-bw-nav) has one button per path segment plus "up" — the current one
// carrying aria-current. So the breadcrumbs got tagged as our nav list:
// `.dsa-nav-list{flex-direction:column}` stacked them vertically and the
// saved group heads were inserted underneath them.
//
// The contract now: only the panel tagged data-shortcut-modal="settings"
// (DSH 0.2.2+), or an unmarked panel whose candidate list has a <nav>
// ancestor AND only icon+label rows, may be adopted.
//
// The three real functions are extracted verbatim from client.js so the test
// cannot drift from the shipped code.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = await readFile(join(here, '..', 'client.js'), 'utf8');

/** Slice one `function <name>(...) { ... }` declaration out of the bundle by
 *  brace counting (none of the targets holds a brace inside a string). */
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

// ---------------------------------------------------------------------------
// Minimal DOM stand-in: only the selectors findNavList()/its probes use.
// ---------------------------------------------------------------------------

class FakeEl {
  constructor(tag, { classes = [], attrs = {}, children = [], text = '' } = {}) {
    this.tagName = tag.toUpperCase();
    this.classes = classes;
    this.attrs = new Map(Object.entries(attrs));
    this.children = children;
    this._text = text;
    this.isConnected = true;
    this.parentElement = null;
    for (const c of children) {
      c.parentElement = this;
      let p = this.parentElement;
      // parentElement is enough for closest(); nothing here re-parents.
      void p;
    }
  }
  get textContent() {
    return this._text || this.children.map((c) => c.textContent).join('');
  }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  hasAttribute(name) { return this.attrs.has(name); }
  closest(selector) {
    if (selector !== 'nav') throw new Error(`unsupported closest(): ${selector}`);
    let node = this;
    while (node) {
      if (node.tagName === 'NAV') return node;
      node = node.parentElement;
    }
    return null;
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (this._matches(child, selector)) return child;
      const hit = child.querySelector(selector);
      if (hit) return hit;
    }
    return null;
  }
  querySelectorAll(selector) {
    const parts = selector.split(',').map((s) => s.trim());
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (parts.some((p) => this._matches(child, p))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  _matches(el, selector) {
    if (selector === 'nav') return el.tagName === 'NAV';
    if (selector === '[class*="navLabel"]') return el.classes.some((c) => c.includes('navLabel'));
    const m = selector.match(/^([a-z0-9]+)((?:\[[^\]]+\])+)$/i);
    if (!m) throw new Error(`unsupported selector: ${selector}`);
    if (el.tagName !== m[1].toUpperCase()) return false;
    const attrs = m[2].match(/\[([^\]]+)\]/g) || [];
    return attrs.every((a) => el.hasAttribute(a.slice(1, -1).trim()));
  }
}

function fakeDocument(panels) {
  return {
    querySelectorAll(selector) {
      assert.equal(selector, '[role="dialog"][aria-modal="true"]');
      return panels;
    },
  };
}

/** A settings-shell nav row: <button><span class=navIcon/><span class=navLabel>Text</span></button> */
function navRow(label) {
  return new FakeEl('button', {
    classes: ['VOzbGW_navCell'],
    attrs: { 'data-modal-autofocus': '' },
    children: [
      new FakeEl('span', { classes: ['VOzbGW_navIcon'] }),
      new FakeEl('span', { classes: ['VOzbGW_navLabel'], text: label }),
    ],
  });
}

/** The real settings panel: <div role=dialog aria-modal data-shortcut-modal=settings><nav><div class=navList>rows</div></nav></div> */
function settingsPanel({ marked = true, labels = ['通用设置', '模型', '通知'] } = {}) {
  const list = new FakeEl('div', { classes: ['VOzbGW_navList'], children: labels.map(navRow) });
  const nav = new FakeEl('nav', { classes: ['VOzbGW_nav'], children: [list] });
  const attrs = { role: 'dialog', 'aria-modal': 'true' };
  if (marked) attrs['data-shortcut-modal'] = 'settings';
  return { panel: new FakeEl('div', { attrs, children: [nav] }), list };
}

/** The directory picker as @zfgcta/dsh-multi-folder renders it: breadcrumb
 *  row of plain-text buttons, current crumb carrying aria-current. */
function directoryPickerPanel(crumbs = ['主目录', 'Projects', 'dsh-plugin-develop']) {
  const buttons = crumbs.map((label, i) => new FakeEl('button', {
    classes: ['mf-bw-crumb'],
    attrs: i === crumbs.length - 1 ? { 'aria-current': 'true' } : {},
    text: label,
  }));
  buttons.push(new FakeEl('button', { classes: ['mf-bw-up'], text: '↑ 上一级' }));
  const list = new FakeEl('div', { classes: ['mf-bw-nav'], children: buttons });
  const panel = new FakeEl('div', {
    attrs: { role: 'dialog', 'aria-modal': 'true' },
    children: [new FakeEl('div', { classes: ['mf-bw-dialog'], children: [list] })],
  });
  return { panel, list };
}

// ---------------------------------------------------------------------------

test('adopts the marked settings panel nav list', () => {
  const { panel, list } = settingsPanel();
  assert.equal(findNavListVia(fakeDocument([panel])), list);
});

test('ignores the directory picker breadcrumb row (the 0.1.6 bug)', () => {
  const { panel, list } = directoryPickerPanel();
  assert.equal(findNavListVia(fakeDocument([panel])), null);
  assert.equal(list.getAttribute('data-dsa-anchored'), null);
});

test('ignores a stale anchor on an unmarked panel', () => {
  const { panel, list } = directoryPickerPanel();
  list.setAttribute('data-dsa-anchored', '1');
  assert.equal(findNavListVia(fakeDocument([panel])), null);
});

test('accepts an unmarked (older shell) list only with the full structural proof', () => {
  const { panel, list } = settingsPanel({ marked: false });
  assert.equal(findNavListVia(fakeDocument([panel])), list);
});

test('rejects an unmarked dialog whose 3-button list is not inside <nav>', () => {
  const list = new FakeEl('div', { classes: ['some-row'], children: [navRow('a'), navRow('b'), navRow('c')] });
  const panel = new FakeEl('div', {
    attrs: { role: 'dialog', 'aria-modal': 'true' },
    children: [list],
  });
  assert.equal(findNavListVia(fakeDocument([panel])), null);
});

test('a marked panel skip-probes an already anchored list', () => {
  // Anchored rows that lost their label spans (e.g. an icon-only row) must
  // still be adopted once the Settings panel itself is positively identified.
  const list = new FakeEl('div', {
    classes: ['VOzbGW_navList'],
    attrs: { 'data-dsa-anchored': '1' },
    children: [
      new FakeEl('button', { attrs: { 'data-modal-autofocus': '' }, text: 'A' }),
      new FakeEl('button', { text: 'B' }),
      new FakeEl('button', { text: 'C' }),
    ],
  });
  const nav = new FakeEl('nav', { children: [list] });
  const panel = new FakeEl('div', {
    attrs: { role: 'dialog', 'aria-modal': 'true', 'data-shortcut-modal': 'settings' },
    children: [nav],
  });
  assert.equal(findNavListVia(fakeDocument([panel])), list);
});

/** findNavList() reads the ambient `document`; bind one for the call. */
function findNavListVia(document) {
  const fn = new Function(
    'document',
    `${extractFunction(SRC, 'looksLikeNavCell')}\n` +
    `${extractFunction(SRC, 'looksLikeSettingsNavList')}\n` +
    `${extractFunction(SRC, 'findNavList')}\n` +
    'return findNavList();',
  );
  return fn(document);
}
