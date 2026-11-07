// plus2-quick.js — edição de tema DENTRO do chat (v0.90.0).
//  • estilo das mensagens (balão vidro/neon/contorno..., cantos, animação de entrada)
//  • ajustes rápidos pessoais por cima de qualquer tema (cores, fundo, fonte) — ficam só no seu navegador
//  • comandos digitados no chat:  /tema   /tema natal   /tema cor #ff0000   /tema editar ...
//  • mini-editor flutuante aberto pelo botão de paleta ao lado da caixa de mensagem
(function (global) {
  'use strict';
  const doc = document;
  const KEY = 'pv2_quick_v1';
  const BUBBLES = { default: 'Padrão do tema', glass: 'Vidro', solid: 'Sólido', outline: 'Contorno', neon: 'Neon', round: 'Redondo' };
  const ENTRIES = { none: 'Nenhuma', pop: 'Pulinho', slide: 'Deslizar', glow: 'Brilho' };
  const SCENES = { none: 'Nenhum', aurora: 'Aurora', grid: 'Grade neon', waves: 'Ondas', stars: 'Estrelas', embers: 'Brasas', matrix: 'Matrix', petals: 'Pétalas', snow: 'Neve', confetti: 'Confete', fireworks: 'Fogos', hearts: 'Corações', balloons: 'Balões', easter: 'Ovos' };
  const FONTS = { '': 'Padrão', modern: 'Moderna', tech: 'Tech', retro: 'Retrô', elegant: 'Elegante', soft: 'Suave' };
  const FRAMES = { none: 'Sem moldura', line: 'Fina', neon: 'Neon', gold: 'Dourada', glass: 'Vidro' };
  const BTNS = { default: 'Padrão do tema', gradient: 'Degradê', bevel: 'Relevo', flat: 'Chato' };
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const STAGE = !!global.__PV2_STAGE;
  let access = false, ov = {}, panel = null;

  function load() { if (STAGE) return; try { ov = JSON.parse(global.localStorage.getItem(KEY) || '{}') || {}; } catch (_) { ov = {}; }
    if (!ov._t && Object.keys(ov).length) ov = {}; /* v0.92: ajustes antigos (sem tema dono) eram a causa do preview diferente do aplicado */ }
  function save() { if (STAGE) return; try { global.localStorage.setItem(KEY, JSON.stringify(ov)); } catch (_) { /* sem storage */ } }
  load();
  const has = () => Object.keys(ov).filter((k) => k !== '_t').length > 0;

  // ---------- merge: aplica por cima do tema atual ----------
  function merge(theme) {
    if (!theme) return theme;
    const t = Object.assign({}, theme);
    const own = theme.fx && theme.fx.chatStyle ? theme.fx.chatStyle : null;
    t.chatStyle = own;
    if (STAGE || !access || !has()) return t;
    // v0.92.0: ajustes pessoais ficam presos ao tema em que foram feitos —
    // antes vazavam para QUALQUER tema escolhido depois (preview ≠ aplicado).
    if (ov._t && ov._t !== (theme.key || theme.id)) return t;
    t.extras = {};
    ['glow', 'cardR', 'frame', 'btnStyle', 'sceneO'].forEach((k) => { if (ov[k] !== undefined && ov[k] !== '') t.extras[k] = ov[k]; });
    t.colors = Object.assign({}, theme.colors);
    ['primary', 'secondary', 'highlight'].forEach((k) => { if (HEX.test(ov[k] || '')) t.colors[k] = ov[k]; });
    if (ov.scene) t.scene = ov.scene;
    if (ov.font !== undefined && ov.font !== null) t.font = ov.font;
    const cs = Object.assign({}, own || {});
    ['bubble', 'entry', 'radius', 'own', 'other'].forEach((k) => { if (ov[k] !== undefined && ov[k] !== '') cs[k] = ov[k]; });
    t.chatStyle = Object.keys(cs).length ? cs : null;
    return t;
  }

  // ---------- v0.92.0: personalização extra (brilho, cantos, moldura, botões, fundo) ----------
  function applyExtras(x) {
    const b = doc.body, root = doc.documentElement; if (!b) return;
    Array.from(b.classList).forEach((c) => { if (c.indexOf('pv2-x-') === 0 || c.indexOf('pv2-frame-') === 0 || c.indexOf('pv2-btn-') === 0) b.classList.remove(c); });
    ['--pv2-glow', '--pv2-card-r', '--pv2-scene-o'].forEach((v) => root.style.removeProperty(v));
    if (!x) return;
    if (x.glow !== undefined) { root.style.setProperty('--pv2-glow', String(Math.max(0, Math.min(100, +x.glow)) / 100)); b.classList.add('pv2-x-glow'); }
    if (x.cardR !== undefined) { root.style.setProperty('--pv2-card-r', Math.max(0, Math.min(28, +x.cardR)) + 'px'); b.classList.add('pv2-x-cr'); }
    if (x.sceneO !== undefined) { root.style.setProperty('--pv2-scene-o', String(Math.max(5, Math.min(100, +x.sceneO)) / 100)); b.classList.add('pv2-x-so'); }
    if (x.frame && x.frame !== 'none') b.classList.add('pv2-frame-' + x.frame);
    if (x.btnStyle && x.btnStyle !== 'default') b.classList.add('pv2-btn-' + x.btnStyle);
  }

  // ---------- estilo das mensagens ----------
  function applyChat(theme) {
    const b = doc.body; if (!b) return;
    Array.from(b.classList).forEach((c) => { if (c.indexOf('pv2-cs-') === 0) b.classList.remove(c); });
    const root = doc.documentElement;
    ['--pv2-cs-r', '--pv2-cs-own', '--pv2-cs-other'].forEach((v) => root.style.removeProperty(v));
    applyExtras(theme && theme.extras);
    const cs = theme && theme.chatStyle;
    if (!cs) return;
    const bubble = BUBBLES[cs.bubble] ? cs.bubble : 'default';
    if (bubble === 'default' && (!cs.entry || cs.entry === 'none') && cs.radius === undefined && !cs.own && !cs.other) return;
    b.classList.add('pv2-cs-on', 'pv2-cs-' + bubble);
    if (cs.entry && cs.entry !== 'none') b.classList.add('pv2-cs-in-' + cs.entry);
    if (cs.radius !== undefined && cs.radius !== '') root.style.setProperty('--pv2-cs-r', Math.max(0, Math.min(28, +cs.radius)) + 'px');
    if (HEX.test(cs.own || '')) root.style.setProperty('--pv2-cs-own', cs.own);
    if (HEX.test(cs.other || '')) root.style.setProperty('--pv2-cs-other', cs.other);
  }

  // ---------- reaplicar ----------
  function reapply() { const l = global.PlusV2Live; if (l && l.reapply) l.reapply(); }
  function setOv(patch) {
    const b = cur(); ov._t = b.key || b.id || ov._t;
    Object.keys(patch).forEach((k) => { if (patch[k] === null || patch[k] === undefined) delete ov[k]; else ov[k] = patch[k]; });
    save(); reapply(); syncPanel();
  }

  // ---------- avisos locais no chat ----------
  function notice(text) {
    const box = doc.getElementById('messages');
    if (box) {
      const el = doc.createElement('div');
      el.className = 'pv2-local-notice';
      text.split('\n').forEach((ln, i) => { if (i) el.appendChild(doc.createElement('br')); el.appendChild(doc.createTextNode(ln)); });
      box.appendChild(el); box.scrollTop = box.scrollHeight;
      setTimeout(() => el.classList.add('old'), 20000);
    } else if (global.alert) global.alert(text);
  }
  const HELP = [
    'Comandos de tema (só no seu site):',
    '/tema lista — ver temas disponíveis',
    '/tema natal — aplicar um tema pelo nome',
    '/tema editar — abrir o mini-editor',
    '/tema cor #ff0066 (cor2, cor3 = outras cores)',
    '/tema fundo neve · /tema balao neon · /tema entrada pop · /tema fonte tech',
    '/tema moldura neon|dourada|vidro|fina|sem · /tema botao degrade|relevo|chato',
    '/tema mascote on|off · /tema reset',
  ].join('\n');
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const pickKey = (map, word) => { const w = norm(word); return Object.keys(map).find((k) => norm(k) === w || norm(map[k]) === w || (w.length > 2 && norm(map[k]).indexOf(w) === 0)); };

  async function catalog() {
    const r = await global.fetch('/api/plus2/catalog', { credentials: 'include' });
    if (!r.ok) throw new Error('Não consegui carregar os temas');
    return r.json();
  }
  async function applyByName(name) {
    const data = await catalog();
    const all = (data.themes || []).concat(data.myCustomThemes || []);
    const w = norm(name);
    const t = all.find((x) => norm(x.key) === w || norm(x.name) === w) || all.find((x) => norm(x.name).indexOf(w) >= 0 || norm(x.key || '').indexOf(w) >= 0);
    if (!t) return notice('Não achei o tema "' + name + '". Use /tema lista.');
    if (t.locked) return notice(t.comingSoon ? 'O tema ' + t.name + ' ainda não foi lançado.' : 'O tema ' + t.name + ' é exclusivo do NEXTGAME PLUS.');
    const r = await global.fetch('/api/plus2/me', { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ themeId: t.id }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); return notice(j.error || 'Não deu para aplicar o tema.'); }
    if (global.PlusV2Live) await global.PlusV2Live.refresh(global.fetch.bind(global));
    notice('Tema aplicado: ' + t.name);
  }

  // retorna true se o texto era um comando (e então NÃO é enviado ao chat)
  function handleCommand(text) {
    const m = /^\/tema(?:\s+(.*))?$/i.exec(String(text || '').trim());
    if (!m) return false;
    const args = (m[1] || '').trim(), parts = args.split(/\s+/), cmd = norm(parts[0]), rest = parts.slice(1).join(' ');
    (async () => {
      try {
        if (!args || cmd === 'ajuda' || cmd === 'help') return notice(HELP);
        if (cmd === 'lista' || cmd === 'temas') {
          const d = await catalog();
          return notice('Temas: ' + (d.themes || []).filter((t) => !t.locked).map((t) => t.name).join(', ') + '\nUse /tema nome');
        }
        if (cmd === 'editar' || cmd === 'editor') return openPanel();
        // a partir daqui são ajustes personalizados → exigem PLUS/admin
        const needsAccess = ['moldura', 'botao', 'reset', 'cor', 'cor1', 'cor2', 'cor3', 'fundo', 'balao', 'entrada', 'fonte'].indexOf(cmd) >= 0;
        if (needsAccess && !access) return notice('Editar o tema é exclusivo do NEXTGAME PLUS.');
        if (cmd === 'reset') { ov = {}; save(); reapply(); syncPanel(); return notice('Ajustes removidos. Tema original de volta.'); }
        if (cmd === 'cor' || cmd === 'cor1' || cmd === 'cor2' || cmd === 'cor3') {
          let hex = rest.trim(); if (/^[0-9a-f]{6}$/i.test(hex)) hex = '#' + hex;
          if (!HEX.test(hex)) return notice('Use uma cor assim: /tema cor #ff0066');
          setOv({ [{ cor: 'primary', cor1: 'primary', cor2: 'secondary', cor3: 'highlight' }[cmd]]: hex }); return notice('Cor alterada.');
        }
        if (cmd === 'fundo') { const k = pickKey(SCENES, rest); if (!k) return notice('Fundos: ' + Object.values(SCENES).join(', ')); setOv({ scene: k }); return notice('Fundo: ' + SCENES[k]); }
        if (cmd === 'balao') { const k = pickKey(BUBBLES, rest); if (!k) return notice('Balões: ' + Object.values(BUBBLES).join(', ')); setOv({ bubble: k }); return notice('Balão: ' + BUBBLES[k]); }
        if (cmd === 'entrada') { const k = pickKey(ENTRIES, rest); if (!k) return notice('Entradas: ' + Object.values(ENTRIES).join(', ')); setOv({ entry: k }); return notice('Entrada: ' + ENTRIES[k]); }
        if (cmd === 'fonte') { const k = pickKey(FONTS, rest); if (k === undefined) return notice('Fontes: ' + Object.values(FONTS).join(', ')); setOv({ font: k }); return notice('Fonte: ' + FONTS[k]); }
        if (cmd === 'moldura') { const k = pickKey(FRAMES, rest) || ({ sem: 'none', dourada: 'gold' })[norm(rest)]; if (!k) return notice('Molduras: ' + Object.values(FRAMES).join(', ')); setOv({ frame: k }); return notice('Moldura: ' + FRAMES[k]); }
        if (cmd === 'botao') { const k = pickKey(BTNS, rest) || ({ degrade: 'gradient' })[norm(rest)]; if (!k) return notice('Botões: ' + Object.values(BTNS).join(', ')); setOv({ btnStyle: k }); return notice('Botões: ' + BTNS[k]); }
        if (cmd === 'mascote') {
          const on = /^(on|ligar|sim|1)$/i.test(rest);
          if (global.PlusV2Live && global.PlusV2Live.setPrefs) global.PlusV2Live.setPrefs({ mascot: on, decor: on });
          return notice('Mascote e decoração ' + (on ? 'ligados.' : 'desligados.'));
        }
        await applyByName(args);
      } catch (err) { notice(err && err.message ? err.message : 'Erro no comando.'); }
    })();
    return true;
  }

  // ---------- mini-editor ----------
  const cur = () => (global.PlusV2LiveBaseTheme || {});
  const eff = () => merge(cur());
  function field(label, inner) { return '<label class="pq-f"><span>' + label + '</span>' + inner + '</label>'; }
  const optHtml = (map, v) => Object.keys(map).map((k) => '<option value="' + k + '"' + (k === v ? ' selected' : '') + '>' + map[k] + '</option>').join('');
  function buildPanel() {
    if (panel) return;
    panel = doc.createElement('div'); panel.id = 'pv2-quick'; panel.className = 'pv2-quick';
    panel.innerHTML =
      '<div class="pq-head"><b>Editar tema</b><button type="button" class="pq-x" data-a="close" aria-label="Fechar">×</button></div>' +
      '<div class="pq-note">Vale só para você, por cima do tema atual.</div>' +
      '<div class="pq-body">' +
        '<div class="pq-colors">' + field('Cor 1', '<input type="color" data-k="primary">') + field('Cor 2', '<input type="color" data-k="secondary">') + field('Cor 3', '<input type="color" data-k="highlight">') + '</div>' +
        field('Fundo animado', '<select data-k="scene">' + optHtml(SCENES, '') + '</select>') +
        field('Fonte', '<select data-k="font">' + optHtml(FONTS, '') + '</select>') +
        '<div class="pq-sep">Mensagens</div>' +
        field('Balão', '<select data-k="bubble">' + optHtml(BUBBLES, '') + '</select>') +
        field('Entrada', '<select data-k="entry">' + optHtml(ENTRIES, '') + '</select>') +
        field('Cantos', '<input type="range" min="0" max="28" data-k="radius">') +
        '<div class="pq-colors">' + field('Minha msg', '<input type="color" data-k="own">') + field('Dos outros', '<input type="color" data-k="other">') + '</div>' +
        '<div class="pq-sep">Visual geral</div>' +
        field('Brilho dos botões', '<input type="range" min="0" max="100" data-k="glow">') +
        field('Cantos dos cartões', '<input type="range" min="0" max="28" data-k="cardR">') +
        field('Força do fundo animado', '<input type="range" min="5" max="100" data-k="sceneO">') +
        field('Moldura da tela', '<select data-k="frame">' + optHtml(FRAMES, 'none') + '</select>') +
        field('Estilo dos botões', '<select data-k="btnStyle">' + optHtml(BTNS, 'default') + '</select>') +
        '<label class="pq-chk"><input type="checkbox" data-k="mascot"> Mascote, decoração e figurinhas</label>' +
      '</div>' +
      '<div class="pq-foot"><button type="button" data-a="reset">Voltar ao original</button><button type="button" data-a="saveas" class="pri">Salvar como meu tema</button></div>' +
      '<div class="pq-hint">Dica: digite /tema no chat para ver os comandos.</div>';
    doc.body.appendChild(panel);
    panel.addEventListener('input', (e) => {
      const k = e.target.dataset && e.target.dataset.k; if (!k) return;
      if (!access) { notice('Editar o tema é exclusivo do NEXTGAME PLUS.'); syncPanel(); return; }
      if (k === 'mascot') { if (global.PlusV2Live && global.PlusV2Live.setPrefs) global.PlusV2Live.setPrefs({ mascot: e.target.checked, decor: e.target.checked, scene: true }); return; }
      let v = e.target.value; if (k === 'radius' || k === 'glow' || k === 'cardR' || k === 'sceneO') v = +v;
      setOv({ [k]: v });
    });
    panel.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]'); if (!a) return;
      if (a.dataset.a === 'close') closePanel();
      else if (a.dataset.a === 'reset') { ov = {}; save(); reapply(); syncPanel(); }
      else if (a.dataset.a === 'saveas') {
        const t = eff(); if (!t || !t.colors) return;
        const name = global.prompt('Nome do seu tema:', (cur().name || 'Meu tema') + ' (meu)'); if (!name) return;
        const body = { name, primary: t.colors.primary, secondary: t.colors.secondary, highlight: t.colors.highlight, text: t.colors.text, button: t.colors.button, darkMode: true, effect: t.effect || 'none', font: t.font || '', scene: t.scene || 'none' };
        const r = await global.fetch('/api/plus2/themes/custom', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        notice(r.ok ? 'Tema salvo em "Meus temas": ' + name : (j.error || 'Não consegui salvar.'));
      }
    });
  }
  function syncPanel() {
    if (!panel) return;
    const t = eff(), cs = (t && t.chatStyle) || {}, c = (t && t.colors) || {};
    const set = (k, v) => { const el = panel.querySelector('[data-k="' + k + '"]'); if (el && doc.activeElement !== el) el.value = v; };
    set('primary', c.primary || '#5b6cff'); set('secondary', c.secondary || '#8b5cf6'); set('highlight', c.highlight || '#22d3ee');
    set('scene', (t && t.scene) || 'none'); set('font', (t && t.font) || '');
    set('bubble', cs.bubble || 'default'); set('entry', cs.entry || 'none'); set('radius', cs.radius !== undefined ? cs.radius : 12);
    set('own', HEX.test(cs.own || '') ? cs.own : (c.primary || '#5b6cff')); set('other', HEX.test(cs.other || '') ? cs.other : '#2b2d31');
    const ex = (t && t.extras) || {};
    set('glow', ex.glow !== undefined ? ex.glow : 60); set('cardR', ex.cardR !== undefined ? ex.cardR : 12); set('sceneO', ex.sceneO !== undefined ? ex.sceneO : 100);
    set('frame', ex.frame || 'none'); set('btnStyle', ex.btnStyle || 'default');
    const m = panel.querySelector('[data-k="mascot"]'); const p = global.PlusV2Live && global.PlusV2Live.prefs ? global.PlusV2Live.prefs() : {};
    if (m) m.checked = p.mascot !== false;
  }
  function openPanel() { buildPanel(); panel.classList.add('open'); syncPanel(); }
  function closePanel() { if (panel) panel.classList.remove('open'); }

  global.PlusV2Quick = {
    merge, applyChat, handleCommand, openPanel, closePanel, notice,
    setAccess: (v) => { access = !!v; reapply(); },
    toggle: () => { if (panel && panel.classList.contains('open')) closePanel(); else openPanel(); },
    overlay: () => Object.assign({}, ov),
  };
})(typeof window !== 'undefined' ? window : globalThis);
