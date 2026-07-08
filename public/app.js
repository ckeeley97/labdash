/* LabDash frontend — everything is driven by the config the server hands us.
   No rebuilds, no code edits: change things in the UI, it saves to the server. */

'use strict';

let cfg = null;          // live config object
let editing = false;
let statuses = {};       // id -> {up, ms, code}
let drag = null;         // {gi, si} while dragging a tile

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ---------------- API ---------------- */

async function apiGet(path) {
  const r = await fetch(path);
  if (r.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `${path} -> ${r.status}`);
  return out;
}

let saveTimer = null;
function save(showToast = true) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      if (!r.ok) throw new Error('save failed');
      if (showToast) toast('Saved');
    } catch (e) {
      toast('⚠ Could not save — ' + e.message);
    }
  }, 250);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2200);
}

const uid = (p) => p + '-' + Math.random().toString(36).slice(2, 9);

/* ---------------- settings -> page ---------------- */

function applySettings() {
  const s = cfg.settings;
  document.title = s.title || 'LabDash';
  $('#dash-title').textContent = s.title || 'LabDash';
  $('#dash-subtitle').textContent = s.subtitle || '';
  document.documentElement.style.setProperty('--accent', s.accent || '#4f9cf9');

  let theme = s.theme || 'dark';
  if (theme === 'auto') {
    theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.body.dataset.theme = theme;

  $('#clock').hidden = !s.showClock;
  $('#searchwrap').hidden = !s.showSearch;
  $('#stats').hidden = !s.showStats;
  if (!s.showWeather) $('#weather').hidden = true;

  // custom background: an image URL or any CSS background value (e.g. a gradient)
  const bg = s.background || {};
  const v = (bg.value || '').trim();
  const layer = $('#bglayer');
  if (v) {
    layer.style.backgroundImage = /^(https?:)?\/\//.test(v) || v.startsWith('/') ? `url("${v}")` : v;
    document.documentElement.style.setProperty('--bg-blur', (bg.blur || 0) + 'px');
    document.documentElement.style.setProperty('--bg-dim', (bg.dim || 0) / 100);
    document.body.classList.add('has-bg');
  } else {
    layer.style.backgroundImage = '';
    document.body.classList.remove('has-bg');
  }

  // custom CSS, applied last so it can override anything
  let styleEl = document.getElementById('customcss');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'customcss';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = s.customCss || '';
}

/* ---------------- icons ---------------- */

function iconNode(svc) {
  const box = document.createElement('div');
  box.className = 'ic';
  const v = (svc.icon || '').trim();

  const monogram = () => {
    box.textContent = '';
    const m = document.createElement('span');
    m.className = 'monogram';
    m.textContent = (svc.name || '?').slice(0, 2).toUpperCase();
    box.appendChild(m);
  };

  if (!v) { monogram(); return box; }

  const isUrl = /^(https?:)?\/\//.test(v) || v.startsWith('/');
  const isSlug = /^[a-z0-9][a-z0-9-]*$/i.test(v) && v.length > 1;

  if (isUrl || isSlug) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = isUrl ? v : `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/${v.toLowerCase()}.png`;
    img.onerror = monogram;
    box.appendChild(img);
  } else {
    box.textContent = v; // emoji / short text
  }
  return box;
}

/* ---------------- groups & tiles ---------------- */

function render() {
  applySettings();
  renderWidgets();
  const wrap = $('#groups');
  wrap.textContent = '';

  cfg.groups.forEach((g, gi) => {
    const sec = document.createElement('section');
    sec.className = 'group';
    sec.dataset.gi = gi;

    const head = document.createElement('div');
    head.className = 'group-head';
    const h2 = document.createElement('h2');
    h2.textContent = g.name;
    head.appendChild(h2);

    const tools = document.createElement('div');
    tools.className = 'group-tools';
    tools.append(
      mini('✎', 'Rename group', () => openGroupModal(gi)),
      mini('↑', 'Move up', () => { moveGroup(gi, -1); }),
      mini('↓', 'Move down', () => { moveGroup(gi, 1); }),
      mini('🗑', 'Delete group', () => {
        if (g.services.length === 0 || window.confirm(`Delete group "${g.name}" and its ${g.services.length} tile(s)?`)) {
          cfg.groups.splice(gi, 1); render(); save();
        }
      }, true),
    );
    head.appendChild(tools);
    sec.appendChild(head);

    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    tiles.dataset.gi = gi;

    g.services.forEach((svc, si) => tiles.appendChild(tileNode(svc, gi, si)));

    const add = document.createElement('button');
    add.className = 'add-tile';
    add.textContent = '+ Add service';
    add.addEventListener('click', () => openServiceModal(gi, null));
    tiles.appendChild(add);

    wireDropZone(tiles);
    sec.appendChild(tiles);
    wrap.appendChild(sec);
  });

  applyStatuses();
  applyFilter();
}

