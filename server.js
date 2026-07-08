#!/usr/bin/env node
/*
 * LabDash — a lightweight, self-hosted homelab dashboard.
 * Zero runtime dependencies: plain Node.js (>= 18).
 *
 * Everything the user can customize lives in data/config.json and is
 * edited from the web UI — no code changes needed.
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { URL } = require('url');

const { Auth } = require('./lib/auth');
const widgets = require('./lib/widgets');

const PORT = parseInt(process.env.PORT || '7380', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'config.default.json');

/* ------------------------------------------------------------------ */
/* Config storage                                                      */
/* ------------------------------------------------------------------ */

function ensureConfig() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.copyFileSync(DEFAULT_CONFIG_PATH, CONFIG_PATH);
    console.log(`[labdash] created ${CONFIG_PATH} from defaults`);
  }
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error('[labdash] config unreadable, serving defaults:', err.message);
    return JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
  }
}

function writeConfig(obj) {
  // Atomic write: tmp file + rename, plus a rolling backup of the previous version.
  const tmp = CONFIG_PATH + '.tmp';
  if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

function validateConfig(obj) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return 'config must be an object';
  if (!obj.settings || typeof obj.settings !== 'object') return 'missing "settings" object';
  if (!Array.isArray(obj.groups)) return 'missing "groups" array';
  if (obj.widgets !== undefined) {
    if (!Array.isArray(obj.widgets)) return '"widgets" must be an array';
    for (const w of obj.widgets) {
      if (!w || typeof w.type !== 'string' || typeof w.id !== 'string') return 'every widget needs an id and a type';
    }
  }
  for (const g of obj.groups) {
    if (typeof g.name !== 'string') return 'every group needs a name';
    if (!Array.isArray(g.services)) return 'every group needs a services array';
    for (const s of g.services) {
      if (typeof s.name !== 'string') return 'every service needs a name';
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* HTTP(S) probe used for service status checks                       */
/* Accepts self-signed certificates (very common in homelabs).        */
/* Any HTTP response — including 401/403 — counts as "up".            */
/* ------------------------------------------------------------------ */

function probe(target, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(target);
    } catch {
      return resolve({ up: false, ms: 0, error: 'invalid url' });
    }
    const mod = u.protocol === 'https:' ? https : http;
    const started = Date.now();
    const req = mod.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: { 'User-Agent': 'labdash-healthcheck' },
      },
      (res) => {
        res.destroy();
        resolve({ up: true, code: res.statusCode, ms: Date.now() - started });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ up: false, ms: timeoutMs, error: 'timeout' }); });
    req.on('error', (err) => resolve({ up: false, ms: Date.now() - started, error: err.code || err.message }));
    req.end();
  });
}

let statusCache = { at: 0, results: {} };
const STATUS_TTL = 15 * 1000;

async function getStatuses() {
  const now = Date.now();
  if (now - statusCache.at < STATUS_TTL) return statusCache.results;
  const cfg = readConfig();
  const checks = [];
  for (const group of cfg.groups || []) {
    for (const svc of group.services || []) {
      if (!svc.health || svc.health.enabled === false) continue;
      const target = (svc.health.url || svc.url || '').trim();
      if (!target) continue;
      checks.push(
        probe(target).then((r) => [svc.id || svc.name, r])
      );
    }
  }
  const settled = await Promise.all(checks);
  const results = Object.fromEntries(settled);
  statusCache = { at: Date.now(), results };
  return results;
}

/* ------------------------------------------------------------------ */
/* System stats                                                        */
/* ------------------------------------------------------------------ */

let lastCpu = null;

function readCpuTimes() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

function cpuPercent() {
  const cur = readCpuTimes();
  if (!cur) return null;
  let pct = null;
  if (lastCpu && cur.total > lastCpu.total) {
    const dTotal = cur.total - lastCpu.total;
    const dIdle = cur.idle - lastCpu.idle;
    pct = Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
  }
  lastCpu = cur;
  return pct;
}

function diskUsage() {
  return new Promise((resolve) => {
    execFile('df', ['-kP', '/'], (err, stdout) => {
      if (err) return resolve(null);
      const line = stdout.trim().split('\n').pop().trim().split(/\s+/);
      const total = parseInt(line[1], 10) * 1024;
      const used = parseInt(line[2], 10) * 1024;
      resolve({ total, used, pct: (used / total) * 100 });
    });
  });
}

