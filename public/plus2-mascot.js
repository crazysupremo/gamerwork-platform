// plus2-mascot.js — mascotes das datas comemorativas (v0.87.0).
// Cada data tem personagens desenhados em SVG que voam, pousam nos servidores/botões,
// falam, fazem perguntas, soltam itens coletáveis, correm atrás do mouse e reagem ao clique.
(function (global) {
  'use strict';
  // ---------------------------------------------------------------------
  // DESENHOS DOS MASCOTES (SVG, viewBox 0 0 100 120, pés em y≈111)
  // Cada mascote tem: olhos que piscam (.pv2-eye), braço que acena (.pv2-arm)
  // e braço parado (.pv2-armL). O CSS anima isso (ver plus2.css).
  // ---------------------------------------------------------------------
  const NSV = "xmlns='http://www.w3.org/2000/svg'";
  const INK = '#1d1d2b';
  const eyes = (y, dx) => `<g class='pv2-eyes'><ellipse class='pv2-eye' cx='${50 - dx}' cy='${y}' rx='3.4' ry='4.1' fill='${INK}'/><ellipse class='pv2-eye' cx='${50 + dx}' cy='${y}' rx='3.4' ry='4.1' fill='${INK}'/><circle cx='${51 - dx}' cy='${y - 1.6}' r='1.2' fill='#fff'/><circle cx='${51 + dx}' cy='${y - 1.6}' r='1.2' fill='#fff'/></g>`;
  const mouth = (y) => `<path d='M43.5 ${y} Q50 ${y + 8} 56.5 ${y}' stroke='${INK}' stroke-width='2.2' fill='none' stroke-linecap='round'/>`;
  const cheeks = (y, dx, c) => `<ellipse cx='${50 - dx}' cy='${y}' rx='4.6' ry='3' fill='${c || '#ff8fa3'}' opacity='.55'/><ellipse cx='${50 + dx}' cy='${y}' rx='4.6' ry='3' fill='${c || '#ff8fa3'}' opacity='.55'/>`;
  const feet = (c) => `<ellipse cx='37' cy='111' rx='12' ry='6.2' fill='${c}'/><ellipse cx='63' cy='111' rx='12' ry='6.2' fill='${c}'/>`;
  const wrapM = (inner) => `<svg ${NSV} viewBox='0 0 100 120'>${inner}</svg>`;
  const shine = (cx, cy, rx, ry) => `<ellipse cx='${cx}' cy='${cy}' rx='${rx}' ry='${ry}' fill='#fff' opacity='.16' transform='rotate(-25 ${cx} ${cy})'/>`;
  const armL = (c, x, y) => `<g class='pv2-armL'><ellipse cx='${x}' cy='${y}' rx='7' ry='13' fill='${c}' transform='rotate(20 ${x} ${y})'/></g>`;
  const armR = (c, x, y, held) => `<g class='pv2-arm'><ellipse cx='${x}' cy='${y}' rx='7' ry='13' fill='${c}' transform='rotate(-20 ${x} ${y})'/>${held || ''}</g>`;

  const MASCOTS = {
    // ---- NATAL ----
    snowman: () => wrapM(`${feet('#c5d1e8')}
      <ellipse cx='50' cy='84' rx='29' ry='27' fill='#f6f9ff' stroke='#d3dcec' stroke-width='1.5'/>${shine(40, 74, 7, 12)}
      <path d='M24 80 L6 66 M12 70 L7 78' stroke='#7b4b22' stroke-width='3.2' stroke-linecap='round' fill='none'/>
      <g class='pv2-arm'><path d='M76 80 L94 64 M88 68 L94 75' stroke='#7b4b22' stroke-width='3.2' stroke-linecap='round' fill='none'/></g>
      <circle cx='50' cy='44' r='21' fill='#f9fbff' stroke='#d3dcec' stroke-width='1.5'/>
      <path d='M30 63 Q50 75 70 63 L72 71 Q50 83 28 71Z' fill='#d62839'/><path d='M62 71 L70 94 L59 96 L55 76Z' fill='#b3162a'/>
      <circle cx='50' cy='86' r='2.6' fill='#333'/><circle cx='50' cy='97' r='2.6' fill='#333'/>
      <rect x='36' y='10' width='28' height='20' rx='3' fill='#25252f'/><rect x='29' y='27' width='42' height='6' rx='3' fill='#25252f'/><rect x='36' y='22' width='28' height='4' fill='#d62839'/>
      <g class='pv2-eyes'><circle class='pv2-eye' cx='43' cy='42' r='2.7' fill='#222'/><circle class='pv2-eye' cx='57' cy='42' r='2.7' fill='#222'/></g>
      <path d='M50 46 L69 50.5 L50 53Z' fill='#ff8a2b'/>
      <circle cx='39' cy='57' r='1.6' fill='#222'/><circle cx='44' cy='59.5' r='1.6' fill='#222'/><circle cx='50' cy='60.5' r='1.6' fill='#222'/><circle cx='56' cy='59.5' r='1.6' fill='#222'/><circle cx='61' cy='57' r='1.6' fill='#222'/>
      ${cheeks(51, 17, '#ff8fa3')}`),
    elf: () => wrapM(`${feet('#8a2b2b')}
      <path d='M24 108 Q22 68 50 62 Q78 68 76 108Z' fill='#2f9e5a'/>${shine(38, 84, 6, 16)}
      <rect x='25' y='88' width='50' height='6' fill='#5b3a1a'/><rect x='44' y='86' width='12' height='10' rx='2' fill='#f2c230'/>
      <path d='M30 64 L36 72 L42 64 L48 72 L54 64 L60 72 L66 64 L70 66 L62 76 L38 76 L30 66Z' fill='#fff' opacity='.9'/>
      ${armL('#2f9e5a', 25, 80)}
      <g class='pv2-arm'><ellipse cx='75' cy='80' rx='7' ry='13' fill='#2f9e5a' transform='rotate(-20 75 80)'/><circle cx='80' cy='70' r='4.5' fill='#ffd7b8'/><path d='M82 68 L82 50 C82 40 96 40 96 49' stroke='#fff' stroke-width='4' fill='none' stroke-linecap='round'/><path d='M82 68 L82 50 C82 40 96 40 96 49' stroke='#d62839' stroke-width='4' fill='none' stroke-linecap='round' stroke-dasharray='3 4'/></g>
      <path d='M32 42 L12 32 L31 54Z' fill='#ffd7b8'/><path d='M68 42 L88 32 L69 54Z' fill='#ffd7b8'/>
      <circle cx='50' cy='44' r='20' fill='#ffd7b8'/>
      <path d='M30 38 Q44 8 82 14 Q62 18 70 38Z' fill='#2f9e5a'/><path d='M30 38 Q50 46 70 38 L70 31 Q50 39 30 31Z' fill='#d62839'/><circle cx='83' cy='14' r='5.5' fill='#f2c230' stroke='#b88a00' stroke-width='1.2'/>
      ${eyes(46, 8)}${mouth(53)}${cheeks(52, 14)}`),
    // ---- ANO NOVO ----
    clock: () => {
      let ticks = '';
      for (let i = 0; i < 12; i++) { const a = i * 0.5236; ticks += `<line x1='${50 + Math.sin(a) * 28}' y1='${68 - Math.cos(a) * 28}' x2='${50 + Math.sin(a) * 32}' y2='${68 - Math.cos(a) * 32}' stroke='#b9902a' stroke-width='${i % 3 ? 1.6 : 3}' stroke-linecap='round'/>`; }
      return wrapM(`${feet('#3b4fb8')}
      ${armL('#ffd54a', 12, 76)}
      <g class='pv2-arm'><ellipse cx='88' cy='76' rx='7' ry='13' fill='#ffd54a' transform='rotate(-20 88 76)'/><rect x='88' y='56' width='4' height='18' rx='2' fill='#c8c8d8'/><path d='M90 56 Q96 50 92 44 Q98 48 94 54' stroke='#ff2e93' stroke-width='3' fill='none' stroke-linecap='round'/></g>
      <circle cx='50' cy='70' r='40' fill='#ffd54a' stroke='#c99a1d' stroke-width='3'/><circle cx='50' cy='70' r='33' fill='#fffbe8'/>${ticks}
      <path d='M50 46 L50 58 M50 58 L58 52' stroke='${INK}' stroke-width='2.6' stroke-linecap='round' fill='none'/>
      ${eyes(68, 10)}${mouth(78)}${cheeks(76, 18)}
      <path d='M33 34 L50 0 L67 34Z' fill='#3b4fb8'/><path d='M38 24 L62 24 M42 14 L58 14' stroke='#ffd54a' stroke-width='3' stroke-dasharray='5 4'/><circle cx='50' cy='3' r='5.5' fill='#fff' stroke='#ddd'/>
      <ellipse cx='50' cy='34' rx='20' ry='3.5' fill='#2b3a8f'/>`);
    },
    gold: () => wrapM(`${feet('#b9902a')}
      <ellipse cx='50' cy='80' rx='27' ry='30' fill='#ffd54a'/>${shine(38, 70, 7, 15)}
      ${armL('#ffd54a', 23, 80)}
      <g class='pv2-arm'><ellipse cx='77' cy='80' rx='7' ry='13' fill='#ffd54a' transform='rotate(-20 77 80)'/><path d='M84 60 L96 60 L94 70 Q90 76 86 70Z' fill='#fff' fill-opacity='.8' stroke='#ddd'/><rect x='89' y='70' width='2' height='8' fill='#ddd'/><circle cx='88' cy='52' r='2' fill='#fff'/><circle cx='93' cy='48' r='1.5' fill='#fff'/></g>
      <circle cx='50' cy='42' r='22' fill='#ffd54a'/>${shine(41, 33, 6, 10)}
      <path d='M30 30 Q50 38 70 30' stroke='#c99a1d' stroke-width='0' fill='none'/>
      <rect x='34' y='4' width='32' height='24' rx='4' fill='#25252f'/><rect x='24' y='25' width='52' height='6' rx='3' fill='#25252f'/><rect x='34' y='20' width='32' height='4' fill='#f0b429'/>
      ${eyes(42, 8)}<circle cx='58' cy='42' r='7' fill='none' stroke='#555' stroke-width='1.6'/>${mouth(51)}${cheeks(50, 14, '#ff8f6b')}
      <path d='M40 66 L50 71 L60 66 L60 76 L50 71 L40 76Z' fill='#d62839'/><circle cx='50' cy='71' r='3' fill='#b3162a'/>`),
    // ---- CARNAVAL ----
    folia: () => wrapM(`${feet('#4b1f8a')}
      <ellipse cx='50' cy='80' rx='27' ry='30' fill='#7b2cff'/>${shine(38, 70, 7, 15)}
      <path d='M26 70 Q50 82 74 70' stroke='#ffd600' stroke-width='3' fill='none'/><circle cx='36' cy='88' r='2' fill='#ffd600'/><circle cx='50' cy='94' r='2' fill='#00e676'/><circle cx='64' cy='88' r='2' fill='#ff2e93'/>
      ${armL('#7b2cff', 23, 80)}<g class='pv2-armL' style='display:none'></g>
      <g class='pv2-arm'><ellipse cx='77' cy='80' rx='7' ry='13' fill='#7b2cff' transform='rotate(-20 77 80)'/><rect x='84' y='56' width='3' height='22' rx='1.5' fill='#8a5a2e'/><circle cx='85.5' cy='50' r='7' fill='#ff2e93' stroke='#ffd600' stroke-width='2'/><circle cx='83' cy='48' r='1.4' fill='#fff'/><circle cx='88' cy='52' r='1.4' fill='#fff'/></g>
      <circle cx='50' cy='42' r='22' fill='#ffd7b8'/>
      <path d='M24 40 C24 30 40 29 50 34 C60 29 76 30 76 40 C76 50 64 53 59 46 C55 42 45 42 41 46 C36 53 24 50 24 40Z' fill='#ff2e93' stroke='#ffd600' stroke-width='2.2'/>
      <ellipse cx='41' cy='41' rx='5' ry='3.6' fill='#1a0a26'/><ellipse cx='59' cy='41' rx='5' ry='3.6' fill='#1a0a26'/><g class='pv2-eyes'><circle class='pv2-eye' cx='41' cy='41' r='1.8' fill='#fff'/><circle class='pv2-eye' cx='59' cy='41' r='1.8' fill='#fff'/></g>
      ${mouth(54)}${cheeks(52, 15)}
      <path d='M60 18 C66 -2 84 -2 80 16Z' fill='#00e676'/><path d='M50 16 C52 -6 70 -8 70 14Z' fill='#ffd600'/><path d='M40 18 C36 -2 54 -8 58 14Z' fill='#2979ff'/><path d='M34 24 Q50 14 66 24 L64 28 Q50 20 36 28Z' fill='#ff2e93'/>`),
    passista: () => wrapM(`${feet('#c2185b')}
      <ellipse cx='50' cy='80' rx='27' ry='30' fill='#ff2e93'/>${shine(38, 70, 7, 15)}
      <path d='M24 74 Q50 90 76 74 L80 96 Q50 108 20 96Z' fill='#ffd600' opacity='.9'/><circle cx='34' cy='88' r='2.4' fill='#fff'/><circle cx='50' cy='94' r='2.4' fill='#fff'/><circle cx='66' cy='88' r='2.4' fill='#fff'/>
      ${armL('#ff2e93', 23, 80)}
      <g class='pv2-arm'><ellipse cx='77' cy='80' rx='7' ry='13' fill='#ff2e93' transform='rotate(-20 77 80)'/><path d='M84 62 L98 48 M84 62 L100 56 M84 62 L96 66' stroke='#00e676' stroke-width='3' stroke-linecap='round'/></g>
      <path d='M50 -2 L30 34 L70 34Z' fill='none'/>
      <g transform='translate(50 28)'><path d='M0 0 L-38 -8 L-26 -24Z' fill='#2979ff'/><path d='M0 0 L-24 -28 L-8 -34Z' fill='#00e676'/><path d='M0 0 L-4 -34 L10 -32Z' fill='#ffd600'/><path d='M0 0 L12 -32 L26 -26Z' fill='#ff6d00'/><path d='M0 0 L28 -24 L38 -8Z' fill='#b44bff'/></g>
      <circle cx='50' cy='44' r='21' fill='#ffd7b8'/>
      ${eyes(44, 8)}${mouth(52)}${cheeks(51, 14)}
      <circle cx='50' cy='24' r='5' fill='#ffd600'/>`),
    // ---- PÁSCOA ----
    coelho: () => wrapM(`${feet('#f1e9ff')}
      <ellipse cx='50' cy='82' rx='27' ry='28' fill='#fff' stroke='#e6dff2' stroke-width='1.8'/>
      <circle cx='22' cy='96' r='8' fill='#fff' stroke='#e6dff2' stroke-width='1.8'/>
      ${armL('#fff', 25, 80)}
      <g class='pv2-arm'><ellipse cx='75' cy='80' rx='7' ry='13' fill='#fff' stroke='#e6dff2' stroke-width='1.5' transform='rotate(-20 75 80)'/><g transform='translate(88 62)'><path d='M0 -14 C8 -14 12 -2 11 4 C10 10 -10 10 -11 4 C-12 -2 -8 -14 0 -14Z' fill='#b388ff'/><path d='M-11 -2 L-6 -6 L-1 -2 L4 -6 L9 -2 L11 0 L11 3 L9 1 L4 -3 L-1 1 L-6 -3 L-11 1Z' fill='#fff'/></g></g>
      <path d='M32 28 C20 -6 26 -14 36 -12 C46 -10 46 14 44 26Z' fill='#fff' stroke='#e6dff2' stroke-width='1.8'/><path d='M35 22 C28 6 30 -4 35 -4 C40 -4 40 8 40 20Z' fill='#ffb3d1'/>
      <path d='M68 28 C80 -6 74 -14 64 -12 C54 -10 54 14 56 26Z' fill='#fff' stroke='#e6dff2' stroke-width='1.8'/><path d='M65 22 C72 6 70 -4 65 -4 C60 -4 60 8 60 20Z' fill='#ffb3d1'/>
      <circle cx='50' cy='44' r='21' fill='#fff' stroke='#e6dff2' stroke-width='1.8'/>
      ${eyes(42, 8)}<ellipse cx='50' cy='49' rx='3' ry='2.2' fill='#ff8fb0'/><path d='M50 51 L50 54 M44 54 Q50 59 56 54' stroke='#d96b92' stroke-width='1.8' fill='none' stroke-linecap='round'/>${cheeks(49, 15)}
      <path d='M41 50 L31 49 M41 52 L31 54 M59 50 L69 49 M59 52 L69 54' stroke='#d7cfe6' stroke-width='1.2'/>`),
    pintinho: () => wrapM(`<ellipse cx='36' cy='111' rx='10' ry='4' fill='#ff9d2e'/><ellipse cx='64' cy='111' rx='10' ry='4' fill='#ff9d2e'/>
      <path d='M40 104 L40 111 M60 104 L60 111' stroke='#ff9d2e' stroke-width='4' stroke-linecap='round'/>
      <ellipse cx='50' cy='80' rx='28' ry='28' fill='#ffd84a'/>${shine(38, 70, 7, 14)}
      <path d='M22 92 Q36 106 50 108 Q64 106 78 92 L82 100 L74 106 L66 100 L58 108 L50 100 L42 108 L34 100 L26 106 L18 100Z' fill='#fff' stroke='#eee'/>
      ${armL('#ffd84a', 22, 74)}<g class='pv2-arm'><ellipse cx='78' cy='74' rx='8' ry='13' fill='#ffc933' transform='rotate(-26 78 74)'/></g>
      <circle cx='50' cy='44' r='22' fill='#ffd84a'/>${shine(41, 34, 6, 10)}
      <path d='M28 36 L33 26 L38 34 L44 22 L50 34 L56 22 L62 34 L67 26 L72 36 Q50 18 28 36Z' fill='#fff' stroke='#eee' stroke-width='1.2'/>
      <path d='M44 46 L56 46 L50 56Z' fill='#ff9d2e'/>
      ${eyes(40, 9)}${cheeks(50, 17, '#ff8f6b')}
      <path d='M46 8 Q50 0 54 8' stroke='#ffd84a' stroke-width='3' fill='none' stroke-linecap='round'/>`),
    // ---- NAMORADOS / CRIANÇAS ----
    cupido: () => wrapM(`${feet('#ffb3c6')}
      <g class='pv2-wings'><path d='M24 62 C6 40 -6 56 10 76 C16 82 22 80 26 76Z' fill='#fff' stroke='#ffd0dc' stroke-width='1.5'/><path d='M76 62 C94 40 106 56 90 76 C84 82 78 80 74 76Z' fill='#fff' stroke='#ffd0dc' stroke-width='1.5'/></g>
      <ellipse cx='50' cy='82' rx='26' ry='27' fill='#ffcfdc'/>${shine(39, 72, 7, 14)}
      <path d='M30 100 Q50 108 70 100 L66 108 Q50 112 34 108Z' fill='#fff' opacity='.9'/>
      ${armL('#ffcfdc', 25, 80)}
      <g class='pv2-arm'><ellipse cx='75' cy='80' rx='7' ry='13' fill='#ffcfdc' transform='rotate(-20 75 80)'/><path d='M86 50 Q98 66 86 84' stroke='#8a5a2e' stroke-width='3' fill='none' stroke-linecap='round'/><path d='M86 50 L86 84' stroke='#fff' stroke-width='1' opacity='.8'/><path d='M70 67 L96 67' stroke='#e6c35c' stroke-width='2'/><path transform='translate(94 61) scale(.28)' d='M15 30 C3 21 1 14 1 10 C1 4 5 1 9 1 C12 1 14 2.5 15 5 C16 2.5 18 1 21 1 C25 1 29 4 29 10 C29 14 27 21 15 30Z' fill='#ff4d79'/></g>
      <circle cx='50' cy='44' r='21' fill='#ffd9c4'/>
      <path d='M30 40 C28 22 44 14 54 18 C64 14 74 24 70 40 C66 30 58 28 50 30 C42 28 34 30 30 40Z' fill='#d49a5a'/><circle cx='34' cy='26' r='5' fill='#d49a5a'/><circle cx='66' cy='26' r='5' fill='#d49a5a'/>
      <ellipse cx='50' cy='10' rx='13' ry='3.2' fill='none' stroke='#ffd54a' stroke-width='2.6'/>
      ${eyes(45, 8)}${mouth(52)}${cheeks(51, 14)}`),
    ursinho: () => wrapM(`${feet('#6b4a2e')}
      <ellipse cx='50' cy='82' rx='27' ry='28' fill='#b07a4a'/><ellipse cx='50' cy='88' rx='16' ry='17' fill='#e2bd92'/>${shine(38, 72, 7, 14)}
      ${armL('#b07a4a', 24, 80)}
      <g class='pv2-arm'><ellipse cx='76' cy='80' rx='7.5' ry='13' fill='#b07a4a' transform='rotate(-20 76 80)'/>{HELD}</g>
      <circle cx='29' cy='26' r='9' fill='#b07a4a'/><circle cx='29' cy='26' r='5' fill='#e2bd92'/><circle cx='71' cy='26' r='9' fill='#b07a4a'/><circle cx='71' cy='26' r='5' fill='#e2bd92'/>
      <circle cx='50' cy='44' r='23' fill='#b07a4a'/>${shine(40, 34, 6, 10)}
      <ellipse cx='50' cy='52' rx='11' ry='8.5' fill='#e2bd92'/><ellipse cx='50' cy='48.5' rx='4.2' ry='3' fill='${INK}'/>
      ${eyes(40, 9)}<path d='M45 56 Q50 60 55 56' stroke='${INK}' stroke-width='2' fill='none' stroke-linecap='round'/>{HAT}`),
    robo: () => wrapM(`<rect x='26' y='104' width='18' height='8' rx='3' fill='#34425a'/><rect x='56' y='104' width='18' height='8' rx='3' fill='#34425a'/>
      <rect x='24' y='56' width='52' height='50' rx='12' fill='#4f9dff' stroke='#2f6fd0' stroke-width='2'/>${shine(36, 70, 5, 14)}
      <circle cx='50' cy='84' r='9' fill='#fff' opacity='.9'/><circle cx='50' cy='84' r='5' fill='#ffb300'/><path d='M50 74 L50 78 M50 90 L50 94 M40 84 L44 84 M56 84 L60 84' stroke='#ffb300' stroke-width='2.4' stroke-linecap='round'/>
      <g class='pv2-armL'><rect x='10' y='64' width='11' height='28' rx='5.5' fill='#7aa7e0'/><circle cx='15.5' cy='94' r='5' fill='#34425a'/></g>
      <g class='pv2-arm'><rect x='80' y='60' width='11' height='28' rx='5.5' fill='#7aa7e0'/><circle cx='85.5' cy='60' r='5' fill='#34425a'/></g>
      <rect x='28' y='14' width='44' height='40' rx='11' fill='#6fb3ff' stroke='#2f6fd0' stroke-width='2'/>
      <rect x='33' y='20' width='34' height='26' rx='8' fill='#10202f'/>
      <g class='pv2-eyes'><rect class='pv2-eye' x='38' y='27' width='7' height='9' rx='3' fill='#5ef2ff'/><rect class='pv2-eye' x='55' y='27' width='7' height='9' rx='3' fill='#5ef2ff'/></g>
      <path d='M42 40 Q50 45 58 40' stroke='#5ef2ff' stroke-width='2' fill='none' stroke-linecap='round'/>
      <path d='M50 14 L50 4' stroke='#34425a' stroke-width='3'/><circle cx='50' cy='3' r='4.4' fill='#ff4d4d' class='pv2-nose'/>`),
  };
  // o ursinho muda de acessório por data (coração nos Namorados, balão + boné nas Crianças)
  const URSO = {
    namorados: {
      held: `<path transform='translate(70 56) scale(.85)' d='M15 30 C3 21 1 14 1 10 C1 4 5 1 9 1 C12 1 14 2.5 15 5 C16 2.5 18 1 21 1 C25 1 29 4 29 10 C29 14 27 21 15 30Z' fill='#ff4d79' stroke='#fff' stroke-opacity='.6'/>`,
      hat: `<path d='M38 22 L50 8 L62 22Z' fill='#ff4d79'/><circle cx='50' cy='7' r='3.4' fill='#fff'/>`,
    },
    criancas: {
      held: `<path d='M88 64 Q96 50 92 36' stroke='#ddd' stroke-width='1.2' fill='none'/><ellipse cx='92' cy='24' rx='9' ry='11.5' fill='#ff7043'/><ellipse cx='89' cy='20' rx='2.4' ry='4' fill='#fff' opacity='.5' transform='rotate(-25 89 20)'/>`,
      hat: `<path d='M33 26 C33 8 67 8 67 26Z' fill='#22b8f0'/><path d='M50 12 C42 12 36 16 34 26 L50 26Z' fill='#ff7043'/><path d='M50 12 C58 12 64 16 66 26 L50 26Z' fill='#ffee58'/><circle cx='50' cy='9' r='3.2' fill='#fff'/><rect x='49' y='1' width='2' height='6' fill='#555'/><path d='M50 1 C42 -1 36 2 35 5 M50 1 C58 -1 64 2 65 5' stroke='#e8e8e8' stroke-width='2.4' stroke-linecap='round' fill='none'/>`,
    },
  };
  function mascotMarkup(variant, decorKey) {
    if (variant === 'ursinho') {
      const u = URSO[decorKey] || URSO.criancas;
      return MASCOTS.ursinho().replace('{HELD}', u.held).replace('{HAT}', u.hat);
    }
    return MASCOTS[variant]();
  }

  // ---------------------------------------------------------------------
  // ITENS COLETÁVEIS (viewBox 0 0 32 32)
  // ---------------------------------------------------------------------
  const ITEMS = {
    gift: `<svg ${NSV} viewBox='0 0 32 32'><rect x='4' y='13' width='24' height='16' rx='2.5' fill='#d62839'/><rect x='4' y='13' width='24' height='5' fill='#000' opacity='.15'/><rect x='14' y='13' width='4' height='16' fill='#ffe08a'/><rect x='4' y='19' width='24' height='3.5' fill='#ffe08a'/><path d='M16 13 C10 1 3 10 16 13 C29 10 22 1 16 13Z' fill='#ffe08a' stroke='#d9a82e' stroke-width='.8'/></svg>`,
    star: `<svg ${NSV} viewBox='0 0 32 32'><path d='M16 2 L20 12 L30 12.6 L22.2 19 L24.8 29 L16 23.4 L7.2 29 L9.8 19 L2 12.6 L12 12Z' fill='#ffd54a' stroke='#fff' stroke-width='1.4' stroke-linejoin='round'/><path d='M16 7 L17.6 13 L16 15 L14.4 13Z' fill='#fff' opacity='.6'/></svg>`,
    popper: `<svg ${NSV} viewBox='0 0 32 32'><path d='M3 29 L11 8 L24 21Z' fill='#ff2e93'/><path d='M7 20 L15 23 M9 14 L19 18' stroke='#ffd600' stroke-width='2.4'/><circle cx='20' cy='6' r='2' fill='#00e676'/><circle cx='27' cy='11' r='2' fill='#2979ff'/><rect x='23' y='3' width='4' height='2' fill='#ffd600' transform='rotate(30 25 4)'/><path d='M16 4 Q19 9 24 8' stroke='#b44bff' stroke-width='1.6' fill='none'/></svg>`,
    egg: `<svg ${NSV} viewBox='0 0 32 32'><defs><clipPath id='ie'><path d='M16 2 C24 2 28 16 26 22 C24 29 8 29 6 22 C4 16 8 2 16 2Z'/></clipPath></defs><path d='M16 2 C24 2 28 16 26 22 C24 29 8 29 6 22 C4 16 8 2 16 2Z' fill='#b388ff'/><g clip-path='url(#ie)'><path d='M0 15 L5 11 L10 15 L16 11 L22 15 L27 11 L32 15 L32 19 L27 15 L22 19 L16 15 L10 19 L5 15 L0 19Z' fill='#fff' opacity='.85'/><circle cx='11' cy='24' r='1.8' fill='#fff' opacity='.85'/><circle cx='21' cy='24' r='1.8' fill='#fff' opacity='.85'/><ellipse cx='11' cy='9' rx='2.4' ry='4.6' fill='#fff' opacity='.4' transform='rotate(18 11 9)'/></g></svg>`,
    heart: `<svg ${NSV} viewBox='0 0 32 32'><path d='M16 29 C3 20 2 13 2 10 C2 5 6 3 9 3 C12 3 15 5 16 8 C17 5 20 3 23 3 C26 3 30 5 30 10 C30 13 29 20 16 29Z' fill='#ff4d79' stroke='#fff' stroke-opacity='.6' stroke-width='1.2'/><path d='M8 10 Q9 6 13 6' stroke='#fff' stroke-opacity='.8' stroke-width='2.4' fill='none' stroke-linecap='round'/></svg>`,
    candy: `<svg ${NSV} viewBox='0 0 32 32'><path d='M2 9 L9 16 L2 23Z' fill='#ffd1e1'/><path d='M30 9 L23 16 L30 23Z' fill='#ffd1e1'/><circle cx='16' cy='16' r='9' fill='#ff6d9a'/><path d='M10 12 Q16 8 22 12 M9 17 Q16 13 23 17 M10 22 Q16 18 22 22' stroke='#fff' stroke-width='2' fill='none' opacity='.85'/><ellipse cx='12' cy='11' rx='2.6' ry='1.6' fill='#fff' opacity='.5' transform='rotate(-30 12 11)'/></svg>`,
  };

  // ---------------------------------------------------------------------
  // CONTEÚDO DE CADA DATA: personagens, falas, perguntas e reações
  // ---------------------------------------------------------------------
  const THEMES = {
    natal: {
      variants: ['santa', 'snowman', 'elf'], names: { santa: 'Papai Noel', snowman: 'Boneco de Neve', elf: 'Duende' },
      item: 'gift', itemName: 'presentes', spark: ['#ffd54a', '#ffffff', '#ff6b6b'],
      lines: ['Ho ho ho! Feliz Natal, {n}!', 'Já escreveu sua cartinha pro Papai Noel?', 'Este servidor está na lista dos bonzinhos!', 'Olha os presentes caindo! Clica neles!', 'Quem joga em equipe ganha presente em dobro!', 'Cuidado com a neve nos servidores, {n}!'],
      react: ['Ho ho ho!', 'Presente pra você!', 'Feliz Natal!'],
      quiz: [
        { q: 'Qual presente você quer ganhar, {n}?', a: [['Uma skin rara', 'Anotado! Vou pedir pros duendes.'], ['Mais FPS', 'Ho ho ho! Esse eu entrego de graça.'], ['Um parceiro de jogo', 'Boa! Chame alguém pro seu servidor.']] },
        { q: 'Você foi bonzinho este ano?', a: [['Muito!', 'Então vem presente por aí!'], ['Mais ou menos...', 'Ho ho ho, vou fingir que não vi.'], ['Joguei sem lag, conta?', 'Conta sim! Parabéns.']] },
        { q: 'Qual seu enfeite de Natal favorito?', a: [['Pisca-pisca', 'Clássico! Está piscando lá em cima.'], ['Árvore', 'Linda! Fico de olho nos presentes.'], ['Bengala doce', 'Docinho! Me dá um pedaço?']] },
      ],
    },
    'ano-novo': {
      variants: ['clock', 'gold'], names: { clock: 'Relógio Festeiro', gold: 'Sr. Dourado' },
      item: 'star', itemName: 'estrelas', spark: ['#ffd54a', '#ffffff', '#6bc5ff'],
      lines: ['Falta pouco pro ano novo, {n}!', 'Qual sua meta de jogos pro próximo ano?', 'Clique em qualquer lugar: eu lanço um fogo!', 'Feliz Ano Novo antecipado!', 'Pega as estrelas da sorte!'],
      react: ['Tin tin! Feliz Ano Novo!', 'Bora brindar!', 'Contagem regressiva!'],
      quiz: [
        { q: 'Qual sua meta pro ano novo, {n}?', a: [['Subir de rank', 'Foco! Vamos juntos.'], ['Criar um servidor', 'Ótima ideia, chame a galera.'], ['Jogar mais com amigos', 'Esse é o espírito!']] },
        { q: 'Vai ficar acordado até meia-noite?', a: [['Claro!', 'Então prepare os fogos!'], ['Vou dormir cedo', 'Tudo bem, os fogos esperam.'], ['Vou jogar online', 'Eu te acompanho!']] },
      ],
    },
    carnaval: {
      variants: ['folia', 'passista'], names: { folia: 'Folião', passista: 'Passista' },
      item: 'popper', itemName: 'confetes', spark: ['#ff2e93', '#ffd600', '#00e676', '#2979ff'],
      lines: ['Bora pular carnaval, {n}!', 'Quem quer confete?', 'Alegria é jogar com a galera!', 'Clica em mim que eu solto serpentina!'],
      react: ['Olê olê olá!', 'Vai, vai, vai!', 'É carnaval!'],
      quiz: [
        { q: 'Qual sua fantasia, {n}?', a: [['Pirata', 'Arrr! Bela escolha.'], ['Super-herói', 'Salve o dia!'], ['De gamer mesmo', 'A melhor de todas!']] },
        { q: 'Qual ritmo pra animar?', a: [['Samba', 'Tá animado!'], ['Axé', 'Todo mundo pulando!'], ['Funk', 'Sobe o volume!']] },
      ],
    },
    pascoa: {
      variants: ['coelho', 'pintinho'], names: { coelho: 'Coelhinho', pintinho: 'Pintinho' },
      item: 'egg', itemName: 'ovos', spark: ['#b388ff', '#ff9ec7', '#fff3a0', '#9be7c4'],
      lines: ['Feliz Páscoa, {n}!', 'Achei um ovinho, quer?', 'Pulo de servidor em servidor!', 'Será que tem ovo escondido por aqui?'],
      react: ['Pulinho!', 'Feliz Páscoa!', 'Tem ovo!'],
      quiz: [
        { q: 'Qual seu chocolate favorito, {n}?', a: [['Ao leite', 'Clássico!'], ['Branco', 'Cremoso!'], ['Meio amargo', 'Chique!']] },
        { q: 'Onde você esconderia um ovo?', a: [['Num servidor', 'Esperto!'], ['No chat', 'Rá! Vou procurar.'], ['No inventário', 'Boa, ninguém acha!']] },
      ],
    },
    namorados: {
      variants: ['cupido', 'ursinho'], names: { cupido: 'Cupido', ursinho: 'Ursinho Apaixonado' },
      item: 'heart', itemName: 'corações', spark: ['#ff4d79', '#ffc2d4', '#ffffff'],
      lines: ['Feliz Dia dos Namorados, {n}!', 'Amor é jogar em dupla!', 'Chama seu player 2!', 'Um coração pra você!'],
      react: ['Pow! Flechada!', 'Amorzinho!', 'Que fofo!'],
      quiz: [
        { q: 'Seu player 2 já sabe que você joga, {n}?', a: [['Sim, joga comigo', 'Que fofo!'], ['Ainda não', 'Convida pra um servidor!'], ['Sou solteiro(a), e daí?', 'O amor-próprio também conta!']] },
        { q: 'Qual presente você daria?', a: [['Uma skin', 'Um mimo!'], ['Convite pro servidor', 'Romântico!'], ['Uma cartinha', 'Clássico!']] },
      ],
    },
    criancas: {
      variants: ['ursinho', 'robo'], names: { ursinho: 'Ursinho', robo: 'Robozinho' },
      item: 'candy', itemName: 'doces', spark: ['#22b8f0', '#ff7043', '#ffee58', '#66bb6a'],
      lines: ['Feliz Dia das Crianças, {n}!', 'Quem quer brincar?', 'Todo mundo tem uma criança por dentro!', 'Estoura os balões!'],
      react: ['Brincadeira!', 'Iuhuu!', 'Bora brincar!'],
      quiz: [
        { q: 'Qual seu brinquedo favorito, {n}?', a: [['Carrinho', 'Vrum vrum!'], ['Boneco', 'Legal!'], ['Videogame', 'Claro! Hehe.']] },
        { q: 'Qual desenho você mais gostava?', a: [['De aventura', 'Que épico!'], ['De super-herói', 'Pow!'], ['Todos!', 'Nostalgia total!']] },
      ],
    },
  };

  // ---------------------------------------------------------------------
  // MOTOR DO MASCOTE
  // ---------------------------------------------------------------------
  const L = () => global.PlusV2Live;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const prefs = () => (L() && L().prefs && L().prefs()) || {};
  const inten = () => ({ leve: 1.7, normal: 1, intenso: 0.55 }[prefs().intensity || 'normal'] || 1);
  const rAF = (f) => global.requestAnimationFrame(f);

  let root = null, sprite = null, face = null, speech = null, hud = null;
  let cfgKey = '', cfg = null, variant = '';
  let running = false, raf = 0, lastPerchEl = null, speechTimer = 0, jumpTimer = 0;
  let quizPool = [], drops = [];
  const S = { phase: 'off', x: 0, y: 0, from: null, to: null, t0: 0, dur: 0, next: '', arc: 0, until: 0, perchEl: null, perchUntil: 0, followUntil: 0, lastTrail: 0, lastDrop: 0, quizOpen: false, lastQuiz: 0, dir: 1, w: 92, h: 110, anchor: 0.935 };
  const mouse = { x: 400, y: 300, t: 0 };

  function userName() {
    const p = prefs();
    if (p.name) return p.name;
    try { if (typeof me !== 'undefined' && me && me.username) return me.username; } catch (_) { /* sem login ainda */ }
    return global.PlusV2UserName || 'jogador';
  }
  const fill = (t) => String(t).replace(/\{n\}/g, userName());
  function scoreKey() { return 'pv2_score_' + cfgKey; }
  const memScore = {};
  function getScore() { if (global.__PV2_STAGE) return memScore[cfgKey] || 0; try { return parseInt(global.localStorage.getItem(scoreKey()) || '0', 10) || 0; } catch (_) { return 0; } }
  function setScore(v) { if (global.__PV2_STAGE) { memScore[cfgKey] = v; return; } try { global.localStorage.setItem(scoreKey(), String(v)); } catch (_) { /* sem storage */ } }

  function variantsFor(key) { return THEMES[key] ? THEMES[key].variants.map((v) => ({ value: v, label: THEMES[key].names[v] })) : []; }
  function currentVariant() {
    const chosen = (prefs().variant || {})[cfgKey];
    return cfg.variants.indexOf(chosen) >= 0 ? chosen : cfg.variants[0];
  }

  function spriteMarkup() {
    if (variant === 'santa') {
      return (L().art.sleigh()).replace("class='pv2-art-sleigh'", '');
    }
    return mascotMarkup(variant, cfgKey);
  }

  function build() {
    root = document.createElement('div');
    root.id = 'plus2-mascot-layer';
    variant = currentVariant();
    const small = (global.innerWidth || 1200) < 640;
    const isSleigh = variant === 'santa';
    S.w = isSleigh ? (small ? 150 : 210) : (small ? 74 : 92);
    S.h = isSleigh ? S.w * 0.325 : S.w * 1.2;
    S.anchor = isSleigh ? 0.8 : 0.935;
    sprite = document.createElement('div');
    sprite.className = 'pv2-mascot';
    sprite.style.setProperty('--mw', S.w + 'px');
    face = document.createElement('div');
    face.className = 'pv2-face';
    face.innerHTML = spriteMarkup();
    speech = document.createElement('div');
    speech.className = 'pv2-speech';
    sprite.appendChild(face);
    sprite.appendChild(speech);
    sprite.addEventListener('pointerdown', onSpriteDown);
    root.appendChild(sprite);
    hud = document.createElement('div');
    hud.className = 'pv2-hud';
    root.appendChild(hud);
    document.body.appendChild(root);
    updateHud();
  }

  function place(x, y) {
    S.x = x; S.y = y;
    sprite.style.transform = 'translate3d(' + Math.round(x - S.w / 2) + 'px,' + Math.round(y - S.h * S.anchor) + 'px,0)';
  }
  function setFacing(d) { S.dir = d; face.style.transform = 'scaleX(' + d + ')'; }
  function setMode(m) {
    sprite.classList.remove('fly', 'perch');
    if (m) sprite.classList.add(m);
  }

  // ---------- onde pousar ----------
  const SELS = ['#server-rail-list .server-row', '.sidebar-nav-item', '.home-servers-grid > *', '.home-side-card', '.home-partner-game-card', '.top-navbar .navbar-right > *', '.channel-item', '.home-quick-action', '.explore-card'];
  const SEL_W = [5, 2, 3, 2, 2, 2, 2, 1, 1];
  function candidates() {
    const out = [];
    const vw = global.innerWidth || 1200, vh = global.innerHeight || 800;
    SELS.forEach((sel, idx) => {
      document.querySelectorAll(sel).forEach((el) => {
        if (el.closest && el.closest('#plus2-mascot-layer, #plus2-decor, .modal-overlay')) return;
        const r = el.getBoundingClientRect();
        if (r.width < 34 || r.height < 16 || r.width > 760) return;
        if (r.top < S.h * S.anchor + 56 || r.top > vh - 30 || r.right < 0 || r.left > vw) return;
        for (let k = 0; k < SEL_W[idx]; k++) out.push(el);
      });
    });
    return out;
  }
  function pickPerch() {
    const c = candidates().filter((e) => e !== lastPerchEl);
    return c.length ? pick(c) : null;
  }
  function perchPoint(el) {
    const r = el.getBoundingClientRect();
    const vw = global.innerWidth || 1200;
    return { x: clamp(r.left + r.width / 2, S.w / 2 + 6, vw - S.w / 2 - 6), y: r.top + 3, ok: r.width > 0 && r.height > 0 };
  }

  // ---------- movimento ----------
  const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  function flyTo(to, now, next) {
    S.from = { x: S.x, y: S.y }; S.to = to; S.next = next; S.t0 = now;
    const dist = Math.hypot(to.x - S.x, to.y - S.y);
    S.dur = clamp(dist / 0.55 + 500, 1400, 3600);
    S.arc = Math.min(170, dist * 0.22) + 28;
    S.phase = 'fly';
    setFacing(to.x >= S.x ? 1 : -1);
    setMode('fly');
  }
  function startEnter(now) {
    const vw = global.innerWidth || 1200, vh = global.innerHeight || 800;
    const side = Math.random() < 0.5 ? -1 : 1;
    sprite.classList.add('on');
    place(side < 0 ? -S.w : vw + S.w, rnd(110, vh * 0.45));
    const el = pickPerch();
    if (el) { S.perchEl = el; flyTo(perchPoint(el), now, 'perch'); }
    else flyTo({ x: side < 0 ? vw + S.w + 40 : -S.w - 40, y: rnd(120, vh * 0.5) }, now, 'exit');
  }
  function exitScreen(now) {
    const vw = global.innerWidth || 1200;
    flyTo({ x: S.x < vw / 2 ? -S.w - 50 : vw + S.w + 50, y: Math.max(90, S.y - 140) }, now, 'exit');
  }
  function stepFly(now) {
    const u = clamp((now - S.t0) / S.dur, 0, 1);
    const e = ease(u);
    let tx = S.to.x, ty = S.to.y;
    if (S.next === 'perch' && S.perchEl) { const p = perchPoint(S.perchEl); if (p.ok) { tx = p.x; ty = p.y; S.to = { x: tx, y: ty }; } }
    const x = S.from.x + (tx - S.from.x) * e;
    const y = S.from.y + (ty - S.from.y) * e - Math.sin(Math.PI * u) * S.arc;
    place(x, y);
    if (now - S.lastTrail > 90) { S.lastTrail = now; trail(x, y - S.h * 0.4); }
    if (prefs().drops !== false && now - S.lastDrop > rnd(650, 1150) * inten() && u > 0.08 && u < 0.92) { S.lastDrop = now; dropItem(x, y - S.h * 0.2); }
    if (u >= 1) {
      if (S.next === 'perch') startPerch(now);
      else if (S.next === 'follow') startFollow(now);
      else { S.phase = 'wait'; S.until = now + rnd(16000, 38000) * inten(); sprite.classList.remove('on', 'fly', 'perch'); hideSpeech(); }
    }
  }
  function startPerch(now) {
    S.phase = 'perch'; lastPerchEl = S.perchEl;
    S.perchUntil = now + rnd(5200, 8600);
    setMode('perch');
    const p = prefs();
    if (p.quiz !== false && p.talk !== false && now - S.lastQuiz > 45000 && Math.random() < 0.4) openQuiz(now);
    else if (p.talk !== false && Math.random() < 0.85) say(pick(cfg.lines));
  }
  function stepPerch(now) {
    const p = S.perchEl ? perchPoint(S.perchEl) : { ok: false };
    if (!p.ok || !document.body.contains(S.perchEl)) { depart(now); return; }
    place(S.x + (p.x - S.x) * 0.3, S.y + (p.y - S.y) * 0.3);
    if (S.quizOpen) S.perchUntil = Math.max(S.perchUntil, now + 1500);
    else if (now > S.perchUntil) depart(now);
  }
  function depart(now) {
    hideSpeech();
    const r = Math.random();
    if (r < 0.26 && now - mouse.t < 9000) { flyTo({ x: mouse.x, y: mouse.y + 36 }, now, 'follow'); return; }
    if (r < 0.7) {
      const el = pickPerch();
      if (el) { S.perchEl = el; flyTo(perchPoint(el), now, 'perch'); return; }
    }
    exitScreen(now);
  }
  function startFollow(now) {
    S.phase = 'follow'; S.followUntil = now + 7500; setMode('fly');
    if (prefs().talk !== false) say('Me pega, {n}!', 2400);
  }
  function stepFollow(now) {
    const tx = mouse.x, ty = mouse.y + 38;
    setFacing(tx >= S.x ? 1 : -1);
    place(S.x + (tx - S.x) * 0.07, S.y + (ty - S.y) * 0.07);
    if (now - S.lastTrail > 80) { S.lastTrail = now; trail(S.x, S.y - S.h * 0.4); }
    if (prefs().drops !== false && now - S.lastDrop > 1800 * inten()) { S.lastDrop = now; dropItem(S.x, S.y - S.h * 0.3); }
    if (now > S.followUntil) { hideSpeech(); const el = pickPerch(); if (el && Math.random() < 0.6) { S.perchEl = el; flyTo(perchPoint(el), now, 'perch'); } else exitScreen(now); }
  }

  function loop(t) {
    if (!running) return;
    raf = rAF(loop);
    switch (S.phase) {
      case 'wait': if (t >= S.until) startEnter(t); break;
      case 'fly': stepFly(t); break;
      case 'perch': stepPerch(t); break;
      case 'follow': stepFollow(t); break;
      default: break;
    }
  }

  // ---------- partículas, itens, placar ----------
  function sparkEl(x, y, color, dx, dy, dur, size) {
    if (!root) return;
    const el = document.createElement('i');
    el.className = 'pv2-spark';
    el.style.cssText = 'left:' + x + 'px;top:' + y + 'px;background:' + color + ';box-shadow:0 0 8px ' + color + ';width:' + size + 'px;height:' + size + 'px;';
    root.appendChild(el);
    if (!el.animate) { el.remove(); return; }
    const a = el.animate([{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.2)', opacity: 0 }], { duration: dur, easing: 'ease-out' });
    a.onfinish = () => el.remove();
  }
  function trail(x, y) { sparkEl(x + rnd(-8, 8), y + rnd(-6, 6), pick(cfg.spark), rnd(-26, 26), rnd(8, 34), rnd(500, 900), rnd(4, 8)); }
  function burst(x, y, n) { for (let i = 0; i < n; i++) { const a = rnd(0, 6.283), d = rnd(24, 70); sparkEl(x, y, pick(cfg.spark), Math.cos(a) * d, Math.sin(a) * d, rnd(500, 900), rnd(4, 8)); } }

  function dropItem(x, y) {
    if (!root || drops.length >= 8) return;
    const el = document.createElement('div');
    el.className = 'pv2-drop';
    el.innerHTML = ITEMS[cfg.item];
    el.style.left = Math.round(x - 15) + 'px';
    el.style.top = Math.round(y) + 'px';
    root.appendChild(el);
    drops.push(el);
    const vh = global.innerHeight || 800;
    const endY = vh - 48 - rnd(0, 90), dx = rnd(-70, 70);
    const finish = () => { el.classList.add('landed'); };
    if (el.animate) {
      const a = el.animate([{ transform: 'translate(0,0) rotate(0deg)' }, { transform: 'translate(' + dx + 'px,' + (endY - y) + 'px) rotate(' + Math.round(rnd(-220, 220)) + 'deg)' }], { duration: 900 + Math.max(0, endY - y) * 1.1, easing: 'cubic-bezier(.35,0,.9,.6)', fill: 'forwards' });
      a.onfinish = finish;
    } else finish();
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); collect(el); });
    setTimeout(() => { if (el.parentNode) { el.classList.add('fade'); setTimeout(() => removeDrop(el), 500); } }, 9500);
  }
  function removeDrop(el) { const i = drops.indexOf(el); if (i >= 0) drops.splice(i, 1); el.remove(); }
  function collect(el) {
    const r = el.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2, 9);
    removeDrop(el);
    const total = getScore() + 1;
    setScore(total);
    updateHud(true);
    if (total % 10 === 0) {
      say('Uau, {n}! ' + total + ' ' + cfg.itemName + '!', 3600);
      for (let k = 0; k < 4; k++) setTimeout(() => { if (L() && L().poke) L().poke(rnd(120, (global.innerWidth || 1200) - 120), rnd(120, (global.innerHeight || 800) * 0.6)); burst(rnd(80, (global.innerWidth || 1200) - 80), rnd(100, 400), 14); }, k * 220);
    }
  }
  function updateHud(pulse) {
    if (!hud) return;
    const n = getScore();
    if (!n) { hud.classList.remove('show'); return; }
    hud.innerHTML = '<span class="pv2-hud-ico">' + ITEMS[cfg.item] + '</span><b>' + n + '</b><span class="pv2-hud-name">' + cfg.itemName + '</span>';
    hud.classList.add('show');
    if (pulse) { hud.classList.remove('pulse'); void hud.offsetWidth; hud.classList.add('pulse'); }
  }

  // ---------- falas e perguntas ----------
  function fitSpeech() {
    speech.style.setProperty('--shift', '0px');
    const r = speech.getBoundingClientRect();
    const vw = global.innerWidth || 1200;
    let shift = 0;
    if (r.left < 8) shift = 8 - r.left; else if (r.right > vw - 8) shift = vw - 8 - r.right;
    speech.style.setProperty('--shift', Math.round(shift) + 'px');
  }
  function showSpeech() { speech.classList.add('show'); fitSpeech(); }
  function hideSpeech() { if (!speech) return; speech.classList.remove('show', 'quiz'); clearTimeout(speechTimer); S.quizOpen = false; }
  function say(text, ms) {
    if (!speech || prefs().talk === false) return;
    clearTimeout(speechTimer);
    S.quizOpen = false;
    speech.classList.remove('quiz');
    speech.textContent = fill(text);
    showSpeech();
    speechTimer = setTimeout(hideSpeech, ms || 4400);
  }
  function openQuiz(now) {
    if (!quizPool.length) quizPool = cfg.quiz.slice().sort(() => Math.random() - 0.5);
    const q = quizPool.pop();
    clearTimeout(speechTimer);
    speech.classList.add('quiz');
    speech.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'pv2-q-title';
    title.textContent = fill(q.q);
    speech.appendChild(title);
    q.a.forEach((ans) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pv2-q-btn';
      b.textContent = ans[0];
      b.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
      b.addEventListener('click', (e) => { e.stopPropagation(); answer(ans[1]); });
      speech.appendChild(b);
    });
    S.quizOpen = true; S.lastQuiz = now || performance.now();
    showSpeech();
    speechTimer = setTimeout(hideSpeech, 16000);
  }
  function answer(reaction) {
    S.quizOpen = false;
    speech.classList.remove('quiz');
    clearTimeout(speechTimer);
    speech.textContent = fill(reaction);
    showSpeech();
    speechTimer = setTimeout(hideSpeech, 3600);
    jump();
    celebrate();
  }
  function celebrate() {
    burst(S.x, S.y - S.h * 0.5, 16);
    if (prefs().drops !== false) for (let i = 0; i < 3; i++) setTimeout(() => dropItem(S.x + rnd(-40, 40), S.y - S.h * 0.5), i * 160);
    if (L() && L().poke) L().poke(S.x, S.y - S.h * 0.5);
  }
  function jump() {
    sprite.classList.remove('jump'); void sprite.offsetWidth; sprite.classList.add('jump');
    clearTimeout(jumpTimer); jumpTimer = setTimeout(() => sprite && sprite.classList.remove('jump'), 900);
  }

  // ---------- cliques no mascote ----------
  function onSpriteDown(e) {
    e.stopPropagation();
    if (S.quizOpen) return;
    if (S.phase === 'follow') { say('Você me pegou, {n}!', 2800); jump(); celebrate(); for (let i = 0; i < 3; i++) setTimeout(() => dropItem(S.x + rnd(-50, 50), S.y - S.h * 0.5), i * 120); S.followUntil = 0; return; }
    say(pick(cfg.react), 2400);
    jump();
    celebrate();
  }

  // ---------- ciclo de vida ----------
  function onMove(e) { mouse.x = e.clientX; mouse.y = e.clientY; mouse.t = performance.now(); }
  function stop() {
    running = false; cancelAnimationFrame(raf);
    clearTimeout(speechTimer); clearTimeout(jumpTimer);
    document.removeEventListener('pointermove', onMove);
    if (root) root.remove();
    root = sprite = face = speech = hud = null; drops = []; S.phase = 'off'; S.quizOpen = false;
  }
  function set(key) {
    const p = prefs();
    const mq = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)');
    if (!key || !THEMES[key] || p.mascot === false || (L() && L().state && L().state.performanceMode) || (mq && mq.matches)) { cfgKey = key || ''; stop(); return; }
    if (running && key === cfgKey && variant === currentVariant()) return;
    stop();
    cfgKey = key; cfg = THEMES[key]; quizPool = [];
    build();
    document.addEventListener('pointermove', onMove, { passive: true });
    running = true; S.phase = 'wait'; S.until = performance.now() + 2200; place(-300, -300);
    raf = rAF(loop);
  }
  function summon() {
    if (!running) { if (cfgKey) set(cfgKey); return; }
    const now = performance.now();
    if (S.phase === 'wait') startEnter(now);
    else if (S.phase === 'perch') depart(now);
  }
  function resetScore() { if (cfgKey) { setScore(0); updateHud(); } }

  global.PlusV2Mascot = {
    set, stop, summon, resetScore, variantsFor, refresh: () => { const k = cfgKey; stop(); if (k) set(k); },
    themes: THEMES, active: () => cfgKey,
    preview: (key, v) => (v === 'santa' ? L().art.sleigh().replace("class='pv2-art-sleigh'", '') : mascotMarkup(v, key)),
  };

})(typeof window !== 'undefined' ? window : globalThis);