function mini(txt, title, fn, danger = false) {
  const b = document.createElement('button');
  b.className = 'minibtn' + (danger ? ' danger' : '');
  b.textContent = txt;
  b.title = title;
  b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
  return b;
}

function tileNode(svc, gi, si) {
  const a = document.createElement('a');
  a.className = 'tile';
  a.href = svc.url || '#';
  if (cfg.settings.openInNewTab) { a.target = '_blank'; a.rel = 'noopener'; }
  a.dataset.gi = gi;
  a.dataset.si = si;
  a.dataset.id = svc.id || svc.name;
  a.dataset.search = `${svc.name} ${svc.description || ''} ${svc.url || ''}`.toLowerCase();

  a.appendChild(iconNode(svc));

  const txt = document.createElement('div');
  txt.className = 'txt';
  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = svc.name;
  const ds = document.createElement('div');
  ds.className = 'ds';
  ds.textContent = svc.description || prettyHost(svc.url);
  const downtag = document.createElement('div');
  downtag.className = 'downtag';
  downtag.textContent = 'offline';
  txt.append(nm, ds, downtag);
  a.appendChild(txt);

  const dot = document.createElement('span');
  dot.className = 'dot';
  a.appendChild(dot);

  const tools = document.createElement('div');
  tools.className = 'tile-tools';
  tools.append(
    mini('✎', 'Edit service', () => openServiceModal(gi, si)),
    mini('🗑', 'Delete service', () => {
      cfg.groups[gi].services.splice(si, 1); render(); save();
    }, true),
  );
  a.appendChild(tools);

  // block navigation while editing; enable dragging instead
  a.addEventListener('click', (e) => { if (editing) e.preventDefault(); });
  a.draggable = false;
  a.addEventListener('mousedown', () => { a.draggable = editing; });
  a.addEventListener('dragstart', (e) => {
    if (!editing) { e.preventDefault(); return; }
    drag = { gi, si };
    a.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', svc.name);
  });
  a.addEventListener('dragend', () => { a.classList.remove('dragging'); drag = null; $$('.tiles').forEach(t => t.classList.remove('dragover')); });

  return a;
}

function prettyHost(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function moveGroup(gi, dir) {
  const to = gi + dir;
  if (to < 0 || to >= cfg.groups.length) return;
  const [g] = cfg.groups.splice(gi, 1);
  cfg.groups.splice(to, 0, g);
  render(); save();
}

function wireDropZone(tilesEl) {
  tilesEl.addEventListener('dragover', (e) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    tilesEl.classList.add('dragover');
  });
  tilesEl.addEventListener('dragleave', () => tilesEl.classList.remove('dragover'));
  tilesEl.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    tilesEl.classList.remove('dragover');
    const toGi = parseInt(tilesEl.dataset.gi, 10);

    // figure out insertion index from the tile under the cursor
    const after = e.target.closest('.tile');
    let toSi = cfg.groups[toGi].services.length;
    if (after && after.dataset.si !== undefined) {
      toSi = parseInt(after.dataset.si, 10);
      const rect = after.getBoundingClientRect();
      if (e.clientX > rect.left + rect.width / 2) toSi += 1;
    }

    const [svc] = cfg.groups[drag.gi].services.splice(drag.si, 1);
    if (drag.gi === toGi && drag.si < toSi) toSi -= 1;
    cfg.groups[toGi].services.splice(toSi, 0, svc);
    drag = null;
    render(); save();
  });
}

/* ---------------- edit mode ---------------- */

function setEditing(on) {
  editing = on;
  document.body.classList.toggle('editing', on);
  $('#editbar').hidden = !on;
  $('#btn-edit').classList.toggle('active', on);
}

$('#btn-edit').addEventListener('click', () => setEditing(!editing));
$('#btn-done').addEventListener('click', () => setEditing(false));
$('#btn-add-group').addEventListener('click', () => openGroupModal(null));
$('#btn-add-widget').addEventListener('click', () => openWidgetModal(null));

$('#btn-logout').addEventListener('click', async () => {
  try { await apiPost('/api/auth/logout', {}); } catch { /* ignore */ }
  location.href = '/login';
});

/* ---------------- service modal ---------------- */

let svcTarget = null; // {gi, si|null}

function openServiceModal(gi, si) {
  svcTarget = { gi, si };
  const f = $('#form-service');
  const svc = si === null ? {} : cfg.groups[gi].services[si];
  $('#svc-modal-title').textContent = si === null ? `Add service to “${cfg.groups[gi].name}”` : `Edit “${svc.name}”`;
  f.name.value = svc.name || '';
  f.url.value = svc.url || '';
  f.icon.value = svc.icon || '';
  f.description.value = svc.description || '';
  f.healthEnabled.checked = !!(svc.health && svc.health.enabled);
  f.healthUrl.value = (svc.health && svc.health.url) || '';
  $('#modal-service').showModal();
}

