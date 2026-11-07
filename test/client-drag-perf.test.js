// Regression test for edit-mode drag lag ("整理状态下拖动卡顿").
//
// Root cause: `dragover` fires ~60-120/s even with a STILL pointer. The old
// attachDnd ran `clearMarks()` (a full nav querySelectorAll + class removes)
// and an unconditional `classList.add` on EVERY event. Those class writes are
// observed by the nav MutationObserver (attributeFilter: ['class', ...]) whose
// callback calls syncFlags() — a full re-assert of every row. So each frame fed
// itself: ~240 class writes, ~120 full re-asserts for a 120-event hover, and
// the drag felt sticky.
//
// The fix has two halves, both guarded here:
//   1. setDropMark() writes the DOM only when {el, side} actually changes, so
//      a steady hover is a no-op (guards the clearMarks/add removal).
//   2. watch()'s observer callback early-returns while `_dragging` is true, so
//      even a stray class write cannot wake syncFlags mid-gesture.
//
// These methods are extracted VERBATIM from client.js (brace counting), so the
// test cannot drift from the shipped code. The fake DOM counts the writes that
// matter; to prove the guard, run against a pre-fix build, e.g.
//   DSA_SRC=/tmp/dsa-client-before.js node --test test/client-drag-perf.test.js
// — the two hot-path assertions below fail there (242 writes / 122 syncFlags).

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = await readFile(process.env.DSA_SRC || join(here, '..', 'client.js'), 'utf8');

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
// Bare `name() {}` methods are only valid inside an object literal.
const body = 'return {\n' + parts.filter(Boolean).join(',\n') + '\n};';

// ---- counting fake DOM -------------------------------------------------
const C = () => ({ classWrites: 0, scans: 0, syncFlagsCalls: 0 });
let counts = C();
let observerCb = null;
let pending = [];

