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
  }

  // ---------------- Fundo personalizado ----------------
  // DESLIGADO por enquanto (v0.19.2) — a camada de fundo cheia da página
  // causou dois bugs visuais reais seguidos em produção (menu ficando preso
  // atrás da página, e o fundo aparecendo como um bloco duro em vez de algo
  // sutil por trás do conteúdo) e, sem conseguir testar num navegador de
  // verdade, o risco de continuar iterando às cegas é maior que o ganho.
  // A escolha de fundo continua sendo salva normalmente (nada se perde), só
  // não é mais desenhada na página até isso ser revisado com calma.
  function applyBackground(bg, prefs) {
    state.background = bg;
    document.body.classList.remove('pv2-custom-bg-active');
    const layer = document.getElementById('plus2-bg-layer');
    if (layer) layer.remove();
    stopParticles();
    state._bgParticlesRequested = false;
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