$('#modal-service').addEventListener('close', () => {
  if ($('#modal-service').returnValue !== 'ok' || !svcTarget) return;
  const f = $('#form-service');
  const data = {
    name: f.name.value.trim(),
    url: f.url.value.trim(),
    icon: f.icon.value.trim(),
    description: f.description.value.trim(),
    health: { enabled: f.healthEnabled.checked, url: f.healthUrl.value.trim() },
  };
  if (!data.name) return;
  const { gi, si } = svcTarget;
  if (si === null) {
    data.id = uid('s');
    cfg.groups[gi].services.push(data);
  } else {
    data.id = cfg.groups[gi].services[si].id || uid('s');
    cfg.groups[gi].services[si] = data;
  }
  svcTarget = null;
  render(); save();
  pollStatus(true);
});

/* ---------------- group modal ---------------- */

let grpTarget = null; // index | null

function openGroupModal(gi) {
  grpTarget = gi;
  const f = $('#form-group');
  $('#grp-modal-title').textContent = gi === null ? 'Add group' : 'Rename group';
  f.name.value = gi === null ? '' : cfg.groups[gi].name;
  $('#modal-group').showModal();
}

$('#modal-group').addEventListener('close', () => {
  if ($('#modal-group').returnValue !== 'ok') return;
  const name = $('#form-group').name.value.trim();
  if (!name) return;
  if (grpTarget === null) {
    cfg.groups.push({ id: uid('g'), name, services: [] });
  } else {
    cfg.groups[grpTarget].name = name;
  }
  grpTarget = null;
  render(); save();
});

/* ---------------- integration widgets ---------------- */

const WTYPES = {
  proxmox: {
    label: 'Proxmox',
    fields: [
      { k: 'url', label: 'API URL', ph: 'https://192.168.1.10:8006', req: true },
      { k: 'tokenId', label: 'API token ID', ph: 'root@pam!labdash', req: true },
      { k: 'tokenSecret', label: 'API token secret', ph: 'xxxxxxxx-xxxx-…', req: true, secret: true },
      { k: 'node', label: 'Node name (optional — first node if empty)', ph: 'pve' },
    ],
    help: 'Create a token in Proxmox: Datacenter → Permissions → API Tokens (untick "Privilege Separation" or give it the PVEAuditor role on /).',
  },
  uptimekuma: {
    label: 'Uptime Kuma',
    fields: [
      { k: 'url', label: 'Uptime Kuma URL', ph: 'http://192.168.1.30:3001', req: true },
      { k: 'slug', label: 'Status page slug', ph: 'homelab', req: true },
    ],
    help: 'In Uptime Kuma create a status page (☰ → Status Pages), add your monitors to it, and use its slug here.',
  },
  speedtest: {
    label: 'Speedtest',
    fields: [
      { k: 'url', label: 'Speedtest Tracker URL', ph: 'http://192.168.1.40:8080', req: true },
      { k: 'token', label: 'API token (optional on older versions)', ph: '', secret: true },
    ],
    help: 'Works with Speedtest Tracker (alexjustesen). Create an API token under Settings → API Tokens.',
  },
  pihole: {
    label: 'Pi-hole',
    fields: [
      { k: 'url', label: 'Pi-hole URL', ph: 'http://192.168.1.2', req: true },
      { k: 'token', label: 'API token / app password', ph: '', secret: true },
    ],
    help: 'v5: Settings → API → Show API token. v6: create an app password in Settings → Web interface/API. Both work.',
  },
  qbittorrent: {
    label: 'qBittorrent',
    fields: [
      { k: 'url', label: 'qBittorrent Web UI URL', ph: 'http://192.168.1.25:8081', req: true },
      { k: 'username', label: 'Username', ph: 'admin' },
      { k: 'password', label: 'Password', ph: '', secret: true },
    ],
    help: 'Uses the Web UI API. If login fails, check Options → Web UI → allowed hosts / CSRF settings.',
  },
  rss: {
    label: 'RSS feed',
    fields: [
      { k: 'url', label: 'Feed URL', ph: 'https://www.proxmox.com/en/rss', req: true },
      { k: 'count', label: 'Items to show', ph: '5' },
    ],
    help: 'Any RSS or Atom feed.',
  },
  notes: {
    label: 'Notes',
    fields: [
      { k: 'text', label: 'Note', ph: 'Shopping list for the next node…', textarea: true },
    ],
    help: 'A sticky note on your dashboard. Just click the note text on the card to edit it in place — no need to come back here.',
    client: true,
  },
  iframe: {
    label: 'Embed',
    fields: [
      { k: 'url', label: 'Page URL to embed', ph: 'http://192.168.1.50:3000/d/abc/grafana-dash', req: true },
      { k: 'mode', label: 'Display', select: [['modal', 'Popup — small card, opens fullscreen (recommended)'], ['inline', 'Inline — embedded on the dashboard']] },
      { k: 'height', label: 'Height in pixels (inline mode only)', ph: '400' },
    ],
    help: 'Embeds any page (Grafana panel, cameras, …). The site must allow embedding (no X-Frame-Options: DENY).',
    client: true,
  },
};

