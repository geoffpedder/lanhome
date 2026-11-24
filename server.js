// LAN Home: a Mafl-style home page with a built-in editor.
// Reads and writes the same config.yml format Mafl uses, so the two stay interchangeable.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3001);
const CONFIG = process.env.CONFIG || '/opt/mafl/data/config.yml';
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(CONFIG), 'backups');
const ICON_CACHE = process.env.ICON_CACHE || path.join(ROOT, 'icon-cache');
const PASSWORD = process.env.EDIT_PASSWORD || '';
const KEEP_BACKUPS = Number(process.env.KEEP_BACKUPS || 30);
const MAX_BODY = 2 * 1024 * 1024;

fs.mkdirSync(ICON_CACHE, { recursive: true });

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

// ---------- helpers ----------
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function passwordOk(req) {
  if (!PASSWORD) return true;
  const given = Buffer.from(String(req.headers['x-edit-password'] || ''));
  const want = Buffer.from(PASSWORD);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function fileVersion() {
  try {
    const st = fs.statSync(CONFIG);
    return `${st.mtimeMs}-${st.size}`;
  } catch {
    return 'missing';
  }
}

function readConfigText() {
  try {
    return fs.readFileSync(CONFIG, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return 'title: Home\nservices: {}\n';
    throw e;
  }
}

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return 'Config must be a mapping.';
  const s = cfg.services;
  if (s == null) return null;
  if (typeof s !== 'object') return '"services" must be a mapping of group name to a list of services.';
  const groups = Array.isArray(s) ? [['(list)', s]] : Object.entries(s);
  for (const [name, items] of groups) {
    if (items == null) continue;
    if (!Array.isArray(items)) return `Group "${name}" must be a list of services.`;
    for (const [i, it] of items.entries()) {
      if (!it || typeof it !== 'object') return `Group "${name}", item ${i + 1} must be a mapping.`;
    }
  }
  return null;
}

function backupCurrent() {
  if (!fs.existsSync(CONFIG)) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(CONFIG, path.join(BACKUP_DIR, `config-${stamp}.yml`));
  const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^config-.*\.yml$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(BACKUP_DIR, f));
}

function writeConfigText(text) {
  backupCurrent();
  // Write in place (not rename) so tools watching the file, such as Mafl, see the change.
  fs.writeFileSync(CONFIG, text, 'utf8');
}

function toYaml(cfg) {
  return YAML.stringify(cfg, { indent: 2, lineWidth: 0, minContentWidth: 0 });
}

// ---------- icons (Iconify, cached on disk) ----------
// Icons are fetched through Iconify's JSON API, one request per icon set for any number of icons.
// Fetching each icon's .svg separately gets the whole network rate-limited by Iconify's CDN.
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NOT_FOUND_TTL = 60 * 60 * 1000;
const notFound = new Map(); // "prefix:name" -> time it was reported missing
const inflight = new Map(); // upstream request key -> promise of icon set JSON

class UpstreamError extends Error {}

