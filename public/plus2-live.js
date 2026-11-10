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

  // =========================================================================
  // v0.86.0 — BIBLIOTECA DE DESENHOS (SVG feito à mão, sem emoji)
  // =========================================================================
  // Tudo que antes era emoji agora é desenho vetorial: enfeites que pendem do
  // fio de luzes, acessório da logo e o "voador" que atravessa a tela (trenó
  // do Papai Noel com renas, cometa, faixa de bandeirinhas, coelho pulando,
  // flecha de cupido, aviãozinho de papel).
  const NS = "xmlns='http://www.w3.org/2000/svg'";
  const ART = {
    // ---------- enfeites pendurados (viewBox 0 0 30 44, fio no topo) ----------
    bauble: (c) => `<svg ${NS} viewBox='0 0 30 44'><defs><radialGradient id='b${c.slice(1)}' cx='35%' cy='30%' r='75%'><stop offset='0' stop-color='#fff' stop-opacity='.9'/><stop offset='.25' stop-color='${c}'/><stop offset='1' stop-color='#000' stop-opacity='.45'/></radialGradient></defs><line x1='15' y1='0' x2='15' y2='9' stroke='#bbb' stroke-width='1.2'/><rect x='11' y='8' width='8' height='5' rx='1.5' fill='#e6c35c'/><circle cx='15' cy='28' r='14' fill='${c}'/><circle cx='15' cy='28' r='14' fill='url(#b${c.slice(1)})'/><path d='M4 28 Q15 22 26 28' stroke='#fff' stroke-opacity='.55' stroke-width='2' fill='none'/><path d='M5 33 Q15 27 25 33' stroke='#fff' stroke-opacity='.3' stroke-width='1.5' fill='none'/></svg>`,
    star: (c) => `<svg ${NS} viewBox='0 0 30 44'><line x1='15' y1='0' x2='15' y2='12' stroke='#bbb' stroke-width='1.2'/><path d='M15 10 L18.5 20 L29 20.5 L20.8 27 L23.8 37.5 L15 31.5 L6.2 37.5 L9.2 27 L1 20.5 L11.5 20 Z' fill='${c}' stroke='#fff' stroke-opacity='.6' stroke-width='1' stroke-linejoin='round'/><path d='M15 14 L17 21 L15 24 L13 21 Z' fill='#fff' fill-opacity='.55'/></svg>`,
    gift: (c) => `<svg ${NS} viewBox='0 0 30 44'><line x1='15' y1='0' x2='15' y2='14' stroke='#bbb' stroke-width='1.2'/><rect x='3' y='19' width='24' height='21' rx='2.5' fill='${c}'/><rect x='3' y='19' width='24' height='6' rx='2' fill='#000' fill-opacity='.18'/><rect x='13' y='19' width='4' height='21' fill='#ffe08a'/><rect x='3' y='28' width='24' height='4' fill='#ffe08a'/><path d='M15 19 C9 6 2 14 15 19 C28 14 21 6 15 19Z' fill='#ffe08a' stroke='#d9a82e' stroke-width='.8'/></svg>`,
    bell: () => `<svg ${NS} viewBox='0 0 30 44'><line x1='15' y1='0' x2='15' y2='9' stroke='#bbb' stroke-width='1.2'/><path d='M15 8 C7 8 6 17 5 25 C4 30 2 31 2 33 L28 33 C28 31 26 30 25 25 C24 17 23 8 15 8Z' fill='#f2c230' stroke='#b88a00' stroke-width='1'/><path d='M9 14 C8 20 8 25 7 29' stroke='#fff' stroke-opacity='.6' stroke-width='2' fill='none' stroke-linecap='round'/><circle cx='15' cy='37' r='3.6' fill='#b88a00'/><path d='M8 26 Q15 29 22 26' stroke='#b88a00' stroke-width='1.3' fill='none'/></svg>`,
    cane: () => `<svg ${NS} viewBox='0 0 30 44'><path d='M8 43 L8 16 C8 4 24 4 24 15' stroke='#fff' stroke-width='5.5' fill='none' stroke-linecap='round'/><path d='M8 43 L8 16 C8 4 24 4 24 15' stroke='#d62839' stroke-width='5.5' fill='none' stroke-linecap='round' stroke-dasharray='3.6 4.4'/><path d='M8 43 L8 16 C8 4 24 4 24 15' stroke='#fff' stroke-opacity='.35' stroke-width='1.4' fill='none' stroke-linecap='round' transform='translate(-1.2 -1)'/></svg>`,
    heart: (c) => `<svg ${NS} viewBox='0 0 30 44'><line x1='15' y1='0' x2='15' y2='14' stroke='#bbb' stroke-width='1.2'/><path d='M15 40 C3 31 1 24 1 20 C1 14 5 11 9 11 C12 11 14 12.5 15 15 C16 12.5 18 11 21 11 C25 11 29 14 29 20 C29 24 27 31 15 40Z' fill='${c}' stroke='#fff' stroke-opacity='.5' stroke-width='1'/><path d='M7 18 Q8 14 12 14' stroke='#fff' stroke-opacity='.7' stroke-width='2' fill='none' stroke-linecap='round'/></svg>`,
    balloon: (c) => `<svg ${NS} viewBox='0 0 30 44'><defs><radialGradient id='l${c.slice(1)}' cx='35%' cy='28%' r='80%'><stop offset='0' stop-color='#fff' stop-opacity='.85'/><stop offset='.3' stop-color='${c}'/><stop offset='1' stop-color='#000' stop-opacity='.35'/></radialGradient></defs><path d='M15 33 C5 30 2 20 2 15 C2 6 8 1 15 1 C22 1 28 6 28 15 C28 20 25 30 15 33Z' fill='${c}'/><path d='M15 33 C5 30 2 20 2 15 C2 6 8 1 15 1 C22 1 28 6 28 15 C28 20 25 30 15 33Z' fill='url(#l${c.slice(1)})'/><path d='M12.5 36 L17.5 36 L15 32.5Z' fill='${c}'/><path d='M15 36 Q10 39 15 41 Q20 43 15 44' stroke='#ccc' stroke-width='1' fill='none'/></svg>`,
    egg: (c) => `<svg ${NS} viewBox='0 0 30 44'><line x1='15' y1='0' x2='15' y2='9' stroke='#bbb' stroke-width='1.2'/><defs><clipPath id='e${c.slice(1)}'><path d='M15 8 C24 8 28 24 26 31 C24 38 6 38 4 31 C2 24 6 8 15 8Z'/></clipPath></defs><path d='M15 8 C24 8 28 24 26 31 C24 38 6 38 4 31 C2 24 6 8 15 8Z' fill='${c}'/><g clip-path='url(#e${c.slice(1)})'><path d='M0 22 L5 18 L10 22 L15 18 L20 22 L25 18 L30 22 L30 26 L25 22 L20 26 L15 22 L10 26 L5 22 L0 26Z' fill='#fff' fill-opacity='.85'/><circle cx='9' cy='31' r='1.6' fill='#fff' fill-opacity='.85'/><circle cx='15' cy='33' r='1.6' fill='#fff' fill-opacity='.85'/><circle cx='21' cy='31' r='1.6' fill='#fff' fill-opacity='.85'/><ellipse cx='10' cy='15' rx='2.4' ry='4.5' fill='#fff' fill-opacity='.4' transform='rotate(18 10 15)'/></g></svg>`,
    disco: () => `<svg ${NS} viewBox='0 0 30 44'><line x1='15' y1='0' x2='15' y2='10' stroke='#bbb' stroke-width='1.2'/><rect x='12' y='9' width='6' height='4' fill='#999'/><defs><radialGradient id='dsc' cx='35%' cy='30%' r='75%'><stop offset='0' stop-color='#fff'/><stop offset='.5' stop-color='#cfd6e6'/><stop offset='1' stop-color='#566'/></radialGradient><clipPath id='dscc'><circle cx='15' cy='28' r='14'/></clipPath></defs><circle cx='15' cy='28' r='14' fill='url(#dsc)'/><g clip-path='url(#dscc)' stroke='#667' stroke-width='.7' opacity='.8'><path d='M0 20 H30 M0 26 H30 M0 32 H30 M0 38 H30 M8 12 V44 M15 12 V44 M22 12 V44'/></g><rect x='10' y='20' width='4' height='4' fill='#fff' opacity='.9'/><rect x='19' y='30' width='4' height='4' fill='#ffd54a' opacity='.9'/></svg>`,
    lollipop: (c) => `<svg ${NS} viewBox='0 0 30 44'><line x1='15' y1='0' x2='15' y2='9' stroke='#bbb' stroke-width='1.2'/><rect x='14' y='22' width='2.4' height='21' rx='1.2' fill='#f4eadc'/><circle cx='15' cy='16' r='11' fill='${c}'/><path d='M15 16 m0 0 a3 3 0 1 1 3 3 a6 6 0 1 1 -7 -6 a9 9 0 1 1 9 11' stroke='#fff' stroke-width='2' fill='none' stroke-linecap='round'/></svg>`,

    // ---------- acessórios da logo (viewBox 0 0 64 52) ----------
    hat_natal: `<svg ${NS} viewBox='0 0 64 52'><defs><linearGradient id='sh' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#ff5566'/><stop offset='1' stop-color='#b3162a'/></linearGradient></defs><path d='M7 40 C9 16 24 6 40 8 C52 9 58 18 57 28 C50 24 44 28 42 36 Z' fill='url(#sh)'/><path d='M14 30 C20 18 30 14 40 14' stroke='#fff' stroke-opacity='.35' stroke-width='3' fill='none' stroke-linecap='round'/><path d='M3 38 C3 32 10 30 16 34 L50 40 C57 42 57 49 50 49 C32 51 14 50 6 46 C3 44 3 41 3 38Z' fill='#fff' stroke='#e5e7eb' stroke-width='1'/><circle cx='57' cy='27' r='7' fill='#fff' stroke='#e5e7eb' stroke-width='1'/></svg>`,
    hat_ano: `<svg ${NS} viewBox='0 0 64 52'><defs><linearGradient id='ph' x1='0' y1='1' x2='1' y2='0'><stop offset='0' stop-color='#ffd54a'/><stop offset='1' stop-color='#f08a00'/></linearGradient></defs><path d='M10 48 L34 4 L54 48 Z' fill='url(#ph)'/><path d='M17 36 L51 36 M24 24 L44 24' stroke='#fff' stroke-opacity='.8' stroke-width='3' stroke-dasharray='4 5'/><ellipse cx='32' cy='48' rx='23' ry='4.5' fill='#1b2a6b'/><circle cx='34' cy='5' r='5.5' fill='#fff'/><path d='M34 5 l-6 -4 M34 5 l7 -3 M34 5 l-1 -7' stroke='#ffd54a' stroke-width='1.6' stroke-linecap='round'/></svg>`,
    mask_carnaval: `<svg ${NS} viewBox='0 0 64 52'><defs><linearGradient id='mk' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#ff2e93'/><stop offset='1' stop-color='#7b2cff'/></linearGradient></defs><path d='M4 24 C4 14 22 12 32 18 C42 12 60 14 60 24 C60 36 46 40 40 32 C36 28 28 28 24 32 C18 40 4 36 4 24Z' fill='url(#mk)' stroke='#ffd600' stroke-width='2'/><ellipse cx='20' cy='25' rx='6' ry='4' fill='#1a0a26'/><ellipse cx='44' cy='25' rx='6' ry='4' fill='#1a0a26'/><path d='M8 18 Q16 12 26 17 M56 18 Q48 12 38 17' stroke='#ffd600' stroke-width='1.6' fill='none'/><path d='M52 14 C60 -2 70 4 62 14' fill='#00e676'/><path d='M50 12 C54 -4 64 0 58 12' fill='#ffd600'/><path d='M46 14 C46 2 56 0 54 12' fill='#2979ff'/></svg>`,
    ears_pascoa: `<svg ${NS} viewBox='0 0 64 52'><path d='M16 46 C6 30 8 6 18 4 C28 2 28 30 26 46Z' fill='#fff' stroke='#e6dff2' stroke-width='1.5'/><path d='M18 40 C13 28 14 12 18 10 C23 9 23 28 22 40Z' fill='#ffb3d1'/><path d='M38 46 C36 30 38 4 48 4 C58 6 58 30 48 46Z' fill='#fff' stroke='#e6dff2' stroke-width='1.5'/><path d='M42 40 C41 28 42 12 47 10 C51 12 52 28 47 40Z' fill='#ffb3d1'/></svg>`,
    heart_namorados: `<svg ${NS} viewBox='0 0 64 52'><defs><radialGradient id='hh' cx='35%' cy='30%' r='80%'><stop offset='0' stop-color='#ffd0dc'/><stop offset='.35' stop-color='#ff4d79'/><stop offset='1' stop-color='#9c0f3c'/></radialGradient></defs><path d='M32 50 C10 36 4 26 4 18 C4 9 11 4 18 4 C24 4 29 7 32 12 C35 7 40 4 46 4 C53 4 60 9 60 18 C60 26 54 36 32 50Z' fill='url(#hh)' stroke='#fff' stroke-opacity='.6' stroke-width='1.5'/><path d='M12 18 Q13 10 21 9' stroke='#fff' stroke-opacity='.8' stroke-width='3' fill='none' stroke-linecap='round'/><path d='M2 40 L58 6' stroke='#e6c35c' stroke-width='2.4'/><path d='M58 6 l-9 1 M58 6 l-3 8' stroke='#e6c35c' stroke-width='2.4' stroke-linecap='round'/></svg>`,
    cap_criancas: `<svg ${NS} viewBox='0 0 64 52'><path d='M8 36 C8 14 56 14 56 36Z' fill='#22b8f0'/><path d='M32 22 C20 22 12 28 10 36 L32 36Z' fill='#ff7043'/><path d='M32 22 C44 22 52 28 54 36 L32 36Z' fill='#ffee58'/><path d='M6 36 H58 C58 41 50 43 32 43 C14 43 6 41 6 36Z' fill='#7b4bd8'/><circle cx='32' cy='17' r='4' fill='#fff' stroke='#ccc'/><rect x='30.8' y='6' width='2.4' height='9' fill='#555'/><path d='M32 6 C22 2 14 6 12 10 M32 6 C42 2 50 6 52 10' stroke='#e8e8e8' stroke-width='3' stroke-linecap='round' fill='none'/></svg>`,

    // ---------- voadores que atravessam a tela ----------
    // Trenó do Papai Noel com 2 renas (nariz vermelho brilhando)
    sleigh: () => {
      const rein = (x) => `<g transform='translate(${x} 40)'>
        <g class='pv2-leg' style='animation-delay:-.1s'><path d='M14 38 L10 56' stroke='#7b4b22' stroke-width='4.5' stroke-linecap='round'/></g>
        <g class='pv2-leg' style='animation-delay:-.3s'><path d='M22 38 L26 56' stroke='#8d5a2b' stroke-width='4.5' stroke-linecap='round'/></g>
        <g class='pv2-leg' style='animation-delay:-.2s'><path d='M42 38 L38 56' stroke='#7b4b22' stroke-width='4.5' stroke-linecap='round'/></g>
        <g class='pv2-leg' style='animation-delay:-.4s'><path d='M50 38 L54 56' stroke='#8d5a2b' stroke-width='4.5' stroke-linecap='round'/></g>
        <ellipse cx='30' cy='30' rx='25' ry='12' fill='#9a6233'/><ellipse cx='30' cy='35' rx='19' ry='6' fill='#d9b48a' fill-opacity='.55'/>
        <path d='M48 24 Q58 14 60 6 L69 10 Q65 24 55 34Z' fill='#9a6233'/>
        <ellipse cx='71' cy='10' rx='10' ry='7' transform='rotate(18 71 10)' fill='#a96d38'/>
        <circle cx='72' cy='9' r='1.5' fill='#222'/><circle cx='80' cy='14' r='3.6' fill='#ff2a2a' class='pv2-nose'/>
        <path d='M66 4 Q63 -7 56 -11 M62 -3 Q55 -5 51 -4 M70 3 Q73 -7 80 -10 M73 -2 Q80 -4 84 -1' stroke='#e0c08a' stroke-width='2.2' fill='none' stroke-linecap='round'/>
        <circle cx='5' cy='26' r='4' fill='#fff'/></g>`;
      return `<svg ${NS} viewBox='0 0 400 130' class='pv2-art-sleigh'>
        <path d='M96 62 L206 82 M168 70 L206 82' stroke='#e6c35c' stroke-width='1.6' fill='none'/>
        ${rein(14)}${rein(94)}
        <g transform='translate(200 34)'>
          <path d='M-4 66 Q-10 66 -10 56 M-4 66 L100 66 Q114 66 114 52' stroke='#e6c35c' stroke-width='4.5' fill='none' stroke-linecap='round'/>
          <path d='M16 66 L16 50 M84 66 L84 50' stroke='#e6c35c' stroke-width='3'/>
          <path d='M2 50 L8 22 Q10 14 22 14 L88 14 Q102 14 108 26 L114 40 Q114 52 100 52Z' fill='#d62839' stroke='#9c1626' stroke-width='1.5'/>
          <path d='M5 42 L112 42' stroke='#e6c35c' stroke-width='3'/>
          <path d='M108 26 Q124 18 118 6' stroke='#e6c35c' stroke-width='3.5' fill='none' stroke-linecap='round'/>
          <ellipse cx='84' cy='8' rx='20' ry='15' fill='#b57a43'/><path d='M74 -4 Q84 -12 94 -4' stroke='#8a5a2e' stroke-width='3' fill='none'/>
          <rect x='72' y='-10' width='11' height='11' rx='2' fill='#2ecc71' transform='rotate(-14 77 -4)'/><rect x='84' y='-12' width='10' height='10' rx='2' fill='#4aa8ff' transform='rotate(12 89 -7)'/>
          <ellipse cx='42' cy='10' rx='15' ry='16' fill='#e02a3d'/>
          <rect x='27' y='10' width='30' height='4' fill='#1b1b1b'/><rect x='38' y='9' width='8' height='6' rx='1' fill='#e6c35c'/>
          <circle cx='42' cy='-13' r='9.5' fill='#ffd2b0'/><circle cx='39' cy='-14' r='1.3' fill='#222'/><circle cx='46' cy='-14' r='1.3' fill='#222'/><circle cx='42.5' cy='-10' r='2' fill='#f2a38a'/>
          <path d='M32 -9 Q42 12 52 -9 Q47 -3 42 -4 Q37 -3 32 -9Z' fill='#fff'/><path d='M34 -12 Q42 -2 50 -12' fill='#fff'/>
          <path d='M32 -17 Q36 -40 56 -26 Q47 -23 49 -17Z' fill='#e02a3d'/>
          <rect x='31' y='-19' width='20' height='6' rx='3' fill='#fff'/><circle cx='57' cy='-26' r='4.6' fill='#fff'/>
          <g class='pv2-wave'><path d='M55 8 Q70 -2 76 -10' stroke='#e02a3d' stroke-width='7' stroke-linecap='round' fill='none'/><circle cx='77' cy='-11' r='4.5' fill='#fff'/></g>
        </g>
        <g class='pv2-twinkle' fill='#fff'><path d='M0 30 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z'/><path d='M30 108 l1.6 4 4 1.6 -4 1.6 -1.6 4 -1.6 -4 -4 -1.6 4 -1.6z'/><path d='M160 122 l1.6 4 4 1.6 -4 1.6 -1.6 4 -1.6 -4 -4 -1.6 4 -1.6z'/></g></svg>`;
    },
    // Cometa dourado com cauda
    comet: () => `<svg ${NS} viewBox='0 0 360 90'><defs><linearGradient id='ct' x1='0' y1='0' x2='1' y2='0'><stop offset='0' stop-color='#ffd54a' stop-opacity='0'/><stop offset='.7' stop-color='#ffd54a' stop-opacity='.55'/><stop offset='1' stop-color='#fff' stop-opacity='.95'/></linearGradient></defs><path d='M0 46 Q150 36 292 44 L292 48 Q150 56 0 46Z' fill='url(#ct)'/><path d='M40 52 Q150 50 290 50' stroke='#fff' stroke-opacity='.4' stroke-width='1.2' fill='none'/><path d='M318 14 L328 38 L354 40 L334 56 L342 82 L318 66 L294 82 L302 56 L282 40 L308 38Z' fill='#ffd54a' stroke='#fff' stroke-width='2' stroke-linejoin='round' transform='translate(-4 -2) scale(.95)'/><g class='pv2-twinkle' fill='#fff'><path d='M90 26 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z'/><path d='M180 70 l1.6 4 4 1.6 -4 1.6 -1.6 4 -1.6 -4 -4 -1.6 4 -1.6z'/><path d='M240 22 l1.6 4 4 1.6 -4 1.6 -1.6 4 -1.6 -4 -4 -1.6 4 -1.6z'/></g></svg>`,
    // Bandeirinhas coloridas ondulando
    bunting: () => {
      const cols = ['#ff2e93', '#00c853', '#ffd600', '#2979ff', '#ff6d00', '#b44bff', '#00e5ff', '#ff4d4d'];
      let flags = '';
      for (let i = 0; i < 8; i++) { const x = 20 + i * 44, y = 14 + Math.sin(i * 0.9) * 8; flags += `<path d='M${x} ${y} L${x + 36} ${y + 2} L${x + 18} ${y + 40}Z' fill='${cols[i]}' stroke='#fff' stroke-opacity='.4' stroke-width='1'/>`; }
      return `<svg ${NS} viewBox='0 0 380 70'><path d='M4 12 Q100 28 190 12 T376 14' stroke='#444' stroke-width='2' fill='none' transform='translate(0 -2)'/>${flags}</svg>`;
    },
    // Coelhinho (silhueta branca com orelhas rosas)
    bunny: () => `<svg ${NS} viewBox='0 0 120 100'><ellipse cx='50' cy='66' rx='32' ry='22' fill='#fff' stroke='#e6dff2' stroke-width='2'/><circle cx='84' cy='46' r='17' fill='#fff' stroke='#e6dff2' stroke-width='2'/><path d='M76 34 C66 8 70 -2 78 0 C88 4 86 24 86 34Z' fill='#fff' stroke='#e6dff2' stroke-width='2'/><path d='M80 30 C74 12 75 6 78 6 C82 8 82 20 83 30Z' fill='#ffb3d1'/><path d='M90 34 C94 10 104 4 108 10 C110 18 98 28 96 38Z' fill='#fff' stroke='#e6dff2' stroke-width='2'/><path d='M94 30 C96 16 102 12 104 14 C104 20 99 26 97 32Z' fill='#ffb3d1'/><circle cx='90' cy='44' r='2.2' fill='#333'/><ellipse cx='98' cy='50' rx='2.6' ry='2' fill='#ff8fb0'/><path d='M96 53 Q93 57 89 54' stroke='#d96b92' stroke-width='1.5' fill='none' stroke-linecap='round'/><circle cx='20' cy='62' r='9' fill='#fff' stroke='#e6dff2' stroke-width='2'/><ellipse cx='36' cy='86' rx='16' ry='8' fill='#fff' stroke='#e6dff2' stroke-width='2'/><ellipse cx='72' cy='88' rx='13' ry='6' fill='#fff' stroke='#e6dff2' stroke-width='2'/></svg>`,
    // Flecha de cupido com coração
    arrow: () => `<svg ${NS} viewBox='0 0 300 70'><defs><radialGradient id='ah' cx='35%' cy='30%' r='80%'><stop offset='0' stop-color='#ffd0dc'/><stop offset='.4' stop-color='#ff4d79'/><stop offset='1' stop-color='#9c0f3c'/></radialGradient></defs><path d='M10 35 L246 35' stroke='#e6c35c' stroke-width='4' stroke-linecap='round'/><path d='M4 35 L20 21 L30 35 L20 49Z M24 35 L40 21 L50 35 L40 49Z' fill='#ff4d79'/><path d='M244 33 L252 20 L256 35 L252 50 L244 37Z' fill='#e6c35c'/><path transform='translate(250 6) scale(1.5)' d='M15 30 C3 21 1 14 1 10 C1 4 5 1 9 1 C12 1 14 2.5 15 5 C16 2.5 18 1 21 1 C25 1 29 4 29 10 C29 14 27 21 15 30Z' fill='url(#ah)' stroke='#fff' stroke-opacity='.65' stroke-width='1'/><path d='M262 20 Q263 14 270 14' stroke='#fff' stroke-opacity='.8' stroke-width='3' fill='none' stroke-linecap='round'/><g class='pv2-twinkle' fill='#ff9ab5'><path d='M70 12 c-4 -5 -10 0 -5 5 l5 5 5 -5 c5 -5 -1 -10 -5 -5z'/><path d='M130 52 c-3 -4 -8 0 -4 4 l4 4 4 -4 c4 -4 -1 -8 -4 -4z'/><path d='M180 14 c-3 -4 -8 0 -4 4 l4 4 4 -4 c4 -4 -1 -8 -4 -4z'/></g></svg>`,
    // Aviãozinho de papel com rastro
    plane: () => `<svg ${NS} viewBox='0 0 300 100'><path d='M4 80 C40 90 60 40 100 56 C130 68 150 40 190 44' stroke='#fff' stroke-opacity='.75' stroke-width='2.4' stroke-dasharray='2 9' stroke-linecap='round' fill='none'/><path d='M196 40 L292 12 L236 74 L222 56Z' fill='#fff' stroke='#c7d3e0' stroke-width='1.5' stroke-linejoin='round'/><path d='M196 40 L222 56 L212 76Z' fill='#cfe2f3' stroke='#c7d3e0' stroke-width='1.5' stroke-linejoin='round'/><path d='M222 56 L292 12 L238 66Z' fill='#22b8f0' fill-opacity='.35'/></svg>`,
  };
  const svgUri = (svg) => 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '")';


  // ---------- preferências de efeitos/mascote (salvas no navegador) ----------
  const PREFS_KEY = 'pv2_fx_prefs_v1';
  const prefsState = { mascot: true, decor: true, scene: true, drops: true, talk: true, quiz: true, intensity: 'normal', name: '', variant: {} };
  if (!global.__PV2_STAGE) { try { Object.assign(prefsState, JSON.parse(global.localStorage.getItem(PREFS_KEY) || '{}')); } catch (_) { /* sem storage */ } }
  const getPrefs = () => prefsState;
  function setPrefs(patch) {
    if (patch.variant) patch.variant = Object.assign({}, prefsState.variant, patch.variant);
    Object.assign(prefsState, patch);
    if (!global.__PV2_STAGE) { try { global.localStorage.setItem(PREFS_KEY, JSON.stringify(prefsState)); } catch (_) { /* sem storage */ } }
    const th = global.PlusV2LiveCurrentTheme;
    if (th) { applyScene(th); applyDecor(th); }
  }
  const densityFactor = () => ({ leve: 0.5, normal: 1, intenso: 1.5 }[prefsState.intensity] || 1);

  const CANVAS_SCENES = new Set(['stars', 'embers', 'matrix', 'petals', 'snow', 'confetti', 'fireworks', 'hearts', 'balloons', 'easter']);
  const CSS_SCENES = new Set(['aurora', 'grid', 'waves']);
  let sceneStop = null;
  let sceneApi = null;
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
    const COUNT = { stars: 90, embers: 46, petals: 34, snow: 70, confetti: 70, hearts: 26, balloons: 14, easter: 24 }[mode] || 0;
    const GLYPHS = { hearts: ['💗', '💖', '❤️', '💘', '💕'], easter: ['🥚', '🐣', '🌷', '🐰', '🥕'] }[mode] || [];
    const rockets = [], sparks = [];
    let nextRocket = 0;
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
        g: GLYPHS.length ? GLYPHS[Math.floor(Math.random() * GLYPHS.length)] : '', rot: rnd(0, 6.28),
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
        // v0.91.5: colunas recalculadas a cada quadro (antes ficavam vazias se a
        // tela ainda tinha largura 0 quando o tema era aplicado) e canvas
        // redimensionado sozinho se o layout mudou depois.
        if (!W || !H || canvas.width !== Math.floor(canvas.clientWidth * dpr)) size();
        if (!W || !H) return;
        const fs = 16 * dpr;
        const need = Math.ceil(W / fs);
        while (cols.length < need) cols.push(Math.random() * -40);
        cols.length = need;
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = 'rgba(0,0,0,0.16)';
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'source-over';
        ctx.font = fs + 'px monospace';
        ctx.textBaseline = 'top';
        const col = colors[0] || '#00ff66';
        for (let i = 0; i < cols.length; i++) {
          // v0.97.7 — Matrix SUTIL: só 1 coluna a cada 3 desenha, sem cabeça branca e sem brilho
          if (i % 3 === 0) {
            const ch = String.fromCharCode(0x30A0 + Math.floor(Math.random() * 96));
            const y = cols[i] * fs;
            if (y >= -fs) { ctx.globalAlpha = 0.55; ctx.fillStyle = col; ctx.shadowBlur = 0; ctx.fillText(ch, i * fs, y); }
          }
          ctx.globalAlpha = 1;
          if (cols[i] * fs > H && Math.random() > 0.975) cols[i] = Math.random() * -12;
          cols[i] += 0.35 + (i % 5) * 0.06;
        }
        return;
      }
      if (mode === 'fireworks') {
        // rastro: apaga um pouquinho a cada quadro em vez de limpar tudo
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'source-over';
        if (t > nextRocket) {
          nextRocket = t + rnd(500, 1300);
          rockets.push({ x: rnd(W * 0.1, W * 0.9), y: H, ty: rnd(H * 0.12, H * 0.5), c: colors[Math.floor(Math.random() * colors.length)] });
        }
        for (let i = rockets.length - 1; i >= 0; i--) {
          const r = rockets[i];
          r.y -= 9 * dpr;
          ctx.globalAlpha = 1; ctx.fillStyle = '#fff';
          ctx.beginPath(); ctx.arc(r.x, r.y, 2 * dpr, 0, 6.283); ctx.fill();
          if (r.y <= r.ty) {
            const n = 46;
            for (let k = 0; k < n; k++) {
              const a = (k / n) * 6.283, sp = rnd(1.5, 5) * dpr;
              sparks.push({ x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, c: r.c });
            }
            rockets.splice(i, 1);
          }
        }
        for (let i = sparks.length - 1; i >= 0; i--) {
          const sp = sparks[i];
          sp.x += sp.vx; sp.y += sp.vy; sp.vy += 0.06 * dpr; sp.vx *= 0.985; sp.life -= 0.016;
          if (sp.life <= 0) { sparks.splice(i, 1); continue; }
          ctx.globalAlpha = sp.life; ctx.fillStyle = sp.c;
          ctx.beginPath(); ctx.arc(sp.x, sp.y, 2.2 * dpr, 0, 6.283); ctx.fill();
        }
        ctx.globalAlpha = 1;
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
        } else if (mode === 'confetti') {
          it.y += (1 + it.v * 2) * dpr; it.x += Math.sin(it.p += 0.05) * 1.3 * dpr; it.rot += 0.08;
          if (it.y > H + 10) { it.y = -10; it.x = rnd(0, W); }
          ctx.globalAlpha = 0.9; ctx.fillStyle = it.c;
          ctx.save(); ctx.translate(it.x, it.y); ctx.rotate(it.rot);
          ctx.fillRect(-it.r * 1.6, -it.r * 0.7, it.r * 3.2, it.r * 1.4); ctx.restore();
        } else if (mode === 'hearts') {
          it.y -= (0.5 + it.v) * dpr; it.x += Math.sin(it.p += 0.025) * 0.7 * dpr;
          if (it.y < -30) { it.y = H + 30; it.x = rnd(0, W); }
          ctx.globalAlpha = 0.8; ctx.font = Math.round((10 + it.r * 4) * dpr) + 'px serif';
          ctx.fillText(it.g, it.x, it.y);
        } else if (mode === 'easter') {
          it.y += (0.6 + it.v * 0.9) * dpr; it.x += Math.sin(it.p += 0.02) * 0.8 * dpr;
          if (it.y > H + 30) { it.y = -30; it.x = rnd(0, W); }
          ctx.globalAlpha = 0.85; ctx.font = Math.round((14 + it.r * 4) * dpr) + 'px serif';
          ctx.fillText(it.g, it.x, it.y);
        } else if (mode === 'balloons') {
          it.y -= (0.45 + it.v * 0.7) * dpr; it.x += Math.sin(it.p += 0.02) * 0.6 * dpr;
          const bw = (14 + it.r * 4) * dpr, bh = bw * 1.25;
          if (it.y < -bh * 2) { it.y = H + bh * 2; it.x = rnd(0, W); }
          ctx.globalAlpha = 0.85; ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = dpr;
          ctx.beginPath(); ctx.moveTo(it.x, it.y + bh); ctx.quadraticCurveTo(it.x - 6 * dpr, it.y + bh * 1.6, it.x, it.y + bh * 2.1); ctx.stroke();
          ctx.fillStyle = it.c; ctx.beginPath(); ctx.ellipse(it.x, it.y, bw, bh, 0, 0, 6.283); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.ellipse(it.x - bw * 0.35, it.y - bh * 0.35, bw * 0.18, bh * 0.28, -0.5, 0, 6.283); ctx.fill();
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

  // =========================================================================
  // v0.86.0 — MOTOR "RICO" DAS CENAS INTERATIVAS (canvas, tudo desenhado)
  // =========================================================================
  // Cena de fundo (atrás dos painéis) + camada de efeitos na FRENTE de tudo
  // (#plus2-fx, pointer-events:none, então nunca atrapalha cliques). Interações:
  //  - balões: passar o mouse empurra; clicar num balão ESTOURA (cacos +
  //    confete); clicar no vazio SOLTA balões novos
  //  - fogos de artifício: clique lança um foguete até o ponto (fogos em
  //    círculo, anel, salgueiro e em formato de CORAÇÃO)
  //  - neve: o mouse sopra os flocos; clique solta uma rajada de cristais
  //  - corações: clique faz chover corações; confete: clique é um canhão
  //  - ovos de Páscoa: clique quebra o ovo em pedacinhos coloridos
  const RICH_SCENES = new Set(['snow', 'fireworks', 'confetti', 'hearts', 'balloons', 'easter']);

  function mixHex(hex, amt) {
    const c = hexToRgb(hex);
    const t = amt >= 0 ? 255 : 0, k = Math.abs(amt);
    const f = (v) => Math.round(v + (t - v) * k);
    return `rgb(${f(c.r)},${f(c.g)},${f(c.b)})`;
  }
  function pathHeart(c, s) {
    c.beginPath();
    c.moveTo(0, 0.38 * s);
    c.bezierCurveTo(-0.12 * s, 0.28 * s, -0.55 * s, 0.06 * s, -0.55 * s, -0.2 * s);
    c.bezierCurveTo(-0.55 * s, -0.5 * s, -0.12 * s, -0.55 * s, 0, -0.26 * s);
    c.bezierCurveTo(0.12 * s, -0.55 * s, 0.55 * s, -0.5 * s, 0.55 * s, -0.2 * s);
    c.bezierCurveTo(0.55 * s, 0.06 * s, 0.12 * s, 0.28 * s, 0, 0.38 * s);
    c.closePath();
  }
  function drawHeart(c, x, y, s, col, rot, alpha, glow) {
    c.save(); c.translate(x, y); c.rotate(rot || 0); c.globalAlpha = alpha;
    pathHeart(c, s);
    const g = c.createRadialGradient(-0.18 * s, -0.28 * s, 0.02 * s, 0, 0, 0.7 * s);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.22, mixHex(col, 0.2)); g.addColorStop(0.7, col); g.addColorStop(1, mixHex(col, -0.4));
    c.fillStyle = g; c.shadowColor = col; c.shadowBlur = glow || 0; c.fill(); c.shadowBlur = 0;
    c.fillStyle = 'rgba(255,255,255,0.55)';
    c.beginPath(); c.ellipse(-0.26 * s, -0.3 * s, 0.1 * s, 0.17 * s, -0.6, 0, 6.283); c.fill();
    c.restore();
  }
  function drawFlake(c, x, y, r, rot, col, alpha, lw) {
    c.save(); c.translate(x, y); c.rotate(rot); c.globalAlpha = alpha; c.strokeStyle = col; c.lineWidth = lw; c.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      c.rotate(1.0472);
      c.beginPath(); c.moveTo(0, 0); c.lineTo(r, 0);
      c.moveTo(r * 0.55, 0); c.lineTo(r * 0.8, r * 0.26); c.moveTo(r * 0.55, 0); c.lineTo(r * 0.8, -r * 0.26);
      c.moveTo(r * 0.3, 0); c.lineTo(r * 0.45, r * 0.15); c.moveTo(r * 0.3, 0); c.lineTo(r * 0.45, -r * 0.15);
      c.stroke();
    }
    c.restore();
  }
  function drawSpark(c, x, y, r, rot, col, alpha) {
    c.save(); c.translate(x, y); c.rotate(rot); c.globalAlpha = alpha; c.fillStyle = col;
    c.beginPath();
    for (let i = 0; i < 8; i++) { const a = i * 0.7854, rr = i % 2 ? r * 0.28 : r; c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
    c.closePath(); c.fill(); c.restore();
  }
  function drawBalloon(c, x, y, w, h, col, alpha, tilt) {
    c.save(); c.translate(x, y); c.rotate(tilt || 0); c.globalAlpha = alpha;
    c.beginPath(); c.moveTo(0, h);
    c.bezierCurveTo(-w * 0.2, h * 0.92, -w, h * 0.35, -w, -h * 0.1);
    c.bezierCurveTo(-w, -h * 0.8, -w * 0.3, -h, 0, -h);
    c.bezierCurveTo(w * 0.3, -h, w, -h * 0.8, w, -h * 0.1);
    c.bezierCurveTo(w, h * 0.35, w * 0.2, h * 0.92, 0, h); c.closePath();
    const g = c.createRadialGradient(-w * 0.35, -h * 0.4, w * 0.05, 0, 0, h * 1.15);
    g.addColorStop(0, mixHex(col, 0.65)); g.addColorStop(0.35, col); g.addColorStop(1, mixHex(col, -0.45));
    c.fillStyle = g; c.fill();
    c.fillStyle = mixHex(col, -0.3);
    c.beginPath(); c.moveTo(-w * 0.14, h + w * 0.2); c.lineTo(w * 0.14, h + w * 0.2); c.lineTo(0, h * 0.97); c.closePath(); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.45)';
    c.beginPath(); c.ellipse(-w * 0.38, -h * 0.42, w * 0.16, h * 0.27, -0.55, 0, 6.283); c.fill();
    c.restore();
  }
  function drawEgg(c, x, y, w, h, rot, col, alpha, style) {
    c.save(); c.translate(x, y); c.rotate(rot); c.globalAlpha = alpha;
    c.beginPath(); c.moveTo(0, -h);
    c.bezierCurveTo(w * 0.85, -h, w, h * 0.25, w * 0.7, h * 0.7);
    c.bezierCurveTo(w * 0.45, h * 1.05, -w * 0.45, h * 1.05, -w * 0.7, h * 0.7);
    c.bezierCurveTo(-w, h * 0.25, -w * 0.85, -h, 0, -h); c.closePath();
    const g = c.createRadialGradient(-w * 0.3, -h * 0.35, w * 0.05, 0, 0, h * 1.2);
    g.addColorStop(0, mixHex(col, 0.55)); g.addColorStop(0.5, col); g.addColorStop(1, mixHex(col, -0.35));
    c.fillStyle = g; c.fill();
    c.save(); c.clip();
    c.strokeStyle = 'rgba(255,255,255,0.85)'; c.fillStyle = 'rgba(255,255,255,0.85)'; c.lineWidth = Math.max(1.5, w * 0.12);
    if (style === 0) {
      c.beginPath(); for (let i = -4; i <= 4; i++) c.lineTo(i * w * 0.28, h * 0.05 + (i % 2 ? w * 0.22 : -w * 0.22)); c.stroke();
    } else if (style === 1) {
      for (let i = -2; i <= 2; i++) { c.beginPath(); c.arc(i * w * 0.4, h * 0.2, w * 0.1, 0, 6.283); c.fill(); }
      for (let i = -1; i <= 1; i++) { c.beginPath(); c.arc(i * w * 0.4 + w * 0.2, h * 0.5, w * 0.09, 0, 6.283); c.fill(); }
    } else {
      c.beginPath(); c.moveTo(-w, h * 0.1);
      for (let i = 0; i <= 8; i++) c.quadraticCurveTo(-w + (i + 0.5) * w * 0.25, h * 0.1 + (i % 2 ? w * 0.2 : -w * 0.2), -w + (i + 1) * w * 0.25, h * 0.1);
      c.stroke();
    }
    c.restore();
    c.fillStyle = 'rgba(255,255,255,0.4)';
    c.beginPath(); c.ellipse(-w * 0.35, -h * 0.35, w * 0.14, h * 0.24, -0.4, 0, 6.283); c.fill();
    c.restore();
  }

  function startRichScene(canvas, fg, mode, theme) {
    const ctx = canvas.getContext('2d');
    const fx = fg.getContext('2d');
    if (!ctx || !fx) return { stop() {}, hit() {} };
    const col = theme.colors;
    const PAL = {
      balloons: [col.primary, col.secondary, col.highlight, '#7bd88f', '#c084fc', '#ff7a7a'],
      confetti: [col.primary, col.secondary, col.highlight, '#ffffff', '#4dd0ff', '#b6ff6b'],
      fireworks: [col.primary, col.highlight, '#ffffff', '#ff6b6b', '#6bc5ff', '#b78cff'],
      hearts: [col.primary, mixHex(col.primary, 0.25), col.highlight, '#ff7aa8'],
      easter: [col.primary, col.secondary, col.highlight, '#8ee0c3', '#ffb86b'],
      snow: ['#ffffff', col.highlight],
    }[mode];
    const dpr = Math.min(global.devicePixelRatio || 1, 2);
    let W = 0, H = 0;
    function size() {
      W = canvas.width = Math.floor(canvas.clientWidth * dpr); H = canvas.height = Math.floor(canvas.clientHeight * dpr);
      fg.width = W; fg.height = H;
    }
    size();
    global.addEventListener('resize', size);
    const rnd = (a, b) => a + Math.random() * (b - a);
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    const mouse = { x: -9999, y: -9999 };
    const parts = [];   // partículas da camada da frente
    const rockets = [];

    // ---------- itens ambientes ----------
    const N = Math.round({ snow: 120, confetti: 90, hearts: 26, balloons: 15, easter: 20, fireworks: 70 }[mode] * densityFactor());
    const items = [];
    function spawn(it, fresh) {
      it.x = rnd(0, W); it.vx = 0; it.p = rnd(0, 6.28); it.c = pick(PAL); it.rot = rnd(0, 6.28); it.vr = rnd(-0.03, 0.03);
      it.v = rnd(0.35, 1);
      if (mode === 'snow') { it.r = Math.pow(Math.random(), 2.2) * 3.4 + 0.8; it.crystal = it.r > 2.6; it.y = fresh ? rnd(-H, H) : -10; }
      else if (mode === 'confetti') { it.r = rnd(3, 6); it.ribbon = Math.random() < 0.3; it.y = fresh ? rnd(-H, H) : -12; it.len = rnd(14, 30); }
      else if (mode === 'hearts') { it.r = rnd(14, 42); it.y = fresh ? rnd(0, H) : H + 40; }
      else if (mode === 'balloons') { it.w = rnd(17, 31) * dpr; it.h = it.w * 1.25; it.y = fresh ? rnd(0, H) : H + it.h * 2.5; it.sw = rnd(0.012, 0.03); }
      else if (mode === 'easter') { it.w = rnd(11, 19) * dpr; it.h = it.w * 1.3; it.style = Math.floor(rnd(0, 3)); it.y = fresh ? rnd(-H * 0.5, H) : -it.h * 2; }
      else if (mode === 'fireworks') { it.r = rnd(0.5, 1.6) * dpr; it.y = rnd(0, H * 0.8); it.p = rnd(0, 6.28); }
      return it;
    }
    for (let i = 0; i < N; i++) items.push(spawn({}, true));

    // ---------- partículas da frente ----------
    function burst(x, y, kind, n, opts) {
      opts = opts || {};
      for (let i = 0; i < n; i++) {
        const a = opts.cone ? -1.5708 + rnd(-opts.cone, opts.cone) : rnd(0, 6.283);
        const sp = rnd(opts.min || 2, opts.max || 7) * dpr;
        parts.push({
          kind, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, decay: opts.decay || rnd(0.008, 0.016),
          g: (opts.g === undefined ? 0.12 : opts.g) * dpr, drag: opts.drag || 0.985, size: (opts.size || rnd(3, 7)) * dpr,
          c: opts.color || pick(PAL), rot: rnd(0, 6.28), vr: rnd(-0.25, 0.25), flip: rnd(0, 6.28), glow: opts.glow || 0,
        });
      }
    }
    function explode(x, y) {
      const type = pick(['peony', 'ring', 'willow', 'heart', 'peony', 'heart']);
      const c1 = pick(PAL), c2 = pick(PAL);
      const n = type === 'ring' ? 56 : type === 'heart' ? 70 : type === 'willow' ? 48 : 80;
      for (let i = 0; i < n; i++) {
        let vx, vy, decay = rnd(0.011, 0.019), g = 0.05 * dpr;
        const t = (i / n) * 6.283;
        if (type === 'heart') {
          const k = 0.3 * dpr;
          vx = 16 * Math.pow(Math.sin(t), 3) * k; vy = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) * k;
        } else if (type === 'ring') { vx = Math.cos(t) * 4.6 * dpr; vy = Math.sin(t) * 4.6 * dpr; }
        else if (type === 'willow') { const sp = rnd(1, 3.8) * dpr; vx = Math.cos(t) * sp; vy = Math.sin(t) * sp; decay = rnd(0.005, 0.009); g = 0.075 * dpr; }
        else { const sp = rnd(1, 5.6) * dpr; vx = Math.cos(t) * sp; vy = Math.sin(t) * sp; }
        parts.push({ kind: 'fire', x, y, vx, vy, life: 1, decay, g, drag: 0.987, size: rnd(1.6, 2.8) * dpr, c: i % 5 === 0 ? c2 : c1, trail: type === 'willow' });
      }
      parts.push({ kind: 'flash', x, y, life: 1, decay: 0.09, size: 60 * dpr, c: c1, vx: 0, vy: 0, g: 0, drag: 1 });
    }
    function launch(x, ty) {
      rockets.push({ x, y: H + 10, ty: ty === undefined ? rnd(H * 0.12, H * 0.5) : ty, vx: rnd(-0.6, 0.6) * dpr });
    }

    // ---------- interação ----------
    function onMove(e) { mouse.x = e.clientX * dpr; mouse.y = e.clientY * dpr; }
    function onDown(e) {
      const x = e.clientX * dpr, y = e.clientY * dpr;
      hit(x, y);
    }
    function hit(x, y) {
      if (mode === 'balloons') {
        let best = null, bd = 1e9;
        items.forEach((it) => { const d = Math.hypot(it.x - x, it.y - y); if (d < it.w * 1.25 && d < bd) { best = it; bd = d; } });
        if (best) {
          burst(best.x, best.y, 'shard', 22, { color: best.c, min: 2, max: 8, g: 0.2, size: 6, decay: 0.02 });
          burst(best.x, best.y, 'confetti', 14, { min: 1, max: 6, g: 0.09 });
          burst(best.x, best.y, 'flash', 1, { min: 0, max: 0, size: 40, decay: 0.12, color: best.c });
          spawn(best, false);
        } else if (items.length < 46) {
          for (let k = 0; k < 3; k++) { const b = spawn({}, false); b.x = x + rnd(-50, 50) * dpr; b.temp = true; items.push(b); }
        }
      } else if (mode === 'fireworks') { launch(x, y); }
      else if (mode === 'snow') {
        burst(x, y, 'flake', 20, { min: 1.5, max: 6, g: 0.03, size: 8, decay: 0.009, color: '#ffffff' });
        burst(x, y, 'spark', 10, { min: 1, max: 5, g: 0.02, size: 5, decay: 0.014, color: '#ffe9a8' });
      } else if (mode === 'confetti') { burst(x, y, 'confetti', 70, { cone: 0.9, min: 5, max: 15, g: 0.18, decay: 0.008, size: 5 }); burst(x, y, 'ribbon', 16, { cone: 0.9, min: 5, max: 12, g: 0.14, decay: 0.008 }); }
      else if (mode === 'hearts') { burst(x, y, 'heart', 18, { min: 1.5, max: 6, g: -0.03, size: 16, decay: 0.01, glow: 10 }); burst(x, y, 'spark', 10, { min: 1, max: 5, g: 0, size: 5, decay: 0.02 }); }
      else if (mode === 'easter') {
        let best = null, bd = 1e9;
        items.forEach((it) => { const d = Math.hypot(it.x - x, it.y - y); if (d < it.w * 1.6 && d < bd) { best = it; bd = d; } });
        if (best) { burst(best.x, best.y, 'shard', 20, { color: best.c, min: 2, max: 7, g: 0.2, size: 6, decay: 0.018 }); burst(best.x, best.y, 'spark', 10, { min: 1, max: 5, g: 0.02, size: 6, decay: 0.02, color: '#fff3a0' }); spawn(best, false); }
        else burst(x, y, 'confetti', 24, { min: 2, max: 8, g: 0.1, size: 4 });
      }
    }
    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerdown', onDown, { passive: true });

    // ---------- loop ----------
    let raf = 0, last = 0, running = true, nextAuto = 0;
    function frame(t) {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      const dt = Math.min(48, t - (last || t)) / 16.67; last = t;
      ctx.clearRect(0, 0, W, H);
      const wind = Math.sin(t / 3800) * 0.35 + Math.sin(t / 1300) * 0.12;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        // empurrão do mouse
        const dx = it.x - mouse.x, dy = it.y - mouse.y, d = Math.hypot(dx, dy), R = 130 * dpr;
        if (d < R && d > 1 && mode !== 'fireworks') { const f = (1 - d / R) * 1.6 * dpr; it.vx += (dx / d) * f * dt * 0.6; it.y += (dy / d) * f * dt * 0.4; }
        it.vx *= 0.94; it.x += it.vx * dt;
        if (mode === 'snow') {
          it.p += 0.02 * dt; it.rot += it.vr * dt;
          it.y += (0.5 + it.r * 0.42) * dpr * dt; it.x += (Math.sin(it.p) * 0.45 + wind * (0.6 + it.r * 0.25)) * dpr * dt;
          if (it.y > H + 12) spawn(it, false);
          if (it.crystal) drawFlake(ctx, it.x, it.y, it.r * 3.4 * dpr, it.rot, '#ffffff', 0.9, Math.max(1, it.r * 0.35 * dpr));
          else { ctx.globalAlpha = 0.35 + it.v * 0.5; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(it.x, it.y, it.r * dpr, 0, 6.283); ctx.fill(); }
        } else if (mode === 'confetti') {
          it.p += 0.06 * dt; it.rot += 0.1 * dt;
          it.y += (1 + it.v * 2) * dpr * dt; it.x += Math.sin(it.p) * 1.3 * dpr * dt;
          if (it.y > H + 30) spawn(it, false);
          ctx.globalAlpha = 0.92; ctx.fillStyle = ctx.strokeStyle = it.c;
          ctx.save(); ctx.translate(it.x, it.y); ctx.rotate(it.rot);
          if (it.ribbon) { ctx.lineWidth = 2.2 * dpr; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(0, -it.len * dpr / 2); for (let k = 1; k <= 4; k++) ctx.quadraticCurveTo((k % 2 ? 7 : -7) * dpr, (-it.len / 2 + k * it.len / 4 - it.len / 8) * dpr, 0, (-it.len / 2 + k * it.len / 4) * dpr); ctx.stroke(); }
          else { ctx.scale(1, Math.abs(Math.cos(it.p * 1.5)) * 0.9 + 0.1); ctx.fillRect(-it.r * dpr, -it.r * dpr * 0.6, it.r * 2 * dpr, it.r * 1.2 * dpr); }
          ctx.restore();
        } else if (mode === 'hearts') {
          it.p += 0.025 * dt; it.y -= (0.5 + it.v) * dpr * dt; it.x += Math.sin(it.p) * 0.8 * dpr * dt;
          if (it.y < -50) spawn(it, false);
          drawHeart(ctx, it.x, it.y, it.r * dpr * 1.7, it.c, Math.sin(it.p) * 0.25, 0.82, 14 * dpr);
        } else if (mode === 'balloons') {
          it.p += it.sw * dt; it.y -= (0.55 + it.v * 0.8) * dpr * dt; it.x += Math.sin(it.p) * 0.7 * dpr * dt;
          if (it.y < -it.h * 3) { if (it.temp) { items.splice(i, 1); continue; } spawn(it, false); }
          const tilt = Math.sin(it.p) * 0.1 + it.vx * 0.02;
          // fio
          ctx.globalAlpha = 0.6; ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = dpr;
          ctx.beginPath(); ctx.moveTo(it.x, it.y + it.h + it.w * 0.2);
          ctx.bezierCurveTo(it.x - 9 * dpr + Math.sin(it.p) * 8 * dpr, it.y + it.h * 1.6, it.x + 9 * dpr, it.y + it.h * 2.2, it.x + Math.sin(it.p * 1.3) * 6 * dpr, it.y + it.h * 2.8); ctx.stroke();
          drawBalloon(ctx, it.x, it.y, it.w, it.h, it.c, 0.88, tilt);
        } else if (mode === 'easter') {
          it.p += 0.02 * dt; it.rot = Math.sin(it.p * 1.4) * 0.35; it.y += (0.6 + it.v * 0.9) * dpr * dt; it.x += Math.sin(it.p) * 0.7 * dpr * dt;
          if (it.y > H + it.h * 2) spawn(it, false);
          drawEgg(ctx, it.x, it.y, it.w, it.h, it.rot, it.c, 0.9, it.style);
        } else if (mode === 'fireworks') {
          it.p += 0.04 * dt; drawSpark(ctx, it.x, it.y, it.r * 2.4, 0, '#ffffff', 0.2 + 0.7 * Math.abs(Math.sin(it.p)));
        }
      }
      ctx.globalAlpha = 1;

      // ----- camada da frente -----
      fx.globalCompositeOperation = 'destination-out';
      fx.fillStyle = mode === 'fireworks' ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,1)';
      fx.fillRect(0, 0, W, H);
      fx.globalCompositeOperation = 'source-over';
      if (mode === 'fireworks') {
        if (t > nextAuto) { nextAuto = t + rnd(900, 2000); launch(rnd(W * 0.1, W * 0.9)); }
        for (let i = rockets.length - 1; i >= 0; i--) {
          const r = rockets[i];
          r.y -= 11 * dpr * dt; r.x += r.vx * dt;
          fx.globalAlpha = 1; fx.fillStyle = '#fff'; fx.beginPath(); fx.arc(r.x, r.y, 2.2 * dpr, 0, 6.283); fx.fill();
          fx.globalAlpha = 0.5; fx.fillStyle = '#ffd37a'; fx.beginPath(); fx.arc(r.x - r.vx * 2, r.y + 8 * dpr, 1.6 * dpr, 0, 6.283); fx.fill();
          if (r.y <= r.ty) { explode(r.x, r.y); rockets.splice(i, 1); }
        }
      }
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.vx *= p.drag; p.vy = p.vy * p.drag + p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= p.decay * dt; p.rot += p.vr * dt;
        if (p.life <= 0) { parts.splice(i, 1); continue; }
        const a = Math.max(0, Math.min(1, p.life * 1.4));
        if (p.kind === 'fire') {
          fx.globalCompositeOperation = 'lighter'; fx.globalAlpha = a; fx.fillStyle = p.c;
          fx.beginPath(); fx.arc(p.x, p.y, p.size * (0.5 + p.life * 0.7), 0, 6.283); fx.fill();
          if (p.trail && Math.random() < 0.5) parts.push({ kind: 'fire', x: p.x, y: p.y, vx: 0, vy: 0, life: 0.5, decay: 0.03, g: 0, drag: 1, size: p.size * 0.6, c: '#ffd9a0' });
          fx.globalCompositeOperation = 'source-over';
        } else if (p.kind === 'flash') {
          fx.globalCompositeOperation = 'lighter';
          const g = fx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * (2 - p.life));
          g.addColorStop(0, 'rgba(255,255,255,' + (0.7 * p.life) + ')'); g.addColorStop(1, 'rgba(255,255,255,0)');
          fx.globalAlpha = 1; fx.fillStyle = g; fx.beginPath(); fx.arc(p.x, p.y, p.size * 2, 0, 6.283); fx.fill();
          fx.globalCompositeOperation = 'source-over';
        } else if (p.kind === 'confetti') {
          fx.globalAlpha = a; fx.fillStyle = p.c; fx.save(); fx.translate(p.x, p.y); fx.rotate(p.rot); fx.scale(1, Math.abs(Math.cos(p.flip += 0.18 * dt)) * 0.9 + 0.1);
          fx.fillRect(-p.size, -p.size * 0.55, p.size * 2, p.size * 1.1); fx.restore();
        } else if (p.kind === 'ribbon') {
          fx.globalAlpha = a; fx.strokeStyle = p.c; fx.lineWidth = 2.4 * dpr; fx.lineCap = 'round'; fx.save(); fx.translate(p.x, p.y); fx.rotate(p.rot);
          fx.beginPath(); fx.moveTo(0, -9 * dpr); fx.quadraticCurveTo(6 * dpr, -4 * dpr, 0, 0); fx.quadraticCurveTo(-6 * dpr, 4 * dpr, 0, 9 * dpr); fx.stroke(); fx.restore();
        } else if (p.kind === 'heart') drawHeart(fx, p.x, p.y, p.size * 1.6, p.c, p.rot * 0.2, a, p.glow * dpr);
        else if (p.kind === 'flake') drawFlake(fx, p.x, p.y, p.size, p.rot, '#ffffff', a, Math.max(1, dpr * 1.4));
        else if (p.kind === 'spark') drawSpark(fx, p.x, p.y, p.size * 1.6, p.rot, p.c, a);
        else if (p.kind === 'shard') {
          fx.globalAlpha = a; fx.fillStyle = p.c; fx.save(); fx.translate(p.x, p.y); fx.rotate(p.rot);
          fx.beginPath(); fx.moveTo(0, -p.size); fx.lineTo(p.size * 0.8, p.size * 0.7); fx.lineTo(-p.size * 0.5, p.size * 0.4); fx.closePath(); fx.fill(); fx.restore();
        }
      }
      fx.globalAlpha = 1;
    }
    raf = requestAnimationFrame(frame);
    function onVis() {
      if (document.hidden) { running = false; cancelAnimationFrame(raf); }
      else if (!running) { running = true; last = 0; raf = requestAnimationFrame(frame); }
    }
    document.addEventListener('visibilitychange', onVis);
    return {
      hit,
      stop() {
        running = false; cancelAnimationFrame(raf);
        global.removeEventListener('resize', size);
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerdown', onDown);
        document.removeEventListener('visibilitychange', onVis);
        fx.clearRect(0, 0, fg.width, fg.height);
      },
    };
  }


  function sceneColors(theme, mode) {
    const c = theme.colors;
    if (mode === 'matrix') return [c.primary];
    if (mode === 'snow') return ['#ffffff', c.highlight];
    if (mode === 'embers') return [c.primary, c.highlight, c.secondary];
    if (mode === 'petals') return [c.primary, c.highlight];
    if (mode === 'confetti') return [c.primary, c.secondary, c.highlight, '#ffffff', '#4dd0ff'];
    if (mode === 'fireworks') return [c.primary, c.highlight, '#ffffff', '#ff6b6b', '#6bc5ff'];
    if (mode === 'hearts' || mode === 'easter') return [c.primary];
    if (mode === 'balloons') return [c.primary, c.secondary, c.highlight, '#7bd88f', '#c084fc'];
    return [c.highlight, '#ffffff', c.primary];
  }

  function applyScene(theme) {
    const key = theme && theme.scene ? theme.scene : 'none';
    const layer = ensureSceneLayer();
    if (sceneStop) { sceneStop(); sceneStop = null; }
    sceneApi = null;
    const oldFx = document.getElementById('plus2-fx');
    if (oldFx) oldFx.remove();
    layer.innerHTML = '';
    layer.className = '';
    currentScene = key;
    const off = key === 'none' || (state.performanceMode && !state.previewing) || prefsState.scene === false;
    document.body.classList.toggle('pv2-scene-active', !off);
    document.body.dataset.pv2Scene = off ? '' : key;
    if (off) return;
    if (CSS_SCENES.has(key)) {
      layer.className = 'pv2-scene-' + key;
      if (key === 'aurora') layer.innerHTML = '<i></i><i></i><i></i>';
    } else if (RICH_SCENES.has(key)) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:100%;height:100%;display:block;';
      layer.appendChild(canvas);
      const fg = document.createElement('canvas');
      fg.id = 'plus2-fx';
      document.body.appendChild(fg);
      sceneApi = startRichScene(canvas, fg, key, theme);
      sceneStop = () => sceneApi && sceneApi.stop();
    } else if (CANVAS_SCENES.has(key)) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:100%;height:100%;display:block;';
      layer.appendChild(canvas);
      sceneStop = startCanvasScene(canvas, key, sceneColors(theme, key));
    }
  }


  // =========================================================================
  // v0.85.0 — DECORAÇÃO TEMÁTICA (datas comemorativas)
  // =========================================================================
  // Além da cor/fonte/fundo animado, um tema pode ter "decor": luzes
  // piscando penduradas no topo (com enfeites balançando), um personagem/
  // objeto que atravessa a tela de tempos em tempos (ex.: Papai Noel no
  // trenó), um acessório na logo (ex.: gorro de Natal) e uma faixa listrada
  // na barra lateral. Tudo é só DOM/CSS, sem imagem, e some no modo
  // desempenho.
  const DECORS = {
    natal: {
      lights: ['#ff3b3b', '#2ecc71', '#ffd54a', '#4aa8ff'],
      orn: [['bauble', '#d62839'], ['star', '#ffd54a'], ['gift', '#2ecc71'], ['bell'], ['bauble', '#2ecc71'], ['cane'], ['gift', '#d62839'], ['bauble', '#4aa8ff']],
      top: 'lights', logo: 'hat_natal', stripe: ['#d62839', '#ffffff'],
    },
    'ano-novo': {
      lights: ['#ffd54a', '#ffffff', '#f0b429'],
      orn: [['star', '#ffd54a'], ['disco'], ['bauble', '#f0b429'], ['star', '#ffffff'], ['bauble', '#3b4fb8']],
      top: 'countdown', logo: 'hat_ano', stripe: ['#f0b429', '#1b2a6b'],
    },
    carnaval: {
      lights: ['#ff2e93', '#00e676', '#ffd600', '#2979ff', '#ff6d00'],
      orn: [['bauble', '#ff2e93'], ['star', '#ffd600'], ['bauble', '#00c853'], ['bauble', '#2979ff'], ['star', '#ff6d00']],
      top: 'bunting', logo: 'mask_carnaval', stripe: ['#ff2e93', '#ffd600'],
    },
    pascoa: {
      lights: ['#b388ff', '#ff9ec7', '#fff3a0', '#9be7c4'],
      orn: [['egg', '#b388ff'], ['egg', '#ff9ec7'], ['egg', '#9be7c4'], ['egg', '#ffd56b']],
      top: 'vines', logo: 'ears_pascoa', stripe: ['#b388ff', '#ff9ec7'],
    },
    namorados: {
      lights: ['#ff4d79', '#ff8fab', '#ffc2d4', '#ffffff'],
      orn: [['heart', '#ff4d79'], ['heart', '#ff8fab'], ['heart', '#e0245e']],
      top: 'garland', logo: 'heart_namorados', stripe: ['#ff4d79', '#ffffff'],
    },
    criancas: {
      lights: ['#22b8f0', '#ff7043', '#ffee58', '#66bb6a', '#ab47bc'],
      orn: [['balloon', '#22b8f0'], ['balloon', '#ff7043'], ['lollipop', '#ab47bc'], ['balloon', '#66bb6a'], ['star', '#ffee58']],
      top: 'garland', logo: 'cap_criancas', stripe: ['#22b8f0', '#ffee58'],
    },
  };
  const DECOR_CLASSES = Object.keys(DECORS).map((k) => 'pv2-decor-' + k);
  let decorResizeTimer = null;

  function ensureDecorLayer() {
    let layer = document.getElementById('plus2-decor');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'plus2-decor';
      document.body.appendChild(layer);
    }
    return layer;
  }

  function renderLights(cfg, onlyOrn) {
    const layer = ensureDecorLayer();
    let bar = layer.querySelector('.pv2-lights');
    if (!bar) { bar = document.createElement('div'); bar.className = 'pv2-lights'; layer.insertBefore(bar, layer.firstChild); }
    bar.innerHTML = '';
    bar.classList.toggle('garland', !!onlyOrn);
    const n = Math.max(8, Math.ceil((global.innerWidth || 1200) / (onlyOrn ? 74 : 44)));
    let o = 0;
    for (let i = 0; i < n; i++) {
      let node;
      if (onlyOrn || (i % 7 === 3 && cfg.orn.length)) {
        const [kind, color] = cfg.orn[o++ % cfg.orn.length];
        node = document.createElement('b');
        node.innerHTML = ART[kind](color);
        node.style.animationDelay = (-(i % 5) * 0.4) + 's';
        // clique no enfeite: balança forte (e o clique também vira efeito na cena)
        node.addEventListener('pointerdown', () => {
          node.classList.remove('hard'); void node.offsetWidth; node.classList.add('hard');
        });
      } else {
        node = document.createElement('i');
        node.style.setProperty('--c', cfg.lights[i % cfg.lights.length]);
        node.style.setProperty('--d', ((i % 6) * 0.27).toFixed(2) + 's');
      }
      bar.appendChild(node);
    }
  }

  // ---------------------------------------------------------------------
  // v0.87.0 — DECORAÇÃO ÚNICA NO TOPO POR DATA (só o Natal tem pisca-pisca)
  //   natal: fio de luzes | ano-novo: contagem regressiva + serpentinas
  //   carnaval: bandeirinhas | páscoa: trepadeira com flores e ovos
  //   namorados/crianças: varal de corações / de balões
  // ---------------------------------------------------------------------
  let cdTimer = 0;
  function renderCountdown(layer, cfg) {
    const wrap = document.createElement('div');
    wrap.className = 'pv2-countdown';
    const t = document.createElement('div'); t.className = 'pv2-cd-title';
    const c = document.createElement('div'); c.className = 'pv2-cd-time';
    wrap.appendChild(t); wrap.appendChild(c);
    const st = (side) => `<svg ${NS} class='pv2-streamer ${side}' viewBox='0 0 90 230'>${[['#ffd54a', 14], ['#ffffff', 36], ['#6bc5ff', 58], ['#ff6b9a', 76]].map(([c, x], i) => `<path d='M${x} 0 Q${x + 22} 26 ${x} 52 T${x} 104 T${x} 156 T${x} ${190 + i * 8}' stroke='${c}' stroke-width='5' fill='none' stroke-linecap='round' style='animation-delay:${-i * 0.45}s'/>`).join('')}</svg>`;
    layer.insertAdjacentHTML('afterbegin', st('left') + st('right'));
    layer.appendChild(wrap);
    const pad = (n) => String(n).padStart(2, '0');
    function tick() {
      const now = new Date(), y = now.getFullYear();
      if (now.getMonth() === 0 && now.getDate() <= 7) { t.textContent = 'FELIZ'; c.textContent = String(y); wrap.classList.add('party'); return; }
      wrap.classList.remove('party');
      const diff = Math.max(0, new Date(y + 1, 0, 1) - now);
      const d = Math.floor(diff / 864e5), h = Math.floor(diff / 36e5) % 24, m = Math.floor(diff / 6e4) % 60, s = Math.floor(diff / 1e3) % 60;
      t.textContent = 'FALTAM PARA ' + (y + 1);
      c.textContent = d + 'd  ' + pad(h) + ':' + pad(m) + ':' + pad(s);
    }
    tick();
    clearInterval(cdTimer);
    cdTimer = setInterval(tick, 1000);
  }
  function renderBunting(layer) {
    const W = global.innerWidth || 1200, cols = ['#ff2e93', '#00c853', '#ffd600', '#2979ff', '#ff6d00', '#b44bff', '#00e5ff', '#ff4d4d'];
    let paths = '', flags = '', k = 0;
    for (let x0 = -10; x0 < W; x0 += 250) {
      const x1 = x0 + 250, xm = x0 + 125;
      paths += `<path d='M${x0} 3 Q${xm} 38 ${x1} 3' stroke='#3a3a3a' stroke-width='2' fill='none'/>`;
      for (let j = 1; j <= 5; j++) {
        const t = j / 6, px = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * xm + t * t * x1, py = (1 - t) * (1 - t) * 3 + 2 * (1 - t) * t * 38 + t * t * 3;
        flags += `<g class='pv2-flag' style='transform-origin:${px}px ${py}px;animation-delay:${-(k % 7) * 0.31}s'><path d='M${px - 11} ${py - 1} L${px + 11} ${py - 1} L${px} ${py + 28}Z' fill='${cols[k % cols.length]}' stroke='#fff' stroke-opacity='.45' stroke-width='1'/></g>`;
        k++;
      }
    }
    layer.insertAdjacentHTML('afterbegin', `<svg ${NS} class='pv2-bunting' width='${W}' height='64' viewBox='0 0 ${W} 64'>${paths}${flags}</svg>`);
  }
  function renderVines(layer, cfg) {
    const W = global.innerWidth || 1200, petal = ['#ff9ec7', '#b388ff', '#fff3a0', '#9be7c4'];
    let d = 'M0 8', leaves = '', flowers = '', eggs = '';
    for (let x = 0; x < W + 40; x += 40) d += ` Q${x + 20} ${x % 80 ? 22 : -4} ${x + 40} 8`;
    for (let x = 30; x < W; x += 55) leaves += `<ellipse cx='${x}' cy='${(x % 110 ? 15 : 4)}' rx='9' ry='4.2' fill='#58b86b' transform='rotate(${x % 110 ? 35 : -35} ${x} ${(x % 110 ? 15 : 4)})'/>`;
    let n = 0;
    for (let x = 70; x < W; x += 130) {
      const c = petal[n % petal.length];
      let p = '';
      for (let a = 0; a < 5; a++) p += `<circle cx='${x + Math.cos(a * 1.2566) * 6}' cy='${14 + Math.sin(a * 1.2566) * 6}' r='5' fill='${c}'/>`;
      flowers += `<g class='pv2-bloom' style='animation-delay:${-(n % 4) * 0.5}s'>${p}<circle cx='${x}' cy='14' r='3.4' fill='#ffd54a'/></g>`;
      if (n % 2 === 1) eggs += ART.egg(petal[(n + 1) % petal.length]).replace('<svg ', `<svg class='pv2-hegg' x='${x + 46}' y='6' width='24' height='36' `);
      n++;
    }
    layer.insertAdjacentHTML('afterbegin', `<svg ${NS} class='pv2-vines' width='${W}' height='62' viewBox='0 0 ${W} 62'><path d='${d}' stroke='#3e9a57' stroke-width='4' fill='none' stroke-linecap='round'/>${leaves}${flowers}${eggs}</svg>`);
  }
  function renderTop(cfg, layer) {
    if (cfg.top === 'lights') renderLights(cfg, false);
    else if (cfg.top === 'garland') renderLights(cfg, true);
    else if (cfg.top === 'countdown') renderCountdown(layer, cfg);
    else if (cfg.top === 'bunting') renderBunting(layer);
    else if (cfg.top === 'vines') renderVines(layer, cfg);
  }

  function applyDecor(theme) {
    if (global.PlusV2Fx) global.PlusV2Fx.set(theme && theme.fx ? theme.fx : null);
    const key = theme && theme.decor ? theme.decor : '';
    const cfg = DECORS[key];
    const root = document.documentElement;
    DECOR_CLASSES.forEach((c) => document.body.classList.remove(c));
    const layer = ensureDecorLayer();
    clearInterval(cdTimer);
    if (!cfg || (state.performanceMode && !state.previewing)) {
      document.body.classList.remove('pv2-has-decor');
      layer.innerHTML = '';
      if (global.PlusV2Mascot) global.PlusV2Mascot.set('');
      return;
    }
    document.body.classList.add('pv2-has-decor', 'pv2-decor-' + key);
    const logoSvg = ART[cfg.logo];
    root.style.setProperty('--pv2-logo-img', svgUri(typeof logoSvg === 'function' ? logoSvg() : logoSvg));
    root.style.setProperty('--pv2-stripe-a', cfg.stripe[0]);
    root.style.setProperty('--pv2-stripe-b', cfg.stripe[1]);
    layer.innerHTML = '';
    if (prefsState.decor !== false) renderTop(cfg, layer);
    if (global.PlusV2Mascot) global.PlusV2Mascot.set(key);
    if (!global.__pv2DecorResizeBound) {
      global.__pv2DecorResizeBound = true;
      global.addEventListener('resize', () => {
        clearTimeout(decorResizeTimer);
        decorResizeTimer = setTimeout(() => {
          const cur = global.PlusV2LiveCurrentTheme;
          const c = cur && DECORS[cur.decor];
          if (c && !state.performanceMode && prefsState.decor !== false && (c.top === 'lights' || c.top === 'garland')) renderLights(c, c.top === 'garland');
        }, 250);
      });
    }
  }

  // ---- Pré-visualização ao vivo: aplica um tema no site de verdade SEM
  // salvar; cancelPreview() volta pro que está salvo.
  let lastData = null;
  function previewTheme(theme) {
    if (!theme) return;
    // v0.91.5: a pré-visualização mostra os efeitos mesmo com o "modo desempenho"
    // ligado (senão parecia que o tema não tinha efeito nenhum).
    state.previewing = true;
    applyTheme(theme, true);
  }
  // v0.90.0 — reaplica o tema atual (usado pelo mini-editor do chat)
  function reapply() { const t = global.PlusV2LiveBaseTheme; if (t) applyTheme(t); }
  function cancelPreview() {
    state.previewing = false;
    if (lastData) applyAll(lastData);
  }

  // v0.91.5 — o logo do NEXT GAME (disco azul com X branco) também muda de cor
  // com o tema: gira o matiz do azul original (~215°) até o matiz da cor
  // principal, ajustando saturação/brilho (tema cinza => logo cinza).
  function applyLogoTint(theme) {
    const root = document.documentElement;
    const c = theme && theme.colors && theme.colors.primary;
    if (!c || !/^#[0-9a-fA-F]{6}$/.test(c) || theme.key === 'blue') { root.style.removeProperty('--pv2-logo-filter'); return; }
    const rgb = hexToRgb(c), hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    const s = hsl.s / 100, l = hsl.l / 100;
    let rot = Math.round(hsl.h - 215); if (rot > 180) rot -= 360; if (rot < -180) rot += 360;
    const sat = Math.max(0.12, Math.min(1.5, s / 0.72)).toFixed(2);
    const bri = Math.max(0.75, Math.min(1.3, 0.85 + (l - 0.5) * 0.8)).toFixed(2);
    root.style.setProperty('--pv2-logo-filter', `hue-rotate(${rot}deg) saturate(${sat}) brightness(${bri})`);
  }

  // ---------------- Tema: cores viram CSS vars usadas no site inteiro ----------------
  function applyTheme(theme, isPreview) {
    if (!theme) return;
    if (!isPreview) global.PlusV2LiveBaseTheme = theme;
    if (global.PlusV2Quick) theme = global.PlusV2Quick.merge(theme); // v0.92.0: preview e tema aplicado passam pelo MESMO caminho
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
    // Selo "MEMBRO MAGIC TANK" (tema exclusivo por cupom) — criado sob demanda.
    if (theme.key === 'magic-tank' && !document.getElementById('mt-member-tag')) {
      const tag = document.createElement('div');
      tag.id = 'mt-member-tag';
      tag.textContent = '★ MEMBRO MAGIC TANK';
      // v0.92.0: dentro da barra do topo (antes flutuava por cima de tudo)
      const chip = document.querySelector('.navbar-profile-chip-wrap');
      if (chip && chip.parentElement) chip.parentElement.insertBefore(tag, chip); else document.body.appendChild(tag);
    }
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
    applyLogoTint(theme);
    applyFont(theme.font);
    applyScene(theme);
    applyDecor(theme);
    if (global.PlusV2Quick) global.PlusV2Quick.applyChat(theme);
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
    state.previewing = false;
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
    if (theme) { applyScene(theme); applyDecor(theme); } // respeita o modo desempenho
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

  // v0.97.7 — quando o mouse está sobre algo clicável (botão, link, campo, item de lista),
  // os efeitos/decoração por cima ficam quase transparentes: dá para ver e clicar sem nada na frente.
  (function bindClearZone() {
    if (global.__pv2ClearBound || typeof document === 'undefined') return;
    global.__pv2ClearBound = true;
    const SEL = 'button,a,input,textarea,select,label,summary,[role="button"],[role="menuitem"],[role="tab"],.channel-item,.message,.server-icon,.home-card,.server-card,.sidebar-nav-item,.navbar-icon-btn,.member-item,.friend-row,.modal-card,.footer-more-menu,.sidebar-more-menu,.navbar-create-menu';
    let on = false;
    document.addEventListener('pointerover', (e) => {
      const t = e.target && e.target.closest ? e.target.closest(SEL) : null;
      const want = !!t && !t.closest('#plus2-decor, #plus2-mascot-layer, .pv2-drop');
      if (want !== on) { on = want; document.body.classList.toggle('pv2-clear', want); }
    }, { passive: true });
    document.addEventListener('pointerleave', () => { if (on) { on = false; document.body.classList.remove('pv2-clear'); } }, { passive: true });
  })();

  global.PlusV2Live = { state, refresh, applyAll, previewTheme, cancelPreview, reapply, prefs: getPrefs, setPrefs, art: ART, poke: (x, y) => { if (sceneApi) sceneApi.hit(x * (Math.min(global.devicePixelRatio || 1, 2)), y * (Math.min(global.devicePixelRatio || 1, 2))); } };
})(typeof window !== 'undefined' ? window : globalThis);