let widgetData = {}; // id -> {ok, type, data|error}

function renderWidgets() {
  const row = $('#widgets');
  const list = cfg.widgets || [];
  row.hidden = list.length === 0;
  row.textContent = '';

  list.forEach((w, wi) => {
    const spec = WTYPES[w.type] || { label: w.type };
    const card = document.createElement('div');
    card.className = 'widget';

    const head = document.createElement('div');
    head.className = 'whead';
    const name = document.createElement('span');
    const wd = widgetData[w.id];
    name.textContent = w.title || (w.type === 'rss' && wd && wd.ok && wd.data.feedTitle) || spec.label;
    head.append(name);
    if (name.textContent !== spec.label) {
      const kind = document.createElement('span');
      kind.className = 'wtype';
      kind.textContent = spec.label;
      head.append(kind);
    }
    card.appendChild(head);

    if (w.type === 'iframe' && (w.options || {}).mode === 'inline') card.classList.add('wide');

    const body = document.createElement('div');
    body.className = 'wbody';
    card.appendChild(body); // attach first — client widgets reach up to style their card
    if (spec.client) {
      fillClientWidget(body, w);
    } else {
      const d = widgetData[w.id];
      if (!d) {
        body.innerHTML = '<div class="sub">Loading…</div>';
      } else if (!d.ok) {
        body.innerHTML = '<div class="werr"></div>';
        body.querySelector('.werr').textContent = '⚠ ' + d.error;
      } else {
        fillWidgetBody(body, w.type, d.data);
      }
    }

    const tools = document.createElement('div');
    tools.className = 'widget-tools';
    tools.append(
      mini('✎', 'Edit widget', () => openWidgetModal(wi)),
      mini('🗑', 'Delete widget', () => { cfg.widgets.splice(wi, 1); renderWidgets(); save(); }, true),
    );
    card.appendChild(tools);

    row.appendChild(card);
  });
}

function meterEl(pct) {
  const meter = document.createElement('div');
  meter.className = 'meter';
  meter.style.setProperty('--meter-color', meterColor(pct));
  const fill = document.createElement('i');
  fill.style.width = Math.min(100, pct || 0).toFixed(1) + '%';
  meter.appendChild(fill);
  return meter;
}

function fillWidgetBody(body, type, d) {
  if (type === 'proxmox') {
    const memPct = d.maxmem ? (d.mem / d.maxmem) * 100 : 0;
    const line = (l, v) => { const r = document.createElement('div'); r.className = 'rowline'; r.innerHTML = '<span></span><b></b>'; r.firstChild.textContent = l; r.lastChild.textContent = v; return r; };
    body.append(
      line(`CPU — ${d.node}`, (d.cpu || 0).toFixed(0) + '%'), meterEl(d.cpu),
      line('Memory', `${fmtBytes(d.mem)} / ${fmtBytes(d.maxmem)}`), meterEl(memPct),
      line('VMs / LXCs running', `${d.vms.run}/${d.vms.total} · ${d.cts.run}/${d.cts.total}`),
      line('Uptime', fmtUptime(d.uptime)),
    );
  } else if (type === 'uptimekuma') {
    const big = document.createElement('div');
    big.className = 'big';
    if (d.down === 0) {
      big.innerHTML = `<span class="okband">${d.up}/${d.total} up</span>`;
    } else {
      big.textContent = `${d.up}/${d.total} up`;
    }
    body.appendChild(big);
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = d.down === 0 ? 'All monitors healthy' : `${d.down} monitor${d.down > 1 ? 's' : ''} down`;
    body.appendChild(sub);
    if (d.downNames && d.downNames.length) {
      const dl = document.createElement('div');
      dl.className = 'downlist';
      dl.textContent = '✗ ' + d.downNames.slice(0, 4).join(', ') + (d.downNames.length > 4 ? '…' : '');
      body.appendChild(dl);
    }
  } else if (type === 'speedtest') {
    const cols = document.createElement('div');
    cols.className = 'speedcols';
    const col = (lbl, val) => {
      const c = document.createElement('div'); c.className = 'col';
      const b = document.createElement('div'); b.className = 'big'; b.textContent = val;
      const l = document.createElement('div'); l.className = 'lbl'; l.textContent = lbl;
      c.append(b, l); return c;
    };
    cols.append(
      col('↓ Mbps', d.down.toFixed(0)),
      col('↑ Mbps', d.up.toFixed(0)),
      col('ping ms', d.ping.toFixed(0)),
    );
    body.appendChild(cols);
    if (d.at) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = 'Last run: ' + new Date(d.at).toLocaleString();
      body.appendChild(sub);
    }
  } else if (type === 'pihole') {
    const big = document.createElement('div');
    big.className = 'big';
    big.textContent = `${(d.blocked ?? 0).toLocaleString()} blocked`;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `${(d.pct || 0).toFixed(1)}% of ${(d.queries ?? 0).toLocaleString()} queries today`;
    body.append(big, sub, meterEl(d.pct || 0));
    const st = document.createElement('div');
    st.className = 'sub';
    st.textContent = `${(d.domains ?? 0).toLocaleString()} domains on blocklist · ${d.status}`;
    body.appendChild(st);
  } else if (type === 'qbittorrent') {
    const fmtRate = (b) => { const m = b / 1048576; return m >= 1 ? m.toFixed(1) + ' MB/s' : (b / 1024).toFixed(0) + ' KB/s'; };
    const cols = document.createElement('div');
    cols.className = 'speedcols';
    const col = (lbl, val) => {
      const c = document.createElement('div'); c.className = 'col';
      const b = document.createElement('div'); b.className = 'big'; b.textContent = val;
      const l = document.createElement('div'); l.className = 'lbl'; l.textContent = lbl;
      c.append(b, l); return c;
    };
    cols.append(col('↓ down', fmtRate(d.dl)), col('↑ up', fmtRate(d.ul)));
    body.appendChild(cols);
    if (d.active != null) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = `${d.active} active torrent${d.active === 1 ? '' : 's'}`;
      body.appendChild(sub);
    }
  } else if (type === 'rss') {
    const list = document.createElement('div');
    list.className = 'rsslist';
    d.items.forEach((it) => {
      const a = document.createElement('a');
      a.textContent = '· ' + it.title;
      a.title = it.title + (it.date ? ` — ${it.date}` : '');
      if (it.link) { a.href = it.link; a.target = '_blank'; a.rel = 'noopener'; }
      list.appendChild(a);
    });
    body.appendChild(list);
  }
}

