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

/* Generic HTTP(S) request that tolerates self-signed certs.
   Resolves {status, headers, body} — 4xx/5xx do NOT reject, callers decide. */
function request(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('invalid url: ' + urlStr)); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: { 'User-Agent': 'labdash-widget', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', (e) => reject(new Error(e.code || e.message)));
    if (body) req.write(body);
    req.end();
  });
}

async function getJson(urlStr, headers = {}, timeoutMs = 8000) {
  const r = await request(urlStr, { headers: { Accept: 'application/json', ...headers }, timeoutMs });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  try { return JSON.parse(r.body); } catch { throw new Error('non-JSON response'); }
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

/* ---------------- Pi-hole ----------------
   Supports v5 (api.php + API token from Settings → API) and
   v6 (REST API + app password).                              */
async function pihole(o) {
  const base = trim(o.url);

  // v5 first: /admin/api.php?summaryRaw&auth=TOKEN
  try {
    const d = await getJson(`${base}/admin/api.php?summaryRaw&auth=${encodeURIComponent(o.token || '')}`);
    if (d && d.dns_queries_today !== undefined) {
      return {
        queries: d.dns_queries_today,
        blocked: d.ads_blocked_today,
        pct: Number(d.ads_percentage_today) || 0,
        domains: d.domains_being_blocked,
        status: d.status || 'unknown',
      };
    }
  } catch { /* fall through to v6 */ }

  // v6: POST /api/auth {password} -> sid, then /api/stats/summary
  const authRes = await request(`${base}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ password: o.token || '' }),
  });
  if (authRes.status >= 400) throw new Error(`Pi-hole auth failed (HTTP ${authRes.status}) — check the token/app password`);
  const sid = JSON.parse(authRes.body).session && JSON.parse(authRes.body).session.sid;
  if (!sid) throw new Error('Pi-hole v6 auth gave no session');
  const s = await getJson(`${base}/api/stats/summary`, { 'X-FTL-SID': sid });
  return {
    queries: s.queries && s.queries.total,
    blocked: s.queries && s.queries.blocked,
    pct: (s.queries && s.queries.percent_blocked) || 0,
    domains: s.gravity && s.gravity.domains_being_blocked,
    status: 'enabled',
  };
}

/* ---------------- qBittorrent ----------------
   Web UI credentials; logs in for a session cookie, then reads
   transfer speeds and active torrent count.                     */
const qbSessions = new Map(); // widget url -> cookie

async function qbittorrent(o) {
  const base = trim(o.url);

  async function login() {
    const r = await request(`${base}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: base },
      body: `username=${encodeURIComponent(o.username || '')}&password=${encodeURIComponent(o.password || '')}`,
    });
    const cookie = (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
    if (r.status !== 200 || !/SID=/.test(cookie)) throw new Error('qBittorrent login failed — check credentials and that the Web UI allows this host');
    qbSessions.set(base, cookie);
    return cookie;
  }

  let cookie = qbSessions.get(base) || (await login());
  let r = await request(`${base}/api/v2/transfer/info`, { headers: { Cookie: cookie, Accept: 'application/json' } });
  if (r.status === 403) { cookie = await login(); r = await request(`${base}/api/v2/transfer/info`, { headers: { Cookie: cookie, Accept: 'application/json' } }); }
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  const t = JSON.parse(r.body);

  let active = null;
  try {
    const tr = await request(`${base}/api/v2/torrents/info?filter=active`, { headers: { Cookie: cookie, Accept: 'application/json' } });
    if (tr.status === 200) active = JSON.parse(tr.body).length;
  } catch { /* optional */ }

  return { dl: t.dl_info_speed || 0, ul: t.up_info_speed || 0, active };
}

/* ---------------- RSS / Atom feed ---------------- */
function stripTags(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .trim();
}

async function rss(o) {
  const r = await request(trim(o.url), { headers: { Accept: 'application/rss+xml, application/atom+xml, text/xml, */*' } });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  const xml = r.body;
  const items = [];
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks.slice(0, Number(o.count) || 5)) {
    const title = stripTags((b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    let link = ((b.match(/<link[^>]*href="([^"]+)"/i) || [])[1]) || stripTags((b.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1]);
    const date = stripTags((b.match(/<(pubDate|updated|published)[^>]*>([\s\S]*?)<\/\1>/i) || [])[2]);
    if (title) items.push({ title, link: (link || '').trim(), date });
  }
  const feedTitle = stripTags(((xml.split(/<(item|entry)[\s>]/i)[0] || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  if (!items.length) throw new Error('no items found — is this an RSS/Atom feed?');
  return { feedTitle, items };
}

const TYPES = { proxmox, uptimekuma, speedtest, pihole, qbittorrent, rss };

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
