const RESTRICTED = /^(chrome|edge|brave|about|chrome-extension|devtools|view-source|file):|^https:\/\/chrome\.google\.com\/webstore|^https:\/\/chromewebstore\.google\.com/;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
function send(tab, msg) { return chrome.tabs.sendMessage(tab.id, msg); }
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function clip(s, n) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

let tab = null;

function disableAll(reason) {
  document.getElementById('hide-btn').disabled = true;
  document.getElementById('edit-btn').disabled = true;
  document.getElementById('undo-btn').disabled = true;
  document.getElementById('clear-btn').disabled = true;
  document.getElementById('pause-row').style.display = 'none';
  document.querySelector('.tip').style.display = 'none';
  document.getElementById('rules-list').innerHTML = `<div class="empty">${esc(reason).replace(/\n/g, '<br>')}</div>`;
  document.getElementById('count-label').textContent = '—';
}

async function render() {
  tab = await getActiveTab();
  let host = '—';
  try { host = new URL(tab.url).hostname || tab.url; } catch (_) {}
  const hostEl = document.getElementById('host-label');
  hostEl.textContent = host; hostEl.title = tab.url || '';

  if (!tab.url || RESTRICTED.test(tab.url)) {
    disableAll("PagePatch can’t run on this page.\nOpen a normal website to start editing.");
    return;
  }

  let state;
  try { state = await send(tab, { type: 'get-state' }); } catch (_) {
    disableAll("This page loaded before PagePatch.\nRefresh it, then reopen this popup.");
    return;
  }
  const rules = Array.isArray(state?.rules) ? state.rules : [];
  const paused = !!state?.paused;

  // Pause switch (checked = active)
  const pt = document.getElementById('pause-toggle');
  pt.checked = !paused;
  document.getElementById('pause-sub').textContent = paused ? 'Paused — nothing is applied' : 'Patches are applied';

  document.getElementById('hide-btn').disabled = paused;
  document.getElementById('edit-btn').disabled = paused;

  const active = rules.filter(r => !r.disabled).length;
  document.getElementById('count-label').textContent =
    rules.length + ' patch' + (rules.length !== 1 ? 'es' : '') + (rules.length ? ` · ${active} on` : '');
  document.getElementById('undo-btn').disabled = !rules.length;
  document.getElementById('clear-btn').disabled = !rules.length;

  const list = document.getElementById('rules-list');
  if (!rules.length) {
    list.innerHTML = `<div class="empty">No patches here yet.<br><strong>Pick a mode above</strong> to start.</div>`;
    return;
  }

  list.innerHTML = '';
  rules.forEach(rule => {
    const isEdit = rule.action === 'text';
    const title = rule.label || (isEdit ? clip(rule.original, 40) : rule.selector);
    let change = '';
    if (isEdit) {
      change = `<div class="rule-change">
        <span class="rule-orig">${esc(clip(rule.original, 22)) || '∅'}</span>
        <span class="rule-arrow">→</span>
        <span class="rule-new">${esc(clip(rule.value, 22)) || '∅'}</span></div>`;
    } else {
      change = `<div class="rule-sel" title="${esc(rule.selector)}">${esc(clip(rule.selector, 44))}</div>`;
    }
    const item = document.createElement('div');
    item.className = 'rule-item' + (rule.disabled ? ' off' : '');
    item.innerHTML = `
      <div class="rule-badge ${isEdit ? 'edit' : 'hide'}">${isEdit ? 'EDIT' : 'HIDE'}</div>
      <div class="rule-info">
        <div class="rule-title" title="${esc(title)}">${esc(title)}</div>
        ${change}
      </div>
      <label class="switch sm" title="Enable / disable">
        <input type="checkbox" data-toggle="${rule.id}" ${rule.disabled ? '' : 'checked'}>
        <span class="track"></span><span class="thumb"></span>
      </label>
      <button class="del-rule" data-del="${rule.id}" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    list.appendChild(item);
  });

  list.querySelectorAll('[data-toggle]').forEach(inp => {
    inp.addEventListener('change', async () => {
      try { await send(tab, { type: 'toggle-rule', id: inp.dataset.toggle }); } catch (_) {}
      render();
    });
  });
  list.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await send(tab, { type: 'delete-rule', id: btn.dataset.del }); } catch (_) {}
      render();
    });
  });
}

async function pick(mode) {
  try { await send(tab, { type: 'activate-picker', mode }); window.close(); }
  catch (_) { disableAll('Refresh the page first, then reopen PagePatch.'); }
}

document.getElementById('hide-btn').addEventListener('click', () => pick('hide'));
document.getElementById('edit-btn').addEventListener('click', () => pick('edit'));
document.getElementById('ai-btn').addEventListener('click', async () => {
  // No token to check anymore — just try to reach the bridge. If it's running,
  // start the picker; if not, open the dashboard so the user can set up Claude Code.
  const r = await chrome.runtime.sendMessage({ type: 'bridge-connect' }).catch(() => null);
  if (r?.state === 'connected') { pick('ai'); return; }
  chrome.runtime.openOptionsPage();
  window.close();
});

document.getElementById('pause-toggle').addEventListener('change', async (e) => {
  try { await send(tab, { type: 'set-paused', paused: !e.target.checked }); } catch (_) {}
  render();
});

// One-tap site-wide "looks" — declarative style rules, reversible like any patch.
// The `[id^="pp-"]` re-invert keeps PagePatch's own UI readable under Dark.
const PRESETS = {
  dark: [
    { action: 'style', selector: 'html', value: 'background:#fff!important;filter:invert(1) hue-rotate(180deg)!important', label: 'Dark mode' },
    { action: 'style', selector: 'img,video,picture,svg,canvas,iframe,[style*="background-image"],[id^="pp-"]', value: 'filter:invert(1) hue-rotate(180deg)!important', label: 'Dark mode (media)' },
  ],
  bigger: [{ action: 'style', selector: 'html', value: 'font-size:118%!important', label: 'Bigger text' }],
  gray: [{ action: 'style', selector: 'html', value: 'filter:grayscale(1)!important', label: 'Calm (grayscale)' }],
};
async function applyLook(key) {
  try { await send(tab, { type: 'add-rules', rules: PRESETS[key] }); } catch (_) {}
  render();
}
document.getElementById('look-dark').addEventListener('click', () => applyLook('dark'));
document.getElementById('look-bigger').addEventListener('click', () => applyLook('bigger'));
document.getElementById('look-gray').addEventListener('click', () => applyLook('gray'));

document.getElementById('undo-btn').addEventListener('click', async () => {
  try { await send(tab, { type: 'undo-last' }); } catch (_) {}
  render();
});
document.getElementById('clear-btn').addEventListener('click', async () => {
  try { await send(tab, { type: 'clear-rules' }); } catch (_) {}
  render();
});
document.getElementById('manage-btn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

render();
