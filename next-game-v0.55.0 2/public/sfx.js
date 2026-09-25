

const SFX = (() => {
let ctx = null;
let enabled = localStorage.getItem('ng_sfx_enabled') !== 'off';

function getCtx() {
if (!ctx) {
const AudioCtx = window.AudioContext || window.webkitAudioContext;
if (!AudioCtx) return null;
ctx = new AudioCtx();
}

if (ctx.state === 'suspended') ctx.resume().catch(() => {});
return ctx;
}

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

function playFile(src, volume = 0.35) {
if (!enabled) return;
try {
const audio = new Audio(src);
audio.volume = volume;
audio.play().catch(() => {});
} catch (_) {}
}

return {
isEnabled: () => enabled,
setEnabled(value) {
enabled = value;
localStorage.setItem('ng_sfx_enabled', value ? 'on' : 'off');
},

uiSwitch() {
playFile('/assets/sounds/switch-a.ogg', 0.3);
},
uiTap() {
playFile('/assets/sounds/tap-a.ogg', 0.25);
},

message() {
tone({ freq: 660, endFreq: 880, duration: 0.09, type: 'sine', gain: 0.09 });
},

mention() {
tone({ freq: 660, duration: 0.08, type: 'triangle', gain: 0.13 });
tone({ freq: 880, duration: 0.1, type: 'triangle', gain: 0.13, delay: 0.09 });
},

join() {
tone({ freq: 330, endFreq: 660, duration: 0.16, type: 'sine', gain: 0.13 });
},

leave() {
tone({ freq: 550, endFreq: 260, duration: 0.18, type: 'sine', gain: 0.13 });
},

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

cameraOn() {
noiseBurst({ duration: 0.04, gain: 0.14 });
noiseBurst({ duration: 0.03, gain: 0.1, delay: 0.05 });
},
cameraOff() {
tone({ freq: 420, endFreq: 260, duration: 0.08, type: 'square', gain: 0.08 });
},

screenShareStart() {
tone({ freq: 300, endFreq: 750, duration: 0.22, type: 'sawtooth', gain: 0.06 });
},
screenShareStop() {
tone({ freq: 650, endFreq: 250, duration: 0.16, type: 'sawtooth', gain: 0.06 });
},

click() {
tone({ freq: 700, duration: 0.03, type: 'square', gain: 0.03 });
},

modalOpen() {
tone({ freq: 500, endFreq: 640, duration: 0.06, type: 'sine', gain: 0.05 });
},

wrong() {
tone({ freq: 300, endFreq: 220, duration: 0.16, type: 'sine', gain: 0.09 });
},

streakUp() {
tone({ freq: 523.25, duration: 0.1, type: 'triangle', gain: 0.12 });
tone({ freq: 659.25, duration: 0.14, type: 'triangle', gain: 0.12, delay: 0.09 });
},

rewardUnlock() {
const notes = [523.25, 659.25, 783.99, 1046.5];
notes.forEach((freq, i) => {
tone({ freq, duration: 0.28, type: 'triangle', gain: 0.14, delay: i * 0.09, attack: 0.01 });
});
},
};
})();

['click', 'keydown'].forEach((evt) => {
window.addEventListener(
evt,
() => {
if (SFX.isEnabled()) SFX.message && null;
},
{ once: true, passive: true }
);
});

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
