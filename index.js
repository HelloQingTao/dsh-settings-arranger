// dsh-settings-arranger — host half.
//
// The client half owns all the UI; this module owns the single configuration
// file (`$DSH_HOME/settings-arranger.json`) and the loopback HTTP surface the
// browser half reaches it through. The file is GLOBAL by design (user decision
// 2026-10-24): both profiles share one layout, last write wins.
//
// Defensive posture (patterns proven in dsh-railist's host half):
// - Read never throws: a missing file means "no layout"; an unparsable or
//   structurally invalid file is copied aside as
//   `settings-arranger.json.corrupt-<timestamp>` and served as no-layout —
//   never overwritten, never deleted.
// - Write normalizes the layout (lenient structural check, no schema engine,
//   zero dependencies), then writes a 0600 temp file and renames it over the
//   target (direct-write fallback where Windows refuses the replace).
// - Every route is fenced twice: loopback peer address AND loopback `Host`
//   header (that pair is what stops a DNS-rebound browser page), with a
//   256 KB body cap.
//
// `webServer` is deliberately NOT in `inject`: a host without a webserver must
// still load this plugin (its client half silently degrades to localStorage,
// i.e. exactly the pre-0.2.0 behavior).

import { access, constants as fsConstants, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const name = 'dsh-settings-arranger';

/** No hard service requirements — see the file comment about `webServer`. */
export const inject = [];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Prefix route registered through the optional `webServer` service. */
export const API_PREFIX = '/settings-arranger/api';

/** The one file this plugin owns inside the harness home. */
const FILE_NAME = 'settings-arranger.json';

/** Layout document version; bump only for a breaking shape change. */
const SCHEMA_VERSION = 1;

/** Largest accepted request body. Layouts are a few KB; 256 KB is generous. */
export const MAX_BODY_BYTES = 256 * 1024;

/** Peer addresses the fence accepts: IPv4 loopback, its IPv6 form, and the IPv4-mapped spelling Node reports. */
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/** `Host` authorities the fence accepts. */
const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '::1'];

/** Normalization caps; the body cap bounds everything else. */
const LAYOUT_LIMITS = {
  groups: 64,        // max custom groups
  groupIds: 128,     // max members per group
  order: 256,        // max top-level blocks
  idLength: 160,     // max id / lastSection length
  labelLength: 200,  // max group label length
};

/** Endpoints under the prefix: pathname → allowed methods. */
const ENDPOINTS = [
  { path: '/config', methods: ['GET', 'PUT'] },
  { path: '/reset', methods: ['POST'] },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  return typeof code === 'string' ? code : undefined;
}

function isNotFound(error) {
  return errorCode(error) === 'ENOENT';
}

