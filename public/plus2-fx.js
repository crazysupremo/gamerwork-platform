// plus2-fx.js — motor de EFEITOS PERSONALIZADOS dos temas (v0.89.0).
// Lê theme.fx (criado no Estúdio de Temas) e desenha, sem nenhuma dependência:
//   • chuva / subida / flutuação de emojis e figurinhas
//   • varal de figurinhas no topo
//   • moldura animada em volta da tela (fogo, neon, gelo, brilho, estrelas)
//   • bichinhos andando ou BRIGANDO no rodapé
//   • mascote próprio que fala e reage ao clique
//   • reação ao chat: cada mensagem solta um "show" de figurinhas
(function (global) {
  'use strict';
  const doc = document;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const L = () => global.PlusV2Live;

  let cfg = null, sig = '', sprites = [], cv = null, ctx = null, raf = 0, last = 0;
  let W = 0, H = 0, dpr = 1;
  let parts = [], crit = [], edge = [], pops = [], garland = null, frameEl = null, mascotEl = null, bubble = null;
  let speakT = 0, resizeT = 0, impact = null, styled = false;

  const reduce = () => !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const factor = () => {
    const p = L() && L().prefs ? L().prefs() : {};
    return ({ leve: 0.5, normal: 1, intenso: 1.5 }[p.intensity] || 1) * (reduce() ? 0.3 : 1) * ((global.innerWidth || 1200) < 700 ? 0.6 : 1);
  };
  const allowed = () => {
    const l = L();
    if (!l) return true;
    if (l.state && l.state.performanceMode) return false;
    const p = l.prefs ? l.prefs() : {};
    return p.scene !== false;
  };

  // ------------------------------------------------------------ sprites
  function makeSprite(item) {
    const sp = { ready: false, src: null, ar: 1 };
    if (item.t === 'emoji') {
      const c = doc.createElement('canvas'); c.width = c.height = 96;
      const x = c.getContext('2d');
      x.font = '72px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(item.v, 48, 54);
      sp.src = c; sp.ready = true;
    } else {
      const im = new Image();
      im.onload = () => { sp.src = im; sp.ar = (im.naturalHeight || 1) / (im.naturalWidth || 1); sp.ready = true; };
      if (/^https:/.test(item.v)) im.referrerPolicy = 'no-referrer';
      im.src = item.v;
    }
    return sp;
  }
  function emojiSprite(ch) { return makeSprite({ t: 'emoji', v: ch }); }
  function draw(sp, x, y, s, rot, alpha, flip) {
    if (!sp || !sp.ready) return;
    ctx.save();
    ctx.translate(x, y);
    if (rot) ctx.rotate(rot);
    if (flip) ctx.scale(-1, 1);
    if (alpha < 1) ctx.globalAlpha = alpha;
    ctx.drawImage(sp.src, -s / 2, -s * sp.ar / 2, s, s * sp.ar);
    ctx.restore();
  }

  // ------------------------------------------------------------ DOM / CSS
  function injectStyle() {
    if (styled) return; styled = true;
    const st = doc.createElement('style');
    st.textContent = `
#pv2-tsp,#pv2-tsp canvas{pointer-events:none !important}
#pv2-cfx{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:94}
#pv2-cfx-frame{position:fixed;inset:0;pointer-events:none;z-index:93;border-radius:0}
#pv2-cfx-frame.neon{box-shadow:inset 0 0 0 2px var(--fx-c),inset 0 0 28px 4px var(--fx-c),inset 0 0 90px 6px color-mix(in srgb,var(--fx-c) 45%,transparent);animation:pv2fxneon 3.2s ease-in-out infinite}
#pv2-cfx-frame.glow{box-shadow:inset 0 0 70px 8px color-mix(in srgb,var(--fx-c) 55%,transparent);animation:pv2fxglow 4s ease-in-out infinite}
#pv2-cfx-frame.ice{box-shadow:inset 0 0 0 1px #d6f3ff,inset 0 0 60px 10px rgba(150,220,255,.55),inset 0 0 130px 6px rgba(120,190,255,.3);animation:pv2fxglow 5s ease-in-out infinite}
#pv2-cfx-frame.fire{box-shadow:inset 0 -60px 90px -20px rgba(255,90,0,.55),inset 0 0 70px 0 rgba(255,60,0,.28);animation:pv2fxglow 1.6s ease-in-out infinite}
#pv2-cfx-frame.sparkle{box-shadow:inset 0 0 60px 4px color-mix(in srgb,var(--fx-c) 30%,transparent)}
@keyframes pv2fxneon{0%,100%{opacity:.75}50%{opacity:1}}
@keyframes pv2fxglow{0%,100%{opacity:.6}50%{opacity:1}}
#pv2-cfx-garland{position:fixed;left:0;right:0;top:0;display:flex;justify-content:space-around;align-items:flex-start;pointer-events:none;z-index:91;overflow:hidden}
#pv2-cfx-garland::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent)}
#pv2-cfx-garland .g{transform-origin:50% 0;animation:pv2fxswing 2.8s ease-in-out infinite;display:flex;flex-direction:column;align-items:center}
#pv2-cfx-garland .g::before{content:"";width:1px;height:10px;background:rgba(255,255,255,.4)}
#pv2-cfx-garland .g>*{display:block;object-fit:contain;line-height:1}
@keyframes pv2fxswing{0%,100%{transform:rotate(-7deg)}50%{transform:rotate(7deg)}}
#pv2-cfx-mascot{position:fixed;right:22px;bottom:96px;z-index:97;cursor:pointer;pointer-events:auto;animation:pv2fxbob 2.4s ease-in-out infinite;filter:drop-shadow(0 6px 10px rgba(0,0,0,.45));user-select:none;-webkit-user-select:none}
#pv2-cfx-mascot>*{display:block;line-height:1;object-fit:contain}
#pv2-cfx-mascot.hop{animation:pv2fxhop .55s ease-out}
@keyframes pv2fxbob{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
@keyframes pv2fxhop{0%{transform:translateY(0) scale(1)}40%{transform:translateY(-36px) scale(1.12,.92)}100%{transform:translateY(0) scale(1)}}
#pv2-cfx-bubble{position:fixed;right:22px;bottom:176px;max-width:230px;z-index:98;background:rgba(255,255,255,.97);color:#1d1d2b;padding:8px 12px;border-radius:14px 14px 4px 14px;font:700 12.5px/1.35 var(--pv2-font-body,system-ui,sans-serif);box-shadow:0 8px 24px rgba(0,0,0,.4);opacity:0;transform:translateY(6px);transition:.25s;pointer-events:none}
#pv2-cfx-bubble.show{opacity:1;transform:none}
@media(max-width:700px){#pv2-cfx-mascot{right:10px;bottom:84px}#pv2-cfx-bubble{right:10px;bottom:150px;max-width:190px}}`;
    doc.head.appendChild(st);
  }
  function ensureCanvas() {
    if (cv) return;
    injectStyle();
    cv = doc.createElement('canvas'); cv.id = 'pv2-cfx';
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
  function itemEl(i, px) {
    const it = cfg.items[i]; if (!it) return null;
    if (it.t === 'emoji') { const s = doc.createElement('span'); s.textContent = it.v; s.style.fontSize = px + 'px'; return s; }
    const im = doc.createElement('img'); im.src = it.v; im.width = px; im.height = px; im.alt = ''; im.draggable = false;
    if (/^https:/.test(it.v)) im.referrerPolicy = 'no-referrer';
    return im;
  }
  function buildGarland() {
    if (!cfg.garland.on || !cfg.items.length) return;
    const px = cfg.garland.size, n = Math.max(4, Math.min(30, Math.floor((global.innerWidth || 1200) / (px * 1.9))));
    garland = doc.createElement('div'); garland.id = 'pv2-cfx-garland';
    garland.style.height = (px * 1.8 + 12) + 'px';
    for (let i = 0; i < n; i++) {
      const g = doc.createElement('div'); g.className = 'g';
      g.style.animationDelay = (-Math.random() * 2.8).toFixed(2) + 's';
      g.style.marginTop = ((i % 2) * 8) + 'px';
      const e = itemEl(i % cfg.items.length, px); if (e) g.appendChild(e);
      garland.appendChild(g);
    }
    doc.body.appendChild(garland);
  }
  function buildFrame() {
    const f = cfg.frame; if (f.type === 'none') return;
    injectStyle();
    frameEl = doc.createElement('div'); frameEl.id = 'pv2-cfx-frame'; frameEl.className = f.type;
    frameEl.style.setProperty('--fx-c', f.color || 'var(--accent, #5b6cff)');
    frameEl.style.opacity = String(Math.min(1, 0.55 + f.power * 0.3));
    doc.body.appendChild(frameEl);
  }
  function say(text, ms) {
    if (!bubble || !text) return;
    bubble.textContent = text; bubble.classList.add('show');
    clearTimeout(say.t); say.t = setTimeout(() => bubble && bubble.classList.remove('show'), ms || 3200);
  }
  function userName() {
    return (L() && L().prefs && L().prefs().name) || global.PlusV2UserName || '';
  }
  function fill(s) { return s.replace(/\{nome\}/gi, userName() || 'amigo'); }
  function buildMascot() {
    const m = cfg.mascot; if (!m.on || !cfg.items.length) return;
    injectStyle();
    mascotEl = doc.createElement('div'); mascotEl.id = 'pv2-cfx-mascot';
    const e = itemEl(m.item, 64); if (e) mascotEl.appendChild(e);
    bubble = doc.createElement('div'); bubble.id = 'pv2-cfx-bubble';
    doc.body.appendChild(mascotEl); doc.body.appendChild(bubble);
    const lines = m.lines.length ? m.lines : ['Oi, {nome}!', 'Bora jogar?', 'Gostei desse tema!'];
    const talk = () => {
      if (mascotEl) { if (!(L() && L().prefs && L().prefs().talk === false)) say((m.name ? m.name + ': ' : '') + fill(pick(lines)), 3600); }
      speakT = setTimeout(talk, rnd(22000, 38000));
    };
    speakT = setTimeout(talk, 4000);
    mascotEl.addEventListener('click', (ev) => {
      ev.stopPropagation();
      mascotEl.classList.remove('hop'); void mascotEl.offsetWidth; mascotEl.classList.add('hop');
      const r = mascotEl.getBoundingClientRect();
      burst(r.left + r.width / 2, r.top + r.height / 2, 16);
      say(fill(pick(lines)), 3000);
    });
  }

  // ------------------------------------------------------------ partículas
  function spawnFall(initial) {
    const f = cfg.fall, s = f.size * rnd(0.7, 1.25), i = Math.floor(Math.random() * cfg.items.length);
    const p = { i, s, x: rnd(0, W), y: 0, vx: rnd(-14, 14), vy: 0, rot: rnd(0, 6.28), vr: rnd(-1.2, 1.2), ph: rnd(0, 6.28), a: rnd(0.75, 1), life: 0 };
    if (f.mode === 'fall') { p.y = initial ? rnd(-20, H) : -s; p.vy = rnd(35, 80) * f.speed; }
    else if (f.mode === 'rise') { p.y = initial ? rnd(0, H + 20) : H + s; p.vy = -rnd(35, 85) * f.speed; p.vr *= 0.3; }
    else { p.y = rnd(0, H); p.vy = rnd(-14, 14) * f.speed; p.vx = rnd(-22, 22) * f.speed; p.vr *= 0.4; }
    parts.push(p);
  }
  function burst(x, y, n) {
    if (!cfg || !cfg.items.length || !cv) return;
    n = Math.round(n * Math.min(1.4, factor()));
    for (let k = 0; k < n; k++) {
      const a = rnd(-Math.PI * 0.95, -Math.PI * 0.05), v = rnd(140, 380);
      pops.push({ i: Math.floor(Math.random() * cfg.items.length), x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, s: rnd(16, 34), rot: rnd(0, 6.28), vr: rnd(-6, 6), life: 0, max: rnd(1.0, 1.7) });
    }
    wake();
  }
  function buildCritters() {
    const c = cfg.critters; if (!c.on || !cfg.items.length) return;
    const pool = c.items.length ? c.items : cfg.items.map((_, i) => i);
    const n = Math.max(1, Math.round(c.count * Math.min(1.2, factor() + 0.2)));
    impact = emojiSprite('💥');
    for (let i = 0; i < n; i++) {
      crit.push({ i: pool[i % pool.length], x: rnd(60, W - 60), dir: Math.random() < 0.5 ? -1 : 1, sp: rnd(30, 70), ph: rnd(0, 6), hop: 0, pair: -1, cx: 0, t: rnd(0, 5), hit: 0 });
    }
    if (c.mode === 'fight') {
      for (let i = 0; i + 1 < crit.length; i += 2) {
        const cx = rnd(W * 0.2, W * 0.8);
        crit[i].pair = i + 1; crit[i + 1].pair = i; crit[i].cx = crit[i + 1].cx = cx;
        crit[i].side = -1; crit[i + 1].side = 1;
        crit[i].t = crit[i + 1].t = rnd(0, 6);
      }
    }
  }
  function updCritters(dt) {
    const c = cfg.critters, S = c.size;
    crit.forEach((q) => {
      q.ph += dt * 6; if (q.hop > 0) q.hop = Math.max(0, q.hop - dt * 2.2);
      if (c.mode === 'fight' && q.pair >= 0) {
        q.t = (q.t + dt) % 6;
        const t = q.t; let gap;
        if (t < 2) gap = 300 - (t / 2) * 262;            // aproxima
        else if (t < 4) { gap = 38 + Math.sin(t * 22) * 7; // briga
          const k = Math.floor(t * 4);
          if (k !== q.lastK) { q.lastK = k; if (q.side === -1) { pops.push({ spr: 'imp', x: q.cx + rnd(-10, 10), y: H - S * 0.9 - 8 - rnd(0, 18), vx: 0, vy: -20, s: S * 0.8, rot: rnd(-0.4, 0.4), vr: 0, life: 0, max: 0.45 }); wake(); } }
        } else gap = 38 + ((t - 4) / 2) * 262;           // afasta
        q.x = q.cx + q.side * gap / 2;
        q.dir = -q.side;
        q.shake = t >= 2 && t < 4 ? Math.sin(t * 40) * 3 : 0;
      } else {
        q.x += q.dir * q.sp * dt;
        if (q.x < 30) { q.x = 30; q.dir = 1; } else if (q.x > W - 30) { q.x = W - 30; q.dir = -1; }
        if (Math.random() < dt * 0.15) q.dir *= -1;
        q.shake = 0;
      }
    });
  }
  function drawCritters() {
    const S = cfg.critters.size;
    crit.forEach((q) => {
      const bob = Math.abs(Math.sin(q.ph)) * 6 + Math.sin(q.hop * Math.PI) * 40;
      draw(sprites[q.i], q.x + (q.shake || 0), H - S * 0.55 - 6 - bob, S, Math.sin(q.ph) * 0.08, 1, q.dir > 0);
    });
  }
  // moldura de partículas
  function emitEdge(dt) {
    const f = cfg.frame; if (f.type !== 'fire' && f.type !== 'sparkle' && f.type !== 'ice') return;
    const pw = f.power * factor();
    if (f.type === 'fire') {
      let n = (W / 9 + H / 22) * dt * pw * 1.6;
      while (n-- > 0 || Math.random() < n + 1) {
        const r = Math.random(); let x, y, vx = rnd(-14, 14), vy = -rnd(50, 120), s = rnd(14, 30);
        if (r < 0.62) { x = rnd(-10, W + 10); y = H + 6; }
        else if (r < 0.9) { x = Math.random() < 0.5 ? -4 : W + 4; y = rnd(H * 0.2, H + 6); vx = x < 0 ? rnd(8, 26) : -rnd(8, 26); s *= 0.8; }
        else { x = rnd(0, W); y = -4; vy = rnd(8, 30); s *= 0.5; }
        edge.push({ x, y, vx, vy, s, life: 0, max: rnd(0.8, 1.5), k: 'fire' });
        if (n < 0) break;
      }
    } else {
      let n = (W + H) / 70 * dt * pw;
      while (n-- > 0 || Math.random() < n + 1) {
        const side = Math.floor(Math.random() * 4);
        const x = side === 0 ? rnd(0, W) : side === 1 ? rnd(0, W) : side === 2 ? rnd(0, 26) : W - rnd(0, 26);
        const y = side === 0 ? rnd(0, 22) : side === 1 ? H - rnd(0, 22) : rnd(0, H);
        edge.push({ x, y, vx: rnd(-6, 6), vy: f.type === 'ice' ? rnd(10, 36) : rnd(-8, 8), s: rnd(5, 12), life: 0, max: rnd(1.1, 2.2), k: f.type === 'ice' ? 'ice' : 'star' });
        if (n < 0) break;
      }
    }
    if (edge.length > 420) edge.splice(0, edge.length - 420);
  }
  function star(x, y, r, a, c) {
    ctx.save(); ctx.translate(x, y); ctx.globalAlpha = a; ctx.fillStyle = c;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) { const rr = i % 2 ? r * 0.28 : r; const ang = i * Math.PI / 4; ctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr); }
    ctx.closePath(); ctx.fill(); ctx.restore();
  }
  function drawEdge(dt) {
    const col = cfg.frame.color;
    ctx.save();
    for (let i = edge.length - 1; i >= 0; i--) {
      const p = edge[i]; p.life += dt;
      if (p.life >= p.max) { edge.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; const k = p.life / p.max;
      if (p.k === 'fire') {
        p.vx += Math.sin(p.life * 9 + p.x) * 22 * dt;
        const r = p.s * (1 - k * 0.7);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        const hot = k < 0.3 ? '255,235,160' : k < 0.6 ? '255,150,30' : '230,50,10';
        g.addColorStop(0, 'rgba(' + hot + ',' + (0.85 * (1 - k)).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(' + hot + ',0)');
        ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.2832); ctx.fill();
      } else {
        ctx.globalCompositeOperation = 'lighter';
        const a = Math.sin(k * Math.PI);
        star(p.x, p.y, p.s * (p.k === 'ice' ? 0.7 : 1), a, p.k === 'ice' ? '#dff6ff' : (col || '#ffe9a8'));
      }
    }
    ctx.restore();
  }
  function wake() { if (!raf && cv) { last = 0; raf = requestAnimationFrame(tick); } }
  function needsLoop() {
    return !!(cfg && (cfg.fall.on || cfg.critters.on || ['fire', 'ice', 'sparkle'].includes(cfg.frame.type))) || pops.length;
  }
  function tick(t) {
    raf = 0;
    if (!cv) return;
    if (doc.hidden) { raf = requestAnimationFrame(tick); last = 0; return; }
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016; last = t;
    ctx.clearRect(0, 0, W, H);
    if (cfg) {
      if (cfg.fall.on && cfg.items.length) {
        const target = Math.round(cfg.fall.count * factor());
        while (parts.length < target) spawnFall(parts.length === 0 || last < 0);
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          p.ph += dt * 1.6; p.x += (p.vx + Math.sin(p.ph) * 18) * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
          const out = cfg.fall.mode === 'fall' ? p.y > H + p.s : cfg.fall.mode === 'rise' ? p.y < -p.s : false;
          if (cfg.fall.mode === 'float') { if (p.x < -p.s) p.x = W + p.s; if (p.x > W + p.s) p.x = -p.s; if (p.y < -p.s) p.y = H + p.s; if (p.y > H + p.s) p.y = -p.s; }
          if (out || parts.length > target) { parts.splice(i, 1); continue; }
          draw(sprites[p.i], p.x, p.y, p.s, p.rot, p.a);
        }
      }
      emitEdge(dt); drawEdge(dt);
      if (crit.length) { updCritters(dt); drawCritters(); }
    }
    for (let i = pops.length - 1; i >= 0; i--) {
      const p = pops[i]; p.life += dt;
      if (p.life > p.max) { pops.splice(i, 1); continue; }
      p.vy += (p.spr ? 0 : 620) * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      const a = Math.min(1, (p.max - p.life) * 2.5);
      if (p.spr) { const sc = 0.6 + Math.sin(Math.min(1, p.life / p.max) * Math.PI) * 0.7; draw(impact, p.x, p.y, p.s * sc, p.rot, a); }
      else draw(sprites[p.i], p.x, p.y, p.s, p.rot, a);
    }
    if (needsLoop()) raf = requestAnimationFrame(tick);
  }


  // ------------------------------------------------------------ tsParticles (motor open source)
  // https://github.com/tsparticles/tsparticles (licença MIT). Carregado sob demanda
  // da CDN — não entra no zip. Se não carregar (sem internet), o resto dos efeitos continua.
  const TSP_URL = 'https://cdn.jsdelivr.net/npm/tsparticles@3.9.1/tsparticles.bundle.min.js';
  let tspLoad = null, tspC = null, tspTok = 0;
  function loadTsp() {
    if (global.tsParticles) return Promise.resolve(global.tsParticles);
    if (!tspLoad) tspLoad = new Promise((ok, bad) => {
      const s = doc.createElement('script'); s.src = TSP_URL; s.async = true;
      s.onload = () => (global.tsParticles ? ok(global.tsParticles) : bad(new Error('tsParticles ausente')));
      s.onerror = () => { tspLoad = null; bad(new Error('sem acesso à CDN')); };
      doc.head.appendChild(s);
    });
    return tspLoad;
  }
  function accent() {
    try { return (getComputedStyle(doc.documentElement).getPropertyValue('--accent') || '').trim() || '#5b6cff'; } catch (_) { return '#5b6cff'; }
  }
  function tspOptions(preset, color) {
    const k = factor(), c = color || accent();
    const base = {
      fullScreen: { enable: true, zIndex: 92 }, background: { color: { value: 'transparent' } }, fpsLimit: 60, detectRetina: true,
      interactivity: { detectsOn: 'window', events: { onHover: { enable: true, mode: 'repulse' }, onClick: { enable: true, mode: 'push' } }, modes: { repulse: { distance: 110, duration: 0.4 }, push: { quantity: 3 } } },
    };
    const fade = (speed) => ({ enable: true, speed, startValue: 'max', destroy: 'min', sync: false });
    const P = {
      snow: { particles: { number: { value: Math.round(90 * k), density: { enable: true } }, color: { value: '#ffffff' }, shape: { type: 'circle' }, opacity: { value: { min: 0.3, max: 0.9 } }, size: { value: { min: 1, max: 5 } }, move: { enable: true, direction: 'bottom', speed: { min: 1, max: 3 }, outModes: { default: 'out' } } } },
      stars: { particles: { number: { value: Math.round(80 * k), density: { enable: true } }, color: { value: ['#ffffff', '#ffe9a8', c] }, shape: { type: 'star' }, opacity: { value: { min: 0.2, max: 1 }, animation: { enable: true, speed: 1, sync: false } }, size: { value: { min: 1, max: 4 } }, move: { enable: true, speed: 0.35, direction: 'none', random: true, outModes: { default: 'out' } } } },
      fireflies: { particles: { number: { value: Math.round(40 * k), density: { enable: true } }, color: { value: color || '#d9ff66' }, shape: { type: 'circle' }, shadow: { enable: true, color: color || '#d9ff66', blur: 12 }, opacity: { value: { min: 0.2, max: 1 }, animation: { enable: true, speed: 0.8, sync: false } }, size: { value: { min: 2, max: 4 } }, move: { enable: true, speed: 0.8, direction: 'none', random: true, outModes: { default: 'out' } } } },
      bubbles: { particles: { number: { value: Math.round(32 * k), density: { enable: true } }, color: { value: color || '#9be7ff' }, shape: { type: 'circle' }, opacity: { value: 0.25 }, stroke: { width: 1, color: { value: '#ffffff' }, opacity: 0.5 }, size: { value: { min: 4, max: 18 } }, move: { enable: true, direction: 'top', speed: { min: 0.8, max: 2 }, outModes: { default: 'out' } } } },
      links: { particles: { number: { value: Math.round(60 * k), density: { enable: true } }, color: { value: c }, links: { enable: true, distance: 140, color: c, opacity: 0.4, width: 1 }, shape: { type: 'circle' }, opacity: { value: 0.6 }, size: { value: { min: 1, max: 3 } }, move: { enable: true, speed: 1.2, direction: 'none', outModes: { default: 'bounce' } } } },
      confetti: { particles: { number: { value: Math.round(70 * k), density: { enable: true } }, color: { value: ['#ff2e93', '#ffd54a', '#2979ff', '#00e676', '#b44bff', '#ff6d00'] }, shape: { type: ['square', 'circle'] }, opacity: { value: { min: 0.7, max: 1 } }, size: { value: { min: 4, max: 9 } }, rotate: { value: { min: 0, max: 360 }, animation: { enable: true, speed: 20 } }, move: { enable: true, direction: 'bottom', speed: { min: 2, max: 5 }, outModes: { default: 'out' } } } },
      fire: { particles: { number: { value: 0 }, color: { value: ['#ff4500', '#ff8c00', '#ffd000'] }, shape: { type: 'circle' }, opacity: { value: { min: 0.2, max: 0.85 }, animation: fade(1.4) }, size: { value: { min: 3, max: 10 }, animation: fade(6) }, move: { enable: true, direction: 'top', speed: { min: 2, max: 5 }, random: true, outModes: { default: 'destroy' } } },
        emitters: [{ direction: 'top', rate: { delay: Math.max(0.03, 0.07 / k), quantity: 4 }, position: { x: 50, y: 100 }, size: { mode: 'percent', width: 100, height: 0 } }] },
    };
    if (!P[preset]) return null;
    return Object.assign({}, base, P[preset]);
  }
  async function startTsp(t) {
    const tok = ++tspTok;
    try {
      const o = tspOptions(t.preset, t.color); if (!o) return;
      const lib = await loadTsp();
      if (tok !== tspTok) return;
      const c = await lib.load({ id: 'pv2-tsp', options: o });
      if (tok !== tspTok) { if (c) c.destroy(); return; }
      tspC = c;
    } catch (err) { if (global.console) console.warn('[tema] tsParticles indisponível:', err && err.message); }
  }
  function stopTsp() {
    tspTok++;
    if (tspC) { try { tspC.destroy(); } catch (_) { /* já destruído */ } tspC = null; }
    const e = doc.getElementById('pv2-tsp'); if (e) e.remove();
  }

  // ------------------------------------------------------------ ciclo de vida
  function clearAll() {
    cancelAnimationFrame(raf); raf = 0; clearTimeout(speakT); stopTsp();
    [cv, garland, frameEl, mascotEl, bubble].forEach((e) => e && e.remove());
    cv = ctx = garland = frameEl = mascotEl = bubble = null;
    parts = []; crit = []; edge = []; pops = []; sprites = []; impact = null;
  }
  function applyFont(name) {
    if (!name) return;
    const id = 'pv2-cfx-font';
    let l = doc.getElementById(id);
    if (!l) { l = doc.createElement('link'); l.id = id; l.rel = 'stylesheet'; doc.head.appendChild(l); }
    l.href = 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(name).replace(/%20/g, '+') + ':wght@400;600;800&display=swap';
    const root = doc.documentElement;
    root.style.setProperty('--pv2-font-body', '"' + name + '"');
    root.style.setProperty('--pv2-font-display', '"' + name + '"');
    doc.body.classList.add('pv2-has-font');
  }
  function set(fx) {
    const s = fx ? JSON.stringify(fx) : '';
    if (s === sig && (cv || !fx)) return;
    sig = s;
    clearAll();
    cfg = null;
    if (!fx || !allowed()) return;
    const hasAny = fx.items && fx.items.length;
    if (fx.googleFont) applyFont(fx.googleFont);
    const tsp = fx.tsp && fx.tsp.preset ? fx.tsp : null;
    if (!hasAny && fx.frame.type === 'none' && !tsp) return;
    cfg = fx;
    sprites = fx.items.map(makeSprite);
    ensureCanvas();
    buildFrame(); buildGarland(); buildMascot(); buildCritters();
    if (tsp) startTsp(tsp);
    wake();
  }
  function onChat(ev) {
    const d = (ev && ev.detail) || {};
    const rect = (() => {
      const m = doc.querySelectorAll('#messages > *'); const el = m[m.length - 1];
      return el ? el.getBoundingClientRect() : null;
    })();
    const x = rect ? Math.min(W - 40, rect.left + Math.min(rect.width, 280) * (d.own ? 0.8 : 0.3)) : (global.innerWidth || 800) / 2;
    const y = rect ? Math.min((global.innerHeight || 800) - 90, Math.max(80, rect.bottom - 10)) : (global.innerHeight || 800) - 120;
    if (cfg && cfg.chat.burst && allowed()) {
      burst(x, y, d.mention ? 26 : 10);
      crit.forEach((q) => { q.hop = 1; });
      if (mascotEl && Math.random() < 0.35) {
        const lines = cfg.mascot.lines.length ? cfg.mascot.lines : ['Boa!', 'Mensagem nova!'];
        say(fill(pick(lines)), 2200);
        mascotEl.classList.remove('hop'); void mascotEl.offsetWidth; mascotEl.classList.add('hop');
      }
      return;
    }
    // temas prontos (Natal etc.): faz a cena e o mascote reagirem
    const l = L();
    if (l && l.poke && allowed()) l.poke(x, y);
    if (global.PlusV2Mascot && global.PlusV2Mascot.cheer) global.PlusV2Mascot.cheer(d.mention);
  }
  global.addEventListener('pv2:chat', onChat);
  global.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (cv) { size(); if (garland) { garland.remove(); garland = null; buildGarland(); } } }, 200);
  });
  global.PlusV2Fx = { set, burst: (x, y, n) => burst(x, y, n || 12), active: () => !!cfg };
})(typeof window !== 'undefined' ? window : globalThis);
