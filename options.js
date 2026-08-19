/* PagePatch dashboard — operates directly on chrome.storage.local.
   Content scripts + the badge react via storage.onChanged, so edits here apply
   live to open tabs. */

const RK = 'pp_rules_', PK = 'pp_paused_';
let model = [];          // [{ host, rules, paused }]
let filter = '';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function clip(s, n) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }
function genId() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

const ICON = {
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.3 10.7l7.4-4.4M8.3 13.3l7.4 4.4"/></svg>',
};

/* ── Patch Packs — share a site's edits safely ────────────────────────────────
   A pack contains ONLY declarative rules (hide / text / style) — never code — so
   importing someone else's pack can't run anything. Encoded as a copyable string. */
function sanitizeCssValue(v) {
  return String(v || '').replace(/[<>{}]/g, '').replace(/javascript:/gi, '').replace(/expression\s*\(/gi, '').slice(0, 2000);
}
const PACK_ACTIONS = new Set(['hide', 'text', 'style']);
function sanitizePackRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.filter(r => r && PACK_ACTIONS.has(r.action) && typeof r.selector === 'string' && r.selector.length <= 1024)
    .map(r => {
      const out = { id: genId(), action: r.action, selector: r.selector.replace(/[<>{}]/g, '').slice(0, 1024), source: 'pack', createdAt: Date.now() };
      if (r.action === 'text') { out.value = String(r.value ?? '').slice(0, 8000); out.original = String(r.original ?? '').slice(0, 8000); }
      if (r.action === 'style') out.value = sanitizeCssValue(r.value);
      if (r.label) out.label = String(r.label).slice(0, 80);
      if (r.note) out.note = String(r.note).slice(0, 200);
      return out;
    }).slice(0, 500);
}
function buildPack(site) {
  return { app: 'PagePatch', kind: 'pack', v: 1, host: site.host, count: site.rules.length, rules: sanitizePackRules(site.rules) };
}
function encodePack(pack) {
  const json = JSON.stringify(pack);
  return 'pp1_' + btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodePack(code) {
  let s = String(code || '').trim();
  if (s.startsWith('pp1_')) s = s.slice(4);
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const json = decodeURIComponent(escape(atob(s)));
    const pack = JSON.parse(json);
    if (!pack || pack.kind !== 'pack' || !Array.isArray(pack.rules)) return null;
    return pack;
  } catch (_) { return null; }
}

async function load() {
  const all = await chrome.storage.local.get(null);
  const hosts = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(RK)) {
      const host = k.slice(RK.length);
      let changed = false;
      const rules = (Array.isArray(v) ? v : []).map(r => {
        if (!r.id) { changed = true; return { ...r, id: genId(), createdAt: r.createdAt || Date.now() }; }
        return r;
      });
      hosts[host] = hosts[host] || { host, rules: [], paused: false };
      hosts[host].rules = rules;
      if (changed) chrome.storage.local.set({ [k]: rules });   // persist migrated ids for this key only
    } else if (k.startsWith(PK)) {
      const host = k.slice(PK.length);
      hosts[host] = hosts[host] || { host, rules: [], paused: false };
      hosts[host].paused = !!v;
    }
  }
  model = Object.values(hosts)
    .filter(s => s.rules.length || s.paused)
    .sort((a, b) => b.rules.length - a.rules.length || a.host.localeCompare(b.host));
  render();
}

function saveSite(site) {
  return chrome.storage.local.set({ [RK + site.host]: site.rules, [PK + site.host]: site.paused });
}

function matches(site) {
  if (!filter) return true;
  if (site.host.toLowerCase().includes(filter)) return true;
  return site.rules.some(r =>
    (r.label || '').toLowerCase().includes(filter) ||
    (r.value || '').toLowerCase().includes(filter) ||
    (r.original || '').toLowerCase().includes(filter) ||
    (r.selector || '').toLowerCase().includes(filter));
}

