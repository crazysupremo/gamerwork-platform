

(function (global) {
'use strict';

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

function hexToRgb(hex) {
const clean = String(hex || '#5865f2').replace('#', '');
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

const surfaces = deriveSurfaces(theme.colors.primary);
root.style.setProperty('--bg-app', surfaces.app);
root.style.setProperty('--bg-rail', surfaces.rail);
root.style.setProperty('--bg-sidebar', surfaces.sidebar);
root.style.setProperty('--bg-panel', surfaces.panel);
root.style.setProperty('--bg-modal', surfaces.modal);
}

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

layer.querySelectorAll('canvas').forEach((c) => c.remove());
const wantParticles = !state.performanceMode && (state._bgParticlesRequested || state.effects.particles);
if (wantParticles) {
const canvas = document.createElement('canvas');
canvas.style.cssText = 'width:100%; height:100%; display:block;';
layer.appendChild(canvas);
particleStop = startParticles(canvas);
}
}

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

function applyChatState(chat) {
state.chat = chat;
document.documentElement.style.setProperty('--pv2-live-spacing', (chat.spacing || 16) + 'px');
}

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
