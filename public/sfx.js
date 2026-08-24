// sfx.js - efeitos sonoros e visuais do NEXT GAME
//
// Todos os sons são SINTETIZADOS na hora via Web Audio API (osciladores/ruído
// gerados por código) — não depende de nenhum arquivo de áudio externo, então
// nunca quebra por link morto e não tem questão de direitos autorais.
//
// Uso: SFX.message(), SFX.join(), SFX.rewardUnlock(), etc.
// Ligar/desligar tudo: SFX.setEnabled(true/false) — fica salvo no navegador.

const SFX = (() => {
  let ctx = null;
  let enabled = localStorage.getItem('ng_sfx_enabled') !== 'off'; // ligado por padrão

  function getCtx() {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      ctx = new AudioCtx();
    }
    // Navegadores só liberam áudio depois de alguma interação do usuário —
    // isso é chamado de novo a cada efeito, então destrava assim que possível.
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // Um "beep" com envelope (ataque rápido, decaimento suave) — a peça básica
  // que todos os efeitos combinam pra soar menos robótico que um bipe puro.
  function tone({ freq = 440, endFreq = null, duration = 0.12, type = 'sine', gain = 0.12, delay = 0, attack = 0.005 }) {
    if (!enabled) return;
    const audioCtx = getCtx();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime + delay;
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), t0 + duration);
    gainNode.gain.setValueAtTime(0, t0);
    gainNode.gain.linearRampToValueAtTime(gain, t0 + attack);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gainNode).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  // Rajada de ruído filtrado — usada pro "clique" de câmera (som de obturador).
  function noiseBurst({ duration = 0.05, gain = 0.15, delay = 0, filterFreq = 2500 }) {
    if (!enabled) return;
    const audioCtx = getCtx();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime + delay;
    const bufferSize = Math.floor(audioCtx.sampleRate * duration);
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = filterFreq;
    const gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(gain, t0);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    noise.connect(filter).connect(gainNode).connect(audioCtx.destination);
    noise.start(t0);
    noise.stop(t0 + duration + 0.01);
  }

  return {
    isEnabled: () => enabled,
    setEnabled(value) {
      enabled = value;
      localStorage.setItem('ng_sfx_enabled', value ? 'on' : 'off');
    },

    // Mensagem nova de outra pessoa no chat.
    message() {
      tone({ freq: 660, endFreq: 880, duration: 0.09, type: 'sine', gain: 0.09 });
    },
    // Alguém te mencionou (@usuario) — um pouco mais chamativo.
    mention() {
      tone({ freq: 660, duration: 0.08, type: 'triangle', gain: 0.13 });
      tone({ freq: 880, duration: 0.1, type: 'triangle', gain: 0.13, delay: 0.09 });
    },
    // Entrar numa sala de voz.
    join() {
      tone({ freq: 330, endFreq: 660, duration: 0.16, type: 'sine', gain: 0.13 });
    },
    // Sair de uma sala de voz.
    leave() {
      tone({ freq: 550, endFreq: 260, duration: 0.18, type: 'sine', gain: 0.13 });
    },
    // Alguém entrou/saiu da sala em que você já está (mais discreto que join/leave).
    peerJoin() {
      tone({ freq: 500, endFreq: 700, duration: 0.1, type: 'sine', gain: 0.07 });
    },
    peerLeave() {
      tone({ freq: 500, endFreq: 350, duration: 0.1, type: 'sine', gain: 0.07 });
    },
    mute() {
      tone({ freq: 320, duration: 0.07, type: 'square', gain: 0.08 });
    },
    unmute() {
      tone({ freq: 480, duration: 0.07, type: 'square', gain: 0.08 });
    },
    // Ligar a câmera — "clique" de obturador.
    cameraOn() {
      noiseBurst({ duration: 0.04, gain: 0.14 });
      noiseBurst({ duration: 0.03, gain: 0.1, delay: 0.05 });
    },
    cameraOff() {
      tone({ freq: 420, endFreq: 260, duration: 0.08, type: 'square', gain: 0.08 });
    },
    // Começar a compartilhar a tela.
    screenShareStart() {
      tone({ freq: 300, endFreq: 750, duration: 0.22, type: 'sawtooth', gain: 0.06 });
    },
    screenShareStop() {
      tone({ freq: 650, endFreq: 250, duration: 0.16, type: 'sawtooth', gain: 0.06 });
    },
    // Clique genérico de botão/interface — bem sutil, tipo Discord.
    click() {
      tone({ freq: 700, duration: 0.03, type: 'square', gain: 0.03 });
    },
    // Abrir um modal/painel.
    modalOpen() {
      tone({ freq: 500, endFreq: 640, duration: 0.06, type: 'sine', gain: 0.05 });
    },
    // Resposta errada num quiz de missão — discreto, sem ser desanimador.
    wrong() {
      tone({ freq: 300, endFreq: 220, duration: 0.16, type: 'sine', gain: 0.09 });
    },
    // Sequência subiu um dia — chime curto e positivo.
    streakUp() {
      tone({ freq: 523.25, duration: 0.1, type: 'triangle', gain: 0.12 });
      tone({ freq: 659.25, duration: 0.14, type: 'triangle', gain: 0.12, delay: 0.09 });
    },
    // Desbloqueou uma recompensa nova — arpejo triunfante (acorde maior).
    rewardUnlock() {
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
      notes.forEach((freq, i) => {
        tone({ freq, duration: 0.28, type: 'triangle', gain: 0.14, delay: i * 0.09, attack: 0.01 });
      });
    },
  };
})();

