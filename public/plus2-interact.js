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
  // Cursor "varinha mágica" do Magic Tank (SVG desenhado aqui, sem arquivo extra).
  const wandSvg = (hot) => "url(\"data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'>" +
    (hot ? "<circle cx='6' cy='6' r='6' fill='rgba(127,217,255,.55)'/>" : '') +
    "<line x1='9' y1='9' x2='28' y2='28' stroke='#05080f' stroke-width='5.5' stroke-linecap='round'/>" +
    "<line x1='9' y1='9' x2='28' y2='28' stroke='#1a6fd1' stroke-width='3' stroke-linecap='round'/>" +
    "<line x1='23' y1='23' x2='28' y2='28' stroke='#fbdc70' stroke-width='3' stroke-linecap='round'/>" +
    "<path d='M6 0l1.6 4.2L12 6l-4.4 1.8L6 12l-1.6-4.2L0 6l4.4-1.8z' fill='#fbdc70' stroke='#7a5a10' stroke-width='.7'/>" +
    "</svg>") + "\")";
  const WAND = wandSvg(false), WAND_HOT = wandSvg(true);
  let styled = false;
  function injectStyle() {
    if (styled) return; styled = true;
    const st = doc.createElement('style');
    st.id = 'pv2-ix-style';
    st.textContent = `
#pv2-ix{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:96}
body.pv2-modal-open :is(#pv2-ix,#pv2-spot,#plus2-fx,#plus2-scene,#plus2-decor,#pv2-cfx,#pv2-tsp,#plus2-mascot-layer,#pv2-cfx-mascot,#pv2-cfx-bubble,#pv2-cfx-garland){display:none!important}
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
#pv2-fest-hello{position:fixed;left:50%;top:72px;transform:translateX(-50%);z-index:9500;pointer-events:none;
  padding:9px 16px;border-radius:999px;font:800 13px/1.2 var(--pv2-font-body,system-ui,sans-serif);color:#fff;white-space:nowrap;
  background:rgba(12,10,22,.88);border:1px solid rgba(var(--c),.7);box-shadow:0 8px 26px rgba(0,0,0,.45),0 0 22px rgba(var(--c),.35);
  animation:pv2festHello 4.2s ease forwards}
@keyframes pv2festHello{0%{opacity:0;transform:translate(-50%,-10px)}8%,82%{opacity:1;transform:translate(-50%,0)}100%{opacity:0;transform:translate(-50%,-6px)}}
@media(max-width:600px){#pv2-fest-hello{top:60px;font-size:12px;max-width:calc(100vw - 24px);white-space:normal;text-align:center}}
body.pv2-modal-open #pv2-fest-hello,body.pv2-modal-open #pv2-nb-scene{display:none}
#pv2-nb-sweep{position:fixed;pointer-events:none;z-index:94;overflow:hidden;opacity:0}
#pv2-nb-sweep.go{opacity:1}
#pv2-nb-sweep::before{content:"";position:absolute;top:0;bottom:0;width:38%;left:-40%;background:linear-gradient(90deg,transparent,rgba(255,61,154,.20) 40%,rgba(45,226,230,.28) 60%,transparent);filter:blur(2px)}
#pv2-nb-sweep.go::before{animation:pv2nbSweep .6s cubic-bezier(.4,0,.2,1) forwards}
#pv2-nb-sweep::after{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,transparent,#ff3d9a,#2de2e6,transparent);opacity:0}
#pv2-nb-sweep.go::after{animation:pv2nbLine .6s ease forwards}
@keyframes pv2nbSweep{to{left:110%}}
@keyframes pv2nbLine{0%{opacity:0;transform:scaleX(.2)}30%{opacity:1}100%{opacity:0;transform:scaleX(1)}}
.app-main.pv2-nb-enter .main>section:not(.hidden){animation:pv2nbEnter .42s cubic-bezier(.2,.9,.3,1)}
@keyframes pv2nbEnter{from{opacity:.25;transform:translateY(10px)}to{opacity:1;transform:none}}
body.pv2-nb-on .modal-overlay:not(.hidden) .modal-card{animation:pv2nbModal .34s cubic-bezier(.2,1.25,.4,1);border:1px solid rgba(255,61,154,.55)!important;
  box-shadow:0 0 0 1px rgba(45,226,230,.18),0 0 34px rgba(255,61,154,.32),0 26px 70px rgba(0,0,0,.6)!important;
  background-image:linear-gradient(180deg,rgba(255,61,154,.16),rgba(255,154,60,.05) 70px,transparent 120px)!important}
@keyframes pv2nbModal{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}
body.pv2-nb-on .modal-card h2,body.pv2-nb-on .home-section-title{background:linear-gradient(90deg,#fff6fb,#ffd1ea 50%,#ffb04a);-webkit-background-clip:text;background-clip:text;color:transparent;text-shadow:none;filter:drop-shadow(0 0 8px rgba(255,61,154,.45))}
body.pv2-nb-on .message.msg-own{box-shadow:inset 3px 0 0 #ff3d9a,0 0 18px -10px rgba(255,61,154,.8)!important}
body.pv2-nb-on .message:not(.msg-own):not(.bot-message){box-shadow:inset 3px 0 0 rgba(45,226,230,.75)!important}
body.pv2-nb-on #message-input:focus{box-shadow:0 0 0 2px rgba(255,61,154,.85),0 0 22px rgba(255,61,154,.45),0 0 40px rgba(45,226,230,.2)!important;border-color:#ff3d9a!important}
body.pv2-nb-on .copy-toast{background:linear-gradient(135deg,rgba(40,8,48,.96),rgba(18,4,26,.96))!important;color:#fff4fa!important;border:1px solid #ff3d9a!important;box-shadow:0 0 16px rgba(255,61,154,.55),0 10px 30px rgba(0,0,0,.5)!important;text-shadow:0 0 8px rgba(255,61,154,.6)}
body.pv2-nb-on .sidebar-nav-item.active{box-shadow:inset 3px 0 0 #ff3d9a,0 0 18px -6px rgba(255,61,154,.7)!important;background:linear-gradient(90deg,rgba(255,61,154,.22),rgba(45,226,230,.06))!important}
body.pv2-nb-on .sidebar-nav-item:hover{background:linear-gradient(90deg,rgba(255,61,154,.12),transparent)!important}
body.pv2-nb-on .member-avatar{box-shadow:0 0 0 2px rgba(255,61,154,.55),0 0 12px rgba(45,226,230,.35)}
body.pv2-nb-on ::-webkit-scrollbar-thumb{background:linear-gradient(180deg,#ff3d9a,#2de2e6)!important;border-radius:8px}
body.pv2-nb-on *{scrollbar-color:#ff3d9a transparent}
body.pv2-nb-on .navbar-badge{background:#ff3d9a!important;box-shadow:0 0 10px rgba(255,61,154,.8)!important}
@media (prefers-reduced-motion:reduce){.app-main.pv2-nb-enter .main>section{animation:none!important}body.pv2-nb-on .modal-overlay:not(.hidden) .modal-card{animation:none}}

#pv2-nb-scene{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden}
#pv2-nb-scene>*{position:absolute;pointer-events:none}
#pv2-nb-scene .nb-stars{inset:0;width:100%;height:100%;display:block}
#pv2-nb-scene .nb-sky{inset:0;background:radial-gradient(ellipse 85% 60% at 50% 102%,rgba(255,61,154,.42),rgba(122,31,160,.18) 48%,rgba(18,5,31,0) 76%),linear-gradient(180deg,rgba(10,3,20,.0),rgba(36,8,58,.35))}
#pv2-nb-scene .nb-sky2{inset:0;background:radial-gradient(ellipse 60% 42% at 50% 100%,rgba(255,154,60,.38),rgba(255,154,60,0) 70%);animation:nbSkyPulse 7s ease-in-out infinite}
@keyframes nbSkyPulse{0%,100%{opacity:.55}50%{opacity:1}}
#pv2-nb-scene .nb-beam{bottom:-6%;width:22vw;min-width:160px;height:125vh;transform-origin:50% 100%;
  clip-path:polygon(47% 100%,53% 100%,100% 0,0 0);will-change:transform;animation:nbBeam 11s ease-in-out infinite alternate}
#pv2-nb-scene .b1{left:12%;background:linear-gradient(to top,rgba(45,226,230,.30),rgba(45,226,230,.08) 55%,rgba(45,226,230,0) 85%)}
#pv2-nb-scene .b2{right:12%;background:linear-gradient(to top,rgba(255,61,154,.30),rgba(255,61,154,.08) 55%,rgba(255,61,154,0) 85%);animation-delay:-5.5s;animation-direction:alternate-reverse}
#pv2-nb-scene .b3{left:46%;width:16vw;background:linear-gradient(to top,rgba(255,214,120,.18),rgba(255,214,120,0) 70%);animation-duration:15s;animation-delay:-3s}
@keyframes nbBeam{0%{transform:rotate(-24deg)}100%{transform:rotate(24deg)}}
#pv2-nb-scene .nb-orb{border-radius:50%;will-change:transform;animation:nbFloat 22s ease-in-out infinite alternate}
#pv2-nb-scene .o1{width:340px;height:340px;left:8%;top:18%;background:radial-gradient(circle,rgba(255,61,154,.20),rgba(255,61,154,0) 68%)}
#pv2-nb-scene .o2{width:420px;height:420px;right:6%;top:8%;background:radial-gradient(circle,rgba(45,226,230,.16),rgba(45,226,230,0) 68%);animation-duration:27s;animation-delay:-8s}
#pv2-nb-scene .o3{width:260px;height:260px;left:42%;top:30%;background:radial-gradient(circle,rgba(255,154,60,.16),rgba(255,154,60,0) 68%);animation-duration:19s;animation-delay:-4s}
#pv2-nb-scene .o4{width:300px;height:300px;left:62%;bottom:12%;background:radial-gradient(circle,rgba(160,80,255,.18),rgba(160,80,255,0) 68%);animation-duration:24s;animation-delay:-12s}
#pv2-nb-scene .o5{width:220px;height:220px;left:24%;bottom:22%;background:radial-gradient(circle,rgba(45,226,230,.14),rgba(45,226,230,0) 68%);animation-duration:17s;animation-delay:-6s}
@keyframes nbFloat{0%{transform:translate(0,0) scale(1)}33%{transform:translate(60px,-40px) scale(1.12)}66%{transform:translate(-50px,30px) scale(.92)}100%{transform:translate(30px,50px) scale(1.06)}}
#pv2-nb-scene .nb-shoot{top:10%;left:-12%;width:140px;height:2px;border-radius:2px;opacity:0;
  background:linear-gradient(90deg,rgba(255,255,255,0),#fff 70%,#ffe8f4);box-shadow:0 0 8px rgba(255,255,255,.8);will-change:transform,opacity;animation:nbShoot 9s linear infinite}
#pv2-nb-scene .s2{top:22%;animation-delay:-3.3s;animation-duration:11s}
#pv2-nb-scene .s3{top:5%;animation-delay:-6.6s;animation-duration:13s}
@keyframes nbShoot{0%{transform:translate(0,0) rotate(14deg);opacity:0}2%{opacity:1}10%{transform:translate(78vw,19vw) rotate(14deg);opacity:0}100%{transform:translate(78vw,19vw) rotate(14deg);opacity:0}}
#pv2-nb-scene .nb-horizon{left:0;right:0;bottom:55%;height:2px;background:linear-gradient(90deg,transparent,#ff3d9a 25%,#2de2e6 50%,#ff3d9a 75%,transparent);
  box-shadow:0 0 14px rgba(255,61,154,.7),0 0 30px rgba(45,226,230,.4);animation:nbHz 4.5s ease-in-out infinite}
@keyframes nbHz{0%,100%{opacity:.45}50%{opacity:.95}}
@media(max-width:700px){#pv2-nb-scene .b3,#pv2-nb-scene .o4,#pv2-nb-scene .o5,#pv2-nb-scene .s3{display:none}}
body.pv2-nb-on.pv2-scene-active .app-main{background:color-mix(in srgb,var(--bg-app) 38%,transparent)!important}
body.pv2-nb-on.pv2-scene-active .main{background:color-mix(in srgb,var(--bg-panel,#1d1117) 30%,transparent)!important}
body.pv2-nb-on.pv2-scene-active .app-sidebar{background:color-mix(in srgb,var(--bg-rail) 66%,transparent)!important}
body.pv2-nb-on.pv2-scene-active .main-header{background:color-mix(in srgb,var(--bg-panel,#1d1117) 55%,transparent)!important}
body.pv2-nb-on.pv2-scene-active .top-navbar{background:color-mix(in srgb,var(--bg-sidebar) 70%,transparent)!important}
body.pv2-nb-on .home-tournament-banner-text h2{background:linear-gradient(90deg,#fff6fb 0%,#ffd1ea 45%,#ffb04a 100%)!important;-webkit-background-clip:text!important;background-clip:text!important;color:transparent!important;text-shadow:none!important;filter:drop-shadow(0 0 10px rgba(255,61,154,.6)) drop-shadow(0 0 22px rgba(255,61,154,.25))}
#pv2-nb-clock{position:absolute;right:18px;bottom:14px;z-index:2;display:flex;align-items:center;gap:10px;padding:7px 12px;border-radius:12px;pointer-events:none;
  background:rgba(14,4,22,.72);border:1.5px solid rgba(255,61,154,.85);box-shadow:0 0 12px rgba(255,61,154,.6),inset 0 0 12px rgba(45,226,230,.22)}
#pv2-nb-clock .lbl{font:800 10px/1 system-ui,sans-serif;letter-spacing:.2em;color:#2de2e6;text-shadow:0 0 8px rgba(45,226,230,.8)}
#pv2-nb-clock .dig{display:flex;gap:7px;align-items:baseline}
#pv2-nb-clock b{font:900 20px/1 'Audiowide',ui-monospace,monospace;color:#fff6fb;text-shadow:0 0 8px #ff3d9a,0 0 18px rgba(255,61,154,.7);font-variant-numeric:tabular-nums}
#pv2-nb-clock i{font:800 9px/1 system-ui,sans-serif;font-style:normal;color:#ffb0d6;margin-left:1px}
@media(max-width:900px){body.pv2-nb-on .home-tournament-banner{background-size:auto,cover!important;background-position:0 0,right center!important}}
@media(max-width:1100px){#pv2-nb-clock{position:relative;right:auto;bottom:auto;margin:14px 0 0;width:max-content;max-width:100%}}
@media(max-width:600px){#pv2-nb-clock{padding:6px 9px;gap:7px}#pv2-nb-clock b{font-size:15px}}
body.pv2-nb-on .home-tournament-banner{position:relative;transition:background-position .25s ease-out}
body.pv2-nb-on .home-tournament-banner .home-btn-primary{background:linear-gradient(135deg,rgba(255,61,154,.95),rgba(255,154,60,.95))!important;color:#fff!important;border:1px solid rgba(255,255,255,.35)!important;box-shadow:0 0 16px rgba(255,61,154,.65),0 6px 18px rgba(0,0,0,.35)!important;text-shadow:0 1px 2px rgba(0,0,0,.35)}
body.pv2-nb-on .home-tournament-banner .home-btn-secondary{background:rgba(14,4,22,.6)!important;border:1px solid rgba(45,226,230,.7)!important;color:#bff8fa!important;box-shadow:0 0 12px rgba(45,226,230,.35)!important}
body.pv2-nb-on .home-tournament-banner-kicker{color:#2de2e6!important;text-shadow:0 0 10px rgba(45,226,230,.75)}
body.pv2-nb-on .app-sidebar-theme-banner{font-family:'Audiowide',ui-monospace,monospace!important;font-size:10.5px!important;letter-spacing:.08em!important;color:#fff2f8!important;
  background:linear-gradient(180deg,rgba(40,8,48,.92),rgba(18,4,26,.92))!important;border:1.5px solid #ff3d9a!important;border-radius:12px!important;
  box-shadow:0 0 10px rgba(255,61,154,.75),0 0 26px rgba(255,61,154,.35),inset 0 0 12px rgba(45,226,230,.25)!important;
  text-shadow:0 0 6px #ff3d9a,0 0 14px rgba(255,61,154,.8)!important;animation:pv2nbSign 7s linear infinite!important}
@keyframes pv2nbSign{0%,100%{opacity:1}2%{opacity:.55}3%{opacity:1}5%{opacity:.7}6%,64%{opacity:1}65%{opacity:.6}66%{opacity:1}}
body.pv2-nb-on .home-tournament-banner{background:linear-gradient(90deg,rgba(18,6,28,.94) 0%,rgba(18,6,28,.78) 38%,rgba(18,6,28,.15) 68%,rgba(18,6,28,0) 100%),var(--pv2-nb-hero) calc(100% + var(--nbx,0px)) calc(50% + var(--nby,0px))/112% auto no-repeat!important;border-color:rgba(255,61,154,.55)!important;box-shadow:0 0 0 1px rgba(45,226,230,.25),0 18px 50px -18px rgba(255,61,154,.55)!important}
#pv2-nb-scene .nb-palm{transform-box:fill-box;transform-origin:50% 100%;animation:pv2nbSway 7s ease-in-out infinite}
#pv2-nb-scene .nb-palm-r{animation-delay:-3.5s}
#pv2-nb-scene .nb-glow{animation:pv2nbGlow 5s ease-in-out infinite}
#pv2-nb-scene .nb-win{animation:pv2nbWin 3.2s steps(2) infinite}#pv2-nb-scene .nb-win2{animation:pv2nbWin 4.4s steps(2) infinite reverse}
@keyframes pv2nbSway{0%,100%{transform:rotate(-1.4deg)}50%{transform:rotate(1.6deg)}}
@keyframes pv2nbGlow{0%,100%{opacity:.75}50%{opacity:1}}
@keyframes pv2nbWin{0%{opacity:1}100%{opacity:.25}}
#pv2-nb-splash{position:fixed;inset:0;z-index:2147483000;pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
  background:radial-gradient(circle at 50% 44%,rgba(60,10,60,.6),rgba(10,4,20,0) 62%);animation:pv2mtFade 2.9s ease forwards}
#pv2-nb-splash .sun{width:min(40vw,200px);aspect-ratio:1;border-radius:50%;animation:pv2mtPop .7s cubic-bezier(.2,1.4,.4,1) both;
  background:linear-gradient(#ffe680,#ff8a3c 55%,#ff3d9a);box-shadow:0 0 60px rgba(255,61,154,.7),0 0 120px rgba(255,154,60,.35);
  -webkit-mask:repeating-linear-gradient(to bottom,#000 0 58%,transparent 58% 61%,#000 61% 66%,transparent 66% 70%,#000 70% 76%,transparent 76% 81%,#000 81% 88%,transparent 88% 94%,#000 94% 100%);
  mask:repeating-linear-gradient(to bottom,#000 0 58%,transparent 58% 61%,#000 61% 66%,transparent 66% 70%,#000 70% 76%,transparent 76% 81%,#000 81% 88%,transparent 88% 94%,#000 94% 100%)}
#pv2-nb-splash .t{font:900 clamp(18px,4.2vw,34px)/1 'Audiowide',var(--pv2-font-display,system-ui,sans-serif);letter-spacing:.12em;color:#fff2f8;
  text-shadow:0 0 10px #ff3d9a,0 0 28px #ff3d9a,0 0 50px rgba(45,226,230,.6);animation:pv2mtUp .8s .25s ease both}
#pv2-nb-splash .h{font:700 12px/1 var(--pv2-font-body,system-ui,sans-serif);letter-spacing:.14em;color:#ffd1ea;opacity:.9;animation:pv2mtUp .8s .65s ease both}
#pv2-nb-splash .s{font:800 clamp(11px,2.4vw,14px)/1 var(--pv2-font-body,system-ui,sans-serif);letter-spacing:.22em;color:#2de2e6;text-shadow:0 0 12px rgba(45,226,230,.8);animation:pv2mtUp .8s .45s ease both}
@media (prefers-reduced-motion:reduce){#pv2-nb-scene *{animation:none!important}}
@keyframes pv2mtFade{0%,78%{opacity:1}100%{opacity:0}}
@keyframes pv2mtPop{0%{transform:scale(.3) rotate(-25deg);opacity:0}100%{transform:none;opacity:1}}
@keyframes pv2mtSpin{to{transform:rotate(360deg)}}
@keyframes pv2mtUp{0%{transform:translateY(12px);opacity:0}100%{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){#pv2-mt-splash .ring::before,#pv2-mt-splash .ring::after{animation:none}}
@media (hover:hover) and (pointer:fine){
body.theme-magic-tank,body.theme-magic-tank *{cursor:${WAND} 6 6,auto}
body.theme-magic-tank :is(a,button,[role="button"],select,label,summary,.channel-item,.member-item,.server-row,.sidebar-nav-item,.friend-row,.explore-card,.manage-tab,.settings-sidebar-item,input[type="checkbox"],input[type="radio"]),
body.theme-magic-tank :is(a,button,[role="button"]) *{cursor:${WAND_HOT} 6 6,pointer}
body.theme-magic-tank :is(input[type="text"],input[type="search"],input[type="email"],input[type="password"],input[type="number"],textarea,[contenteditable="true"]){cursor:text}}`;
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
    orbs.push({ x0: m.x, y0: m.y, x1: x, y1: y, cx: (m.x + x) / 2, cy: Math.min(m.y, y) - Math.min(220, dist * 0.35), t: 0, dur: Math.min(0.55, Math.max(0.22, dist / 1500)), combo, hist: [] });
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


  // ================================================================ DATAS COMEMORATIVAS (v0.98.5)
  // Cada tema de data ganha um "toque" próprio (o que acontece ao tocar/clicar),
  // um rastro de cursor e faíscas nos botões com a cara da data. Tudo desenhado
  // no mesmo canvas leve deste módulo (pausa com janela aberta, respeita modo
  // desempenho e "reduzir movimento").
  const emoCache = new Map();
  function emoSprite(ch) {
    let c = emoCache.get(ch);
    if (c) return c;
    c = doc.createElement('canvas'); c.width = c.height = 72;
    const x = c.getContext('2d');
    x.font = '56px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(ch, 36, 40);
    emoCache.set(ch, c);
    return c;
  }
  const P = (o) => { if (parts.length < 520) parts.push(Object.assign({ life: 0 }, o)); };
  function emo(x, y, ch, o) {
    o = o || {};
    const a = o.a != null ? o.a : rnd(-Math.PI * 0.9, -Math.PI * 0.1), v = o.v != null ? o.v : rnd(120, 320);
    P({ k: 'emo', x, y, ch, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: o.g != null ? o.g : 520, rot: rnd(-0.5, 0.5), vr: o.vr != null ? o.vr : rnd(-4, 4), s: o.s || rnd(24, 38), max: o.max || rnd(0.9, 1.4), pop: o.pop, flap: o.flap });
  }
  function confetti(x, y, cols, n, o) {
    o = o || {};
    for (let i = 0; i < n; i++) {
      const a = o.a != null ? o.a + rnd(-o.spread, o.spread) : rnd(-Math.PI * 0.95, -Math.PI * 0.05), v = rnd(o.v0 || 220, o.v1 || 560);
      P({ k: 'conf', x, y, c: pick(cols), vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 420, w: rnd(5, 9), h: rnd(8, 14), rot: rnd(0, 6.28), vr: rnd(-10, 10), ph: rnd(0, 6.28), max: rnd(1.3, 2.1) });
    }
  }
  function hearts(x, y, cols, n, big) {
    for (let i = 0; i < n; i++) P({ k: 'heart', x: x + rnd(-14, 14), y: y + rnd(-8, 8), c: pick(cols), vx: rnd(-60, 60), vy: -rnd(70, 190), s: big ? rnd(14, 22) : rnd(7, 13), ph: rnd(0, 6.28), max: rnd(1.1, 1.8) });
  }
  function pixels(x, y, cols, n) {
    for (let i = 0; i < n; i++) { const a = rnd(0, 6.28), v = rnd(90, 360); P({ k: 'pix', x, y, c: pick(cols), vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 380, s: pick([4, 5, 6, 8]), max: rnd(0.6, 1.1) }); }
  }
  function firework(x, y) {
    const cols = pick([['255,214,90', '255,255,255'], ['255,80,170', '255,214,90'], ['80,220,255', '255,255,255'], ['160,110,255', '255,140,220'], ['120,255,160', '255,240,160']]);
    const n = reduce() ? 14 : 46;
    for (let i = 0; i < n; i++) { const a = (i / n) * 6.283 + rnd(-0.06, 0.06); spark(x, y, pick(cols), { a, v: rnd(160, 300), g: 90, max: rnd(0.9, 1.4), s: rnd(1.4, 2.6) }); }
    ring(x, y, cols[0], { vr: 260, max: 0.45, w: 2 });
    if (!reduce()) setTimeout(() => { for (let i = 0; i < 12; i++) spark(x + rnd(-90, 90), y + rnd(-70, 90), '255,250,220', { v: rnd(5, 30), g: 30, max: rnd(0.2, 0.45), s: rnd(1, 1.8) }); wake(); }, 650);
    sound('boom');
  }
  function textPop(x, y, str, c, o) { P(Object.assign({ k: 'text', x, y, vy: -60, max: 1.1, str, c }, o || {})); }

  const YEAR = () => new Date().getFullYear() + (new Date().getMonth() === 11 ? 1 : 0);
  let festCount = 0, festCountT = 0;
  const FEST = {
    natal: {
      cols: ['255,255,255', '214,40,57', '31,138,76', '255,213,74'], hello: '🎄 Modo Natal — toque na tela!',
      tap(x, y) { P({ k: 'emo', x, y, ch: '🎁', vx: 0, vy: -40, g: 0, rot: 0, vr: 0, s: 40, max: 0.32, pop: 1 }); setTimeout(() => { ring(x, y, '255,255,255', { vr: 240, max: 0.5 }); for (let i = 0; i < 7; i++) emo(x, y, pick(['❄️', '⭐', '🎄', '🔔', '🍪'])); for (let i = 0; i < 16; i++) spark(x, y, pick(this.cols)); wake(); }, 300); },
      trail: 'snow',
    },
    'winter-night': { cols: ['224,242,255', '150,200,255', '255,255,255'], hello: '❄️ Noite de neve — toque na tela!', tap(x, y) { ring(x, y, '224,242,255', { vr: 220 }); for (let i = 0; i < 5; i++) emo(x, y, '❄️', { s: rnd(18, 30) }); for (let i = 0; i < 18; i++) spark(x, y, pick(this.cols), { g: 60 }); }, trail: 'snow' },
    'ano-novo': {
      cols: ['255,214,90', '255,255,255', '255,80,170', '80,220,255'], hello: '🎆 Ano Novo — toque pra soltar fogos!',
      tap(x, y) {
        const x0 = Math.max(20, Math.min(W - 20, x + rnd(-80, 80)));
        P({ k: 'rocket', x: x0, y: H + 8, x0, y0: H + 8, x1: x, y1: y, t: 0, dur: Math.min(0.9, Math.max(0.35, (H - y) / 900)), max: 3 });
        const now = performance.now(); festCount = now - festCountT < 2600 ? festCount + 1 : 1; festCountT = now;
        if (festCount === 5) setTimeout(() => { textPop(W / 2, H * 0.3, `FELIZ ${YEAR()}!`, '255,214,90', { max: 2, vy: -20, big: 1 }); wake(); }, 700);
        sound('pew');
      },
      trail: 'glitter',
    },
    carnaval: { cols: ['255,46,147', '0,184,92', '255,214,0', '0,170,255', '160,80,255'], hello: '🎭 Carnaval — toque pra soltar confete!', tap(x, y) { confetti(x, y, this.cols, reduce() ? 12 : 38); if (Math.random() < 0.6) emo(x, y, pick(['🎭', '🎉', '🥁', '🎊'])); }, trail: 'confetti' },
    'sete-de-setembro': { cols: ['22,163,74', '250,204,21', '37,99,235', '255,255,255'], hello: '🇧🇷 Sete de Setembro — toque na tela!', tap(x, y) { confetti(x, y, this.cols, reduce() ? 12 : 32); emo(x, y, pick(['🇧🇷', '⚽', '🎉']), { s: 34 }); }, trail: 'confetti' },
    pascoa: {
      cols: ['179,136,255', '255,158,199', '255,243,160', '160,230,200'], hello: '🐣 Páscoa — toque pra achar ovinhos!',
      tap(x, y) { P({ k: 'egg', x, y, c: pick(['255,200,225', '200,180,255', '255,240,170', '180,240,210']), max: 0.62, done: 0 }); if (Math.random() < 0.25) emo(x, y, '🐰', { a: -Math.PI / 2 + rnd(-0.6, 0.6), v: 260 }); },
      trail: 'pastel',
    },
    namorados: { cols: ['255,77,121', '255,194,212', '200,20,80'], hello: '💘 Dia dos Namorados — toque na tela!', tap(x, y) { hearts(x, y, this.cols, reduce() ? 3 : 9); hearts(x, y, ['255,77,121'], 1, true); ring(x, y, '255,77,121', { vr: 180, max: 0.5 }); }, trail: 'hearts' },
    'dia-do-amigo': { cols: ['251,113,133', '96,165,250', '252,211,77'], hello: '🤝 Dia do Amigo — toque na tela!', tap(x, y) { hearts(x, y, this.cols, reduce() ? 3 : 7); emo(x, y, pick(['🤝', '🫶', '💛', '🎮']), { s: 34 }); }, trail: 'hearts' },
    criancas: {
      cols: ['34,184,240', '255,112,67', '255,238,88', '120,220,120', '200,120,255'], hello: '🎈 Dia das Crianças — toque pra soltar (e estourar!) balões',
      tap(x, y) { for (let i = 0; i < 2; i++) P({ k: 'balloon', x: x + rnd(-24, 24), y: y + rnd(-6, 10), c: pick(this.cols), vy: -rnd(55, 95), ph: rnd(0, 6.28), s: rnd(15, 21), max: 14 }); },
      trail: 'confetti',
    },
    'dia-das-maes': { cols: ['255,111,165', '199,125,255', '255,214,165'], hello: '🌸 Dia das Mães — toque pra florescer!', tap(x, y) { P({ k: 'bloom', x, y, c: pick(['255,111,165', '199,125,255', '255,150,190']), rot: rnd(0, 6.28), max: 1.3 }); for (let i = 0; i < 3; i++) emo(x, y, pick(['🌸', '🌷', '🦋', '💐']), { g: 120, v: rnd(60, 160), s: rnd(20, 28) }); }, trail: 'petals' },
    'dia-dos-pais': { cols: ['59,130,246', '14,165,233', '251,191,36'], hello: '🏆 Dia dos Pais — toque na tela!', tap(x, y) { P({ k: 'emo', x, y, ch: '⚽', vx: rnd(-160, 160), vy: -rnd(260, 380), g: 900, rot: 0, vr: rnd(-8, 8), s: 30, max: 2.4, bounce: 1 }); if (Math.random() < 0.5) P({ k: 'emo', x, y: y - 10, ch: '🏆', vx: 0, vy: -50, g: 0, rot: 0, vr: 0, s: 36, max: 0.9, pop: 1 }); for (let i = 0; i < 12; i++) spark(x, y, pick(this.cols)); }, trail: 'glitter' },
    'festa-junina': { cols: ['255,179,0', '229,57,53', '124,179,66', '255,120,30'], hello: '🔥 Arraiá — toque pra acender a fogueira!', tap(x, y) { for (let i = 0; i < (reduce() ? 8 : 26); i++) spark(x + rnd(-10, 10), y, pick(['255,180,40', '255,120,30', '255,220,120']), { a: -Math.PI / 2 + rnd(-0.5, 0.5), v: rnd(60, 220), g: -40, max: rnd(0.7, 1.3), s: rnd(1.4, 3) }); emo(x, y, pick(['🌽', '🎈', '🪅', '🎆']), { s: 30 }); }, trail: 'embers' },
    'black-friday': { cols: ['255,214,0', '255,23,68', '0,229,255'], hello: '🛒 Black Friday — toque pra caçar ofertas!', tap(x, y) { P({ k: 'tag', x, y, str: '-' + pick([50, 60, 70, 80, 90]) + '%', max: 1.1 }); for (let i = 0; i < 4; i++) P({ k: 'emo', x: x + rnd(-80, 80), y: y - rnd(40, 120), ch: pick(['💸', '💰', '🛒']), vx: rnd(-20, 20), vy: rnd(40, 120), g: 300, rot: 0, vr: rnd(-2, 2), s: 26, max: 1.4 }); }, trail: 'glitter' },
    'dia-do-gamer': {
      cols: ['168,85,247', '34,211,238', '244,114,182', '255,255,255'], hello: '👾 Dia do Gamer — toque pra ganhar XP!',
      tap(x, y) { pixels(x, y, this.cols, reduce() ? 10 : 28); const now = performance.now(); festCount = now - festCountT < 4000 ? festCount + 1 : 1; festCountT = now; textPop(x, y - 16, festCount % 10 === 0 ? 'LEVEL UP!' : '+10 XP', festCount % 10 === 0 ? '252,238,10' : '34,211,238', { pixel: 1 }); },
      trail: 'pixels',
    },
    'noite-de-lancamento': {
      cols: ['255,61,154', '255,154,60', '45,226,230', '255,230,120'], hello: null,
      tap(x, y) {
        for (let i = 0; i < (reduce() ? 2 : 6); i++) emo(x, y, pick(['💵', '💵', '💵', '💰']), { g: 150, v: rnd(140, 300), vr: rnd(-3, 3), max: rnd(1.4, 2), s: rnd(24, 32) });
        ring(x, y, '255,61,154', { vr: 260, max: 0.5, w: 2.5 }); ring(x, y, '45,226,230', { vr: 170, max: 0.6, w: 1.6 });
        P({ k: 'siren', x, y, max: 0.75 });
        if (Math.random() < 0.38) P({ k: 'neonword', x, y: y - 34, str: pick(['BORA!', 'PARTIU!', '19/11', 'É HOJE?', 'VAI!', 'NEON!', 'TURBO']), c: pick(['255,61,154', '45,226,230', '255,154,60']), max: 1.2, rot: rnd(-0.18, 0.18) });
        const now = performance.now(); festCount = now - festCountT < 3000 ? festCount + 1 : 1; festCountT = now;
        if (festCount === 5) { textPop(x, y - 30, 'TURBO!', '45,226,230', { big: 1, max: 1.3 }); nbCar(x < W / 2); }
        sound('pew');
      },
      trail: 'neon',
    },
    halloween: { cols: ['255,122,26', '160,60,255', '255,46,46'], hello: '🎃 Halloween — toque se tiver coragem!', tap(x, y) { for (let i = 0; i < (reduce() ? 2 : 4); i++) emo(x, y, '🦇', { a: rnd(-Math.PI, 0), v: rnd(160, 300), g: -40, s: rnd(22, 30), max: 1.3, flap: 1 }); for (let i = 0; i < 14; i++) spark(x, y, pick(this.cols)); if (Math.random() < 0.2) P({ k: 'emo', x, y, ch: '👻', vx: rnd(-20, 20), vy: -70, g: -10, rot: 0, vr: 0, s: 38, max: 1.6 }); }, trail: 'embers' },
  };
  const festKey = () => { const t = global.PlusV2LiveCurrentTheme; return t && FEST[t.key] ? t.key : null; };
  function festTap(x, y) {
    ensureCanvas();
    if (festKey() === 'criancas' && popBalloonAt(x, y)) { wake(); return; } // estourar vem antes do limite de toques
    const now = performance.now();
    if (now - lastTap < 120) return; lastTap = now;
    FEST[festKey()].tap(x, y);
    wake();
  }
  function popBalloonAt(x, y) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p.k !== 'balloon') continue;
      if (Math.hypot(p.x - x, p.y - y) < p.s * 1.6) {
        parts.splice(i, 1);
        confetti(p.x, p.y, FEST.criancas.cols, 18, { v0: 120, v1: 320 });
        ring(p.x, p.y, p.c, { vr: 300, max: 0.3 });
        textPop(p.x, p.y - 10, 'POP!', p.c);
        sound('boom');
        return true;
      }
    }
    return false;
  }
  function festTrail(x, y, kind) {
    const cs = FEST[festKey()].cols;
    if (kind === 'snow') spark(x + rnd(-4, 4), y + rnd(-4, 4), '240,248,255', { v: rnd(5, 20), g: 40, max: rnd(0.6, 1), s: rnd(1.2, 2.4) });
    else if (kind === 'hearts') { if (Math.random() < 0.45) P({ k: 'heart', x, y, c: pick(cs), vx: rnd(-10, 10), vy: -rnd(20, 50), s: rnd(4, 7), ph: rnd(0, 6), max: 0.8 }); }
    else if (kind === 'confetti') { if (Math.random() < 0.5) P({ k: 'conf', x, y, c: pick(cs), vx: rnd(-30, 30), vy: rnd(-20, 10), g: 160, w: 4, h: 6, rot: rnd(0, 6), vr: rnd(-8, 8), ph: 0, max: 0.8 }); }
    else if (kind === 'pixels') { if (Math.random() < 0.6) P({ k: 'pix', x: Math.round(x / 4) * 4, y: Math.round(y / 4) * 4, c: pick(cs), vx: 0, vy: 0, g: 0, s: 4, max: 0.45 }); }
    else if (kind === 'petals') { if (Math.random() < 0.4) P({ k: 'heart', x, y, c: pick(cs), vx: rnd(-20, 20), vy: rnd(-10, 30), s: rnd(3, 5), ph: rnd(0, 6), max: 0.9, petal: 1 }); }
    else if (kind === 'neon') spark(x + rnd(-2, 2), y + rnd(-2, 2), pick(['255,61,154', '45,226,230']), { v: rnd(6, 24), g: 10, max: rnd(0.35, 0.55), s: rnd(1.2, 2.2) });
    else if (kind === 'embers') spark(x, y, pick(['255,170,40', '255,110,30']), { a: -Math.PI / 2 + rnd(-0.6, 0.6), v: rnd(15, 45), g: -30, max: rnd(0.4, 0.7), s: rnd(1, 2) });
    else if (kind === 'pastel') spark(x, y, pick(cs), { v: rnd(5, 25), g: 20, max: rnd(0.5, 0.8), s: rnd(1.4, 2.6) });
    else spark(x + rnd(-3, 3), y + rnd(-3, 3), pick(cs), { v: rnd(8, 30), g: 40, max: rnd(0.35, 0.6), s: rnd(1, 2.2) });
  }
  // aviso discreto (1x por sessão por tema) dizendo que dá pra interagir
  function festHello(key) {
    const cfg = FEST[key]; if (!cfg || !cfg.hello) return;
    let seen = false;
    try { const k = 'pv2_fest_hello_' + key; seen = sessionStorage.getItem(k) === '1'; sessionStorage.setItem(k, '1'); } catch (_) { /* sem storage */ }
    if (seen) return;
    const old = doc.getElementById('pv2-fest-hello'); if (old) old.remove();
    injectStyle();
    const el = doc.createElement('div'); el.id = 'pv2-fest-hello'; el.textContent = cfg.hello;
    el.style.setProperty('--c', cfg.cols[0]);
    doc.body.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }
  function heartPath(x, y, s) {
    ctx.beginPath(); ctx.moveTo(x, y + s * 0.35);
    ctx.bezierCurveTo(x - s * 1.1, y - s * 0.45, x - s * 0.45, y - s * 1.15, x, y - s * 0.45);
    ctx.bezierCurveTo(x + s * 0.45, y - s * 1.15, x + s * 1.1, y - s * 0.45, x, y + s * 0.35);
    ctx.closePath();
  }
  // desenha os tipos novos (chamado dentro do loop, com composição normal)
  function drawFest(p, dt, k) {
    ctx.globalCompositeOperation = 'source-over';
    if (p.k === 'emo') {
      if (p.flap) { p.vx *= 0.99; p.vy += Math.sin(p.life * 22) * 40 * dt; }
      p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      if (p.bounce && p.y > H - 30 && p.vy > 0) { p.y = H - 30; p.vy *= -0.62; p.vx *= 0.8; }
      const sc = p.pop ? Math.min(1.25, 0.4 + p.life / 0.12) : Math.min(1, 0.5 + p.life / 0.08);
      const sz = p.s * sc;
      ctx.save(); ctx.globalAlpha = Math.min(1, k * 2.2); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      if (p.flap) ctx.scale(1, 0.75 + Math.abs(Math.sin(p.life * 22)) * 0.35);
      ctx.drawImage(emoSprite(p.ch), -sz / 2, -sz / 2, sz, sz); ctx.restore();
    } else if (p.k === 'conf') {
      p.vy += p.g * dt; p.vx *= 0.97; p.vy *= 0.985; p.x += p.vx * dt + Math.sin(p.life * 6 + p.ph) * 20 * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      ctx.save(); ctx.globalAlpha = Math.min(1, k * 2.5); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(1, Math.cos(p.life * 9 + p.ph));
      ctx.fillStyle = `rgb(${p.c})`; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
    } else if (p.k === 'heart') {
      p.x += (p.vx + Math.sin(p.life * 4 + p.ph) * 30) * dt; p.y += p.vy * dt; p.vy *= 0.995;
      ctx.globalAlpha = Math.min(1, k * 2); ctx.fillStyle = `rgb(${p.c})`;
      if (p.petal) { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.life * 3 + p.ph); ctx.beginPath(); ctx.ellipse(0, 0, p.s, p.s * 0.55, 0, 0, 6.29); ctx.fill(); ctx.restore(); }
      else { heartPath(p.x, p.y, p.s * Math.min(1, 0.4 + p.life * 5)); ctx.fill(); }
      ctx.globalAlpha = 1;
    } else if (p.k === 'pix') {
      p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.98;
      ctx.globalAlpha = Math.min(1, k * 2); ctx.fillStyle = `rgb(${p.c})`; ctx.fillRect(Math.round(p.x), Math.round(p.y), p.s, p.s); ctx.globalAlpha = 1;
    } else if (p.k === 'rocket') {
      p.t += dt / p.dur; const u = Math.min(1, p.t), e = 1 - Math.pow(1 - u, 2);
      p.x = p.x0 + (p.x1 - p.x0) * e; p.y = p.y0 + (p.y1 - p.y0) * e;
      spark(p.x, p.y + 4, pick(['255,220,140', '255,170,60']), { a: Math.PI / 2 + rnd(-0.4, 0.4), v: rnd(30, 90), g: 60, max: rnd(0.25, 0.45), s: rnd(1, 2) });
      ctx.fillStyle = 'rgba(255,250,230,1)'; ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, 6.29); ctx.fill();
      if (u >= 1) { p.life = p.max; firework(p.x1, p.y1); }
    } else if (p.k === 'balloon') {
      p.y += p.vy * dt; p.x += Math.sin(p.life * 1.6 + p.ph) * 18 * dt;
      if (p.y < -60) { p.life = p.max; return; }
      const s = p.s * Math.min(1, 0.3 + p.life * 4);
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p.x, p.y + s * 1.25); ctx.quadraticCurveTo(p.x + Math.sin(p.life * 3) * 6, p.y + s * 2, p.x, p.y + s * 2.8); ctx.stroke();
      const g = ctx.createRadialGradient(p.x - s * 0.35, p.y - s * 0.45, s * 0.1, p.x, p.y, s * 1.3);
      g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(0.25, `rgb(${p.c})`); g.addColorStop(1, `rgba(${p.c},.85)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(p.x, p.y, s, s * 1.2, 0, 0, 6.29); ctx.fill();
      ctx.fillStyle = `rgb(${p.c})`; ctx.beginPath(); ctx.moveTo(p.x - 3, p.y + s * 1.25); ctx.lineTo(p.x + 3, p.y + s * 1.25); ctx.lineTo(p.x, p.y + s * 1.08); ctx.fill();
    } else if (p.k === 'bloom') {
      const u = Math.min(1, p.life / 0.35), r = 26 * (1 - Math.pow(1 - u, 3));
      ctx.save(); ctx.globalAlpha = Math.min(1, k * 2.2); ctx.translate(p.x, p.y); ctx.rotate(p.rot + p.life * 0.6);
      ctx.fillStyle = `rgb(${p.c})`;
      for (let i = 0; i < 6; i++) { ctx.rotate(Math.PI / 3); ctx.beginPath(); ctx.ellipse(r * 0.55, 0, r * 0.55, r * 0.3, 0, 0, 6.29); ctx.fill(); }
      ctx.fillStyle = 'rgb(255,214,90)'; ctx.beginPath(); ctx.arc(0, 0, r * 0.22, 0, 6.29); ctx.fill(); ctx.restore();
    } else if (p.k === 'egg') {
      const wob = Math.sin(p.life * 38) * 0.22 * Math.min(1, p.life * 4);
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(wob);
      ctx.fillStyle = `rgb(${p.c})`; ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(0, 0, 16, 21, 0, 0, 6.29); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-14, -2); for (let i = -10; i <= 14; i += 6) ctx.lineTo(i, i % 12 === 0 ? -6 : 2); ctx.stroke();
      if (p.life > 0.42) { ctx.strokeStyle = 'rgba(80,60,40,.8)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(-8, -10); ctx.lineTo(-2, -4); ctx.lineTo(3, -11); ctx.lineTo(8, -5); ctx.stroke(); }
      ctx.restore();
      if (p.life > 0.58 && !p.done) { p.done = 1; P({ k: 'emo', x: p.x, y: p.y, ch: '🐣', vx: 0, vy: -60, g: 0, rot: 0, vr: 0, s: 34, max: 1.1, pop: 1 }); for (let i = 0; i < 12; i++) spark(p.x, p.y, pick(FEST.pascoa.cols)); }
    } else if (p.k === 'tag') {
      const sc = Math.min(1.15, 0.3 + p.life / 0.1);
      ctx.save(); ctx.globalAlpha = Math.min(1, k * 2.5); ctx.translate(p.x, p.y - p.life * 30); ctx.rotate(-0.12); ctx.scale(sc, sc);
      ctx.fillStyle = 'rgb(255,214,0)'; rr(-30, -14, 60, 28, 6); ctx.fill();
      ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(-22, 0, 3, 0, 6.29); ctx.fill();
      ctx.font = '900 15px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(p.str, 4, 1); ctx.restore();
    } else if (p.k === 'flash') {
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(W, H));
      g.addColorStop(0, `rgba(${p.c},${(0.32 * k).toFixed(3)})`); g.addColorStop(1, `rgba(${p.c},0)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    } else if (p.k === 'crystal') {
      drawCrystal(p, dt, k);
    } else if (p.k === 'neonword') {
      const sc = Math.min(1.1, 0.4 + p.life / 0.09), fl = (p.life < 0.25 && Math.random() < 0.35) ? 0.35 : 1;
      ctx.save(); ctx.globalAlpha = Math.min(1, k * 2.2) * fl; ctx.translate(p.x, p.y - p.life * 26); ctx.rotate(p.rot); ctx.scale(sc, sc);
      ctx.font = "900 26px 'Audiowide', system-ui, sans-serif"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = `rgb(${p.c})`; ctx.shadowBlur = 18; ctx.lineWidth = 2.2; ctx.strokeStyle = `rgb(${p.c})`; ctx.strokeText(p.str, 0, 0);
      ctx.shadowBlur = 8; ctx.fillStyle = '#fff6fb'; ctx.fillText(p.str, 0, 0); ctx.restore();
    } else if (p.k === 'car') {
      drawCar(p, dt);
    } else if (p.k === 'siren') {
      ctx.globalCompositeOperation = 'lighter';
      const red = Math.floor(p.life / 0.12) % 2 === 0;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 120);
      g.addColorStop(0, red ? `rgba(255,40,60,${(0.55 * k).toFixed(3)})` : `rgba(40,110,255,${(0.55 * k).toFixed(3)})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, 120, 0, 6.29); ctx.fill();
    }
    ctx.globalCompositeOperation = 'lighter';
  }

  // ================================================================ MAGIC TANK v2 (v0.98.5)
  // • segurar o clique/dedo carrega uma MEGA MAGIA (solta pra disparar)
  // • cristais mágicos aparecem de vez em quando — acerte pra coletar (contador salvo)
  // • o projétil deixa um rastro de luz
  const charge = { on: 0, x: 0, y: 0, t0: 0, id: null };
  const MEGA_MS = 450;
  function chargeLevel() { return charge.on ? Math.min(1, (performance.now() - charge.t0 - 150) / 900) : 0; }
  function megaFire(x, y) {
    ensureCanvas();
    tank.want = 1; tank.idle = 0;
    const m0 = muzzle(true);
    tank.ang = Math.max(-Math.PI + 0.15, Math.min(-0.05, Math.atan2(y - m0.ty, x - m0.tx)));
    tank.recoil = 1.6; tank.flash = 1.6;
    const m = muzzle(true), dist = Math.hypot(x - m.x, y - m.y);
    orbs.push({ x0: m.x, y0: m.y, x1: x, y1: y, cx: (m.x + x) / 2, cy: Math.min(m.y, y) - Math.min(260, dist * 0.4), t: 0, dur: Math.min(0.75, Math.max(0.32, dist / 1100)), combo: 0, mega: 1, hist: [] });
    sound('pew'); wake();
  }
  function mtMega(x, y) {
    P({ k: 'flash', x, y, c: GOLD, max: 0.45 });
    for (const [c, vr, w, mx] of [[GOLD, 520, 4, 0.7], [BLUE, 380, 3, 0.85], [ICE, 260, 2, 1], [GOLD, 160, 2, 1.1]]) ring(x, y, c, { r0: 10, vr, w, max: mx });
    rune(x, y); setTimeout(() => { rune(x, y); wake(); }, 160);
    const n = reduce() ? 20 : 90;
    for (let i = 0; i < n; i++) spark(x, y, pick([GOLD, GOLD, BLUE, ICE, '255,255,235']), { v: rnd(140, 620), max: rnd(0.6, 1.2), s: rnd(1.6, 3.4) });
    textPop(x, y - 30, 'MEGA MAGIA!', GOLD, { big: 1, max: 1.4 });
    if (global.PlusV2Fx && global.PlusV2Fx.burst) global.PlusV2Fx.burst(x, y, 14);
    hitCrystals(x, y, 140);
    sound('boom'); setTimeout(() => sound('boom'), 120);
  }
  // ---- cristais
  let crystalT = 0;
  function crystalCount(add) {
    let n = 0;
    try { n = Number(localStorage.getItem('pv2_mt_crystals') || 0) + (add || 0); if (add) localStorage.setItem('pv2_mt_crystals', String(n)); } catch (_) { /* sem storage */ }
    return n;
  }
  function scheduleCrystal(first) {
    clearTimeout(crystalT);
    crystalT = setTimeout(() => {
      if (isMT() && allowed() && !doc.hidden && !doc.body.classList.contains('pv2-modal-open') && !parts.some((p) => p.k === 'crystal')) {
        ensureCanvas();
        const left = W < 800 ? 30 : 300;
        P({ k: 'crystal', x: rnd(left, W - 60), y: rnd(H * 0.14, H * 0.5), ph: rnd(0, 6.28), max: 9, born: 0 });
        wake();
      }
      if (isMT()) scheduleCrystal();
    }, first ? rnd(5000, 9000) : rnd(16000, 28000));
  }
  function drawCrystal(p, dt, k) {
    p.ph += dt * 2;
    const y = p.y + Math.sin(p.ph) * 8, a = Math.min(1, p.life * 3) * Math.min(1, k * 4), s = 15;
    ctx.save(); ctx.globalAlpha = a; ctx.translate(p.x, y);
    const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, 46);
    glow.addColorStop(0, `rgba(${ICE},.45)`); glow.addColorStop(1, `rgba(${BLUE},0)`);
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0, 46, 0, 6.29); ctx.fill();
    ctx.rotate(Math.sin(p.ph * 0.5) * 0.15);
    const g = ctx.createLinearGradient(-s, -s * 1.6, s, s * 1.6);
    g.addColorStop(0, '#e9fbff'); g.addColorStop(0.45, '#4cc3ff'); g.addColorStop(1, '#fbdc70');
    ctx.fillStyle = g; ctx.strokeStyle = `rgba(${GOLD},.95)`; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(0, -s * 1.7); ctx.lineTo(s, -s * 0.4); ctx.lineTo(s * 0.6, s * 1.2); ctx.lineTo(0, s * 1.7); ctx.lineTo(-s * 0.6, s * 1.2); ctx.lineTo(-s, -s * 0.4); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, -s * 1.7); ctx.lineTo(0, s * 1.7); ctx.moveTo(-s, -s * 0.4); ctx.lineTo(s, -s * 0.4); ctx.stroke();
    ctx.restore();
    if (Math.random() < 0.25) spark(p.x + rnd(-22, 22), y + rnd(-26, 26), pick([GOLD, ICE]), { v: rnd(5, 20), g: -10, max: 0.5, s: rnd(0.8, 1.6) });
  }
  function hitCrystals(x, y, radius) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p.k !== 'crystal') continue;
      const cy = p.y + Math.sin(p.ph) * 8;
      if (Math.hypot(p.x - x, cy - y) > radius) continue;
      parts.splice(i, 1);
      const total = crystalCount(1);
      ring(p.x, cy, ICE, { vr: 360, max: 0.5, w: 3 });
      for (let j = 0; j < 30; j++) spark(p.x, cy, pick([ICE, GOLD, '255,255,255']), { v: rnd(120, 420), max: rnd(0.5, 1), s: rnd(1.6, 3) });
      textPop(p.x, cy - 26, `💎 +1  (total ${total})`, ICE, { max: 1.6 });
      sound('boom');
    }
  }
  function drawCharge() {
    const c = chargeLevel();
    if (c <= 0) return;
    const m = muzzle(false);
    ctx.globalCompositeOperation = 'lighter';
    const r = 6 + c * 18;
    const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, r * 2);
    g.addColorStop(0, 'rgba(255,255,235,.95)'); g.addColorStop(0.35, `rgba(${GOLD},.85)`); g.addColorStop(1, `rgba(${BLUE},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(m.x, m.y, r * 2, 0, 6.29); ctx.fill();
    // mira no alvo
    ctx.save(); ctx.translate(charge.x, charge.y); ctx.rotate(performance.now() / 300);
    ctx.strokeStyle = `rgba(${GOLD},${(0.4 + c * 0.6).toFixed(2)})`; ctx.lineWidth = 2; ctx.setLineDash([5, 6]);
    ctx.beginPath(); ctx.arc(0, 0, 26 - c * 8, 0, 6.29); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = `rgba(${ICE},${c.toFixed(2)})`; for (let j = 0; j < 4; j++) { ctx.rotate(Math.PI / 2); star(26 - c * 8, 0, 3); }
    ctx.restore();
    if (Math.random() < 0.6) spark(m.x + rnd(-30, 30), m.y + rnd(-30, 30), pick([GOLD, ICE]), { a: Math.atan2(m.y - (m.y + rnd(-30, 30)), 0), v: 40, g: 0, max: 0.3, s: 1.4 });
    tank.want = 1; tank.idle = 0;
    ctx.globalCompositeOperation = 'source-over';
  }


  // ================================================================ NOITE DE LANÇAMENTO (v0.98.6)
  // Tema original pra noite de lançamento (19/11/2026, meia-noite no horário
  // local): cenário neon (sol listrado, cidade, palmeiras balançando) por trás
  // do app, carro neon passando, chuva de dinheiro + sirene no toque e
  // contagem regressiva na faixa do menu. Desenhos próprios, sem marcas.
  const NB_KEY = 'noite-de-lancamento';
  const LAUNCH = new Date(2026, 10, 19, 0, 0, 0); // meia-noite LOCAL de 19/11
  const isNB = () => { const t = global.PlusV2LiveCurrentTheme; return !!(t && t.key === NB_KEY); };
  function launchLabel() {
    const ms = LAUNCH.getTime() - Date.now();
    if (ms > 0) {
      const d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000) % 24, m = Math.floor(ms / 60000) % 60;
      return '🌴 LANÇA EM ' + (d ? d + 'd ' : '') + h + 'h ' + String(m).padStart(2, '0') + 'm';
    }
    if (ms > -3 * 86400000) return '🎉 LANÇOU! BOA JOGATINA';
    return '🌴 NOITE DE LANÇAMENTO';
  }
  global.pv2BannerText = (theme) => (theme && theme.key === NB_KEY ? launchLabel() : null);
  setInterval(() => {
    if (!isNB()) return;
    const b = doc.getElementById('app-sidebar-theme-banner');
    if (b) { const t = launchLabel(); if (b.textContent !== t) b.textContent = t; }
  }, 15000);

  // v0.99.0: fundo ANIMADO — céu com brilho do pôr do sol pulsando, holofotes
  // de "noite de estreia" varrendo o céu, estrelas piscando, estrelas cadentes,
  // luzes neon flutuando e linha do horizonte (por cima do chão em grade).
  const NB_SVG = `<div class="nb-sky"></div><div class="nb-sky2"></div>
<div class="nb-beam b1"></div><div class="nb-beam b2"></div><div class="nb-beam b3"></div>
<svg class="nb-stars" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg"><g fill="#fff"><circle cx="946" cy="453" r="1.8"><animate attributeName="opacity" values=".1;1;.1" dur="5.0s" begin="-3.9s" repeatCount="indefinite"/></circle><circle cx="945" cy="270" r="1.8"><animate attributeName="opacity" values=".1;1;.1" dur="2.7s" begin="-4.0s" repeatCount="indefinite"/></circle><circle cx="994" cy="332" r="1.8"><animate attributeName="opacity" values=".1;1;.1" dur="4.8s" begin="-0.5s" repeatCount="indefinite"/></circle><circle cx="641" cy="82" r="0.8"><animate attributeName="opacity" values=".1;1;.1" dur="3.9s" begin="-4.5s" repeatCount="indefinite"/></circle><circle cx="1319" cy="31" r="1.8"><animate attributeName="opacity" values=".1;1;.1" dur="5.4s" begin="-4.8s" repeatCount="indefinite"/></circle><circle cx="1359" cy="388" r="1.8"><animate attributeName="opacity" values=".1;1;.1" dur="4.3s" begin="-3.1s" repeatCount="indefinite"/></circle><circle cx="1102" cy="42" r="0.8"><animate attributeName="opacity" values=".1;1;.1" dur="2.1s" begin="-4.4s" repeatCount="indefinite"/></circle><circle cx="1248" cy="25" r="1.5"><animate attributeName="opacity" values=".1;1;.1" dur="3.1s" begin="-3.0s" repeatCount="indefinite"/></circle><circle cx="420" cy="275" r="1"><animate attributeName="opacity" values=".1;1;.1" dur="4.2s" begin="-2.5s" repeatCount="indefinite"/></circle><circle cx="1376" cy="53" r="1.5"><animate attributeName="opacity" values=".1;1;.1" dur="4.3s" begin="-2.0s" repeatCount="indefinite"/></circle><circle cx="1148" cy="440" r="0.8"><animate attributeName="opacity" values=".1;1;.1" dur="4.5s" begin="-1.6s" repeatCount="indefinite"/></circle><circle cx="490" cy="272" r="1.2"><animate attributeName="opacity" values=".1;1;.1" dur="2.1s" begin="-2.8s" repeatCount="indefinite"/></circle><circle cx="241" cy="215" r="0.8"><animate attributeName="opacity" values=".1;1;.1" dur="5.0s" begin="-1.9s" repeatCount="indefinite"/></circle><circle cx="54" cy="443" r="0.8"><animate attributeName="opacity" values=".1;1;.1" dur="2.7s" begin="-4.6s" repeatCount="indefinite"/></circle><circle cx="127" cy="250" r="1.5"><animate attributeName="opacity" values=".1;1;.1" dur="5.4s" begin="-2.0s" repeatCount="indefinite"/></circle><circle cx="169" cy="299" r="1"><animate attributeName="opacity" values=".1;1;.1" dur="4.7s" begin="-1.3s" repeatCount="indefinite"/></circle><circle cx="198" cy="169" r="1.2"><animate attributeName="opacity" values=".1;1;.1" dur="2.1s" begin="-2.1s" repeatCount="indefinite"/></circle><circle cx="261" cy="78" r="1"><animate attributeName="opacity" values=".1;1;.1" dur="4.5s" begin="-0.1s" repeatCount="indefinite"/></circle><circle cx="972" cy="418" r="1.5"><animate attributeName="opacity" values=".1;1;.1" dur="2.6s" begin="-2.8s" repeatCount="indefinite"/></circle><circle cx="936" cy="270" r="1"><animate attributeName="opacity" values=".1;1;.1" dur="5.4s" begin="-3.8s" repeatCount="indefinite"/></circle><circle cx="878" cy="339" r="1.5"><animate attributeName="opacity" values=".1;1;.1" dur="2.4s" begin="-2.1s" repeatCount="indefinite"/></circle><circle cx="455" cy="10" r="1.2"><animate attributeName="opacity" values=".1;1;.1" dur="5.0s" begin="-4.9s" repeatCount="indefinite"/></circle><circle cx="1233" cy="165" r="0.8"><animate attributeName="opacity" values=".1;1;.1" dur="2.7s" begin="-2.0s" repeatCount="indefinite"/></circle><circle cx="1252" cy="338" r="1.8"><animate attributeName="opacity" values=".1;1;.1" dur="2.4s" begin="-4.9s" repeatCount="indefinite"/></circle><circle cx="456" cy="236" r="1.2"><animate attributeName="opacity" values=".1;1;.1" dur="2.0s" begin="-3.1s" repeatCount="indefinite"/></circle><circle cx="626" cy="207" r="0.8"><animate attributeName="opacity" values=".1;1;.1" dur="2.3s" begin="-1.0s" repeatCount="indefinite"/></circle><circle cx="1323" cy="134" r="0.8"><animate attributeName="opacity" values=".1;1;.1" dur="4.1s" begin="-1.9s" repeatCount="indefinite"/></circle><circle cx="948" cy="75" r="1.8"><animate attributeName="opacity" values=".1;1;.1" dur="3.7s" begin="-2.9s" repeatCount="indefinite"/></circle><circle cx="810" cy="103" r="1"><animate attributeName="opacity" values=".1;1;.1" dur="3.1s" begin="-1.1s" repeatCount="indefinite"/></circle><circle cx="1270" cy="137" r="1"><animate attributeName="opacity" values=".1;1;.1" dur="2.6s" begin="-3.1s" repeatCount="indefinite"/></circle><circle cx="1154" cy="110" r="1.5"><animate attributeName="opacity" values=".1;1;.1" dur="5.1s" begin="-3.0s" repeatCount="indefinite"/></circle><circle cx="883" cy="34" r="0.8"><animate attributeName="opacity" values=".1;1;.1" dur="2.4s" begin="-2.6s" repeatCount="indefinite"/></circle><circle cx="542" cy="132" r="1.5"><animate attributeName="opacity" values=".1;1;.1" dur="2.9s" begin="-4.1s" repeatCount="indefinite"/></circle><circle cx="1241" cy="261" r="1.2"><animate attributeName="opacity" values=".1;1;.1" dur="3.8s" begin="-4.6s" repeatCount="indefinite"/></circle><circle cx="160" cy="74" r="1"><animate attributeName="opacity" values=".1;1;.1" dur="3.7s" begin="-3.3s" repeatCount="indefinite"/></circle><circle cx="1281" cy="324" r="0.8"><animate attributeName="opacity" values=".1;1;.1" dur="3.0s" begin="-4.6s" repeatCount="indefinite"/></circle><circle cx="437" cy="393" r="0.8"><animate attributeName="opacity" values=".1;1;.1" dur="2.2s" begin="-2.1s" repeatCount="indefinite"/></circle><circle cx="530" cy="40" r="0.8"><animate attributeName="opacity" values=".1;1;.1" dur="2.6s" begin="-1.8s" repeatCount="indefinite"/></circle><circle cx="1191" cy="77" r="0.8"><animate attributeName="opacity" values=".1;1;.1" dur="3.3s" begin="-4.5s" repeatCount="indefinite"/></circle><circle cx="697" cy="346" r="1.8"><animate attributeName="opacity" values=".1;1;.1" dur="4.0s" begin="-0.7s" repeatCount="indefinite"/></circle><circle cx="91" cy="19" r="1.5"><animate attributeName="opacity" values=".1;1;.1" dur="5.2s" begin="-3.5s" repeatCount="indefinite"/></circle><circle cx="88" cy="20" r="1.8"><animate attributeName="opacity" values=".1;1;.1" dur="4.2s" begin="-2.4s" repeatCount="indefinite"/></circle><circle cx="1516" cy="169" r="1.2"><animate attributeName="opacity" values=".1;1;.1" dur="2.5s" begin="-0.4s" repeatCount="indefinite"/></circle><circle cx="947" cy="289" r="1.2"><animate attributeName="opacity" values=".1;1;.1" dur="4.6s" begin="-4.5s" repeatCount="indefinite"/></circle><circle cx="1529" cy="387" r="1"><animate attributeName="opacity" values=".1;1;.1" dur="4.8s" begin="-4.6s" repeatCount="indefinite"/></circle><circle cx="740" cy="53" r="1.5"><animate attributeName="opacity" values=".1;1;.1" dur="5.2s" begin="-4.4s" repeatCount="indefinite"/></circle></g></svg>
<div class="nb-orb o1"></div><div class="nb-orb o2"></div><div class="nb-orb o3"></div><div class="nb-orb o4"></div><div class="nb-orb o5"></div>
<div class="nb-shoot s1"></div><div class="nb-shoot s2"></div><div class="nb-shoot s3"></div>
<div class="nb-horizon"></div>`;
  const NB_HERO = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 360" preserveAspectRatio="xMaxYMid slice">