function fillClientWidget(body, w) {
  const o = w.options || {};
  if (w.type === 'notes') {
    const t = document.createElement('div');
    t.className = 'notes-text';
    t.textContent = o.text || '';
    t.title = 'Click to edit';
    t.addEventListener('click', () => startNoteEdit(t, w));
    body.appendChild(t);
  } else if (w.type === 'iframe') {
    if (o.mode === 'inline') {
      const fr = document.createElement('iframe');
      fr.src = o.url || 'about:blank';
      fr.height = Math.max(120, parseInt(o.height, 10) || 400);
      fr.loading = 'lazy';
      fr.sandbox = 'allow-scripts allow-same-origin allow-forms allow-popups';
      body.appendChild(fr);
    } else {
      // modal mode: compact card, page loads only when opened
      const row = document.createElement('div');
      row.className = 'embed-open';
      const go = document.createElement('span'); go.className = 'go'; go.textContent = '🗔';
      const host = document.createElement('span'); host.className = 'host'; host.textContent = prettyHost(o.url) || o.url || '';
      const hint = document.createElement('span'); hint.className = 'hint'; hint.textContent = 'click to open ⤢';
      row.append(go, host, hint);
      body.appendChild(row);
      const card = body.closest('.widget');
      card.classList.add('embed-card');
      card.addEventListener('click', (e) => {
        if (editing || e.target.closest('.widget-tools')) return;
        openEmbed(w);
      });
    }
  }
}

