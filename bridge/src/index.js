#!/usr/bin/env node
/**
 * PagePatch bridge
 * ================
 * A single local process with two faces:
 *   • To Claude Code  — an MCP server over stdio (tools to read edit requests and
 *                       push edits back).
 *   • To the browser  — a WebSocket server bound to 127.0.0.1, restricted to
 *                       chrome-extension:// origins. No pairing token: the extension
 *                       auto-connects and the bridge greets it with a `hello`.
 *
 * Security stance:
 *   - Never binds to anything but loopback (127.0.0.1) — unreachable off the machine.
 *   - Rejects any WS client that isn't a chrome-extension origin on a localhost Host.
 *     That origin+loopback pair IS the trust boundary — a page on the web cannot forge
 *     a chrome-extension:// Origin, so no shared secret is needed to keep others out.
 *   - Only ever *relays declarative patch data*. It never executes code, and never
 *     reflects one extension's data to another.
 *   - stdout is reserved for the MCP protocol; all logs go to stderr.
 */
import { WebSocketServer } from 'ws';
import net from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, CONFIG_PATH } from './config.js';

const cfg = loadConfig();

// A port is "in use" if anything answers a connection on 127.0.0.1 — the exact
// thing the extension will hit — regardless of IPv4/IPv6 binding quirks.
function portInUse(p) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port: p });
    const done = (v) => { try { s.destroy(); } catch {} res(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));       // ECONNREFUSED → nothing there → free
    s.setTimeout(400, () => done(false));
  });
}
// Always scan up from the configured base so we land on the same (lowest free)
// port every run — predictable for pairing. We don't persist the drift.
async function ensurePort() {
  const base = cfg.port;
  for (let p = base; p < base + 40; p++) {
    if (!(await portInUse(p))) return p;
  }
  return base;
}

// CLI helpers (run directly, not as an MCP server).
const arg = process.argv[2];
if (arg === '--token' || arg === '-t' || arg === '--status') {
  const port = await ensurePort();
  process.stdout.write(
    `PagePatch bridge — no pairing token needed.\n` +
    `Add the MCP server, restart Claude Code, and reload the extension; it auto-connects.\n` +
    `port: ${port} (set PAGEPATCH_PORT to force one)\n`);
  process.exit(0);
}
if (arg === '--help' || arg === '-h') {
  const port = await ensurePort();
  process.stdout.write(
    `pagepatch-bridge — lets Claude Code edit pages via the PagePatch extension\n\n` +
    `  pagepatch-bridge            run the bridge (used as an MCP server by Claude Code)\n` +
    `  pagepatch-bridge --status   print the port the extension will auto-connect to\n` +
    `  pagepatch-bridge --help     this help\n\n` +
    `  No pairing token — the extension connects to 127.0.0.1 on its own.\n` +
    `  Port: ${port} (set PAGEPATCH_PORT to force one)\n`);
  process.exit(0);
}

const log = (...a) => process.stderr.write('[pagepatch-bridge] ' + a.join(' ') + '\n');
cfg.port = await ensurePort();   // pick a free port before we bind

// ── Limits (defensive caps on anything crossing the boundary) ───────────────
const MAX_HTML = 200_000;      // outerHTML chars
const MAX_PROMPT = 8_000;      // user prompt chars
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 6_000_000;
const CLAIM_TTL_MS = 120_000;  // a claimed-but-unfinished request frees up after this

// ── Shared state ────────────────────────────────────────────────────────────
let nextSockId = 1;
let mcpReady = false;                      // true once Claude Code has attached over MCP
const authed = new Set();                 // Set<WebSocket> (authenticated extension sockets)
const pending = new Map();                // requestId -> { request, socket, claimed, claimedUntil }
const waiters = [];                       // long-poll resolvers from Claude Code

// ── WebSocket server (extension side) ───────────────────────────────────────
const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: cfg.port,
  maxPayload: MAX_IMAGE_BYTES * (MAX_IMAGES + 2),
  verifyClient: ({ origin, req }) => {
    // Only the extension's own contexts (service worker / options page) may connect.
    const okOrigin = typeof origin === 'string' && origin.startsWith('chrome-extension://');
    const host = (req.headers.host || '').split(':')[0];
    const okHost = host === '127.0.0.1' || host === 'localhost';
    return okOrigin && okHost;
  },
});

wss.on('listening', () => {
  log(`WebSocket listening on 127.0.0.1:${cfg.port}`);
  log(`Config: ${CONFIG_PATH}`);
  log('');
  log('  ┌─────────────────────────────────────────────────────────────┐');
  log('  │  PagePatch bridge is up. No pairing token needed —            │');
  log('  │  reload the extension and it auto-connects on loopback.       │');
  log('  └─────────────────────────────────────────────────────────────┘');
  log(`  (port ${cfg.port} — set PAGEPATCH_PORT to change)`);
  log('');
});
wss.on('error', (e) => log('WS error:', e.message));

