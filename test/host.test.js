// Host-half test surface for dsh-settings-arranger.
// Runs on the built-in node:test runner (zero devDependencies):
//   node --test test/
//
// Covers the two defensive contracts the client depends on:
// - SettingsStore: read never throws, bad files are quarantined, writes are
//   atomic; and
// - createApiHandler: the loopback fence, the endpoint table, body cap and the
//   PUT normalization rejections.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import {
  API_PREFIX,
  InvalidLayoutError,
  MAX_BODY_BYTES,
  SettingsStore,
  createApiHandler,
  isLoopbackRequest,
  normalizeLayout,
} from '../index.js';

let home;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsa-test-'));
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// normalizeLayout
// ---------------------------------------------------------------------------

test('normalizeLayout keeps well-formed entries and drops malformed ones', () => {
  const result = normalizeLayout({
    groups: [
      { id: 'g1', label: '常用', sectionIds: ['a', 'b', 42, '', null] },
      { nope: true },
      null,
      { id: '', sectionIds: [] },
    ],
    collapsed: ['g1', 7, 'g2'],
    order: [{ kind: 'group', id: 'g1' }, { kind: 'row', id: 'a' }, 'junk', { kind: 'nope', id: 'x' }],
    lastSection: 'a',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.layout, {
    groups: [{ id: 'g1', sectionIds: ['a', 'b'], label: '常用' }],
    collapsed: ['g1', 'g2'],
    order: [{ kind: 'group', id: 'g1' }, { kind: 'row', id: 'a' }],
    lastSection: 'a',
  });
});

test('normalizeLayout preserves order:null and lastSection:null', () => {
  const result = normalizeLayout({ groups: [], collapsed: [], order: null, lastSection: null });
  assert.equal(result.ok, true);
  assert.equal(result.layout.order, null);
  assert.equal(result.layout.lastSection, null);
});

test('normalizeLayout rejects wrong container types with per-field errors', () => {
  const result = normalizeLayout({ groups: 'nope', collapsed: 3, order: {}, lastSection: 5 });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    'layout.groups must be an array',
    'layout.collapsed must be an array',
    'layout.order must be an array or null',
    'layout.lastSection must be a string or null',
  ]);
});

test('normalizeLayout rejects a non-object layout', () => {
  assert.equal(normalizeLayout('x').ok, false);
  assert.equal(normalizeLayout(null).ok, false);
  assert.equal(normalizeLayout([]).ok, false);
});

// ---------------------------------------------------------------------------
// SettingsStore
// ---------------------------------------------------------------------------

test('readConfig on a missing file returns null without throwing', async () => {
  const store = new SettingsStore({ home });
  const config = await store.readConfig();
  assert.equal(config, null);
  assert.equal(store.health().exists, false);
  assert.equal(store.health().ok, true);
});

test('writeLayout → readConfig roundtrip, file is 0600 and human-readable', async () => {
  const store = new SettingsStore({ home });
  const layout = { groups: [{ id: 'g1', label: '常用', sectionIds: ['a'] }], collapsed: [], order: [{ kind: 'group', id: 'g1' }], lastSection: 'a' };
  const written = await store.writeLayout(layout);
  assert.equal(written.version, 1);
  assert.ok(written.updatedAt);

  const config = await store.readConfig();
  assert.equal(config.version, 1);
  assert.equal(config.updatedAt, written.updatedAt);
  assert.deepEqual(config.layout, layout);

  // 0600 file mode (POSIX) and a trailing newline for hand edits.
  if (process.platform !== 'win32') {
    const mode = (await stat(store.configPath)).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  const text = await readFile(store.configPath, 'utf8');
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(JSON.parse(text).layout, layout);
});

test('a file with invalid JSON is quarantined, not overwritten', async () => {
  const store = new SettingsStore({ home });
  const bad = '{not json';
  await writeFileRaw(store.configPath, bad);
  const config = await store.readConfig();
  assert.equal(config, null);
  // Original is preserved; a .corrupt- copy sits next to it.
  assert.equal(await readFile(store.configPath, 'utf8'), bad);
  const siblings = await readdir(home);
  const corrupt = siblings.filter(name => name.startsWith('settings-arranger.json.corrupt-'));
  assert.equal(corrupt.length, 1);
  assert.equal(await readFile(join(home, corrupt[0]), 'utf8'), bad);
  assert.equal(store.health().corruption.detected, true);
  // The same bad content is not copied twice.
  await store.readConfig();
  const again = (await readdir(home)).filter(name => name.startsWith('settings-arranger.json.corrupt-'));
  assert.equal(again.length, 1);
});

test('a structurally invalid layout is quarantined too', async () => {
  const store = new SettingsStore({ home });
  await writeFileRaw(store.configPath, JSON.stringify({ version: 1, layout: { groups: 'nope' } }));
  const config = await store.readConfig();
  assert.equal(config, null);
  assert.equal(store.health().corruption.detected, true);
});

test('writeLayout rejects invalid caller input and leaves the file untouched', async () => {
  const store = new SettingsStore({ home });
  const good = { groups: [{ id: 'g1', sectionIds: [] }], collapsed: [], order: null, lastSection: null };
  await store.writeLayout(good);
  // writeLayout is async: rejections must be awaited, not assert.throws()'d.
  await assert.rejects(() => store.writeLayout({ groups: 'nope' }), InvalidLayoutError);
  await assert.rejects(() => store.writeLayout('nope'), InvalidLayoutError);
  const config = await store.readConfig();
  assert.deepEqual(config.layout, good);
});

test('reset removes the file and clears corruption state', async () => {
  const store = new SettingsStore({ home });
  await store.writeLayout({ groups: [], collapsed: [], order: null, lastSection: null });
  await store.reset();
  assert.equal(await store.readConfig(), null);
  assert.equal(store.health().exists, false);
  assert.equal(store.health().corruption.detected, false);
});

async function writeFileRaw(path, text) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, text, 'utf8');
}

