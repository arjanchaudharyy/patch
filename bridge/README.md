# pagepatch-bridge

The local bridge that lets **Claude Code edit web pages** you select in the
[PagePatch](../README.md) browser extension.

It is a single process with two faces:

- **To Claude Code** — an MCP server over stdio (tools to read the element you
  selected and push an edit back).
- **To the browser** — a WebSocket server bound to `127.0.0.1`, restricted to
  `chrome-extension://` origins. No pairing token: the extension auto-connects and
  the bridge greets it with a `hello`.

```
 ┌───────────────┐   select + prompt    ┌──────────────┐   MCP (stdio)   ┌─────────────┐
 │  PagePatch    │ ───────────────────▶ │              │ ──────────────▶ │             │
 │  extension    │                      │    bridge    │                 │ Claude Code │
 │ (service      │ ◀─────────────────── │  (this pkg)  │ ◀────────────── │             │
 │  worker)      │   apply patch         └──────────────┘   apply_edit    └─────────────┘
 └───────────────┘   ws://127.0.0.1 (origin gated)
```

## Run it

```bash
# add it to Claude Code as an MCP server (user scope → available in every project)
claude mcp add pagepatch -s user -- npx -y pagepatch-bridge
```

Restart Claude Code so the tools load, then tell it:
*“watch PagePatch and apply my edits.”* It will loop on `pagepatch_next_request`
and act on each element you send.

There is **no pairing step**. The extension scans a small port range on `127.0.0.1`,
finds the bridge, and connects on its own — nothing to copy or configure. The port
lives in `~/.pagepatch/bridge.json`; override it with `PAGEPATCH_PORT` (the extension
probes `8787`–`8798`).

## MCP tools

| Tool | Purpose |
|------|---------|
| `pagepatch_status` | Is the extension connected? How many requests are waiting? |
| `pagepatch_next_request({timeoutMs?})` | Long-poll for the next element the user sent (url, selector, `outerHTML`, computed styles, prompt, images). |
| `pagepatch_list_pending` | Summaries of all waiting requests. |
| `pagepatch_apply_edit({requestId, kind, value?, note?})` | Apply an edit. `kind` ∈ `text` / `css` / `remove`. |
| `pagepatch_reject_request({requestId, reason?})` | Decline a request. |

Every applied edit is shown to the user with a **Keep / Discard** prompt before it
becomes a permanent PagePatch rule.

## Security

- Binds to loopback (`127.0.0.1`) only — never a public interface.
- The WebSocket handshake is rejected unless the `Origin` is `chrome-extension://…`
  and the `Host` is localhost (blocks websites and DNS-rebinding). A web page cannot
  forge a `chrome-extension://` origin, so this origin+loopback pair is the trust
  boundary — no shared secret is needed to keep other local processes out.
- The bridge only relays **declarative patch data** (`text` / `css` / `remove`). It
  never executes code, and never reflects one extension's data to another.
- Payloads are size-capped (HTML, prompt, images).
- `stdout` is reserved for the MCP protocol; all logs go to `stderr`.

## Test

```bash
npm install
node test/integration.mjs   # drives both the MCP and WebSocket sides end-to-end
```

MIT.
