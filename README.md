# PagePatch

> Cursor for any website. Hide or rewrite anything on any page, permanently, and edit it with AI.

MIT licensed and open source. Contributions welcome.

Permanently hide or rewrite anything on any website. Your changes survive refresh,
hard refresh, and restart — stored locally and re-applied every time the page loads,
with **zero flash** (patched text never appears as its original, even for a frame).

## Install (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. **Load unpacked** → select this `pagepatch-extension` folder
4. Pin PagePatch so you can see the badge

Update after code changes: `chrome://extensions` → ↺ on the PagePatch card.

## Use

Click the icon, or use a keyboard shortcut, then click any element:

- **🗑 Hide element** — `Alt+Shift+H` — remove it forever.
- **✏️ Edit text** — `Alt+Shift+E` — type a replacement inline (works on links & logos).

While picking, the highlight follows your cursor exactly. Fine-tune with arrow keys:
`↑` parent · `↓` child · `←` `→` siblings. `Esc` cancels. In edit mode `Enter` saves.

The toolbar **badge** shows how many patches are active on the current site
(blue = active count, grey = paused).

## Manage & back up

The popup lists every patch on the current site with an **enable/disable** switch,
delete, **Undo last**, **Clear all**, and a per-site **pause** switch.

**Manage all sites & backup →** opens the full **dashboard** (`options.html`):

- Every patch across every site, grouped, searchable.
- Enable/disable or delete any patch; pause or clear a whole site.
- **Export backup** → a plain-JSON file of everything.
- **Import** → restore from a backup (or move your patches to another machine).

Changes in the dashboard apply **live** to any open tabs.

## Ask Claude Code to edit a page (beta)

Turn PagePatch into **Cursor for any website**: select an element, describe the
change (drop screenshots if you like), and Claude Code rewrites or restyles it —
permanently, behind a Keep / Discard preview.

**Setup (one time — no pairing token):**

1. Add the bridge to Claude Code:
   ```bash
   claude mcp add pagepatch -s user -- npx -y pagepatch-bridge
   ```
2. Restart Claude Code so the tools load, then tell it:
   *“watch PagePatch and apply my edits.”*

That's it — the extension finds the bridge on `127.0.0.1` and connects on its own.
No token to copy, no port to configure.

**Then, on any page:** click **Ask Claude to edit an element** (`Alt+Shift+C`), pick
an element, type what you want (e.g. *“make this a bold blue heading”* or *“rewrite
as one punchy line”*), and hit Send. Claude's edit appears with **Keep it / Discard**.
Keep it, and it's saved as a normal PagePatch rule that survives every refresh.

Everything is local: your prompt, screenshots, and the page content go only to the
bridge on `127.0.0.1`, which is origin-locked to the extension. See
[`bridge/`](bridge/) for the architecture and security details.

## Share your setup (Patch Packs)

Every site's edits can be exported as a **Patch Pack** — a copyable code (or `.json`
file) you can send to anyone. In the dashboard, hit the **share** icon on a site to
get a `pp1_…` code; others paste it into **Import pack** to get your exact edits.

Unlike JS-based customizers, PagePatch packs contain **only declarative rules**
(hide / text / restyle) — never code — and the importer re-sanitises everything, so
installing a stranger's pack can't run anything on your machine. Make a
distraction-free Twitter, share the pack, done.

## One-tap looks

From the popup: **Dark** (invert any site to dark mode), **Bigger** (scale up text),
and **Calm** (grayscale). Each is just a reversible style rule — toggle or delete it
like any other patch.

## How it works

- Patches are keyed by **hostname**. Durable copy: `chrome.storage.local`. A
  synchronous `localStorage` mirror is kept only as a `document_start` fast-path.
- **Hiding** is injected CSS — applies before paint, auto-covers dynamic content.
- **Text edits** apply with **zero flash**: rules are read synchronously at
  `document_start` and each target is patched inside `requestAnimationFrame`
  (before the browser paints), including nodes that stream in during parse or on
  SPA re-renders. The original is kept for exact undo.
- Editing a **hyperlink or logo** works: navigation is suppressed while you type,
  and clicks landing on an SVG/image resolve to the nearest editable element.
- Each patch carries a stable id, an enabled flag, a timestamp and an optional note.

## Notes / limits

- Patches are per-site (host), not per-URL path.
- Content inside cross-origin `<iframe>`s isn't patched.
- Structural selectors can break if a site ships a major redesign; just re-apply.
- The `localStorage` fast-path means a site's own scripts could read your patch
  list for that site. Everything stays local to your browser.

## Contributing

PagePatch is open source under the [MIT license](LICENSE). Issues and pull
requests are welcome, whether it is a bug on a specific site, a new quick action,
or an improvement to the Claude Code bridge. To hack on it:

1. `git clone` this repo and load it unpacked (see **Install** above).
2. For the AI bridge, work in `bridge/` (`npm install`, `npm test`).
3. Open a PR describing what changed and how you tested it.

No build step, no framework. It is plain JS on purpose, so it stays easy to read
and audit.