// ---------------------------------------------------------------------------
// HTTP surface (mock req/res, no real server)
// ---------------------------------------------------------------------------

/** Minimal IncomingMessage stand-in: enough for the fence, URL parsing and body drain. */
function mockReq({ method = 'GET', url = '/config', peer = '127.0.0.1', host = '127.0.0.1:3080', body = null }) {
  const listeners = {};
  return {
    method,
    url,
    headers: { host },
    socket: { remoteAddress: peer },
    on(event, fn) {
      (listeners[event] ??= []).push(fn);
      return this;
    },
    // Deliver the body (if any) on the next tick, then end.
    _go() {
      queueMicrotask(() => {
        if (body !== null) for (const fn of listeners.data ?? []) fn(Buffer.from(body));
        for (const fn of listeners.end ?? []) fn();
      });
    },
  };
}

/** Minimal ServerResponse stand-in capturing status and body. */
function mockRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
      return this;
    },
    end(text) {
      this.ended = true;
      this.body = text === undefined ? null : JSON.parse(text);
    },
  };
}

async function handle(reqOptions, store) {
  const handler = createApiHandler(store ?? new SettingsStore({ home }));
  const req = mockReq(reqOptions);
  const res = mockRes();
  const promise = handler(req, res);
  req._go();
  await promise;
  return res;
}

test('the loopback fence rejects remote peers and DNS-rebind shapes', async () => {
  // Remote peer, loopback Host: a proxied request.
  let res = await handle({ peer: '10.0.0.5', host: '127.0.0.1:3080' });
  assert.equal(res.statusCode, 403);
  // Loopback peer, foreign Host: exactly the DNS-rebinding shape.
  res = await handle({ peer: '127.0.0.1', host: 'evil.example:3080' });
  assert.equal(res.statusCode, 403);
  // Both halves present: accepted (localhost with port, [::1] spelling).
  res = await handle({ peer: '127.0.0.1', host: 'localhost:3080' });
  assert.equal(res.statusCode, 200);
  res = await handle({ peer: '::1', host: '[::1]:3080' });
  assert.equal(res.statusCode, 200);
});

test('isLoopbackRequest accepts every loopback spelling Node reports', () => {
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackRequest(mockReq({ peer })), true);
  }
  assert.equal(isLoopbackRequest(mockReq({ peer: '192.168.1.9' })), false);
  assert.equal(isLoopbackRequest({ socket: {}, headers: {} }), false);
});

test('unknown endpoints and wrong methods are answered 404/405', async () => {
  let res = await handle({ url: '/config/extra' });
  assert.equal(res.statusCode, 404);
  res = await handle({ method: 'DELETE', url: '/config' });
  assert.equal(res.statusCode, 405);
  res = await handle({ method: 'GET', url: '/reset' });
  assert.equal(res.statusCode, 405);
});

test('the mount prefix is stripped: dsh delivers full URLs to prefix handlers', async () => {
  // Regression (2026-10-24, caught live on a temp instance): dsh registers
  // { kind: 'prefix' } handlers with the FULL request URL, while the endpoint
  // table is inner-relative — before the strip, every real request 404'd.
  let res = await handle({ url: `${API_PREFIX}/config` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.config, null);
  // Trailing slash tolerated.
  res = await handle({ url: `${API_PREFIX}/config/` });
  assert.equal(res.statusCode, 200);
  // Same semantics for the reset endpoint.
  res = await handle({ method: 'POST', url: `${API_PREFIX}/reset` });
  assert.equal(res.statusCode, 200);
  // A prefix-shaped but bogus endpoint still 404s.
  res = await handle({ url: `${API_PREFIX}/nope` });
  assert.equal(res.statusCode, 404);
});

test('GET /config on an empty store answers config:null plus health', async () => {
  const res = await handle({});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.config, null);
  assert.equal(res.body.health.configPath, join(home, 'settings-arranger.json'));
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('PUT /config writes through normalization and echoes the stored config', async () => {
  const store = new SettingsStore({ home });
  const layout = { groups: [{ id: 'g1', sectionIds: ['a'], label: 'x' }], collapsed: [], order: null, lastSection: 'a' };
  const res = await handle({ method: 'PUT', body: JSON.stringify({ layout }) }, store);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.config.layout, layout);
  const stored = JSON.parse(await readFile(store.configPath, 'utf8'));
  assert.deepEqual(stored.layout, layout);
  assert.ok(stored.updatedAt);
});

test('PUT /config rejects malformed bodies with 400 and 413', async () => {
  let res = await handle({ method: 'PUT', body: 'not json' });
  assert.equal(res.statusCode, 400);
  res = await handle({ method: 'PUT', body: JSON.stringify({ nope: 1 }) });
  assert.equal(res.statusCode, 400);
  res = await handle({ method: 'PUT', body: JSON.stringify({ layout: { groups: 'nope' } }) });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.details.includes('layout.groups must be an array'));
  // Over the 256 KB cap: refused before any store call.
  const big = 'x'.repeat(MAX_BODY_BYTES + 1);
  res = await handle({ method: 'PUT', body: JSON.stringify({ layout: { groups: [], collapsed: [], order: null, lastSection: big } }) });
  assert.equal(res.statusCode, 413);
});

test('POST /reset removes the file and answers config:null', async () => {
  const store = new SettingsStore({ home });
  await store.writeLayout({ groups: [], collapsed: [], order: null, lastSection: null });
  const res = await handle({ method: 'POST', url: '/reset' }, store);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.config, null);
  assert.equal(await store.readConfig(), null);
});