wss.on('connection', (socket, req) => {
  socket._ppId = nextSockId++;
  socket.isAlive = true;

  // verifyClient already proved this is a chrome-extension origin on loopback —
  // that's the whole trust boundary, so the socket is trusted the moment it opens.
  // Greet it so the extension can confirm it reached the real PagePatch bridge
  // (and not some other localhost WebSocket) before it starts sending edits.
  // `mcpReady` tells the extension whether Claude Code is actually attached, so it
  // can prefer a live bridge over a leftover/zombie one squatting the port.
  authed.add(socket);
  send(socket, { type: 'hello', bridge: 'pagepatch', version: 1, mcpReady });
  log(`extension #${socket._ppId} connected (${authed.size} live)`);

  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'edit-request') handleEditRequest(socket, msg.request);
    else if (msg.type === 'cancel') dropRequest(msg.requestId);
    // Legacy 'auth' messages from older extensions are simply ignored now.
  });

  socket.on('close', () => {
    authed.delete(socket);
    // Drop any pending requests owned by this socket.
    for (const [id, entry] of pending) if (entry.socket === socket) pending.delete(id);
    log(`extension #${socket._ppId} disconnected (${authed.size} live)`);
  });
  socket.on('error', () => {});
});

// Heartbeat: cull dead sockets.
const heartbeat = setInterval(() => {
  for (const s of wss.clients) {
    if (s.isAlive === false) { try { s.terminate(); } catch {} continue; }
    s.isAlive = false;
    try { s.ping(); } catch {}
  }
}, 30_000);
heartbeat.unref?.();

function send(socket, obj) {
  try { socket.send(JSON.stringify(obj)); } catch {}
}

function handleEditRequest(socket, request) {
  if (!request || typeof request !== 'object') return;
  // Validate + clamp everything before it becomes visible to Claude Code.
  const clean = {
    id: String(request.id || '').slice(0, 64) || 'req_' + Math.random().toString(36).slice(2),
    url: String(request.url || '').slice(0, 2048),
    title: String(request.title || '').slice(0, 300),
    selector: String(request.selector || '').slice(0, 1024),
    text: String(request.text || '').slice(0, MAX_HTML),
    outerHTML: String(request.outerHTML || '').slice(0, MAX_HTML),
    styles: request.styles && typeof request.styles === 'object' ? request.styles : {},
    prompt: String(request.prompt || '').slice(0, MAX_PROMPT),
    images: Array.isArray(request.images)
      ? request.images.slice(0, MAX_IMAGES)
          .filter(im => im && typeof im.dataUrl === 'string' && im.dataUrl.length <= MAX_IMAGE_BYTES)
          .map(im => ({ name: String(im.name || 'image').slice(0, 120), dataUrl: im.dataUrl }))
      : [],
    receivedAt: new Date().toISOString(),
  };
  pending.set(clean.id, { request: clean, socket, claimed: false, claimedUntil: 0 });
  log(`edit-request ${clean.id} queued (${pending.size} pending)`);
  // Wake the oldest waiting Claude Code poll, if any.
  const waiter = waiters.shift();
  if (waiter) waiter(claimNext());
}

function claimNext() {
  const now = Date.now();
  for (const entry of pending.values()) {
    if (!entry.claimed || entry.claimedUntil < now) {
      entry.claimed = true;
      entry.claimedUntil = now + CLAIM_TTL_MS;
      return entry.request;
    }
  }
  return null;
}

function dropRequest(id) { pending.delete(id); }

// ── MCP server (Claude Code side) ───────────────────────────────────────────
const INSTRUCTIONS = `PagePatch lets the user pick an element in their browser and ask you to edit it.

To act on edits, WATCH for them: call \`pagepatch_next_request\` (it long-polls). When it
returns a request, you get the element the user selected — its url, selector, outerHTML,
computed styles, the user's prompt, and any pasted images. Produce the edit and call
\`pagepatch_apply_edit\` with the same requestId and one of:
  • kind:"text"   — replace the element's visible text with \`value\`
  • kind:"css"    — \`value\` is CSS declarations (e.g. "color:#0a84ff;font-weight:700;font-size:22px")
  • kind:"remove" — delete the element
Make the change directly rather than asking follow-up questions — the user approves every
edit with a Keep / Discard prompt in the browser. Then call \`pagepatch_next_request\` again
to keep watching. If it returns {none:true}, just call it again. Stop only when the user says so.`;