function sanitizeSvg(svg) {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/((?:xlink:)?href\s*=\s*["'])\s*javascript:[^"']*/gi, '$1#');
}

const cacheFile = (prefix, name) => path.join(ICON_CACHE, `${prefix}--${name}.svg`);

function buildSvg(set, name) {
  // Resolve aliases (an alias points at a parent icon and may add flips/rotation)
  let icon = set.icons?.[name];
  const extra = { hFlip: false, vFlip: false, rotate: 0 };
  let cur = name;
  for (let depth = 0; !icon && depth < 6; depth++) {
    const alias = set.aliases?.[cur];
    if (!alias) break;
    if (alias.hFlip) extra.hFlip = !extra.hFlip;
    if (alias.vFlip) extra.vFlip = !extra.vFlip;
    extra.rotate += alias.rotate || 0;
    for (const k of ['width', 'height', 'left', 'top']) if (alias[k] != null && extra[k] == null) extra[k] = alias[k];
    cur = alias.parent;
    icon = set.icons?.[cur];
  }
  if (!icon || typeof icon.body !== 'string') return null;
  const left = extra.left ?? icon.left ?? set.left ?? 0;
  const top = extra.top ?? icon.top ?? set.top ?? 0;
  const width = extra.width ?? icon.width ?? set.width ?? 16;
  const height = extra.height ?? icon.height ?? set.height ?? 16;
  const hFlip = !!icon.hFlip !== extra.hFlip;
  const vFlip = !!icon.vFlip !== extra.vFlip;
  const rotate = (((icon.rotate || 0) + extra.rotate) % 4 + 4) % 4;
  const cx = left + width / 2, cy = top + height / 2;
  const transforms = [];
  if (hFlip || vFlip) transforms.push(`translate(${cx} ${cy}) scale(${hFlip ? -1 : 1} ${vFlip ? -1 : 1}) translate(${-cx} ${-cy})`);
  if (rotate) transforms.push(`rotate(${rotate * 90} ${cx} ${cy})`);
  const body = transforms.length ? `<g transform="${transforms.join(' ')}">${icon.body}</g>` : icon.body;
  return sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1em" height="1em" viewBox="${left} ${top} ${width} ${height}">${body}</svg>`);
}

async function fetchIconSet(prefix, names) {
  const r = await fetch(`https://api.iconify.design/${prefix}.json?icons=${names.map(encodeURIComponent).join(',')}`, { signal: AbortSignal.timeout(10000) });
  if (r.status === 404) return { icons: {} }; // unknown icon set
  if (!r.ok) throw new UpstreamError(r.status === 429 ? 'The icon library is rate-limiting requests from your network. Try again in a few minutes.' : `The icon library answered ${r.status}.`);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError('The icon library sent an unexpected answer.');
  }
}

// Returns { svgs: { "prefix:name": svg|null }, error?: string }
async function getIcons(fullNames) {
  const svgs = {};
  const missing = new Map(); // prefix -> [names]
  for (const full of fullNames) {
    const [prefix, name] = full.split(':');
    if (!NAME_RE.test(prefix || '') || !NAME_RE.test(name || '')) { svgs[full] = null; continue; }
    const file = cacheFile(prefix, name);
    if (fs.existsSync(file)) { svgs[full] = fs.readFileSync(file, 'utf8'); continue; }
    const nf = notFound.get(full);
    if (nf && Date.now() - nf < NOT_FOUND_TTL) { svgs[full] = null; continue; }
    if (!missing.has(prefix)) missing.set(prefix, []);
    missing.get(prefix).push(name);
  }
  let error;
  await Promise.all([...missing].map(async ([prefix, names]) => {
    for (let i = 0; i < names.length; i += 60) {
      const chunk = names.slice(i, i + 60);
      try {
        const set = await sharedFetch(prefix, chunk);
        for (const n of chunk) {
          const svg = buildSvg(set, n);
          if (svg) fs.writeFileSync(cacheFile(prefix, n), svg, 'utf8');
          else notFound.set(`${prefix}:${n}`, Date.now());
          svgs[`${prefix}:${n}`] = svg;
        }
      } catch (e) {
        for (const n of chunk) svgs[`${prefix}:${n}`] = null;
        error = e instanceof UpstreamError ? e.message : 'Could not reach the icon library (no internet?).';
      }
    }
  }));
  return { svgs, error };
}

// Identical requests made at the same time share one upstream fetch.
function sharedFetch(prefix, names) {
  const key = `${prefix}?${names.join(',')}`;
  if (!inflight.has(key)) {
    const p = fetchIconSet(prefix, names);
    inflight.set(key, p);
    p.then(() => inflight.delete(key), () => inflight.delete(key));
  }
  return inflight.get(key);
}

// ---------- status checks ----------
// Only links that are in the config are checked, so this can't be used to probe arbitrary hosts.
const STATUS_TTL = 30 * 1000;
const STATUS_TIMEOUT = Number(process.env.STATUS_TIMEOUT || 5000);
const statusCache = new Map(); // target -> { at, result }
const statusInflight = new Map();

function statusTargets(cfg) {
  const s = cfg?.services;
  const groups = !s ? [] : Array.isArray(s) ? [s] : Object.values(s);
  const out = new Set();
  for (const items of groups) {
    for (const it of Array.isArray(items) ? items : []) {
      if (!it || it.status === false) continue;
      const t = typeof it.status === 'string' && it.status.trim() ? it.status.trim() : it.link;
      if (typeof t === 'string' && /^https?:\/\//i.test(t.trim())) out.add(t.trim());
    }
  }
  return [...out];
}

function probe(target) {
  return new Promise((resolve) => {
    const start = Date.now();
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve({ ...r, ms: Date.now() - start }); } };
    let u;
    try { u = new URL(target); } catch { return finish({ up: false, error: 'bad URL' }); }
    const mod = u.protocol === 'https:' ? https : http;
    // Self-signed certificates are common on a LAN; this only checks that something answers.
    const req = mod.request(u, { method: 'GET', rejectUnauthorized: false, timeout: STATUS_TIMEOUT, headers: { 'User-Agent': 'lanhome-status' } }, (res) => {
      const code = res.statusCode;
      // 502/503/504 usually mean a reverse proxy is up but the service behind it isn't.
      finish({ up: ![502, 503, 504].includes(code), code });
      res.destroy();
    });
    req.on('timeout', () => { finish({ up: false, error: 'timed out' }); req.destroy(); });
    const reasons = { ECONNREFUSED: 'connection refused', ENOTFOUND: 'name not found', EHOSTUNREACH: 'host unreachable', ENETUNREACH: 'network unreachable', ECONNRESET: 'connection reset', ETIMEDOUT: 'timed out' };
    req.on('error', (e) => finish({ up: false, error: reasons[e.code] || e.code || e.message }));
    req.end();
  });
}