/** A short, stable fingerprint of unreadable text, so one bad file is set aside once. */
function contentSignature(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length}:${hash.toString(16)}`;
}

/** Harness home: explicit override → `$DSH_HOME` → `~/.dsh`. */
export function resolveHome(explicit) {
  const fromArg = typeof explicit === 'string' && explicit.trim() !== '' ? explicit : undefined;
  const fromEnv = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : undefined;
  const chosen = fromArg ?? fromEnv;
  if (chosen === undefined) return join(homedir(), '.dsh');
  return resolve(chosen);
}

// ---------------------------------------------------------------------------
// Layout normalization (lenient; the client sends its localStorage payload)
// ---------------------------------------------------------------------------

/** A write was refused by the structural check. */
export class InvalidLayoutError extends Error {
  constructor(details) {
    super(details[0] ?? 'the layout was rejected');
    this.name = 'InvalidLayoutError';
    this.details = details;
  }
}

/**
 * Normalize a raw client layout into the stored shape.
 *
 * Container types are mandatory (that is what "invalid" means here); everything
 * else is lenient — malformed entries are dropped, strings capped, unknown
 * fields stripped. The client's own loader re-validates on read anyway, so the
 * stored file only needs to stay parseable and bounded.
 * @returns `{ ok: true, layout }` or `{ ok: false, errors }`.
 */
export function normalizeLayout(raw) {
  if (!isRecord(raw)) return { ok: false, errors: ['layout must be an object'] };
  const errors = [];
  if (!Array.isArray(raw.groups)) errors.push('layout.groups must be an array');
  if (!Array.isArray(raw.collapsed)) errors.push('layout.collapsed must be an array');
  if (raw.order !== null && raw.order !== undefined && !Array.isArray(raw.order)) {
    errors.push('layout.order must be an array or null');
  }
  if (raw.lastSection !== null && raw.lastSection !== undefined && typeof raw.lastSection !== 'string') {
    errors.push('layout.lastSection must be a string or null');
  }
  if (errors.length > 0) return { ok: false, errors };

  // Groups: keep well-formed entries, drop the rest (never fail a whole write
  // over one bad group — the client renders whatever survives).
  const groups = [];
  for (const g of raw.groups.slice(0, LAYOUT_LIMITS.groups)) {
    if (!isRecord(g) || typeof g.id !== 'string' || g.id === '') continue;
    const group = {
      id: g.id.slice(0, LAYOUT_LIMITS.idLength),
      sectionIds: Array.isArray(g.sectionIds)
        ? g.sectionIds
            .filter(id => typeof id === 'string' && id !== '')
            .slice(0, LAYOUT_LIMITS.groupIds)
        : [],
    };
    if (typeof g.label === 'string' && g.label !== '') group.label = g.label.slice(0, LAYOUT_LIMITS.labelLength);
    groups.push(group);
  }

  const collapsed = raw.collapsed
    .filter(id => typeof id === 'string' && id !== '')
    .slice(0, LAYOUT_LIMITS.groups);

  // Top-level block sequence: `null` means "follow the native order".
  const order = Array.isArray(raw.order)
    ? raw.order
        .slice(0, LAYOUT_LIMITS.order)
        .filter(b => isRecord(b) && (b.kind === 'group' || b.kind === 'row') && typeof b.id === 'string' && b.id !== '')
        .map(b => ({ kind: b.kind, id: b.id.slice(0, LAYOUT_LIMITS.idLength) }))
    : null;

  const lastSection = typeof raw.lastSection === 'string'
    ? raw.lastSection.slice(0, LAYOUT_LIMITS.idLength)
    : null;

  return { ok: true, layout: { groups, collapsed, order, lastSection } };
}

// ---------------------------------------------------------------------------
// Store: the one file, defended in both directions
// ---------------------------------------------------------------------------

/**
 * The file store behind `GET/PUT /settings-arranger/api/config`.
 *
 * Nothing is read at construction; only `writeLayout` throws (and only for
 * caller input that fails normalization).
 */
export class SettingsStore {
  /** @param {{home?: string}} [options] */
  constructor(options = {}) {
    this.home = resolveHome(options.home);
    this.configPath = join(this.home, FILE_NAME);
    this.state = {
      exists: false,
      writable: true,
      lastError: undefined,
      corruption: { detected: false, backupPath: undefined },
      corruptSignature: undefined,
    };
  }

  /** Whether the home exists and accepts writes; creates it if absent. */
  async refreshWritable() {
    try {
      await mkdir(this.home, { recursive: true });
      await access(this.home, fsConstants.W_OK);
      this.state.writable = true;
    } catch (error) {
      this.state.writable = false;
      this.state.lastError = describe(error);
    }
  }

  /**
   * Read the stored config. Never throws: missing file → `null` (plus
   * `exists: false` in health); unparsable/invalid file → quarantined, `null`.
   * @returns `{ version, updatedAt, layout } | null`.
   */
  async readConfig() {
    const state = this.state;
    state.lastError = undefined;
    await this.refreshWritable();

    let raw;
    try {
      raw = await readFile(this.configPath, 'utf8');
    } catch (error) {
      if (isNotFound(error)) {
        state.exists = false;
        state.corruption = { detected: false, backupPath: undefined };
        state.corruptSignature = undefined;
        return null;
      }
      state.lastError = describe(error);
      return null;
    }
    state.exists = true;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.quarantine(raw, 'the stored configuration is not valid JSON');
      return null;
    }
    if (!isRecord(parsed)) {
      await this.quarantine(raw, 'the stored configuration is not an object');
      return null;
    }
    const normalized = normalizeLayout(parsed.layout);
    if (!normalized.ok) {
      await this.quarantine(raw, `the stored layout is invalid: ${normalized.errors.join('; ')}`);
      return null;
    }
    // A hand-edited file may omit updatedAt; it is informational only.
    state.corruption = { detected: false, backupPath: undefined };
    state.corruptSignature = undefined;
    return {
      version: typeof parsed.version === 'number' ? parsed.version : SCHEMA_VERSION,
      ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {}),
      layout: normalized.layout,
    };
  }

  /**
   * Normalize and store one layout (atomic replace).
   * @throws {InvalidLayoutError} when the caller's own input fails normalization.
   */
  async writeLayout(rawLayout) {
    const normalized = normalizeLayout(rawLayout);
    if (!normalized.ok) throw new InvalidLayoutError(normalized.errors);
    const document = {
      version: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      layout: normalized.layout,
    };
    await this.writeDocument(document);
    return document;
  }

  /** Remove the file (reset to "no layout"); quarantine state resets with it. */
  async reset() {
    try {
      await rm(this.configPath, { force: true });
    } catch (error) {
      this.state.lastError = describe(error);
    }
    this.state.exists = false;
    this.state.corruption = { detected: false, backupPath: undefined };
    this.state.corruptSignature = undefined;
  }

  /** Last-known storage state; every read/write refreshes it. */
  health() {
    const { corruption, lastError } = this.state;
    return {
      ok: !corruption.detected && lastError === undefined,
      configPath: this.configPath,
      writable: this.state.writable,
      exists: this.state.exists,
      corruption: {
        detected: corruption.detected,
        ...(corruption.backupPath === undefined ? {} : { backupPath: corruption.backupPath }),
      },
      ...(lastError === undefined ? {} : { lastError }),
      checkedAt: new Date().toISOString(),
    };
  }

  /** Atomic write: 0600 temp file + rename, direct-write fallback on Windows locks. */
  async writeDocument(document) {
    const text = `${JSON.stringify(document, null, 2)}\n`;
    await mkdir(dirname(this.configPath), { recursive: true });
    const tempPath = `${this.configPath}.${process.pid.toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(tempPath, text, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(tempPath, this.configPath);
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
        await rm(tempPath, { force: true });
        throw error;
      }
      // Windows refuses to replace a file another handle holds open: write in
      // place instead; a torn write is recovered by the corrupt-file path.
      await writeFile(this.configPath, text, { encoding: 'utf8', mode: 0o600 });
      await rm(tempPath, { force: true });
    }
    this.state.exists = true;
    this.state.writable = true;
  }

  /** Set a bad original aside (once per distinct content) and record it. */
  async quarantine(raw, reason) {
    const backupPath = await this.setAside(raw);
    this.state.corruption = { detected: true, backupPath };
    this.state.lastError = reason;
  }

  /** Copy the original next to itself, unless this exact content already was. */
  async setAside(raw) {
    const signature = contentSignature(raw);
    if (this.state.corruptSignature === signature) return this.state.corruption.backupPath;
    const stamp = new Date().toISOString().replaceAll(':', '');
    const target = `${this.configPath}.corrupt-${stamp}`;
    try {
      await copyFile(this.configPath, target);
      this.state.corruptSignature = signature;
      return target;
    } catch (error) {
      this.state.lastError = `could not set the unreadable configuration aside: ${describe(error)}`;
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

/**
 * Whether a request originates on the loopback interface.
 *
 * Both halves are required: a loopback peer with a foreign `Host` is exactly
 * the DNS-rebinding shape, and a loopback `Host` with a remote peer is a
 * proxied request the plugin must not answer.
 */
export function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress;
  if (address === undefined || !LOOPBACK_ADDRESSES.includes(address)) return false;
  const host = req.headers.host;
  if (host === undefined) return false;
  return LOOPBACK_HOSTNAMES.includes(hostnameOf(host));
}

/** Hostname of a `Host` header value: `host`, `host:port`, `[::1]` or `[::1]:port`. */
function hostnameOf(host) {
  const authority = host.trim().toLowerCase();
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return end === -1 ? '' : authority.slice(1, end);
  }
  const first = authority.indexOf(':');
  if (first === -1) return authority;
  // Exactly one colon is host:port; several mean a bracket-less IPv6 literal.
  return first === authority.lastIndexOf(':') ? authority.slice(0, first) : authority;
}