const mcp = new McpServer({ name: 'pagepatch', version: '0.1.0' }, { instructions: INSTRUCTIONS });

// When Claude Code finishes the MCP handshake, tell any connected extensions that
// this bridge is live — so they can prefer it over a leftover bridge on the range.
mcp.server.oninitialized = () => {
  mcpReady = true;
  log('Claude Code attached (MCP initialized)');
  for (const s of authed) send(s, { type: 'ready' });
};

// A ready-to-run prompt the user can paste into Claude Code.
mcp.registerPrompt('watch_pagepatch', {
  description: 'Watch PagePatch and apply the edits the user sends from their browser.',
}, () => ({
  messages: [{
    role: 'user',
    content: { type: 'text', text: 'Watch PagePatch: repeatedly call pagepatch_next_request and apply each element I send using pagepatch_apply_edit (text / css / remove). Keep looping until I tell you to stop.' },
  }],
}));

mcp.registerTool('pagepatch_status', {
  description: 'Report bridge status: whether the PagePatch browser extension is connected and how many edit requests are waiting.',
  inputSchema: {},
}, async () => text({ connected: authed.size > 0, extensions: authed.size, pending: pending.size, driven: mcpReady }));

mcp.registerTool('pagepatch_next_request', {
  description:
    'Wait for the next element the user sent from the browser. Returns { request } with the element the user selected (url, selector, outerHTML, computed styles, the user\'s prompt, and any pasted images as data URLs), or { none: true } if nothing arrived before the timeout. Call this in a loop to act on edits as they come in. After producing an edit, call pagepatch_apply_edit with the same request id.',
  inputSchema: { timeoutMs: z.number().int().min(1000).max(60000).optional() },
}, async ({ timeoutMs }) => {
  const ready = claimNext();
  if (ready) return text({ request: ready });
  const req = await new Promise((resolve) => {
    const done = (r) => { clearTimeout(t); const i = waiters.indexOf(done); if (i >= 0) waiters.splice(i, 1); resolve(r); };
    const t = setTimeout(() => done(null), timeoutMs ?? 25000);
    waiters.push(done);
  });
  return text(req ? { request: req } : { none: true });
});

mcp.registerTool('pagepatch_list_pending', {
  description: 'List summaries of all edit requests currently waiting (id, url, selector, prompt).',
  inputSchema: {},
}, async () => text({
  pending: [...pending.values()].map(e => ({
    id: e.request.id, url: e.request.url, selector: e.request.selector,
    prompt: e.request.prompt, claimed: e.claimed,
  })),
}));

mcp.registerTool('pagepatch_apply_edit', {
  description:
    'Apply an edit to the element the user selected. `kind` is one of: ' +
    '"text" — replace the element\'s visible text with `value`; ' +
    '"css"  — set `value` to CSS declarations scoped to the element (e.g. ' +
    '"color:#0a84ff;font-weight:700;font-size:20px") for colour, size, spacing, weight, etc.; ' +
    '"remove" — delete the element. ' +
    'The user reviews the change with a Keep / Discard prompt before it becomes permanent, ' +
    'so prefer making the edit rather than asking follow-up questions.',
  inputSchema: {
    requestId: z.string(),
    kind: z.enum(['text', 'css', 'remove']),
    value: z.string().optional(),
    note: z.string().optional(),
  },
}, async ({ requestId, kind, value, note }) => {
  const entry = pending.get(requestId);
  if (!entry) return text({ ok: false, error: 'unknown or expired requestId' });
  send(entry.socket, { type: 'apply', requestId, patch: { kind, value: value ?? '', note: note ?? '' } });
  pending.delete(requestId);
  return text({ ok: true, delivered: true, note: 'Sent to the browser for the user to Keep or Discard.' });
});

mcp.registerTool('pagepatch_reject_request', {
  description: 'Decline an edit request (e.g. it is unsafe or impossible) and tell the user why.',
  inputSchema: { requestId: z.string(), reason: z.string().optional() },
}, async ({ requestId, reason }) => {
  const entry = pending.get(requestId);
  if (entry) { send(entry.socket, { type: 'reject', requestId, reason: reason ?? '' }); pending.delete(requestId); }
  return text({ ok: !!entry });
});

function text(obj) { return { content: [{ type: 'text', text: JSON.stringify(obj) }] }; }

// ── Boot ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
mcp.connect(transport).then(() => log('MCP server ready (stdio)')).catch((e) => { log('MCP connect failed:', e.message); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { clearInterval(heartbeat); try { wss.close(); } catch {} process.exit(0); });
}
