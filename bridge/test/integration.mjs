/* End-to-end bridge test: drives the MCP stdio interface (as Claude Code would)
   and a WebSocket client (as the extension would), and checks the security gates. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const PORT = Number(process.env.PP_TEST_PORT) || 8799;
let cfg; // loaded after the bridge boots (it creates the config file)
let pass = 0, fail = 0;
const A = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL:', m); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

const proc = spawn(process.execPath, ['src/index.js'], { env: { ...process.env, PAGEPATCH_PORT: String(PORT) }, stdio: ['pipe', 'pipe', 'inherit'] });

// ── minimal MCP stdio client ──
let buf = '';
const mcpPending = new Map();
proc.stdout.on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && mcpPending.has(msg.id)) { mcpPending.get(msg.id)(msg); mcpPending.delete(msg.id); }
  }
});
let mcpId = 0;
function rpc(method, params) {
  const id = ++mcpId;
  return new Promise(resolve => { mcpPending.set(id, resolve); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
}
function notify(method, params) { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
function toolCall(name, args) { return rpc('tools/call', { name, arguments: args }).then(r => JSON.parse(r.result.content[0].text)); }

function connectWS(origin = 'chrome-extension://testextensionid') {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { Origin: origin } });
  ws.on('message', d => { const m = JSON.parse(d.toString()); ws._last = m; (ws._onmsg || (() => {}))(m); });
  ws._ready = new Promise((res, rej) => { ws._onmsg = m => { if (m.type === 'hello') res(ws); }; ws.on('error', rej); });
  return ws;
}

async function main() {
  await wait(600); // let servers boot (creates ~/.pagepatch/bridge.json)
  cfg = JSON.parse(readFileSync(join(homedir(), '.pagepatch', 'bridge.json'), 'utf8'));

  console.log('== MCP handshake ==');
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  A(init.result && init.result.serverInfo, 'initialize handshake ok');
  notify('notifications/initialized');
  const status0 = await toolCall('pagepatch_status', {});
  A(status0.connected === false && status0.pending === 0, 'status: no extension yet');

  console.log('== security gates ==');
  // wrong origin → rejected at handshake
  let originRejected = false;
  await new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { Origin: 'https://evil.com' } });
    ws.on('error', () => { originRejected = true; res(); });
    ws.on('open', () => { ws.close(); res(); });
  });
  A(originRejected, 'non-extension origin is rejected at the handshake');

  console.log('== tokenless round-trip ==');
  const ext = connectWS();
  await ext._ready;
  A(ext._last && ext._last.type === 'hello' && ext._last.bridge === 'pagepatch', 'extension connects with no token and is greeted with hello');

  const status1 = await toolCall('pagepatch_status', {});
  A(status1.connected === true && status1.extensions === 1, 'status: extension connected');

  // long-poll first (nothing yet) then send a request → poll resolves with it
  const pollP = toolCall('pagepatch_next_request', { timeoutMs: 8000 });
  await wait(200);
  ext.send(JSON.stringify({ type: 'edit-request', request: {
    id: 'req_test_1', url: 'https://example.com', selector: 'h1#title',
    outerHTML: '<h1 id="title">Old headline</h1>', text: 'Old headline',
    prompt: 'make it say Hello World and bold', images: [],
  }}));
  const polled = await pollP;
  A(polled.request && polled.request.id === 'req_test_1', 'next_request delivers the queued element');
  A(polled.request.prompt.includes('Hello World'), 'request carries the user prompt');

  // apply an edit → extension receives it
  const applied = new Promise(res => { ext._onmsg = m => { if (m.type === 'apply') res(m); }; });
  const applyRes = await toolCall('pagepatch_apply_edit', { requestId: 'req_test_1', kind: 'text', value: 'Hello World' });
  A(applyRes.ok === true, 'apply_edit returns ok');
  const applyMsg = await applied;
  A(applyMsg.patch.kind === 'text' && applyMsg.patch.value === 'Hello World', 'extension receives the patch to apply');

  // applying an expired/unknown id fails cleanly
  const bad2 = await toolCall('pagepatch_apply_edit', { requestId: 'nope', kind: 'text', value: 'x' });
  A(bad2.ok === false, 'apply to unknown requestId fails cleanly');

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  proc.kill();
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); proc.kill(); process.exit(1); });
