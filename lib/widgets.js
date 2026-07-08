/* Integration widgets — the server fetches from your services (so the browser
   never talks to them directly and API tokens stay off the wire), normalizes
   the result, and caches it briefly.

   Adding a new widget type = add one async function + register it in TYPES.  */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const CACHE_TTL = 60 * 1000;
const cache = new Map(); // widget id -> {at, payload}

/* Generic JSON GET that tolerates self-signed certs. */
function getJson(urlStr, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('invalid url: ' + urlStr)); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: { 'User-Agent': 'labdash-widget', Accept: 'application/json', ...headers },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(body)); } catch { reject(new Error('non-JSON response')); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', (e) => reject(new Error(e.code || e.message)));
  });
}

const trim = (s) => String(s || '').trim().replace(/\/+$/, '');

/* ---------------- Proxmox VE ----------------
   Needs an API token: Datacenter -> Permissions -> API Tokens.
   Read-only role (PVEAuditor) on / is enough.                     */
async function proxmox(o) {
  const base = trim(o.url);
  const headers = { Authorization: `PVEAPIToken=${o.tokenId}=${o.tokenSecret}` };

  const nodes = await getJson(`${base}/api2/json/nodes`, headers);
  const list = nodes.data || [];
  if (!list.length) throw new Error('no nodes visible to this token');
  const node = list.find((n) => n.node === o.node) || list[0];

  let vms = { run: 0, total: 0 }, cts = { run: 0, total: 0 };
  try {
    const res = await getJson(`${base}/api2/json/cluster/resources?type=vm`, headers);
    for (const r of res.data || []) {
      const bucket = r.type === 'lxc' ? cts : vms;
      bucket.total += 1;
      if (r.status === 'running') bucket.run += 1;
    }
  } catch { /* resource listing is optional */ }

  return {
    node: node.node,
    online: node.status !== 'offline',
    cpu: (node.cpu || 0) * 100,
    mem: node.mem || 0,
    maxmem: node.maxmem || 0,
    uptime: node.uptime || 0,
    vms, cts,
  };
}

/* ---------------- Uptime Kuma ----------------
   Uses a public status page: create one in Kuma, add your monitors,
   and give the widget its slug.                                      */
async function uptimekuma(o) {
  const base = trim(o.url);
  const slug = String(o.slug || '').trim();
  if (!slug) throw new Error('missing status page slug');

  const [page, hb] = await Promise.all([
    getJson(`${base}/api/status-page/${slug}`),
    getJson(`${base}/api/status-page/heartbeat/${slug}`),
  ]);

  const names = {};
  for (const g of page.publicGroupList || []) {
    for (const m of g.monitorList || []) names[m.id] = m.name;
  }

  let up = 0;
  const downNames = [];
  for (const [id, beats] of Object.entries(hb.heartbeatList || {})) {
    const last = Array.isArray(beats) ? beats[beats.length - 1] : null;
    if (last && last.status === 1) up += 1;
    else downNames.push(names[id] || `monitor ${id}`);
  }
  return { up, down: downNames.length, total: up + downNames.length, downNames };
}

/* ---------------- Speedtest Tracker ----------------
   https://github.com/alexjustesen/speedtest-tracker
   Token = API token from the app's settings (optional on old versions). */
async function speedtest(o) {
  const base = trim(o.url);
  const headers = o.token ? { Authorization: `Bearer ${o.token}` } : {};

  let raw;
  try {
    raw = await getJson(`${base}/api/v1/results/latest`, headers);
  } catch {
    raw = await getJson(`${base}/api/speedtest/latest`, headers); // legacy endpoint
  }
  const d = raw.data || raw;

  // Newer versions store bytes/sec, older ones Mbps — normalize to Mbps.
  const mbps = (v) => { v = Number(v) || 0; return v > 10000 ? (v * 8) / 1e6 : v; };

  return {
    down: mbps(d.download),
    up: mbps(d.upload),
    ping: Number(d.ping) || 0,
    at: d.created_at || d.updated_at || null,
  };
}

const TYPES = { proxmox, uptimekuma, speedtest };

async function fetchAll(widgets) {
  const out = {};
  await Promise.all(
    (widgets || []).map(async (w) => {
      if (!w || !w.id || !TYPES[w.type]) return;
      const hit = cache.get(w.id);
      if (hit && Date.now() - hit.at < CACHE_TTL && hit.key === JSON.stringify(w.options)) {
        out[w.id] = hit.payload;
        return;
      }
      let payload;
      try {
        payload = { ok: true, type: w.type, data: await TYPES[w.type](w.options || {}) };
      } catch (e) {
        payload = { ok: false, type: w.type, error: e.message };
      }
      cache.set(w.id, { at: Date.now(), key: JSON.stringify(w.options), payload });
      out[w.id] = payload;
    })
  );
  return out;
}

module.exports = { fetchAll, TYPES };