/* Notes are edited right on the card — click, type, click away (or Ctrl+Enter). */
function startNoteEdit(displayEl, w) {
  if (displayEl.dataset.editing) return;
  displayEl.dataset.editing = '1';
  const ta = document.createElement('textarea');
  ta.className = 'notes-edit';
  // inline fallback styling so the editor looks right even if a stale style.css is cached
  ta.style.cssText = 'width:100%;box-sizing:border-box;margin-top:6px;padding:6px 8px;background:var(--surface-2,#1d2430);color:var(--text,#e8ecf3);border:1px solid var(--accent,#4f9cf9);border-radius:8px;font-family:inherit;font-size:.86rem;line-height:1.45;resize:vertical;outline:none;';
  ta.value = (w.options && w.options.text) || '';
  ta.placeholder = 'Write a note…';
  ta.rows = Math.min(12, Math.max(3, ta.value.split('\n').length + 1));
  displayEl.replaceWith(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  let cancelled = false;
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep the dashboard's / and E shortcuts out of the note
    if (e.key === 'Escape') { cancelled = true; ta.blur(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ta.blur();
  });
  ta.addEventListener('blur', () => {
    const newText = ta.value;
    if (!cancelled && newText !== ((w.options && w.options.text) || '')) {
      if (!w.options) w.options = {};
      w.options.text = newText;
      save();
    }
    renderWidgets();
  });
}

function openEmbed(w) {
  const o = w.options || {};
  $('#embed-title').textContent = w.title || prettyHost(o.url) || 'Embed';
  $('#embed-newtab').href = o.url || '#';
  $('#embed-frame').src = o.url || 'about:blank';
  $('#modal-embed').showModal();
}

$('#embed-close').addEventListener('click', () => $('#modal-embed').close());
$('#modal-embed').addEventListener('close', () => { $('#embed-frame').src = 'about:blank'; });

async function pollWidgets(force) {
  renderWidgets(); // show cards (with cached/loading state) immediately
  const needsServer = (cfg.widgets || []).some((w) => WTYPES[w.type] && !WTYPES[w.type].client);
  if (!needsServer) return;
  try {
    widgetData = await apiGet('/api/widgets' + (force ? '?t=' + Date.now() : ''));
    renderWidgets();
  } catch { /* keep whatever we had */ }
}

/* -------- widget modal -------- */

let wgtTarget = null; // index | null

function buildWidgetFields(type, values) {
  const spec = WTYPES[type];
  const box = $('#wgt-fields');
  box.textContent = '';
  spec.fields.forEach((f) => {
    const lab = document.createElement('label');
    lab.textContent = f.label + ' ';
    let inp;
    if (f.textarea) {
      inp = document.createElement('textarea');
      inp.rows = 5;
    } else if (f.select) {
      inp = document.createElement('select');
      f.select.forEach(([val, text]) => {
        const op = document.createElement('option');
        op.value = val; op.textContent = text;
        inp.appendChild(op);
      });
    } else {
      inp = document.createElement('input');
      inp.type = f.secret ? 'password' : 'text';
    }
    inp.name = 'opt_' + f.k;
    inp.placeholder = f.ph || '';
    if (f.req) inp.required = true;
    inp.value = (values && values[f.k]) || '';
    if (f.select && !inp.value) inp.selectedIndex = 0;
    inp.autocomplete = 'off';
    lab.appendChild(inp);
    box.appendChild(lab);
  });
  $('#wgt-help').textContent = spec.help || '';
}

function openWidgetModal(wi) {
  wgtTarget = wi;
  const w = wi === null ? null : cfg.widgets[wi];
  $('#wgt-modal-title').textContent = wi === null ? 'Add widget' : 'Edit widget';
  const f = $('#form-widget');
  f.type.value = w ? w.type : 'proxmox';
  f.type.disabled = wi !== null; // type is fixed once created
  f.title.value = w ? (w.title || '') : '';
  buildWidgetFields(f.type.value, w ? w.options : null);
  $('#modal-widget').showModal();
}

$('#wgt-type').addEventListener('change', (e) => buildWidgetFields(e.target.value, null));

$('#modal-widget').addEventListener('close', () => {
  if ($('#modal-widget').returnValue !== 'ok') return;
  const f = $('#form-widget');
  const type = f.type.value;
  const options = {};
  WTYPES[type].fields.forEach((fl) => { options[fl.k] = f['opt_' + fl.k].value.trim(); });
  if (!cfg.widgets) cfg.widgets = [];
  if (wgtTarget === null) {
    cfg.widgets.push({ id: uid('w'), type, title: f.title.value.trim(), options });
  } else {
    const w = cfg.widgets[wgtTarget];
    w.title = f.title.value.trim();
    w.options = options;
  }
  wgtTarget = null;
  save();
  pollWidgets(true);
});

/* ---------------- settings modal ---------------- */

let pendingWeather = null;

$('#btn-settings').addEventListener('click', () => {
  const f = $('#form-settings');
  const s = cfg.settings;
  f.title.value = s.title || '';
  f.subtitle.value = s.subtitle || '';
  f.theme.value = s.theme || 'dark';
  f.accent.value = s.accent || '#4f9cf9';
  f.searchEngine.value = s.searchEngine || 'https://duckduckgo.com/?q=';
  f.openInNewTab.checked = !!s.openInNewTab;
  f.showClock.checked = !!s.showClock;
  f.showWeather.checked = !!s.showWeather;
  f.showStats.checked = !!s.showStats;
  f.showSearch.checked = !!s.showSearch;
  const bg = s.background || {};
  f.bgValue.value = bg.value || '';
  f.bgBlur.value = bg.blur || 0;
  f.bgDim.value = bg.dim || 0;
  $('#val-blur').textContent = (bg.blur || 0) + 'px';
  $('#val-dim').textContent = (bg.dim || 0) + '%';
  f.customCss.value = s.customCss || '';
  pendingWeather = null;
  $('#geo-results').textContent = '';
  $('#geo-q').value = '';
  $('#geo-current').textContent = s.weather && s.weather.name
    ? `Current location: ${s.weather.name}`
    : 'No location set — weather stays hidden until you pick one.';
  $('#modal-settings').showModal();
});

async function geoSearch() {
  const q = $('#geo-q').value.trim();
  if (!q) return;
  const box = $('#geo-results');
  box.textContent = 'Searching…';
  try {
    const results = await apiGet('/api/geocode?q=' + encodeURIComponent(q));
    box.textContent = '';
    if (!results.length) { box.textContent = 'No matches.'; return; }
    results.forEach((r) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = r.name;
      b.addEventListener('click', () => {
        pendingWeather = r;
        $('#geo-current').textContent = `Selected: ${r.name} (saved when you press Save)`;
        box.textContent = '';
      });
      box.appendChild(b);
    });
  } catch {
    box.textContent = 'Lookup failed — is the server online?';
  }
}
$('#bg-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = $('#bg-upload-status');
  status.textContent = 'Uploading…';
  try {
    const r = await fetch('/api/background', { method: 'POST', body: file });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || 'upload failed');
    $('#form-settings').bgValue.value = out.url;
    status.textContent = `Uploaded ${file.name} — press Save to apply.`;
  } catch (err) {
    status.textContent = '⚠ ' + err.message;
  }
  e.target.value = '';
});

