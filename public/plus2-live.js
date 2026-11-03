// plus2-live.js — "motor de aplicação" da Personalização (Plus V2) na página
// de verdade. O plus2.js cuida só da TELA de configurações (escolher tema,
// fundo, efeitos etc.); esse arquivo aqui é quem pega o que a pessoa
// escolheu e aplica de verdade no app inteiro (cores, fundo, efeitos visuais,
// badge/banner no chat e perfil).
//
// Roda automaticamente no boot do app (chamado em startApp(), ver app.js) e
// de novo toda vez que alguma coisa muda no painel de Configurações →
// NEXTGAME PLUS (via o callback onChange que o plus2.js dispara depois de
// cada salvamento).
(function (global) {
  'use strict';

  // Estado atual, exposto pra outras partes do app.js lerem de forma síncrona
  // (ex: renderMessage() decide se mostra efeito de menção, addVideoTile()
  // decide se anima a entrada na call) sem precisar buscar de novo na API.
  const state = {
    loaded: false,
    theme: null,
    background: null,
    effects: { particles: false, buttonGlow: false, animatedGradients: false, messageReceive: false, callJoin: false, avatarGlow: false, transitions: false },
    performanceMode: false,
    chat: { bubbleStyle: 'rounded', showAvatars: true, colorMode: 'per_user', fontSize: 'medium', spacing: 16, showTimestamps: true, showReactions: true, mentionEffect: 'highlight' },
    badge: null,
    bannerCss: null,
  };

  // ---------------- Cor -> fundo das "colunas" (rail/sidebar/main/topo/
  // pop-ups) ----------------
  // Antes, trocar de tema só mudava botões/detalhes (--accent) — as colunas
  // de fundo do app inteiro ficavam sempre no mesmo cinza fixo, tema nenhum
  // "pegava" nelas. Aqui a gente deriva um fundo bem escuro só que TINGIDO
  // com a matiz da cor primária do tema (ex: GAMEX = verde → fundo preto-
  // esverdeado; Diamond = azul-gelo → fundo preto-azulado; Eclipse = roxo
  // escuro → fundo quase preto-arroxeado), pra cada tema realmente assumir a
  // identidade visual inteira, sem precisar de um valor de fundo cadastrado
  // à mão pra cada tema novo — funciona automático pra qualquer tema
  // (inclusive os que o usuário PLUS cria na hora, na aba "Criar tema").
  function hexToRgb(hex) {
    const clean = String(hex || '#00ff9d').replace('#', '');
    const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
    const num = parseInt(full, 16) || 0;
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d !== 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
  }
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const toHex = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
    return '#' + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
  }
  // Satura pouco de propósito — dá pra sentir a cor do tema no fundo sem
  // virar neon chapado atrás do conteúdo (mantém leitura confortável).
  // CORRIGIDO ("ficou feio" no tema Halloween/laranja): 28% de saturação
  // com matiz laranja/amarela em pouca luminosidade lê como MARROM SUJO, não
  // como "escuro combinando com o tema" — funcionava bem pra matizes frias
  // (azul/roxo/rosa) mas ficava lamacento pras quentes. Reduz a saturação
  // base e desatura ainda mais matizes entre 15°-55° (laranja/âmbar/amarelo),
  // a faixa que mais sofre desse efeito "barro".
  function deriveSurfaces(primaryHex) {
    const rgb = hexToRgb(primaryHex);
    const { h } = rgbToHsl(rgb.r, rgb.g, rgb.b);
    // AJUSTADO: a redução geral pra 18% deixou os temas frios (rosa/roxo/
    // azul) "personalizando mal" — fracos demais. Volta pro 28% original
    // pra esses, e mantém baixa SÓ na faixa laranja/âmbar/amarela (15°-55°),
    // que é a única que lia como barro/lama.
    const isWarmBrownZone = h >= 15 && h <= 55;
    const S = isWarmBrownZone ? 12 : 28;
    return {
      app: hslToHex(h, S, 9),
      rail: hslToHex(h, S, 6.5),
      sidebar: hslToHex(h, S, 11),
      panel: hslToHex(h, S, 14),
      modal: hslToHex(h, S, 18),
    };
  }

  let particleStop = null;
  function stopParticles() {
    if (particleStop) { particleStop(); particleStop = null; }
  }
  function startParticles(canvas) {
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return () => {};
    const dpr = global.devicePixelRatio || 1;
    function size() { canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr; }
    size();
    global.addEventListener('resize', size);
    const N = 40;
    const particles = Array.from({ length: N }, () => ({
      x: Math.random() * canvas.width, y: Math.random() * canvas.height,
      r: 1 + Math.random() * 2, vy: 0.1 + Math.random() * 0.3, vx: (Math.random() - 0.5) * 0.15,
    }));
    let raf;
    function tick() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      particles.forEach((p) => {
        p.y -= p.vy; p.x += p.vx;
        if (p.y < -4) { p.y = canvas.height + 4; p.x = Math.random() * canvas.width; }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * dpr, 0, Math.PI * 2);
        ctx.fill();
      });
      raf = requestAnimationFrame(tick);
    }
    tick();
    return () => { cancelAnimationFrame(raf); global.removeEventListener('resize', size); };
  }

  // =========================================================================
  // v0.84.0 — FONTES E FUNDOS ANIMADOS DOS TEMAS ("scene")
  // =========================================================================
  // Cada tema pode trazer uma fonte própria (corpo + títulos) e um fundo
  // animado. As fontes vêm do Google Fonts, carregadas sob demanda (só a do
  // tema escolhido) — se estiver offline, cai nas fontes do sistema sem
  // quebrar nada. Os fundos CSS (aurora/grid/waves) são só gradientes
  // animados; os de canvas (stars/embers/matrix/petals/snow) são leves e
  // pausam sozinhos quando a aba fica escondida ou no "modo desempenho".
  const FONT_PACKS = {
    modern: { body: "'Inter', 'Segoe UI', system-ui, sans-serif", display: "'Sora', 'Inter', sans-serif", google: 'family=Inter:wght@400;500;600;700&family=Sora:wght@500;600;700;800' },
    tech: { body: "'Exo 2', 'Segoe UI', system-ui, sans-serif", display: "'Orbitron', 'Exo 2', sans-serif", google: 'family=Exo+2:wght@400;500;600;700&family=Orbitron:wght@500;700;800' },
    retro: { body: "'Space Grotesk', 'Segoe UI', system-ui, sans-serif", display: "'Audiowide', 'Space Grotesk', sans-serif", google: 'family=Space+Grotesk:wght@400;500;600;700&family=Audiowide' },
    elegant: { body: "'Inter', 'Segoe UI', system-ui, sans-serif", display: "'Playfair Display', Georgia, serif", google: 'family=Inter:wght@400;500;600;700&family=Playfair+Display:wght@600;700;800' },
    soft: { body: "'Nunito', 'Segoe UI', system-ui, sans-serif", display: "'Fredoka', 'Nunito', sans-serif", google: 'family=Nunito:wght@400;600;700;800&family=Fredoka:wght@500;600;700' },
  };
  const loadedFonts = {};
  function applyFont(fontKey) {
    const pack = FONT_PACKS[fontKey];
    const root = document.documentElement;
    document.body.classList.toggle('pv2-has-font', !!pack);
    if (!pack) {
      root.style.removeProperty('--pv2-font-body');
      root.style.removeProperty('--pv2-font-display');
      return;
    }
    if (!loadedFonts[fontKey]) {
      loadedFonts[fontKey] = true;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?' + pack.google + '&display=swap';
      document.head.appendChild(link);
    }
    root.style.setProperty('--pv2-font-body', pack.body);
    root.style.setProperty('--pv2-font-display', pack.display);
  }

  const CANVAS_SCENES = new Set(['stars', 'embers', 'matrix', 'petals', 'snow']);
  const CSS_SCENES = new Set(['aurora', 'grid', 'waves']);
  let sceneStop = null;
  let currentScene = 'none';

  function ensureSceneLayer() {
    let layer = document.getElementById('plus2-scene');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'plus2-scene';
      const bg = document.getElementById('plus2-bg-layer');
      if (bg && bg.nextSibling) document.body.insertBefore(layer, bg.nextSibling);
      else document.body.insertBefore(layer, document.body.firstChild);
    }
    return layer;
  }

  // Motor de canvas único — cada cena é só um "modo" de desenhar. Usa as
  // cores do próprio tema (CSS vars --accent/--accent-2/--accent-3).
  function startCanvasScene(canvas, mode, colors) {
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return () => {};
    const dpr = Math.min(global.devicePixelRatio || 1, 2);
    let W = 0, H = 0;
    function size() {
      W = canvas.width = Math.floor(canvas.clientWidth * dpr);
      H = canvas.height = Math.floor(canvas.clientHeight * dpr);
    }
    size();
    global.addEventListener('resize', size);
    const rnd = (a, b) => a + Math.random() * (b - a);
    const COUNT = { stars: 90, embers: 46, petals: 34, snow: 70 }[mode] || 0;
    let items = [];
    let cols = [];
    if (mode === 'matrix') {
      const fs = 16 * dpr;
      const n = Math.ceil(W / fs);
      cols = Array.from({ length: n }, () => Math.random() * -50);
    } else {
      items = Array.from({ length: COUNT }, () => ({
        x: rnd(0, W), y: rnd(0, H), r: rnd(0.6, mode === 'stars' ? 1.8 : 3.2) * dpr,
        v: rnd(0.2, 1), p: rnd(0, Math.PI * 2), c: colors[Math.floor(Math.random() * colors.length)],
      }));
    }
    let raf = 0;
    let last = 0;
    let running = true;
    function frame(t) {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      if (t - last < 33) return; // ~30fps — leve de propósito
      last = t;
      if (mode === 'matrix') {
        ctx.fillStyle = 'rgba(0,0,0,0.08)';
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'source-over';
        const fs = 16 * dpr;
        ctx.font = fs + 'px monospace';
        for (let i = 0; i < cols.length; i++) {
          const ch = String.fromCharCode(0x30A0 + Math.floor(Math.random() * 96));
          ctx.fillStyle = colors[0];
          ctx.globalAlpha = 0.85;
          ctx.fillText(ch, i * fs, cols[i] * fs);
          ctx.globalAlpha = 1;
          if (cols[i] * fs > H && Math.random() > 0.975) cols[i] = 0;
          cols[i] += 0.5;
        }
        return;
      }
      ctx.clearRect(0, 0, W, H);
      for (const it of items) {
        if (mode === 'stars') {
          it.p += 0.03 * it.v;
          ctx.globalAlpha = 0.25 + 0.75 * Math.abs(Math.sin(it.p));
          ctx.fillStyle = it.c;
          ctx.beginPath(); ctx.arc(it.x, it.y, it.r, 0, 6.283); ctx.fill();
        } else if (mode === 'embers') {
          it.y -= (0.4 + it.v * 1.2) * dpr; it.x += Math.sin(it.p += 0.04) * 0.5 * dpr;
          if (it.y < -10) { it.y = H + 10; it.x = rnd(0, W); }
          ctx.globalAlpha = Math.max(0, Math.min(0.9, it.y / H + 0.1));
          ctx.fillStyle = it.c;
          ctx.shadowColor = it.c; ctx.shadowBlur = 8 * dpr;
          ctx.beginPath(); ctx.arc(it.x, it.y, it.r, 0, 6.283); ctx.fill();
          ctx.shadowBlur = 0;
        } else if (mode === 'petals' || mode === 'snow') {
          const speed = mode === 'snow' ? 0.5 : 0.7;
          it.y += (speed + it.v * 0.9) * dpr; it.x += Math.sin(it.p += 0.02) * (mode === 'snow' ? 0.4 : 0.9) * dpr;
          if (it.y > H + 10) { it.y = -10; it.x = rnd(0, W); }
          ctx.globalAlpha = 0.75;
          ctx.fillStyle = it.c;
          ctx.beginPath();
          if (mode === 'petals') ctx.ellipse(it.x, it.y, it.r * 1.6, it.r, it.p, 0, 6.283);
          else ctx.arc(it.x, it.y, it.r, 0, 6.283);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }
    raf = requestAnimationFrame(frame);
    function onVis() {
      if (document.hidden) { running = false; cancelAnimationFrame(raf); }
      else if (!running) { running = true; raf = requestAnimationFrame(frame); }
    }
    document.addEventListener('visibilitychange', onVis);
    return () => {
      running = false; cancelAnimationFrame(raf);
      global.removeEventListener('resize', size);
      document.removeEventListener('visibilitychange', onVis);
    };
  }

  function sceneColors(theme, mode) {
    const c = theme.colors;
    if (mode === 'matrix') return [c.primary];
    if (mode === 'snow') return ['#ffffff', c.highlight];
    if (mode === 'embers') return [c.primary, c.highlight, c.secondary];
    if (mode === 'petals') return [c.primary, c.highlight];
    return [c.highlight, '#ffffff', c.primary];
  }

  function applyScene(theme) {
    const key = theme && theme.scene ? theme.scene : 'none';
    const layer = ensureSceneLayer();
    if (sceneStop) { sceneStop(); sceneStop = null; }
    layer.innerHTML = '';
    layer.className = '';
    currentScene = key;
    const off = key === 'none' || state.performanceMode;
    document.body.classList.toggle('pv2-scene-active', !off);
    document.body.dataset.pv2Scene = off ? '' : key;
    if (off) return;
    if (CSS_SCENES.has(key)) {
      layer.className = 'pv2-scene-' + key;
      if (key === 'aurora') layer.innerHTML = '<i></i><i></i><i></i>';
    } else if (CANVAS_SCENES.has(key)) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:100%;height:100%;display:block;';
      layer.appendChild(canvas);
      sceneStop = startCanvasScene(canvas, key, sceneColors(theme, key));
    }
  }

  // ---- Pré-visualização ao vivo: aplica um tema no site de verdade SEM
  // salvar; cancelPreview() volta pro que está salvo.
  let lastData = null;
  function previewTheme(theme) {
    if (!theme) return;
    applyTheme(theme);
  }
  function cancelPreview() {
    if (lastData) applyAll(lastData);
  }

  // ---------------- Tema: cores viram CSS vars usadas no site inteiro ----------------
  function applyTheme(theme) {
    if (!theme) return;
    const root = document.documentElement;
    // Expõe o tema atual pro app.js conseguir ler o nome/cor sem duplicar
    // esse dado — usado pela faixa de identidade genérica no menu lateral
    // (ver initThemeBanner() em app.js), que funciona pra qualquer tema do
    // catálogo, não só os 2 que ganharam decoração feita à mão (Halloween/
    // Magic Tank).
    global.PlusV2LiveCurrentTheme = theme;
    // Tema sazonal "Halloween" — além da cor (que se aplica sozinha, igual
    // qualquer tema), liga uma classe extra no <body> que o style.css usa
    // pra mostrar os decorativos exclusivos dele (morcegos, lua, neblina).
    document.body.classList.toggle('theme-halloween', theme.key === 'halloween');
    // Mesma ideia pro tema do jogo parceiro Magic Tank — extras próprios
    // (banner "MAGIC TANK PARTNER" com brilho, borda azul/dourada nos
    // painéis) só aparecem quando esse tema específico está ativo.
    document.body.classList.toggle('theme-magic-tank', theme.key === 'magic-tank');
    // Mesma ideia pro tema DDTank — a pedido ("o mesmo do DDTank"): partículas
    // de brilho/coraçãozinho flutuando, combinando com a paleta fofa/pastel
    // dele (ver initDdtankExtras() em app.js).
    document.body.classList.toggle('theme-ddtank', theme.key === 'ddtank');
    root.style.setProperty('--accent', theme.colors.primary);
    root.style.setProperty('--accent-2', theme.colors.secondary);
    root.style.setProperty('--accent-3', theme.colors.highlight);
    root.style.setProperty(
      '--gradient-brand',
      `linear-gradient(135deg, ${theme.colors.primary} 0%, ${theme.colors.secondary} 55%, ${theme.colors.highlight} 100%)`
    );
    // CORRIGIDO — o remodelamento visual (bordas/glow neon) usa
    // rgba(var(--accent-rgb), X) em vez de cor fixa, exatamente pra poder
    // acompanhar o tema escolhido aqui. Antes só --accent (a cor "sólida")
    // mudava; o glow ficava sempre verde-neon porque não tinha essa
    // variável — parecia que "o tema não aplicava em tudo".
    const rgb = hexToRgb(theme.colors.primary);
    const rgb2 = hexToRgb(theme.colors.secondary);
    const rgb3 = hexToRgb(theme.colors.highlight);
    root.style.setProperty('--accent-rgb', `${rgb.r},${rgb.g},${rgb.b}`);
    root.style.setProperty('--accent-2-rgb', `${rgb2.r},${rgb2.g},${rgb2.b}`);
    // CORRIGIDO ("temas não personalizam tudo"): faltava essa variável —
    // vários blocos novos (fundo da tela, blobs do login, destaque do menu)
    // precisam da 3ª cor do tema (highlight) em rgba() e só tinham --accent/
    // --accent-2 disponíveis, então ficavam sempre na cor padrão (rosa/roxo)
    // não importa qual tema a pessoa escolhesse.
    root.style.setProperty('--accent-3-rgb', `${rgb3.r},${rgb3.g},${rgb3.b}`);
    // Fundo das colunas (rail de servidores, sidebar de canais, painel
    // principal, barra do topo e pop-ups) também acompanha o tema agora —
    // antes só os detalhes/botões mudavam de cor, as colunas ficavam sempre
    // no mesmo cinza. Ver deriveSurfaces() acima.
    const surfaces = deriveSurfaces(theme.colors.primary);
    root.style.setProperty('--bg-app', surfaces.app);
    root.style.setProperty('--bg-rail', surfaces.rail);
    root.style.setProperty('--bg-sidebar', surfaces.sidebar);
    root.style.setProperty('--bg-panel', surfaces.panel);
    root.style.setProperty('--bg-modal', surfaces.modal);
    // v0.84.0 — fonte e fundo animado do tema + variáveis do visual "glass".
    root.style.setProperty('--pv2-glass-bg', `rgba(${rgb.r},${rgb.g},${rgb.b},0.10)`);
    root.style.setProperty('--pv2-glass-border', `rgba(${rgb3.r},${rgb3.g},${rgb3.b},0.28)`);
    applyFont(theme.font);
    applyScene(theme);
  }

  // ---------------- Fundo personalizado ----------------
  // REATIVADO (a pedido, depois de entender a causa dos 2 bugs de 2026-09):
  // 1) o menu do chip de perfil ficava preso atrás da página — vinha do
  //    backdrop-filter na camada de fundo, que cria um stacking context novo
  //    e prende qualquer coisa com position:fixed sem z-index alto o
  //    bastante. Essa versão NÃO usa backdrop-filter em lugar nenhum, e o
  //    #footer-more-menu já ganhou z-index bem alto (ver style.css) — a
  //    combinação das duas coisas deve evitar o problema de novo.
  // 2) o fundo aparecia "em bloco duro" — a camada agora fica com z-index
  //    bem baixo (fixed, atrás de tudo) e os painéis (sidebar/topo/main)
  //    ficam translúcidos só quando tem fundo custom ativo (ver
  //    body.pv2-custom-bg-active no plus2.css), deixando o fundo aparecer
  //    de forma sutil por trás, em vez de cobrir a tela toda.
  // Só cores sólidas/gradiente/efeitos (partículas/ondas) são aplicados de
  // verdade — "Imagens"/"GIFs" no catálogo atual são só exemplos de
  // ilustração (sem arquivo real por trás ainda), então continuam só
  // salvando a escolha sem desenhar nada, pra não mostrar imagem quebrada.
  function ensureBgLayer() {
    let layer = document.getElementById('plus2-bg-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'plus2-bg-layer';
      document.body.insertBefore(layer, document.body.firstChild);
    }
    return layer;
  }
  function applyBackground(bg, prefs) {
    state.background = bg;
    const layer = ensureBgLayer();
    const opacity = prefs && typeof prefs.opacity === 'number' ? prefs.opacity : 100;
    const blur = prefs && typeof prefs.blur === 'number' ? prefs.blur : 0;
    layer.style.opacity = String(Math.max(0, Math.min(100, opacity)) / 100);
    layer.style.filter = blur > 0 ? `blur(${blur}px)` : 'none';
    layer.style.background = '';
    layer.classList.remove('pv2-bg-waves');
    stopParticles();
    state._bgParticlesRequested = false;

    const isDefault = !bg || bg.key === 'bg-solid-dark';
    document.body.classList.toggle('pv2-custom-bg-active', !isDefault);
    if (isDefault) return;

    if (bg.type === 'solid') {
      layer.style.background = bg.value;
    } else if (bg.type === 'gradient') {
      const parts = String(bg.value).split(',');
      const angle = parts[2] ? Number(parts[2]) || 135 : 135;
      layer.style.background = `linear-gradient(${angle}deg, ${parts[0]}, ${parts[1]})`;
    } else if (bg.type === 'effect') {
      layer.style.background = '#0a0b0d';
      if (bg.value === 'waves') {
        layer.classList.add('pv2-bg-waves');
      } else if (bg.value === 'particles') {
        state._bgParticlesRequested = true;
      }
    } else if ((bg.type === 'image' || bg.type === 'gif') && String(bg.value || '').indexOf('placeholder:') !== 0) {
      // CORRIGIDO ("imagem/GIF não funciona"): agora desenha de verdade
      // quando `value` é uma URL/imagem de verdade (upload próprio via
      // Configurações → Personalização, ou um valor real de catálogo) — só
      // os exemplos de ilustração do catálogo (prefixo "placeholder:",
      // sem arquivo real por trás) continuam sem desenhar nada.
      layer.style.backgroundImage = `url("${bg.value}")`;
      layer.style.backgroundSize = 'cover';
      layer.style.backgroundPosition = 'center';
      layer.style.backgroundRepeat = 'no-repeat';
    } else {
      // Exemplo de ilustração do catálogo (sem arquivo real por trás) —
      // não desenha nada pra não mostrar um placeholder quebrado; a escolha
      // continua salva normalmente.
      document.body.classList.remove('pv2-custom-bg-active');
      return;
    }
    refreshParticleLayer(layer);
  }

  function refreshParticleLayer(layer) {
    layer = layer || document.getElementById('plus2-bg-layer');
    if (!layer) return;
    stopParticles();
    // Sempre limpa qualquer canvas antigo antes de decidir se cria um novo —
    // sem isso, chamar essa função mais de uma vez (ex: applyBackground E
    // applyEffects, os dois dentro do mesmo applyAll()) ia empilhando um
    // canvas novo em cima do outro toda vez que qualquer configuração mudasse.
    layer.querySelectorAll('canvas').forEach((c) => c.remove());
    const wantParticles = !state.performanceMode && (state._bgParticlesRequested || state.effects.particles);
    if (wantParticles) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:100%; height:100%; display:block;';
      layer.appendChild(canvas);
      particleStop = startParticles(canvas);
    }
  }

  // ---------------- Efeitos (só os aditivos/seguros de aplicar globalmente) ----------------
  function applyEffects(effects, performanceMode) {
    state.effects = effects;
    state.performanceMode = performanceMode;
    const active = performanceMode ? {} : effects;
    document.body.classList.toggle('pv2-fx-button-glow', !!active.buttonGlow);
    document.body.classList.toggle('pv2-fx-avatar-glow', !!active.avatarGlow);
    document.body.classList.toggle('pv2-fx-gradient-sidebar', !!active.animatedGradients);
    document.body.classList.toggle('pv2-fx-transitions', !!active.transitions);
    refreshParticleLayer();
  }

  // ---------------- Chat / badge / banner: só guarda estado; quem lê e
  // desenha de verdade é renderMessage()/openProfilePreview() no app.js. ----
  function applyChatState(chat) {
    state.chat = chat;
    document.documentElement.style.setProperty('--pv2-live-spacing', (chat.spacing || 16) + 'px');
  }

  // Cor da bolha de DM por remetente — paleta fixa (não é aleatório de
  // verdade) pra sempre dar uma cor legível/consistente pro mesmo id.
  const PALETTE = ['#00c896', '#ff9f43', '#00b4ff', '#ff6ec7', '#ffd93d', '#7ee8ff', '#ff8a65', '#a78bfa'];
  function colorForUser(userId) {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
    return PALETTE[hash % PALETTE.length];
  }
  global.PlusV2LiveColorForUser = colorForUser;
  function applyIdentity(data) {
    state.badge = data.badges.find((b) => b.id === data.current.badgeId) || null;
    const customBanner = data.current.customBannerUrl;
    const catalogBanner = data.banners.find((b) => b.id === data.current.bannerId);
    if (customBanner) {
      state.bannerCss = `background-image:url("${customBanner}"); background-size:cover; background-position:center;`;
    } else if (catalogBanner) {
      state.bannerCss = catalogBanner.style === 'gradient'
        ? (() => { const [a, b] = catalogBanner.value.split(','); return `background: linear-gradient(120deg, ${a}, ${b});`; })()
        : `background:${catalogBanner.value};`;
    } else {
      state.bannerCss = null;
    }
  }

  function applyAll(data) {
    lastData = data;
    const theme = [...data.themes, ...data.myCustomThemes].find((t) => t.id === data.current.themeId);
    applyTheme(theme);
    // CORRIGIDO ("fundo com imagem/GIF não funciona"): fundo com upload
    // próprio tem prioridade sobre o escolhido do catálogo — mesmo padrão
    // de banner/tema (ver applyIdentity() abaixo pro banner equivalente).
    const customBgUrl = data.current.customBackgroundUrl;
    const bg = customBgUrl
      ? { key: 'custom-upload', type: data.current.customBackgroundType || 'image', value: customBgUrl }
      : data.backgrounds.find((b) => b.id === data.current.backgroundId);
    applyBackground(bg, data.visualPrefs.background);
    applyEffects(data.visualPrefs.effects, data.visualPrefs.performanceMode);
    if (theme) applyScene(theme); // respeita o modo desempenho
    applyChatState(data.visualPrefs.chat);
    applyIdentity(data);
    state.loaded = true;
  }

  let inFlight = null;
  async function refresh(fetchFn) {
    // Evita duas chamadas simultâneas pisando uma na outra se vários eventos
    // de "mudou algo" disparam em sequência rápida.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const res = await fetchFn('/api/plus2/catalog', { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        applyAll(data);
      } catch (err) {
        console.error('Erro ao aplicar personalização:', err);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  global.PlusV2Live = { state, refresh, applyAll, previewTheme, cancelPreview };
})(typeof window !== 'undefined' ? window : globalThis);