function checkStatus(target) {
  const c = statusCache.get(target);
  if (c && Date.now() - c.at < STATUS_TTL) return Promise.resolve(c.result);
  if (statusInflight.has(target)) return statusInflight.get(target);
  const pr = probe(target).then((result) => {
    statusCache.set(target, { at: Date.now(), result });
    statusInflight.delete(target);
    return result;
  });
  statusInflight.set(target, pr);
  return pr;
}

async function allStatus() {
  let cfg;
  try { cfg = YAML.parse(readConfigText()) || {}; } catch { return {}; }
  const targets = statusTargets(cfg);
  const results = {};
  const queue = [...targets];
  const worker = async () => { while (queue.length) { const t = queue.shift(); results[t] = await checkStatus(t); } };
  await Promise.all(Array.from({ length: Math.min(12, queue.length) }, worker));
  for (const k of statusCache.keys()) if (!targets.includes(k)) statusCache.delete(k);
  return results;
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'GET' && STATIC[p]) {
    const [file, type] = STATIC[p];
    return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', file)), type);
  }

  if (p === '/api/config' && req.method === 'GET') {
    const text = readConfigText();
    let config;
    try {
      config = YAML.parse(text) || {};
    } catch (e) {
      return send(res, 200, { error: `config.yml has a YAML error: ${e.message}`, raw: text, version: fileVersion(), passwordRequired: !!PASSWORD });
    }
    return send(res, 200, { config, version: fileVersion(), passwordRequired: !!PASSWORD });
  }

  if (p === '/api/auth' && req.method === 'POST') {
    return passwordOk(req) ? send(res, 200, { ok: true }) : send(res, 401, { error: 'Wrong password' });
  }

  if ((p === '/api/config' || p === '/api/raw') && req.method === 'PUT') {
    if (!passwordOk(req)) return send(res, 401, { error: 'Wrong or missing password' });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'Bad request body' });
    }
    if (body.version && body.version !== fileVersion()) {
      return send(res, 409, { error: 'config.yml was changed by someone else since you loaded it. Reload to see the latest version, then make your edit again.' });
    }
    let text;
    if (p === '/api/raw') {
      text = String(body.raw ?? '');
      let parsed;
      try {
        parsed = YAML.parse(text);
      } catch (e) {
        return send(res, 400, { error: `YAML error: ${e.message}` });
      }
      const err = validateConfig(parsed);
      if (err) return send(res, 400, { error: err });
    } else {
      const err = validateConfig(body.config);
      if (err) return send(res, 400, { error: err });
      text = toYaml(body.config);
    }
    writeConfigText(text);
    return send(res, 200, { ok: true, version: fileVersion() });
  }

  if (p === '/api/raw' && req.method === 'GET') {
    return send(res, 200, { raw: readConfigText(), version: fileVersion() });
  }

  if (p === '/api/status' && req.method === 'GET') {
    return send(res, 200, { results: await allStatus(), checkedAt: Date.now() }, undefined, { 'Cache-Control': 'no-store' });
  }

  if (p === '/api/icon-search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
    if (!q) return send(res, 200, { icons: [] });
    try {
      const r = await fetch(`https://api.iconify.design/search?query=${encodeURIComponent(q)}&limit=64`, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      return send(res, 200, { icons: Array.isArray(j.icons) ? j.icons : [] });
    } catch {
      return send(res, 502, { error: 'Icon search is unavailable (no internet?)', icons: [] });
    }
  }

  if (p === '/api/icons' && req.method === 'GET') {
    const names = [...new Set((url.searchParams.get('names') || '').split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 200);
    const { svgs, error } = await getIcons(names);
    return send(res, 200, { svgs, error });
  }

  const m = p.match(/^\/icon\/([^/]+)\/([^/]+)\.svg$/);
  if (m && req.method === 'GET') {
    const [, prefix, name] = m;
    if (!NAME_RE.test(prefix) || !NAME_RE.test(name)) return send(res, 400, 'bad icon name', 'text/plain');
    const full = `${prefix}:${name}`;
    const { svgs, error } = await getIcons([full]);
    if (svgs[full]) return send(res, 200, svgs[full], 'image/svg+xml', { 'Cache-Control': 'public, max-age=604800' });
    return error ? send(res, 502, error, 'text/plain') : send(res, 404, 'icon not found', 'text/plain');
  }

  return send(res, 404, { error: 'Not found' });
}

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: e.message || 'Server error' });
    });
  })
  .listen(PORT, () => {
    console.log(`LAN Home listening on :${PORT}, config ${CONFIG}${PASSWORD ? ', editing password-protected' : ''}`);
  });
