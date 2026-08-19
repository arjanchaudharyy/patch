/* PagePatch — content script (v3)
 * Source of truth: chrome.storage.local (per-host). A synchronous localStorage
 * mirror is kept purely as a document_start fast-path for zero-flash text edits.
 * Hide = declarative CSS. Edit = imperative text with captured original for undo.
 * Rules carry stable ids, an enabled/disabled flag, timestamps and optional notes.
 */
(() => {
  'use strict';
  if (window.__pagePatchLoaded) return;      // guard against double injection
  window.__pagePatchLoaded = true;

  const HOST = location.hostname;
  const STORE_KEY = 'pp_rules_' + HOST;
  const PAUSE_KEY = 'pp_paused_' + HOST;

  let rules = [];                 // single source of truth
  let paused = false;             // per-site master switch
  const appliedText = new Map();  // selector -> original text (for undo)
  let observer = null;
  let debounceTimer = null;
  let reconciling = false;

  // ─────────────────────────────────────────────────────────────── UTIL ────

  function escAttr(v) { return String(v).replace(/(["\\])/g, '\\$1'); }
  function genId() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // Assign ids / timestamps to any rule missing them (migrates old data).
  function normalizeRules(list) {
    let changed = false;
    const out = (Array.isArray(list) ? list : []).map(r => {
      const n = { ...r };
      if (!n.id) { n.id = genId(); changed = true; }
      if (!n.createdAt) { n.createdAt = Date.now(); changed = true; }
      return n;
    });
    return { list: out, changed };
  }

  // Only rules that should currently affect the page.
  function activeRules() { return paused ? [] : rules.filter(r => !r.disabled); }
  function activeHide() { return activeRules().filter(r => r.action === 'hide'); }
  function activeText() { return activeRules().filter(r => r.action === 'text'); }
  function activeStyle() { return activeRules().filter(r => r.action === 'style'); }

  function getElementText(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) return n.textContent;
    }
    return el.textContent;
  }

  // Replace visible text without destroying child elements (icons, SVGs…).
  function setElementText(el, text) {
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) { n.textContent = text; return; }
    }
    const hasEl = Array.from(el.childNodes).some(n => n.nodeType === Node.ELEMENT_NODE);
    if (!hasEl) { el.textContent = text; return; }
    el.insertBefore(document.createTextNode(text), el.firstChild); // container w/o direct text
  }

  function isElementVisibleHidden(el) {
    try { return getComputedStyle(el).display === 'none'; } catch (_) { return false; }
  }

  // ───────────────────────────────────────────────────────── RECONCILE ────

  function injectHideCSS(hideRules) {
    let style = document.getElementById('pp-hide-css');
    if (!style) {
      style = document.createElement('style');
      style.id = 'pp-hide-css';
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = hideRules.length
      ? hideRules.map(r => `${r.selector}{display:none!important}`).join('\n')
      : '';
  }

  // Declarative restyle rules (color, size, spacing…) — like hide, fully reversible.
  function injectStyleCSS(styleRules) {
    let style = document.getElementById('pp-style-css');
    if (!style) {
      style = document.createElement('style');
      style.id = 'pp-style-css';
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = styleRules.length
      ? styleRules.map(r => `${r.selector}{${r.value}}`).join('\n')
      : '';
  }

  // Apply active text rules to the current DOM. Cheap + idempotent (stamp guards).
  function applyTextRules() {
    const textRules = activeText();
    const activeSel = new Set(textRules.map(r => r.selector));
    // Undo text that is no longer active (deleted / disabled / paused).
    for (const [sel, orig] of Array.from(appliedText)) {
      if (!activeSel.has(sel)) {
        safeQueryAll(sel).forEach(el => { setElementText(el, orig); el.removeAttribute('data-pp-text'); });
        appliedText.delete(sel);
      }
    }
    // Apply / refresh active text rules.
    textRules.forEach(r => {
      safeQueryAll(r.selector).forEach(el => {
        if (el.getAttribute('data-pp-text') === r.value) return;
        if (!appliedText.has(r.selector)) appliedText.set(r.selector, getElementText(el));
        setElementText(el, r.value);
        el.setAttribute('data-pp-text', r.value);
      });
    });
    return textRules.length > 0;
  }

  // Full reconcile. `deep` runs the getComputedStyle inline-hide fallback — only
  // needed when the rule set actually changed, not on every DOM mutation.
  function reconcile(deep = true) {
    if (reconciling) return;
    reconciling = true;
    observer?.disconnect();
    try {
      const hideRules = activeHide();
      injectHideCSS(hideRules);
      injectStyleCSS(activeStyle());
      if (deep) {
        document.querySelectorAll('[data-pp-hidden]').forEach(el => {
          el.style.removeProperty('display');
          el.removeAttribute('data-pp-hidden');
        });
        hideRules.forEach(r => {
          safeQueryAll(r.selector).forEach(el => {
            if (!isElementVisibleHidden(el)) {
              el.style.setProperty('display', 'none', 'important');
              el.setAttribute('data-pp-hidden', '1');
            }
          });
        });
      }
      const hasText = applyTextRules();
      updateObserver(hasText);
    } finally {
      reconciling = false;
      reconnectObserver();
    }
  }

  // Pre-paint text application: scheduled inside requestAnimationFrame, which the
  // browser runs *before* it paints — so patched text is never flashed as its
  // original. Throttled to one pass per frame.
  let fastScheduled = false;
  function scheduleFastText() {
    if (fastScheduled) return;
    fastScheduled = true;
    requestAnimationFrame(() => {
      fastScheduled = false;
      if (reconciling) return;
      reconciling = true;
      observer?.disconnect();
      try { applyTextRules(); } finally { reconciling = false; reconnectObserver(); }
    });
  }

  function safeQueryAll(sel) {
    try { return Array.from(document.querySelectorAll(sel)); } catch (_) { return []; }
  }

  // ───────────────────────────────────────────────────────── OBSERVER ────
  // Observe documentElement (present at document_start) only while active text
  // rules exist — hide is pure CSS and needs no observer.

  function updateObserver(needed) {
    if (needed && !observer) {
      observer = new MutationObserver(() => {
        scheduleFastText();                                        // pre-paint, this frame
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => reconcile(false), 300);   // settle pass
      });
      reconnectObserver();
    } else if (!needed && observer) {
      observer.disconnect();
      observer = null;
    }
  }
  function reconnectObserver() {
    if (observer && document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  // ─────────────────────────────────────────────────────────── STORAGE ────

  function mirror() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(rules));
      localStorage.setItem(PAUSE_KEY, paused ? '1' : '0');
    } catch (_) {}
  }
  function readMirror() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const p = raw ? JSON.parse(raw) : null;
      const pz = localStorage.getItem(PAUSE_KEY) === '1';
      return { rules: Array.isArray(p) ? p : null, paused: pz };
    } catch (_) { return { rules: null, paused: false }; }
  }

  function announce() {
    const count = paused ? 0 : rules.filter(r => !r.disabled).length;
    chrome.runtime.sendMessage({ type: 'rules-changed', host: HOST, count, total: rules.length, paused }).catch(() => {});
  }

  async function saveRules() {
    mirror();
    await chrome.storage.local.set({ [STORE_KEY]: rules });
    announce();
  }
  async function savePaused() {
    mirror();
    await chrome.storage.local.set({ [PAUSE_KEY]: paused });
    announce();
  }

  // Keep in sync across tabs / popup / dashboard writes.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let touched = false;
    if (changes[STORE_KEY]) { rules = normalizeRules(changes[STORE_KEY].newValue).list; touched = true; }
    if (changes[PAUSE_KEY]) { paused = !!changes[PAUSE_KEY].newValue; touched = true; }
    if (touched) { mirror(); reconcile(true); }
  });

  // ─────────────────────────────────────────────────────────────── INIT ────

  // Phase 1 — synchronous, at document_start: arm from the localStorage mirror so
  // hide CSS is present and text rules are patched with zero flash.
  const cached = readMirror();
  if (cached.rules) {
    rules = cached.rules;
    paused = cached.paused;
    injectHideCSS(activeHide());
    injectStyleCSS(activeStyle());
    if (activeText().length) { applyTextRules(); updateObserver(true); }
  }

  // Phase 2 — async: reconcile against the durable source of truth.
  (async () => {
    const data = await chrome.storage.local.get([STORE_KEY, PAUSE_KEY]);
    const norm = normalizeRules(data[STORE_KEY]);
    rules = norm.list;
    paused = !!data[PAUSE_KEY];
    mirror();
    if (norm.changed) chrome.storage.local.set({ [STORE_KEY]: rules }); // persist migrated ids
    reconcile(true);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => reconcile(true), { once: true });
    }
  })();

  // ─────────────────────────────────────────────────────────── SELECTOR ────
  // Guarantees uniqueness where possible by climbing until the path is unique.

  function isUnique(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch (_) { return false; }
  }

  function getSelector(el) {
    if (el.id) {
      const s = '#' + CSS.escape(el.id);
      if (isUnique(s)) return s;
    }
    const stableAttrs = ['data-testid', 'data-cy', 'data-id', 'data-qa', 'aria-label', 'name'];
    for (const attr of stableAttrs) {
      const val = el.getAttribute(attr);
      if (val) {
        const s = `${el.tagName.toLowerCase()}[${attr}="${escAttr(val)}"]`;
        if (isUnique(s)) return s;
      }
    }
    const segs = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      if (node.id) { segs.unshift('#' + CSS.escape(node.id)); break; }
      let seg = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (sameTag.length > 1) seg += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      segs.unshift(seg);
      const candidate = segs.join(' > ');
      if (isUnique(candidate)) return candidate;
      node = parent;
    }
    return segs.join(' > ');
  }

  // Short human label for a rule (used in toasts / dashboard fallbacks).
  function labelFor(el) {
    const t = el.textContent.trim().replace(/\s+/g, ' ');
    if (t) return t.slice(0, 40);
    return '<' + el.tagName.toLowerCase() + '>';
  }

  // ──────────────────────────────────────────────────────────── PICKER ────

  let mode = null;            // 'hide' | 'edit' | null
  let pickerTarget = null;
  let rafPending = false;
  let activeEditCancel = null; // cancels an in-progress inline edit, if any

  function activatePicker(newMode) {
    if (activeEditCancel) activeEditCancel();
    if (mode) deactivatePicker();
    mode = newMode;
    pickerTarget = null;
    const labels = {
      hide: '<strong>Removing.</strong> Click an element to delete it',
      edit: '<strong>Editing.</strong> Click text to change it',
      ai:   '<strong>Ask Claude.</strong> Click an element to send it',
    };

    const tb = document.createElement('div');
    tb.id = 'pp-toolbar';
    tb.className = 'pp-glass';
    tb.setAttribute('data-mode', newMode);
    tb.innerHTML = `
      <div class="pp-tb-left">
        <span class="pp-tb-dot"></span>
        <span class="pp-tb-label">${labels[newMode] || labels.edit}</span>
      </div>
      <div class="pp-tb-keys">
        <kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd><span class="pp-tb-keyhint">precise select</span>
      </div>
      <button class="pp-tb-cancel" id="pp-cancel">Esc</button>`;
    document.documentElement.appendChild(tb);
    document.documentElement.classList.add('pp-picking');
    tb.querySelector('#pp-cancel').addEventListener('click', deactivatePicker);

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onPick, true);
    document.addEventListener('keydown', onPickerKey, true);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition, true);
  }

  function deactivatePicker() {
    if (activeEditCancel) activeEditCancel();
    if (!mode) return;
    mode = null;
    pickerTarget = null;
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onPick, true);
    document.removeEventListener('keydown', onPickerKey, true);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition, true);
    document.documentElement.classList.remove('pp-picking');
    clearOverlay();
    document.getElementById('pp-toolbar')?.remove();
  }

  function clearOverlay() { document.getElementById('pp-overlay')?.remove(); }
  function isOurUI(el) { return !!el?.closest?.('#pp-toolbar,#pp-editbar,#pp-toast,#pp-overlay'); }

  function onMouseMove(e) {
    if (rafPending) return;
    rafPending = true;
    const { clientX, clientY } = e;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!mode) return;
      const el = document.elementFromPoint(clientX, clientY);
      if (!el || isOurUI(el) || el === document.documentElement || el === document.body) return;
      if (el === pickerTarget) return;
      pickerTarget = el;
      renderOverlay(el);
    });
  }

  function reposition() { if (pickerTarget) renderOverlay(pickerTarget); }

  function renderOverlay(el) {
    clearOverlay();
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    const ov = document.createElement('div');
    ov.id = 'pp-overlay';
    ov.setAttribute('data-mode', mode);
    ov.style.cssText =
      `top:${r.top + scrollY}px;left:${r.left + scrollX}px;width:${r.width}px;height:${r.height}px`;

    const label = document.createElement('div');
    label.className = 'pp-ov-label';
    const crumb = document.createElement('span');
    crumb.className = 'pp-ov-crumb';
    crumb.textContent = pathCrumb(el);
    label.appendChild(crumb);
    const txt = el.textContent.trim().replace(/\s+/g, ' ').slice(0, 32);
    if (txt) label.appendChild(document.createTextNode(' · “' + txt + '”'));
    ov.appendChild(label);
    if (r.top < 30) label.classList.add('pp-ov-label-below');
    document.body.appendChild(ov);
  }

  function pathCrumb(el) {
    const parts = [];
    let node = el;
    while (node && node !== document.body && parts.length < 4) {
      parts.unshift(node.tagName.toLowerCase() + (node.id ? '#' + node.id : ''));
      node = node.parentElement;
    }
    return parts.join(' › ');
  }

  function onPick(e) {
    const target = pickerTarget;
    if (!target || isOurUI(target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!target.isConnected) { toast('That element is no longer on the page'); deactivatePicker(); return; }
    clearOverlay();
    if (mode === 'hide') doHide(target);
    else if (mode === 'edit') doEdit(target);
    else if (mode === 'ai') doAI(target);
  }

  function onPickerKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); deactivatePicker(); return; }
    if (!pickerTarget) return;
    let next = null;
    if (e.key === 'ArrowUp')    next = pickerTarget.parentElement;
    if (e.key === 'ArrowDown')  next = pickerTarget.firstElementChild;
    if (e.key === 'ArrowLeft')  next = pickerTarget.previousElementSibling;
    if (e.key === 'ArrowRight') next = pickerTarget.nextElementSibling;
    if (next && next !== document.body && next !== document.documentElement && !isOurUI(next)) {
      e.preventDefault();
      pickerTarget = next;
      renderOverlay(next);
    }
  }

  // ───────────────────────────────────────────────────────────── ACTIONS ────

  async function doHide(el) {
    const selector = getSelector(el);
    if (rules.some(r => r.action === 'hide' && r.selector === selector)) {
      toast('Already hidden');
      deactivatePicker();
      return;
    }
    rules.push({ id: genId(), action: 'hide', selector, label: labelFor(el), createdAt: Date.now() });
    await saveRules();
    reconcile(true);
    toast('Removed — stays gone after refresh');
    deactivatePicker();
  }

  // SVG nodes, images and other media can't hold an editable caret — climb to the
  // nearest ordinary HTML element (e.g. the <a> wrapping a logo) that can.
  function editableTarget(el) {
    while (el && el !== document.body) {
      if (el instanceof window.SVGElement || ['IMG', 'PICTURE', 'CANVAS', 'VIDEO', 'svg'].includes(el.tagName)) {
        el = el.parentElement;
        continue;
      }
      break;
    }
    return el && el !== document.body && el !== document.documentElement ? el : null;
  }

  function placeCaretEnd(el) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
  }

  function doEdit(rawEl) {
    const el = editableTarget(rawEl);
    if (!el) { toast('Can’t place a cursor there — try Hide instead'); deactivatePicker(); return; }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      toast('Form fields can’t be edited here — pick the label text instead');
      deactivatePicker();
      return;
    }

    // Suspend picker interactions while typing.
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onPick, true);
    document.removeEventListener('keydown', onPickerKey, true);
    document.documentElement.classList.remove('pp-picking');
    clearOverlay();
    document.getElementById('pp-toolbar')?.remove();

    const selector = getSelector(el);
    const original = getElementText(el);
    const hasChildEls = Array.from(el.childNodes).some(n => n.nodeType === Node.ELEMENT_NODE);

    // Block link navigation / SPA route handlers while editing.
    const blockNav = ev => { ev.preventDefault(); ev.stopPropagation(); };
    el.addEventListener('click', blockNav, true);
    el.addEventListener('auxclick', blockNav, true);
    const prevDraggable = el.draggable;
    el.draggable = false;

    el.setAttribute('data-pp-editing', '1');
    el.setAttribute('data-pp-original', original);
    el.contentEditable = 'true';
    el.spellcheck = false;
    el.focus();
    if (hasChildEls || !original.trim()) placeCaretEnd(el);
    else selectAll(el);

    const bar = buildEditBar();
    document.body.appendChild(bar);
    const place = () => positionBar(bar, el);
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place, true);

    let done = false;
    let onEditKey = null, onEditPaste = null;
    const finish = () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place, true);
      el.removeEventListener('click', blockNav, true);
      el.removeEventListener('auxclick', blockNav, true);
      if (onEditKey) el.removeEventListener('keydown', onEditKey);
      if (onEditPaste) el.removeEventListener('paste', onEditPaste);
      el.draggable = prevDraggable;
      el.contentEditable = 'false';
      el.removeAttribute('data-pp-editing');
      el.removeAttribute('data-pp-original');
      bar.remove();
      mode = null;
      activeEditCancel = null;
    };

    async function save() {
      if (done) return; done = true;
      const value = getElementText(el);
      finish();
      if (value === original) { toast('No change'); return; }
      const existing = rules.find(r => r.action === 'text' && r.selector === selector);
      if (existing) {
        existing.value = value;
        existing.disabled = false;
        appliedText.set(selector, existing.original ?? original);
      } else {
        rules.push({ id: genId(), action: 'text', selector, value, original, label: original.trim().slice(0, 40) || value.slice(0, 40), createdAt: Date.now() });
        appliedText.set(selector, original);
      }
      el.setAttribute('data-pp-text', value);
      await saveRules();
      toast('Saved — survives every refresh');
    }
    function cancel() {
      if (done) return; done = true;
      setElementText(el, original);
      finish();
    }
    activeEditCancel = cancel;

    bar.querySelector('#pp-eb-save').addEventListener('click', save);
    bar.querySelector('#pp-eb-cancel').addEventListener('click', cancel);
    // Remove this element instead of editing its text.
    bar.querySelector('#pp-eb-remove').addEventListener('click', () => {
      cancel();
      if (!rules.some(r => r.action === 'hide' && r.selector === selector)) {
        rules.push({ id: genId(), action: 'hide', selector, label: labelFor(el), createdAt: Date.now() });
        saveRules().then(() => reconcile(true));
      }
      toast('Removed — stays gone after refresh');
    });
    // Hand this same element off to Claude Code.
    bar.querySelector('#pp-eb-claude').addEventListener('click', () => { cancel(); doAI(el); });
    onEditKey = ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); save(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
    };
    onEditPaste = ev => {
      ev.preventDefault();
      const text = (ev.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    };
    el.addEventListener('keydown', onEditKey);
    el.addEventListener('paste', onEditPaste);
  }

  function selectAll(el) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
  }

  function buildEditBar() {
    const bar = document.createElement('div');
    bar.id = 'pp-editbar';
    bar.className = 'pp-glass';
    bar.innerHTML = `
      <button id="pp-eb-claude" class="pp-eb-claude">${AI_SVG.sparkle}<span>Ask Claude</span></button>
      <button id="pp-eb-remove" class="pp-eb-remove">Remove</button>
      <div class="pp-eb-grow"></div>
      <button id="pp-eb-cancel" class="pp-eb-cancel">Cancel</button>
      <button id="pp-eb-save" class="pp-eb-save">Save</button>`;
    return bar;
  }

  function positionBar(bar, el) {
    const r = el.getBoundingClientRect();
    const bw = bar.offsetWidth || 260, bh = bar.offsetHeight || 40;
    let top = r.bottom + scrollY + 8;
    if (r.bottom + bh + 12 > innerHeight) top = r.top + scrollY - bh - 8; // flip above
    let left = Math.min(Math.max(8, r.left + scrollX), scrollX + innerWidth - bw - 8);
    bar.style.top = top + 'px';
    bar.style.left = left + 'px';
  }

  // ─────────────────────────────────────────────────────────── ASK CLAUDE ────
  // "Send to Claude Code": collect the element + a prompt + optional images, hand
  // it to the local bridge (through the service worker), and apply the returned
  // patch behind an Accept / Reject preview. Nothing the bridge returns is executed
  // as code — patches are declarative (text / css / remove) and CSS is sanitised.

  const AI_SVG = {
    sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>',
    close:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    image:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5L5 20"/></svg>',
    send:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l16-8-6 16-3-6-7-2z"/></svg>',
  };

  const aiPending = new Map();  // requestId -> { el, selector, panel }
  let aiSeq = 0;

  function computedSubset(el) {
    let cs; try { cs = getComputedStyle(el); } catch (_) { return {}; }
    const keys = ['color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontFamily', 'lineHeight',
      'padding', 'margin', 'borderRadius', 'display', 'textAlign', 'width', 'height'];
    const out = {};
    keys.forEach(k => { if (cs[k]) out[k] = cs[k]; });
    return out;
  }

  // Keep CSS declarations from escaping the `selector { … }` block or the <style> tag.
  function sanitizeCSS(decls) {
    return String(decls || '')
      .replace(/[<>{}]/g, '')
      .replace(/javascript:/gi, '')
      .replace(/expression\s*\(/gi, '')
      .slice(0, 2000);
  }

  function doAI(el) {
    deactivatePicker();
    const selector = getSelector(el);
    const requestId = 'req_' + Date.now().toString(36) + '_' + (aiSeq++);
    el.setAttribute('data-pp-ai-target', '1');

    const panel = buildAIPanel();
    aiPending.set(requestId, { el, selector, panel });

    panel.onSend(async (prompt, images) => {
      panel.setStatus('waiting', 'Sending to Claude Code…');
      const request = {
        id: requestId, url: location.href, title: document.title, selector,
        text: (el.textContent || '').trim().slice(0, 4000),
        outerHTML: el.outerHTML.slice(0, 20000),
        styles: computedSubset(el), prompt, images,
      };
      let res;
      try { res = await chrome.runtime.sendMessage({ type: 'ai-edit-request', request }); }
      catch (e) { res = { ok: false, error: String(e) }; }
      if (!res || !res.ok) { panel.setStatus('error', bridgeErrorMessage(res)); return; }
      panel.setStatus('waiting', 'Claude Code is working on it…');
    });

    panel.onClose(() => { el.removeAttribute('data-pp-ai-target'); aiPending.delete(requestId); });
  }

  function bridgeErrorMessage(res) {
    const st = res && res.state;
    if (st === 'disconnected') return 'Claude Code isn’t connected. Open PagePatch settings to pair it.';
    if (st === 'error') return 'Couldn’t reach the bridge — is it running in Claude Code?';
    return (res && res.error) || 'Something went wrong.';
  }

  // Apply a patch from Claude as a live preview with an Accept / Reject decision.
  function onAIApply(requestId, patch) {
    const pend = aiPending.get(requestId);
    if (!pend) return;
    const preview = previewPatch(pend.el, pend.selector, patch);
    if (!preview) { pend.panel.setStatus('error', 'Claude sent a change PagePatch can’t apply yet.'); return; }
    pend.panel.showDecision(preview.describe, () => {
      preview.commit();
      pend.el.removeAttribute('data-pp-ai-target');
      pend.panel.close();
      aiPending.delete(requestId);
      toast('Applied by Claude — saved permanently');
    }, () => {
      preview.revert();
      pend.panel.setStatus('compose', '');
    });
  }

  function onAIReject(requestId, reason) {
    const pend = aiPending.get(requestId);
    if (pend) pend.panel.setStatus('error', reason ? ('Claude: ' + reason) : 'Claude declined this edit.');
  }

  // Returns { describe, revert, commit } for a declarative patch, or null.
  function previewPatch(el, selector, patch) {
    const kind = patch && patch.kind;
    if (kind === 'text') {
      const original = getElementText(el);
      const value = String(patch.value || '');
      setElementText(el, value);
      return {
        describe: 'Change text to “' + value.slice(0, 60) + '”',
        revert: () => setElementText(el, original),
        commit: () => {
          const existing = rules.find(r => r.action === 'text' && r.selector === selector);
          if (existing) { existing.value = value; existing.disabled = false; }
          else rules.push({ id: genId(), action: 'text', selector, value, original, label: original.trim().slice(0, 40) || value.slice(0, 40), source: 'claude', createdAt: Date.now() });
          appliedText.set(selector, existing ? (existing.original ?? original) : original);
          el.setAttribute('data-pp-text', value);
          saveRules().then(() => reconcile(true));
        },
      };
    }
    if (kind === 'css') {
      const value = sanitizeCSS(patch.value);
      let temp = document.createElement('style');
      temp.id = 'pp-ai-preview';
      temp.textContent = `${selector}{${value}}`;
      (document.head || document.documentElement).appendChild(temp);
      return {
        describe: 'Restyle: ' + value.slice(0, 70),
        revert: () => temp.remove(),
        commit: () => {
          temp.remove();
          const existing = rules.find(r => r.action === 'style' && r.selector === selector);
          if (existing) { existing.value = value; existing.disabled = false; }
          else rules.push({ id: genId(), action: 'style', selector, value, label: labelFor(el), source: 'claude', createdAt: Date.now() });
          saveRules().then(() => reconcile(true));
        },
      };
    }
    if (kind === 'remove') {
      el.style.setProperty('display', 'none', 'important');
      return {
        describe: 'Remove this element',
        revert: () => el.style.removeProperty('display'),
        commit: () => {
          el.style.removeProperty('display');
          if (!rules.some(r => r.action === 'hide' && r.selector === selector))
            rules.push({ id: genId(), action: 'hide', selector, label: labelFor(el), source: 'claude', createdAt: Date.now() });
          saveRules().then(() => reconcile(true));
        },
      };
    }
    return null;
  }

  // The floating compose / status / decision panel.
  function buildAIPanel() {
    const images = [];
    let onSendCb = () => {}, onCloseCb = () => {};

    const root = document.createElement('div');
    root.id = 'pp-ai';
    root.className = 'pp-glass';
    root.innerHTML = `
      <div class="pp-ai-head">
        <span class="pp-ai-badge">${AI_SVG.sparkle}</span>
        <span class="pp-ai-title">Ask Claude to edit this</span>
        <button class="pp-ai-x" title="Close">${AI_SVG.close}</button>
      </div>
      <div class="pp-ai-body">
        <textarea class="pp-ai-input" rows="2" placeholder="Describe the change — e.g. “make this a bold blue heading” or “rewrite as one punchy line”"></textarea>
        <div class="pp-ai-thumbs"></div>
      </div>
      <div class="pp-ai-foot">
        <button class="pp-ai-attach" title="Add image (or paste / drop)">${AI_SVG.image}<span>Image</span></button>
        <div class="pp-ai-grow"></div>
        <span class="pp-ai-status"></span>
        <button class="pp-ai-send">${AI_SVG.send}<span>Send</span></button>
      </div>
      <input type="file" accept="image/*" class="pp-ai-file" hidden multiple>`;
    document.documentElement.appendChild(root);

    const input = root.querySelector('.pp-ai-input');
    const thumbs = root.querySelector('.pp-ai-thumbs');
    const statusEl = root.querySelector('.pp-ai-status');
    const sendBtn = root.querySelector('.pp-ai-send');
    const fileInput = root.querySelector('.pp-ai-file');
    const foot = root.querySelector('.pp-ai-foot');

    function close() { root.remove(); document.removeEventListener('keydown', onKey, true); onCloseCb(); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }
    document.addEventListener('keydown', onKey, true);
    root.querySelector('.pp-ai-x').addEventListener('click', close);

    function renderThumbs() {
      thumbs.innerHTML = '';
      images.forEach((im, i) => {
        const t = document.createElement('div');
        t.className = 'pp-ai-thumb';
        t.innerHTML = `<img src="${im.dataUrl}" alt=""><button data-i="${i}" title="Remove">${AI_SVG.close}</button>`;
        t.querySelector('button').addEventListener('click', () => { images.splice(i, 1); renderThumbs(); });
        thumbs.appendChild(t);
      });
      thumbs.style.display = images.length ? 'flex' : 'none';
    }
    function addFile(file) {
      if (!file || !/^image\//.test(file.type) || images.length >= 6) return;
      const rd = new FileReader();
      rd.onload = () => { images.push({ name: file.name || 'image', dataUrl: String(rd.result) }); renderThumbs(); };
      rd.readAsDataURL(file);
    }
    root.querySelector('.pp-ai-attach').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { Array.from(fileInput.files).forEach(addFile); fileInput.value = ''; });
    input.addEventListener('paste', (e) => {
      for (const it of (e.clipboardData?.items || [])) if (it.type.startsWith('image/')) addFile(it.getAsFile());
    });
    root.addEventListener('dragover', (e) => { e.preventDefault(); root.classList.add('pp-ai-drop'); });
    root.addEventListener('dragleave', () => root.classList.remove('pp-ai-drop'));
    root.addEventListener('drop', (e) => { e.preventDefault(); root.classList.remove('pp-ai-drop'); Array.from(e.dataTransfer.files || []).forEach(addFile); });

    function send() {
      const prompt = input.value.trim();
      if (!prompt && !images.length) { input.focus(); return; }
      onSendCb(prompt, images.slice());
    }
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });

    setTimeout(() => input.focus(), 30);
    renderThumbs();

    const api = {
      onSend: (cb) => { onSendCb = cb; },
      onClose: (cb) => { onCloseCb = cb; },
      close,
      setStatus(kind, text) {
        root.setAttribute('data-state', kind);
        statusEl.textContent = text || '';
        statusEl.className = 'pp-ai-status' + (kind === 'error' ? ' err' : kind === 'waiting' ? ' wait' : '');
        // restore compose footer if we left a decision
        const dec = root.querySelector('.pp-ai-decision');
        if (dec && kind === 'compose') { dec.remove(); foot.style.display = ''; input.disabled = false; }
        if (kind === 'waiting') { sendBtn.disabled = true; input.disabled = true; }
        if (kind === 'compose' || kind === 'error') { sendBtn.disabled = false; input.disabled = false; }
      },
      showDecision(describe, onAccept, onReject) {
        foot.style.display = 'none';
        const dec = document.createElement('div');
        dec.className = 'pp-ai-decision';
        dec.innerHTML = `
          <div class="pp-ai-dtext"><span class="pp-ai-badge sm">${AI_SVG.sparkle}</span>${escapeHTML(describe)}</div>
          <div class="pp-ai-dbtns">
            <button class="pp-ai-reject">Discard</button>
            <button class="pp-ai-accept">Keep it</button>
          </div>`;
        root.appendChild(dec);
        dec.querySelector('.pp-ai-accept').addEventListener('click', onAccept);
        dec.querySelector('.pp-ai-reject').addEventListener('click', onReject);
      },
    };
    return api;
  }

  function escapeHTML(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ─────────────────────────────────────────────────────────────── TOAST ────

  let toastTimer = null;
  function toast(msg) {
    document.getElementById('pp-toast')?.remove();
    const t = document.createElement('div');
    t.id = 'pp-toast';
    t.className = 'pp-glass';
    t.textContent = msg;
    document.documentElement.appendChild(t);
    requestAnimationFrame(() => t.classList.add('pp-toast-show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove('pp-toast-show');
      setTimeout(() => t.remove(), 250);
    }, 2600);
  }

  // ──────────────────────────────────────────────────────────── MESSAGES ────

  function persistAnd(reply, extra) {
    saveRules()
      .then(() => { reconcile(true); reply({ ok: true, ...(extra || {}) }); })
      .catch(err => { console.warn('PagePatch: save failed', err); try { reply({ ok: false }); } catch (_) {} });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg.type) {
      case 'activate-picker':
        activatePicker(msg.mode);
        reply?.({ ok: true });
        break;

      case 'get-rules':                       // legacy
        reply(rules);
        break;

      case 'get-state':
        reply({ rules, paused, host: HOST });
        break;

      case 'delete-rule': {
        const i = msg.id != null ? rules.findIndex(r => r.id === msg.id) : msg.index;
        if (i != null && i >= 0 && rules[i]) { rules.splice(i, 1); persistAnd(reply); return true; }
        reply({ ok: false });
        break;
      }

      case 'toggle-rule': {
        const r = rules.find(x => x.id === msg.id);
        if (r) { r.disabled = !r.disabled; persistAnd(reply, { disabled: r.disabled }); return true; }
        reply({ ok: false });
        break;
      }

      case 'set-note': {
        const r = rules.find(x => x.id === msg.id);
        if (r) { r.note = String(msg.note || '').slice(0, 200); persistAnd(reply); return true; }
        reply({ ok: false });
        break;
      }

      case 'undo-last': {
        if (rules.length) { const removed = rules.pop(); saveRules().then(() => { reconcile(true); reply({ ok: true, removed }); }); return true; }
        reply({ ok: false });
        break;
      }

      case 'set-paused':
        paused = !!msg.paused;
        savePaused().then(() => { reconcile(true); reply({ ok: true, paused }); });
        return true;

      case 'add-rules': {
        const incoming = Array.isArray(msg.rules) ? msg.rules : [];
        let added = 0;
        incoming.forEach(r => {
          if (!r || !['hide', 'text', 'style'].includes(r.action) || typeof r.selector !== 'string') return;
          if (rules.some(x => x.action === r.action && x.selector === r.selector && (x.value || '') === (r.value || ''))) return;
          rules.push({ id: genId(), action: r.action, selector: r.selector, value: r.value, label: r.label, source: r.source || 'preset', createdAt: Date.now() });
          added++;
        });
        if (added) { persistAnd(reply, { added }); return true; }
        reply({ ok: true, added: 0 });
        break;
      }

      case 'clear-rules':
        rules = [];
        persistAnd(reply);
        return true;

      case 'ai-apply':
        onAIApply(msg.requestId, msg.patch);
        break;

      case 'ai-reject':
        onAIReject(msg.requestId, msg.reason);
        break;

      case 'ping':
        reply({ ok: true, count: rules.filter(r => !r.disabled).length, paused });
        break;
    }
    return true;
  });
})();
