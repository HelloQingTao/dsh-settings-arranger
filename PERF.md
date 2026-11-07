# Performance ledger

One place to record what was measured, what was tried, and what was kept — so a
dead idea is not re-run next quarter. See also the performance-optimization
skill's Step 4 ledger convention.

Tool: [tools/measure-drag.mjs](tools/measure-drag.mjs) replays a synthetic drag
against the **real** `attachDnd` / `clearMarks` / `setDropMark` / `syncFlags` /
`watch` methods extracted verbatim from a given `client.js` build (brace
counting). Same command, same 120-event budget, before and after:

```
node tools/measure-drag.mjs /tmp/dsa-client-before.js   # pre-fix build
node tools/measure-drag.mjs client.js                    # fixed build
```

## Edit-mode drag lag (「整理状态下拖动卡顿」)

Symptoms: dragging a plugin row in 整理/编辑 mode feels sticky/janky.

Root cause (measured, not assumed): `dragover` fires ~60–120/s even with a
*still* pointer. The old handler ran `clearMarks()` (a full
`querySelectorAll` over the nav subtree + class removes) plus an unconditional
`classList.add` on every event. Those class writes are observed by the nav
`MutationObserver` (`attributeFilter: ['class', ...]`) whose callback calls
`syncFlags()` — a re-assert of every native row. One self-feeding full nav
re-assert per dragover frame.

| Scenario (120 dragover events) | Metric | Before | After |
|---|---|---|---|
| steadyHover (still pointer) | classWrites | 242 | **4** |
| steadyHover (still pointer) | full-subtree scans | 121 | **1** |
| steadyHover (still pointer) | `syncFlags()` full re-asserts | 122 | **1** |
| moving (relocating pointer) | classWrites | 242 | **14** |
| moving (relocating pointer) | `syncFlags()` full re-asserts | 241 | **1** |

The remaining 1 re-assert / 1 scan after the fix is **deliberate**: `dragend`
unmutes the observer so the nav re-syncs once at the end of the gesture. It is
not on the dragover hot path.

| Idea | Baseline → Result | Verdict | Why |
|---|---|---|---|
| Idempotent `setDropMark(el, side)` (write only when target/side changes) | 242 → 4 classWrites (steady) | **kept** | Removes the unconditional clear+add on every event; the marker still relocates/flips correctly. |
| Mute the observer via `_dragging` for the whole drag | 122 → 1 syncFlags (steady) | **kept** | Double safety against any stray class write (e.g. host `aria-current` churn) waking `syncFlags()` mid-gesture. |
| Drop the `dragleave` handler entirely | (part of the kept fix) | **kept** | `dragleave` also fires when crossing a child inside the same row, blanking the marker and re-arming the observer per pixel; the next `dragover` relocates it and `dragend`/`drop` clear it. |
| rAF-throttle `dragover` | not measured | not tried | Idempotency already collapses the steady case to zero writes; an rAF queue would add a frame of latency to the marker with no further win. |

Regression guard: `test/client-drag-perf.test.js` runs the same real methods
against a counting fake DOM. Its hot-path assertion **fails on the pre-fix
build** (239 class writes / observer not muted) and passes on the fixed build.
