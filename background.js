/* PagePatch service worker — toolbar badge + keyboard shortcuts.
   Badge shows the number of ACTIVE patches on the tab's site (blank when the
   site is paused or has none). */

const RESTRICTED = /^(chrome|edge|brave|about|chrome-extension|devtools|view-source|file):|chromewebstore\.google\.com|chrome\.google\.com\/webstore/;
const BLUE = '#0A84FF';
const GREY = '#8E8E93';

function hostOf(url) {
  try { if (RESTRICTED.test(url)) return null; return new URL(url).hostname; }
  catch (_) { return null; }
}

async function stateFor(url) {
  const host = hostOf(url);
  if (!host) return null;
  const rk = 'pp_rules_' + host, pk = 'pp_paused_' + host;
  const data = await chrome.storage.local.get([rk, pk]);
  const rules = Array.isArray(data[rk]) ? data[rk] : [];
  return { total: rules.length, active: rules.filter(r => !r.disabled).length, paused: !!data[pk] };
}

// Blue badge = active patch count. Grey badge = total (site paused). No badge = none.
function setBadge(tabId, color, text) {
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

async function updateBadge(tabId, url) {
  const s = await stateFor(url);
  if (!s) { chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}); return; }
  if (s.paused) setBadge(tabId, GREY, s.total > 0 ? String(s.total) : '');
  else setBadge(tabId, BLUE, s.active > 0 ? String(s.active) : '');
}

async function refreshTab(tabId) {
  try { const tab = await chrome.tabs.get(tabId); if (tab?.url) await updateBadge(tabId, tab.url); }
  catch (_) {}
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' || info.url) updateBadge(tabId, tab.url);
});
chrome.tabs.onActivated.addListener(({ tabId }) => refreshTab(tabId));

// Content script announces its own tab's active count directly.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'rules-changed' && sender.tab) {
    const id = sender.tab.id;
    if (msg.paused) setBadge(id, GREY, msg.total > 0 ? String(msg.total) : '');
    else setBadge(id, BLUE, msg.count > 0 ? String(msg.count) : '');
  }
});

// Storage edits from any context (popup/dashboard) — refresh every affected tab.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes).filter(k => k.startsWith('pp_rules_') || k.startsWith('pp_paused_'));
  if (!keys.length) return;
  const hosts = new Set(keys.map(k => k.replace(/^pp_(rules|paused)_/, '')));
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const h = tab.url && hostOf(tab.url);
    if (h && hosts.has(h)) updateBadge(tab.id, tab.url);
  }
});

// Keyboard shortcuts → activate the picker on the current tab.
chrome.commands.onCommand.addListener(async (command) => {
  const mode = command === 'hide-element' ? 'hide' : command === 'edit-text' ? 'edit'
    : command === 'ask-claude' ? 'ai' : null;
  if (!mode) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'activate-picker', mode }).catch(() => {});
});

/* ──────────────────────────────────────────────────────────────────────────
   Claude Code bridge client
   The extension's socket lives here (in the service worker) so its Origin is
   chrome-extension://<id> — the only origin the local bridge accepts. There is no
   pairing token: we just connect to the bridge on loopback and it greets us with a
   `hello`. We scan a small port range so a drifted bridge port still pairs on its
   own. The bridge relays declarative patches back, which we route to the tab that
   asked. We never execute anything the bridge sends.
   ────────────────────────────────────────────────────────────────────────── */
const PORT_BASE = 8787;        // where the bridge starts looking for a free port
const PORT_SPAN = 12;          // how many ports up from base we'll probe for it
const CONNECT_MS = 1500;       // per-port handshake budget

let bridgeSocket = null;
let bridgeState = 'disconnected';           // 'disconnected' | 'connecting' | 'connected' | 'error'
let bridgeError = '';
let connectingPromise = null;               // de-dupe concurrent connect attempts
let lastGoodPort = 0;                        // try this first next time
const requestTab = new Map();               // requestId -> tabId (route the reply back)

async function bridgeConfig() {
  const { pp_bridge } = await chrome.storage.local.get('pp_bridge');
  // Enabled by default — the bridge is meant to "just work" once the MCP server runs.
  return { enabled: true, portBase: PORT_BASE, ...(pp_bridge || {}) };
}

function setBridgeState(state, err = '') {
  bridgeState = state; bridgeError = err;
  chrome.runtime.sendMessage({ type: 'bridge-state', state, error: err }).catch(() => {});
}

// MV3 keepalive. A Manifest-V3 service worker is killed after ~30s idle, which
// closes our WebSocket AND wipes the requestId→tab map — so an edit that Claude
// takes more than a few seconds on would come back to a dead socket and never
// apply. Chrome resets the idle timer on every extension-API call, so while we're
// connected we tick a cheap one (and a WS ping) every 20s to stay alive.
let keepAliveTimer = null;
function keepAliveTick() {
  try { chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError); } catch {}
  try { bridgeSocket && bridgeSocket.readyState === 1 && bridgeSocket.send(JSON.stringify({ type: 'ping' })); } catch {}
}
function startKeepAlive() { if (keepAliveTimer) return; keepAliveTick(); keepAliveTimer = setInterval(keepAliveTick, 20000); }
function stopKeepAlive() { if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; } }