function render() {
  const total = model.reduce((n, s) => n + s.rules.length, 0);
  const active = model.reduce((n, s) => n + (s.paused ? 0 : s.rules.filter(r => !r.disabled).length), 0);
  document.getElementById('s-sites').textContent = model.filter(s => s.rules.length).length;
  document.getElementById('s-total').textContent = total;
  document.getElementById('s-active').textContent = active;

  const container = document.getElementById('sites');
  const shown = model.filter(matches);

  if (!total) {
    container.innerHTML = `<div class="empty"><div class="big">${ICON.spark}</div><p><strong>No patches yet.</strong><br>Open any website, click the PagePatch icon, and start hiding or editing.<br>Everything you change will show up here.</p></div>`;
    return;
  }
  if (!shown.length) {
    container.innerHTML = `<div class="empty"><div class="big">${ICON.search}</div><p>Nothing matches “${esc(filter)}”.</p></div>`;
    return;
  }

  container.innerHTML = '';
  shown.forEach(site => {
    const card = document.createElement('div');
    card.className = 'site';
    const activeN = site.paused ? 0 : site.rules.filter(r => !r.disabled).length;
    card.innerHTML = `
      <div class="site-head">
        <div>
          <div class="site-host">${esc(site.host)}</div>
          <div class="site-meta">${site.rules.length} patch${site.rules.length !== 1 ? 'es' : ''} · ${activeN} active</div>
        </div>
        <div class="grow"></div>
        ${site.paused ? '<span class="paused-pill">PAUSED</span>' : ''}
        <label class="switch" title="Pause / resume this site">
          <input type="checkbox" data-pause="${esc(site.host)}" ${site.paused ? '' : 'checked'}>
          <span class="track"></span><span class="thumb"></span>
        </label>
        <button class="icon-btn share" data-share="${esc(site.host)}" title="Share these patches as a pack">${ICON.share}</button>
        <button class="icon-btn" data-clearsite="${esc(site.host)}" title="Remove all patches on this site">${ICON.trash}</button>
      </div>
      <div class="patches"></div>`;
    const pc = card.querySelector('.patches');
    site.rules.forEach(rule => {
      const isEdit = rule.action === 'text';
      const title = rule.label || (isEdit ? clip(rule.original, 60) : rule.selector);
      let body;
      if (isEdit) {
        body = `<div class="p-change"><span class="p-orig">${esc(clip(rule.original, 40)) || '∅'}</span><span class="p-arrow">→</span><span class="p-new">${esc(clip(rule.value, 40)) || '∅'}</span></div>`;
      } else {
        body = `<div class="p-sel" title="${esc(rule.selector)}">${esc(clip(rule.selector, 80))}</div>`;
      }
      const note = rule.note ? `<div class="p-note">“${esc(rule.note)}”</div>` : '';
      const row = document.createElement('div');
      row.className = 'patch' + (rule.disabled ? ' off' : '');
      row.innerHTML = `
        <div class="badge ${isEdit ? 'edit' : 'hide'}">${isEdit ? 'EDIT' : 'HIDE'}</div>
        <div class="p-info">
          <div class="p-title" title="${esc(title)}">${esc(title)}</div>
          ${body}${note}
        </div>
        <label class="switch sm" title="Enable / disable">
          <input type="checkbox" data-toggle="${esc(site.host)}|${rule.id}" ${rule.disabled ? '' : 'checked'}>
          <span class="track"></span><span class="thumb"></span>
        </label>
        <button class="icon-btn" data-del="${esc(site.host)}|${rule.id}" title="Delete patch">${ICON.x}</button>`;
      pc.appendChild(row);
    });
    container.appendChild(card);
  });

  // wire events
  container.querySelectorAll('[data-pause]').forEach(inp => inp.addEventListener('change', async () => {
    const site = model.find(s => s.host === inp.dataset.pause);
    if (site) { site.paused = !inp.checked; await saveSite(site); render(); }
  }));
  container.querySelectorAll('[data-share]').forEach(btn => btn.addEventListener('click', () => {
    const site = model.find(s => s.host === btn.dataset.share);
    if (site) sharePack(site);
  }));
  container.querySelectorAll('[data-clearsite]').forEach(btn => btn.addEventListener('click', async () => {
    const host = btn.dataset.clearsite;
    if (!confirm(`Remove all patches on ${host}?`)) return;
    await chrome.storage.local.remove([RK + host, PK + host]);
    model = model.filter(s => s.host !== host);
    render();
  }));
  container.querySelectorAll('[data-toggle]').forEach(inp => inp.addEventListener('change', async () => {
    const [host, id] = inp.dataset.toggle.split('|');
    const site = model.find(s => s.host === host);
    const rule = site?.rules.find(r => r.id === id);
    if (rule) { rule.disabled = !rule.disabled; await saveSite(site); render(); }
  }));
  container.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
    const [host, id] = btn.dataset.del.split('|');
    const site = model.find(s => s.host === host);
    if (site) { site.rules = site.rules.filter(r => r.id !== id); await saveSite(site); if (!site.rules.length && !site.paused) model = model.filter(s => s.host !== host); render(); }
  }));
}

// ── Export / Import ─────────────────────────────────────────────────────────