$('#bg-remove').addEventListener('click', async () => {
  try { await fetch('/api/background', { method: 'DELETE' }); } catch { /* ignore */ }
  const f = $('#form-settings');
  if (f.bgValue.value.startsWith('/api/background')) f.bgValue.value = '';
  $('#bg-upload-status').textContent = 'Uploaded image removed — press Save.';
});

$('#form-settings').bgBlur.addEventListener('input', (e) => { $('#val-blur').textContent = e.target.value + 'px'; });
$('#form-settings').bgDim.addEventListener('input', (e) => { $('#val-dim').textContent = e.target.value + '%'; });

$('#geo-go').addEventListener('click', geoSearch);
$('#geo-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); geoSearch(); } });

$('#modal-settings').addEventListener('close', async () => {
  if ($('#modal-settings').returnValue !== 'ok') return;
  const f = $('#form-settings');

  // password change (only when the fields are filled in)
  const cur = f.pwCurrent.value, nw = f.pwNew.value, nw2 = f.pwNew2.value;
  f.pwCurrent.value = f.pwNew.value = f.pwNew2.value = '';
  if (nw || nw2 || cur) {
    if (nw !== nw2) toast('⚠ New passwords do not match — password unchanged');
    else if (nw.length < 4) toast('⚠ New password too short — password unchanged');
    else {
      try {
        await apiPost('/api/auth/change', { current: cur, password: nw });
        toast('Password changed');
      } catch (e) {
        toast('⚠ ' + e.message);
      }
    }
  }
  const s = cfg.settings;
  s.title = f.title.value.trim();
  s.subtitle = f.subtitle.value.trim();
  s.theme = f.theme.value;
  s.accent = f.accent.value;
  s.searchEngine = f.searchEngine.value;
  s.openInNewTab = f.openInNewTab.checked;
  s.showClock = f.showClock.checked;
  s.showWeather = f.showWeather.checked;
  s.showStats = f.showStats.checked;
  s.showSearch = f.showSearch.checked;
  s.background = {
    value: f.bgValue.value.trim(),
    blur: parseInt(f.bgBlur.value, 10) || 0,
    dim: parseInt(f.bgDim.value, 10) || 0,
  };
  s.customCss = f.customCss.value;
  if (pendingWeather) {
    s.weather = { name: pendingWeather.name, lat: pendingWeather.lat, lon: pendingWeather.lon };
  }
  render(); save();
  pollWeather(true);
  pollStats(true);
});

/* ---------------- live status ---------------- */

async function pollStatus(force) {
  try {
    statuses = await apiGet('/api/status' + (force ? '?t=' + Date.now() : ''));
    applyStatuses();
  } catch { /* server briefly away; keep old dots */ }
}

function applyStatuses() {
  $$('.tile').forEach((t) => {
    const st = statuses[t.dataset.id];
    const dot = t.querySelector('.dot');
    t.classList.remove('is-down');
    if (!st) { dot.className = 'dot'; dot.title = ''; return; }
    if (st.up) {
      dot.className = 'dot up';
      dot.title = `Online — ${st.ms} ms${st.code ? ` (HTTP ${st.code})` : ''}`;
    } else {
      dot.className = 'dot down';
      dot.title = `Offline — ${st.error || 'no response'}`;
      t.classList.add('is-down');
    }
  });
}

/* ---------------- system stats ---------------- */

function fmtBytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function meterColor(pct) {
  if (pct == null) return 'var(--accent)';
  if (pct >= 85) return 'var(--danger)';
  if (pct >= 60) return 'var(--warn)';
  return 'var(--accent)';
}

function statTile(label, value, sub, pct) {
  const el = document.createElement('div');
  el.className = 'stat';
  el.innerHTML = '<div class="label"></div><div class="value"></div><div class="sub"></div>';
  el.querySelector('.label').textContent = label;
  el.querySelector('.value').textContent = value;
  el.querySelector('.sub').textContent = sub || '';
  if (pct != null) {
    const meter = document.createElement('div');
    meter.className = 'meter';
    meter.style.setProperty('--meter-color', meterColor(pct));
    const fill = document.createElement('i');
    fill.style.width = Math.min(100, pct).toFixed(1) + '%';
    meter.appendChild(fill);
    el.appendChild(meter);
  }
  return el;
}

async function pollStats(force) {
  if (!cfg.settings.showStats) return;
  try {
    const s = await apiGet('/api/stats');
    const row = $('#stats');
    row.textContent = '';
    row.append(
      statTile('CPU', s.cpu.pct == null ? '…' : s.cpu.pct.toFixed(0) + '%', `${s.cpu.cores} cores · load ${s.load[0].toFixed(2)}`, s.cpu.pct),
      statTile('Memory', s.mem.pct.toFixed(0) + '%', `${fmtBytes(s.mem.used)} of ${fmtBytes(s.mem.total)}`, s.mem.pct),
      s.disk ? statTile('Disk', s.disk.pct.toFixed(0) + '%', `${fmtBytes(s.disk.used)} of ${fmtBytes(s.disk.total)}`, s.disk.pct)
             : statTile('Disk', '—', ''),
      statTile('Uptime', fmtUptime(s.uptime), s.hostname),
    );
  } catch { /* leave last values */ }
}

/* ---------------- weather ---------------- */

const WMO = [
  [[0], '☀️', 'Clear'], [[1, 2], '🌤', 'Partly cloudy'], [[3], '☁️', 'Overcast'],
  [[45, 48], '🌫', 'Fog'], [[51, 53, 55, 56, 57], '🌦', 'Drizzle'],
  [[61, 63, 65, 66, 67, 80, 81, 82], '🌧', 'Rain'],
  [[71, 73, 75, 77, 85, 86], '🌨', 'Snow'], [[95, 96, 99], '⛈', 'Thunderstorm'],
];

function wmoLookup(code) {
  for (const [codes, icon, name] of WMO) if (codes.includes(code)) return { icon, name };
  return { icon: '🌡', name: '' };
}

async function pollWeather(force) {
  const el = $('#weather');
  if (!cfg.settings.showWeather) { el.hidden = true; return; }
  try {
    const w = await apiGet('/api/weather');
    if (!w.enabled || w.error || w.temp == null) { el.hidden = true; return; }
    const { icon, name } = wmoLookup(w.code);
    el.textContent = '';
    const i = document.createElement('span'); i.textContent = icon;
    const t = document.createElement('strong'); t.textContent = `${Math.round(w.temp)}${w.unit}`;
    const p = document.createElement('span'); p.className = 'muted';
    p.textContent = (w.place ? w.place.split(',')[0] + ' · ' : '') + `H ${Math.round(w.hi)}° L ${Math.round(w.lo)}°`;
    el.append(i, t, p);
    el.title = `${name} · humidity ${w.humidity}% · wind ${w.wind} km/h`;
    el.hidden = false;
  } catch { el.hidden = true; }
}

/* ---------------- clock ---------------- */

function tickClock() {
  if (!cfg || !cfg.settings.showClock) return;
  const now = new Date();
  $('#clock-time').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('#clock-date').textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

/* ---------------- search ---------------- */

function applyFilter() {
  const q = ($('#search').value || '').trim().toLowerCase();
  $$('.group').forEach((sec) => {
    let visible = 0;
    sec.querySelectorAll('.tile').forEach((t) => {
      const hit = !q || t.dataset.search.includes(q);
      t.classList.toggle('hidden', !hit);
      if (hit) visible++;
    });
    sec.classList.toggle('hidden', q && visible === 0);
  });
}

$('#search').addEventListener('input', applyFilter);
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; applyFilter(); e.target.blur(); }
  if (e.key === 'Enter') {
    const q = e.target.value.trim();
    if (!q) return;
    const first = $$('.tile:not(.hidden)')[0];
    if (first && first.href && first.href !== '#') {
      window.open(first.href, cfg.settings.openInNewTab ? '_blank' : '_self');
    } else {
      window.open(cfg.settings.searchEngine + encodeURIComponent(q), '_blank');
    }
  }
});

document.addEventListener('keydown', (e) => {
  const typing = /^(input|textarea|select)$/i.test(document.activeElement.tagName);
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
  if (e.key === 'e' || e.key === 'E') setEditing(!editing);
});

/* ---------------- boot ---------------- */

async function boot() {
  cfg = await apiGet('/api/config');
  if (!cfg.widgets) cfg.widgets = [];
  render();
  tickClock();
  setInterval(tickClock, 1000);
  pollStatus(); setInterval(pollStatus, 30 * 1000);
  pollStats(); setInterval(pollStats, 10 * 1000);
  pollWidgets(); setInterval(pollWidgets, 60 * 1000);
  pollWeather(); setInterval(pollWeather, 15 * 60 * 1000);
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', applySettings);
  $('#foot').textContent = 'LabDash — edit everything from the ✎ and ⚙ buttons. Config lives in data/config.json.';
}

boot().catch((e) => {
  document.body.innerHTML = `<p style="font-family:sans-serif;padding:40px">LabDash could not load its config: ${e.message}</p>`;
});
