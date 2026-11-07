#!/usr/bin/env node
// Synthetic measurement of the edit-mode drag hot path.
//
// Replays a drag against the REAL attachDnd/clearMarks/setDropMark/syncFlags/
// watch methods extracted verbatim from a client.js build, using a counting
// fake DOM. Nothing here is a re-implementation of the plugin logic: the
// before/after numbers come from shipped code.
//
//   node tools/measure-drag.mjs /tmp/dsa-client-before.js   # baseline
//   node tools/measure-drag.mjs client.js                    # after fix
//
// What is counted per drag session:
//   classWrites       classList calls that actually changed the DOM
//   scans             querySelectorAll calls on the nav subtree
//   observerCallbacks MutationObserver callback invocations
//   syncFlagsCalls    full nav re-assertions (the expensive one)
//   setFlagCalls      per-row attribute comparisons
//
// dragover fires continuously (~60-120/s) even when the pointer is STILL, so
// "steadyHover" is the scenario that decides whether a drag feels sticky.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const file = process.argv[2];
assert.ok(file, 'usage: node tools/measure-drag.mjs <client.js>');
const SRC = await readFile(file, 'utf8');

/** Slice one ARRANGER method (`      name(args) { ... }`) by brace counting. */
function method(name) {
  const marker = `\n      ${name}(`;
  const start = SRC.indexOf(marker);
  if (start === -1) return null;
  const open = SRC.indexOf('{', SRC.indexOf('(', start));
  let depth = 0;
  let end = -1;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.notEqual(end, -1, `unbalanced braces in ${name}()`);
  return SRC.slice(start + 1, end);
}

const NAMES = ['attachDnd', 'clearMarks', 'setDropMark', 'endDrag', 'syncFlags', 'watch'];
const parts = NAMES.map(method);
const present = NAMES.filter((n, i) => parts[i]);
// Bare `name() {}` method definitions are only valid inside an object
// literal, so wrap the extracted methods and return that object.
const body = 'return {\n' + parts.filter(Boolean).join(',\n') + '\n};';

// ---- counting fake DOM -------------------------------------------------
const C = () => ({
  classWrites: 0, scans: 0, observerCallbacks: 0,
  syncFlagsCalls: 0, setFlagCalls: 0,
});
let counts = C();
let observerCb = null;
let pending = [];

class FakeMutationObserver {
  constructor(cb) { observerCb = cb; }
  observe() {}
  disconnect() { observerCb = null; pending = []; }
}
function queueMutation(target) {
  pending.push({ type: 'attributes', target, attributeName: 'class' });
}
function flush() {
  const records = pending.splice(0);
  if (!observerCb || !records.length) return;
  counts.observerCallbacks++;
  observerCb(records);
}

