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
let fontPct = 100;

// ---- Appearance (theme + accent) -------------------------------------------
const THEMES = ['auto', 'light', 'dark'];
const ACCENTS = ['blue', 'purple', 'green', 'orange', 'pink', 'teal'];

function resolveTheme(t) {
  if (t === 'auto') {
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return t;
}
function applyAppearance(theme, accent) {
  const d = document.documentElement;
  d.setAttribute('data-theme', resolveTheme(theme));
  d.setAttribute('data-accent', accent);
  // Reflect active states in the popover.
  document.querySelectorAll('#theme-seg [data-theme-val]').forEach(b => {
    b.classList.toggle('active', b.dataset.themeVal === theme);
  });
  document.querySelectorAll('#accents .accent-dot').forEach(b => {
    b.classList.toggle('active', b.dataset.accent === accent);
  });
}
function getTheme() { return localStorage.getItem('pp_theme') || 'auto'; }
function getAccent() { return localStorage.getItem('pp_accent') || 'blue'; }
function setTheme(t) {
  localStorage.setItem('pp_theme', t);
  try { chrome.storage.local.set({ pp_theme: t }); } catch (_) {}
  applyAppearance(t, getAccent());
}
function setAccent(a) {
  localStorage.setItem('pp_accent', a);
  try { chrome.storage.local.set({ pp_accent: a }); } catch (_) {}
  applyAppearance(getTheme(), a);
}
function initAppearance() {
  applyAppearance(getTheme(), getAccent());
  const panel = document.getElementById('appearance');
  const btn = document.getElementById('theme-btn');
  btn.addEventListener('click', () => {
    const open = panel.classList.toggle('show');
    btn.classList.toggle('open', open);
  });
  const closePanel = () => { panel.classList.remove('show'); btn.classList.remove('open'); };
  document.addEventListener('click', (e) => {
    if (panel.classList.contains('show') && !panel.contains(e.target) && !btn.contains(e.target)) closePanel();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });
  document.querySelectorAll('#theme-seg [data-theme-val]').forEach(b => {
    b.addEventListener('click', () => setTheme(b.dataset.themeVal));
  });
  document.querySelectorAll('#accents .accent-dot').forEach(b => {
    b.addEventListener('click', () => setAccent(b.dataset.accent));
  });
  // Keep "Auto" live if the OS theme flips while the popup is open.
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getTheme() === 'auto') applyAppearance('auto', getAccent());
  });
}

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
  if (!tab) { disableAll("Couldn’t read the current tab.\nTry reopening PagePatch."); return; }
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

  // Reflect the current site-wide text size in the stepper.
  const sizeRule = rules.find(r => r.label === 'Text size');
  const m = sizeRule && /font-size:(\d+)%/.exec(sizeRule.value || '');
  fontPct = m ? +m[1] : 100;
  const sv = document.getElementById('size-val');
  if (sv) sv.textContent = fontPct + '%';
  markActiveStyles(rules);

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
// Broad text selector — recolors/retypes copy without nuking icon fonts.
const TEXT_SEL = 'body,p,li,span,a,h1,h2,h3,h4,h5,h6,td,th,blockquote,label,input,textarea,button,figcaption';
const PRESETS = {
  dark: [
    { action: 'style', selector: 'html', value: 'background:#fff!important;filter:invert(1) hue-rotate(180deg)!important', label: 'Dark mode' },
    { action: 'style', selector: 'img,video,picture,svg,canvas,iframe,[style*="background-image"],[id^="pp-"]', value: 'filter:invert(1) hue-rotate(180deg)!important', label: 'Dark mode (media)' },
  ],
  bigger: [{ action: 'style', selector: 'html', value: 'font-size:118%!important', label: 'Bigger text' }],
  gray: [{ action: 'style', selector: 'html', value: 'filter:grayscale(1)!important', label: 'Calm (grayscale)' }],
  // Fonts — swap the typeface site-wide.
  serif:    [{ action: 'style', selector: TEXT_SEL, value: "font-family:Georgia,'Times New Roman',serif!important", label: 'Serif font' }],
  mono:     [{ action: 'style', selector: TEXT_SEL, value: "font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace!important", label: 'Mono font' }],
  rounded:  [{ action: 'style', selector: TEXT_SEL, value: "font-family:'SF Pro Rounded',Nunito,'Segoe UI',system-ui,sans-serif!important", label: 'Rounded font' }],
  readable: [{ action: 'style', selector: TEXT_SEL, value: "font-family:'Atkinson Hyperlegible',Verdana,Tahoma,sans-serif!important;letter-spacing:0.01em!important", label: 'Readable font' }],
  // Reading comfort.
  spacing:  [{ action: 'style', selector: 'p,li,article,blockquote', value: 'line-height:1.85!important;letter-spacing:0.012em!important', label: 'Comfort spacing' }],
  contrast: [{ action: 'style', selector: 'html', value: 'filter:contrast(1.18)!important', label: 'High contrast' }],
  sepia:    [{ action: 'style', selector: 'html', value: 'filter:sepia(0.38) brightness(1.02)!important', label: 'Sepia (warm)' }],
};
// Highlight the quick-style controls whose rules are currently applied.
const LOOK_LABELS = {
  'look-dark': ['Dark mode'],
  'look-bigger': ['Bigger text'],
  'look-gray': ['Calm (grayscale)'],
};
const CHIP_LABELS = {
  serif: 'Serif font', mono: 'Mono font', rounded: 'Rounded font', readable: 'Readable font',
  spacing: 'Comfort spacing', contrast: 'High contrast', sepia: 'Sepia (warm)',
};
function markActiveStyles(rules) {
  const active = new Set((rules || []).filter(r => !r.disabled).map(r => r.label));
  Object.entries(LOOK_LABELS).forEach(([id, labels]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', labels.some(l => active.has(l)));
  });
  document.querySelectorAll('[data-look]').forEach(chip => {
    const label = CHIP_LABELS[chip.dataset.look];
    chip.classList.toggle('active', !!label && active.has(label));
  });
}

async function applyLook(key) {
  if (!PRESETS[key]) return;
  try { await send(tab, { type: 'add-rules', rules: PRESETS[key] }); } catch (_) {}
  render();
}
document.getElementById('look-dark').addEventListener('click', () => applyLook('dark'));
document.getElementById('look-bigger').addEventListener('click', () => applyLook('bigger'));
document.getElementById('look-gray').addEventListener('click', () => applyLook('gray'));
// Delegated handler for the Fonts / Reading chip rows.
document.querySelectorAll('[data-look]').forEach(chip => {
  chip.addEventListener('click', () => applyLook(chip.dataset.look));
});

// Text-size stepper — one adjustable rule, updated in place via set-style.
async function applySize() {
  document.getElementById('size-val').textContent = fontPct + '%';
  try {
    await send(tab, { type: 'set-style', selector: 'html', value: `font-size:${fontPct}%!important`, label: 'Text size' });
  } catch (_) {}
  render();
}
document.getElementById('size-down').addEventListener('click', () => { fontPct = Math.max(60, fontPct - 10); applySize(); });
document.getElementById('size-up').addEventListener('click', () => { fontPct = Math.min(220, fontPct + 10); applySize(); });
document.getElementById('size-reset').addEventListener('click', () => { fontPct = 100; applySize(); });

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

initAppearance();
render();