// Destrava o áudio na primeira interação do usuário na página (política dos
// navegadores exige um gesto antes de tocar qualquer som) — e já aproveita
// pra iniciar a música de fundo, se ainda estiver na tela de login.
['click', 'keydown'].forEach((evt) => {
  window.addEventListener(
    evt,
    () => {
      if (SFX.isEnabled()) SFX.message && null; // no-op só pra garantir que o módulo carregou
      const authScreen = document.getElementById('auth-screen');
      if (authScreen && !authScreen.classList.contains('hidden')) {
        MusicEngine.start();
      }
    },
    { once: true, passive: true }
  );
});

// ---------- EFEITOS VISUAIS: confete + toast de celebração ----------

// Chuvinha de confete cobrindo a tela por alguns segundos — usada quando
// desbloqueia uma recompensa nova. Desenha num <canvas> criado na hora, sem
// depender de nenhuma lib externa.
function launchConfetti() {
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti-canvas';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx2d = canvas.getContext('2d');

  const colors = ['#5865f2', '#9146ff', '#00d9c0', '#ffd76b', '#ff3b7a'];
  const pieces = Array.from({ length: 90 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.3,
    size: 5 + Math.random() * 6,
    color: colors[Math.floor(Math.random() * colors.length)],
    speedY: 2 + Math.random() * 3,
    speedX: -1.5 + Math.random() * 3,
    rotation: Math.random() * 360,
    rotationSpeed: -8 + Math.random() * 16,
  }));

  const start = performance.now();
  const durationMs = 3200;

  function frame(now) {
    const elapsed = now - start;
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    pieces.forEach((p) => {
      p.x += p.speedX;
      p.y += p.speedY;
      p.rotation += p.rotationSpeed;
      ctx2d.save();
      ctx2d.translate(p.x, p.y);
      ctx2d.rotate((p.rotation * Math.PI) / 180);
      ctx2d.fillStyle = p.color;
      ctx2d.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx2d.restore();
    });
    if (elapsed < durationMs) {
      requestAnimationFrame(frame);
    } else {
      canvas.remove();
    }
  }
  requestAnimationFrame(frame);
}

// Toast no topo da tela avisando de uma recompensa nova desbloqueada.
function showRewardToast(reward) {
  const toast = document.createElement('div');
  toast.className = 'reward-toast' + (reward.rare ? ' reward-toast-rare' : '');
  toast.innerHTML = `
    <span class="reward-toast-icon">${reward.rare ? '⭐' : '🎁'}</span>
    <div class="reward-toast-text">
      <strong>Recompensa desbloqueada!</strong>
      <span>${reward.name}</span>
    </div>
  `;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('reward-toast-show'));
  setTimeout(() => {
    toast.classList.remove('reward-toast-show');
    setTimeout(() => toast.remove(), 400);
  }, 4200);
}