// Attach the long-lived handlers once a socket has completed the `hello` handshake.
function adoptSocket(ws) {
  bridgeSocket = ws;
  setBridgeState('connected');
  startKeepAlive();
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'apply' && requestTab.has(msg.requestId)) {
      const tabId = requestTab.get(msg.requestId); requestTab.delete(msg.requestId);
      chrome.tabs.sendMessage(tabId, { type: 'ai-apply', requestId: msg.requestId, patch: msg.patch }).catch(() => {});
    } else if (msg.type === 'reject' && requestTab.has(msg.requestId)) {
      const tabId = requestTab.get(msg.requestId); requestTab.delete(msg.requestId);
      chrome.tabs.sendMessage(tabId, { type: 'ai-reject', requestId: msg.requestId, reason: msg.reason || '' }).catch(() => {});
    }
  };
  ws.onclose = () => { if (bridgeSocket === ws) { bridgeSocket = null; stopKeepAlive(); setBridgeState('disconnected'); } };
  ws.onerror = () => {};
}

// Try one port. Resolves with { ws, ready } for the real bridge, or null.
// `ready` = the bridge says Claude Code is actually attached (mcpReady).
function probePort(port) {
  return new Promise((resolve) => {
    let ws, done = false;
    const finish = (val) => { if (!done) { done = true; clearTimeout(t); resolve(val); } };
    try { ws = new WebSocket(`ws://127.0.0.1:${port}`); }
    catch { return resolve(null); }
    const t = setTimeout(() => { try { ws.close(); } catch {} finish(null); }, CONNECT_MS);
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'hello' && msg.bridge === 'pagepatch') finish({ ws, ready: !!msg.mcpReady });
    };
    ws.onerror = () => finish(null);
    ws.onclose = () => finish(null);   // no hello before close → not the bridge
  });
}

async function connectBridge() {
  if (bridgeSocket && bridgeState === 'connected') return 'connected';
  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    const cfg = await bridgeConfig();
    if (!cfg.enabled) { setBridgeState('disconnected'); return 'disconnected'; }

    setBridgeState('connecting');
    const base = cfg.portBase || PORT_BASE;
    const ports = [];
    for (let p = base; p < base + PORT_SPAN; p++) ports.push(p);

    // Probe the whole range at once, then prefer a bridge that Claude Code is
    // actually driving (mcpReady) over any leftover/zombie bridge on the range.
    const probes = await Promise.all(ports.map(p => probePort(p).then(r => (r ? { port: p, ...r } : null))));
    const live = probes.filter(Boolean);
    if (!live.length) { setBridgeState('error', 'no-bridge'); return 'error'; }

    const chosen = live.find(r => r.ready) || live.find(r => r.port === lastGoodPort) || live[0];
    for (const r of live) if (r.ws !== chosen.ws) { try { r.ws.close(); } catch {} }
    lastGoodPort = chosen.port;
    adoptSocket(chosen.ws);
    return 'connected';
  })();

  try { return await connectingPromise; }
  finally { connectingPromise = null; }
}

function disconnectBridge() {
  const ws = bridgeSocket;
  bridgeSocket = null;
  stopKeepAlive();
  try { ws?.close(); } catch {}
  setBridgeState('disconnected');
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'bridge-get-state') { reply({ state: bridgeState, error: bridgeError }); return; }
  if (msg?.type === 'bridge-connect') { connectBridge().then(state => reply({ state, error: bridgeError })); return true; }
  if (msg?.type === 'bridge-disconnect') { disconnectBridge(); reply({ state: 'disconnected' }); return; }

  if (msg?.type === 'ai-edit-request' && sender.tab) {
    (async () => {
      const state = await connectBridge();
      if (state !== 'connected') { reply({ ok: false, error: bridgeError || 'not connected', state }); return; }
      requestTab.set(msg.request.id, sender.tab.id);
      try { bridgeSocket.send(JSON.stringify({ type: 'edit-request', request: msg.request })); reply({ ok: true }); }
      catch (e) { requestTab.delete(msg.request.id); reply({ ok: false, error: String(e) }); }
    })();
    return true;
  }
});

// Come up on our own whenever the service worker spins up, so the bridge is
// already connected by the time the user reaches for it. Silent if the bridge
// isn't running yet — the next edit request (or a dashboard "Retry") tries again.
chrome.runtime.onStartup?.addListener(() => { connectBridge().catch(() => {}); });
chrome.runtime.onInstalled?.addListener(() => { connectBridge().catch(() => {}); });
connectBridge().catch(() => {});
