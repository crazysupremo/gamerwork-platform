/*! NextGameThemes SDK v1 — aplique temas do NEXT GAME em qualquer site/jogo.
 *
 *   <script src="https://nextgameblue.stream/sdk/nextgame-themes.js"></script>
 *   <script>NextGameThemes.apply('natal')</script>
 *
 * Define variáveis CSS no <html>:  --ng-primary --ng-secondary --ng-highlight
 * --ng-text --ng-button --ng-bg --ng-panel (+ versões -rgb) e a classe
 * "ng-theme-<chave>". Com { effects: true } também carrega fundo animado,
 * decoração e mascote de data (precisa de um <body>).
 *
 *   NextGameThemes.list()            -> Promise<Tema[]>
 *   NextGameThemes.get(key)          -> Promise<Tema>
 *   NextGameThemes.apply(key|tema, { effects, font })  -> Promise<Tema>
 *   NextGameThemes.remove()          -> remove tudo
 */
(function (global) {
  'use strict';
  var cur = document.currentScript;
  var BASE = global.NEXTGAME_BASE || (cur && cur.src ? new URL(cur.src).origin : 'https://nextgameblue.stream');
  var FONTS = {
    modern: 'Inter:wght@400;600;800', tech: 'Rajdhani:wght@500;700', retro: 'Press+Start+2P',
    elegant: 'Playfair+Display:wght@500;700', soft: 'Nunito:wght@500;800',
  };
  var FAMILY = { modern: 'Inter', tech: 'Rajdhani', retro: '"Press Start 2P"', elegant: '"Playfair Display"', soft: 'Nunito' };
  var applied = null, fxLoaded = null;

  function json(path) {
    return fetch(BASE + '/api/plus2/public' + path).then(function (r) {
      if (!r.ok) throw new Error('NextGameThemes: HTTP ' + r.status);
      return r.json();
    });
  }
  function rgb(hex) { var n = parseInt(hex.slice(1), 16); return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255); }
  function surfaces(hex) {
    var n = parseInt(hex.slice(1), 16), r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), h = 0;
    if (mx !== mn) { var d = mx - mn; h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
    var S = h >= 15 && h <= 55 ? 12 : 28;
    function toHex(L) {
      var s = S / 100, l = L / 100, a = s * Math.min(l, 1 - l);
      function f(k) { var kk = (k + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(kk - 3, Math.min(9 - kk, 1))))).toString(16).padStart(2, '0'); }
      return '#' + f(0) + f(8) + f(4);
    }
    return { bg: toHex(9), panel: toHex(14) };
  }
  function loadFont(key) {
    if (!FONTS[key]) return;
    var id = 'ng-font-' + key;
    if (document.getElementById(id)) return;
    var l = document.createElement('link'); l.id = id; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=' + FONTS[key] + '&display=swap';
    document.head.appendChild(l);
  }
  function loadScript(src) {
    return new Promise(function (ok, fail) {
      var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = function () { fail(new Error('Falha ao carregar ' + src)); };
      document.head.appendChild(s);
    });
  }
  function loadEffects() {
    if (fxLoaded) return fxLoaded;
    var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = BASE + '/plus2.css'; document.head.appendChild(l);
    global.__PV2_STAGE = true; // não grava preferências no site do parceiro
    fxLoaded = loadScript(BASE + '/plus2-live.js').then(function () { return loadScript(BASE + '/plus2-mascot.js'); });
    return fxLoaded;
  }
  function clearVars() {
    var el = document.documentElement;
    ['primary', 'secondary', 'highlight', 'text', 'button', 'bg', 'panel'].forEach(function (k) { el.style.removeProperty('--ng-' + k); el.style.removeProperty('--ng-' + k + '-rgb'); });
    el.style.removeProperty('--ng-font');
    if (applied) el.classList.remove('ng-theme-' + applied);
  }

  var API = {
    base: BASE,
    list: function () { return json('/themes').then(function (j) { return j.themes; }); },
    get: function (key) { return json('/themes/' + encodeURIComponent(key)); },
    apply: function (themeOrKey, opts) {
      opts = opts || {};
      var p = typeof themeOrKey === 'string' ? API.get(themeOrKey) : Promise.resolve(themeOrKey);
      return p.then(function (t) {
        var el = document.documentElement, c = t.colors, s = surfaces(c.primary);
        clearVars();
        var vars = { primary: c.primary, secondary: c.secondary, highlight: c.highlight, text: c.text, button: c.button, bg: s.bg, panel: s.panel };
        Object.keys(vars).forEach(function (k) { el.style.setProperty('--ng-' + k, vars[k]); el.style.setProperty('--ng-' + k + '-rgb', rgb(vars[k])); });
        el.classList.add('ng-theme-' + t.key);
        if (opts.font !== false && t.font && FONTS[t.font]) { loadFont(t.font); el.style.setProperty('--ng-font', FAMILY[t.font] + ', system-ui, sans-serif'); }
        applied = t.key;
        if (!opts.effects) return t;
        return loadEffects().then(function () {
          global.PlusV2Live.previewTheme({ key: t.key, name: t.name, colors: c, darkMode: true, effect: t.effect, font: t.font, scene: t.scene, decor: t.decor, suggestedEffects: [] });
          return t;
        });
      });
    },
    remove: function () {
      clearVars(); applied = null;
      if (global.PlusV2Live && global.PlusV2Live.cancelPreview) global.PlusV2Live.cancelPreview();
    },
  };
  global.NextGameThemes = API;
})(window);