// Dispara som + confete + toast pra cada recompensa que acabou de ser
// desbloqueada (comparando com o que já tinha sido "visto" antes, guardado
// no navegador — assim só celebra recompensas realmente novas).
function celebrateNewRewards(rewardsData, userId) {
  if (!rewardsData || !rewardsData.rewards) return;
  const storageKey = 'ng_seen_rewards_' + userId;
  let seen = [];
  try {
    seen = JSON.parse(localStorage.getItem(storageKey) || '[]');
  } catch (_) {
    seen = [];
  }
  const unlockedNow = rewardsData.rewards.filter((r) => r.unlocked);
  const newOnes = unlockedNow.filter((r) => !seen.includes(r.key));

  if (newOnes.length > 0) {
    newOnes.forEach((reward, i) => {
      setTimeout(() => {
        SFX.rewardUnlock();
        launchConfetti();
        showRewardToast(reward);
      }, i * 600);
    });
  }
  localStorage.setItem(storageKey, JSON.stringify(unlockedNow.map((r) => r.key)));
}

// ---------- MÚSICA DE FUNDO (tela de login) ----------
// Faixa animada tocando em loop, composta na hora via Web Audio (mesmo
// princípio do resto do sfx.js — sem arquivo de música, sem direitos
// autorais). Progressão Am-F-C-G com baixo, arpejo, kick e hi-hat, 128 BPM.
const MusicEngine = (() => {
  let ctx = null;
  let masterGain = null;
  let playing = false;
  let nextNoteTime = 0;
  let schedulerId = null;
  let current16th = 0;
  let musicEnabled = localStorage.getItem('ng_login_music') !== 'off'; // ligado por padrão

  const bpm = 128;
  const secondsPer16th = 60 / bpm / 4;

  const progression = [
    { bass: 110.0, chord: [220.0, 261.63, 329.63] }, // Am
    { bass: 87.31, chord: [174.61, 220.0, 261.63] }, // F
    { bass: 130.81, chord: [261.63, 329.63, 392.0] }, // C
    { bass: 98.0, chord: [196.0, 246.94, 293.66] }, // G
  ];

  function getCtx() {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      ctx = new AudioCtx();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.16;
      masterGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function playNote(freq, time, duration, type, gain) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(gain, time + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    osc.connect(g).connect(masterGain);
    osc.start(time);
    osc.stop(time + duration + 0.02);
  }

  function playKick(time) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, time);
    osc.frequency.exponentialRampToValueAtTime(40, time + 0.12);
    g.gain.setValueAtTime(0.45, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.15);
    osc.connect(g).connect(masterGain);
    osc.start(time);
    osc.stop(time + 0.16);
  }

  function playHat(time) {
    const bufferSize = Math.floor(ctx.sampleRate * 0.03);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.1, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.03);
    noise.connect(filter).connect(g).connect(masterGain);
    noise.start(time);
    noise.stop(time + 0.04);
  }

  function scheduleStep(step, time) {
    const barIndex = Math.floor(step / 16) % progression.length;
    const { bass, chord } = progression[barIndex];
    const beatInBar = step % 16;

    if (beatInBar % 4 === 0) playNote(bass, time, secondsPer16th * 3.5, 'sawtooth', 0.2);
    const arpPattern = [0, 1, 2, 1];
    playNote(chord[arpPattern[beatInBar % 4]], time, secondsPer16th * 0.9, 'triangle', 0.09);
    if (beatInBar === 0 || beatInBar === 8) playKick(time);
    if (beatInBar % 2 === 1) playHat(time);
  }

  function scheduler() {
    if (!ctx) return;
    while (nextNoteTime < ctx.currentTime + 0.12) {
      scheduleStep(current16th, nextNoteTime);
      nextNoteTime += secondsPer16th;
      current16th++;
    }
    schedulerId = setTimeout(scheduler, 25);
  }

  return {
    isEnabled: () => musicEnabled,
    isPlaying: () => playing,
    setEnabled(value) {
      musicEnabled = value;
      localStorage.setItem('ng_login_music', value ? 'on' : 'off');
      if (value) this.start();
      else this.stop();
    },
    start() {
      if (playing || !musicEnabled) return;
      const audioCtx = getCtx();
      if (!audioCtx) return;
      playing = true;
      current16th = 0;
      nextNoteTime = audioCtx.currentTime + 0.1;
      scheduler();
    },
    stop() {
      playing = false;
      if (schedulerId) clearTimeout(schedulerId);
      schedulerId = null;
    },
  };
})();