<defs>
<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#12052a"/><stop offset=".4" stop-color="#4a0f5c"/><stop offset=".78" stop-color="#ff3d9a"/><stop offset="1" stop-color="#ffb04a"/></linearGradient>
<linearGradient id="u" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff1a0"/><stop offset=".5" stop-color="#ff9a3c"/><stop offset="1" stop-color="#ff3d9a"/></linearGradient>
<radialGradient id="h"><stop offset="0" stop-color="#ff6fb5" stop-opacity=".75"/><stop offset=".55" stop-color="#ff3d9a" stop-opacity=".22"/><stop offset="1" stop-color="#ff3d9a" stop-opacity="0"/></radialGradient>
<linearGradient id="m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2e0c44"/><stop offset="1" stop-color="#07030f"/></linearGradient>
<linearGradient id="mt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a1155"/><stop offset="1" stop-color="#1a0828"/></linearGradient>
<linearGradient id="sh" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff"/></linearGradient>
<mask id="c"><rect width="1200" height="360" fill="#fff"/><g fill="#000"><rect x="760" y="126" width="300" height="2"/><rect x="760" y="150" width="300" height="4"/><rect x="760" y="174" width="300" height="6"/><rect x="760" y="198" width="300" height="8"/><rect x="760" y="222" width="300" height="10"/><rect x="760" y="246" width="300" height="12"/><animateTransform attributeName="transform" type="translate" values="0 0;0 24" dur="2.6s" repeatCount="indefinite"/></g></mask>
</defs>
<rect width="1200" height="246" fill="url(#s)"/>
<circle cx="801" cy="46" r="1.8" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="3.9s" begin="-0.3s" repeatCount="indefinite"/></circle><circle cx="1018" cy="32" r="1.4" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="3.7s" begin="-3.6s" repeatCount="indefinite"/></circle><circle cx="689" cy="17" r="0.9" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="3.3s" begin="-0.3s" repeatCount="indefinite"/></circle><circle cx="562" cy="149" r="1.8" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="2.4s" begin="-2.3s" repeatCount="indefinite"/></circle><circle cx="698" cy="23" r="1.8" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="2.3s" begin="-0.9s" repeatCount="indefinite"/></circle><circle cx="1040" cy="42" r="1.4" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="3.3s" begin="-2.2s" repeatCount="indefinite"/></circle><circle cx="1054" cy="86" r="1.1" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="2.5s" begin="-2.3s" repeatCount="indefinite"/></circle><circle cx="662" cy="103" r="0.9" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="3.6s" begin="-0.3s" repeatCount="indefinite"/></circle><circle cx="531" cy="60" r="1.8" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="4.0s" begin="-1.7s" repeatCount="indefinite"/></circle><circle cx="791" cy="127" r="1.8" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="3.1s" begin="-1.0s" repeatCount="indefinite"/></circle><circle cx="654" cy="70" r="0.9" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="3.7s" begin="-2.1s" repeatCount="indefinite"/></circle><circle cx="821" cy="122" r="1.4" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="3.8s" begin="-0.3s" repeatCount="indefinite"/></circle><circle cx="994" cy="115" r="1.1" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="4.2s" begin="-0.6s" repeatCount="indefinite"/></circle><circle cx="970" cy="115" r="0.9" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="4.7s" begin="-0.3s" repeatCount="indefinite"/></circle><circle cx="1041" cy="88" r="1.4" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="4.0s" begin="-2.4s" repeatCount="indefinite"/></circle><circle cx="1063" cy="124" r="0.9" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="4.4s" begin="-3.8s" repeatCount="indefinite"/></circle><circle cx="955" cy="24" r="0.9" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="4.1s" begin="-1.2s" repeatCount="indefinite"/></circle><circle cx="1061" cy="122" r="1.4" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="4.1s" begin="-3.5s" repeatCount="indefinite"/></circle><circle cx="825" cy="13" r="1.8" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="3.1s" begin="-2.4s" repeatCount="indefinite"/></circle><circle cx="975" cy="23" r="1.1" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="4.2s" begin="-0.5s" repeatCount="indefinite"/></circle><circle cx="723" cy="109" r="1.8" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="4.6s" begin="-2.0s" repeatCount="indefinite"/></circle><circle cx="640" cy="122" r="1.8" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="3.6s" begin="-3.5s" repeatCount="indefinite"/></circle><circle cx="910" cy="148" r="1.4" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="4.0s" begin="-3.9s" repeatCount="indefinite"/></circle><circle cx="1169" cy="105" r="1.1" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="2.6s" begin="-0.7s" repeatCount="indefinite"/></circle><circle cx="707" cy="67" r="0.9" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="3.5s" begin="-2.4s" repeatCount="indefinite"/></circle><circle cx="739" cy="80" r="0.9" fill="#fff"><animate attributeName="opacity" values=".15;1;.15" dur="2.6s" begin="-2.1s" repeatCount="indefinite"/></circle>
<g><line x1="0" y1="0" x2="70" y2="0" stroke="url(#sh)" stroke-width="2" stroke-linecap="round"/>
<animateTransform attributeName="transform" type="translate" values="560 20;860 110" dur="9s" repeatCount="indefinite" keyTimes="0;1"/>
<animate attributeName="opacity" values="0;0;1;0;0" keyTimes="0;.82;.88;.96;1" dur="9s" repeatCount="indefinite"/></g>
<circle cx="900" cy="232" r="215" fill="url(#h)"><animate attributeName="r" values="205;225;205" dur="5s" repeatCount="indefinite"/></circle>
<circle cx="900" cy="232" r="122" fill="url(#u)" mask="url(#c)"/>
<path d="M470 246 L560 196 L612 222 L690 168 L760 214 L800 200 L840 246Z M960 246 L1010 206 L1060 228 L1120 186 L1200 230 L1200 246Z" fill="url(#mt)"/>
<path d="M470 246 L560 196 L612 222 L690 168 L760 214 L800 200 L840 246 M960 246 L1010 206 L1060 228 L1120 186 L1200 230" fill="none" stroke="#ff5fae" stroke-width="1.6" opacity=".85"/>
<g fill="#12061e"><rect x="560" y="200" width="24" height="46"/><rect x="588" y="178" width="20" height="68"/><rect x="612" y="206" width="30" height="40"/><rect x="646" y="190" width="18" height="56"/><rect x="1040" y="196" width="22" height="50"/><rect x="1066" y="212" width="34" height="34"/></g>
<g fill="#2de2e6"><rect x="593" y="190" width="3" height="4"><animate attributeName="opacity" values="1;.2;1" dur="3s" repeatCount="indefinite"/></rect><rect x="600" y="208" width="3" height="4"/><rect x="566" y="214" width="3" height="4"><animate attributeName="opacity" values=".2;1;.2" dur="4s" repeatCount="indefinite"/></rect><rect x="651" y="204" width="3" height="4"/><rect x="1047" y="210" width="3" height="4"><animate attributeName="opacity" values="1;.3;1" dur="2.6s" repeatCount="indefinite"/></rect><rect x="1076" y="222" width="3" height="4"/></g>
<rect y="246" width="1200" height="114" fill="url(#m)"/>
<rect y="245" width="1200" height="2" fill="#2de2e6"><animate attributeName="opacity" values=".6;1;.6" dur="3s" repeatCount="indefinite"/></rect>
<rect x="815" y="253" width="170" height="2.4" rx="1.2" fill="#ff8fc6"><animate attributeName="opacity" values=".25;.9;.25" dur="2.4s" begin="-0s" repeatCount="indefinite"/><animate attributeName="x" values="815;823;815" dur="3.4s" repeatCount="indefinite"/></rect><rect x="834" y="262" width="132" height="2.4" rx="1.2" fill="#ff8fc6"><animate attributeName="opacity" values=".25;.9;.25" dur="2.9s" begin="-1s" repeatCount="indefinite"/><animate attributeName="x" values="834;842;834" dur="3.9s" repeatCount="indefinite"/></rect><rect x="848" y="272" width="104" height="2.4" rx="1.2" fill="#ff8fc6"><animate attributeName="opacity" values=".25;.9;.25" dur="2.2s" begin="-0.5s" repeatCount="indefinite"/><animate attributeName="x" values="848;856;848" dur="3.2s" repeatCount="indefinite"/></rect><rect x="860" y="284" width="80" height="2.4" rx="1.2" fill="#ff8fc6"><animate attributeName="opacity" values=".25;.9;.25" dur="3.1s" begin="-1.5s" repeatCount="indefinite"/><animate attributeName="x" values="860;868;860" dur="4.1s" repeatCount="indefinite"/></rect><rect x="872" y="297" width="56" height="2.4" rx="1.2" fill="#ff8fc6"><animate attributeName="opacity" values=".25;.9;.25" dur="2.6s" begin="-0.8s" repeatCount="indefinite"/><animate attributeName="x" values="872;880;872" dur="3.6s" repeatCount="indefinite"/></rect><rect x="882" y="312" width="36" height="2.4" rx="1.2" fill="#ff8fc6"><animate attributeName="opacity" values=".25;.9;.25" dur="2.8s" begin="-2s" repeatCount="indefinite"/><animate attributeName="x" values="882;890;882" dur="3.8s" repeatCount="indefinite"/></rect>
<path d="M480 352 L1200 330" stroke="#1f0b30" stroke-width="12"/>
<path d="M480 349 L1200 327" stroke="#ff4060" stroke-width="2.2" stroke-dasharray="14 70" stroke-linecap="round"><animate attributeName="stroke-dashoffset" values="0;168" dur="1.4s" repeatCount="indefinite"/></path>
<path d="M480 355 L1200 333" stroke="#fffbe0" stroke-width="2.2" stroke-dasharray="18 90" stroke-linecap="round"><animate attributeName="stroke-dashoffset" values="216;0" dur="1.8s" repeatCount="indefinite"/></path>
<g fill="none" stroke="#1a0828" stroke-width="2.2" stroke-linecap="round"><path d="M0 0 q7 -7 14 0 q7 -7 14 0"><animateTransform attributeName="transform" type="translate" values="1210 70;640 96" dur="16s" repeatCount="indefinite"/></path><path d="M0 0 q5 -5 10 0 q5 -5 10 0"><animateTransform attributeName="transform" type="translate" values="1240 84;660 112" dur="16s" repeatCount="indefinite"/></path></g>
<g fill="#0a0312"><path d="M1185 360 C1172 300 1158 250 1128 200 L1120 203 C1146 252 1160 300 1170 360Z"/><path d="M1124 200 C1090 176 1052 180 1024 202 C1058 186 1094 188 1124 206Z"/><path d="M1124 200 C1108 166 1080 150 1046 150 C1080 162 1106 180 1122 204Z"/><path d="M1126 198 C1132 160 1156 138 1186 132 C1162 150 1144 174 1128 204Z"/><path d="M1126 200 C1158 180 1194 180 1220 196 C1186 192 1156 196 1128 206Z"/><path d="M1124 202 C1100 206 1086 226 1082 250 C1094 230 1106 216 1126 208Z"/><animateTransform attributeName="transform" type="rotate" values="-1.6 1180 360;1.8 1180 360;-1.6 1180 360" dur="7s" repeatCount="indefinite"/></g>
</svg>`);
  function nbScene(on) {
    let el = doc.getElementById('pv2-nb-scene');
    doc.body.classList.toggle('pv2-nb-on', !!on);
    if (!on) { if (el) el.remove(); return; }
    if (el) return;
    injectStyle();
    el = doc.createElement('div'); el.id = 'pv2-nb-scene'; el.setAttribute('aria-hidden', 'true'); el.innerHTML = NB_SVG;
    doc.documentElement.style.setProperty('--pv2-nb-hero', 'url("' + NB_HERO + '")');
    const sc = doc.getElementById('plus2-scene');
    if (sc && sc.parentNode) sc.parentNode.insertBefore(el, sc.nextSibling); else doc.body.insertBefore(el, doc.body.firstChild);
  }
  function nbSplash() {
    if (doc.getElementById('pv2-nb-splash')) return;
    injectStyle();
    const el = doc.createElement('div'); el.id = 'pv2-nb-splash'; el.setAttribute('aria-hidden', 'true');
    const today = Math.abs(LAUNCH.getTime() - Date.now()) < 86400000 && Date.now() >= LAUNCH.getTime();
    el.innerHTML = '<div class="sun"></div><div class="t">NOITE DE LANÇAMENTO</div><div class="s">' + (today ? '🎉 É HOJE! BOA JOGATINA' : launchLabel().replace('🌴 ', '')) + '</div><div class="h">toque na tela • segure pra pilotar</div>';
    doc.body.appendChild(el);
    setTimeout(() => { ensureCanvas(); const x = W / 2, y = H * 0.42; for (let i = 0; i < (reduce() ? 4 : 10); i++) emo(x, y, '💵', { g: 160, v: rnd(160, 380), vr: rnd(-3, 3), max: 2 }); ring(x, y, '255,61,154', { r0: 70, vr: 380, max: 0.8, w: 3 }); ring(x, y, '45,226,230', { r0: 70, vr: 260, max: 1, w: 2 }); wake(); }, 400);
    setTimeout(() => el.remove(), 2900);
  }
  // carro neon (desenho próprio) passando pelo rodapé
  function nbCar(dirRight) {
    if (reduce()) return;
    ensureCanvas();
    const s = W < 700 ? 0.7 : 1, sp = 1150 * s;
    P({ k: 'car', x: dirRight ? -200 * s : W + 200 * s, y: H - 22 * s, vx: dirRight ? sp : -sp, s, max: (W + 420 * s) / sp, dir: dirRight ? 1 : -1 });
    sound('pew');
    wake();
  }
  let carT = 0;
  function scheduleCar(first) {
    clearTimeout(carT);
    carT = setTimeout(() => {
      if (isNB() && allowed() && !doc.hidden && !doc.body.classList.contains('pv2-modal-open')) nbCar(Math.random() < 0.6);
      if (isNB()) scheduleCar();
    }, first ? rnd(3500, 6000) : rnd(20000, 34000));
  }
  function drawCar(p, dt) {
    const s = p.s;
    if (p.driven) {
      if (drive.on) { p.life = 0.1; const tx = Math.max(60, Math.min(W - 60, drive.x)); const nx = p.x + (tx - p.x) * Math.min(1, dt * 7); const v = (nx - p.x) / Math.max(dt, 0.001); if (Math.abs(v) > 30) p.dir = v > 0 ? 1 : -1; p.vx = v; p.x = nx; }
      else { p.vx = p.dir * Math.max(900, Math.abs(p.vx) + 1600 * dt) ; p.x += p.vx * dt; if (p.x < -260 || p.x > W + 260) p.life = p.max; }
    } else p.x += p.vx * dt;
    const d = p.dir;
    const x = p.x, y = p.y;
    if (Math.random() < 0.7) spark(x - d * 70 * s, y - 6 * s, pick(['255,61,154', '45,226,230', '255,154,60']), { a: d > 0 ? Math.PI + rnd(-0.2, 0.2) : rnd(-0.2, 0.2), v: rnd(60, 180), g: -20, max: 0.4, s: rnd(1, 2) });
    ctx.save(); ctx.translate(x, y); ctx.scale(d * s, s);
    // linhas de velocidade
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 4; i++) { ctx.strokeStyle = `rgba(45,226,230,${0.35 - i * 0.07})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-90 - i * 40, -14 - i * 7); ctx.lineTo(-170 - i * 70, -14 - i * 7); ctx.stroke(); }
    // brilho por baixo
    const ug = ctx.createRadialGradient(0, 4, 4, 0, 4, 95);
    ug.addColorStop(0, 'rgba(255,61,154,.75)'); ug.addColorStop(1, 'rgba(255,61,154,0)');
    ctx.fillStyle = ug; ctx.beginPath(); ctx.ellipse(0, 4, 95, 12, 0, 0, 6.29); ctx.fill();
    // farol (frente)
    const hb = ctx.createLinearGradient(70, -12, 190, -4);
    hb.addColorStop(0, 'rgba(255,250,220,.65)'); hb.addColorStop(1, 'rgba(255,250,220,0)');
    ctx.fillStyle = hb; ctx.beginPath(); ctx.moveTo(72, -16); ctx.lineTo(190, -30); ctx.lineTo(190, 4); ctx.lineTo(72, -9); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // carroceria (cupê baixo em cunha)
    const bg = ctx.createLinearGradient(0, -40, 0, -4);
    bg.addColorStop(0, '#ff5fae'); bg.addColorStop(1, '#7a1050');
    ctx.fillStyle = bg; ctx.strokeStyle = '#2de2e6'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(-82, -8); ctx.lineTo(-80, -22); ctx.lineTo(-56, -27); ctx.lineTo(-22, -40); ctx.lineTo(20, -41); ctx.lineTo(46, -28); ctx.lineTo(80, -22); ctx.lineTo(84, -10); ctx.lineTo(76, -6); ctx.lineTo(-76, -6); ctx.closePath(); ctx.fill(); ctx.stroke();
    // vidro
    ctx.fillStyle = 'rgba(45,226,230,.55)'; ctx.beginPath(); ctx.moveTo(-40, -28); ctx.lineTo(-18, -37); ctx.lineTo(16, -38); ctx.lineTo(36, -28); ctx.closePath(); ctx.fill();
    // lanterna traseira e farol
    ctx.fillStyle = '#ff2a2a'; ctx.fillRect(-83, -20, 5, 6);
    ctx.fillStyle = '#fffbe0'; ctx.fillRect(79, -20, 5, 5);
    // rodas girando
    for (const wx of [-50, 52]) {
      ctx.fillStyle = '#0c0414'; ctx.beginPath(); ctx.arc(wx, -6, 12, 0, 6.29); ctx.fill();
      ctx.strokeStyle = '#2de2e6'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(wx, -6, 7, 0, 6.29); ctx.stroke();
      const r0 = p.life * 40;
      for (let k = 0; k < 3; k++) { const a = r0 + k * 2.09; ctx.beginPath(); ctx.moveTo(wx, -6); ctx.lineTo(wx + Math.cos(a) * 7, -6 + Math.sin(a) * 7); ctx.stroke(); }
    }
    ctx.restore();
  }

  // ---- Noite de Lançamento: contagem ao vivo dentro do cartão do Início
  function nbClock() {
    const hero = doc.getElementById('home-tournament-banner');
    let chip = doc.getElementById('pv2-nb-clock');
    if (!isNB() || !hero) { if (chip) chip.remove(); return; }
    if (!chip || chip.parentElement !== hero) {
      if (chip) chip.remove();
      chip = doc.createElement('div'); chip.id = 'pv2-nb-clock'; chip.setAttribute('aria-live', 'off');
      hero.appendChild(chip);
    }
    const ms = LAUNCH.getTime() - Date.now();
    let html;
    if (ms > 0) {
      const d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000) % 24, m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60;
      const u = (n, l) => '<b>' + String(n).padStart(2, '0') + '</b><i>' + l + '</i>';
      html = '<span class="lbl">LANÇA EM</span><span class="dig">' + u(d, 'D') + u(h, 'H') + u(m, 'M') + u(sec, 'S') + '</span>';
    } else if (ms > -3 * 86400000) html = '<span class="lbl">JÁ SAIU</span><span class="dig"><b>BOA JOGATINA!</b></span>';
    else { chip.remove(); return; }
    if (chip.innerHTML !== html) chip.innerHTML = html;
  }
  setInterval(nbClock, 1000);
  // parallax da arte do cartão (só mouse)
  let parT = 0;
  doc.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !isNB() || reduce() || parT) return;
    parT = requestAnimationFrame(() => {
      parT = 0;
      const hero = doc.getElementById('home-tournament-banner'); if (!hero) return;
      const r = hero.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width - 0.5, ny = (e.clientY - r.top) / r.height - 0.5;
      hero.style.setProperty('--nbx', (Math.max(-0.6, Math.min(0.6, nx)) * -26).toFixed(1) + 'px');
      hero.style.setProperty('--nby', (Math.max(-0.6, Math.min(0.6, ny)) * -12).toFixed(1) + 'px');
    });
  }, { passive: true });
  // segurar o clique/dedo = aparece o carro neon e ele segue você; soltar = ele acelera e some
  const drive = { on: 0, x: 0, t0: 0, id: null, timer: 0, car: null };
  function startDrive(e) {
    drive.x = e.clientX; drive.id = e.pointerId; drive.t0 = performance.now();
    clearTimeout(drive.timer);
    drive.timer = setTimeout(() => {
      if (!isNB() || !allowed()) return;
      drive.on = 1; ensureCanvas();
      const s = W < 700 ? 0.7 : 1;
      drive.car = { k: 'car', driven: 1, x: drive.x < W / 2 ? -180 * s : W + 180 * s, y: H - 22 * s, vx: 0, s, max: 60, dir: drive.x < W / 2 ? 1 : -1, life: 0 };
      P(drive.car); sound('pew'); wake();
    }, 320);
  }
  function endDrive(e) {
    if (e && drive.id != null && e.pointerId !== drive.id) return;
    clearTimeout(drive.timer);
    if (drive.on && drive.car) { textPop(drive.car.x, drive.car.y - 50, 'VRUUUM!', '45,226,230', { big: 1, max: 1 }); sound('boom'); wake(); }
    drive.on = 0; drive.car = null; drive.id = null;
  }
  // só em área livre: segurar em botão, link, campo ou mensagem (pra selecionar texto) não chama o carro
  const NO_DRIVE = 'a, button, [role="button"], input, textarea, select, label, summary, [contenteditable="true"], .message, .msg, .modal-overlay, .navbar-search';
  doc.addEventListener('pointerdown', (e) => { if (e.button === 0 && isNB() && allowed() && !reduce() && !(e.target && e.target.closest && e.target.closest(NO_DRIVE))) startDrive(e); }, { capture: true, passive: true });
  doc.addEventListener('pointermove', (e) => {
    if (e.pointerId !== drive.id) return;
    // arrastou muito antes de "pegar" (ex.: rolando a tela) = cancela
    if (!drive.on && Math.abs(e.clientX - drive.x) > 40) { clearTimeout(drive.timer); drive.id = null; return; }
    drive.x = e.clientX;
  }, { passive: true });
  doc.addEventListener('pointerup', endDrive, { capture: true, passive: true });
  doc.addEventListener('pointercancel', endDrive, { capture: true, passive: true });


  // ---- Noite de Lançamento no app inteiro (v0.98.9)
  // lembra o último tema neste aparelho (a abertura do app usa isso antes do login)
  function rememberTheme() {
    const t = global.PlusV2LiveCurrentTheme;
    if (!t || !t.key) return;
    try { localStorage.setItem('pv2_last_theme', t.key); } catch (_) { /* sem storage */ }
    doc.documentElement.classList.toggle('nb-boot', t.key === NB_KEY);
  }
  // troca de aba/tela: faixa de luz neon passando + conteúdo entrando
  const NAV_SEL = '.sidebar-nav-item, .server-row, .channel-item, .friend-row, #dm-friends-shortcut, .settings-sidebar-item, .manage-tab, .friends-tab, .home-btn-primary, .home-btn-secondary';
  let sweepT = 0;
  function nbSweep() {
    if (reduce() || !allowed()) return;
    const main = doc.querySelector('.app-main'); if (!main) return;
    injectStyle();
    let sw = doc.getElementById('pv2-nb-sweep');
    if (!sw) { sw = doc.createElement('div'); sw.id = 'pv2-nb-sweep'; sw.setAttribute('aria-hidden', 'true'); doc.body.appendChild(sw); }
    const r = main.getBoundingClientRect();
    sw.style.left = r.left + 'px'; sw.style.top = r.top + 'px'; sw.style.width = r.width + 'px'; sw.style.height = r.height + 'px';
    sw.classList.remove('go'); void sw.offsetWidth; sw.classList.add('go');
    main.classList.remove('pv2-nb-enter'); void main.offsetWidth; main.classList.add('pv2-nb-enter');
    clearTimeout(sweepT); sweepT = setTimeout(() => { sw.classList.remove('go'); main.classList.remove('pv2-nb-enter'); }, 700);
  }
  doc.addEventListener('click', (e) => {
    if (!isNB()) return;
    const el = e.target && e.target.closest ? e.target.closest(NAV_SEL) : null;
    if (el) setTimeout(nbSweep, 30);
  }, { capture: true, passive: true });
  // chat: enviar = dinheiro; menção = sirene; digitar = faísca neon no campo
  global.addEventListener('pv2:chat', (ev) => {
    if (!isNB() || !allowed() || reduce()) return;
    const d = (ev && ev.detail) || {};
    const m = doc.querySelectorAll('#messages > *'); const last = m[m.length - 1];
    if (!last) return;
    const r = last.getBoundingClientRect();
    const x = Math.min(W - 40, r.left + Math.min(r.width, 260) * (d.own ? 0.75 : 0.3)), y = Math.max(80, Math.min(H - 90, r.top + 10));
    ensureCanvas();
    for (let i = 0; i < (d.own ? 4 : 2); i++) emo(x, y, '💵', { g: 160, v: rnd(90, 200), vr: rnd(-3, 3), s: rnd(18, 24), max: 1.2 });
    if (d.mention) { P({ k: 'siren', x, y, max: 1 }); textPop(x, y - 24, 'TE CHAMARAM!', '255,61,154'); }
    else if (d.own && Math.random() < 0.35) P({ k: 'neonword', x, y: y - 26, str: pick(['MANDOU!', 'BORA!', 'ENVIADO!']), c: pick(['255,61,154', '45,226,230']), max: 1, rot: rnd(-0.15, 0.15) });
    wake();
  });
  let typeT = 0;
  doc.addEventListener('input', (e) => {
    const inp = e.target;
    if (!isNB() || reduce() || !allowed() || !inp || inp.id !== 'message-input') return;
    const now = performance.now(); if (now - typeT < 45) return; typeT = now;
    const r = inp.getBoundingClientRect();
    const x = Math.min(r.right - 12, r.left + 14 + Math.min(String(inp.value).length * 7.4, r.width - 30));
    ensureCanvas();
    for (let i = 0; i < 3; i++) spark(x, r.top + r.height / 2, pick(['255,61,154', '45,226,230', '255,154,60']), { a: -Math.PI / 2 + rnd(-0.9, 0.9), v: rnd(30, 90), g: 120, max: rnd(0.3, 0.5), s: rnd(1, 2) });
    wake();
  }, { passive: true });

  // ------------------------------------------------------------ loop
  function tick(t) {
    raf = 0;
    if (!cv) return;
    if (doc.body.classList.contains('pv2-modal-open')) { parts = []; orbs = []; ctx.clearRect(0, 0, W, H); return; }
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016; last = t;
    ctx.clearRect(0, 0, W, H);
    // projéteis do Magic Tank
    for (let i = orbs.length - 1; i >= 0; i--) {
      const o = orbs[i]; o.t += dt / o.dur;
      const u = Math.min(1, o.t), iu = 1 - u;
      const x = iu * iu * o.x0 + 2 * iu * u * o.cx + u * u * o.x1;
      const y = iu * iu * o.y0 + 2 * iu * u * o.cy + u * u * o.y1;
      const R = o.mega ? 30 : 16;
      // rastro de luz (fita que afina)
      (o.hist = o.hist || []).push(x, y); if (o.hist.length > 24) o.hist.splice(0, 2);
      ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
      for (let j = 2; j < o.hist.length; j += 2) {
        const f2 = j / o.hist.length;
        ctx.strokeStyle = `rgba(${f2 > 0.6 ? GOLD : BLUE},${(f2 * 0.8).toFixed(3)})`; ctx.lineWidth = R * 0.55 * f2;
        ctx.beginPath(); ctx.moveTo(o.hist[j - 2], o.hist[j - 1]); ctx.lineTo(o.hist[j], o.hist[j + 1]); ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
      spark(x, y, pick([GOLD, ICE]), { v: rnd(10, 50), g: 20, max: 0.35, s: rnd(1.2, 2.6) });
      const g = ctx.createRadialGradient(x, y, 0, x, y, R);
      g.addColorStop(0, 'rgba(255,255,235,1)'); g.addColorStop(0.35, `rgba(${GOLD},.9)`); g.addColorStop(1, `rgba(${BLUE},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, R, 0, 6.29); ctx.fill();
      if (u >= 1) { orbs.splice(i, 1); if (o.mega) mtMega(o.x1, o.y1); else { mtBoom(o.x1, o.y1, o.combo); hitCrystals(o.x1, o.y1, 60); } }
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
      } else if (p.k === 'comet') {
        p.x += p.vx * dt; p.y += p.vy * dt;
        const tx = p.x - p.vx * 0.16, ty = p.y - p.vy * 0.16;
        const g = ctx.createLinearGradient(tx, ty, p.x, p.y);
        g.addColorStop(0, `rgba(${BLUE},0)`); g.addColorStop(1, `rgba(${GOLD},${(0.85 * Math.min(1, k * 3)).toFixed(3)})`);
        ctx.strokeStyle = g; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(p.x, p.y); ctx.stroke();
        ctx.fillStyle = 'rgba(255,250,225,.95)'; ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, 6.29); ctx.fill();
        if (Math.random() < 0.5) spark(p.x, p.y, pick([GOLD, ICE]), { v: rnd(10, 40), g: 60, max: 0.5, s: rnd(0.8, 1.8) });
      } else if (p.k === 'text') {
        p.y += p.vy * dt;
        ctx.globalCompositeOperation = 'source-over';
        ctx.font = p.big ? '900 30px system-ui, sans-serif' : p.pixel ? '900 16px ui-monospace, Menlo, monospace' : '900 18px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.lineWidth = 4; ctx.strokeStyle = `rgba(5,8,16,${k.toFixed(3)})`; ctx.strokeText(p.str, p.x, p.y);
        ctx.fillStyle = `rgba(${p.c},${k.toFixed(3)})`; ctx.fillText(p.str, p.x, p.y);
        ctx.globalCompositeOperation = 'lighter';
      } else {
        drawFest(p, dt, k);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    const tankOn = drawTank(dt);
    drawCharge();
    if ((parts.length || orbs.length || tankOn || charge.on || drive.on) && !raf) raf = requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ Magic Tank: cometas e brilho nos botões
  let cometT = 0;
  function scheduleComet() {
    clearTimeout(cometT);
    cometT = setTimeout(() => {
      if (isMT() && allowed() && !doc.hidden && !reduce()) {
        ensureCanvas();
        const ltr = Math.random() < 0.5, sp = rnd(520, 760), y0 = rnd(H * 0.08, H * 0.4);
        const a = rnd(0.12, 0.3);
        parts.push({ k: 'comet', x: ltr ? -40 : W + 40, y: y0, vx: (ltr ? 1 : -1) * Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: (W + 80) / (Math.cos(a) * sp) });
        wake();
      }
      if (isMT()) scheduleComet();
    }, rnd(6000, 11000));
  }
  const hoverSeen = new WeakMap();
  function hoverSparkle(el) {
    const now = performance.now();
    if (now - (hoverSeen.get(el) || 0) < 700) return;
    hoverSeen.set(el, now);
    const r = el.getBoundingClientRect();
    if (r.width < 12 || r.width * r.height > W * H * 0.2) return;
    ensureCanvas();
    const hc = isMT() ? [GOLD, GOLD, ICE] : FEST[festKey()].cols;
    for (let i = 0; i < 6; i++) spark(rnd(r.left + 4, r.right - 4), r.top + rnd(0, 4), pick(hc), { a: rnd(-Math.PI * 0.85, -Math.PI * 0.15), v: rnd(30, 90), g: 80, max: rnd(0.4, 0.7), s: rnd(1, 2) });
    wake();
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
  let wasMT = false, hadOtherTheme = false, lastFest = null, prevThemeKey = null;
  function watchTheme() {
    const curKey = (global.PlusV2LiveCurrentTheme || {}).key || null;
    if (curKey) rememberTheme();
    const switchedFrom = curKey !== prevThemeKey ? prevThemeKey : undefined;
    if (curKey) prevThemeKey = curKey;
    const now = isMT();
    if (now && !wasMT) {
      // Trocou de outro tema pro Magic Tank nesta página = escolheu agora:
      // abertura sempre. Só carregou a página já com ele: uma vez por sessão.
      let seen = false;
      try { seen = sessionStorage.getItem('pv2_mt_splash') === '1'; sessionStorage.setItem('pv2_mt_splash', '1'); } catch (_) { /* sem storage */ }
      if (hadOtherTheme || !seen) setTimeout(() => { if (isMT() && allowed()) splash(); }, 150);
    }
    if (!now && global.PlusV2LiveCurrentTheme) hadOtherTheme = true;
    if (now && !wasMT) { scheduleComet(); scheduleCrystal(true); } else if (!now) { clearTimeout(cometT); clearTimeout(crystalT); parts = parts.filter((p) => p.k !== 'crystal'); }
    const fk = festKey();
    if (fk === 'noite-de-lancamento' && lastFest !== fk) {
      nbScene(true); scheduleCar(true);
      let seenNb = false;
      try { seenNb = sessionStorage.getItem('pv2_nb_splash') === '1'; sessionStorage.setItem('pv2_nb_splash', '1'); } catch (_) { /* sem storage */ }
      if ((switchedFrom || !seenNb) && allowed()) setTimeout(() => { if (isNB()) nbSplash(); }, 200);
      setTimeout(() => { const b = doc.getElementById('app-sidebar-theme-banner'); if (b && isNB()) b.textContent = launchLabel(); }, 400);
    } else if (fk !== 'noite-de-lancamento' && lastFest === 'noite-de-lancamento') { nbScene(false); clearTimeout(carT); parts = parts.filter((p) => p.k !== 'car'); }
    if (fk && fk !== lastFest && allowed()) setTimeout(() => { if (festKey() === fk) festHello(fk); }, fk === 'noite-de-lancamento' ? 3100 : 900);
    lastFest = fk;
    wasMT = now;
    colorsFor = null; // cores podem ter mudado
    hideSpot();
  }

  // ------------------------------------------------------------ eventos
  const TYPING = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';
  doc.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !allowed()) return;
    if (e.target && e.target.closest && e.target.closest(TYPING)) return;
    if (isMT()) {
      mtFire(e.clientX, e.clientY);
      if (!reduce()) { charge.on = 1; charge.x = e.clientX; charge.y = e.clientY; charge.t0 = performance.now(); charge.id = e.pointerId; wake(); }
    } else if (festKey()) festTap(e.clientX, e.clientY);
    else ripple(e.clientX, e.clientY);
  }, { capture: true, passive: true });
  // tiro carregado do Magic Tank: segurou >= MEGA_MS e soltou = MEGA MAGIA
  const endCharge = (e, fire) => {
    if (!charge.on || (e && charge.id != null && e.pointerId !== charge.id)) return;
    const held = performance.now() - charge.t0;
    charge.on = 0;
    if (fire && held >= MEGA_MS && isMT() && allowed()) megaFire(charge.x, charge.y);
  };
  doc.addEventListener('pointerup', (e) => endCharge(e, true), { capture: true, passive: true });
  doc.addEventListener('pointercancel', (e) => endCharge(e, false), { capture: true, passive: true });
  global.addEventListener('blur', () => endCharge(null, false));
  doc.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !allowed()) { hideSpot(); return; }
    moveSpot(e.target, e.clientX, e.clientY);
    if (charge.on && e.pointerId === charge.id) { charge.x = e.clientX; charge.y = e.clientY; }
    if (!reduce()) { const fk = festKey(); if (fk) { const now = performance.now(); if (now - lastTrail >= 28 && parts.length < 220) { lastTrail = now; ensureCanvas(); festTrail(e.clientX, e.clientY, FEST[fk].trail); wake(); } } else trail(e.clientX, e.clientY); }
  }, { passive: true });
  // no toque (celular) a mira do tiro carregado acompanha o dedo
  doc.addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse' && charge.on && e.pointerId === charge.id) { charge.x = e.clientX; charge.y = e.clientY; } }, { passive: true });
  doc.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse' || reduce() || !allowed() || (!isMT() && !festKey())) return;
    const b = e.target && e.target.closest ? e.target.closest('button, a, [role="button"]') : null;
    if (b) hoverSparkle(b);
  }, { passive: true });
  global.addEventListener('scroll', hideSpot, { capture: true, passive: true });
  global.addEventListener('blur', hideSpot);
  global.addEventListener('resize', () => { size(); hideSpot(); });

  // ------------------------------------------------------------ janela aberta = efeitos pausados
  // CORRIGIDO (0.98.3, vídeo "a lista de temas some ao rolar"): com uma janela
  // aberta (Configurações, Explorar...) as camadas animadas em tela cheia
  // ficavam invisíveis (opacity 0), mas continuavam sendo desenhadas 60x/s por
  // trás do fundo desfocado da janela. Em tela grande/Retina o Chrome não dava
  // conta e pedaços da lista ficavam em branco ao rolar. Agora, com janela
  // aberta, os loops param e as camadas saem da renderização (display:none).
  // A moldura do tema não é afetada.
  const OPEN_MODAL = '.modal-overlay:not(.hidden):not(.pv2-hide-for-preview)';
  let modalCheckT = 0;
  function syncModalPause() {
    modalCheckT = 0;
    const open = !!doc.querySelector(OPEN_MODAL);
    if (open !== doc.body.classList.contains('pv2-modal-open')) {
      doc.body.classList.toggle('pv2-modal-open', open);
      if (!open) wake();
    }
  }
  function queueModalCheck() { if (!modalCheckT) modalCheckT = requestAnimationFrame(syncModalPause); }

  function start() {
    if (!doc.body) return;
    syncModalPause();
    new MutationObserver(queueModalCheck).observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
    injectStyle(); // cursor da varinha precisa estar pronto antes do 1º clique
    watchTheme();
    new MutationObserver(watchTheme).observe(doc.body, { attributes: true, attributeFilter: ['class'] });
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();

  global.PlusV2Interact = { car: () => nbCar(true), ripple, fire: mtFire, mega: megaFire, festTap: (x, y) => { if (festKey()) festTap(x, y); }, crystal: () => scheduleCrystal(true), splash, active: allowed, stats: () => ({ baloes: parts.filter((p) => p.k === 'balloon').map((p) => [Math.round(p.x), Math.round(p.y)]), cristais: parts.filter((p) => p.k === 'crystal').map((p) => [Math.round(p.x), Math.round(p.y + Math.sin(p.ph) * 8)]), particulas: parts.length, cometas: parts.filter((p) => p.k === 'comet').length }) };
})(typeof window !== 'undefined' ? window : globalThis);
