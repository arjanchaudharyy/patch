// Applies the saved appearance (theme + accent) before first paint, so the
// popup and dashboard never flash the wrong theme. Loaded in <head> as an
// external file because MV3's default CSP blocks inline <script>.
// Kept tiny and dependency-free; popup.js / options.js wire up the controls.
(function () {
  try {
    var theme = localStorage.getItem('pp_theme') || 'auto';
    var accent = localStorage.getItem('pp_accent') || 'blue';
    var resolved = theme === 'auto'
      ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : theme;
    var root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    root.setAttribute('data-accent', accent);
  } catch (e) {}
})();