async function exportBackup() {
  const all = await chrome.storage.local.get(null);
  const data = {};
  for (const [k, v] of Object.entries(all)) if (k.startsWith(RK) || k.startsWith(PK)) data[k] = v;
  const payload = { app: 'PagePatch', version: 2, exportedAt: new Date().toISOString(), data };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url; a.download = `pagepatch-backup-${stamp}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let parsed;
    try { parsed = JSON.parse(reader.result); } catch (_) { alert('That file isn’t valid JSON.'); return; }
    const data = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : null;
    if (!data) { alert('This doesn’t look like a PagePatch backup.'); return; }
    const keys = Object.keys(data).filter(k => k.startsWith(RK) || k.startsWith(PK));
    if (!keys.length) { alert('No PagePatch patches found in that file.'); return; }
    const sites = new Set(keys.map(k => k.replace(/^pp_(rules|paused)_/, '')));
    if (!confirm(`Import patches for ${sites.size} site${sites.size !== 1 ? 's' : ''}? This replaces patches on those sites.`)) return;
    const toSet = {};
    for (const k of keys) toSet[k] = data[k];
    await chrome.storage.local.set(toSet);
    await load();
  };
  reader.readAsText(file);
}

// ── wiring ──────────────────────────────────────────────────────────────────

// ── modal + patch-pack sharing ──────────────────────────────────────────────
function showModal(innerHTML) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">${innerHTML}</div>`;
  bg.addEventListener('click', e => { if (e.target === bg) bg.remove(); });
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { bg.remove(); document.removeEventListener('keydown', esc); } });
  document.body.appendChild(bg);
  return bg;
}

function sharePack(site) {
  const pack = buildPack(site);
  const code = encodePack(pack);
  const m = showModal(`
    <h2>Share “${esc(site.host)}”</h2>
    <p>${pack.rules.length} patch${pack.rules.length !== 1 ? 'es' : ''}. Anyone can paste this code into <b>Import pack</b> to get your exact edits. Packs contain no code — only safe, declarative changes.</p>
    <textarea readonly>${esc(code)}</textarea>
    <div class="modal-note" id="m-note"></div>
    <div class="modal-row">
      <button class="toolbtn" id="m-file">Download .json</button>
      <button class="toolbtn primary" id="m-copy">Copy code</button>
    </div>`);
  const ta = m.querySelector('textarea');
  ta.addEventListener('focus', () => ta.select());
  m.querySelector('#m-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(code); } catch (_) { ta.select(); document.execCommand('copy'); }
    m.querySelector('#m-note').textContent = 'Copied — send it to anyone.';
  });
  m.querySelector('#m-file').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `pagepatch-${site.host}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
}

function importPackFlow() {
  const m = showModal(`
    <h2>Import a patch pack</h2>
    <p>Paste a pack code (starts with <code style="font-family:var(--mono)">pp1_</code>) or drop a pack file. It only ever adds safe, declarative edits.</p>
    <textarea id="m-in" placeholder="pp1_…"></textarea>
    <div class="modal-note" id="m-note"></div>
    <div class="modal-row">
      <button class="toolbtn" id="m-cancel">Cancel</button>
      <button class="toolbtn primary" id="m-go">Preview</button>
    </div>`);
  const note = m.querySelector('#m-note');
  m.querySelector('#m-cancel').addEventListener('click', () => m.remove());
  m.querySelector('#m-go').addEventListener('click', async () => {
    const pack = decodePack(m.querySelector('#m-in').value);
    if (!pack) { note.className = 'modal-note err'; note.textContent = 'That doesn’t look like a valid pack code.'; return; }
    const clean = sanitizePackRules(pack.rules);
    if (!clean.length) { note.className = 'modal-note err'; note.textContent = 'This pack has no importable patches.'; return; }
    if (!confirm(`Add ${clean.length} patch${clean.length !== 1 ? 'es' : ''} to ${pack.host}?`)) return;
    const key = RK + pack.host;
    const cur = await chrome.storage.local.get(key);
    const merged = (Array.isArray(cur[key]) ? cur[key] : []).concat(clean);
    await chrome.storage.local.set({ [key]: merged });
    m.remove();
    await load();
  });
}
document.getElementById('importpack-btn').addEventListener('click', importPackFlow);

document.getElementById('export-btn').addEventListener('click', exportBackup);
document.getElementById('import-btn').addEventListener('click', () => document.getElementById('file-input').click());
document.getElementById('file-input').addEventListener('change', e => {
  if (e.target.files[0]) importBackup(e.target.files[0]);
  e.target.value = '';
});
document.getElementById('search').addEventListener('input', e => { filter = e.target.value.trim().toLowerCase(); render(); });

// ── Claude Code bridge (tokenless, auto-connecting) ─────────────────────────
const bEnabled = document.getElementById('bridge-enabled');
const bSetup = document.getElementById('bridge-setup');
const bStatus = document.getElementById('bstatus');

function paintStatus(state, error) {
  let cls = 'off', label = 'Not connected';
  if (state === 'connected') { cls = 'on'; label = 'Connected'; }
  else if (state === 'connecting') { cls = 'wait'; label = 'Connecting…'; }
  else if (state === 'error') { cls = 'err'; label = 'Bridge not running'; }
  bStatus.className = 'bstatus ' + cls;
  bStatus.textContent = label;
}

const SETUP_CMD = 'claude mcp add pagepatch -s user -- npx -y pagepatch-bridge';

// The whole setup as one paste-into-Claude-Code prompt: register the bridge, ask
// for a restart, then run the watch loop. This is the "one prompt" — nothing else
// to copy, no token, no port.
const CONNECT_PROMPT =
`Set up "PagePatch" and then watch my edits. PagePatch is my own Chrome extension: I click any element on any web page and ask you to rewrite or restyle it, you apply the change, and I approve it in the browser with a Keep/Discard prompt. It only ever edits pages in my own browser — fully authorized.

