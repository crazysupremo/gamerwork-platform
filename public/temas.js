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

  // ============ v0.89.0 — CRIADOR DE EFEITOS (figurinhas, emojis, moldura, bichinhos, mascote) ============
  const EMOJI_GROUPS = {
    'Festa': '🎉🎊🎈🎆🎇🧨🪅🎁🥳🍾🥂🎂🪩🎶',
    'Natal / Inverno': '🎄🎅🤶⛄❄️🦌🔔🕯️🧦🍪🐧🧣⭐🌟',
    'Terror': '🎃👻🦇🕷️🕸️💀☠️🧛🧟🪦🔮🌙',
    'Amor': '❤️💖💘💝🌹💐🌸💌🧸😍💋🥰',
    'Bichos': '🐶🐱🦊🐻🐼🐸🐵🦁🐯🐰🐥🦄🐉🦖🐙🦈',
    'Gamer': '🎮🕹️👾🤖⚔️🛡️🏆💎🔥⚡💥🚀🎯👑🧙',
    'Esporte': '⚽🏀🏈🎾🏐🥊🏎️🥇🥅🏁',
    'Comida': '🍕🍔🌽🍿🍩🍫🍓🍉🥕🍺🥤🍰',
    'Natureza': '🌈☀️🌊🌴🍀🌻🍂🍁🌵🦋🐝🌺',
    'Fogo / Gelo': '🔥💥✨🌋☄️💫🧊❄️💧🌪️⚡🌟',
  };
  const FX_FRAMES = { none: 'Sem moldura', fire: 'Fogo em volta da tela', neon: 'Neon pulsante', ice: 'Gelo', sparkle: 'Estrelinhas brilhando', glow: 'Brilho suave' };
  const FX_RECIPES = [
    { n: 'Halloween com fogo', c: { primary: '#ff7a1a', secondary: '#7a2cff', highlight: '#ffd24a', text: '#fff3e6', button: '#1a0d08' }, scene: 'embers', cat: 'datas', fx: { items: '🎃👻🦇🕷️', fall: ['fall', 22, 30], frame: 'fire', crit: ['fight', 4, '👻🎃'], mascot: ['🎃', 'Abóbora', 'Buuu, {nome}!|Cuidado com o fogo!|Doce ou travessura?'] } },
    { n: 'Festa Junina', c: { primary: '#ffb300', secondary: '#e53935', highlight: '#7cb342', text: '#fff8e1', button: '#2a1405' }, scene: 'confetti', cat: 'datas', fx: { items: '🌽🎈🔥🪅🎆', fall: ['float', 20, 30], garland: 30, frame: 'sparkle', mascot: ['🌽', 'Caipira', 'Arraiá do {nome}!|Bora dançar quadrilha!|Pé de moleque!'] } },
    { n: 'Copa / Futebol', c: { primary: '#00c853', secondary: '#ffd600', highlight: '#2979ff', text: '#f1fff4', button: '#07200f' }, scene: 'confetti', cat: 'datas', fx: { items: '⚽🏆🥅🎉', fall: ['fall', 16, 28], frame: 'neon', crit: ['walk', 3, '⚽'], mascot: ['🏆', 'Craque', 'Gooool, {nome}!|Joga bola?|Bora pro título!'] } },
    { n: 'Dia das Mães', c: { primary: '#ff6fa5', secondary: '#c77dff', highlight: '#ffd6a5', text: '#fff0f6', button: '#2a0d1c' }, scene: 'petals', cat: 'datas', fx: { items: '🌸💐❤️🌷', fall: ['rise', 18, 30], garland: 28, frame: 'sparkle', mascot: ['💐', 'Florzinha', 'Feliz Dia das Mães!|Ligou pra sua mãe?|Com carinho, {nome}!'] } },
    { n: 'Black Friday', c: { primary: '#ffd600', secondary: '#ff1744', highlight: '#00e5ff', text: '#fffde7', button: '#0d0d0d' }, scene: 'grid', cat: 'datas', fx: { items: '💸🛒🔥⚡', fall: ['fall', 24, 26], frame: 'neon', mascot: ['🛒', 'Ofertinha', 'Tudo 80% off!|Corre, {nome}!|Só hoje!'] } },
    { n: 'Réveillon na praia', c: { primary: '#38bdf8', secondary: '#f59e0b', highlight: '#fde047', text: '#f0f9ff', button: '#04162b' }, scene: 'fireworks', cat: 'datas', fx: { items: '🎆🥂🍾✨', fall: ['rise', 18, 30], frame: 'sparkle', mascot: ['🥂', 'Brinde', 'Feliz Ano Novo, {nome}!|Tim-tim!|Que venha o novo ano!'] } },
    { n: 'Dragões vs Cavaleiros', c: { primary: '#ef4444', secondary: '#6366f1', highlight: '#fbbf24', text: '#fef2f2', button: '#14080a' }, scene: 'embers', cat: 'gamer', fx: { items: '🐉⚔️🛡️🔥', fall: ['float', 10, 26], frame: 'fire', crit: ['fight', 4, '🐉⚔️'], mascot: ['🐉', 'Dragão', 'Rooooar, {nome}!|Prepare sua espada!|Quem vence?'] } },
    { n: 'Reino do Gelo', c: { primary: '#7dd3fc', secondary: '#a78bfa', highlight: '#e0f2fe', text: '#f0f9ff', button: '#07162a' }, scene: 'snow', cat: 'sazonal', fx: { items: '❄️🐧⛄🧊', fall: ['fall', 28, 28], frame: 'ice', crit: ['walk', 3, '🐧⛄'], mascot: ['🐧', 'Pingu', 'Brrr, {nome}!|Escorrega comigo!|Que friozinho!'] } },
  ];

  function fxDefault() {
    return { items: [], fall: { on: false, mode: 'fall', count: 24, size: 28, speed: 1 }, garland: { on: false, size: 30 }, frame: { type: 'none', color: '', power: 1 }, critters: { on: false, mode: 'walk', count: 4, size: 44, items: [] }, mascot: { on: false, item: 0, name: '', lines: [] }, chat: { burst: true }, chatStyle: { bubble: 'default', entry: 'none', radius: 14, own: '', other: '' }, tsp: { preset: '', color: '' }, googleFont: '' };
  }
  function ensureFx(t) {
    const d = fxDefault(), f = t.fx || {};
    t.fx = { items: f.items || [], fall: Object.assign(d.fall, f.fall), garland: Object.assign(d.garland, f.garland), frame: Object.assign(d.frame, f.frame), critters: Object.assign(d.critters, f.critters), mascot: Object.assign(d.mascot, f.mascot), chat: Object.assign(d.chat, f.chat), chatStyle: Object.assign(d.chatStyle, f.chatStyle), tsp: Object.assign(d.tsp, f.tsp), googleFont: f.googleFont || '' };
    return t.fx;
  }
  function itemThumb(it, px) {
    return it.t === 'emoji' ? `<span style="font-size:${px}px;line-height:1">${esc(it.v)}</span>` : `<img src="${esc(it.v)}" width="${px}" height="${px}" style="object-fit:contain" referrerpolicy="no-referrer" alt="">`;
  }
  const emojiList = (s) => ((typeof Intl !== 'undefined' && Intl.Segmenter) ? Array.from(new Intl.Segmenter('pt', { granularity: 'grapheme' }).segment(s), (x) => x.segment) : Array.from(s));
  function fxSize() { return JSON.stringify(draft.fx || {}).length; }

  function renderFx2() {
    const f = ensureFx(draft), kb = Math.round(fxSize() / 1024);
    const n = f.items.length;
    const card = (title, body) => `<section class="card"><h4>${title}</h4>${body}</section>`;
    const tog = (id, on, label) => `<label class="toggle"><input type="checkbox" id="${id}"${on ? ' checked' : ''}> ${label}</label>`;
    const sl = (id, lbl, v, lo, hi, st) => `<div class="rng"><span>${lbl}</span><input type="range" id="${id}" min="${lo}" max="${hi}" step="${st || 1}" value="${v}"><b id="${id}-v">${v}</b></div>`;
    $('#tab-fx2').innerHTML =
      card('Receitas prontas', `<div class="sub">Preenche cores e efeitos de uma vez. Depois é só ajustar.</div>
        <div class="chips">${FX_RECIPES.map((r, i) => `<button class="chip" data-recipe="${i}">${esc(r.n)}</button>`).join('')}</div>`) +
      card(`Figurinhas (${n}/14) · ${kb} KB de 400`, `
        <div class="itemgrid">${f.items.map((it, i) => `<div class="itm" title="Clique para remover" data-rm="${i}">${itemThumb(it, 28)}<small>${i + 1}</small></div>`).join('') || '<span class="sub">Nenhuma ainda. Use uma receita, a biblioteca de emojis ou envie imagens.</span>'}</div>
        <div class="addrow"><input type="text" id="fx-emoji-in" placeholder="Digite ou cole emojis"><button id="fx-emoji-add">Adicionar</button></div>
        <div class="addrow"><input type="text" id="fx-url-in" placeholder="Link de imagem https://…"><button id="fx-url-add">Baixar</button></div>
        <button id="fx-file-btn">Enviar imagens do computador</button>
        <input type="file" id="fx-file" accept="image/*" multiple class="hidden">
        <div class="sub">Também dá para colar (Ctrl+V) uma imagem nesta aba. As imagens são reduzidas e salvas dentro do tema.</div>
        <details><summary class="sub" style="cursor:pointer;color:#aab1ff">Biblioteca de emojis</summary>
          ${Object.entries(EMOJI_GROUPS).map(([g, s]) => `<div class="sub" style="margin:8px 0 3px">${g}</div><div class="emo">${emojiList(s).map((e) => `<button data-emo="${esc(e)}">${e}</button>`).join('')}</div>`).join('')}
        </details>`) +
      card('Motor tsParticles (open source)', `
        <label class="f">Efeito<select id="fx-tsp">${opts({ '': 'Desligado', fire: 'Fogo subindo do rodapé', snow: 'Neve', stars: 'Estrelas piscando', fireflies: 'Vagalumes', bubbles: 'Bolhas', links: 'Rede de pontos conectados', confetti: 'Confete' }, f.tsp.preset)}</select></label>
        <div class="crow"><span>Cor</span><input type="color" id="fx-tsp-c" value="${f.tsp.color || '#5b6cff'}"><button id="fx-tsp-auto">Usar cor do tema</button></div>
        <div class="sub">Motor tsParticles (MIT, github.com/tsparticles). Reage ao mouse: as partículas fogem do cursor e o clique cria mais. Carrega da internet quando o tema é usado.</div>`) +
      card('Chuva de figurinhas', `${tog('fx-fall-on', f.fall.on, 'Ligar')}
        <label class="f">Movimento<select id="fx-fall-mode">${opts({ fall: 'Caindo', rise: 'Subindo (balões)', float: 'Flutuando' }, f.fall.mode)}</select></label>
        ${sl('fx-fall-count', 'Quantidade', f.fall.count, 3, 80)}${sl('fx-fall-size', 'Tamanho', f.fall.size, 12, 64)}${sl('fx-fall-speed', 'Velocidade', f.fall.speed, 0.3, 3, 0.1)}`) +
      card('Varal no topo', `${tog('fx-gar-on', f.garland.on, 'Ligar')}${sl('fx-gar-size', 'Tamanho', f.garland.size, 18, 56)}`) +
      card('Moldura em volta da tela', `
        <label class="f">Tipo<select id="fx-frame">${opts(FX_FRAMES, f.frame.type)}</select></label>
        <div class="crow"><span>Cor</span><input type="color" id="fx-frame-c" value="${f.frame.color || '#ff7a1a'}"><button id="fx-frame-auto">Usar cor do tema</button></div>
        ${sl('fx-frame-p', 'Intensidade', f.frame.power, 0.3, 2, 0.1)}`) +
      card('Bichinhos no rodapé', `${tog('fx-cr-on', f.critters.on, 'Ligar')}
        <label class="f">Comportamento<select id="fx-cr-mode">${opts({ walk: 'Passeando', fight: 'Brigando em duplas' }, f.critters.mode)}</select></label>
        ${sl('fx-cr-count', 'Quantidade', f.critters.count, 1, 8)}${sl('fx-cr-size', 'Tamanho', f.critters.size, 24, 80)}
        <div class="sub">Quem participa? Clique nas figurinhas (nenhuma marcada = todas):</div>
        <div class="itemgrid">${f.items.map((it, i) => `<div class="itm${f.critters.items.includes(i) ? ' on' : ''}" data-cr="${i}">${itemThumb(it, 24)}</div>`).join('') || '<span class="sub">Adicione figurinhas primeiro.</span>'}</div>`) +
      card('Mascote próprio', `${tog('fx-ma-on', f.mascot.on, 'Ligar (fica no canto, fala e pula ao clicar)')}
        <div class="row2"><label class="f">Figurinha nº<input type="text" id="fx-ma-item" value="${f.mascot.item + 1}"></label><label class="f">Nome<input type="text" id="fx-ma-name" maxlength="24" value="${esc(f.mascot.name)}"></label></div>
        <label class="f">Falas (uma por linha, {nome} vira o nome da pessoa)<textarea id="fx-ma-lines" rows="4">${esc(f.mascot.lines.join('\n'))}</textarea></label>`) +
      card('Mensagens do chat', `
        <div class="row2"><label class="f">Balão<select id="fx-cs-bubble">${opts({ default: 'Padrão do tema', glass: 'Vidro', solid: 'Sólido', outline: 'Contorno', neon: 'Neon', round: 'Redondo' }, f.chatStyle.bubble)}</select></label>
        <label class="f">Animação de entrada<select id="fx-cs-entry">${opts({ none: 'Nenhuma', pop: 'Pulinho', slide: 'Deslizar', glow: 'Brilho' }, f.chatStyle.entry)}</select></label></div>
        ${sl('fx-cs-radius', 'Cantos', f.chatStyle.radius, 0, 28)}
        <div class="row2"><div class="crow" style="grid-template-columns:70px 38px 1fr"><span>Minha msg</span><input type="color" id="fx-cs-own" value="${f.chatStyle.own || '#5b6cff'}"><button id="fx-cs-own-x">auto</button></div>
        <div class="crow" style="grid-template-columns:70px 38px 1fr"><span>Dos outros</span><input type="color" id="fx-cs-other" value="${f.chatStyle.other || '#2b2d31'}"><button id="fx-cs-other-x">auto</button></div></div>
        <div class="sub">Cada usuário ainda pode ajustar por cima, no chat, com o botão de paleta ou /tema.</div>`) +
      card('Extras', `${tog('fx-chat', f.chat.burst, 'Reagir às mensagens do chat')}
        <label class="f">Fonte do Google Fonts (ex: Bangers, Pacifico, Orbitron)<input type="text" id="fx-font" maxlength="40" value="${esc(f.googleFont)}"></label>
        <button id="fx-clear" class="dan">Limpar todos os efeitos</button>`);
  }

  function fxChanged(rerender) { dirty = true; if (rerender) renderFx2(); pushSoon(); }

  function addFxItem(it) {
    const f = ensureFx(draft);
    if (f.items.length >= 14) return toast('Máximo de 14 figurinhas');
    if (f.items.some((x) => x.v === it.v)) return;
    f.items.push(it);
  }
  function addEmojis(str) {
    emojiList(str).filter((e) => e.trim() && /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/u.test(e)).forEach((e) => addFxItem({ t: 'emoji', v: e }));
    fxChanged(true);
  }
  function shrinkImage(img) {
    for (const max of [96, 72, 56]) {
      const r = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)), w = Math.max(1, Math.round(img.naturalWidth * r)), h = Math.max(1, Math.round(img.naturalHeight * r));
      const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h);
      let d = c.toDataURL('image/webp', 0.85); if (d.indexOf('image/webp') < 0) d = c.toDataURL('image/png');
      if (d.length <= 80000) return d;
    }
    return null;
  }
  function loadImage(src, cors) {
    return new Promise((ok, bad) => { const im = new Image(); if (cors) im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = () => bad(new Error('img')); im.src = src; });
  }
  async function addImageFile(file) {
    try {
      const url = URL.createObjectURL(file); const im = await loadImage(url); const d = shrinkImage(im); URL.revokeObjectURL(url);
      if (!d) return toast('Imagem complexa demais, tente outra');
      addFxItem({ t: 'img', v: d });
    } catch (_) { toast('Não consegui ler essa imagem'); }
  }
  async function addImageUrl(url) {
    if (!/^https:\/\//i.test(url)) return toast('Use um link https://');
    try {
      const im = await loadImage(url, true); const d = shrinkImage(im);
      if (d) addFxItem({ t: 'img', v: d }); else return toast('Imagem complexa demais');
    } catch (_) {
      // site da imagem não permite copiar — guarda só o link (a imagem continua vindo de lá)
      try { await loadImage(url, false); addFxItem({ t: 'img', v: url }); toast('Esse site não deixa copiar a imagem: guardei o link (depende do site continuar no ar). Prefira baixar e enviar o arquivo.'); }
      catch (_) { return toast('Não consegui abrir esse link de imagem'); }
    }
    fxChanged(true);
  }
  function applyRecipe(r) {
    const d = draft; Object.assign(d, r.c); d.scene = r.scene; d.category = r.cat; d.decor = ''; d.effect = 'glow';
    if (!d.tagline) d.tagline = r.n;
    const f = fxDefault(); f.items = emojiList(r.fx.items).map((e) => ({ t: 'emoji', v: e }));
    if (r.fx.fall) f.fall = { on: true, mode: r.fx.fall[0], count: r.fx.fall[1], size: r.fx.fall[2], speed: 1 };
    if (r.fx.garland) f.garland = { on: true, size: r.fx.garland };
    if (r.fx.frame) f.frame = { type: r.fx.frame, color: '', power: 1 };
    if (r.fx.crit) { const pool = emojiList(r.fx.crit[2]); f.critters = { on: true, mode: r.fx.crit[0], count: r.fx.crit[1], size: 44, items: pool.map((e) => f.items.findIndex((x) => x.v === e)).filter((i) => i >= 0) }; }
    if (r.fx.mascot) { const ix = f.items.findIndex((x) => x.v === r.fx.mascot[0]); f.mascot = { on: true, item: Math.max(0, ix), name: r.fx.mascot[1], lines: r.fx.mascot[2].split('|') }; }
    d.fx = f; renderEditor(); mark(); toast('Receita aplicada: ' + r.n);
  }

  function bindFx() {
    const root = $('#tab-fx2');
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button,[data-rm],[data-cr]'); if (!b) return;
      const f = ensureFx(draft);
      if (b.dataset.recipe !== undefined) return applyRecipe(FX_RECIPES[+b.dataset.recipe]);
      if (b.dataset.emo) { addFxItem({ t: 'emoji', v: b.dataset.emo }); return fxChanged(true); }
      if (b.dataset.rm !== undefined) {
        const i = +b.dataset.rm; f.items.splice(i, 1);
        const fix = (a) => a.filter((x) => x !== i).map((x) => (x > i ? x - 1 : x));
        f.critters.items = fix(f.critters.items);
        if (f.mascot.item >= f.items.length) f.mascot.item = Math.max(0, f.items.length - 1);
        return fxChanged(true);
      }
      if (b.dataset.cr !== undefined) { const i = +b.dataset.cr, a = f.critters.items; const k = a.indexOf(i); k >= 0 ? a.splice(k, 1) : a.push(i); return fxChanged(true); }
      if (b.id === 'fx-emoji-add') { addEmojis($('#fx-emoji-in').value); $('#fx-emoji-in').value = ''; }
      else if (b.id === 'fx-url-add') { const u = $('#fx-url-in').value.trim(); if (u) addImageUrl(u).then(() => { $('#fx-url-in').value = ''; }); }
      else if (b.id === 'fx-file-btn') $('#fx-file').click();
      else if (b.id === 'fx-tsp-auto') { f.tsp.color = ''; fxChanged(false); toast('Usando a cor do tema'); }
      else if (b.id === 'fx-cs-own-x') { f.chatStyle.own = ''; fxChanged(true); }
      else if (b.id === 'fx-cs-other-x') { f.chatStyle.other = ''; fxChanged(true); }
      else if (b.id === 'fx-frame-auto') { f.frame.color = ''; fxChanged(false); toast('Usando a cor do tema'); }
      else if (b.id === 'fx-clear') { if (confirm('Remover todos os efeitos deste tema?')) { draft.fx = fxDefault(); fxChanged(true); } }
    });
    root.addEventListener('change', async (e) => {
      if (e.target.id === 'fx-file') { for (const fl of Array.from(e.target.files)) await addImageFile(fl); e.target.value = ''; fxChanged(true); }
    });
    root.addEventListener('input', (e) => {
      const el = e.target, f = ensureFx(draft), id = el.id;
      const num = () => parseFloat(el.value);
      const show = () => { const v = $('#' + id + '-v'); if (v) v.textContent = el.value; };
      if (id === 'fx-tsp') f.tsp.preset = el.value; else if (id === 'fx-tsp-c') f.tsp.color = el.value;
      else if (id === 'fx-fall-on') f.fall.on = el.checked; else if (id === 'fx-fall-mode') f.fall.mode = el.value;
      else if (id === 'fx-fall-count') { f.fall.count = num(); show(); } else if (id === 'fx-fall-size') { f.fall.size = num(); show(); } else if (id === 'fx-fall-speed') { f.fall.speed = num(); show(); }
      else if (id === 'fx-gar-on') f.garland.on = el.checked; else if (id === 'fx-gar-size') { f.garland.size = num(); show(); }
      else if (id === 'fx-frame') f.frame.type = el.value; else if (id === 'fx-frame-c') f.frame.color = el.value; else if (id === 'fx-frame-p') { f.frame.power = num(); show(); }
      else if (id === 'fx-cr-on') f.critters.on = el.checked; else if (id === 'fx-cr-mode') f.critters.mode = el.value;
      else if (id === 'fx-cr-count') { f.critters.count = num(); show(); } else if (id === 'fx-cr-size') { f.critters.size = num(); show(); }
      else if (id === 'fx-ma-on') f.mascot.on = el.checked; else if (id === 'fx-ma-item') f.mascot.item = Math.max(0, (parseInt(el.value, 10) || 1) - 1);
      else if (id === 'fx-ma-name') f.mascot.name = el.value; else if (id === 'fx-ma-lines') f.mascot.lines = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
      else if (id === 'fx-cs-bubble') f.chatStyle.bubble = el.value; else if (id === 'fx-cs-entry') f.chatStyle.entry = el.value;
      else if (id === 'fx-cs-radius') { f.chatStyle.radius = num(); show(); } else if (id === 'fx-cs-own') f.chatStyle.own = el.value; else if (id === 'fx-cs-other') f.chatStyle.other = el.value;
      else if (id === 'fx-chat') f.chat.burst = el.checked; else if (id === 'fx-font') f.googleFont = el.value.replace(/[^A-Za-z0-9 ]/g, '');
      else return;
      dirty = true; pushSoon();
    });
    root.addEventListener('paste', async (e) => {
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((x) => x.type.indexOf('image/') === 0);
      if (!files.length) return; e.preventDefault();
      for (const fl of files) await addImageFile(fl); fxChanged(true);
    });
  }

  let themes = [], sel = null, draft = null, isNew = false, filterCat = '', dirty = false;
  const stage = $('#stage');
  let stageReady = false;
  stage.addEventListener('load', () => { [100, 500, 1500].forEach((ms) => setTimeout(() => { try { pushStage(); } catch (_) { /* ainda carregando */ } }, ms)); });

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
    return { id: null, key: '', name: 'Novo tema', tagline: '', category: 'essenciais', primary: '#5b6cff', secondary: '#8b5cf6', highlight: '#22d3ee', text: '#eef0ff', button: '#12142b', darkMode: true, effect: 'glow', premium: false, published: true, releaseAt: null, suggestedEffects: [], fx: null, font: 'modern', scene: 'aurora', decor: '', sortOrder: themes.length ? Math.max.apply(null, themes.map((t) => t.sortOrder || 0)) + 1 : 1 };
  }
  function toStageTheme(t) {
    return { key: t.key, name: t.name, colors: { primary: t.primary, secondary: t.secondary, highlight: t.highlight, text: t.text, button: t.button }, darkMode: true, effect: t.effect, font: t.font, scene: t.scene, decor: t.decor || '', fx: t.fx || null, suggestedEffects: t.suggestedEffects || [] };
  }
  function pushStage(extra) {
    // v0.90.7: não depende mais do aviso "pronto" do palco (se ele se perdia, o
    // preview ficava com o visual padrão); envia sempre e reenvia ao carregar.
    if (!draft || !okHexAll(draft) || !stage.contentWindow) return;
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
    $('#list').innerHTML = items.map((t) => `<div class="item${sel && sel.id === t.id && !isNew ? ' sel' : ''}" data-id="${esc(t.id)}"><div class="sw">${[t.primary, t.secondary, t.highlight, t.text, t.button].map((c) => `<i style="background:${c}"></i>`).join('')}</div><div class="nm"><b>${esc(t.name)}</b><small>${esc(t.tagline || t.key || '—')} · ${esc(CATS[t.category] || t.category)}</small></div><div class="tags">${status(t)}${t.premium ? '<span class="tag">PLUS</span>' : ''}${t.fx && t.fx.items && t.fx.items.length ? '<span class="tag">figurinhas</span>' : ''}${t.scene && t.scene !== 'none' ? '<span class="tag">fundo animado</span>' : ''}</div></div>`).join('') || '<div class="sub" style="padding:14px">Nenhum tema.</div>';
    renderCats();
  }

  // ---------- editor ----------
  let page = 'list';
  function showPage(name) {
    page = name;
    ['list', 'edit', 'prev'].forEach((n) => $('#page-' + n).classList.toggle('hidden', n !== name));
    $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.page === name));
    $('#cur').innerHTML = draft ? 'Editando: <b>' + esc(draft.name || 'sem nome') + '</b>' : '';
    if (name === 'prev') { setTimeout(() => { stage.contentWindow && stage.contentWindow.dispatchEvent(new Event('resize')); pushStage(); }, 80); }
    const pg = $('#page-' + name); if (pg) pg.scrollTop = 0;
  }
  function select(t, creating) {
    sel = t; isNew = !!creating; draft = JSON.parse(JSON.stringify(t)); dirty = false;
    renderEditor(); renderList(); pushStage();
    const cur = $('#cur'); if (cur) cur.innerHTML = 'Editando: <b>' + esc(draft.name || 'sem nome') + '</b>';
  }
  function renderEditor() {
    const t = draft;
    const card = (title, body) => `<section class="card"><h4>${title}</h4>${body}</section>`;
    const tog = (id, on, label) => `<label class="toggle"><input type="checkbox" id="${id}"${on ? ' checked' : ''}> ${label}</label>`;
    $('#tab-basic').innerHTML =
      card('Identificação', `
        <div class="row2"><label class="f">Nome<input type="text" id="f-name" maxlength="40" value="${esc(t.name)}"></label>
        <label class="f">Chave (slug)<input type="text" id="f-key" maxlength="32" value="${esc(t.key)}" ${isNew ? '' : 'disabled'} placeholder="ex: meu-tema"></label></div>
        <div class="row2"><label class="f">Frase curta<input type="text" id="f-tagline" maxlength="60" value="${esc(t.tagline)}"></label>
        <label class="f">Categoria<select id="f-category">${opts(CATS, t.category)}</select></label></div>`) +
      card('Cores', `
        <div class="presets">${PRESETS.map((p, i) => `<button data-p="${i}" title="Paleta ${i + 1}">${p.slice(0, 3).map((c) => `<i style="background:${c}"></i>`).join('')}</button>`).join('')}<button id="btn-rand" style="width:auto;padding:0 10px">Sortear</button></div>
        ${COLORS.map(([k, n]) => `<div class="crow"><span>${n}</span><input type="color" data-c="${k}" value="${okHex(t[k]) ? t[k] : '#000000'}"><input type="text" data-h="${k}" value="${esc(t[k])}" maxlength="7"></div>`).join('')}`) +
      card('Legibilidade (contraste)', '<div class="audit" id="audit"></div>');
    $('#tab-fx').innerHTML =
      card('Visual', `
        <div class="row2"><label class="f">Fonte<select id="f-font">${opts(FONTS, t.font)}</select></label>
        <label class="f">Efeito do card<select id="f-effect">${opts(EFFECTS, t.effect)}</select></label></div>
        <label class="f">Fundo animado<select id="f-scene">${opts(SCENES, t.scene)}</select></label>`) +
      card('Data comemorativa pronta', `
        <label class="f">Decoração + mascote<select id="f-decor">${opts(DECORS, t.decor)}</select></label>
        <div class="sub">Liga o varal/enfeite do topo e o mascote do Natal, Ano Novo, Carnaval, Páscoa, Namorados ou Crianças. Para qualquer outra data, use a aba Figurinhas.</div>`) +
      card('Efeitos do site que ligam sozinhos', Object.entries(SITE_FX).map(([k, v]) => `<label class="toggle"><input type="checkbox" data-fx="${k}"${(t.suggestedEffects || []).includes(k) ? ' checked' : ''}> ${v}</label>`).join(''));
    renderFx2();
    const rel = t.releaseAt ? new Date(t.releaseAt) : null;
    const loc = rel ? new Date(rel.getTime() - rel.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
    $('#tab-pub').innerHTML =
      card('Visibilidade', `
        ${tog('f-published', t.published !== false, 'Publicado (aparece na galeria e na API)')}
        ${tog('f-premium', t.premium, 'Exclusivo PLUS')}
        <label class="f">Liberar automaticamente em<input type="datetime-local" id="f-release" value="${loc}"></label>
        <div class="sub">Vazio = disponível já. Rascunhos e temas agendados só aparecem para você (admin).</div>`) +
      card('Agenda de lançamentos', `<div class="audit">${themes.filter((x) => x.releaseAt).sort((a, b) => new Date(a.releaseAt) - new Date(b.releaseAt)).map((x) => `<div><span>${esc(x.name)}</span><b>${new Date(x.releaseAt).toLocaleDateString('pt-BR')}</b></div>`).join('') || '<span class="sub">Nenhum agendamento.</span>'}</div>`);
    const k = t.key || 'meu-tema';
    $('#tab-api').innerHTML =
      card('Site parceiro', `
        <pre class="code">&lt;script src="${location.origin}/sdk/nextgame-themes.js"&gt;&lt;/script&gt;
&lt;script&gt;NextGameThemes.apply('${esc(k)}')&lt;/script&gt;</pre>
        <button id="btn-copy-snip">Copiar código</button>
        <div class="sub">Com fundo animado, figurinhas e mascote:</div>
        <pre class="code">NextGameThemes.apply('${esc(k)}', { effects: true })</pre>`) +
      card('API pública (somente leitura)', `<pre class="code">${location.origin}/api/plus2/public/themes
${location.origin}/api/plus2/public/themes/${esc(k)}</pre><div class="sub">Só temas publicados e já liberados aparecem.</div>`);
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
      ['basic', 'fx', 'fx2', 'pub', 'api'].forEach((n) => $('#tab-' + n).classList.toggle('hidden', n !== b.dataset.tab));
    });
    $('#list').addEventListener('click', (e) => {
      const it = e.target.closest('.item'); if (!it) return;
      if (dirty && !confirm('Descartar alterações não salvas?')) return;
      select(themes.find((t) => t.id === it.dataset.id)); showPage('edit');
    });
    $('#cats').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { filterCat = b.dataset.c; renderList(); } });
    $('#q').addEventListener('input', renderList);
    $('#btn-new').onclick = () => { if (dirty && !confirm('Descartar alterações não salvas?')) return; select(blank(), true); showPage('edit'); };
    $('#btn-save').onclick = save; $('#btn-save2').onclick = save;
    $('#nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.page !== 'list' && !draft) return; showPage(b.dataset.page); });
    $('#btn-go-prev').onclick = () => showPage('prev');
    $('#btn-back-edit').onclick = () => showPage('edit');
    $('#btn-dup').onclick = () => {
      const c = JSON.parse(JSON.stringify(draft)); c.id = null; c.name += ' (cópia)'; c.published = false;
      let k = (draft.key || 'tema') + '-copia', n = 2; const keys = new Set(themes.map((t) => t.key));
      let base = k; while (keys.has(k)) k = base + '-' + n++;
      c.key = k; select(c, true); showPage('edit'); dirty = true; toast('Cópia criada — ajuste e salve');
    };
    $('#btn-del').onclick = async () => {
      if (isNew || !draft.id) return toast('Tema ainda não foi salvo');
      if (!confirm('Excluir "' + draft.name + '"? Quem usa volta ao tema padrão.')) return;
      try { await api('/admin/themes/' + draft.id, 'DELETE'); toast('Excluído'); await load(); showPage('list'); } catch (err) { toast(err.message); }
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
    const o = {}; ['key', 'name', 'tagline', 'category', 'primary', 'secondary', 'highlight', 'text', 'button', 'darkMode', 'effect', 'premium', 'releaseAt', 'suggestedEffects', 'font', 'scene', 'decor', 'fx'].forEach((k) => { o[k] = t[k]; });
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
    const body = { name: d.name, tagline: d.tagline, category: d.category, primary: d.primary, secondary: d.secondary, highlight: d.highlight, text: d.text, button: d.button, darkMode: true, effect: d.effect, premium: !!d.premium, releaseAt: d.releaseAt || null, suggestedEffects: d.suggestedEffects || [], font: d.font, scene: d.scene, decor: d.decor || '', fx: (d.fx && (d.fx.items.length || d.fx.frame.type !== 'none' || d.fx.tsp.preset || d.fx.chatStyle.bubble !== 'default' || d.fx.chatStyle.entry !== 'none')) ? d.fx : null, published: d.published !== false, sortOrder: d.sortOrder || 0 };
    try {
      $('#btn-save').disabled = true;
      if (isNew) { body.key = d.key; await api('/admin/themes', 'POST', body); } else { await api('/admin/themes/' + d.id, 'PATCH', body); }
      toast(body.published ? 'Salvo! Já está disponível no NEXT GAME (recarregue o site para ver).' : 'Salvo como rascunho (só você vê).'); dirty = false;
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
    bind(); bindFx();
    try { await load(); } catch (err) { g.classList.remove('hidden'); g.textContent = 'Erro ao carregar: ' + err.message; }
  }
  init();
})();