class FakeMutationObserver {
  constructor(cb) { observerCb = cb; }
  observe() {}
  disconnect() { observerCb = null; pending = []; }
}
function queueMutation(target, type = 'attributes') {
  pending.push({ type, target, attributeName: 'class' });
}
function flush() {
  const records = pending.splice(0);
  if (!observerCb || !records.length) return;
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
    this.isConnected = true;
    this.dataset = {};
    this.draggable = false;
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

function setFlag() {}

const factory = new Function('MutationObserver', 'setTimeout', 'clearTimeout', 'setFlag', body);
const M = factory(FakeMutationObserver, () => 0, () => {}, setFlag);

/** Fresh harness: 6 rows, real methods bound to ARRANGER-shaped state. */
function harness() {
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
      return list.querySelectorAll('button')
        .filter(el => !el.classList.contains('dsa-group-head'))
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
  return { A, rows, list, fire };
}

// ---------------------------------------------------------------------------
// The hot-path guard: a still pointer must not rewrite the DOM or wake the
// observer. These two assertions FAIL on the pre-fix build (242 / 122).
// ---------------------------------------------------------------------------

test('steady dragover is a no-op: no repeated class writes, no observer re-assert', () => {
  const { A, rows, fire } = harness();
  fire(rows[0], 'dragstart');   // sets _dragging, adds .dsa-dragging
  flush();
  counts = C();                 // measure ONLY the steady-hover loop
  for (let i = 0; i < 120; i++) {
    fire(rows[3], 'dragover', { clientY: rows[3]._rect.top + 2 }); // same target + same side
    flush();
  }
  assert.ok(counts.classWrites <= 2,
    `a still pointer must not rewrite the DOM on every event (got ${counts.classWrites})`);
  assert.equal(counts.syncFlagsCalls, 0,
    'no full nav re-assert may run while dragging (observer muted)');
  assert.equal(counts.scans, 0,
    'no full-subtree querySelectorAll on the dragover hot path');
});

// ---------------------------------------------------------------------------
// Correctness: the marker is still shown, and still relocates when the target
// or the side changes. A "fix" that simply disabled markers would fail here.
// ---------------------------------------------------------------------------

test('drop marker appears, relocates on a new target, and flips before/after', () => {
  const { A, rows, fire } = harness();
  fire(rows[0], 'dragstart');
  flush();

  fire(rows[3], 'dragover', { clientY: rows[3]._rect.top + 2 }); // upper half → before
  flush();
  assert.ok(rows[3].classList.contains('dsa-drop-before'), 'marker shows on hovered row');

  fire(rows[5], 'dragover', { clientY: rows[5]._rect.top + 2 });
  flush();
  assert.ok(!rows[3].classList.contains('dsa-drop-before'), 'old marker is cleared');
  assert.ok(rows[5].classList.contains('dsa-drop-before'), 'marker relocates to new row');

  fire(rows[5], 'dragover', { clientY: rows[5]._rect.top + 28 }); // lower half → after
  flush();
  assert.ok(!rows[5].classList.contains('dsa-drop-before'), 'before marker removed on flip');
  assert.ok(rows[5].classList.contains('dsa-drop-after'), 'after marker shown on flip');
});

test('dragend clears the marker and unmutes the observer', () => {
  const { A, rows, fire } = harness();
  fire(rows[0], 'dragstart');
  flush();
  fire(rows[2], 'dragover', { clientY: rows[2]._rect.top + 2 });
  flush();
  assert.ok(A._dragging, 'observer is muted during the drag');
  fire(rows[0], 'dragend');
  flush();
  assert.equal(A._dragging, false, 'observer is live again after the drag');
  assert.ok(!rows[2].classList.contains('dsa-drop-before'), 'marker removed on dragend');
  assert.equal(A._dropMark, null, 'tracked marker is reset');
});

// Direct unit of the idempotency primitive (present only in the fixed build).
test('setDropMark writes only when {el, side} changes', () => {
  const { A, rows } = harness();
  if (typeof A.setDropMark !== 'function') return; // pre-fix build: covered by test 1
  counts = C();
  A.setDropMark(rows[1], 'before');
  A.setDropMark(rows[1], 'before');
  A.setDropMark(rows[1], 'before');
  assert.equal(counts.classWrites, 1, 'three identical marks → one write');
  A.setDropMark(rows[1], 'after');
  assert.equal(counts.classWrites, 3, 'side flip → remove + add');
  A.setDropMark(rows[2], 'after');
  assert.equal(counts.classWrites, 5, 'new target → remove old + add new');
});

// ---- exit-path guards --------------------------------------------------
// A muted observer must never outlive the gesture, and a host className
// rewrite must not leave the marker blank while the cached {el, side} matches.

test('a detached drag source re-arms the nav observer', () => {
  const { A, rows, list, fire } = harness();
  fire(rows[0], 'dragstart');
  flush();
  assert.equal(A._dragging, true, 'observer is muted during the drag');

  // Host re-render detaches the source: neither dragend nor drop will arrive.
  rows[0].isConnected = false;
  pending.push({ type: 'childList', target: list, removedNodes: [rows[0]] });
  counts = C();
  flush();

  assert.equal(A._dragging, false, 'structural change ends the gesture');
  assert.equal(A._dragEl, null, 'drag source is released');
  assert.ok(counts.syncFlagsCalls >= 1, 'normal repair path runs again');

  counts = C();
  queueMutation(rows[1]);
  flush();
  assert.ok(counts.syncFlagsCalls >= 1, 'observer stays live after recovery');
});

test('marker recovers when the host rewrites the hovered row className', () => {
  const { rows, fire } = harness();
  fire(rows[0], 'dragstart');
  flush();
  fire(rows[3], 'dragover', { clientY: rows[3]._rect.top + 2 });
  flush();
  assert.ok(rows[3].classList.contains('dsa-drop-before'), 'marker shown');

  // The shell rewrites className mid-drag; our class is gone but the cache
  // still points at this row.
  rows[3]._classes.clear();
  fire(rows[3], 'dragover', { clientY: rows[3]._rect.top + 2 });
  flush();
  assert.ok(rows[3].classList.contains('dsa-drop-before'), 'marker recovers');

  // Recovery must not reintroduce the hot-path writes.
  counts = C();
  for (let i = 0; i < 120; i++) {
    fire(rows[3], 'dragover', { clientY: rows[3]._rect.top + 2 });
    flush();
  }
  assert.equal(counts.classWrites, 0, 'steady hover is still a no-op');
  assert.equal(counts.scans, 0, 'no full-subtree scan on the hot path');
});
