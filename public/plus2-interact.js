// plus2-interact.js — temas INTERATIVOS (v0.98.1).
//
// Pedido: "os temas ficarem mais interativos e legais, e o Magic Tank especial".
// Até aqui os temas eram só animação de fundo — nada respondia ao que a pessoa
// fazia. Este módulo funciona por cima de QUALQUER tema (lê as cores do tema
// ativo pelas variáveis CSS --accent-rgb / --accent-2-rgb / --accent-3-rgb):
//
//   • toque/clique: onda + faíscas nas cores do tema (temas com figurinhas
//     soltam algumas delas também, via PlusV2Fx.burst)
//   • rastro de luz seguindo o cursor (só mouse; no celular não tem cursor)
//   • brilho que segue o mouse por cima dos cards
//
// Tema MAGIC TANK (especial):
//   • abertura animada com o logo do parceiro ao ativar o tema
//   • um tanque mágico sobe do canto, mira onde você tocou e dispara um
//     projétil dourado que explode em runas e faíscas — com COMBO pra cliques
//     seguidos. O tanque só aparece na hora do tiro e volta pra baixo logo
//     depois, pra não ficar por cima de nada da tela.
//
// Respeita: modo desempenho, "cena animada" desligada nas preferências e a
// preferência do sistema "reduzir movimento". Nunca bloqueia clique (tudo é
// pointer-events:none) e o loop de animação só roda enquanto há algo na tela.
(function (global) {
  'use strict';
  const doc = document;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const L = () => global.PlusV2Live;
  const reduce = () => !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const isMT = () => doc.body && doc.body.classList.contains('theme-magic-tank');

  function allowed() {
    if (!global.PlusV2LiveCurrentTheme || !doc.body) return false;
    // tela de login/carregando: sem efeitos (só dentro do app)
    const auth = doc.getElementById('auth-screen');
    if (auth && !auth.classList.contains('hidden') && auth.offsetParent !== null) return false;
    const l = L();
    if (l && l.state && l.state.performanceMode && !l.state.previewing) return false;
    const p = l && l.prefs ? l.prefs() : {};
    if (p.scene === false) return false;
    return true;
  }

  // ------------------------------------------------------------ cores do tema
  let colorsFor = null, colors = ['255,255,255'];
  function themeColors() {
    const t = global.PlusV2LiveCurrentTheme;
    if (t === colorsFor && colors.length) return colors;
    colorsFor = t;
    if (isMT()) { colors = ['251,220,112', '0,168,255', '127,217,255', '255,240,190']; return colors; }
    const cs = getComputedStyle(doc.documentElement);
    colors = ['--accent-rgb', '--accent-2-rgb', '--accent-3-rgb']
      .map((v) => cs.getPropertyValue(v).trim())
      .filter((v) => /^\d+\s*,\s*\d+\s*,\s*\d+$/.test(v));
    if (!colors.length) colors = ['120,140,255'];
    return colors;
  }

  // ------------------------------------------------------------ CSS próprio
  let styled = false;
  function injectStyle() {
    if (styled) return; styled = true;
    const st = doc.createElement('style');
    st.id = 'pv2-ix-style';
    st.textContent = `
#pv2-ix{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:96}
#pv2-spot{position:fixed;pointer-events:none;z-index:95;opacity:0;transition:opacity .25s ease;
  background:radial-gradient(260px circle at var(--x,50%) var(--y,50%),rgba(var(--c),.16),transparent 65%);
  box-shadow:inset 0 0 0 1px rgba(var(--c),.28)}
#pv2-spot.on{opacity:1}
#pv2-mt-splash{position:fixed;inset:0;z-index:2147483000;pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
  background:radial-gradient(circle at 50% 46%,rgba(0,40,80,.55),rgba(2,6,14,.0) 60%);animation:pv2mtFade 2.6s ease forwards}
#pv2-mt-splash .ring{position:relative;width:min(46vw,230px);aspect-ratio:1;border-radius:50%;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(circle,rgba(0,168,255,.28),rgba(5,8,16,.92) 68%);
  box-shadow:0 0 0 2px rgba(251,220,112,.7),0 0 40px rgba(0,168,255,.55),0 0 90px rgba(251,220,112,.25);animation:pv2mtPop .7s cubic-bezier(.2,1.4,.4,1) both}
#pv2-mt-splash .ring::before{content:"";position:absolute;inset:-14px;border-radius:50%;
  border:2px dashed rgba(251,220,112,.75);animation:pv2mtSpin 6s linear infinite}
#pv2-mt-splash .ring::after{content:"✦ ✧ ✦ ✧ ✦ ✧ ✦ ✧";position:absolute;inset:-34px;border-radius:50%;color:rgba(127,217,255,.8);
  font-size:13px;letter-spacing:22px;display:flex;align-items:flex-start;justify-content:center;animation:pv2mtSpin 9s linear infinite reverse}
#pv2-mt-splash img{width:78%;height:auto;filter:drop-shadow(0 4px 14px rgba(0,0,0,.6))}
#pv2-mt-splash .t{font:900 clamp(14px,3.2vw,20px)/1.1 var(--pv2-font-display,system-ui,sans-serif);letter-spacing:.32em;color:#fbe7a0;
  text-shadow:0 0 12px rgba(0,168,255,.9),0 0 30px rgba(251,220,112,.45);animation:pv2mtUp .8s .25s ease both}
#pv2-mt-splash .s{font:700 clamp(10px,2.2vw,12px)/1 var(--pv2-font-body,system-ui,sans-serif);letter-spacing:.24em;color:#9fdcff;animation:pv2mtUp .8s .45s ease both}
@keyframes pv2mtFade{0%,78%{opacity:1}100%{opacity:0}}
@keyframes pv2mtPop{0%{transform:scale(.3) rotate(-25deg);opacity:0}100%{transform:none;opacity:1}}
@keyframes pv2mtSpin{to{transform:rotate(360deg)}}
@keyframes pv2mtUp{0%{transform:translateY(12px);opacity:0}100%{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){#pv2-mt-splash .ring::before,#pv2-mt-splash .ring::after{animation:none}}`;
    doc.head.appendChild(st);
  }

  // ------------------------------------------------------------ canvas + loop
  let cv = null, ctx = null, W = 0, H = 0, dpr = 1, raf = 0, last = 0;
  let parts = [], orbs = [];
  function ensureCanvas() {
    if (cv) return;
    injectStyle();
    cv = doc.createElement('canvas'); cv.id = 'pv2-ix'; cv.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(cv);
    ctx = cv.getContext('2d');
    size();
  }
  function size() {
    if (!cv) return;
    dpr = Math.min(global.devicePixelRatio || 1, 1.5);
    W = global.innerWidth || 1200; H = global.innerHeight || 800;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function wake() { if (!raf && cv) { last = 0; raf = requestAnimationFrame(tick); } }

  function spark(x, y, c, o) {
    o = o || {};
    const a = o.a != null ? o.a : rnd(0, Math.PI * 2), v = o.v != null ? o.v : rnd(60, 260);
    parts.push({ k: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: o.g != null ? o.g : 260, life: 0, max: o.max || rnd(0.35, 0.8), s: o.s || rnd(1.4, 3.2), c });
  }
  function ring(x, y, c, o) {
    o = o || {};
    parts.push({ k: 'ring', x, y, r: o.r0 || 4, vr: o.vr || 260, w: o.w || 2.5, life: 0, max: o.max || 0.5, c });
  }
  function text(x, y, str, c) {
    parts.push({ k: 'text', x, y, vy: -60, life: 0, max: 1.1, str, c });
  }
  function rune(x, y) {
    parts.push({ k: 'rune', x, y, rot: rnd(0, 6.28), life: 0, max: 0.9 });
  }

  // ------------------------------------------------------------ efeito padrão (todos os temas)
  let lastTap = 0;
  function ripple(x, y) {
    const now = performance.now();
    if (now - lastTap < 110) return; lastTap = now;
    ensureCanvas();
    const cs = themeColors();
    ring(x, y, cs[0], { vr: 220, max: 0.45 });
    if (!reduce()) {
      ring(x, y, cs[1] || cs[0], { vr: 140, max: 0.55, w: 1.5 });
      for (let i = 0; i < 12; i++) spark(x, y, pick(cs));
      if (global.PlusV2Fx && global.PlusV2Fx.active && global.PlusV2Fx.active() && Math.random() < 0.6) global.PlusV2Fx.burst(x, y, 4);
    }
    wake();
  }

  // rastro do cursor (só mouse, nunca em toque)
  let lastTrail = 0;
  function trail(x, y) {
    const now = performance.now();
    if (now - lastTrail < 28) return; lastTrail = now;
    ensureCanvas();
    if (parts.length > 160) return;
    const cs = themeColors();
    spark(x + rnd(-3, 3), y + rnd(-3, 3), pick(cs), { v: rnd(8, 30), g: isMT() ? -30 : 40, max: rnd(0.35, 0.6), s: rnd(1, 2.2) });
    wake();
  }

  // brilho que segue o mouse nos cards
  const SPOT_SEL = '.explore-card, .home-server-card, .featured-server-card, .settings-row, .friend-row, .server-row, .sidebar-nav-item, [class*="home-"][class*="card"], [class*="-card"]:not(.modal-card):not(.modal-card-wide):not(.auth-card)';
  let spot = null, spotTarget = null;
  function moveSpot(target, x, y) {
    const el = target && target.closest ? target.closest(SPOT_SEL) : null;
    if (!el) { hideSpot(); return; }
    const r = el.getBoundingClientRect();
    if (r.width * r.height > W * H * 0.4 || r.width < 30) { hideSpot(); return; }
    if (!spot) { injectStyle(); spot = doc.createElement('div'); spot.id = 'pv2-spot'; spot.setAttribute('aria-hidden', 'true'); doc.body.appendChild(spot); }
    if (el !== spotTarget) {
      spotTarget = el;
      spot.style.borderRadius = getComputedStyle(el).borderRadius;
      spot.style.setProperty('--c', themeColors()[0]);
    }
    spot.style.left = r.left + 'px'; spot.style.top = r.top + 'px';
    spot.style.width = r.width + 'px'; spot.style.height = r.height + 'px';
    spot.style.setProperty('--x', (x - r.left) + 'px'); spot.style.setProperty('--y', (y - r.top) + 'px');
    spot.classList.add('on');
  }
  function hideSpot() { spotTarget = null; if (spot) spot.classList.remove('on'); }

  // ------------------------------------------------------------ MAGIC TANK
  const GOLD = '251,220,112', BLUE = '0,168,255', ICE = '127,217,255';
  const tank = { show: 0, want: 0, ang: -0.6, recoil: 0, flash: 0, idle: 0 };
  let combo = 0, comboT = 0, lastShot = 0, audio = null;

  function tankBase() {
    const s = W < 700 ? 0.72 : 1;
    return { s, x: 18 + 46 * s, y: H - 12 };
  }
  function muzzle(final) {
    const b = tankBase(), lift = final ? 0 : (1 - easeOut(tank.show)) * 90 * b.s;
    const tx = b.x, ty = b.y - 34 * b.s + lift;
    const len = (36 - tank.recoil * 10) * b.s;
    return { x: tx + Math.cos(tank.ang) * len, y: ty + Math.sin(tank.ang) * len, tx, ty };
  }
  const easeOut = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

  function sound(kind) {
    try {
      if (typeof SFX === 'undefined' || !SFX.isEnabled || !SFX.isEnabled()) return; // eslint-disable-line no-undef
      const AC = global.AudioContext || global.webkitAudioContext; if (!AC) return;
      audio = audio || new AC(); if (audio.state === 'suspended') audio.resume();
      const t0 = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
      if (kind === 'pew') { o.type = 'square'; o.frequency.setValueAtTime(980, t0); o.frequency.exponentialRampToValueAtTime(240, t0 + 0.13); g.gain.setValueAtTime(0.035, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14); }
      else { o.type = 'triangle'; o.frequency.setValueAtTime(150, t0); o.frequency.exponentialRampToValueAtTime(38, t0 + 0.28); g.gain.setValueAtTime(0.07, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3); }
      o.connect(g).connect(audio.destination); o.start(t0); o.stop(t0 + 0.32);
    } catch (_) { /* som é opcional */ }
  }

  function mtFire(x, y) {
    const now = performance.now();
    if (now - lastShot < 170 || orbs.length >= 6) return;
    lastShot = now;
    ensureCanvas();
    tank.want = 1; tank.idle = 0;
    const m0 = muzzle(true);
    tank.ang = Math.max(-Math.PI + 0.15, Math.min(-0.05, Math.atan2(y - m0.ty, x - m0.tx)));
    tank.recoil = 1; tank.flash = 1;
    combo = now - comboT < 1300 ? combo + 1 : 1; comboT = now;
    const m = muzzle(true);
    const dist = Math.hypot(x - m.x, y - m.y);
    orbs.push({ x0: m.x, y0: m.y, x1: x, y1: y, cx: (m.x + x) / 2, cy: Math.min(m.y, y) - Math.min(220, dist * 0.35), t: 0, dur: Math.min(0.55, Math.max(0.22, dist / 1500)), combo });
    for (let i = 0; i < 8; i++) spark(m.x, m.y, pick([GOLD, ICE]), { a: tank.ang + rnd(-0.5, 0.5), v: rnd(80, 220), max: 0.3 });
    sound('pew');
    wake();
  }
  function mtBoom(x, y, n) {
    ring(x, y, GOLD, { vr: 320, max: 0.5, w: 3 });
    ring(x, y, BLUE, { vr: 200, max: 0.65, w: 2 });
    rune(x, y);
    const k = reduce() ? 8 : 22 + Math.min(20, n * 3);
    for (let i = 0; i < k; i++) spark(x, y, pick([GOLD, GOLD, BLUE, ICE]), { v: rnd(90, 340 + n * 20) });
    if (n >= 3) text(x, y - 18, `x${n} COMBO!`, GOLD);
    if (n === 10 || n === 25) {
      if (global.PlusV2Fx && global.PlusV2Fx.burst) global.PlusV2Fx.burst(x, y, 18);
      text(x, y - 44, n === 10 ? 'MÁGICO!' : 'LENDÁRIO!', ICE);
    }
    sound('boom');
  }

  function drawTank(dt) {
    if (tank.want) { tank.idle += dt; if (tank.idle > 1.4 && !orbs.length) tank.want = 0; }
    tank.show += (tank.want ? 1 : -1) * dt * 5;
    tank.show = Math.max(0, Math.min(1, tank.show));
    tank.recoil = Math.max(0, tank.recoil - dt * 6);
    tank.flash = Math.max(0, tank.flash - dt * 7);
    if (tank.show <= 0) return false;
    const b = tankBase(), s = b.s, lift = (1 - easeOut(tank.show)) * 90 * s;
    const x = b.x, y = b.y + lift;
    ctx.save();
    ctx.globalAlpha = Math.min(1, tank.show * 1.4);
    // aura mágica
    const gr = ctx.createRadialGradient(x, y - 22 * s, 4, x, y - 22 * s, 70 * s);
    gr.addColorStop(0, `rgba(${BLUE},.35)`); gr.addColorStop(1, `rgba(${BLUE},0)`);
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y - 22 * s, 70 * s, 0, 6.29); ctx.fill();
    // esteiras
    ctx.fillStyle = '#0b1424'; ctx.strokeStyle = `rgba(${BLUE},.9)`; ctx.lineWidth = 1.5 * s;
    rr(x - 44 * s, y - 16 * s, 88 * s, 16 * s, 8 * s); ctx.fill(); ctx.stroke();
    ctx.fillStyle = `rgba(${GOLD},.95)`;
    const roll = (performance.now() / 90) % 12;
    for (let i = -36; i <= 36; i += 12) { ctx.beginPath(); ctx.arc(x + (i + roll - 6) * s, y - 8 * s, 2.3 * s, 0, 6.29); ctx.fill(); }
    // casco
    const hg = ctx.createLinearGradient(0, y - 36 * s, 0, y - 14 * s);
    hg.addColorStop(0, '#1a6fd1'); hg.addColorStop(1, '#0a2f63');
    ctx.fillStyle = hg; ctx.strokeStyle = `rgba(${GOLD},.95)`; ctx.lineWidth = 2 * s;
    rr(x - 36 * s, y - 34 * s, 72 * s, 20 * s, 7 * s); ctx.fill(); ctx.stroke();
    // estrelinha no casco
    ctx.fillStyle = `rgba(${GOLD},1)`; star(x + 18 * s, y - 24 * s, 4.5 * s);
    // canhão
    const tx = x, ty = y - 34 * s, len = (36 - tank.recoil * 10) * s;
    ctx.save(); ctx.translate(tx, ty); ctx.rotate(tank.ang);
    ctx.fillStyle = '#0f3d7a'; ctx.strokeStyle = `rgba(${GOLD},.95)`; ctx.lineWidth = 1.6 * s;
    rr(0, -4.5 * s, len, 9 * s, 4 * s); ctx.fill(); ctx.stroke();
    ctx.fillStyle = `rgba(${GOLD},1)`; rr(len - 6 * s, -6 * s, 7 * s, 12 * s, 2 * s); ctx.fill();
    if (tank.flash > 0) {
      const fg = ctx.createRadialGradient(len + 6 * s, 0, 0, len + 6 * s, 0, 26 * s * tank.flash);
      fg.addColorStop(0, 'rgba(255,255,230,.95)'); fg.addColorStop(0.4, `rgba(${GOLD},.8)`); fg.addColorStop(1, `rgba(${BLUE},0)`);
      ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(len + 6 * s, 0, 26 * s * tank.flash, 0, 6.29); ctx.fill();
    }
    ctx.restore();
    // torre (cúpula) + chapéu de mago 🎩
    ctx.fillStyle = '#1556a8'; ctx.strokeStyle = `rgba(${GOLD},.95)`; ctx.lineWidth = 2 * s;
    ctx.beginPath(); ctx.arc(tx, ty, 14 * s, Math.PI, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#10121c'; rr(tx - 7 * s, ty - 30 * s, 14 * s, 16 * s, 2 * s); ctx.fill();
    rr(tx - 12 * s, ty - 15 * s, 24 * s, 4 * s, 2 * s); ctx.fill();
    ctx.fillStyle = `rgba(${GOLD},1)`; ctx.fillRect(tx - 7 * s, ty - 19 * s, 14 * s, 3 * s);
    ctx.restore();
    return true;
  }
  function rr(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function star(x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr2 = i % 2 ? r * 0.45 : r; ctx.lineTo(x + Math.cos(a) * rr2, y + Math.sin(a) * rr2); }
    ctx.closePath(); ctx.fill();
  }

  // ------------------------------------------------------------ loop
  function tick(t) {
    raf = 0;
    if (!cv) return;
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016; last = t;
    ctx.clearRect(0, 0, W, H);
    // projéteis do Magic Tank
    for (let i = orbs.length - 1; i >= 0; i--) {
      const o = orbs[i]; o.t += dt / o.dur;
      const u = Math.min(1, o.t), iu = 1 - u;
      const x = iu * iu * o.x0 + 2 * iu * u * o.cx + u * u * o.x1;
      const y = iu * iu * o.y0 + 2 * iu * u * o.cy + u * u * o.y1;
      spark(x, y, pick([GOLD, ICE]), { v: rnd(10, 50), g: 20, max: 0.35, s: rnd(1.2, 2.6) });
      const g = ctx.createRadialGradient(x, y, 0, x, y, 16);
      g.addColorStop(0, 'rgba(255,255,235,1)'); g.addColorStop(0.35, `rgba(${GOLD},.9)`); g.addColorStop(1, `rgba(${BLUE},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 16, 0, 6.29); ctx.fill();
      if (u >= 1) { orbs.splice(i, 1); mtBoom(o.x1, o.y1, o.combo); }
    }
    ctx.globalCompositeOperation = 'lighter';
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]; p.life += dt;
      if (p.life >= p.max) { parts.splice(i, 1); continue; }
      const k = 1 - p.life / p.max;
      if (p.k === 'spark') {
        p.vy += p.g * dt; p.vx *= 0.985; p.x += p.vx * dt; p.y += p.vy * dt;
        ctx.fillStyle = `rgba(${p.c},${(k * 0.95).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.s * (0.5 + k * 0.5), 0, 6.29); ctx.fill();
      } else if (p.k === 'ring') {
        p.r += p.vr * dt * (0.4 + k);
        ctx.strokeStyle = `rgba(${p.c},${(k * 0.8).toFixed(3)})`; ctx.lineWidth = p.w * k + 0.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.29); ctx.stroke();
      } else if (p.k === 'rune') {
        p.rot += dt * 2.4;
        const r = 26 + (1 - k) * 22;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.strokeStyle = `rgba(${GOLD},${(k * 0.85).toFixed(3)})`; ctx.lineWidth = 1.6;
        ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.29); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = `rgba(${ICE},${(k * 0.9).toFixed(3)})`;
        for (let j = 0; j < 6; j++) { const a = j * Math.PI / 3; ctx.save(); ctx.translate(Math.cos(a) * r, Math.sin(a) * r); ctx.rotate(a); star(0, 0, 4); ctx.restore(); }
        ctx.restore();
      } else if (p.k === 'text') {
        p.y += p.vy * dt;
        ctx.globalCompositeOperation = 'source-over';
        ctx.font = '900 18px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.lineWidth = 4; ctx.strokeStyle = `rgba(5,8,16,${k.toFixed(3)})`; ctx.strokeText(p.str, p.x, p.y);
        ctx.fillStyle = `rgba(${p.c},${k.toFixed(3)})`; ctx.fillText(p.str, p.x, p.y);
        ctx.globalCompositeOperation = 'lighter';
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    const tankOn = drawTank(dt);
    if (parts.length || orbs.length || tankOn) raf = requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ abertura do Magic Tank
  function splash() {
    if (doc.getElementById('pv2-mt-splash')) return;
    injectStyle();
    const el = doc.createElement('div');
    el.id = 'pv2-mt-splash'; el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="ring"><img src="/assets/partner-magic-tank.png" alt=""></div><div class="t">MAGIC TANK</div><div class="s">MODO MÁGICO ATIVADO</div>';
    doc.body.appendChild(el);
    setTimeout(() => {
      ensureCanvas();
      const x = W / 2, y = H * 0.46;
      ring(x, y, GOLD, { r0: 60, vr: 420, max: 0.8, w: 3 });
      ring(x, y, BLUE, { r0: 60, vr: 300, max: 1, w: 2 });
      if (!reduce()) for (let i = 0; i < 40; i++) spark(x, y, pick([GOLD, BLUE, ICE]), { v: rnd(120, 420), max: rnd(0.6, 1.1) });
      wake();
    }, 350);
    setTimeout(() => el.remove(), 2700);
  }
  let wasMT = false, hadOtherTheme = false;
  function watchTheme() {
    const now = isMT();
    if (now && !wasMT) {
      // Trocou de outro tema pro Magic Tank nesta página = escolheu agora:
      // abertura sempre. Só carregou a página já com ele: uma vez por sessão.
      let seen = false;
      try { seen = sessionStorage.getItem('pv2_mt_splash') === '1'; sessionStorage.setItem('pv2_mt_splash', '1'); } catch (_) { /* sem storage */ }
      if (hadOtherTheme || !seen) setTimeout(() => { if (isMT() && allowed()) splash(); }, 150);
    }
    if (!now && global.PlusV2LiveCurrentTheme) hadOtherTheme = true;
    wasMT = now;
    colorsFor = null; // cores podem ter mudado
    hideSpot();
  }

  // ------------------------------------------------------------ eventos
  const TYPING = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';
  doc.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !allowed()) return;
    if (e.target && e.target.closest && e.target.closest(TYPING)) return;
    if (isMT()) mtFire(e.clientX, e.clientY); else ripple(e.clientX, e.clientY);
  }, { capture: true, passive: true });
  doc.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !allowed()) { hideSpot(); return; }
    moveSpot(e.target, e.clientX, e.clientY);
    if (!reduce()) trail(e.clientX, e.clientY);
  }, { passive: true });
  global.addEventListener('scroll', hideSpot, { capture: true, passive: true });
  global.addEventListener('blur', hideSpot);
  global.addEventListener('resize', () => { size(); hideSpot(); });

  function start() {
    if (!doc.body) return;
    watchTheme();
    new MutationObserver(watchTheme).observe(doc.body, { attributes: true, attributeFilter: ['class'] });
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();

  global.PlusV2Interact = { ripple, fire: mtFire, splash, active: allowed };
})(typeof window !== 'undefined' ? window : globalThis);