function respondJson(res, status, body, headers = {}) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

function fail(res, status, error, details) {
  const body = { error, ...(details === undefined || details.length === 0 ? {} : { details }) };
  respondJson(res, status, body);
}

/** Read the request body, refusing anything over `cap` (null = over the cap). */
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', chunk => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > cap) {
        // Answer immediately: draining a hostile stream would keep the socket open.
        settle(null);
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => settle(Buffer.concat(chunks).toString('utf8')));
    req.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/** The response both GET and PUT /config answer with. */
async function configResponse(store) {
  return { config: await store.readConfig(), health: store.health() };
}

/**
 * Create the handler for the `/settings-arranger/api` prefix route.
 * Exported so tests drive the exact surface production mounts.
 */
export function createApiHandler(store) {
  return async function handle(req, res) {
    if (!isLoopbackRequest(req)) {
      fail(res, 403, 'refused: this endpoint answers loopback requests only');
      return;
    }
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      fail(res, 400, 'malformed request URL');
      return;
    }
    let pathname = url.pathname;
    // The dsh webServer hands `kind:'prefix'` handlers the FULL request URL
    // (mount prefix included, e.g. `/settings-arranger/api/config`), while
    // the endpoint table — and the unit tests — use the inner path
    // (`/config`). Accept both by stripping the prefix when present.
    if (pathname.startsWith(API_PREFIX)) {
      pathname = pathname.slice(API_PREFIX.length);
      if (!pathname.startsWith('/')) pathname = '/' + pathname;
    }
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    const endpoint = ENDPOINTS.find(candidate => candidate.path === pathname);
    if (endpoint === undefined) {
      fail(res, 404, `unknown endpoint ${url.pathname}`);
      return;
    }
    const method = (req.method ?? 'GET').toUpperCase();
    if (!endpoint.methods.includes(method)) {
      fail(res, 405, `${method} is not allowed on ${pathname}`);
      return;
    }

    if (pathname === '/config') {
      if (method === 'GET') {
        respondJson(res, 200, await configResponse(store));
        return;
      }
      // PUT: body is `{ "layout": {...} }` — the raw localStorage payload.
      const body = await readBody(req, MAX_BODY_BYTES);
      if (body === null) {
        fail(res, 413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        fail(res, 400, 'request body is not valid JSON');
        return;
      }
      if (!isRecord(parsed) || !isRecord(parsed.layout)) {
        fail(res, 400, 'request body must be {"layout": {...}}');
        return;
      }
      try {
        await store.writeLayout(parsed.layout);
      } catch (error) {
        if (error instanceof InvalidLayoutError) {
          fail(res, 400, 'the layout was rejected by normalization', error.details);
          return;
        }
        fail(res, 500, describe(error));
        return;
      }
      respondJson(res, 200, await configResponse(store));
      return;
    }

    // POST /reset: back to "no layout on disk". The client clears its own
    // localStorage mirror; the file is the only thing this endpoint owns.
    await store.reset();
    respondJson(res, 200, { config: null, health: store.health() });
  };
}

/** Prefix route registration this plugin makes through `ctx.webServer`. */
export const ROUTE_REGISTRATION = { kind: 'prefix', path: API_PREFIX };

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Wire the store and the route.
 *
 * `webServer` is optional at apply time, so the registration runs inside
 * `ctx.inject(['webServer'], …)` wrapped in `ctx.effect` — the service may be
 * provided later, replaced, or withdrawn on a reload, and the route follows it
 * either way (same shape as dsh-railist).
 * @param {import('@deepseek-ai/cordis').Context} ctx - cordis context of this plugin.
 * @param {{home?: string}} [config] - optional home override (tests).
 */
export function apply(ctx, config) {
  const store = new SettingsStore({ home: config?.home });
  const handler = createApiHandler(store);

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.reflect.get('webServer');
    webCtx.effect(
      () => webServer.register({ ...ROUTE_REGISTRATION, handler }),
      'dsh-settings-arranger: loopback api route',
    );
  });
}