class FakeEl {
  constructor(tag, opts = {}) {
    this.tagName = tag.toUpperCase();
    this._attrs = new Map(Object.entries(opts.attrs || {}));
    this._classes = new Set(opts.classes || []);
    this.children = opts.children || [];
    for (const c of this.children) c.parentElement = this;
    this.parentElement = null;
    this.dataset = {};
    this.listeners = {};
    this._rect = opts.rect || { top: 0, height: 30 };
  }
  get classList() {
    const self = this;
    return {
      contains: c => self._classes.has(c),
      add(...cs) {
        let changed = false;
        for (const c of cs) if (!self._classes.has(c)) { self._classes.add(c); changed = true; }
        if (changed) { counts.classWrites++; queueMutation(self); }
      },
      remove(...cs) {
        let changed = false;
        for (const c of cs) if (self._classes.has(c)) { self._classes.delete(c); changed = true; }
        if (changed) { counts.classWrites++; queueMutation(self); }
      },
    };
  }
  getAttribute(n) {
    if (n === 'class') return [...this._classes].join(' ') || null;
    return this._attrs.has(n) ? this._attrs.get(n) : null;
  }
  setAttribute(n, v) { this._attrs.set(n, String(v)); }
  hasAttribute(n) { return n === 'class' ? this._classes.size > 0 : this._attrs.has(n); }
  removeAttribute(n) { if (n === 'class') this._classes.clear(); else this._attrs.delete(n); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  getBoundingClientRect() { return this._rect; }
  contains(o) { let n = o; while (n) { if (n === this) return true; n = n.parentElement; } return false; }
}

class FakeList extends FakeEl {
  querySelectorAll(sel) {
    counts.scans++;
    const out = [];
    const walk = n => {
      for (const c of n.children) {
        if (sel === 'button') { if (c.tagName === 'BUTTON') out.push(c); }
        else if (sel.includes('dsa-drop-before')) {
          if (c._classes.has('dsa-drop-before') || c._classes.has('dsa-drop-after')) out.push(c);
        }
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

function setFlag(el, name, on) {
  counts.setFlagCalls++;
  if (!el) return;
  if (on) { if (el.getAttribute(name) !== '1') el.setAttribute(name, '1'); }
  else if (el.hasAttribute(name)) el.removeAttribute(name);
}

const factory = new Function(
  'MutationObserver', 'setTimeout', 'clearTimeout', 'setFlag', body,
);
const M = factory(FakeMutationObserver, () => 0, () => {}, setFlag);

// ---- one scenario ------------------------------------------------------
function run(label, { events, moving }) {
  counts = C();
  pending = [];
  observerCb = null;

  const rows = [];
  for (let i = 0; i < 6; i++) {
    rows.push(new FakeEl('button', {
      attrs: { 'data-dsa-id': 'r' + i },
      rect: { top: i * 30, height: 30 },
      children: [new FakeEl('span')],
    }));
  }
  const list = new FakeList('div', { children: rows });
  for (const r of rows) r.parentElement = list;

  const A = {
    editing: true,
    state: { groups: [{ id: 'g1', sectionIds: ['r1', 'r2'] }], collapsed: [], order: [] },
    navList: list, observer: null, _suppress: false, _t: 0,
    _dragging: false, _dropMark: null, __dsaDead: false,
    ...M,
    move() {}, settle() {},
    nativeRows() {
      const els = list.querySelectorAll('button');
      return els.filter(el => !el.classList.contains('dsa-group-head'))
        .map(el => ({ el, id: el.getAttribute('data-dsa-id') }))
        .filter(r => r.id);
    },
  };
  A.syncFlags = function () { counts.syncFlagsCalls++; return M.syncFlags.call(A); };

  const dt = { setData() {}, getData() { return ''; }, effectAllowed: '' };
  const fire = (el, type, extra = {}) => {
    const ev = {
      type, target: el, pointerType: 'mouse', dataTransfer: dt, clientY: 0,
      preventDefault() {}, stopPropagation() {}, ...extra,
    };
    for (const fn of el.listeners[type] || []) fn.call(el, ev);
    let p = el.parentElement;
    while (p) { for (const fn of p.listeners[type] || []) fn.call(p, ev); p = p.parentElement; }
  };

  for (const r of rows) A.attachDnd(r, { kind: 'row', id: r.getAttribute('data-dsa-id') });
  A.watch(list);

  const src = rows[0];
  fire(src, 'dragstart');
  flush();
  for (let i = 0; i < events; i++) {
    const target = moving ? rows[i % rows.length] : rows[3];
    if (moving && i > 0) { fire(rows[(i - 1) % rows.length], 'dragleave'); flush(); }
    fire(target, 'dragover', { clientY: target._rect.top + 2 });
    flush();
  }
  fire(src, 'dragend');
  flush();

  console.log(`${label.padEnd(18)} classWrites=${String(counts.classWrites).padStart(4)}` +
    `  scans=${String(counts.scans).padStart(4)}` +
    `  observerCb=${String(counts.observerCallbacks).padStart(4)}` +
    `  syncFlags=${String(counts.syncFlagsCalls).padStart(4)}` +
    `  setFlag=${String(counts.setFlagCalls).padStart(5)}`);
  return { ...counts };
}

console.log(`\nbuild: ${file}`);
console.log(`has setDropMark: ${SRC.includes('setDropMark')}   has _dragging guard: ${SRC.includes('this._dragging')}\n`);
const steady = run('steadyHover(120)', { events: 120, moving: false });
const moving = run('moving(120)', { events: 120, moving: true });
console.log('');