async function getStats() {
  const disk = await diskUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    hostname: os.hostname(),
    uptime: os.uptime(),
    load: os.loadavg(),
    cpu: { pct: cpuPercent(), cores: os.cpus().length },
    mem: { total: totalMem, used: totalMem - freeMem, pct: ((totalMem - freeMem) / totalMem) * 100 },
    disk,
  };
}

// Prime the CPU sampler so the first real request has a delta to work with.
setInterval(() => cpuPercent(), 5000).unref();
cpuPercent();

/* ------------------------------------------------------------------ */
/* Weather (Open-Meteo — free, no API key)                             */
/* ------------------------------------------------------------------ */

let weatherCache = { at: 0, key: '', data: null };
const WEATHER_TTL = 10 * 60 * 1000;

function fetchJson(urlStr, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.get(
      { hostname: u.hostname, path: u.pathname + u.search, timeout: timeoutMs, headers: { 'User-Agent': 'labdash' } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function getWeather() {
  const cfg = readConfig();
  const w = (cfg.settings && cfg.settings.weather) || {};
  if (!w.lat || !w.lon) return { enabled: false };
  const key = `${w.lat},${w.lon}`;
  const now = Date.now();
  if (weatherCache.data && weatherCache.key === key && now - weatherCache.at < WEATHER_TTL) {
    return weatherCache.data;
  }
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${encodeURIComponent(w.lat)}&longitude=${encodeURIComponent(w.lon)}` +
    '&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m' +
    '&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto';
  const raw = await fetchJson(url);
  const data = {
    enabled: true,
    place: w.name || '',
    temp: raw.current && raw.current.temperature_2m,
    code: raw.current && raw.current.weather_code,
    wind: raw.current && raw.current.wind_speed_10m,
    humidity: raw.current && raw.current.relative_humidity_2m,
    hi: raw.daily && raw.daily.temperature_2m_max && raw.daily.temperature_2m_max[0],
    lo: raw.daily && raw.daily.temperature_2m_min && raw.daily.temperature_2m_min[0],
    unit: (raw.current_units && raw.current_units.temperature_2m) || '°C',
  };
  weatherCache = { at: now, key, data };
  return data;
}

async function geocode(q) {
  const url =
    'https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&format=json&name=' +
    encodeURIComponent(q);
  const raw = await fetchJson(url);
  return (raw.results || []).map((r) => ({
    name: [r.name, r.admin1, r.country_code].filter(Boolean).join(', '),
    lat: r.latitude,
    lon: r.longitude,
  }));
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(res, reqPath) {
  const clean = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(PUBLIC_DIR, clean);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  if (reqPath === '/' || !path.extname(file)) file = path.join(PUBLIC_DIR, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/* Raw (binary-safe) body reader for image uploads. */
function readBodyRaw(req, limit = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('file too large (max 15 MB)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* Identify an image by magic bytes — we never trust the client's mime type. */
function sniffImage(buf) {
  if (buf.length < 16) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 4).toString() === 'GIF8') return 'image/gif';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(4, 12).toString() === 'ftypavif') return 'image/avif';
  return null;
}

const BG_PATH = () => path.join(DATA_DIR, 'background.img');

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

let auth = null; // constructed after ensureConfig() creates DATA_DIR

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${u.pathname}`;
  const sessionId = auth.check(req);
  const authed = !!sessionId;

  try {
    /* ---------------- auth endpoints (no session required) ---------------- */

    if (route === 'GET /api/auth/status') {
      return sendJson(res, 200, { setup: auth.isSetup(), authed });
    }

    if (route === 'POST /api/auth/setup') {
      if (auth.isSetup()) return sendJson(res, 403, { error: 'already set up' });
      let body; try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
      const pw = String(body.password || '');
      if (pw.length < 4) return sendJson(res, 400, { error: 'password must be at least 4 characters' });
      auth.setPassword(pw);
      const token = auth.createSession();
      res.setHeader('Set-Cookie', auth.cookieFor(token));
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'POST /api/auth/login') {
      const ip = clientIp(req);
      if (auth.locked(ip)) return sendJson(res, 429, { error: 'too many attempts — wait a minute and try again' });
      let body; try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
      if (!auth.verifyPassword(String(body.password || ''))) {
        auth.recordFail(ip);
        return sendJson(res, 401, { error: 'wrong password' });
      }
      auth.clearFails(ip);
      const token = auth.createSession();
      res.setHeader('Set-Cookie', auth.cookieFor(token));
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'POST /api/auth/logout') {
      auth.destroySession(req);
      res.setHeader('Set-Cookie', auth.clearCookie());
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'POST /api/auth/change') {
      if (!authed) return sendJson(res, 401, { error: 'unauthorized' });
      let body; try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
      if (!auth.verifyPassword(String(body.current || ''))) return sendJson(res, 403, { error: 'current password is wrong' });
      const pw = String(body.password || '');
      if (pw.length < 4) return sendJson(res, 400, { error: 'new password must be at least 4 characters' });
      auth.setPassword(pw);
      auth.dropOtherSessions(sessionId); // everyone else has to log in again
      return sendJson(res, 200, { ok: true });
    }

    /* ---------------- everything under /api requires a session ------------ */

    if (u.pathname.startsWith('/api/') && !authed) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }

    if (route === 'GET /api/config') {
      return sendJson(res, 200, readConfig());
    }

    if (route === 'PUT /api/config' || route === 'POST /api/config') {
      const body = await readBody(req);
      let obj;
      try { obj = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
      const problem = validateConfig(obj);
      if (problem) return sendJson(res, 400, { error: problem });
      writeConfig(obj);
      statusCache = { at: 0, results: {} }; // re-check after edits
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'GET /api/status') {
      return sendJson(res, 200, await getStatuses());
    }

    if (route === 'GET /api/stats') {
      return sendJson(res, 200, await getStats());
    }

    if (route === 'GET /api/weather') {
      try { return sendJson(res, 200, await getWeather()); }
      catch (e) { return sendJson(res, 200, { enabled: true, error: e.message }); }
    }

    if (route === 'POST /api/background') {
      let buf;
      try { buf = await readBodyRaw(req); } catch (e) { return sendJson(res, 413, { error: e.message }); }
      const mime = sniffImage(buf);
      if (!mime) return sendJson(res, 400, { error: 'not a supported image — use PNG, JPEG, WebP, GIF or AVIF' });
      fs.writeFileSync(BG_PATH(), buf);
      return sendJson(res, 200, { ok: true, url: '/api/background?v=' + Date.now() });
    }

    if (route === 'GET /api/background') {
      let buf;
      try { buf = fs.readFileSync(BG_PATH()); } catch { res.writeHead(404); return res.end('no background uploaded'); }
      const mime = sniffImage(buf) || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end(buf);
    }

    if (route === 'DELETE /api/background') {
      try { fs.unlinkSync(BG_PATH()); } catch { /* nothing to remove */ }
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'GET /api/widgets') {
      const cfg = readConfig();
      return sendJson(res, 200, await widgets.fetchAll(cfg.widgets));
    }

    if (route === 'GET /api/geocode') {
      const q = (u.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 400, { error: 'missing q' });
      try { return sendJson(res, 200, await geocode(q)); }
      catch (e) { return sendJson(res, 502, { error: e.message }); }
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      // The login page and static assets are public; the app itself is not.
      if (u.pathname === '/login') {
        if (authed) { res.writeHead(302, { Location: '/' }); return res.end(); }
        return serveStatic(res, '/login.html');
      }
      const isPage = u.pathname === '/' || !path.extname(u.pathname) || u.pathname === '/index.html';
      if (isPage && !authed) {
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
      return serveStatic(res, u.pathname);
    }

    res.writeHead(405);
    res.end('method not allowed');
  } catch (err) {
    console.error('[labdash] request error:', err);
    sendJson(res, 500, { error: 'internal error' });
  }
});

ensureConfig();
auth = new Auth(DATA_DIR);
server.listen(PORT, HOST, () => {
  console.log(`[labdash] serving on http://${HOST}:${PORT}`);
  console.log(`[labdash] config: ${CONFIG_PATH}`);
});
