// LAN Home: a Mafl-style home page with a built-in editor.
// Reads and writes the same config.yml format Mafl uses, so the two stay interchangeable.
import http from 'node:http';
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
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const inflight = new Map();

function sanitizeSvg(svg) {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/(href\s*=\s*["'])\s*javascript:[^"']*/gi, '$1#');
}

async function getIcon(prefix, name) {
  const file = path.join(ICON_CACHE, `${prefix}--${name}.svg`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const key = `${prefix}:${name}`;
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      const r = await fetch(`https://api.iconify.design/${prefix}/${name}.svg`, { signal: AbortSignal.timeout(8000) });
      const text = await r.text();
      if (!r.ok || !text.trim().startsWith('<svg')) return null; // Iconify answers 404 for unknown icons
      const clean = sanitizeSvg(text);
      fs.writeFileSync(file, clean, 'utf8');
      return clean;
    })().finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
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

  const m = p.match(/^\/icon\/([^/]+)\/([^/]+)\.svg$/);
  if (m && req.method === 'GET') {
    const [, prefix, name] = m;
    if (!NAME_RE.test(prefix) || !NAME_RE.test(name)) return send(res, 400, 'bad icon name', 'text/plain');
    try {
      const svg = await getIcon(prefix, name);
      if (!svg) return send(res, 404, 'icon not found', 'text/plain');
      return send(res, 200, svg, 'image/svg+xml', { 'Cache-Control': 'public, max-age=604800' });
    } catch {
      return send(res, 502, 'icon fetch failed', 'text/plain');
    }
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