Do this in order:

1) Register the PagePatch bridge as an MCP server (user scope, so it works in every project):
   claude mcp add pagepatch -s user -- npx -y pagepatch-bridge
   If that npm package isn't published yet, use the local checkout instead:
   claude mcp add pagepatch -s user -- node /ABSOLUTE/PATH/TO/pagepatch-extension/bridge/src/index.js

2) Tell me to restart Claude Code so the new tools load. There is NO pairing token and NO port to configure — after the restart my extension finds the bridge on 127.0.0.1 and connects on its own.

3) Once you're restarted, WATCH for my edits: call pagepatch_next_request in a loop. When it returns an element (its url, selector, outerHTML, computed styles, my instruction, and any pasted images), make exactly the change I asked for and call pagepatch_apply_edit with the SAME requestId and one of:
   - kind:"text"   -> replace the element's visible text with \`value\`
   - kind:"css"    -> \`value\` is CSS declarations, e.g. "color:#0a84ff;font-weight:700;font-size:22px"
   - kind:"remove" -> delete the element
   If it returns { none: true }, just call pagepatch_next_request again. Keep looping until I tell you to stop. I approve every edit in the browser, so make the edit instead of asking follow-up questions. If an instruction can't be done with text/css/remove (for example "insert an image"), call pagepatch_reject_request with a short reason.`;

function copyNote(t) { const n = document.getElementById('copy-note'); n.textContent = t; setTimeout(() => { if (n.textContent === t) n.textContent = ''; }, 2600); }
async function copy(text, note) { try { await navigator.clipboard.writeText(text); } catch (_) {} copyNote(note); }
document.getElementById('copy-cmd').addEventListener('click', () => copy(SETUP_CMD, 'Command copied'));
document.getElementById('copy-prompt').addEventListener('click', () => copy(CONNECT_PROMPT, 'Prompt copied — paste it into Claude Code, that\'s the whole setup'));
document.getElementById('bridge-retry').addEventListener('click', async () => {
  paintStatus('connecting');
  const r = await chrome.runtime.sendMessage({ type: 'bridge-connect' }).catch(() => null);
  paintStatus(r?.state || 'error', r?.error);
});

async function loadBridge() {
  const { pp_bridge } = await chrome.storage.local.get('pp_bridge');
  const cfg = { enabled: true, ...(pp_bridge || {}) };   // on by default
  bEnabled.checked = !!cfg.enabled;
  bSetup.classList.toggle('show', !!cfg.enabled);
  // Reflect live status, and nudge a connect so an already-running bridge shows green.
  const msg = cfg.enabled ? 'bridge-connect' : 'bridge-get-state';
  chrome.runtime.sendMessage({ type: msg }).then(r => paintStatus(r?.state, r?.error)).catch(() => paintStatus('disconnected'));
}

async function saveBridge(patch) {
  const { pp_bridge } = await chrome.storage.local.get('pp_bridge');
  const cfg = { enabled: true, ...(pp_bridge || {}), ...patch };
  await chrome.storage.local.set({ pp_bridge: cfg });
  return cfg;
}

bEnabled.addEventListener('change', async () => {
  await saveBridge({ enabled: bEnabled.checked });
  bSetup.classList.toggle('show', bEnabled.checked);
  if (bEnabled.checked) chrome.runtime.sendMessage({ type: 'bridge-connect' }).then(r => paintStatus(r?.state, r?.error)).catch(() => {});
  else chrome.runtime.sendMessage({ type: 'bridge-disconnect' }).then(() => paintStatus('disconnected')).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === 'bridge-state') paintStatus(msg.state, msg.error); });

loadBridge();

// Live-refresh when a page edit changes storage while the dashboard is open.
let reloadTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.keys(changes).some(k => k.startsWith(RK) || k.startsWith(PK))) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 150);
  }
});

load();
