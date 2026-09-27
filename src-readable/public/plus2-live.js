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
  // Satura pouco de propósito (28%) — dá pra sentir a cor do tema no fundo
  // sem virar neon chapado atrás do conteúdo (mantém leitura confortável).
  function deriveSurfaces(primaryHex) {
    const rgb = hexToRgb(primaryHex);
    const { h } = rgbToHsl(rgb.r, rgb.g, rgb.b);
    const S = 28;
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

  // ---------------- Tema: cores viram CSS vars usadas no site inteiro ----------------
  function applyTheme(theme) {
    if (!theme) return;
    const root = document.documentElement;
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
    root.style.setProperty('--accent-rgb', `${rgb.r},${rgb.g},${rgb.b}`);
    root.style.setProperty('--accent-2-rgb', `${rgb2.r},${rgb2.g},${rgb2.b}`);
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
    } else {
      // image/gif ainda são só exemplos no catálogo (sem arquivo real) —
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
    const theme = [...data.themes, ...data.myCustomThemes].find((t) => t.id === data.current.themeId);
    applyTheme(theme);
    applyBackground(data.backgrounds.find((b) => b.id === data.current.backgroundId), data.visualPrefs.background);
    applyEffects(data.visualPrefs.effects, data.visualPrefs.performanceMode);
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

  global.PlusV2Live = { state, refresh, applyAll };
})(typeof window !== 'undefined' ? window : globalThis);
