// temas.js — Estúdio de Temas (v0.88.0). Página só para admin com 2FA.
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const CATS = { essenciais: 'Essenciais', datas: 'Datas', gamer: 'Gamer', espaco: 'Espaço', luxo: 'Luxo', natureza: 'Natureza', sazonal: 'Estações', parceiros: 'Parceiros' };
  const FONTS = { '': 'Padrão do site', modern: 'Moderna', tech: 'Tech', retro: 'Retrô', elegant: 'Elegante', soft: 'Suave' };
  const SCENES = { none: 'Nenhuma', aurora: 'Aurora', grid: 'Grade neon', waves: 'Ondas', stars: 'Estrelas', embers: 'Brasas', matrix: 'Matrix', petals: 'Pétalas', snow: 'Neve', confetti: 'Confete', fireworks: 'Fogos', hearts: 'Corações', balloons: 'Balões', easter: 'Ovos' };
  const DECORS = { '': 'Nenhuma', natal: 'Natal', 'ano-novo': 'Ano Novo', carnaval: 'Carnaval', pascoa: 'Páscoa', namorados: 'Namorados', criancas: 'Dia das Crianças' };
  const EFFECTS = { none: 'Nenhum', shine: 'Brilho', glow: 'Glow', pulse: 'Pulso' };
  const SITE_FX = { particles: 'Partículas', buttonGlow: 'Brilho nos botões', animatedGradients: 'Gradientes animados', messageReceive: 'Mensagem recebida', callJoin: 'Entrada em call', avatarGlow: 'Brilho no avatar', transitions: 'Transições' };
  const COLORS = [['primary', 'Principal'], ['secondary', 'Secundária'], ['highlight', 'Destaque'], ['text', 'Texto'], ['button', 'Botão']];
  const PRESETS = [
    ['#5b6cff', '#8b5cf6', '#22d3ee', '#eef0ff', '#12142b'], ['#ff2e93', '#b44bff', '#ffd54a', '#fff0f8', '#220a1a'],
    ['#00e5a0', '#00b3ff', '#c6ff4a', '#eafff6', '#07201a'], ['#ff6b35', '#ff3d6e', '#ffc24a', '#fff4ec', '#25110a'],
    ['#94a3b8', '#475569', '#7dd3fc', '#f1f5f9', '#0b0f16'], ['#d4af37', '#8a6d1f', '#fff1b8', '#fff8e1', '#1a1405'],
  ];

  let themes = [], sel = null, draft = null, isNew = false, filterCat = '', dirty = false;
  const stage = $('#stage');
  let stageReady = false;

  function toast(msg) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }
  async function api(path, method, body) {
    const r = await fetch('/api/plus2' + path, { method: method || 'GET', credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Erro ' + r.status);
    return j;
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const opts = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${esc(k)}"${k === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');

  // ---------- cores / contraste (mesma matemática do deriveSurfaces do site) ----------
  const hex2rgb = (h) => { const n = parseInt(h.slice(1), 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; };
  function rgb2h(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0;
    if (mx !== mn) { const d = mx - mn; h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
    return h;
  }
  function hsl2hex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
    return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  function surfaces(primary) {
    const c = hex2rgb(primary), h = rgb2h(c.r, c.g, c.b), S = h >= 15 && h <= 55 ? 12 : 28;
    return { app: hsl2hex(h, S, 9), panel: hsl2hex(h, S, 14), modal: hsl2hex(h, S, 18) };
  }
  const lum = (hex) => { const c = hex2rgb(hex); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const okHex = (v) => /^#[0-9a-fA-F]{6}$/.test(v);

  function audit(t) {
    const s = surfaces(t.primary);
    const rows = [
      ['Texto sobre o fundo do app', ratio(t.text, s.app), 4.5],
      ['Texto sobre os painéis', ratio(t.text, s.panel), 4.5],
      ['Texto sobre modais', ratio(t.text, s.modal), 4.5],
      ['Destaque sobre os painéis', ratio(t.highlight, s.panel), 3],
      ['Principal sobre os painéis', ratio(t.primary, s.panel), 3],
    ];
    return rows.map(([n, r, min]) => `<div><span>${n}</span><b class="${r >= min ? 'ok' : r >= min - 1 ? 'warn' : 'bad'}">${r.toFixed(1)}:1 ${r >= min ? '✓' : '⚠ mín. ' + min}</b></div>`).join('');
  }

  // ---------- modelo ----------
  function blank() {
    return { id: null, key: '', name: 'Novo tema', tagline: '', category: 'essenciais', primary: '#5b6cff', secondary: '#8b5cf6', highlight: '#22d3ee', text: '#eef0ff', button: '#12142b', darkMode: true, effect: 'glow', premium: false, published: false, releaseAt: null, suggestedEffects: [], font: 'modern', scene: 'aurora', decor: '', sortOrder: themes.length ? Math.max.apply(null, themes.map((t) => t.sortOrder || 0)) + 1 : 1 };
  }
  function toStageTheme(t) {
    return { key: t.key, name: t.name, colors: { primary: t.primary, secondary: t.secondary, highlight: t.highlight, text: t.text, button: t.button }, darkMode: true, effect: t.effect, font: t.font, scene: t.scene, decor: t.decor || '', suggestedEffects: t.suggestedEffects || [] };
  }
  function pushStage(extra) {
    if (!stageReady || !draft || !okHexAll(draft)) return;
    stage.contentWindow.postMessage(Object.assign({ type: 'pv2-stage', theme: toStageTheme(draft), name: 'Admin' }, extra || {}), location.origin);
  }
  const okHexAll = (t) => COLORS.every(([k]) => okHex(t[k]));
  let pushT = 0;
  const pushSoon = () => { clearTimeout(pushT); pushT = setTimeout(pushStage, 60); };

  // ---------- lista ----------
  function status(t) {
    if (t.published === false) return '<span class="tag draft">rascunho</span>';
    if (t.releaseAt && new Date(t.releaseAt) > new Date()) return '<span class="tag sched">agendado</span>';
    return '';
  }
  function renderCats() {
    const counts = {}; themes.forEach((t) => { counts[t.category] = (counts[t.category] || 0) + 1; });
    $('#cats').innerHTML = `<button class="chip${filterCat ? '' : ' on'}" data-c="">Todos ${themes.length}</button>` + Object.entries(CATS).filter(([k]) => counts[k]).map(([k, v]) => `<button class="chip${filterCat === k ? ' on' : ''}" data-c="${k}">${v} ${counts[k]}</button>`).join('');
  }
  function renderList() {
    const q = $('#q').value.trim().toLowerCase();
    const items = themes.filter((t) => (!filterCat || t.category === filterCat) && (!q || (t.name + ' ' + t.key + ' ' + (t.tagline || '')).toLowerCase().includes(q)));
    $('#list').innerHTML = items.map((t) => `<div class="item${sel && sel.id === t.id && !isNew ? ' sel' : ''}" data-id="${esc(t.id)}"><div class="sw"><i style="background:${t.primary}"></i><i style="background:${t.secondary}"></i><i style="background:${t.highlight}"></i></div><div class="nm"><b>${esc(t.name)}</b><small>${esc(t.key || '—')} · ${esc(CATS[t.category] || t.category)}</small></div>${status(t)}${t.premium ? '<span class="tag">PLUS</span>' : ''}</div>`).join('') || '<div class="note" style="padding:14px">Nenhum tema.</div>';
    renderCats();
  }

  // ---------- editor ----------
  function select(t, creating) {
    sel = t; isNew = !!creating; draft = JSON.parse(JSON.stringify(t)); dirty = false;
    renderEditor(); renderList(); pushStage();
  }
  function renderEditor() {
    const t = draft;
    $('#tab-basic').innerHTML = `
      <div class="row2"><label class="f">Nome<input type="text" id="f-name" maxlength="40" value="${esc(t.name)}"></label>
      <label class="f">Chave (slug)<input type="text" id="f-key" maxlength="32" value="${esc(t.key)}" ${isNew ? '' : 'disabled'} placeholder="ex: meu-tema"></label></div>
      <label class="f">Frase curta<input type="text" id="f-tagline" maxlength="60" value="${esc(t.tagline)}"></label>
      <label class="f">Categoria<select id="f-category">${opts(CATS, t.category)}</select></label>
      <div class="presets">${PRESETS.map((p, i) => `<button data-p="${i}" title="Paleta ${i + 1}">${p.slice(0, 3).map((c) => `<i style="background:${c}"></i>`).join('')}</button>`).join('')}<button id="btn-rand">Sortear</button></div>
      ${COLORS.map(([k, n]) => `<div class="crow"><span>${n}</span><input type="color" data-c="${k}" value="${okHex(t[k]) ? t[k] : '#000000'}"><input type="text" data-h="${k}" value="${esc(t[k])}" maxlength="7"></div>`).join('')}
      <div class="audit" id="audit"></div>`;
    $('#tab-fx').innerHTML = `
      <div class="row2"><label class="f">Fonte<select id="f-font">${opts(FONTS, t.font)}</select></label>
      <label class="f">Efeito do card<select id="f-effect">${opts(EFFECTS, t.effect)}</select></label></div>
      <label class="f">Fundo animado<select id="f-scene">${opts(SCENES, t.scene)}</select></label>
      <label class="f">Decoração + mascote de data<select id="f-decor">${opts(DECORS, t.decor)}</select></label>
      <div class="note">Decoração liga o mascote da data (Natal, Ano Novo, Carnaval, Páscoa, Namorados, Crianças).</div>
      <div class="f">Efeitos sugeridos (ligam ao escolher o tema)</div>
      ${Object.entries(SITE_FX).map(([k, v]) => `<label class="switch"><input type="checkbox" data-fx="${k}"${(t.suggestedEffects || []).includes(k) ? ' checked' : ''}> ${v}</label>`).join('')}`;
    const rel = t.releaseAt ? new Date(t.releaseAt) : null;
    const loc = rel ? new Date(rel.getTime() - rel.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
    $('#tab-pub').innerHTML = `
      <label class="switch"><input type="checkbox" id="f-published"${t.published !== false ? ' checked' : ''}> Publicado (aparece na galeria e na API pública)</label>
      <label class="switch"><input type="checkbox" id="f-premium"${t.premium ? ' checked' : ''}> Exclusivo PLUS</label>
      <label class="f">Liberar automaticamente em<input type="datetime-local" id="f-release" value="${loc}"></label>
      <div class="note">Vazio = disponível já. Rascunhos nunca aparecem para usuários nem parceiros.</div>
      <div class="f">Agenda de lançamentos</div>
      <div class="audit">${themes.filter((x) => x.releaseAt).sort((a, b) => new Date(a.releaseAt) - new Date(b.releaseAt)).map((x) => `<div><span>${esc(x.name)}</span><b>${new Date(x.releaseAt).toLocaleDateString('pt-BR')}</b></div>`).join('') || '<span class="note">Nenhum agendamento.</span>'}</div>`;
    const k = t.key || 'meu-tema';
    $('#tab-api').innerHTML = `
      <div class="f">Aplicar este tema em um site parceiro</div>
      <pre class="code">&lt;script src="${location.origin}/sdk/nextgame-themes.js"&gt;&lt;/script&gt;
&lt;script&gt;NextGameThemes.apply('${esc(k)}')&lt;/script&gt;</pre>
      <button id="btn-copy-snip">Copiar código</button>
      <div class="f">Com fundo animado, decoração e mascote</div>
      <pre class="code">NextGameThemes.apply('${esc(k)}', { effects: true })</pre>
      <div class="f">API pública (somente leitura)</div>
      <pre class="code">${location.origin}/api/plus2/public/themes
${location.origin}/api/plus2/public/themes/${esc(k)}</pre>
      <div class="note">Só temas publicados e já liberados aparecem na API.</div>`;
    refreshAudit();
  }
  function refreshAudit() { const a = $('#audit'); if (a && okHexAll(draft)) a.innerHTML = audit(draft); }
  function mark() { dirty = true; pushSoon(); }

  function bind() {
    const ed = $('#editor-col');
    ed.addEventListener('input', (e) => {
      const el = e.target, d = draft; if (!d) return;
      if (el.id === 'f-name') d.name = el.value;
      else if (el.id === 'f-key') d.key = el.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32);
      else if (el.id === 'f-tagline') d.tagline = el.value;
      else if (el.id === 'f-category') d.category = el.value;
      else if (el.id === 'f-font') d.font = el.value;
      else if (el.id === 'f-effect') d.effect = el.value;
      else if (el.id === 'f-scene') d.scene = el.value;
      else if (el.id === 'f-decor') d.decor = el.value;
      else if (el.id === 'f-published') d.published = el.checked;
      else if (el.id === 'f-premium') d.premium = el.checked;
      else if (el.id === 'f-release') d.releaseAt = el.value ? new Date(el.value).toISOString() : null;
      else if (el.dataset.fx) { const s = new Set(d.suggestedEffects || []); el.checked ? s.add(el.dataset.fx) : s.delete(el.dataset.fx); d.suggestedEffects = Array.from(s); }
      else if (el.dataset.c) { d[el.dataset.c] = el.value; const h = $(`[data-h="${el.dataset.c}"]`); if (h) h.value = el.value; refreshAudit(); }
      else if (el.dataset.h) { let v = el.value.trim(); if (v && v[0] !== '#') v = '#' + v; if (okHex(v)) { d[el.dataset.h] = v; const c = $(`[data-c="${el.dataset.h}"]`); if (c) c.value = v; refreshAudit(); } else return; }
      else return;
      mark();
    });
    ed.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || !draft) return;
      if (b.dataset.p !== undefined) { const p = PRESETS[+b.dataset.p]; COLORS.forEach(([k], i) => { draft[k] = p[i]; }); renderEditor(); mark(); }
      else if (b.id === 'btn-rand') {
        const h = Math.floor(Math.random() * 360);
        draft.primary = hsl2hex(h, 85, 60); draft.secondary = hsl2hex((h + 40) % 360, 80, 55); draft.highlight = hsl2hex((h + 170) % 360, 90, 65);
        draft.text = hsl2hex(h, 60, 96); draft.button = hsl2hex(h, 45, 10); renderEditor(); mark();
      } else if (b.id === 'btn-copy-snip') { navigator.clipboard.writeText($('#tab-api .code').textContent).then(() => toast('Código copiado')); }
    });
    $('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
      ['basic', 'fx', 'pub', 'api'].forEach((n) => $('#tab-' + n).classList.toggle('hidden', n !== b.dataset.tab));
    });
    $('#list').addEventListener('click', (e) => {
      const it = e.target.closest('.item'); if (!it) return;
      if (dirty && !confirm('Descartar alterações não salvas?')) return;
      select(themes.find((t) => t.id === it.dataset.id));
    });
    $('#cats').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { filterCat = b.dataset.c; renderList(); } });
    $('#q').addEventListener('input', renderList);
    $('#btn-new').onclick = () => { if (dirty && !confirm('Descartar alterações não salvas?')) return; select(blank(), true); };
    $('#btn-save').onclick = save;
    $('#btn-dup').onclick = () => {
      const c = JSON.parse(JSON.stringify(draft)); c.id = null; c.name += ' (cópia)'; c.published = false;
      let k = (draft.key || 'tema') + '-copia', n = 2; const keys = new Set(themes.map((t) => t.key));
      let base = k; while (keys.has(k)) k = base + '-' + n++;
      c.key = k; select(c, true); dirty = true; toast('Cópia criada — ajuste e salve');
    };
    $('#btn-del').onclick = async () => {
      if (isNew || !draft.id) return toast('Tema ainda não foi salvo');
      if (!confirm('Excluir "' + draft.name + '"? Quem usa volta ao tema padrão.')) return;
      try { await api('/admin/themes/' + draft.id, 'DELETE'); toast('Excluído'); await load(); } catch (err) { toast(err.message); }
    };
    $('#btn-exp').onclick = () => download('tema-' + (draft.key || 'novo') + '.json', { nextgameTheme: 1, theme: exportable(draft) });
    $('#btn-export-all').onclick = () => download('temas-nextgame.json', { nextgameThemes: 1, themes: themes.map(exportable) });
    $('#btn-import').onclick = () => $('#file-in').click();
    $('#file-in').onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        const list = j.themes || (j.theme ? [j.theme] : []);
        if (!list.length) throw new Error('Arquivo sem temas');
        let n = 0;
        for (const t of list) {
          const keys = new Set(themes.map((x) => x.key)); let k = (t.key || 'importado').toLowerCase().replace(/[^a-z0-9-]/g, '-'), base = k, i = 2;
          while (keys.has(k)) k = base + '-' + i++;
          const body = Object.assign(blank(), t, { id: null, key: k, published: false });
          if (!COLORS.every(([c]) => okHex(body[c]))) continue;
          await api('/admin/themes', 'POST', body); n++;
        }
        toast(n + ' tema(s) importado(s) como rascunho'); await load();
      } catch (err) { toast('Importação falhou: ' + err.message); }
    };
    $$('.pbar [data-dev]').forEach((b) => b.onclick = () => {
      $$('.pbar [data-dev]').forEach((x) => x.classList.toggle('on', x === b));
      $('#frame').className = 'frame ' + b.dataset.dev;
    });
    $('#btn-summon').onclick = () => pushStage({ summon: true });
    $('#btn-fullscreen').onclick = () => { if ($('#frame').requestFullscreen) $('#frame').requestFullscreen(); };
    window.addEventListener('message', (e) => { if (e.origin === location.origin && e.data && e.data.type === 'pv2-stage-ready') { stageReady = true; pushStage(); } });
    window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  }
  function exportable(t) {
    const o = {}; ['key', 'name', 'tagline', 'category', 'primary', 'secondary', 'highlight', 'text', 'button', 'darkMode', 'effect', 'premium', 'releaseAt', 'suggestedEffects', 'font', 'scene', 'decor'].forEach((k) => { o[k] = t[k]; });
    return o;
  }
  function download(name, obj) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  async function save() {
    const d = draft;
    if (!d.name.trim()) return toast('Dê um nome ao tema');
    if (!okHexAll(d)) return toast('Há uma cor inválida');
    if (isNew && !/^[a-z0-9][a-z0-9-]{1,31}$/.test(d.key || '')) return toast('Chave inválida: use letras minúsculas, números e hífen');
    if (isNew && themes.some((t) => t.key === d.key)) return toast('Essa chave já existe');
    const body = { name: d.name, tagline: d.tagline, category: d.category, primary: d.primary, secondary: d.secondary, highlight: d.highlight, text: d.text, button: d.button, darkMode: true, effect: d.effect, premium: !!d.premium, releaseAt: d.releaseAt || null, suggestedEffects: d.suggestedEffects || [], font: d.font, scene: d.scene, decor: d.decor || '', published: d.published !== false, sortOrder: d.sortOrder || 0 };
    try {
      $('#btn-save').disabled = true;
      if (isNew) { body.key = d.key; await api('/admin/themes', 'POST', body); } else { await api('/admin/themes/' + d.id, 'PATCH', body); }
      toast('Salvo!'); dirty = false;
      const keep = d.key; await load(keep);
    } catch (err) { toast(err.message); } finally { $('#btn-save').disabled = false; }
  }

  async function load(selectKey) {
    const j = await api('/admin/all');
    themes = (j.themes || []).filter((t) => t.key !== undefined);
    renderList();
    const next = (selectKey && themes.find((t) => t.key === selectKey)) || themes[0];
    if (next) select(next); else select(blank(), true);
  }

  async function init() {
    const g = $('#guard');
    const r = await fetch('/api/me', { credentials: 'include' });
    if (!r.ok) { g.textContent = 'Você precisa estar logado.'; return; }
    const me = await r.json();
    if (!me.is_admin) { g.textContent = 'Acesso restrito a administradores.'; return; }
    if (!me.totp_enabled) { g.textContent = 'Ative a verificação em duas etapas (2FA) para usar o Estúdio.'; return; }
    g.classList.add('hidden'); $('#studio').classList.remove('hidden');
    bind();
    try { await load(); } catch (err) { g.classList.remove('hidden'); g.textContent = 'Erro ao carregar: ' + err.message; }
  }
  init();
})();
