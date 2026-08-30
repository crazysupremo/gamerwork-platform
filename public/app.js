// app.js - lógica do frontend (auth, canais, chat, WebRTC screen share)

let me = null;
let socket = null;
let currentChannel = null; // o que está sendo exibido no painel principal agora
let connectedVoiceRoomId = null; // sala de voz em que você está REALMENTE conectado (independe do que está vendo)
let localStream = null; // tela compartilhada
let micStream = null; // áudio do microfone
let micMuted = false;
let isDeafened = false;
// Volume geral da chamada (0 a 1) — multiplica o volume de TODAS as pessoas
// remotas de uma vez, junto com o slider individual de cada tile. Lembrado
// entre chamadas via localStorage, igual as outras preferências de áudio.
let masterCallVolume = Number(localStorage.getItem('ng_master_volume') ?? 100) / 100;
const peers = {}; // socketId -> RTCPeerConnection
const remoteStreams = {}; // socketId -> MediaStream combinada (áudio + vídeo do peer)
const remotePeerInfo = {}; // socketId -> { username, avatar, avatar_frame } — pra mostrar a foto de perfil na tile
let voiceParticipants = {}; // channelId -> [{socketId, userId, username}]
let cameraStream = null; // vídeo da webcam (separado da tela compartilhada)
let allUsers = []; // cache de /api/users pro painel de membros
let serverIcons = {}; // category -> emoji real escolhido por quem criou o servidor
let onlineUserIds = new Set();
let presenceStatusMap = {}; // userId -> 'online' | 'ausente' | 'ocupado' (quem tá invisível não entra aqui)
let typingUsers = {}; // channelId -> { userId: username }
let typingTimeout = null;
let homeRefreshInterval = null; // atualiza ranking/atividade/jogando-agora sozinho enquanto a Início está aberta
let ngAppVersion = null; // versão do site conhecida nesta aba (ver checkForUpdates)
let ngVersionCheckInterval = null;

const AVATAR_EMOJIS = ['🎮', '🕹️', '👾', '🔥', '⚡', '🐉', '🦊', '🐱', '💀', '👑', '🎯', '🚀'];
const SERVER_ICONS = ['🎮', '🕹️', '👾', '🔫', '⚔️', '🏆', '⚽', '🏎️', '🧙', '🐉', '💼', '💬', '🎧', '🚀'];

// Monta a fileira de ícones pra escolher o emoji de um servidor novo.
// Reaproveitada tanto no modal de criar servidor quanto em qualquer outro
// lugar que precise do mesmo seletor de emoji.
function buildIconRow(rowId, hiddenInputId) {
  const row = document.getElementById(rowId);
  const hiddenInput = document.getElementById(hiddenInputId);
  row.innerHTML = '';
  SERVER_ICONS.forEach((icon, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = icon;
    btn.style.background = '#5865f2';
    if (i === 0) btn.classList.add('avatar-emoji-selected');
    btn.onclick = () => {
      hiddenInput.value = icon;
      row.querySelectorAll('button').forEach((b) => b.classList.remove('avatar-emoji-selected'));
      btn.classList.add('avatar-emoji-selected');
    };
    row.appendChild(btn);
  });
  hiddenInput.value = SERVER_ICONS[0];
}

// Gera o HTML de um avatar (foto enviada, emoji escolhido, ou inicial do nome).
function renderAvatarHtml(user, sizeClass) {
  const avatar = user && user.avatar;
  if (avatar && avatar.startsWith('data:image/')) {
    return `<img src="${avatar}" alt="" />`;
  }
  if (avatar && avatar.startsWith('emoji:')) {
    const parts = avatar.split(':'); // emoji:🎮:#5865f2
    return `<span style="font-size:1.1em">${escapeHtml(parts[1] || '🎮')}</span>`;
  }
  const initial = escapeHtml(((user && user.username) || '?')[0].toUpperCase());
  return `<span>${initial}</span>`;
}

// Classe CSS da moldura animada (se a pessoa tiver uma equipada) — usada
// junto com renderAvatarHtml em todo lugar que mostra avatar.
function avatarFrameClass(user) {
  return user && user.avatar_frame ? 'avatar-frame-' + user.avatar_frame : '';
}

// Identificador estilo Discord (@Username#1234) — sistema de hashtag.
// Usa username_tag se já veio pronto do backend, senão monta na hora com o
// discriminator; se nem isso tiver (conta bem antiga que ainda não migrou),
// não quebra — só mostra o username sem a hashtag.
function userTag(user) {
  if (!user) return '';
  if (user.username_tag) return '@' + user.username_tag;
  if (user.discriminator) return `@${user.username}#${user.discriminator}`;
  return '@' + (user.username || '');
}

// Atalho pra quando o avatar vai direto num elemento já existente no DOM
// (em vez de dentro de um template de HTML string).
function renderAvatarInto(el, user) {
  el.innerHTML = renderAvatarHtml(user);
  el.className = el.className.replace(/\bavatar-frame-\S+/g, '').trim();
  const frameClass = avatarFrameClass(user);
  if (frameClass) el.classList.add(frameClass);
}

// Valor de partida (só STUN) — vira a lista de verdade (com TURN incluso)
// assim que loadIceServers() responder, logo no início do startApp(). Fica
// como fallback caso o /api/ice-servers falhe por qualquer motivo, pra call
// entre duas pessoas na mesma rede ainda funcionar mesmo assim.
let ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// Busca a lista de servidores STUN/TURN do backend (inclui TURN — essencial
// pra chamada conectar entre pessoas atrás de NAT restritivo, tipo dado
// móvel ou wifi de empresa/escola; sem TURN, esses casos falham direto sem
// aviso nenhum, mesmo com só 2 pessoas na call).
async function loadIceServers() {
  try {
    const res = await fetch('/api/ice-servers', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
      ICE_SERVERS = data.iceServers;
    }
  } catch (_) {
    // mantém o fallback só-STUN definido acima
  }
}

// Preferências de dispositivo de áudio, lembradas entre sessões
let preferredInputId = localStorage.getItem('ng_input_device') || '';
let preferredOutputId = localStorage.getItem('ng_output_device') || '';
let noiseSuppressionEnabled = localStorage.getItem('ng_noise_suppression') !== 'off'; // ligado por padrão
const supportsOutputSelection = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

// Constraints de áudio do microfone: cancelamento de eco, redução de ruído
// de fundo e ajuste automático de volume — tudo processado pelo próprio
// navegador antes de mandar o áudio pra call.
function micConstraints() {
  return {
    deviceId: preferredInputId ? { exact: preferredInputId } : undefined,
    echoCancellation: true,
    noiseSuppression: noiseSuppressionEnabled,
    autoGainControl: true,
  };
}

// ---------- AUTH UI ----------

const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const formLogin = document.getElementById('form-login');
const formRegister = document.getElementById('form-register');
const authError = document.getElementById('auth-error');

tabLogin.onclick = () => switchTab('login');
tabRegister.onclick = () => switchTab('register');

function switchTab(which) {
  tabLogin.classList.toggle('active', which === 'login');
  tabRegister.classList.toggle('active', which === 'register');
  formLogin.classList.toggle('hidden', which !== 'login');
  formRegister.classList.toggle('hidden', which !== 'register');
  authError.textContent = '';
  const titleEl = document.getElementById('auth-card-title');
  const subtitleEl = document.getElementById('auth-card-subtitle');
  if (titleEl && subtitleEl) {
    if (which === 'login') {
      titleEl.textContent = 'BEM-VINDO DE VOLTA';
      subtitleEl.innerHTML = 'Entre para continuar sua jornada no <strong>NEXT GAME</strong>.';
    } else {
      titleEl.textContent = 'CRIAR CONTA';
      subtitleEl.innerHTML = 'É grátis — junte-se à comunidade em segundos.';
      if (typeof resetWizard === 'function') resetWizard();
    }
  }
}

// ---------- LANDING PÚBLICA (antes do login) ----------
// Estatísticas públicas (sem precisar estar logado) pra landing.
fetch('/api/stats')
  .then((res) => res.json())
  .then((stats) => {
    document.getElementById('landing-stats').innerHTML = `
      <div class="home-stat"><span class="home-stat-num">${stats.members}</span><span class="home-stat-label">👥 Membros</span></div>
      <div class="home-stat"><span class="home-stat-num">${stats.servers}</span><span class="home-stat-label">🎮 Servidores</span></div>
      <div class="home-stat"><span class="home-stat-num">${stats.tournaments}</span><span class="home-stat-label">🏆 Torneios</span></div>
    `;
  })
  .catch(() => {});

formLogin.onsubmit = async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const remember = document.getElementById('login-remember').checked;
  await authRequest('/api/login', { username, password }, remember);
};

// ---------- ASSISTENTE DE CADASTRO EM 3 PASSOS ----------

const WIZARD_COUNTRIES = [
  'Brasil', 'Portugal', 'Estados Unidos', 'Argentina', 'México', 'Chile',
  'Colômbia', 'Espanha', 'Alemanha', 'França', 'Reino Unido', 'Canadá', 'Outro',
];
const WIZARD_LANGUAGES = ['Português (Brasil)', 'Português (Portugal)', 'English', 'Español', 'Français', 'Deutsch'];
const WIZARD_GAMES = [
  'Valorant', 'League of Legends', 'CS2', 'Fortnite', 'Apex Legends', 'Minecraft',
  'GTA V', 'Free Fire', 'Overwatch 2', 'Dota 2', 'Rocket League', 'Call of Duty',
];
const WIZARD_PLATFORMS = [
  { value: 'pc', label: '💻 PC' },
  { value: 'playstation', label: '🎮 PlayStation' },
  { value: 'xbox', label: '🎮 Xbox' },
];

const wizardState = { favoriteGames: [], platforms: [], playStyle: null, avatar: undefined, estimatedAge: null };

function populateSelect(select, options) {
  select.innerHTML =
    '<option value="">Selecione</option>' + options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
}
populateSelect(document.getElementById('wiz-country'), WIZARD_COUNTRIES);
populateSelect(document.getElementById('wiz-language'), WIZARD_LANGUAGES);

function buildWizardTagPicker(containerId, options, stateKey, multi) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  options.forEach((opt) => {
    const value = typeof opt === 'string' ? opt : opt.value;
    const label = typeof opt === 'string' ? opt : opt.label;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'wizard-tag-chip';
    chip.textContent = label;
    chip.onclick = () => {
      const list = wizardState[stateKey];
      const idx = list.indexOf(value);
      if (idx >= 0) {
        list.splice(idx, 1);
        chip.classList.remove('active');
      } else {
        if (!multi) list.length = 0;
        list.push(value);
        chip.classList.toggle('active', true);
        if (!multi) {
          container.querySelectorAll('.wizard-tag-chip').forEach((c) => {
            if (c !== chip) c.classList.remove('active');
          });
        }
      }
    };
    container.appendChild(chip);
  });
}
buildWizardTagPicker('wiz-games-picker', WIZARD_GAMES, 'favoriteGames', true);
buildWizardTagPicker('wiz-platform-picker', WIZARD_PLATFORMS, 'platforms', false);

document.querySelectorAll('#wiz-playstyle-group .wizard-choice-btn').forEach((btn) => {
  btn.onclick = () => {
    wizardState.playStyle = btn.dataset.value;
    document.querySelectorAll('#wiz-playstyle-group .wizard-choice-btn').forEach((b) => b.classList.toggle('active', b === btn));
  };
});

document.getElementById('wiz-avatar-upload').onclick = (e) => {
  if (e.target.tagName !== 'INPUT') document.getElementById('wiz-avatar-file').click();
};
document.getElementById('wiz-avatar-file').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const size = 160;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      const scale = Math.max(size / img.width, size / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      wizardState.avatar = canvas.toDataURL('image/jpeg', 0.82);
      document.getElementById('wiz-avatar-preview').innerHTML = `<img src="${wizardState.avatar}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;" />`;
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
};

function goToWizardStep(step) {
  [1, 2, 3].forEach((n) => {
    document.getElementById('wizard-panel-' + n).classList.toggle('hidden', n !== step);
    const dot = document.getElementById('wizard-step-dot-' + n);
    dot.classList.toggle('active', n === step);
    dot.classList.toggle('done', n < step);
  });
}

function resetWizard() {
  goToWizardStep(1);
  wizardState.favoriteGames = [];
  wizardState.platforms = [];
  wizardState.playStyle = null;
  wizardState.avatar = undefined;
  wizardState.estimatedAge = null;
  document.getElementById('age-camera-status').textContent = 'Carregando verificação...';
  document.querySelectorAll('.wizard-tag-chip.active, .wizard-choice-btn.active').forEach((el) => el.classList.remove('active'));
  document.getElementById('wiz-avatar-preview').innerHTML = '📷';
  ['wiz-fullname', 'wiz-username', 'wiz-email', 'wiz-password', 'wiz-password-confirm', 'wiz-rank', 'wiz-birthdate'].forEach((id) => {
    document.getElementById(id).value = '';
  });
  document.getElementById('register-error').textContent = '';
}

document.getElementById('wiz-goto-login').onclick = () => switchTab('login');

document.getElementById('wiz-step1-next').onclick = () => {
  const errorEl = document.getElementById('register-error');
  errorEl.textContent = '';
  const username = document.getElementById('wiz-username').value.trim();
  const email = document.getElementById('wiz-email').value.trim();
  const password = document.getElementById('wiz-password').value;
  const confirm = document.getElementById('wiz-password-confirm').value;
  const birthdate = document.getElementById('wiz-birthdate').value;
  if (username.length < 3) return (errorEl.textContent = 'Username precisa ter pelo menos 3 caracteres.');
  if (!email.includes('@')) return (errorEl.textContent = 'Digite um e-mail válido.');
  if (password.length < 6) return (errorEl.textContent = 'Senha precisa ter pelo menos 6 caracteres.');
  if (password !== confirm) return (errorEl.textContent = 'As senhas não são iguais.');
  // ECA Digital (Lei 15.211/25) — data de nascimento passou a ser
  // obrigatória no cadastro (ver nota completa no servidor).
  if (!birthdate) return (errorEl.textContent = 'Preencha sua data de nascimento.');
  if (new Date(birthdate) > new Date()) return (errorEl.textContent = 'Data de nascimento inválida.');
  goToWizardStep(2);
};

document.getElementById('wiz-step2-back').onclick = () => goToWizardStep(1);
document.getElementById('wiz-step2-next').onclick = () => goToWizardStep(3);
document.getElementById('wiz-step3-back').onclick = () => goToWizardStep(2);

document.getElementById('wiz-submit').onclick = async () => {
  const body = {
    username: document.getElementById('wiz-username').value.trim(),
    email: document.getElementById('wiz-email').value.trim(),
    password: document.getElementById('wiz-password').value,
    full_name: document.getElementById('wiz-fullname').value.trim(),
    country: document.getElementById('wiz-country').value,
    language: document.getElementById('wiz-language').value,
    favorite_games: wizardState.favoriteGames,
    platforms: wizardState.platforms,
    preferred_rank: document.getElementById('wiz-rank').value.trim(),
    play_style: wizardState.playStyle,
    avatar: wizardState.avatar,
    birth_date: document.getElementById('wiz-birthdate').value,
    estimated_age: wizardState.estimatedAge,
  };
  await authRequest('/api/register', body);
};

// ---------- Verificação de idade por câmera (opcional, ECA Digital) ----------
// Roda inteiramente no navegador via face-api.js — a imagem da câmera NUNCA
// sai do dispositivo da pessoa, só o número de idade estimado (se ela topar
// usar essa verificação) é que vai junto no cadastro.
const FACE_API_CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/dist/face-api.js';
const FACE_API_MODELS_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model';
let faceApiLoadPromise = null;
let ageCameraStream = null;

function loadFaceApi() {
  if (faceApiLoadPromise) return faceApiLoadPromise;
  faceApiLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = FACE_API_CDN;
    script.onload = async () => {
      try {
        await window.faceapi.nets.tinyFaceDetector.loadFromUri(FACE_API_MODELS_URL);
        await window.faceapi.nets.ageGenderNet.loadFromUri(FACE_API_MODELS_URL);
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    script.onerror = () => reject(new Error('Erro ao carregar a verificação por câmera.'));
    document.head.appendChild(script);
  });
  return faceApiLoadPromise;
}

document.getElementById('btn-age-camera-check').onclick = async () => {
  const wrap = document.getElementById('age-camera-wrap');
  const statusEl = document.getElementById('age-camera-status');
  const video = document.getElementById('age-camera-video');
  wrap.classList.remove('hidden');
  statusEl.textContent = 'Pedindo acesso à câmera...';
  try {
    ageCameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
    video.srcObject = ageCameraStream;
    statusEl.textContent = 'Carregando verificação (só na primeira vez)...';
    await loadFaceApi();
    statusEl.textContent = 'Posicione seu rosto e clique em Capturar.';
  } catch (err) {
    statusEl.textContent = 'Não foi possível acessar a câmera ou carregar a verificação. Tudo bem, é opcional.';
  }
};

document.getElementById('btn-age-camera-capture').onclick = async () => {
  const statusEl = document.getElementById('age-camera-status');
  const video = document.getElementById('age-camera-video');
  statusEl.textContent = 'Analisando...';
  try {
    const result = await window.faceapi
      .detectSingleFace(video, new window.faceapi.TinyFaceDetectorOptions())
      .withAgeAndGender();
    if (!result) {
      statusEl.textContent = 'Não encontrei um rosto — tenta de novo com mais luz.';
      return;
    }
    wizardState.estimatedAge = Math.round(result.age);
    statusEl.textContent = `Prontinho! Idade estimada: ~${wizardState.estimatedAge} anos.`;
    stopAgeCamera();
  } catch (err) {
    statusEl.textContent = 'Erro na verificação. Sem problema, é opcional — pode continuar sem ela.';
  }
};

document.getElementById('btn-age-camera-cancel').onclick = () => {
  stopAgeCamera();
  document.getElementById('age-camera-wrap').classList.add('hidden');
};

function stopAgeCamera() {
  if (ageCameraStream) {
    ageCameraStream.getTracks().forEach((t) => t.stop());
    ageCameraStream = null;
  }
}

let pending2FALoginToken = null;

// "Continuar conectado" guarda essa preferência tanto no navegador
// (localStorage — decide se a gente TENTA reaproveitar a sessão ao abrir a
// página de novo) quanto manda pro servidor (decide se o cookie de sessão
// dura dias ou morre quando o navegador fecha). Sem marcar a caixinha, cada
// vez que a página carrega ela sempre pede login de novo, mesmo com o cookie
// ainda válido — é a pessoa quem escolhe ficar conectada, nunca automático.
let pendingLoginRemember = true;

async function authRequest(url, body, remember = true) {
  authError.textContent = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(Object.assign({}, body, { remember })),
    });
    const data = await res.json();
    if (!res.ok) {
      authError.textContent = data.error || 'Erro ao autenticar';
      return;
    }
    if (data.requires2fa) {
      pending2FALoginToken = data.tempToken;
      pendingLoginRemember = remember;
      formLogin.classList.add('hidden');
      formRegister.classList.add('hidden');
      document.getElementById('form-2fa').classList.remove('hidden');
      document.getElementById('login-2fa-code').value = '';
      document.getElementById('login-2fa-code').focus();
      return;
    }
    if (remember) localStorage.setItem('ng_remember_me', 'true');
    else localStorage.removeItem('ng_remember_me');
    me = data;
    if (data.requiresEmailVerification) {
      showEmailVerificationScreen();
      return;
    }
    startApp();
  } catch (err) {
    authError.textContent = 'Erro de conexão com o servidor';
  }
}

document.getElementById('form-2fa').onsubmit = async (e) => {
  e.preventDefault();
  const code = document.getElementById('login-2fa-code').value.trim();
  await authRequest('/api/login/2fa', { tempToken: pending2FALoginToken, code }, pendingLoginRemember);
};

// ---------- CONFIRMAÇÃO DE E-MAIL (bloqueia até confirmar) ----------
// Mostrada tanto logo após o cadastro quanto pra quem faz login numa conta
// antiga que nunca confirmou o e-mail — em ambos os casos o backend recusa
// (403) qualquer outra rota até isso ser resolvido, então nem tenta abrir o
// app por trás.
function showEmailVerificationScreen() {
  document.getElementById('boot-loading').classList.add('hidden');
  document.getElementById('auth-screen').classList.remove('hidden');
  formLogin.classList.add('hidden');
  formRegister.classList.add('hidden');
  document.getElementById('form-2fa').classList.add('hidden');
  document.getElementById('email-verify-address').textContent = (me && me.email) || 'seu e-mail';
  document.getElementById('email-verify-error').textContent = '';
  document.getElementById('email-verify-info').textContent = '';
  document.getElementById('email-verify-code').value = '';
  document.getElementById('form-email-verify').classList.remove('hidden');
  document.getElementById('email-verify-code').focus();
  const titleEl = document.getElementById('auth-card-title');
  const subtitleEl = document.getElementById('auth-card-subtitle');
  if (titleEl && subtitleEl) {
    titleEl.textContent = 'CONFIRME SEU E-MAIL';
    subtitleEl.textContent = 'Falta pouco — digite o código que enviamos.';
  }
}

document.getElementById('form-email-verify').onsubmit = async (e) => {
  e.preventDefault();
  const code = document.getElementById('email-verify-code').value.trim();
  const errEl = document.getElementById('email-verify-error');
  errEl.textContent = '';
  try {
    const res = await fetch('/api/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Código incorreto';
      return;
    }
    // Confirmado — busca o /api/me atualizado (email_verified agora true) e entra.
    const meRes = await fetch('/api/me', { credentials: 'include' });
    me = await meRes.json();
    document.getElementById('form-email-verify').classList.add('hidden');
    startApp();
  } catch (err) {
    errEl.textContent = 'Erro de conexão com o servidor';
  }
};

document.getElementById('btn-resend-verify-code').onclick = async () => {
  const infoEl = document.getElementById('email-verify-info');
  const errEl = document.getElementById('email-verify-error');
  infoEl.textContent = 'Enviando...';
  errEl.textContent = '';
  try {
    const res = await fetch('/api/resend-verification-code', { method: 'POST', credentials: 'include' });
    const data = await res.json();
    infoEl.textContent = res.ok ? 'Código reenviado — confira sua caixa de entrada (e o spam).' : '';
    if (!res.ok) errEl.textContent = data.error || 'Não deu pra reenviar agora';
  } catch (err) {
    infoEl.textContent = '';
    errEl.textContent = 'Erro de conexão com o servidor';
  }
};

document.getElementById('btn-logout-from-verify').onclick = async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'include' });
  localStorage.removeItem('ng_remember_me');
  window.location.reload();
};

document.getElementById('btn-logout').onclick = async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'include' });
  localStorage.removeItem('ng_remember_me');
  window.location.reload();
};

// ---------- BOOTSTRAP ----------

// Decide, ANTES de mostrar qualquer tela, se tenta reconectar sozinho ou vai
// direto pro login — sem piscar a tela de login por um instante e depois
// trocar pro app sozinho. Só tenta reconectar se "Continuar conectado"
// esteve marcado da última vez (guardado em localStorage, não no cookie).
async function tryResumeSession() {
  const bootLoading = document.getElementById('boot-loading');
  const remembered = localStorage.getItem('ng_remember_me') === 'true';

  if (!remembered) {
    bootLoading.classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
    return;
  }

  try {
    const res = await fetch('/api/me', { credentials: 'include' });
    if (res.ok) {
      me = await res.json();
      if (me.email_verified === false) {
        showEmailVerificationScreen();
        return;
      }
      startApp();
      bootLoading.classList.add('hidden');
      return;
    }
  } catch (_) {}

  // Sessão expirou ou não é mais válida — limpa a preferência e pede login.
  localStorage.removeItem('ng_remember_me');
  bootLoading.classList.add('hidden');
  document.getElementById('auth-screen').classList.remove('hidden');
}

// Vídeo pequeno e centralizado da logo, sobre o app enquanto ele carrega —
// some sozinho quando o vídeo acaba (ou depois de um tempo máximo, se o
// vídeo não existir/não carregar, pra nunca travar a pessoa numa tela preta).
function playLoginIntro() {
  const overlay = document.getElementById('login-intro-overlay');
  const video = document.getElementById('login-intro-video');
  overlay.classList.remove('hidden', 'login-intro-fading');
  try {
    video.currentTime = 0;
    video.play().catch(() => {});
  } catch (_) {}

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    overlay.classList.add('login-intro-fading');
    setTimeout(() => overlay.classList.add('hidden'), 400);
  };
  video.onended = finish;
  video.onerror = finish;
  setTimeout(finish, 4500);
}

function startApp() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  playLoginIntro();
  document.getElementById('me-username').textContent = me.username;
  renderAvatarInto(document.getElementById('me-avatar'), me);
  if (me.is_admin) document.getElementById('admin-link').classList.remove('hidden');

  updateNavbarProfile();
  refreshStreakBadge();
  refreshFriendsBadge();
  refreshMessagesBadge();
  loadIceServers();
  maybeShowMinorSafetyBanner();
  loadUploadLimits();
  enforceScreenQualityForPlan();
  updatePlusBadgeUI();

  socket = io({ auth: { userId: me.id } });
  registerSocketHandlers();

  // Guarda a versão atual como referência e passa a checar de novo a cada
  // 5 minutos — o socket reconectando (registerSocketHandlers) também
  // dispara uma checagem extra, que é o jeito mais rápido de perceber um
  // deploy novo (o servidor reinicia e todo mundo reconecta).
  checkForUpdates();
  if (ngVersionCheckInterval) clearInterval(ngVersionCheckInterval);
  ngVersionCheckInterval = setInterval(checkForUpdates, 5 * 60 * 1000);

  // Processa o convite (se tiver) ANTES de olhar o "?channel=" — senão dava
  // corrida: às vezes o canal ainda não tinha carregado na lista porque a
  // gente ainda não tinha nem entrado no servidor, e a pessoa caía direto
  // na Início sem aviso nenhum, como se o link não fizesse nada.
  (async () => {
    const params = new URLSearchParams(window.location.search);
    const inviteCode = params.get('invite');
    if (inviteCode) await joinWithInviteCode(inviteCode);

    await loadChannels();

    const inviteChannelId = params.get('channel');
    const target = inviteChannelId && allChannels.find((c) => c.id === inviteChannelId);
    if (target) {
      selectChannel(target);
    } else if (inviteChannelId) {
      // Tinha "?channel=" mas o canal continua fora do alcance (ex: convite
      // inválido/expirado, ou a sala foi apagada) — avisa em vez de sumir.
      showCopyToast('Não foi possível entrar nessa sala pelo link.');
      goHome();
    } else {
      // BUG CORRIGIDO: esse é o caminho mais comum de todos (abrir/recarregar
      // a página já logado, sem link de convite) e chamava só
      // loadHomeDashboard() — que carrega o painel mas NUNCA esconde os
      // ícones de busca/fixados/membros do cabeçalho (isso só acontecia
      // dentro de goHome()). Resultado: o ícone de membros ficava visível e
      // clicável na tela de Início logo na abertura do app, sem nenhum canal
      // selecionado — abrindo a lista de membros sem contexto nenhum.
      // goHome() já chama loadHomeDashboard() por dentro, então cobre os dois.
      goHome();
    }
    history.replaceState({}, '', window.location.pathname);
  })();

  loadMembers();
}

// ---------- MEMBROS (online/offline) ----------

async function loadMembers() {
  try {
    const res = await fetch('/api/users', { credentials: 'include' });
    allUsers = await res.json();
    renderMembers();
  } catch (_) {}
}

// PRIVACIDADE: o painel de membros (coluna da direita) mostrava TODO MUNDO
// que já tem conta na plataforma, mesmo quem nunca entrou nesse servidor —
// virava uma lista pública de "todo mundo que existe" pra qualquer pessoa
// logada, sem ninguém ter escolhido aparecer ali. Agora só mostra quem é
// membro DE VERDADE do servidor atual (igual Discord). A exceção é o admin
// master, que continua vendo a lista completa da plataforma (útil pra
// moderação), igual já era antes.
async function renderMembers() {
  const container = document.getElementById('members-list');
  if (!container) return;

  let users;
  if (me && me.is_admin) {
    users = allUsers;
  } else if (activeServerCategory) {
    try {
      const res = await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}/members`, { credentials: 'include' });
      users = res.ok ? await res.json() : [];
    } catch (_) {
      users = [];
    }
  } else {
    users = [];
  }

  container.innerHTML = '';
  const online = users.filter((u) => onlineUserIds.has(u.id));
  const offline = users.filter((u) => !onlineUserIds.has(u.id));

  const buildGroup = (title, users, isOffline) => {
    if (users.length === 0) return;
    const groupTitle = document.createElement('div');
    groupTitle.className = 'member-group-title';
    groupTitle.textContent = `${title} — ${users.length}`;
    container.appendChild(groupTitle);

    users.forEach((u) => {
      const row = document.createElement('div');
      row.className = 'member-row' + (isOffline ? ' offline' : '');
      const presence = presenceStatusMap[u.id] || (isOffline ? 'offline' : 'online');
      row.innerHTML = `
        <div class="member-avatar-wrap">
          <div class="member-avatar ${avatarFrameClass(u)}">${renderAvatarHtml(u)}</div>
          <span class="member-status-dot member-status-${presence}"></span>
        </div>
        <div class="member-info">
          <div class="member-name">${escapeHtml(u.username)}${u.is_admin ? ' 👑' : ''}</div>
          ${u.status_message ? `<div class="member-game">🎮 ${escapeHtml(u.status_message)}</div>` : ''}
        </div>
      `;
      row.style.cursor = 'pointer';
      row.onclick = () => openProfilePreview(u);
      row.oncontextmenu = (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, buildUserContextMenuItems(u));
      };
      container.appendChild(row);
    });
  };

  buildGroup('Online', online, false);
  buildGroup('Offline', offline, true);
}

document.getElementById('btn-toggle-members').onclick = () => {
  const panel = document.getElementById('members-panel');
  panel.classList.toggle('hidden');
  document.getElementById('btn-toggle-members').classList.toggle('active-state', !panel.classList.contains('hidden'));
  if (!panel.classList.contains('hidden')) {
    if (currentChannel && currentChannel.id && currentChannel.id.startsWith('dm::')) {
      renderDmInfoPanel();
    } else {
      renderMembers();
    }
  }
};

// Coluna "Informações" quando é uma DM — mostra o cartão da pessoa em vez da
// lista de membros do servidor (que não faz sentido numa conversa 1 a 1).
async function renderDmInfoPanel() {
  const container = document.getElementById('members-list');
  if (!container) return;
  container.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const otherId = otherUserIdFromDmChannel(currentChannel.id);
  if (!otherId) return;
  const res = await fetch(`/api/users/${otherId}/profile`, { credentials: 'include' });
  const user = await res.json();
  if (!res.ok) {
    container.innerHTML = '<p class="empty-hint">Não foi possível carregar.</p>';
    return;
  }
  const isOnline = onlineUserIds.has(user.id);
  const memberSince = new Date(user.created_at).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  container.innerHTML = `
    <div class="dm-info-card">
      <div class="member-avatar-wrap" style="width:64px; height:64px; margin:0 auto 8px;">
        <div class="member-avatar ${avatarFrameClass(user)}" style="width:64px; height:64px; font-size:24px;">${renderAvatarHtml(user)}</div>
        <span class="member-status-dot" style="${isOnline ? '' : 'background:#6d7178;'}"></span>
      </div>
      <div style="text-align:center; font-weight:700;">${escapeHtml(user.username)}</div>
      <div style="text-align:center;" class="user-tag-inline">${escapeHtml(userTag(user))}</div>
      <div style="text-align:center; font-size:12px; color:${isOnline ? '#23a55a' : '#949ba4'}; margin-top:2px;">${isOnline ? 'Online' : 'Offline'}</div>
      <div class="hint" style="text-align:center; margin-top:8px;">Membro desde ${memberSince}</div>
      ${user.status_message ? `<div class="hint" style="text-align:center;">🎮 ${escapeHtml(user.status_message)}</div>` : ''}
      <div id="dm-info-actions" style="margin-top:14px; display:flex; flex-direction:column; gap:6px;"></div>
    </div>
  `;
  const actionsEl = document.getElementById('dm-info-actions');
  userActionItems(user).forEach((item) => {
    if (item.separator) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'profile-preview-action-btn' + (item.danger ? ' profile-preview-action-danger' : '');
    btn.innerHTML = `${item.icon} ${escapeHtml(item.label)}`;
    btn.onclick = (e) => item.onClick(e);
    actionsEl.appendChild(btn);
  });
  const verPerfilBtn = document.createElement('button');
  verPerfilBtn.type = 'button';
  verPerfilBtn.className = 'profile-preview-action-btn';
  verPerfilBtn.innerHTML = '👤 Ver perfil completo';
  verPerfilBtn.onclick = () => openProfilePreview(user);
  actionsEl.insertBefore(verPerfilBtn, actionsEl.firstChild);
}

// ---------- CHANNELS / SERVIDORES ----------

let allChannels = [];
let activeServerCategory = null; // categoria = "servidor" selecionado no trilho, igual Discord

async function loadChannels() {
  const res = await fetch('/api/channels', { credentials: 'include' });
  allChannels = await res.json();

  const categories = [...new Set(allChannels.map((c) => c.category))].sort((a, b) => a.localeCompare(b));
  if (!activeServerCategory || !categories.includes(activeServerCategory)) {
    activeServerCategory = categories[0] || null;
  }

  await loadServerIcons();
  renderServerRail(categories);
  renderCategories(allChannels);
}

// Lista de servidores retrátil — fica fechada por padrão (mais espaço na
// sidebar), abre ao clicar em "Servidores". Lembra a última escolha.
const SERVERS_COLLAPSED_KEY = 'ng_servers_collapsed';
function setServersCollapsed(collapsed) {
  document.getElementById('server-rail').classList.toggle('hidden', collapsed);
  document.getElementById('servers-toggle-chevron').classList.toggle('open', !collapsed);
  localStorage.setItem(SERVERS_COLLAPSED_KEY, collapsed ? '1' : '0');
}
document.getElementById('btn-toggle-servers').onclick = () => {
  setServersCollapsed(!document.getElementById('server-rail').classList.contains('hidden'));
};
setServersCollapsed(localStorage.getItem(SERVERS_COLLAPSED_KEY) !== '0');

// Busca os ícones reais escolhidos por quem criou cada servidor (um só
// request pra todos, em vez de um por categoria).
async function loadServerIcons() {
  try {
    const res = await fetch('/api/servers', { credentials: 'include' });
    const rows = await res.json();
    serverIcons = {};
    rows.forEach((r) => {
      if (r.icon) serverIcons[r.category] = r.icon;
    });
  } catch (_) {}
}

// ---------- NÃO LIDAS: badge vermelho no ícone do servidor, igual Discord ----------
// Conta por servidor (não por canal individual) — zera assim que a pessoa
// clica no ícone daquele servidor ou abre qualquer canal dele.
const unreadByCategory = {};

function bumpUnreadServer(category) {
  if (!category) return;
  if (category === activeServerCategory && document.visibilityState === 'visible') return; // já estava vendo
  unreadByCategory[category] = (unreadByCategory[category] || 0) + 1;
  renderServerRail([...new Set(allChannels.map((c) => c.category))]);
}

function markServerRead(category) {
  if (!category || !unreadByCategory[category]) return;
  delete unreadByCategory[category];
  renderServerRail([...new Set(allChannels.map((c) => c.category))]);
}

// Lista de servidores na sidebar — cada categoria criada pelos usuários vira
// uma linha clicável (ícone + nome + indicador), igual ao mock de referência.
// Coluna de canais do servidor — some por padrão, aparece como um popup ao
// escolher um servidor ou clicar no botão de canais, fecha no X/ao
// selecionar um canal (dá mais espaço pra tela principal).
function setChannelSidebarOpen(open) {
  document.getElementById('channel-sidebar').classList.toggle('hidden', !open);
}
document.getElementById('btn-toggle-channel-sidebar').onclick = () => {
  setChannelSidebarOpen(document.getElementById('channel-sidebar').classList.contains('hidden'));
};
document.getElementById('btn-close-channel-sidebar').onclick = () => setChannelSidebarOpen(false);

// ---------- MENU MOBILE (gaveta de navegação no celular) ----------
// Só existe visualmente abaixo de 768px (o botão ☰ fica escondido em tela
// grande via CSS) — mas o JS funciona sempre, sem custo nenhum se não for usado.
const mobileBackdrop = document.getElementById('mobile-drawer-backdrop');
function setMobileSidebarOpen(open) {
  document.getElementById('app-sidebar').classList.toggle('mobile-open', open);
  mobileBackdrop.classList.toggle('hidden', !open);
}
const btnMobileMenu = document.getElementById('btn-mobile-menu');
if (btnMobileMenu) btnMobileMenu.onclick = () => setMobileSidebarOpen(true);
mobileBackdrop.onclick = () => {
  // Fecha o que estiver aberto no momento (gaveta de navegação, canais ou membros).
  setMobileSidebarOpen(false);
  setChannelSidebarOpen(false);
  document.getElementById('members-panel').classList.add('hidden');
};
// Escolher qualquer coisa na gaveta de navegação (Início, Amigos, um
// servidor...) já fecha ela sozinha — sem isso, no celular a pessoa clica,
// a tela muda por trás, mas a gaveta continua aberta por cima cobrindo tudo.
document.getElementById('app-sidebar').addEventListener('click', (e) => {
  if (e.target.closest('.sidebar-nav-item, .server-row, .navbar-profile')) {
    setMobileSidebarOpen(false);
  }
});

function renderServerRail(categories) {
  const list = document.getElementById('server-rail-list');
  list.innerHTML = '';
  categories.forEach((category) => {
    const isActive = category === activeServerCategory;
    const btn = document.createElement('button');
    btn.className = 'server-row';
    if (isActive) btn.classList.add('active');
    btn.title = category;
    btn.innerHTML = `
      <span class="server-row-icon">${escapeHtml(serverIcons[category] || serverInitials(category))}</span>
      <span class="server-row-name">${escapeHtml(category)}</span>
      <span class="server-row-dot ${isActive ? 'server-row-dot-on' : ''}"></span>
    `;

    const unread = unreadByCategory[category];
    if (unread) {
      const badge = document.createElement('span');
      badge.className = 'server-row-badge';
      badge.textContent = unread > 99 ? '99+' : String(unread);
      btn.appendChild(badge);
    }

    btn.onclick = () => {
      exitChatMode();
      activeServerCategory = category;
      markServerRead(category);
      renderServerRail(categories);
      renderCategories(allChannels);
      setChannelSidebarOpen(true);
    };
    list.appendChild(btn);
  });
}

function serverInitials(category) {
  const words = category.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] || '?').slice(0, 2).toUpperCase();
}

// Estado de categorias recolhidas (lembrado entre sessões), igual Discord —
// chave por servidor+tipo pra cada servidor guardar seu próprio estado.
let collapsedGroups = {};
try {
  collapsedGroups = JSON.parse(localStorage.getItem('ng_collapsed_groups') || '{}');
} catch (_) {
  collapsedGroups = {};
}
function saveCollapsedGroups() {
  localStorage.setItem('ng_collapsed_groups', JSON.stringify(collapsedGroups));
}

// Mostra só os canais do servidor (categoria) ativo no momento, agrupados em
// "CANAIS DE TEXTO" e "CANAIS DE VOZ" com seta pra recolher/expandir, e um
// icone que aparece só no hover de cada canal — tudo clicável com o mouse.
// Link de canal que TAMBÉM convida — antes era só "?channel=ID", e quem não
// era membro do servidor clicava e não acontecia nada, sem erro nem nada
// (silencioso). Agora carrega o código de convite do servidor junto, então
// quem abrir o link entra automático no servidor antes de cair na sala.
async function buildChannelInviteLink(ch) {
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(ch.category)}`, { credentials: 'include' });
    const info = await res.json();
    if (res.ok && info.invite_code) {
      return `${window.location.origin}/?invite=${info.invite_code}&channel=${ch.id}`;
    }
  } catch (_) {}
  return `${window.location.origin}/?channel=${ch.id}`;
}

function renderCategories(channels) {
  const container = document.getElementById('categories-container');
  container.innerHTML = '';

  const nameEl = document.getElementById('active-server-name');
  nameEl.textContent = activeServerCategory
    ? categoryIcon(activeServerCategory) + ' ' + activeServerCategory
    : 'NEXT GAME';

  const channelsInServer = channels.filter((ch) => ch.category === activeServerCategory);
  const groups = [
    { key: 'texto', label: 'CANAIS DE TEXTO', channels: channelsInServer.filter((c) => c.type === 'texto') },
    { key: 'voz', label: 'CANAIS DE VOZ', channels: channelsInServer.filter((c) => c.type === 'voz') },
  ];

  groups.forEach((group) => {
    if (group.channels.length === 0) return;
    const groupKey = activeServerCategory + '::' + group.key;
    const isCollapsed = !!collapsedGroups[groupKey];

    const header = document.createElement('div');
    header.className = 'channel-category-header';
    header.innerHTML = `<span class="channel-category-chevron ${isCollapsed ? 'collapsed' : ''}">▾</span><span>${group.label}</span>`;
    header.onclick = () => {
      collapsedGroups[groupKey] = !collapsedGroups[groupKey];
      saveCollapsedGroups();
      renderCategories(allChannels);
    };
    container.appendChild(header);

    if (isCollapsed) return;

    const list = document.createElement('div');
    list.className = 'channel-list';
    group.channels.forEach((ch) => {
      const row = document.createElement('div');
      row.className = 'channel-item-row';

      const el = document.createElement('div');
      el.className = 'channel-item';
      if (currentChannel && currentChannel.id === ch.id) el.classList.add('active');
      if (ch.type === 'voz' && connectedVoiceRoomId === ch.id) el.classList.add('connected');

      const label = document.createElement('span');
      label.className = 'channel-item-label';
      let voiceTag = '';
      if (ch.type === 'voz') {
        if (ch.voice_type === 'jogo' && ch.voice_game) voiceTag = ` · 🎮 ${ch.voice_game}`;
        else if (ch.voice_type === 'evento') voiceTag = ' · 🏆 Evento';
        if (ch.is_quick) voiceTag += ' · ⚡ rápida';
      }
      label.textContent = (ch.type === 'voz' ? '🔊 ' : '# ') + ch.name + (ch.read_only ? ' 🔒' : '') + voiceTag;
      el.appendChild(label);
      el.onclick = () => selectChannel(ch);
      el.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, buildChannelContextMenuItems(ch));
      };

      // Ícones que só aparecem passando o mouse em cima — igual Discord.
      const actions = document.createElement('span');
      actions.className = 'channel-item-actions';

      const inviteBtn = document.createElement('button');
      inviteBtn.type = 'button';
      inviteBtn.className = 'channel-action-icon';
      inviteBtn.title = 'Copiar link do canal';
      inviteBtn.textContent = '🔗';
      inviteBtn.onclick = async (e) => {
        e.stopPropagation();
        const url = await buildChannelInviteLink(ch);
        navigator.clipboard.writeText(url).catch(() => {});
        showCopyToast('Link do canal copiado! Quem não é membro entra no servidor automático.');
      };
      actions.appendChild(inviteBtn);

      const settingsBtn = document.createElement('button');
      settingsBtn.type = 'button';
      settingsBtn.className = 'channel-action-icon';
      settingsBtn.title = 'Gerenciar servidor';
      settingsBtn.textContent = '⚙️';
      settingsBtn.onclick = (e) => {
        e.stopPropagation();
        document.getElementById('btn-server-manage').click();
      };
      actions.appendChild(settingsBtn);

      el.appendChild(actions);
      row.appendChild(el);

      if (ch.type === 'voz' && voiceParticipants[ch.id] && voiceParticipants[ch.id].length > 0) {
        const chips = document.createElement('div');
        chips.className = 'voice-participants';
        voiceParticipants[ch.id].forEach((p) => {
          const chip = document.createElement('div');
          chip.className = 'participant-chip';
          chip.innerHTML = `<span class="participant-avatar">${escapeHtml((p.username || '?')[0].toUpperCase())}</span>${escapeHtml(p.username)}`;
          chips.appendChild(chip);
        });
        row.appendChild(chips);
      }

      list.appendChild(row);
    });
    container.appendChild(list);
  });
}

// Pequeno toast simples de confirmação (reaproveitado pros ícones de hover).
// ---------- AVISO DE NOVA VERSÃO DO SITE ----------
// Compara a versão que o servidor diz estar rodando agora com a última que
// essa aba viu. Diferente = saiu um deploy novo enquanto a pessoa tava com
// o site aberto, então mostra um aviso com o que mudou (vem do
// changelog.json, servido por /api/version). Roda: pouco depois do login,
// de tempos em tempos (setInterval) e sempre que o socket reconecta — que é
// justamente quando é mais provável que o servidor tenha sido reiniciado
// por um deploy.
async function checkForUpdates() {
  try {
    const res = await fetch('/api/version', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    if (!ngAppVersion) {
      // Primeira checagem desta aba: só guarda a versão atual como
      // referência, sem avisar nada (senão todo mundo que abre o site pela
      // primeira vez recebia um "atualizou!" falso).
      ngAppVersion = data.version;
      return;
    }
    if (data.version !== ngAppVersion) {
      ngAppVersion = data.version;
      showUpdateBanner(data);
    }
  } catch (err) {
    // Checagem de versão não pode nunca quebrar o resto do app.
  }
}

function showUpdateBanner({ version, changes }) {
  if (document.getElementById('update-banner')) return; // já tem um na tela
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.className = 'update-banner';
  const changesHtml =
    Array.isArray(changes) && changes.length
      ? `<ul class="update-banner-changes">${changes
          .slice(0, 6)
          .map((c) => `<li>${escapeHtml(c)}</li>`)
          .join('')}</ul>`
      : '';
  banner.innerHTML = `
    <div class="update-banner-icon">${icon('sparkles')}</div>
    <div class="update-banner-body">
      <strong>Nova versão do NEXT GAME disponível${version ? ` — v${escapeHtml(version)}` : ''}</strong>
      ${changesHtml}
    </div>
    <div class="update-banner-actions">
      <button type="button" class="update-banner-reload">Atualizar agora</button>
      <button type="button" class="update-banner-dismiss" aria-label="Fechar">${icon('x')}</button>
    </div>
  `;
  document.body.appendChild(banner);
  requestAnimationFrame(() => banner.classList.add('update-banner-show'));
  banner.querySelector('.update-banner-reload').onclick = () => window.location.reload();
  banner.querySelector('.update-banner-dismiss').onclick = () => {
    banner.classList.remove('update-banner-show');
    setTimeout(() => banner.remove(), 200);
  };
}

function showCopyToast(text) {
  const toast = document.createElement('div');
  toast.className = 'copy-toast';
  toast.textContent = text;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('copy-toast-show'));
  setTimeout(() => {
    toast.classList.remove('copy-toast-show');
    setTimeout(() => toast.remove(), 200);
  }, 1800);
}

// ---------- INFORMAÇÕES/REGRAS DO SERVIDOR ----------

const modalServerInfo = document.getElementById('modal-server-info');
let serverInfoEditing = false;

document.getElementById('btn-server-info').onclick = async () => {
  if (!activeServerCategory) return;
  serverInfoEditing = false;
  document.getElementById('server-info-title').textContent = 'Sobre ' + activeServerCategory;
  document.getElementById('form-server-info').classList.add('hidden');
  document.getElementById('server-info-view').classList.remove('hidden');
  document.getElementById('btn-save-server-info').classList.add('hidden');

  const res = await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}`, { credentials: 'include' });
  const info = await res.json();
  const canManage = me.is_admin || info.is_owner || (info.my_permissions || []).includes('manage_server');
  document.getElementById('btn-edit-server-info').classList.toggle('hidden', !canManage);
  document.getElementById('server-info-description').textContent = info.description || 'Nenhuma descrição definida ainda.';
  document.getElementById('server-info-rules').textContent = info.rules || 'Nenhuma regra definida ainda.';
  document.getElementById('server-info-description-input').value = info.description || '';
  document.getElementById('server-info-rules-input').value = info.rules || '';

  modalServerInfo.classList.remove('hidden');
};

document.getElementById('btn-close-server-info').onclick = () => modalServerInfo.classList.add('hidden');

document.getElementById('btn-edit-server-info').onclick = () => {
  serverInfoEditing = true;
  document.getElementById('server-info-view').classList.add('hidden');
  document.getElementById('form-server-info').classList.remove('hidden');
  document.getElementById('btn-edit-server-info').classList.add('hidden');
  document.getElementById('btn-save-server-info').classList.remove('hidden');
};

document.getElementById('btn-save-server-info').onclick = async () => {
  const description = document.getElementById('server-info-description-input').value.trim();
  const rules = document.getElementById('server-info-rules-input').value.trim();
  await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ description, rules }),
  });
  modalServerInfo.classList.add('hidden');
};

function categoryIcon(category) {
  if (serverIcons[category]) return serverIcons[category];
  const normalized = category.toLowerCase();
  if (normalized.includes('trabalho')) return '💼';
  return '🎮';
}

// ---------- ENTRAR COM CONVITE (servidor privado, estilo Discord) ----------

const modalJoinInvite = document.getElementById('modal-join-invite');

document.getElementById('btn-join-invite').onclick = () => {
  document.getElementById('join-invite-input').value = '';
  document.getElementById('join-invite-error').textContent = '';
  document.getElementById('join-mode-convite-panel').classList.remove('hidden');
  modalJoinInvite.classList.remove('hidden');
};
document.getElementById('btn-close-join-invite').onclick = () => modalJoinInvite.classList.add('hidden');

// Entrada por senha removida deste modal a pedido — só link/código de
// convite agora, e ele já leva direto pra sala (não só pro servidor).

// Aceita tanto o código puro quanto um link completo
// (?invite=CODIGO ou ?invite=CODIGO&channel=ID) — devolve os dois pra dar
// pra entrar E já abrir a sala certa, não só o servidor.
function extractInviteCode(raw) {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    const fromQuery = url.searchParams.get('invite');
    if (fromQuery) return { code: fromQuery, channelId: url.searchParams.get('channel') || null };
  } catch (_) {
    // não é uma URL válida, trata como código puro mesmo
  }
  return { code: trimmed, channelId: null };
}

async function joinWithInviteCode(code, channelId) {
  const errorEl = document.getElementById('join-invite-error');
  errorEl.textContent = '';
  try {
    const res = await fetch(`/api/invite/${encodeURIComponent(code)}/join`, { method: 'POST', credentials: 'include' });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Convite inválido';
      alert(data.error || 'Não foi possível entrar com esse convite');
      return false;
    }
    modalJoinInvite.classList.add('hidden');
    activeServerCategory = data.category;
    await loadChannels();
    // Entrou de verdade — mostra isso na tela em vez de deixar tudo escondido
    // (as colunas de servidores/canais agora ficam fechadas por padrão).
    if (typeof setServersCollapsed === 'function') setServersCollapsed(false);
    if (typeof setChannelSidebarOpen === 'function') setChannelSidebarOpen(true);
    // Se o link/código trazia uma sala específica junto, já entra direto
    // nela em vez de só mostrar a lista de canais do servidor.
    const target = channelId && allChannels.find((c) => c.id === channelId);
    if (target) {
      selectChannel(target);
    } else {
      showCopyToast(`Você entrou no servidor "${data.category}"!`);
    }
    return true;
  } catch (_) {
    errorEl.textContent = 'Erro de conexão';
    return false;
  }
}

document.getElementById('btn-submit-invite').onclick = () => {
  const { code, channelId } = extractInviteCode(document.getElementById('join-invite-input').value);
  if (!code) return;
  joinWithInviteCode(code, channelId);
};

// Link de convite direto (?invite=CODIGO) — entra automaticamente ao abrir.
function checkInviteLinkOnLoad() {
  const params = new URLSearchParams(window.location.search);
  const inviteCode = params.get('invite');
  if (inviteCode) {
    joinWithInviteCode(inviteCode).finally(() => {
      history.replaceState({}, '', window.location.pathname);
    });
  }
}

// ---------- GERENCIAR SERVIDOR: convite, membros e cargos ----------

const modalServerManage = document.getElementById('modal-server-manage');
let manageServerPermissions = [];
let manageServerIsOwner = false;
let manageAvailableRoles = [];
const SERVER_PERMISSION_KEYS_CLIENT = ['manage_server', 'manage_channels', 'manage_roles', 'kick_members', 'mute_members'];

document.getElementById('btn-server-manage').onclick = async () => {
  if (!activeServerCategory) return;
  document.querySelectorAll('.manage-tab').forEach((t, i) => t.classList.toggle('active', i === 0));
  document.querySelectorAll('.manage-tab-panel').forEach((p, i) => p.classList.toggle('hidden', i !== 0));

  const infoRes = await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}`, { credentials: 'include' });
  const info = await infoRes.json();
  manageServerIsOwner = !!info.is_owner;
  manageServerPermissions = info.my_permissions || [];
  if (me.is_admin) manageServerPermissions = SERVER_PERMISSION_KEYS_CLIENT;

  // "Apagar servidor" só pro dono — "Sair" fica só pra quem NÃO é dono
  // (dono precisa apagar, não dá pra só sair e abandonar o servidor).
  document.getElementById('btn-delete-server').classList.toggle('hidden', !manageServerIsOwner);
  document.getElementById('btn-leave-server').classList.toggle('hidden', manageServerIsOwner);

  await loadManageInvite();
  modalServerManage.classList.remove('hidden');
};
document.getElementById('btn-close-server-manage').onclick = () => modalServerManage.classList.add('hidden');

document.getElementById('btn-delete-server').onclick = async () => {
  if (!activeServerCategory) return;
  const typed = prompt(
    `Isso apaga o servidor "${activeServerCategory}" pra sempre — salas, mensagens, torneios, tudo. Não dá pra desfazer.\n\nDigite o nome do servidor exatamente como está pra confirmar:`
  );
  if (typed === null) return;
  if (typed !== activeServerCategory) {
    alert('Nome não bateu — servidor não foi apagado.');
    return;
  }
  const res = await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ confirmName: typed }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || 'Não foi possível apagar o servidor');
    return;
  }
  modalServerManage.classList.add('hidden');
  activeServerCategory = null;
  await loadChannels();
  goHome();
};

document.querySelectorAll('.manage-tab').forEach((tabBtn) => {
  tabBtn.onclick = async () => {
    document.querySelectorAll('.manage-tab').forEach((t) => t.classList.remove('active'));
    tabBtn.classList.add('active');
    document.querySelectorAll('.manage-tab-panel').forEach((p) => p.classList.add('hidden'));
    const panel = document.getElementById('manage-tab-' + tabBtn.dataset.tab);
    panel.classList.remove('hidden');
    if (tabBtn.dataset.tab === 'members') await loadManageMembers();
    if (tabBtn.dataset.tab === 'roles') await loadManageRoles();
  };
});

async function loadManageInvite() {
  const canManage = manageServerIsOwner || manageServerPermissions.includes('manage_server');
  document.getElementById('btn-regenerate-invite').classList.toggle('hidden', !canManage);
  const res = await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}/invite`, { credentials: 'include' });
  const data = await res.json();
  document.getElementById('invite-link-display').value = `${window.location.origin}/?invite=${data.invite_code}`;

  // Status do convite: ativo/revogado, quantos usos, validade — item 4 do plano.
  const statusLine = document.getElementById('invite-status-line');
  const parts = [];
  parts.push(data.invite_active ? '✅ Ativo' : '⛔ Revogado');
  parts.push(`${data.invite_uses || 0} uso${data.invite_uses === 1 ? '' : 's'}${data.invite_max_uses ? ` de ${data.invite_max_uses}` : ' (ilimitado)'}`);
  if (data.invite_expires_at) {
    const expires = new Date(data.invite_expires_at);
    parts.push(expires < new Date() ? 'expirado' : `expira em ${expires.toLocaleString('pt-BR')}`);
  } else {
    parts.push('sem prazo de validade');
  }
  statusLine.textContent = parts.join(' · ');
  document.getElementById('invite-minutes-valid').value = '';
  document.getElementById('invite-max-uses').value = data.invite_max_uses || '';
  document.getElementById('btn-revoke-invite').classList.toggle('hidden', !canManage || !data.invite_active);
  document.getElementById('btn-reactivate-invite').classList.toggle('hidden', !canManage || !!data.invite_active);

  document.getElementById('btn-revoke-invite').onclick = async () => {
    if (!confirm('Revogar o convite? O link atual para de funcionar até você reativar ou gerar um novo.')) return;
    await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}/invite/revoke`, {
      method: 'POST',
      credentials: 'include',
    });
    loadManageInvite();
  };
  document.getElementById('btn-reactivate-invite').onclick = async () => {
    await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}/invite/reactivate`, {
      method: 'POST',
      credentials: 'include',
    });
    loadManageInvite();
  };
  document.getElementById('btn-save-invite-limits').onclick = async () => {
    const minutes_valid = document.getElementById('invite-minutes-valid').value || null;
    const max_uses = document.getElementById('invite-max-uses').value || null;
    const r = await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}/invite`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ minutes_valid, max_uses }),
    });
    const d = await r.json();
    if (!r.ok) {
      alert(d.error || 'Erro ao salvar');
      return;
    }
    showCopyToast('Validade/limite do convite atualizados!');
    loadManageInvite();
  };

  const infoRes = await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}`, { credentials: 'include' });
  const info = await infoRes.json();
  const toggle = document.getElementById('server-discoverable-toggle');
  toggle.checked = !!info.discoverable;
  toggle.disabled = !canManage;
  toggle.onchange = async () => {
    await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ discoverable: toggle.checked }),
    });
    showCopyToast(toggle.checked ? 'Servidor agora é público!' : 'Servidor voltou a ser privado.');
  };

  // Modo de acesso: convite ou senha — mostra a aba que já está ativa hoje
  // pro servidor, e troca de modo direto na hora que a pessoa clica na outra.
  const accessTabs = document.querySelectorAll('#manage-tab-invite [data-access-mode]');
  const convitePanel = document.getElementById('access-mode-convite-panel');
  const senhaPanel = document.getElementById('access-mode-senha-panel');
  document.getElementById('server-password-input').value = '';
  document.getElementById('server-password-error').textContent = '';

  function showAccessPanel(mode) {
    accessTabs.forEach((t) => t.classList.toggle('active', t.dataset.accessMode === mode));
    convitePanel.classList.toggle('hidden', mode !== 'convite');
    senhaPanel.classList.toggle('hidden', mode !== 'senha');
  }
  showAccessPanel(info.access_mode === 'senha' ? 'senha' : 'convite');

  accessTabs.forEach((tab) => {
    tab.onclick = async () => {
      const mode = tab.dataset.accessMode;
      showAccessPanel(mode);
      if (!canManage) return;
      if (mode === 'convite') {
        // Volta pra convite não precisa de senha nova — só muda o modo.
        await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ access_mode: 'convite' }),
        });
        showCopyToast('Servidor agora usa convite pra entrar.');
      }
      // Modo "senha" só é salvo quando a pessoa digita e clica em "Salvar senha".
    };
  });

  document.getElementById('btn-save-server-password').onclick = async () => {
    const errorEl = document.getElementById('server-password-error');
    errorEl.textContent = '';
    const password = document.getElementById('server-password-input').value;
    if (password.length < 4) {
      errorEl.textContent = 'A senha precisa ter pelo menos 4 caracteres.';
      return;
    }
    const r = await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ access_mode: 'senha', password }),
    });
    const d = await r.json();
    if (!r.ok) {
      errorEl.textContent = d.error || 'Erro ao salvar a senha';
      return;
    }
    document.getElementById('server-password-input').value = '';
    showCopyToast('Servidor agora usa senha pra entrar.');
  };
}

document.getElementById('btn-copy-invite-server').onclick = () => {
  // BUG CORRIGIDO: esse botão dividia o mesmo id ("btn-copy-invite") com o
  // de "Convidar pra sala" na tela de voz — getElementById sempre pega o
  // PRIMEIRO elemento com aquele id, então esse aqui nunca tinha o clique
  // ligado de verdade (o botão de copiar link do servidor não fazia nada).
  const input = document.getElementById('invite-link-display');
  navigator.clipboard.writeText(input.value).catch(() => {
    input.select();
    document.execCommand('copy');
  });
};

document.getElementById('btn-regenerate-invite').onclick = async () => {
  if (!confirm('Gerar um novo código invalida o link de convite atual. Continuar?')) return;
  const res = await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}/invite/regenerate`, {
    method: 'POST',
    credentials: 'include',
  });
  const data = await res.json();
  if (res.ok) document.getElementById('invite-link-display').value = `${window.location.origin}/?invite=${data.invite_code}`;
};

document.getElementById('form-add-server-member').onsubmit = async (e) => {
  e.preventDefault();
  if (!activeServerCategory) return;
  const errorEl = document.getElementById('add-server-member-error');
  errorEl.textContent = '';
  const username = document.getElementById('add-server-member-input').value.trim();
  if (!username) return;
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Não foi possível adicionar';
      return;
    }
    document.getElementById('add-server-member-input').value = '';
    showCopyToast(`${data.username} foi adicionado ao servidor!`);
    loadManageMembers();
  } catch (_) {
    errorEl.textContent = 'Erro de conexão com o servidor';
  }
};

async function loadManageMembers() {
  const listEl = document.getElementById('server-members-list');
  listEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}/members`, { credentials: 'include' });
  const members = await res.json();

  const rolesRes = await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}/roles`, { credentials: 'include' });
  const rolesData = await rolesRes.json();
  manageAvailableRoles = rolesData.roles || [];

  const canManageRoles = manageServerIsOwner || manageServerPermissions.includes('manage_roles');
  const canKick = manageServerIsOwner || manageServerPermissions.includes('kick_members');
  document.getElementById('form-add-server-member').classList.toggle('hidden', !canKick);

  listEl.innerHTML = '';
  members.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'server-member-row';
    const rolesHtml = m.roles
      .map(
        (r) => `
      <span class="role-pill" style="background:${r.color}22; color:${r.color}; border-color:${r.color}66;">
        ${escapeHtml(r.name)}
        ${canManageRoles ? `<button type="button" class="role-pill-remove" data-role="${r.id}" title="Remover cargo">×</button>` : ''}
      </span>
    `
      )
      .join('');

    const assignableRoles = manageAvailableRoles.filter((ar) => !m.roles.some((mr) => mr.id === ar.id));
    const roleSelectHtml =
      canManageRoles && assignableRoles.length > 0
        ? `<select class="role-assign-select">
             <option value="">+ Cargo</option>
             ${assignableRoles.map((ar) => `<option value="${ar.id}">${escapeHtml(ar.name)}</option>`).join('')}
           </select>`
        : '';

    row.innerHTML = `
      <div class="member-avatar ${avatarFrameClass(m)}">${renderAvatarHtml(m)}</div>
      <div class="server-member-info">
        <div class="server-member-name">${escapeHtml(m.username)}<span class="user-tag-inline">${escapeHtml(userTag(m))}</span>${m.is_owner ? ' 👑' : ''}</div>
        <div class="server-member-roles">${rolesHtml}</div>
      </div>
      <div class="server-member-actions">
        ${roleSelectHtml}
        ${canKick && !m.is_owner ? `<button type="button" class="server-kick-btn" title="Expulsar">🚪</button>` : ''}
      </div>
    `;

    const select = row.querySelector('.role-assign-select');
    if (select) {
      select.onchange = async () => {
        if (!select.value) return;
        await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}/members/${m.id}/roles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ roleId: select.value, action: 'add' }),
        });
        loadManageMembers();
      };
    }
    row.querySelectorAll('.role-pill-remove').forEach((btn) => {
      btn.onclick = async () => {
        await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}/members/${m.id}/roles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ roleId: btn.dataset.role, action: 'remove' }),
        });
        loadManageMembers();
      };
    });
    const kickBtn = row.querySelector('.server-kick-btn');
    if (kickBtn) {
      kickBtn.onclick = async () => {
        if (!confirm(`Expulsar ${m.username} do servidor?`)) return;
        await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}/kick/${m.id}`, {
          method: 'POST',
          credentials: 'include',
        });
        loadManageMembers();
      };
    }

    listEl.appendChild(row);
  });
}

async function loadManageRoles() {
  const listEl = document.getElementById('server-roles-list');
  listEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}/roles`, { credentials: 'include' });
  const data = await res.json();
  manageAvailableRoles = data.roles || [];

  const canManageRoles = manageServerIsOwner || manageServerPermissions.includes('manage_roles');
  document.getElementById('btn-new-role').classList.toggle('hidden', !canManageRoles);

  // Monta as checkboxes de permissão a partir do catálogo mandado pelo backend.
  const checkboxesEl = document.getElementById('role-permissions-checkboxes');
  checkboxesEl.innerHTML = data.permissions_catalog
    .map(
      (p) => `
    <label class="checkbox-row">
      <input type="checkbox" value="${p.key}" />
      <span>${escapeHtml(p.label)}</span>
    </label>
  `
    )
    .join('');

  listEl.innerHTML = '';
  if (manageAvailableRoles.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Nenhum cargo criado ainda.</p>';
  }
  manageAvailableRoles.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'server-role-row';
    row.innerHTML = `
      <span class="role-pill" style="background:${r.color}22; color:${r.color}; border-color:${r.color}66;">${escapeHtml(r.name)}</span>
      <span class="server-role-perms">${r.permissions.length} permiss${r.permissions.length === 1 ? 'ão' : 'ões'}</span>
      ${canManageRoles ? `<button type="button" class="server-role-delete-btn" title="Excluir cargo">🗑️</button>` : ''}
    `;
    const deleteBtn = row.querySelector('.server-role-delete-btn');
    if (deleteBtn) {
      deleteBtn.onclick = async () => {
        if (!confirm(`Excluir o cargo "${r.name}"?`)) return;
        await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}/roles/${r.id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        loadManageRoles();
      };
    }
    listEl.appendChild(row);
  });
}

document.getElementById('btn-new-role').onclick = () => {
  document.getElementById('form-new-role').classList.remove('hidden');
  document.getElementById('role-name-input').value = '';
  document.getElementById('role-color-input').value = '#5865f2';
};
document.getElementById('btn-cancel-role').onclick = () => {
  document.getElementById('form-new-role').classList.add('hidden');
};

document.getElementById('form-new-role').onsubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById('role-name-input').value.trim();
  const color = document.getElementById('role-color-input').value;
  const permissions = [...document.querySelectorAll('#role-permissions-checkboxes input:checked')].map((c) => c.value);
  const res = await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}/roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ name, color, permissions }),
  });
  if (res.ok) {
    document.getElementById('form-new-role').classList.add('hidden');
    loadManageRoles();
  }
};

document.getElementById('btn-leave-server').onclick = async () => {
  if (!activeServerCategory) return;
  if (!confirm(`Sair do servidor "${activeServerCategory}"?`)) return;
  const res = await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}/leave`, {
    method: 'POST',
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || 'Não foi possível sair do servidor');
    return;
  }
  modalServerManage.classList.add('hidden');
  activeServerCategory = null;
  await loadChannels();
  goHome();
};

// ---------- TORNEIOS ----------

const modalTournaments = document.getElementById('modal-tournaments');

document.getElementById('btn-tournaments').onclick = async () => {
  if (!activeServerCategory) return;
  document.getElementById('btn-new-tournament').classList.toggle('hidden', !me.is_admin);
  document.getElementById('form-new-tournament').classList.add('hidden');
  modalTournaments.classList.remove('hidden');
  await loadTournaments();
};
document.getElementById('btn-close-tournaments').onclick = () => modalTournaments.classList.add('hidden');

document.getElementById('btn-new-tournament').onclick = () => {
  document.getElementById('form-new-tournament').classList.remove('hidden');
  document.getElementById('tournament-error').textContent = '';
};
document.getElementById('btn-cancel-tournament').onclick = () => {
  document.getElementById('form-new-tournament').classList.add('hidden');
};

let tournamentFilter = 'todos';
document.querySelectorAll('.tournament-filter-tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tournament-filter-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    tournamentFilter = tab.dataset.filter;
    loadTournaments();
  };
});

async function loadTournaments() {
  const list = document.getElementById('tournaments-list');
  list.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch(`/api/tournaments?category=${encodeURIComponent(activeServerCategory)}`, {
    credentials: 'include',
  });
  let tournaments = await res.json();

  // Filtro por aba — "andamento"/"finalizados" usam a data como referência,
  // já que o torneio não guarda um status separado além dos jogos da chave.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (tournamentFilter === 'inscritos') {
    tournaments = tournaments.filter((t) => t.is_registered);
  } else if (tournamentFilter === 'andamento') {
    tournaments = tournaments.filter((t) => t.event_date && new Date(t.event_date + 'T00:00:00') <= today);
  } else if (tournamentFilter === 'finalizados') {
    tournaments = tournaments.filter((t) => {
      if (!t.event_date) return false;
      const diffDays = (today - new Date(t.event_date + 'T00:00:00')) / 86400000;
      return diffDays > 3;
    });
  }

  list.innerHTML = '';

  if (tournaments.length === 0) {
    list.innerHTML = '<p class="empty-hint">Nenhum torneio nessa categoria.</p>';
    return;
  }

  tournaments.forEach((t) => {
    const card = document.createElement('div');
    card.className = 'tournament-card';
    const dateText = t.event_date ? new Date(t.event_date + 'T00:00:00').toLocaleDateString('pt-BR') : 'Data a definir';
    card.innerHTML = `
      <div class="tournament-info">
        <h3>🏆 ${escapeHtml(t.name)}</h3>
        <div class="tournament-meta">
          <span>${t.format === 'liga' ? '🔁 Liga' : '⚔️ Eliminação'}</span>
          <span>🎮 ${escapeHtml(t.game)}</span>
          <span>📅 ${dateText}</span>
          ${t.prize ? `<span>💰 ${escapeHtml(t.prize)}</span>` : ''}
          <span>👥 ${t.registered_count}/${t.max_slots}</span>
          ${t.registered_count > 0 ? `<span>✅ ${t.checked_in_count} check-in</span>` : ''}
        </div>
      </div>
      <div class="tournament-actions">
        <button class="${t.is_registered ? 'btn-unregister' : 'btn-register'}">
          ${t.is_registered ? 'Sair' : 'Participar'}
        </button>
        ${
          t.is_registered && !t.bracket_generated
            ? `<button class="btn-checkin" ${t.is_checked_in ? 'disabled' : ''}>${t.is_checked_in ? '✅ Check-in feito' : 'Fazer check-in'}</button>`
            : ''
        }
        <button class="btn-view-bracket">🏆 Ver chave</button>
        ${t.created_by === me.id || me.is_admin ? '<button class="btn-generate-bracket">Gerar chave</button>' : ''}
        ${me.is_admin ? '<button class="btn-delete-tournament">Excluir</button>' : ''}
      </div>
      <div class="tournament-bracket hidden"></div>
    `;
    const checkinBtn = card.querySelector('.btn-checkin');
    if (checkinBtn) {
      checkinBtn.onclick = async () => {
        const r = await fetch(`/api/tournaments/${t.id}/check-in`, { method: 'POST', credentials: 'include' });
        const d = await r.json();
        if (!r.ok) return alert(d.error || 'Erro ao fazer check-in');
        loadTournaments();
      };
    }
    card.querySelector(t.is_registered ? '.btn-unregister' : '.btn-register').onclick = async () => {
      const endpoint = t.is_registered ? 'unregister' : 'register';
      const res2 = await fetch(`/api/tournaments/${t.id}/${endpoint}`, { method: 'POST', credentials: 'include' });
      const data = await res2.json();
      if (!res2.ok) {
        alert(data.error || 'Erro');
        return;
      }
      loadTournaments();
    };
    const deleteBtn = card.querySelector('.btn-delete-tournament');
    if (deleteBtn) {
      deleteBtn.onclick = async () => {
        if (!confirm(`Excluir o torneio "${t.name}"?`)) return;
        await fetch(`/api/tournaments/${t.id}`, { method: 'DELETE', credentials: 'include' });
        loadTournaments();
      };
    }
    const generateBtn = card.querySelector('.btn-generate-bracket');
    if (generateBtn) {
      generateBtn.onclick = async () => {
        if (!confirm('Gerar a chave agora? Isso embaralha os inscritos e não pode ser refeito.')) return;
        const r = await fetch(`/api/tournaments/${t.id}/generate-bracket`, { method: 'POST', credentials: 'include' });
        const d = await r.json();
        if (!r.ok) return alert(d.error || 'Erro ao gerar chave');
        renderBracket(t.id, card.querySelector('.tournament-bracket'), t.format);
      };
    }
    card.querySelector('.btn-view-bracket').onclick = () => {
      const bracketEl = card.querySelector('.tournament-bracket');
      bracketEl.classList.toggle('hidden');
      if (!bracketEl.classList.contains('hidden')) renderBracket(t.id, bracketEl, t.format);
    };
    list.appendChild(card);
  });
}

async function renderBracket(tournamentId, container, format) {
  container.innerHTML = '<p class="empty-hint">Carregando chave...</p>';

  let standingsHtml = '';
  if (format === 'liga') {
    const standingsRes = await fetch(`/api/tournaments/${tournamentId}/standings`, { credentials: 'include' });
    const standings = await standingsRes.json();
    if (standings.length > 0) {
      standingsHtml = `
        <div class="liga-standings">
          <div class="liga-standings-header">
            <span>#</span><span>Jogador</span><span>PJ</span><span>V</span><span>D</span><span>Pts</span>
          </div>
          ${standings
            .map(
              (s, i) => `<div class="liga-standings-row">
                <span>${i + 1}</span><span>${escapeHtml(s.name)}</span><span>${s.played}</span><span>${s.wins}</span><span>${s.losses}</span><span><strong>${s.points}</strong></span>
              </div>`
            )
            .join('')}
        </div>`;
    }
  }

  const res = await fetch(`/api/tournaments/${tournamentId}/bracket`, { credentials: 'include' });
  const matches = await res.json();
  if (matches.length === 0) {
    container.innerHTML = standingsHtml || '<p class="empty-hint">Chave ainda não foi gerada.</p>';
    return;
  }
  const rounds = {};
  matches.forEach((m) => {
    if (!rounds[m.round]) rounds[m.round] = [];
    rounds[m.round].push(m);
  });
  const roundNames =
    format === 'liga' ? { 1: 'Confrontos' } : { 1: 'Primeira rodada', 2: 'Quartas', 3: 'Semifinal', 4: 'Final' };
  container.innerHTML = standingsHtml + Object.keys(rounds)
    .sort((a, b) => a - b)
    .map((round) => {
      const label = roundNames[round] || `Rodada ${round}`;
      const matchesHtml = rounds[round]
        .map((m) => {
          const canReport = m.player_a_id && m.player_b_id && m.status !== 'concluida';
          return `
          <div class="bracket-match" data-match-id="${m.id}">
            <div class="bracket-side ${m.winner_id === m.player_a_id ? 'bracket-winner' : ''}">${escapeHtml(m.player_a_name || 'A definir')} ${m.score_a != null ? `(${m.score_a})` : ''}</div>
            <div class="bracket-side ${m.winner_id === m.player_b_id ? 'bracket-winner' : ''}">${escapeHtml(m.player_b_name || 'A definir')} ${m.score_b != null ? `(${m.score_b})` : ''}</div>
            ${m.evidence_url ? `<a href="${m.evidence_url}" target="_blank" class="bracket-evidence-link">📷 Ver evidência</a>` : ''}
            ${canReport ? '<button type="button" class="bracket-report-btn">Registrar resultado</button>' : ''}
            ${
              canReport
                ? `<form class="bracket-report-form hidden">
                     <label class="bracket-report-radio"><input type="radio" name="winner-${m.id}" value="a" checked /> ${escapeHtml(m.player_a_name)} venceu</label>
                     <label class="bracket-report-radio"><input type="radio" name="winner-${m.id}" value="b" /> ${escapeHtml(m.player_b_name)} venceu</label>
                     <div class="bracket-report-scores">
                       <input type="number" min="0" class="bracket-score-a" placeholder="Placar ${escapeHtml(m.player_a_name)}" />
                       <input type="number" min="0" class="bracket-score-b" placeholder="Placar ${escapeHtml(m.player_b_name)}" />
                     </div>
                     <label class="bracket-report-evidence-label">📷 Evidência (print do resultado, opcional)
                       <input type="file" accept="image/*" class="bracket-evidence-file" />
                     </label>
                     <button type="submit" class="bracket-report-submit">Confirmar resultado</button>
                   </form>`
                : ''
            }
          </div>
        `;
        })
        .join('');
      return `<div class="bracket-round"><div class="bracket-round-label">${label}</div>${matchesHtml}</div>`;
    })
    .join('');

  container.querySelectorAll('.bracket-report-btn').forEach((btn) => {
    btn.onclick = () => btn.nextElementSibling.classList.toggle('hidden');
  });

  container.querySelectorAll('.bracket-report-form').forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const matchEl = form.closest('.bracket-match');
      const matchId = matchEl.dataset.matchId;
      const match = matches.find((m) => m.id === matchId);
      const side = form.querySelector('input[type="radio"]:checked').value;
      const winnerId = side === 'a' ? match.player_a_id : match.player_b_id;
      const scoreA = form.querySelector('.bracket-score-a').value;
      const scoreB = form.querySelector('.bracket-score-b').value;
      const fileInput = form.querySelector('.bracket-evidence-file');

      let evidence = null;
      if (fileInput.files && fileInput.files[0]) {
        evidence = await resizeImageToDataUrl(fileInput.files[0], 900);
      }

      const submitBtn = form.querySelector('.bracket-report-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Enviando...';
      const r = await fetch(`/api/tournaments/matches/${matchId}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          winner_id: winnerId,
          score_a: scoreA === '' ? null : Number(scoreA),
          score_b: scoreB === '' ? null : Number(scoreB),
          evidence,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        alert(d.error || 'Erro ao registrar resultado');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Confirmar resultado';
        return;
      }
      renderBracket(tournamentId, container, format);
    };
  });
}

// Reaproveita o mesmo esquema de redimensionar-e-exportar-como-JPEG usado no
// avatar, só que num tamanho maior (print de resultado precisa ser legível).
function resizeImageToDataUrl(file, maxSize) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

document.getElementById('form-new-tournament').onsubmit = async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('tournament-error');
  errorEl.textContent = '';
  const body = {
    category: activeServerCategory,
    name: document.getElementById('tournament-name').value.trim(),
    game: document.getElementById('tournament-game').value.trim(),
    event_date: document.getElementById('tournament-date').value || null,
    prize: document.getElementById('tournament-prize').value.trim(),
    max_slots: document.getElementById('tournament-slots').value,
    format: document.getElementById('tournament-format').value,
  };
  const res = await fetch('/api/tournaments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error || 'Erro ao criar torneio';
    return;
  }
  document.getElementById('form-new-tournament').reset();
  document.getElementById('form-new-tournament').classList.add('hidden');
  loadTournaments();
};

// ---------- RANKING SEMANAL ----------

const modalRanking = document.getElementById('modal-ranking');
let rankingScope = 'global';

async function loadRankingModal() {
  const list = document.getElementById('ranking-list');
  list.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const params = new URLSearchParams({ scope: rankingScope });
  if (rankingScope === 'servidor') {
    if (!activeServerCategory) {
      list.innerHTML = '<p class="empty-hint">Entre num servidor primeiro pra ver o ranking dele.</p>';
      return;
    }
    params.set('category', activeServerCategory);
  }
  const res = await fetch(`/api/ranking?${params.toString()}`, { credentials: 'include' });
  const ranking = await res.json();
  list.innerHTML = '';
  if (ranking.length === 0) {
    list.innerHTML = '<p class="empty-hint">Ainda sem atividade suficiente essa semana nessa categoria.</p>';
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  ranking.forEach((u, i) => {
    const row = document.createElement('div');
    row.className = 'ranking-row';
    row.innerHTML = `
      <span class="ranking-position">${medals[i] || i + 1}</span>
      <div class="member-avatar">${renderAvatarHtml(u)}</div>
      <span class="ranking-name">${escapeHtml(u.username)}</span>
      <span class="ranking-points">${u.points} msgs</span>
    `;
    list.appendChild(row);
  });
}

document.getElementById('btn-ranking').onclick = () => {
  modalRanking.classList.remove('hidden');
  loadRankingModal();
};
document.querySelectorAll('#modal-ranking .tournament-filter-tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('#modal-ranking .tournament-filter-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    rankingScope = tab.dataset.scope;
    loadRankingModal();
  };
});
document.getElementById('btn-close-ranking').onclick = () => modalRanking.classList.add('hidden');

// ---------- LOJA DE RECOMPENSAS (streak de acesso, molduras, selo raro) ----------

const modalRewards = document.getElementById('modal-rewards');
let rewardsCache = null;

document.getElementById('nav-rewards').onclick = () => {
  modalRewards.classList.remove('hidden');
  loadRewards();
};
document.getElementById('btn-close-rewards').onclick = () => modalRewards.classList.add('hidden');

// Atualiza a bolinha de streak no sino de recompensas da navbar.
async function refreshStreakBadge() {
  try {
    const res = await fetch('/api/rewards', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    rewardsCache = data;
    const badge = document.getElementById('navbar-streak-badge');
    if (data.streak > 0) {
      badge.textContent = '🔥' + data.streak;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
    celebrateNewRewards(data, me.id);
  } catch (_) {}
}

// Monta o visual de cada recompensa: os selos com imagem real mostram a arte
// enviada, com o nome da pessoa sobreposto quando a arte tem espaço reservado
// pra isso (hasName), ou como legenda embaixo quando não tem.
const SEAL_SHAPE_CLASS = {
  seal90: 'reward-seal-square',
  seal120: 'reward-seal-wide',
  'founder-eternal': 'reward-seal-founder',
};

function sealVisualHtml(reward) {
  if (reward.image) {
    return `
      <div class="reward-seal-wrap ${SEAL_SHAPE_CLASS[reward.key] || 'reward-seal-wide'}">
        <img src="${reward.image}" alt="${escapeHtml(reward.name)}" class="reward-seal-img" />
        ${reward.hasName && reward.unlocked ? `<span class="reward-seal-name">${escapeHtml(me.username)}</span>` : ''}
      </div>
      ${!reward.hasName && reward.unlocked ? `<div class="reward-seal-caption">🏅 Selo de <strong>${escapeHtml(me.username)}</strong></div>` : ''}
    `;
  }
  const previewFrameClass = reward.unlocked && reward.frame ? 'avatar-frame-' + reward.frame : '';
  return `<div class="reward-frame-preview member-avatar-lg ${previewFrameClass}">${renderAvatarHtml(me)}</div>`;
}

async function loadRewards() {
  const summaryEl = document.getElementById('rewards-streak-summary');
  const catalogEl = document.getElementById('rewards-catalog');
  summaryEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  catalogEl.innerHTML = '';

  const res = await fetch('/api/rewards', { credentials: 'include' });
  const data = await res.json();
  rewardsCache = data;
  celebrateNewRewards(data, me.id);

  const nextStreakGoal = data.rewards.find((r) => r.type === 'streak' && !r.unlocked);
  summaryEl.innerHTML = `
    <div class="streak-summary-row">
      <div class="streak-flame-box">
        <span class="streak-flame">🔥</span>
        <div>
          <div class="streak-count">${data.streak} ${data.streak === 1 ? 'dia' : 'dias'} seguidos</div>
          <div class="streak-best">Recorde: ${data.longest_streak} ${data.longest_streak === 1 ? 'dia' : 'dias'}</div>
        </div>
      </div>
      ${
        nextStreakGoal
          ? `<div class="streak-next-goal">
               <div class="streak-next-label">Próxima recompensa: ${escapeHtml(nextStreakGoal.name)} (${nextStreakGoal.days} dias)</div>
               <div class="streak-progress-bar"><div class="streak-progress-fill" style="width:${Math.min(100, (data.streak / nextStreakGoal.days) * 100)}%"></div></div>
             </div>`
          : `<div class="streak-next-goal"><div class="streak-next-label">🎉 Você desbloqueou todas as recompensas de streak!</div></div>`
      }
    </div>
  `;

  data.rewards.forEach((r) => {
    const isBigSeal = !!r.image || r.key === 'founder-eternal';
    const card = document.createElement('div');
    card.className =
      'reward-card' +
      (r.unlocked ? '' : ' reward-card-locked') +
      (r.rare ? ' reward-card-rare' : '') +
      (isBigSeal ? ' reward-card-seal' : '');

    const progress = r.type === 'streak' && !r.unlocked ? Math.min(data.streak, r.days) : null;

    let actionsHtml = '';
    if (r.unlocked) {
      const isEquipped = me.avatar_frame === r.frame;
      const slotsBrag = r.slots
        ? `<div class="reward-slots-brag">🏅 Você é 1 de ${r.slots.total} pessoas com esse selo no mundo!</div>`
        : '';
      actionsHtml = `
        ${slotsBrag}
        <div class="reward-actions">
          <button type="button" class="reward-equip-btn" ${isEquipped ? 'disabled' : ''}>
            ${isEquipped ? '✅ Equipada' : 'Equipar moldura'}
          </button>
        </div>
        <div class="reward-verify">
          <span class="reward-code">${escapeHtml(r.verification_code)}</span>
          <button type="button" class="reward-copy-btn" title="Copiar código">📋</button>
          <button type="button" class="reward-verify-btn" title="Verificar publicamente">🔎 Verificar</button>
        </div>
      `;
    } else {
      const daysHint = r.type === 'streak' ? `${progress}/${r.days} dias de acesso seguido` : 'Ainda não desbloqueado';
      const slotsHint = r.slots ? ` · ${r.slots.taken}/${r.slots.total} vagas preenchidas` : '';
      actionsHtml = `<div class="reward-locked-hint">🔒 ${daysHint}${slotsHint}</div>`;
    }

    card.innerHTML = `
      ${r.rare && !isBigSeal ? `<img src="/assets/logo.png" alt="" class="reward-rare-logo" />` : ''}
      <div class="reward-icon-wrap">${sealVisualHtml(r)}</div>
      <div class="reward-info">
        <h3>${r.rare ? '<img src="/assets/kenney-icons/star.png" class="reward-rare-star" alt="raro" /> ' : ''}${escapeHtml(r.name)}</h3>
        <p>${escapeHtml(r.description)}</p>
        ${actionsHtml}
      </div>
    `;

    if (r.unlocked) {
      card.querySelector('.reward-equip-btn').onclick = async () => {
        const res2 = await fetch('/api/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ avatar_frame: r.frame }),
        });
        const updated = await res2.json();
        if (!res2.ok) {
          alert(updated.error || 'Erro ao equipar moldura');
          return;
        }
        me.avatar_frame = updated.avatar_frame;
        renderAvatarInto(document.getElementById('me-avatar'), me);
        renderAvatarInto(document.getElementById('navbar-avatar'), me);
        loadRewards();
      };
      card.querySelector('.reward-copy-btn').onclick = () => {
        navigator.clipboard.writeText(r.verification_code).catch(() => {});
      };
      card.querySelector('.reward-verify-btn').onclick = () => {
        modalRewards.classList.add('hidden');
        document.getElementById('verify-code-input').value = r.verification_code;
        document.getElementById('modal-verify').classList.remove('hidden');
        document.getElementById('btn-verify-code').click();
      };
    }

    catalogEl.appendChild(card);
  });
}

// ---------- VERIFICAÇÃO PÚBLICA DE SELO (auditável, sem login) ----------

document.getElementById('btn-close-verify').onclick = () => document.getElementById('modal-verify').classList.add('hidden');

document.getElementById('btn-verify-code').onclick = async () => {
  const code = document.getElementById('verify-code-input').value.trim();
  const resultEl = document.getElementById('verify-result');
  if (!code) return;
  resultEl.innerHTML = '<p class="empty-hint">Verificando...</p>';
  try {
    const res = await fetch(`/api/verify/${encodeURIComponent(code)}`);
    const data = await res.json();
    if (!data.valid) {
      resultEl.innerHTML = `<div class="verify-invalid">❌ Código não encontrado ou inválido.</div>`;
      return;
    }
    resultEl.innerHTML = `
      <div class="verify-valid">
        <img src="/assets/logo.png" alt="" class="verify-logo" />
        ✅ Selo autêntico<br />
        <strong>${escapeHtml(data.username)}</strong> — ${escapeHtml(data.reward_name)}<br />
        <span class="hint">Desbloqueado em ${new Date(data.unlocked_at).toLocaleString('pt-BR')}</span>
      </div>
    `;
  } catch (_) {
    resultEl.innerHTML = `<div class="verify-invalid">Erro ao verificar. Tente de novo.</div>`;
  }
};

// ---------- MISSÕES (quiz sobre o NEXT GAME, rende pontos) ----------

const modalMissions = document.getElementById('modal-missions');
const modalQuiz = document.getElementById('modal-quiz');
let missionsCache = null;
let activeQuizMission = null;

document.getElementById('btn-open-missions').onclick = () => {
  modalRewards.classList.add('hidden');
  modalMissions.classList.remove('hidden');
  loadMissions();
};
document.getElementById('btn-close-missions').onclick = () => modalMissions.classList.add('hidden');

async function loadMissions() {
  const summaryEl = document.getElementById('missions-points-summary');
  const listEl = document.getElementById('missions-list');
  summaryEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  listEl.innerHTML = '';

  const res = await fetch('/api/missions', { credentials: 'include' });
  const data = await res.json();
  missionsCache = data;

  summaryEl.innerHTML = `
    <div class="missions-points-box">
      <span class="missions-points-icon">🧠</span>
      <div>
        <div class="missions-points-total">${data.points} pontos</div>
        <div class="missions-points-hint">Ganhos respondendo os quizzes certinho</div>
      </div>
    </div>
  `;

  data.missions.forEach((m) => {
    const card = document.createElement('div');
    card.className =
      'mission-card' + (m.completed ? ' mission-card-done' : !m.available ? ' mission-card-locked' : '');
    card.innerHTML = `
      <div class="mission-info">
        <h3>${m.completed ? '✅' : m.available ? '🎯' : '🔒'} ${escapeHtml(m.name)}</h3>
        <p>${escapeHtml(m.description)}</p>
        <span class="mission-points-tag">+${m.points} pontos</span>
      </div>
      <div class="mission-action">
        ${
          m.completed
            ? `<span class="mission-done-tag">Concluída</span>`
            : m.available
              ? `<button type="button" class="mission-start-btn">Responder quiz</button>`
              : `<span class="mission-locked-tag">${m.unlockDays} dias de sequência</span>`
        }
      </div>
    `;
    if (m.available && !m.completed) {
      card.querySelector('.mission-start-btn').onclick = () => openQuiz(m);
    }
    listEl.appendChild(card);
  });
}

function openQuiz(mission) {
  activeQuizMission = mission;
  document.getElementById('quiz-title').textContent = '🎯 ' + mission.name;
  const container = document.getElementById('quiz-questions');
  document.getElementById('quiz-result').innerHTML = '';
  container.innerHTML = mission.questions
    .map(
      (q, qi) => `
    <div class="quiz-question">
      <p class="quiz-question-text">${qi + 1}. ${escapeHtml(q.q)}</p>
      <div class="quiz-options">
        ${q.options
          .map(
            (opt, oi) => `
          <label class="quiz-option">
            <input type="radio" name="quiz-q${qi}" value="${oi}" required />
            <span>${escapeHtml(opt)}</span>
          </label>
        `
          )
          .join('')}
      </div>
    </div>
  `
    )
    .join('');
  modalMissions.classList.add('hidden');
  modalQuiz.classList.remove('hidden');
}

document.getElementById('btn-cancel-quiz').onclick = () => {
  modalQuiz.classList.add('hidden');
  modalMissions.classList.remove('hidden');
};

document.getElementById('form-quiz').onsubmit = async (e) => {
  e.preventDefault();
  if (!activeQuizMission) return;
  const resultEl = document.getElementById('quiz-result');
  const answers = activeQuizMission.questions.map((_, qi) => {
    const checked = document.querySelector(`input[name="quiz-q${qi}"]:checked`);
    return checked ? Number(checked.value) : -1;
  });

  const res = await fetch(`/api/missions/${activeQuizMission.key}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ answers }),
  });
  const data = await res.json();

  if (!res.ok) {
    resultEl.innerHTML = `<div class="verify-invalid">${escapeHtml(data.error || 'Erro ao enviar respostas')}</div>`;
    return;
  }

  if (data.success) {
    SFX.streakUp();
    launchConfetti();
    resultEl.innerHTML = `<div class="verify-valid">🎉 Você acertou tudo! +${data.points_awarded} pontos (total: ${data.total_points})</div>`;
    setTimeout(() => {
      modalQuiz.classList.add('hidden');
      modalMissions.classList.remove('hidden');
      loadMissions();
    }, 1800);
  } else {
    SFX.wrong();
    resultEl.innerHTML = `<div class="verify-invalid">Você acertou ${data.correctCount}/${data.total}. Precisa acertar todas — tenta de novo!</div>`;
  }
};

// ---------- AMIGOS E CHAT (tela de verdade, não modal) ----------
// Antes isso tudo vivia num popup por cima da tela. Reorganizado pra ser uma
// área principal de verdade, igual Discord: a lista de conversas mora na
// coluna do meio (onde normalmente ficam os canais do servidor) e fica
// visível o tempo todo enquanto você está no chat; a área principal mostra
// ou o painel de Amigos, ou a conversa aberta.
let inChatMode = false;

function enterChatMode(landOn) {
  inChatMode = true;
  activeServerCategory = null;

  // Coluna do meio: troca "canais do servidor" por "lista de conversas".
  document.getElementById('active-server-name').textContent = 'MENSAGENS';
  document.getElementById('categories-container').classList.add('hidden');
  document.getElementById('dm-sidebar-list').classList.remove('hidden');
  // BUG CORRIGIDO: o "X" de fechar a coluna e os ícones de servidor
  // (sala rápida, config etc) continuavam aparecendo em cima da lista de
  // conversas — não fazem sentido fora do contexto de um servidor.
  ['btn-new-room', 'btn-shop-coins', 'btn-server-info', 'btn-server-manage', 'btn-quick-room', 'btn-close-channel-sidebar'].forEach((id) => {
    document.getElementById(id).classList.add('hidden');
  });
  // Mesma lógica pro cabeçalho da área principal — só faz sentido mostrar
  // busca/fixados/limpar/membros quando tem um canal de verdade selecionado.
  ['btn-search-messages', 'btn-pinned-messages', 'btn-clear-channel', 'btn-toggle-members'].forEach((id) => {
    document.getElementById(id).classList.add('hidden');
  });
  if (typeof setServersCollapsed === 'function') setServersCollapsed(true);
  setChannelSidebarOpen(true);
  renderServerRail([...new Set(allChannels.map((c) => c.category))]);

  loadFriends();
  loadDmConversations().then((conversations) => {
    if (landOn === 'mensagens' && conversations && conversations.length > 0 && !currentChannel) {
      // Pousa direto na conversa mais recente, igual Discord — só quando
      // ainda não tem nenhuma conversa aberta (não interrompe quem já
      // estava conversando com alguém).
      openDmText(conversations[0].other_user.id, conversations[0].other_user.username);
    } else if (!currentChannel || currentChannel.type !== 'texto' || !currentChannel.id.startsWith('dm::')) {
      showFriendsPanel();
    }
  });
}

// Sai do modo chat quando a pessoa clica num servidor de verdade — volta a
// coluna do meio a mostrar canais normalmente.
function exitChatMode() {
  if (!inChatMode) return;
  inChatMode = false;
  document.getElementById('dm-sidebar-list').classList.add('hidden');
  document.getElementById('categories-container').classList.remove('hidden');
  document.getElementById('friends-panel').classList.add('hidden');
  ['btn-new-room', 'btn-shop-coins', 'btn-server-info', 'btn-server-manage', 'btn-quick-room', 'btn-close-channel-sidebar'].forEach((id) => {
    document.getElementById(id).classList.remove('hidden');
  });
  // BUG CORRIGIDO: esses 3 ícones do cabeçalho (busca, fixados, membros)
  // ficavam escondidos pra sempre depois de sair do modo Chat/Amigos e ir
  // pra um servidor, até a pessoa clicar num canal de novo — enterChatMode
  // escondia eles mas só selectChannel devolvia, e por um servidor recém
  // aberto (sem canal escolhido ainda) isso nunca acontecia.
  ['btn-search-messages', 'btn-pinned-messages', 'btn-toggle-members'].forEach((id) => {
    document.getElementById(id).classList.remove('hidden');
  });
}

function showFriendsPanel() {
  document.getElementById('home-panel').classList.add('hidden');
  document.getElementById('text-panel').classList.add('hidden');
  document.getElementById('voice-panel').classList.add('hidden');
  document.getElementById('friends-panel').classList.remove('hidden');
  document.getElementById('current-channel-name').textContent = 'Amigos';
  currentChannel = null;
  setNavActive('nav-inicio', false);
  // Sem canal selecionado — os ícones de busca/fixados/membros do cabeçalho
  // não se aplicam aqui. Escondido direto aqui (não só em enterChatMode)
  // pra cobrir também quem chega na tela de Amigos por outros caminhos,
  // tipo o atalho dentro do próprio modo Chat.
  ['btn-search-messages', 'btn-pinned-messages', 'btn-toggle-members'].forEach((id) => {
    document.getElementById(id).classList.add('hidden');
  });
  loadFriends();
}

document.getElementById('nav-sidebar-amigos').onclick = () => {
  enterChatMode('amigos');
  showFriendsPanel();
};
document.getElementById('dm-friends-shortcut').onclick = showFriendsPanel;

document.getElementById('dm-search-input').oninput = (e) => {
  const term = e.target.value.trim().toLowerCase();
  document.querySelectorAll('#dm-conversations-list .friend-row').forEach((row) => {
    row.style.display = !term || row.dataset.searchName.includes(term) ? '' : 'none';
  });
};

let friendsCache = { friends: [], incoming: [], outgoing: [] };

async function refreshFriendsBadge() {
  try {
    const res = await fetch('/api/friends', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    friendsCache = data;
    [document.getElementById('sidebar-friends-badge')].forEach((badge) => {
      if (!badge) return;
      if (data.incoming.length > 0) {
        badge.textContent = data.incoming.length;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    });
  } catch (_) {}
}

// Contador de mensagens não lidas em todas as DMs — soma o unread_count de
// cada conversa e mostra no sininho de Mensagens (item 3/6 da auditoria).
async function refreshMessagesBadge() {
  try {
    const res = await fetch('/api/dm', { credentials: 'include' });
    if (!res.ok) return;
    const conversations = await res.json();
    const total = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);
    const tabBadge = document.getElementById('dm-tab-badge');
    const sidebarBadge = document.getElementById('sidebar-messages-badge');
    const floatingBadge = document.getElementById('floating-chat-badge');
    [tabBadge, sidebarBadge, floatingBadge].forEach((badge) => {
      if (!badge) return;
      if (total > 0) {
        badge.textContent = total > 99 ? '99+' : total;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    });
    return conversations;
  } catch (_) {
    return [];
  }
}

// Lista completa de conversas diretas (não só as 5 últimas da Home) — com
// prévia, horário, contador de não lidas e opção de ocultar pra mim mesmo.
async function loadDmConversations() {
  const el = document.getElementById('dm-conversations-list');
  const conversations = await refreshMessagesBadge();
  if (!conversations || conversations.length === 0) {
    el.innerHTML = '<p class="empty-hint">Nenhuma conversa ainda. Chame um amigo pra jogar!</p>';
    return conversations || [];
  }
  el.innerHTML = '';
  conversations.forEach((c) => {
    const isOnline = onlineUserIds.has(c.other_user.id);
    const preview = c.last_message ? escapeHtml(messagePreviewText(c.last_message)).slice(0, 60) : 'Sem mensagens ainda';
    const when = c.last_message ? new Date(c.last_message.created_at).toLocaleString('pt-BR') : '';
    const row = document.createElement('div');
    row.className = 'friend-row';
    row.dataset.searchName = c.other_user.username.toLowerCase();
    row.classList.toggle('friend-row-active', currentChannel && currentChannel.id === c.channel_id);
    row.innerHTML = `
      <div class="member-avatar-wrap">
        <div class="member-avatar ${avatarFrameClass(c.other_user)}">${renderAvatarHtml(c.other_user)}</div>
        <span class="member-status-dot" style="${isOnline ? '' : 'background:#6d7178;'}"></span>
      </div>
      <span class="friend-name" style="flex:1; min-width:0;">
        <strong style="${c.unread_count > 0 ? 'color:#fff;' : ''}">${escapeHtml(c.other_user.username)}</strong><span class="user-tag-inline">${escapeHtml(userTag(c.other_user))}</span>
        <span class="friend-status" style="display:block; ${c.unread_count > 0 ? 'color:#dbdee1; font-weight:600;' : ''}">${preview}</span>
        <span class="hint" style="font-size:11px;">${when}</span>
      </span>
      <div class="friend-actions">
        ${c.unread_count > 0 ? `<span class="navbar-badge" style="position:static;">${c.unread_count > 99 ? '99+' : c.unread_count}</span>` : ''}
        <button type="button" class="dm-hide-btn" title="Ocultar conversa">🗑️</button>
      </div>
    `;
    row.querySelector('.friend-name').onclick = () => openDmText(c.other_user.id, c.other_user.username);
    row.querySelector('.friend-name').style.cursor = 'pointer';
    row.querySelector('.dm-hide-btn').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Ocultar a conversa com ${c.other_user.username}? Ela some só da sua lista — se ${c.other_user.username} mandar mensagem de novo, reaparece.`)) return;
      await fetch(`/api/dm/${encodeURIComponent(c.channel_id)}`, { method: 'DELETE', credentials: 'include' });
      loadDmConversations();
    };
    el.appendChild(row);
  });
  return conversations;
}

// Status de amizade com alguém ('friend' | 'pending_out' | 'pending_in' | null)
// — usado pelo menu de contexto e no preview de perfil.
function getFriendStatus(userId) {
  if (friendsCache.friends.some((f) => f.user.id === userId)) return 'friend';
  if (friendsCache.outgoing.some((f) => f.user.id === userId)) return 'pending_out';
  if (friendsCache.incoming.some((f) => f.user.id === userId)) return 'pending_in';
  return null;
}

function findFriendshipId(userId) {
  const all = [...friendsCache.friends, ...friendsCache.outgoing, ...friendsCache.incoming];
  const match = all.find((f) => f.user.id === userId);
  return match ? match.friendship_id : null;
}

async function loadFriends() {
  const res = await fetch('/api/friends', { credentials: 'include' });
  const data = await res.json();
  friendsCache = data;

  const incomingSection = document.getElementById('friends-incoming-section');
  const outgoingSection = document.getElementById('friends-outgoing-section');
  incomingSection.classList.toggle('hidden', data.incoming.length === 0);
  outgoingSection.classList.toggle('hidden', data.outgoing.length === 0);

  const incomingList = document.getElementById('friends-incoming-list');
  incomingList.innerHTML = '';
  data.incoming.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'friend-row';
    row.innerHTML = `
      <div class="member-avatar ${avatarFrameClass(f.user)}">${renderAvatarHtml(f.user)}</div>
      <span class="friend-name">${escapeHtml(f.user.username)}<span class="user-tag-inline">${escapeHtml(userTag(f.user))}</span></span>
      <div class="friend-actions">
        <button type="button" class="friend-accept-btn" title="Aceitar">✅</button>
        <button type="button" class="friend-decline-btn" title="Recusar">❌</button>
      </div>
    `;
    row.querySelector('.friend-accept-btn').onclick = async () => {
      await fetch(`/api/friends/${f.friendship_id}/accept`, { method: 'POST', credentials: 'include' });
      SFX.streakUp();
      loadFriends();
      refreshFriendsBadge();
    };
    row.querySelector('.friend-decline-btn').onclick = async () => {
      await fetch(`/api/friends/${f.friendship_id}`, { method: 'DELETE', credentials: 'include' });
      loadFriends();
      refreshFriendsBadge();
    };
    incomingList.appendChild(row);
  });

  const outgoingList = document.getElementById('friends-outgoing-list');
  outgoingList.innerHTML = '';
  data.outgoing.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'friend-row';
    row.innerHTML = `
      <div class="member-avatar ${avatarFrameClass(f.user)}">${renderAvatarHtml(f.user)}</div>
      <span class="friend-name">${escapeHtml(f.user.username)}<span class="user-tag-inline">${escapeHtml(userTag(f.user))}</span></span>
      <div class="friend-actions">
        <span class="friend-pending-tag">Aguardando...</span>
        <button type="button" class="friend-cancel-btn" title="Cancelar pedido">✖</button>
      </div>
    `;
    row.querySelector('.friend-cancel-btn').onclick = async () => {
      await fetch(`/api/friends/${f.friendship_id}`, { method: 'DELETE', credentials: 'include' });
      loadFriends();
    };
    outgoingList.appendChild(row);
  });

  const friendsList = document.getElementById('friends-list');
  friendsList.innerHTML = '';

  // Assistente de IA fica sempre fixado no topo — não precisa de pedido de
  // amizade, qualquer pessoa pode conversar com ele direto.
  const aiRow = document.createElement('div');
  aiRow.className = 'friend-row';
  aiRow.innerHTML = `
    <div class="member-avatar"><span>🤖</span></div>
    <span class="friend-name">NEXT GAME IA <span class="friend-status">Assistente</span></span>
    <div class="friend-actions">
      <button type="button" class="friend-message-btn" title="Conversar">💬</button>
    </div>
  `;
  aiRow.querySelector('.friend-message-btn').onclick = () => openDmText(AI_BOT_USER_ID, 'NEXT GAME IA');
  friendsList.appendChild(aiRow);

  if (data.friends.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = 'Você ainda não tem amigos adicionados.';
    friendsList.appendChild(hint);
  }
  data.friends.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'friend-row';
    const isOnline = onlineUserIds.has(f.user.id);
    row.innerHTML = `
      <div class="member-avatar-wrap">
        <div class="member-avatar ${avatarFrameClass(f.user)}">${renderAvatarHtml(f.user)}</div>
        <span class="member-status-dot" style="${isOnline ? '' : 'background:#6d7178;'}"></span>
      </div>
      <span class="friend-name">${escapeHtml(f.user.username)}<span class="user-tag-inline">${escapeHtml(userTag(f.user))}</span>${f.user.status_message ? ` <span class="friend-status">🎮 ${escapeHtml(f.user.status_message)}</span>` : ''}</span>
      <div class="friend-actions">
        <button type="button" class="friend-message-btn" title="Conversar">💬</button>
        <button type="button" class="friend-call-btn" title="Ligar">📞</button>
        <button type="button" class="friend-remove-btn" title="Desfazer amizade">🗑️</button>
      </div>
    `;
    row.querySelector('.friend-message-btn').onclick = () => openDmText(f.user.id, f.user.username);
    row.querySelector('.friend-call-btn').onclick = () => openDmCall(f.user.id, f.user.username);
    row.querySelector('.friend-remove-btn').onclick = async () => {
      if (!confirm(`Desfazer amizade com ${f.user.username}?`)) return;
      await fetch(`/api/friends/${f.friendship_id}`, { method: 'DELETE', credentials: 'include' });
      loadFriends();
    };
    friendsList.appendChild(row);
  });
}

// ---------- MENSAGENS DIRETAS (DM) ----------
// Reaproveita selectChannel/connectVoice — a única diferença é que o
// channel_id vem do backend em vez de vir da lista de canais do servidor.

async function openDmText(userId, username) {
  const res = await fetch(`/api/dm/${userId}`, { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Não foi possível abrir a conversa');
    return;
  }
  if (!inChatMode) enterChatMode();
  document.getElementById('friends-panel').classList.add('hidden');
  selectChannel({ id: data.channel_id, type: 'texto', name: '💬 ' + username });
}

async function openDmCall(userId, username) {
  const res = await fetch(`/api/dm/${userId}`, { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Não foi possível ligar');
    return;
  }
  if (!inChatMode) enterChatMode();
  document.getElementById('friends-panel').classList.add('hidden');
  socket.emit('dm:ring', { toUserId: userId, channelId: data.channel_id, fromUsername: me.username });
  selectChannel({ id: data.channel_id, type: 'voz', name: '📞 ' + username }, { autoConnect: true });
}

// Notificação de "alguém está te ligando" — toast com som, mesmo padrão dos
// avisos de recompensa.
function showCallToast(fromUsername, channelId) {
  const toast = document.createElement('div');
  toast.className = 'reward-toast reward-toast-rare';
  toast.innerHTML = `
    <span class="reward-toast-icon">📞</span>
    <div class="reward-toast-text">
      <strong>${escapeHtml(fromUsername)} está te ligando</strong>
      <span>Clique aqui pra atender</span>
    </div>
  `;
  toast.style.cursor = 'pointer';
  toast.onclick = () => {
    toast.remove();
    selectChannel({ id: channelId, type: 'voz', name: '📞 ' + fromUsername }, { autoConnect: true });
  };
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('reward-toast-show'));
  setTimeout(() => {
    toast.classList.remove('reward-toast-show');
    setTimeout(() => toast.remove(), 400);
  }, 8000);
}

// Notificação de "chegou mensagem nova" — mesmo pop-up da chamada, só que
// pra DM de texto. Só aparece se a pessoa não estiver já olhando essa
// conversa (senão a mensagem já apareceu na tela normalmente).
function showMessageToast(fromUsername, channelId, preview) {
  const toast = document.createElement('div');
  toast.className = 'reward-toast';
  toast.innerHTML = `
    <span class="reward-toast-icon">💬</span>
    <div class="reward-toast-text">
      <strong>${escapeHtml(fromUsername)}</strong>
      <span>${escapeHtml(preview)}</span>
    </div>
  `;
  toast.style.cursor = 'pointer';
  toast.onclick = () => {
    toast.remove();
    selectChannel({ id: channelId, type: 'texto', name: '💬 ' + fromUsername });
  };
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('reward-toast-show'));
  setTimeout(() => {
    toast.classList.remove('reward-toast-show');
    setTimeout(() => toast.remove(), 400);
  }, 6000);
}

document.getElementById('form-add-friend').onsubmit = async (e) => {
  e.preventDefault();
  const input = document.getElementById('add-friend-input');
  const errorEl = document.getElementById('add-friend-error');
  errorEl.textContent = '';
  const res = await fetch('/api/friends/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username: input.value.trim() }),
  });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error || 'Erro ao adicionar amigo';
    return;
  }
  input.value = '';
  loadFriends();
};

// ---------- MENU DE CONTEXTO (clique direito, estilo Discord) ----------

let activeContextMenu = null;

function closeContextMenu() {
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
}
document.addEventListener('click', closeContextMenu);
document.addEventListener('scroll', closeContextMenu, true);
window.addEventListener('resize', closeContextMenu);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeContextMenu();
});

// items: [{ icon, label, danger, onClick }] ou { separator: true }
function showContextMenu(x, y, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  items.forEach((item) => {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      menu.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'context-menu-item' + (item.danger ? ' context-menu-item-danger' : '');
    btn.innerHTML = `${item.icon ? `<span class="context-menu-icon">${item.icon}</span>` : ''}<span>${escapeHtml(item.label)}</span>`;
    btn.onclick = (e) => {
      e.stopPropagation();
      closeContextMenu();
      item.onClick(e);
    };
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 8;
  const maxY = window.innerHeight - rect.height - 8;
  menu.style.left = Math.max(4, Math.min(x, maxX)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, maxY)) + 'px';
  activeContextMenu = menu;
}

// ---------- CONVITE DIRETO PELO PERFIL ----------
// Item 187b do pedido: "faz que no perfil da pessoa eu consiga add ela no
// server ou enviar mensagem no perfil dela para ela clicar e ir direto" —
// resolve o problema de links de convite que se perdem quando mandados por
// fora do app (WhatsApp, Discord etc), deixando tudo dentro do NEXT GAME.

// Mostra um menuzinho com os servidores que a pessoa pode gerenciar, pra
// escolher em qual deles vai adicionar/convidar. Reaproveita o mesmo
// componente de menu de contexto usado no botão direito.
async function pickMyServerAndRun(evt, runFn) {
  const res = await fetch('/api/servers/mine', { credentials: 'include' });
  const servers = res.ok ? await res.json() : [];
  if (servers.length === 0) {
    alert('Você ainda não tem nenhum servidor. Crie um primeiro em "Criar Servidor".');
    return;
  }
  const x = evt && typeof evt.clientX === 'number' ? evt.clientX : window.innerWidth / 2;
  const y = evt && typeof evt.clientY === 'number' ? evt.clientY : window.innerHeight / 2;
  showContextMenu(
    x,
    y,
    servers.map((s) => ({ icon: '🎮', label: s.category, onClick: () => runFn(s.category) }))
  );
}

async function addUserToServer(user, category) {
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(category)}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username: user.username }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      showCopyToast(`${user.username} foi adicionado ao servidor "${category}"!`);
    } else {
      alert(data.error || 'Não foi possível adicionar — confira se você tem permissão de gerenciar membros nesse servidor.');
    }
  } catch (_) {
    alert('Erro de conexão ao adicionar.');
  }
}

async function sendInviteMessage(user, category) {
  try {
    const inviteRes = await fetch(`/api/servers/${encodeURIComponent(category)}/invite`, { credentials: 'include' });
    const inviteData = await inviteRes.json().catch(() => ({}));
    if (!inviteRes.ok || !inviteData.invite_code) {
      alert(inviteData.error || 'Não foi possível gerar o link de convite desse servidor.');
      return;
    }
    const link = `${window.location.origin}/?invite=${inviteData.invite_code}`;
    const dmRes = await fetch(`/api/dm/${user.id}`, { credentials: 'include' });
    const dmData = await dmRes.json().catch(() => ({}));
    if (!dmRes.ok) {
      alert(dmData.error || 'Não foi possível abrir uma conversa com essa pessoa.');
      return;
    }
    socket.emit('chat:message', {
      channelId: dmData.channel_id,
      content: `Entra no meu servidor "${category}"! ${link}`,
    });
    showCopyToast(`Link enviado pra ${user.username} — é só ela clicar.`);
  } catch (_) {
    alert('Erro de conexão ao mandar o convite.');
  }
}

// Monta as ações disponíveis pra um usuário (usado tanto no menu de contexto
// quanto nos botões do preview de perfil) — amizade, e banir se for admin do site.
function userActionItems(user) {
  const items = [];
  if (user.id === me.id) return items;

  const friendStatus = getFriendStatus(user.id);
  if (friendStatus === 'friend') {
    items.push({
      icon: '💔',
      label: 'Desfazer amizade',
      onClick: async () => {
        const fid = findFriendshipId(user.id);
        if (fid) await fetch(`/api/friends/${fid}`, { method: 'DELETE', credentials: 'include' });
        refreshFriendsBadge();
      },
    });
  } else if (friendStatus === 'pending_out') {
    items.push({ icon: '⏳', label: 'Pedido de amizade enviado', onClick: () => {} });
  } else if (friendStatus === 'pending_in') {
    items.push({
      icon: '✅',
      label: 'Aceitar pedido de amizade',
      onClick: async () => {
        const fid = findFriendshipId(user.id);
        if (fid) await fetch(`/api/friends/${fid}/accept`, { method: 'POST', credentials: 'include' });
        SFX.streakUp();
        refreshFriendsBadge();
      },
    });
  } else {
    items.push({
      icon: '➕',
      label: 'Adicionar amigo',
      onClick: async () => {
        await fetch('/api/friends/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username: user.username }),
        });
        refreshFriendsBadge();
      },
    });
  }

  // Convite direto pelo perfil — pra quem tá com dificuldade de entrar pelo
  // link solto por fora do app: adiciona a pessoa já como membro do
  // servidor, ou manda pra ela mesma uma mensagem com o link pronto (que já
  // vai direto pro servidor ao clicar, sem precisar copiar/colar nada).
  items.push({
    icon: '➕',
    label: 'Adicionar a um servidor meu',
    onClick: (evt) => pickMyServerAndRun(evt, (category) => addUserToServer(user, category)),
  });
  items.push({
    icon: '📨',
    label: 'Mandar convite por mensagem',
    onClick: (evt) => pickMyServerAndRun(evt, (category) => sendInviteMessage(user, category)),
  });

  items.push({
    icon: '👍',
    label: 'Endossar (reputação)',
    onClick: async () => {
      const res = await fetch(`/api/users/${user.id}/endorse`, { method: 'POST', credentials: 'include' });
      if (res.ok) showCopyToast(`Você endossou ${user.username}!`);
      else {
        const d = await res.json().catch(() => ({}));
        alert(d.error || 'Erro ao endossar');
      }
    },
  });
  items.push({
    icon: '🚫',
    label: 'Bloquear usuário',
    danger: true,
    onClick: async () => {
      if (!confirm(`Bloquear ${user.username}? Vocês não vão mais conseguir se mandar mensagem, convite ou pedido de amizade.`)) return;
      await blockUser(user.id);
      refreshFriendsBadge();
    },
  });

  if (me.is_admin) {
    items.push({ separator: true });
    items.push({
      icon: '🔨',
      label: 'Banir do NEXT GAME',
      danger: true,
      onClick: async () => {
        if (!confirm(`Banir ${user.username} do NEXT GAME? Essa ação impede a pessoa de acessar a conta.`)) return;
        await fetch(`/api/admin/users/${user.id}/ban`, { method: 'POST', credentials: 'include' });
        allUsers = allUsers.filter((u) => u.id !== user.id);
        renderMembers();
      },
    });
  }

  return items;
}

// Menu de contexto (botão direito) de um canal — modo lento e somente-leitura
// são reforçados de novo no servidor (o botão aparece pra todo mundo, mas só
// quem tem permissão de fato consegue salvar; sem permissão, o servidor
// devolve erro e a gente só mostra um alerta).
function buildChannelContextMenuItems(ch) {
  return [
    {
      icon: '🔗',
      label: 'Copiar link do canal',
      onClick: async () => {
        const url = await buildChannelInviteLink(ch);
        navigator.clipboard.writeText(url).catch(() => {});
        showCopyToast('Link do canal copiado! Quem não é membro entra no servidor automático.');
      },
    },
    {
      icon: '✏️',
      label: 'Renomear sala',
      onClick: async () => {
        const novoNome = prompt('Novo nome da sala:', ch.name);
        if (novoNome === null) return;
        const trimmed = novoNome.trim();
        if (!trimmed || trimmed === ch.name) return;
        const res = await fetch(`/api/channels/${ch.id}/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ name: trimmed }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          alert(data.error || 'Erro ao renomear a sala');
          return;
        }
        showCopyToast('Sala renomeada!');
      },
    },
    { separator: true },
    {
      icon: '🐢',
      label: 'Configurar modo lento',
      onClick: async () => {
        const seconds = prompt('Modo lento: quantos segundos entre mensagens? (0 pra desligar)', '0');
        if (seconds === null) return;
        const parsed = Math.max(0, parseInt(seconds, 10) || 0);
        const res = await fetch(`/api/channels/${ch.id}/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ slow_mode_seconds: parsed }),
        });
        const data = await res.json();
        if (!res.ok) alert(data.error || 'Erro ao configurar modo lento');
        else showCopyToast(parsed > 0 ? `Modo lento: ${parsed}s` : 'Modo lento desligado');
      },
    },
    {
      icon: '🔒',
      label: 'Alternar canal somente-leitura',
      onClick: async () => {
        const wantsReadOnly = confirm('Deixar esse canal SOMENTE-LEITURA (só quem gerencia consegue postar)? Cancelar = tirar o somente-leitura.');
        const res = await fetch(`/api/channels/${ch.id}/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ read_only: wantsReadOnly }),
        });
        const data = await res.json();
        if (!res.ok) alert(data.error || 'Erro ao configurar canal');
        else showCopyToast(wantsReadOnly ? 'Canal em somente-leitura' : 'Canal normal de novo');
      },
    },
    {
      icon: '🎭',
      label: 'Restringir por cargo',
      onClick: () => openChannelAccessModal(ch),
    },
    { separator: true },
    {
      icon: '🗑️',
      label: 'Apagar sala',
      danger: true,
      onClick: async () => {
        if (!confirm(`Apagar a sala "${ch.name}"? As mensagens dela somem pra sempre. Isso não pode ser desfeito.`)) return;
        const res = await fetch(`/api/channels/${ch.id}`, { method: 'DELETE', credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          alert(data.error || 'Erro ao apagar a sala');
          return;
        }
        showCopyToast('Sala apagada.');
      },
    },
  ];
}

// ---------- CANAL PRIVADO POR CARGO ----------

const modalChannelAccess = document.getElementById('modal-channel-access');
let channelAccessTarget = null;

async function openChannelAccessModal(ch) {
  channelAccessTarget = ch;
  const listEl = document.getElementById('channel-access-roles-list');
  listEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  modalChannelAccess.classList.remove('hidden');

  const [rolesRes, accessRes] = await Promise.all([
    fetch(`/api/servers/${encodeURIComponent(ch.category)}/roles`, { credentials: 'include' }),
    fetch(`/api/channels/${ch.id}/access`, { credentials: 'include' }),
  ]);
  if (!rolesRes.ok || !accessRes.ok) {
    const d = await (rolesRes.ok ? accessRes : rolesRes).json().catch(() => ({}));
    listEl.innerHTML = `<p class="empty-hint">${escapeHtml(d.error || 'Erro ao carregar')}</p>`;
    return;
  }
  const roles = await rolesRes.json();
  const access = await accessRes.json();
  const allowedIds = new Set(access.role_ids || []);

  if (roles.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Esse servidor ainda não tem cargos criados — crie um cargo em "Gerenciar Servidor" primeiro.</p>';
    return;
  }
  listEl.innerHTML = roles
    .map(
      (r) => `
    <label class="checkbox-row">
      <input type="checkbox" value="${r.id}" ${allowedIds.has(r.id) ? 'checked' : ''} />
      <span style="color:${escapeHtml(r.color || '#99aab5')};">●</span> ${escapeHtml(r.name)}
    </label>
  `
    )
    .join('');
}

document.getElementById('btn-close-channel-access').onclick = () => modalChannelAccess.classList.add('hidden');
document.getElementById('btn-save-channel-access').onclick = async () => {
  if (!channelAccessTarget) return;
  const roleIds = [...document.querySelectorAll('#channel-access-roles-list input[type=checkbox]:checked')].map(
    (el) => el.value
  );
  const res = await fetch(`/api/channels/${channelAccessTarget.id}/access`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ role_ids: roleIds }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Erro ao salvar');
    return;
  }
  modalChannelAccess.classList.add('hidden');
  showCopyToast(roleIds.length > 0 ? 'Canal restrito por cargo!' : 'Canal voltou a ser visível pra todo mundo.');
  // A lista de canais pode ter mudado (um canal restrito pode sumir/aparecer
  // pra você mesmo, dependendo do cargo que você tem) — recarrega.
  loadChannels();
};

function buildUserContextMenuItems(user) {
  const items = [{ icon: '👤', label: 'Ver perfil', onClick: () => openProfilePreview(user) }];
  const actions = userActionItems(user);
  if (actions.length > 0) items.push({ separator: true }, ...actions);
  return items;
}

// ---------- PREVIEW DE PERFIL (ver foto de perfil grande) ----------

const modalProfilePreview = document.getElementById('modal-profile-preview');

async function openProfilePreview(user) {
  const avatarEl = document.getElementById('profile-preview-avatar');
  avatarEl.innerHTML = renderAvatarHtml(user);
  avatarEl.className = 'profile-preview-avatar ' + avatarFrameClass(user);
  document.getElementById('profile-preview-username').textContent = user.username + (user.is_admin ? ' 👑' : '');
  document.getElementById('profile-preview-status').textContent = user.status_message ? '🎮 ' + user.status_message : '';

  // Identificador estilo Discord (@Username#1234) — sistema de hashtag.
  const tag = userTag(user);
  document.getElementById('profile-preview-tag').textContent = tag;
  document.getElementById('profile-preview-copy-id').onclick = () => {
    navigator.clipboard.writeText(tag).then(
      () => showCopyToast('Identificador copiado!'),
      () => showCopyToast('Não foi possível copiar — copia manual: ' + tag)
    );
  };

  const actionsEl = document.getElementById('profile-preview-actions');
  actionsEl.innerHTML = '';
  userActionItems(user).forEach((item) => {
    if (item.separator) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'profile-preview-action-btn' + (item.danger ? ' profile-preview-action-danger' : '');
    btn.innerHTML = `${item.icon} ${escapeHtml(item.label)}`;
    btn.onclick = (e) => item.onClick(e);
    actionsEl.appendChild(btn);
  });

  document.querySelectorAll('#modal-profile-preview .manage-tab').forEach((t, i) => t.classList.toggle('active', i === 0));
  document.querySelectorAll('#modal-profile-preview .manage-tab-panel').forEach((p, i) => p.classList.toggle('hidden', i !== 0));
  modalProfilePreview.classList.remove('hidden');

  const [profileRes, gamesRes] = await Promise.all([
    fetch(`/api/users/${user.id}/profile`, { credentials: 'include' }),
    fetch(`/api/game-profiles/${user.id}`, { credentials: 'include' }),
  ]);
  const profile = await profileRes.json();
  const games = await gamesRes.json();
  if (!profileRes.ok) return;

  document.getElementById('profile-stats-row').innerHTML = `
    <div class="profile-stat"><span class="profile-stat-num">${profile.level}</span><span class="profile-stat-label">Nível</span></div>
    <div class="profile-stat"><span class="profile-stat-num">${profile.points}</span><span class="profile-stat-label">XP</span></div>
    <div class="profile-stat"><span class="profile-stat-num">${profile.tournament_wins}</span><span class="profile-stat-label">🏆 Troféus</span></div>
    <div class="profile-stat"><span class="profile-stat-num">${profile.badge_count}</span><span class="profile-stat-label">🎖️ Conquistas</span></div>
  `;

  const memberSince = new Date(profile.created_at).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  document.getElementById('profile-tab-geral').innerHTML = `
    ${profile.bio ? `<p style="color:#dbdee1; font-size:13px;">${escapeHtml(profile.bio)}</p>` : '<p class="empty-hint">Sem bio ainda.</p>'}
    <p class="hint">📍 ${profile.country ? escapeHtml(profile.country) : 'País não informado'} · Membro desde ${memberSince}</p>
    ${profile.favorite_games.length ? `<p class="hint">🎮 Jogos favoritos: ${profile.favorite_games.map(escapeHtml).join(', ')}</p>` : ''}
  `;

  document.getElementById('profile-tab-estatisticas').innerHTML = `
    <div class="profile-stats-row" style="margin-bottom:0;">
      <div class="profile-stat"><span class="profile-stat-num">${profile.message_count}</span><span class="profile-stat-label">Mensagens</span></div>
      <div class="profile-stat"><span class="profile-stat-num">${profile.login_streak || 0}</span><span class="profile-stat-label">Sequência</span></div>
      <div class="profile-stat"><span class="profile-stat-num">${profile.longest_streak || 0}</span><span class="profile-stat-label">Recorde</span></div>
      <div class="profile-stat"><span class="profile-stat-num">${profile.reputation || 0}</span><span class="profile-stat-label">👍 Reputação</span></div>
    </div>
  `;

  const gamesTab = document.getElementById('profile-tab-jogos');
  if (games.length === 0) {
    gamesTab.innerHTML = '<p class="empty-hint">Nenhum perfil de jogo cadastrado ainda.</p>';
  } else {
    gamesTab.innerHTML = games
      .map(
        (g) => `
      <div class="settings-row">
        <div class="settings-row-info">
          <span class="settings-row-title">🎮 ${escapeHtml(g.game)} ${g.rank ? '— ' + escapeHtml(g.rank) : ''}</span>
          <span class="settings-row-meta">${g.role ? escapeHtml(g.role) + ' · ' : ''}${g.hours}h · ${g.wins}V/${g.losses}D</span>
        </div>
      </div>`
      )
      .join('');
  }

  const activityRes = await fetch('/api/feed', { credentials: 'include' });
  const feed = await activityRes.json();
  const myFeed = feed.filter((p) => p.user_id === user.id).slice(0, 10);
  const activityTab = document.getElementById('profile-tab-atividade');
  activityTab.innerHTML =
    myFeed.length === 0
      ? '<p class="empty-hint">Nenhuma atividade recente.</p>'
      : myFeed
          .map(
            (p) => `<div class="settings-row"><div class="settings-row-info"><span class="settings-row-title">${escapeHtml(p.text || '')}</span><span class="settings-row-meta">${new Date(p.created_at).toLocaleString('pt-BR')}</span></div></div>`
          )
          .join('');
}
document.getElementById('btn-close-profile-preview').onclick = () => modalProfilePreview.classList.add('hidden');
document.querySelectorAll('#modal-profile-preview .manage-tab').forEach((tabBtn) => {
  tabBtn.onclick = () => {
    document.querySelectorAll('#modal-profile-preview .manage-tab').forEach((t) => t.classList.remove('active'));
    tabBtn.classList.add('active');
    document.querySelectorAll('#modal-profile-preview .manage-tab-panel').forEach((p) => p.classList.add('hidden'));
    document.getElementById('profile-tab-' + tabBtn.dataset.profileTab).classList.remove('hidden');
  };
});

// ---------- CRIAR SALA (modal) ----------

const modalNewRoom = document.getElementById('modal-new-room');

// Abre o modal de criar SALA — sempre dentro do servidor já ativo. Não cria
// mais servidor implicitamente: isso agora só acontece via modal-new-server.
function openNewRoomModal(category) {
  if (!category) {
    alert('Crie ou entre num servidor primeiro pra poder criar uma sala nele.');
    return;
  }
  document.getElementById('room-error').textContent = '';
  document.getElementById('form-new-room').reset();
  document.getElementById('room-category').value = category;
  updateRoomVoiceFieldsVisibility();
  modalNewRoom.classList.remove('hidden');
  document.getElementById('room-name').focus();
}

// "+" dentro do servidor atual: cria uma sala nesse mesmo servidor.
document.getElementById('btn-new-room').onclick = () => openNewRoomModal(activeServerCategory);

document.getElementById('btn-cancel-room').onclick = () => modalNewRoom.classList.add('hidden');

// Campos de tipo de sala de voz só aparecem quando o tipo escolhido é "voz",
// e o campo de jogo só aparece quando o tipo de voz é "jogo".
function updateRoomVoiceFieldsVisibility() {
  const isVoice = document.getElementById('room-type').value === 'voz';
  document.getElementById('room-voice-type-fields').classList.toggle('hidden', !isVoice);
  const isGame = isVoice && document.getElementById('room-voice-type').value === 'jogo';
  document.getElementById('room-voice-game-field').classList.toggle('hidden', !isGame);
}
document.getElementById('room-type').onchange = updateRoomVoiceFieldsVisibility;
document.getElementById('room-voice-type').onchange = updateRoomVoiceFieldsVisibility;

document.getElementById('form-new-room').onsubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById('room-name').value.trim();
  const category = document.getElementById('room-category').value.trim();
  const type = document.getElementById('room-type').value;
  const voice_type = type === 'voz' ? document.getElementById('room-voice-type').value : undefined;
  const voice_game = voice_type === 'jogo' ? document.getElementById('room-voice-game').value.trim() : undefined;
  const errorEl = document.getElementById('room-error');
  errorEl.textContent = '';

  try {
    const res = await fetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, category, type, voice_type, voice_game }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Erro ao criar sala';
      return;
    }
    modalNewRoom.classList.add('hidden');
    activeServerCategory = data.category;
    await loadChannels();
  } catch (err) {
    errorEl.textContent = 'Erro de conexão com o servidor';
  }
};

// Sala Rápida: um clique cria uma sala de voz temporária no servidor ativo.
document.getElementById('btn-quick-room').onclick = async () => {
  if (!activeServerCategory) {
    alert('Crie ou entre num servidor primeiro.');
    return;
  }
  try {
    const res = await fetch('/api/channels/quick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ category: activeServerCategory }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Erro ao criar sala rápida');
      return;
    }
    await loadChannels();
    showCopyToast('Sala rápida criada! Ela some sozinha quando todo mundo sair.');
  } catch (err) {
    alert('Erro de conexão com o servidor');
  }
};

// ---------- CRIAR SERVIDOR (modal separado — não cria sala junto) ----------

const modalNewServer = document.getElementById('modal-new-server');

function openNewServerModal() {
  document.getElementById('new-server-error').textContent = '';
  document.getElementById('form-new-server').reset();
  buildIconRow('server-icon-row', 'server-icon-input');
  modalNewServer.classList.remove('hidden');
  document.getElementById('server-name').focus();
}

// "+" da sidebar: cria um servidor novo (vazio, com um canal #geral pronto).
document.getElementById('btn-new-server').onclick = () => openNewServerModal();
document.getElementById('btn-cancel-new-server').onclick = () => modalNewServer.classList.add('hidden');

document.getElementById('form-new-server').onsubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById('server-name').value.trim();
  const icon = document.getElementById('server-icon-input').value || '🎮';
  const errorEl = document.getElementById('new-server-error');
  errorEl.textContent = '';

  try {
    const res = await fetch('/api/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, icon }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Erro ao criar servidor';
      return;
    }
    modalNewServer.classList.add('hidden');
    activeServerCategory = data.category; // já entra direto no servidor recém-criado
    await loadChannels();
  } catch (err) {
    errorEl.textContent = 'Erro de conexão com o servidor';
  }
};

// ---------- EDITAR PERFIL (email / senha / avatar / status) ----------

const POPULAR_GAMES = [
  'Valorant', 'League of Legends', 'CS2', 'Fortnite', 'Minecraft', 'GTA V',
  'Free Fire', 'Apex Legends', 'Overwatch 2', 'Dota 2', 'Rocket League',
  'FIFA / EA FC', 'Call of Duty', 'Roblox', 'Among Us', 'Genshin Impact',
];

const modalProfile = document.getElementById('modal-profile');
let pendingAvatar = undefined; // undefined = não mexeu, string = novo valor (ou '' pra remover)

// Monta o dropdown de jogos populares + "Trabalhando" + "Outro" (texto livre)
const profileStatusSelect = document.getElementById('profile-status-select');
profileStatusSelect.innerHTML =
  '<option value="">Nada no momento</option>' +
  POPULAR_GAMES.map((g) => `<option value="${escapeHtml(g)}">🎮 ${escapeHtml(g)}</option>`).join('') +
  '<option value="__custom__">✏️ Outro (digitar)</option>';

profileStatusSelect.onchange = () => {
  const isCustom = profileStatusSelect.value === '__custom__';
  document.getElementById('profile-status').classList.toggle('hidden', !isCustom);
  if (isCustom) document.getElementById('profile-status').focus();
};

function setProfileStatusFields(statusMessage) {
  const value = statusMessage || '';
  const isKnownGame = POPULAR_GAMES.includes(value);
  if (!value) {
    profileStatusSelect.value = '';
    document.getElementById('profile-status').value = '';
    document.getElementById('profile-status').classList.add('hidden');
  } else if (isKnownGame) {
    profileStatusSelect.value = value;
    document.getElementById('profile-status').value = '';
    document.getElementById('profile-status').classList.add('hidden');
  } else {
    profileStatusSelect.value = '__custom__';
    document.getElementById('profile-status').value = value;
    document.getElementById('profile-status').classList.remove('hidden');
  }
}

function getProfileStatusValue() {
  if (profileStatusSelect.value === '__custom__') {
    return document.getElementById('profile-status').value.trim();
  }
  return profileStatusSelect.value;
}

document.getElementById('own-profile-copy-id').onclick = () => {
  const tag = userTag(me);
  navigator.clipboard.writeText(tag).then(
    () => showCopyToast('Identificador copiado!'),
    () => showCopyToast('Não foi possível copiar — copia manual: ' + tag)
  );
};

function updateAvatarPreview() {
  const preview = document.getElementById('profile-avatar-preview');
  const avatarValue = pendingAvatar !== undefined ? pendingAvatar : me.avatar;
  preview.innerHTML = renderAvatarHtml({ username: me.username, avatar: avatarValue });
}

// Monta a fileira de emojis pra escolher como avatar "criado na hora"
const emojiRow = document.getElementById('avatar-emoji-row');
AVATAR_EMOJIS.forEach((emoji) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = emoji;
  btn.style.background = '#5865f2';
  btn.onclick = () => {
    pendingAvatar = 'emoji:' + emoji + ':#5865f2';
    updateAvatarPreview();
  };
  emojiRow.appendChild(btn);
});

document.getElementById('profile-avatar-file').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      // Redimensiona no navegador antes de mandar pro servidor, pra não
      // encher o banco de dados com fotos gigantes.
      const size = 160;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      const scale = Math.max(size / img.width, size / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      pendingAvatar = canvas.toDataURL('image/jpeg', 0.82);
      updateAvatarPreview();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
};

document.getElementById('btn-edit-profile').onclick = () => {
  document.getElementById('profile-error').textContent = '';
  document.getElementById('own-profile-tag').textContent = userTag(me);
  document.getElementById('profile-email').value = me.email || '';
  document.getElementById('profile-presence-select').value = me.presence_status || 'online';
  setProfileStatusFields(me.status_message);
  document.getElementById('profile-bio').value = me.bio || '';
  document.getElementById('profile-region').value = me.region || '';
  document.getElementById('profile-language').value = me.language || '';
  document.getElementById('profile-new-password').value = '';
  document.getElementById('profile-current-password').value = '';
  pendingAvatar = undefined;
  updateAvatarPreview();
  document.querySelectorAll('#modal-profile .settings-sidebar-item').forEach((t, i) => t.classList.toggle('active', i === 0));
  document.querySelectorAll('#modal-profile .manage-tab-panel').forEach((p, i) => p.classList.toggle('hidden', i !== 0));
  modalProfile.classList.remove('hidden');
};
document.getElementById('btn-cancel-profile').onclick = () => modalProfile.classList.add('hidden');

// Status (Online/Ausente/Ocupado/Invisível) aplica na hora, sem esperar
// salvar o resto do formulário — igual um seletor de presença de verdade.
document.getElementById('profile-presence-select').onchange = async (e) => {
  const presence_status = e.target.value;
  const res = await fetch('/api/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ presence_status }),
  });
  if (res.ok) {
    me.presence_status = presence_status;
    showCopyToast('Status atualizado!');
  }
};

document.getElementById('form-profile').onsubmit = async (e) => {
  e.preventDefault();
  const email = document.getElementById('profile-email').value.trim();
  const password = document.getElementById('profile-new-password').value;
  const currentPassword = document.getElementById('profile-current-password').value;
  const statusMessage = getProfileStatusValue();
  const errorEl = document.getElementById('profile-error');
  errorEl.textContent = '';

  const body = {};
  if (email && email !== me.email) body.email = email;
  if (password) body.password = password;
  if (body.email || body.password) body.currentPassword = currentPassword;
  if (statusMessage !== (me.status_message || '')) body.status_message = statusMessage;
  if (pendingAvatar !== undefined) body.avatar = pendingAvatar;
  const bio = document.getElementById('profile-bio').value.trim();
  const region = document.getElementById('profile-region').value.trim();
  const language = document.getElementById('profile-language').value.trim();
  if (bio !== (me.bio || '')) body.bio = bio;
  if (region !== (me.region || '')) body.region = region;
  if (language !== (me.language || '')) body.language = language;

  if (Object.keys(body).length === 0) {
    modalProfile.classList.add('hidden');
    return;
  }

  try {
    const res = await fetch('/api/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Erro ao salvar';
      return;
    }
    modalProfile.classList.add('hidden');
    if (body.email) me.email = email;
    if ('status_message' in data) me.status_message = data.status_message;
    if ('avatar' in data) me.avatar = data.avatar;
    if ('bio' in data) me.bio = data.bio;
    if ('region' in data) me.region = data.region;
    if ('language' in data) me.language = data.language;
    // Atualiza o avatar/nome que aparecem na hora (rodapé da sidebar, mensagens
    // já na tela) — sem isso, a foto só aparecia certa depois de recarregar.
    pendingAvatar = undefined;
    updateNavbarProfile();
    renderAvatarInto(document.getElementById('me-avatar'), me);
    loadMembers();
    alert('Perfil atualizado!');
  } catch (err) {
    errorEl.textContent = 'Erro de conexão com o servidor';
  }
};

// ---------- ABAS DE CONFIGURAÇÕES: Segurança (2FA + sessões), Privacidade
// (bloqueados) e Notificações ----------

document.querySelectorAll('#modal-profile .settings-sidebar-item').forEach((tabBtn) => {
  tabBtn.onclick = async () => {
    document.querySelectorAll('#modal-profile .settings-sidebar-item').forEach((t) => t.classList.remove('active'));
    tabBtn.classList.add('active');
    document.querySelectorAll('#modal-profile .manage-tab-panel').forEach((p) => p.classList.add('hidden'));
    const tab = tabBtn.dataset.settingsTab;
    document.getElementById('settings-tab-' + tab).classList.remove('hidden');
    if (tab === 'seguranca') {
      load2FAStatus();
      loadSessions();
    }
    if (tab === 'privacidade') {
      loadBlockedUsers();
      loadIntegrations();
    }
    if (tab === 'notificacoes') loadNotificationPrefs();
  };
});

async function load2FAStatus() {
  const res = await fetch('/api/2fa/status', { credentials: 'include' });
  const data = await res.json();
  document.getElementById('twofa-off-view').classList.toggle('hidden', data.enabled);
  document.getElementById('twofa-setup-view').classList.add('hidden');
  document.getElementById('twofa-on-view').classList.toggle('hidden', !data.enabled);
}

document.getElementById('btn-2fa-start').onclick = async () => {
  const res = await fetch('/api/2fa/setup', { method: 'POST', credentials: 'include' });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'Erro ao iniciar 2FA');
  document.getElementById('twofa-qr').src = data.qr;
  document.getElementById('twofa-confirm-code').value = '';
  document.getElementById('twofa-error').textContent = '';
  document.getElementById('twofa-off-view').classList.add('hidden');
  document.getElementById('twofa-setup-view').classList.remove('hidden');
};

document.getElementById('btn-2fa-confirm').onclick = async () => {
  const code = document.getElementById('twofa-confirm-code').value.trim();
  const errorEl = document.getElementById('twofa-error');
  errorEl.textContent = '';
  const res = await fetch('/api/2fa/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error || 'Código incorreto';
    return;
  }
  SFX.reward && SFX.reward();
  load2FAStatus();
};

document.getElementById('btn-2fa-disable').onclick = async () => {
  const currentPassword = document.getElementById('twofa-disable-password').value;
  if (!currentPassword) return alert('Digite a senha atual pra desativar');
  if (!confirm('Tem certeza que quer desativar o 2FA?')) return;
  const res = await fetch('/api/2fa/disable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ currentPassword }),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'Erro ao desativar');
  document.getElementById('twofa-disable-password').value = '';
  load2FAStatus();
};

async function loadSessions() {
  const listEl = document.getElementById('sessions-list');
  listEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch('/api/sessions', { credentials: 'include' });
  const sessions = await res.json();
  listEl.innerHTML = '';
  sessions.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const when = new Date(s.last_seen_at).toLocaleString('pt-BR');
    row.innerHTML = `
      <div class="settings-row-info">
        <span class="settings-row-title">${escapeHtml((s.user_agent || 'Dispositivo desconhecido').slice(0, 60))}</span>
        <span class="settings-row-meta">Visto por último: ${when}${s.is_current ? ' — este dispositivo' : ''}</span>
      </div>
      ${s.is_current ? '<span class="settings-row-badge">ATUAL</span>' : '<button type="button" class="session-revoke-btn">Encerrar</button>'}
    `;
    const revokeBtn = row.querySelector('.session-revoke-btn');
    if (revokeBtn) {
      revokeBtn.onclick = async () => {
        await fetch(`/api/sessions/${s.id}/revoke`, { method: 'POST', credentials: 'include' });
        loadSessions();
      };
    }
    listEl.appendChild(row);
  });
}

document.getElementById('btn-revoke-other-sessions').onclick = async () => {
  if (!confirm('Isso desconecta sua conta de todos os outros dispositivos. Continuar?')) return;
  await fetch('/api/sessions/revoke-others', { method: 'POST', credentials: 'include' });
  loadSessions();
};

async function loadBlockedUsers() {
  const listEl = document.getElementById('blocked-users-list');
  listEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch('/api/blocked-users', { credentials: 'include' });
  const rows = await res.json();
  if (rows.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Você não bloqueou ninguém.</p>';
    return;
  }
  listEl.innerHTML = '';
  rows.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.innerHTML = `
      <div class="settings-row-info">
        <span class="settings-row-title">${escapeHtml(u.username)}</span>
      </div>
      <button type="button" class="unblock-btn">Desbloquear</button>
    `;
    row.querySelector('.unblock-btn').onclick = async () => {
      await fetch(`/api/blocked-users/${u.id}`, { method: 'DELETE', credentials: 'include' });
      loadBlockedUsers();
    };
    listEl.appendChild(row);
  });
}

// Chamado pelo menu de contexto (botão direito num usuário) — ver mais abaixo.
async function blockUser(userId) {
  await fetch(`/api/blocked-users/${userId}`, { method: 'POST', credentials: 'include' });
}

const NOTIFICATION_PREF_LABELS = {
  mensagem: 'Mensagem recebida',
  convite_amizade: 'Convite de amizade',
  convite_servidor: 'Convite para servidor',
  torneio: 'Torneio próximo',
  conquista: 'Conquista desbloqueada',
  transmissao: 'Transmissão ao vivo',
};

async function loadNotificationPrefs() {
  const listEl = document.getElementById('notification-prefs-list');
  listEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch('/api/notification-prefs', { credentials: 'include' });
  const prefs = await res.json();
  listEl.innerHTML = '';
  Object.keys(NOTIFICATION_PREF_LABELS).forEach((key) => {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.innerHTML = `
      <div class="settings-row-info">
        <span class="settings-row-title">${NOTIFICATION_PREF_LABELS[key]}</span>
      </div>
      <label class="toggle-switch">
        <input type="checkbox" ${prefs[key] ? 'checked' : ''} />
        <span class="toggle-switch-track"></span>
      </label>
    `;
    row.querySelector('input').onchange = async (e) => {
      const updated = { ...prefs, [key]: e.target.checked };
      await fetch('/api/notification-prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(updated),
      });
      window.notificationPrefs = updated;
    };
    listEl.appendChild(row);
  });
  window.notificationPrefs = prefs;
}

// ---------- MENSAGENS FIXADAS ----------

async function loadPinnedMessages(channelId) {
  const listEl = document.getElementById('pinned-messages-list');
  listEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch(`/api/channels/${channelId}/pinned`, { credentials: 'include' });
  const rows = await res.json();
  if (rows.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Nenhuma mensagem fixada nesse canal ainda.</p>';
    return;
  }
  listEl.innerHTML = '';
  rows.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const when = new Date(m.created_at).toLocaleString('pt-BR');
    row.innerHTML = `
      <div class="settings-row-info">
        <span class="settings-row-title">${escapeHtml(m.username)}</span>
        <span class="settings-row-meta">${escapeHtml(m.content).slice(0, 140)}</span>
        <span class="settings-row-meta">${when}</span>
      </div>
    `;
    listEl.appendChild(row);
  });
}

document.getElementById('btn-pinned-messages').onclick = () => {
  if (!currentChannel) return;
  document.getElementById('modal-pinned-messages').dataset.channelId = currentChannel.id;
  loadPinnedMessages(currentChannel.id);
  document.getElementById('modal-pinned-messages').classList.remove('hidden');
};
document.getElementById('btn-close-pinned-messages').onclick = () =>
  document.getElementById('modal-pinned-messages').classList.add('hidden');

// Modal "Segurança e proteção de menores" (ECA Digital) — acessível tanto
// no rodapé da tela de login (antes de logar) quanto na aba Privacidade
// das Configurações (depois de logado). É só informativo, sem estado.
function openSafetyInfoModal(e) {
  if (e) e.preventDefault();
  document.getElementById('modal-safety-info').classList.remove('hidden');
}
document.getElementById('link-safety-info').onclick = openSafetyInfoModal;
const linkSafetySettings = document.getElementById('link-safety-info-settings');
if (linkSafetySettings) linkSafetySettings.onclick = openSafetyInfoModal;
document.getElementById('btn-close-safety-info').onclick = () =>
  document.getElementById('modal-safety-info').classList.add('hidden');

// ---------- FALE COM O SUPORTE (reclamação/dúvida) ----------
// Funciona tanto logado (pré-preenche com a conta) quanto deslogado — por
// isso fica acessível já na tela de login, sem precisar de sessão válida
// (útil inclusive pra quem foi banido e não consegue mais entrar).
function openSupportModal(e) {
  if (e) e.preventDefault();
  const guestFields = document.getElementById('support-guest-fields');
  guestFields.classList.toggle('hidden', !!me);
  document.getElementById('support-error').textContent = '';
  document.getElementById('support-success').classList.add('hidden');
  document.getElementById('form-support').classList.remove('hidden');
  document.getElementById('modal-support').classList.remove('hidden');
}
// Botão de baixar o app de desktop — removido temporariamente da tela de
// login (o app de desktop ainda está com um bug de tela preta em
// investigação). Quando o next-game-desktop estiver estável de novo, é só
// devolver o bloco <a id="link-download-desktop"> no index.html e a lógica
// de ativação aqui.

document.getElementById('link-support').onclick = openSupportModal;
const linkSupportSettings = document.getElementById('link-support-settings');
if (linkSupportSettings) linkSupportSettings.onclick = openSupportModal;
document.getElementById('btn-close-support').onclick = () => document.getElementById('modal-support').classList.add('hidden');

document.getElementById('form-support').onsubmit = async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('support-error');
  const okEl = document.getElementById('support-success');
  errEl.textContent = '';
  const body = {
    category: document.getElementById('support-category').value,
    subject: document.getElementById('support-subject').value.trim(),
    message: document.getElementById('support-message').value.trim(),
  };
  if (!me) {
    body.name = document.getElementById('support-name').value.trim();
    body.email = document.getElementById('support-email').value.trim();
  }
  try {
    const res = await fetch('/api/support/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Não deu pra enviar agora, tenta de novo em instantes.';
      return;
    }
    document.getElementById('form-support').classList.add('hidden');
    okEl.classList.remove('hidden');
  } catch (err) {
    errEl.textContent = 'Erro de conexão com o servidor';
  }
};

// Aviso de segurança pra contas sinalizadas como menores (ECA Digital) —
// some ao fechar e não volta por 7 dias, pra não incomodar toda vez que
// a pessoa abre o app.
function maybeShowMinorSafetyBanner() {
  if (!me || !me.is_minor) return;
  const dismissedAt = Number(localStorage.getItem('ng_minor_banner_dismissed_at') || 0);
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  if (Date.now() - dismissedAt < sevenDaysMs) return;
  document.getElementById('minor-safety-banner').classList.remove('hidden');
}
document.getElementById('minor-banner-link').onclick = openSafetyInfoModal;
document.getElementById('minor-banner-close').onclick = () => {
  localStorage.setItem('ng_minor_banner_dismissed_at', String(Date.now()));
  document.getElementById('minor-safety-banner').classList.add('hidden');
};

// ---------- NEXTGAME PLUS (assinatura via PayPal) ----------

function updatePlusBadgeUI() {
  const isPlus = isPlusUser();
  document.getElementById('navbar-plus-badge').classList.toggle('hidden', !isPlus);
  const menuLabel = document.getElementById('plus-menu-label');
  if (menuLabel) menuLabel.textContent = isPlus ? 'NEXTGAME PLUS (ativo)' : 'NEXTGAME PLUS';
}

let paypalSdkLoadedFor = null; // guarda o client-id já carregado, pra não injetar o script 2x

function loadPayPalSdk(clientId) {
  return new Promise((resolve, reject) => {
    if (paypalSdkLoadedFor === clientId && window.paypal) return resolve();
    const existing = document.getElementById('paypal-sdk-script');
    if (existing) existing.remove();
    const script = document.createElement('script');
    script.id = 'paypal-sdk-script';
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&vault=true&intent=subscription`;
    script.onload = () => {
      paypalSdkLoadedFor = clientId;
      resolve();
    };
    script.onerror = () => reject(new Error('Erro ao carregar o PayPal.'));
    document.head.appendChild(script);
  });
}

async function openPlusUpgradeModal() {
  document.getElementById('modal-plus-upgrade').classList.remove('hidden');
  const alreadyEl = document.getElementById('plus-already-active');
  const notConfiguredEl = document.getElementById('plus-not-configured');
  const buttonContainer = document.getElementById('paypal-button-container');
  const errorEl = document.getElementById('plus-error');
  errorEl.textContent = '';
  buttonContainer.innerHTML = '';
  alreadyEl.classList.add('hidden');
  notConfiguredEl.classList.add('hidden');

  if (isPlusUser()) {
    alreadyEl.classList.remove('hidden');
    return;
  }

  try {
    const res = await fetch('/api/paypal/config', { credentials: 'include' });
    const config = await res.json();
    if (!config.configured) {
      notConfiguredEl.classList.remove('hidden');
      return;
    }
    await loadPayPalSdk(config.clientId);
    window.paypal
      .Buttons({
        style: { shape: 'pill', color: 'gold', layout: 'vertical', label: 'subscribe' },
        createSubscription: (data, actions) => actions.subscription.create({ plan_id: config.planId }),
        onApprove: async (data) => {
          errorEl.textContent = 'Confirmando assinatura...';
          try {
            const confirmRes = await fetch('/api/paypal/confirm-subscription', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ subscriptionId: data.subscriptionID }),
            });
            const result = await confirmRes.json();
            if (!confirmRes.ok) throw new Error(result.error || 'Erro ao confirmar assinatura.');
            me.plan = 'plus';
            updatePlusBadgeUI();
            errorEl.textContent = '';
            alreadyEl.classList.remove('hidden');
            buttonContainer.innerHTML = '';
            loadUploadLimits();
            showCopyToast('🎉 Bem-vindo ao NEXTGAME PLUS!');
          } catch (err) {
            errorEl.textContent = err.message || 'Erro ao confirmar assinatura.';
          }
        },
        onError: () => {
          errorEl.textContent = 'Erro ao processar pagamento pelo PayPal.';
        },
      })
      .render('#paypal-button-container');
  } catch (err) {
    errorEl.textContent = err.message || 'Erro ao carregar o PayPal.';
  }
}

document.getElementById('nav-plus-upgrade').onclick = () => {
  document.getElementById('footer-more-menu').classList.add('hidden');
  openPlusUpgradeModal();
};
document.getElementById('btn-close-plus-upgrade').onclick = () =>
  document.getElementById('modal-plus-upgrade').classList.add('hidden');

// ---------- BUSCA DE MENSAGENS ----------

// Extrai o id da OUTRA pessoa a partir do id de canal de DM
// ('dm::idA::idB', ordenados) — evita precisar de outra chamada à API só
// pra descobrir quem é o "outro lado" de uma conversa que já está aberta.
function otherUserIdFromDmChannel(channelId) {
  if (!channelId || !channelId.startsWith('dm::')) return null;
  const parts = channelId.split('::');
  return parts[1] === me.id ? parts[2] : parts[1];
}

// "Convidar para jogar" e "Convidar para servidor" no cabeçalho da conversa
// — itens 6/7 do plano de navegação do chat. Reaproveita pickMyServerAndRun
// e sendInviteMessage (já existiam pro menu de perfil) pro segundo botão.
document.getElementById('btn-invite-to-play').onclick = (e) => {
  if (!currentChannel) return;
  const games = [
    { icon: '🎯', label: 'Valorant' },
    { icon: '🔫', label: 'Fortnite' },
    { icon: '💣', label: 'CS2' },
    { icon: '🎮', label: 'Outro jogo...' },
  ];
  showContextMenu(
    e.clientX,
    e.clientY,
    games.map((g) => ({
      icon: g.icon,
      label: g.label,
      onClick: () => {
        const gameName = g.label === 'Outro jogo...' ? (prompt('Qual jogo?') || '').trim() : g.label;
        if (!gameName) return;
        socket.emit('chat:message', {
          channelId: currentChannel.id,
          content: `${GAME_INVITE_PREFIX}${JSON.stringify({ game: gameName, from: me.username })}`,
        });
        showCopyToast(`Convite pra jogar ${gameName} enviado!`);
      },
    }))
  );
};

document.getElementById('btn-invite-to-server').onclick = (e) => {
  if (!currentChannel) return;
  const targetId = otherUserIdFromDmChannel(currentChannel.id);
  if (!targetId) return;
  const targetUsername = (currentChannel.name || '').replace(/^💬\s*/, '');
  pickMyServerAndRun(e, (category) => sendInviteMessage({ id: targetId, username: targetUsername }, category));
};

let searchDebounceTimer = null;

document.getElementById('btn-search-messages').onclick = () => {
  if (!currentChannel) return;
  document.getElementById('search-messages-input').value = '';
  document.getElementById('search-messages-results').innerHTML = '';
  document.getElementById('modal-search-messages').classList.remove('hidden');
  document.getElementById('search-messages-input').focus();
};
document.getElementById('btn-close-search-messages').onclick = () =>
  document.getElementById('modal-search-messages').classList.add('hidden');

document.getElementById('search-messages-input').oninput = (e) => {
  clearTimeout(searchDebounceTimer);
  const q = e.target.value.trim();
  const resultsEl = document.getElementById('search-messages-results');
  if (q.length < 2) {
    resultsEl.innerHTML = '';
    return;
  }
  searchDebounceTimer = setTimeout(async () => {
    if (!currentChannel) return;
    const res = await fetch(`/api/channels/${currentChannel.id}/search?q=${encodeURIComponent(q)}`, {
      credentials: 'include',
    });
    const rows = await res.json();
    resultsEl.innerHTML = '';
    if (rows.length === 0) {
      resultsEl.innerHTML = '<p class="empty-hint">Nada encontrado.</p>';
      return;
    }
    rows.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'settings-row';
      const when = new Date(m.created_at).toLocaleString('pt-BR');
      row.innerHTML = `
        <div class="settings-row-info">
          <span class="settings-row-title">${escapeHtml(m.username)}</span>
          <span class="settings-row-meta">${escapeHtml(m.content).slice(0, 140)}</span>
          <span class="settings-row-meta">${when}</span>
        </div>
      `;
      resultsEl.appendChild(row);
    });
  }, 300);
};

// Clicar num canal SEMPRE troca o que aparece no painel principal. Só entra
// (ou sai) de uma conexão de voz de verdade quando faz sentido — navegar por
// canais de texto NÃO desconecta você da call, igual Discord.
// `options.autoConnect` pula a telinha de "Entrar na chamada" e conecta na
// hora — usado só quando a intenção já é 100% clara (ligar pra um amigo,
// atender uma chamada recebida), igual o botão de ligação do Discord.
function selectChannel(channel, options = {}) {
  const autoConnect = !!options.autoConnect;
  const isDm = channel.type !== 'voz' && channel.id.startsWith('dm::');

  // sai do canal de TEXTO anterior (sala de voz não é "deixada" só por trocar de tela)
  if (currentChannel && currentChannel.type === 'texto') {
    socket.emit('channel:leave', currentChannel.id);
  }

  currentChannel = channel;
  document.getElementById('current-channel-name').textContent =
    (channel.type === 'voz' ? '🔊 ' : '# ') + channel.name;
  document.getElementById('home-panel').classList.add('hidden');
  document.getElementById('friends-panel').classList.add('hidden');
  setNavActive('nav-inicio', false);
  stopHomeAutoRefresh();
  // Canal de servidor: escolher fecha o popup de canais, sobra mais tela pro
  // conteúdo. DM: a coluna do meio agora é a lista de conversas — fica
  // aberta o tempo todo, igual Discord, pra trocar de pessoa rápido.
  if (!isDm) setChannelSidebarOpen(false);
  if (isDm) {
    document.querySelectorAll('#dm-conversations-list .friend-row').forEach((row) => {
      row.classList.toggle('friend-row-active', row.dataset.searchName === channel.name.replace('💬 ', '').toLowerCase());
    });
  }

  if (channel.type === 'voz') {
    document.getElementById('text-panel').classList.add('hidden');
    document.getElementById('voice-panel').classList.remove('hidden');
    if (autoConnect && connectedVoiceRoomId !== channel.id) {
      if (connectedVoiceRoomId) disconnectVoice();
      // Mesma correção do botão "Entrar na chamada": só atualiza a tela
      // depois que connectVoice() (assíncrono) realmente terminar.
      connectVoice(channel.id).then(() => updateVoicePanelView(channel));
    } else {
      updateVoicePanelView(channel);
    }
    // se já está conectado nessa mesma sala, só mostra a tela de novo — os
    // tiles de vídeo/áudio continuam vivos desde a última vez.
  } else {
    document.getElementById('voice-panel').classList.add('hidden');
    document.getElementById('text-panel').classList.remove('hidden');
    joinTextChannel(channel.id);
  }

  markServerRead(channel.category);
  renderCategories(allChannels);
  updateClearChannelButton();

  // "Convidar para jogar" e "Convidar para servidor" só fazem sentido numa
  // conversa direta (item 6/7 do plano de navegação do chat) — não aparecem
  // em canal de servidor, onde já tem outros jeitos de convidar gente.
  document.getElementById('btn-invite-to-play').classList.toggle('hidden', !isDm);
  document.getElementById('btn-invite-to-server').classList.toggle('hidden', !isDm);
  // Um canal de verdade está selecionado agora (servidor ou DM) — os ícones
  // de busca/fixados/membros voltam a fazer sentido no cabeçalho.
  document.getElementById('btn-search-messages').classList.remove('hidden');
  document.getElementById('btn-pinned-messages').classList.remove('hidden');
  document.getElementById('btn-toggle-members').classList.remove('hidden');
}

// Alterna entre a tela de "Entrar na chamada" (não conectado ainda) e a view
// de dentro da call (vídeo, controles etc), sem duplicar nenhum HTML.
function updateVoicePanelView(channel) {
  const isConnected = connectedVoiceRoomId === channel.id;
  document.getElementById('voice-preview').classList.toggle('hidden', isConnected);
  document.getElementById('voice-incall').classList.toggle('hidden', !isConnected);
  if (!isConnected) renderVoicePreview(channel);
}

function renderVoicePreview(channel) {
  document.getElementById('voice-preview-name').textContent = channel.name;
  const participants = voiceParticipants[channel.id] || [];
  const listEl = document.getElementById('voice-preview-participants');
  if (participants.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Ninguém está em voz</p>';
  } else {
    listEl.innerHTML = '';
    participants.forEach((p) => {
      const chip = document.createElement('div');
      chip.className = 'voice-preview-participant';
      chip.innerHTML = `<span class="participant-avatar">${escapeHtml(
        (p.username || '?')[0].toUpperCase()
      )}</span>${escapeHtml(p.username)}`;
      listEl.appendChild(chip);
    });
  }
  // BUG DO "PRECISA CLICAR DUAS VEZES" CORRIGIDO: connectVoice() é async
  // (espera a confirmação do servidor antes de marcar connectedVoiceRoomId).
  // Antes, updateVoicePanelView(channel) rodava logo em seguida, SEM esperar
  // esse await terminar — então ela via connectedVoiceRoomId ainda vazio e
  // mostrava a tela de "Entrar na chamada" de novo, mesmo já tendo entrado
  // de verdade por trás. Só no SEGUNDO clique (quando o primeiro já tinha
  // terminado) a tela finalmente trocava pra visão de dentro da call. Agora
  // espera connectVoice() terminar antes de atualizar a tela.
  document.getElementById('btn-join-voice-preview').onclick = async () => {
    if (connectedVoiceRoomId && connectedVoiceRoomId !== channel.id) disconnectVoice();
    await connectVoice(channel.id);
    updateVoicePanelView(channel);
  };
}

// Volta pra tela de Início (dashboard), saindo do canal de texto atual (a
// sala de voz continua conectada em segundo plano, igual Discord).
function goHome() {
  if (currentChannel && currentChannel.type === 'texto') {
    socket.emit('channel:leave', currentChannel.id);
  }
  exitChatMode();
  currentChannel = null;
  document.getElementById('current-channel-name').textContent = 'Início';
  document.getElementById('text-panel').classList.add('hidden');
  document.getElementById('voice-panel').classList.add('hidden');
  document.getElementById('friends-panel').classList.add('hidden');
  document.getElementById('home-panel').classList.remove('hidden');
  setNavActive('nav-inicio', true);
  renderCategories(allChannels);
  updateClearChannelButton();
  // Nenhum canal selecionado na Início — os ícones de busca/fixados/membros
  // do cabeçalho não fazem sentido aqui (exitChatMode() logo acima devolve
  // eles por padrão, então escondemos de novo explicitamente).
  ['btn-search-messages', 'btn-pinned-messages', 'btn-toggle-members'].forEach((id) => {
    document.getElementById(id).classList.add('hidden');
  });
  // BUG CORRIGIDO: se o painel de membros (coluna da direita) já estava
  // aberto, ele continuava aberto mesmo depois de voltar pra Início — só o
  // BOTÃO sumia, a lista ficava presa na tela. Agora fecha os dois juntos.
  document.getElementById('members-panel').classList.add('hidden');
  document.getElementById('btn-toggle-members').classList.remove('active-state');
  loadHomeDashboard();

  // Início fica "viva": ranking, atividade recente e quem tá jogando agora
  // se atualizam sozinhos a cada meio minuto, sem precisar recarregar a
  // página. Para automaticamente quando sai da Início (evita gastar rede à toa).
  if (homeRefreshInterval) clearInterval(homeRefreshInterval);
  homeRefreshInterval = setInterval(() => {
    if (document.getElementById('home-panel').classList.contains('hidden')) return;
    loadHomeRanking();
    loadHomeActivity();
    loadHomePlayingNow();
    loadHomeConversations();
  }, 30000);
}

function stopHomeAutoRefresh() {
  if (homeRefreshInterval) {
    clearInterval(homeRefreshInterval);
    homeRefreshInterval = null;
  }
}

function setNavActive(id, active) {
  document.querySelectorAll('.navbar-link').forEach((el) => el.classList.remove('active'));
  if (active) document.getElementById(id).classList.add('active');
}

// ---------- LIMPAR CONVERSA (poder de moderador, só admin) ----------

function updateClearChannelButton() {
  const btn = document.getElementById('btn-clear-channel');
  btn.classList.toggle('hidden', !(me.is_admin && currentChannel));
}

document.getElementById('btn-clear-channel').onclick = async () => {
  if (!currentChannel) return;
  if (!confirm(`Apagar TODAS as mensagens dessa conversa? Essa ação não pode ser desfeita pra quem está vendo.`)) return;
  await fetch(`/api/channels/${currentChannel.id}/clear`, { method: 'POST', credentials: 'include' });
};

// Limpa a view de quem estiver olhando essa conversa no momento (inclusive
// quem clicou) — chega via socket assim que o servidor confirma.
function clearMessagesView(channelId) {
  const container = messagesContainerFor(channelId);
  if (container) container.innerHTML = '<p class="empty-hint">Essa conversa foi limpa por um administrador.</p>';
}

// ---------- NAVBAR (busca, sino, perfil, navegação) ----------

function updateNavbarProfile() {
  renderAvatarInto(document.getElementById('navbar-avatar'), me);
  document.getElementById('navbar-username').textContent = me.username;
  const level = Math.max(1, Math.floor((me.message_count || 0) / 10) + 1);
  document.getElementById('navbar-level').textContent = `Nível ${level}`;
}

document.getElementById('nav-inicio').onclick = () => goHome();
// ---------- EXPLORAR SERVIDORES (descoberta pública) ----------

const modalExplore = document.getElementById('modal-explore');

document.getElementById('nav-jogos').onclick = () => {
  modalExplore.classList.remove('hidden');
  loadExplore();
};
document.getElementById('btn-close-explore').onclick = () => modalExplore.classList.add('hidden');

let exploreSearchTimer = null;
document.getElementById('explore-search').oninput = () => {
  clearTimeout(exploreSearchTimer);
  exploreSearchTimer = setTimeout(loadExplore, 300);
};

async function loadExplore() {
  const grid = document.getElementById('explore-grid');
  grid.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const q = document.getElementById('explore-search').value.trim();
  const res = await fetch(`/api/servers/discover${q ? '?q=' + encodeURIComponent(q) : ''}`, { credentials: 'include' });
  const servers = await res.json();
  if (servers.length === 0) {
    grid.innerHTML = '<p class="empty-hint">Nenhum servidor público encontrado. Servidores só aparecem aqui se o dono marcar como público em "Gerenciar Servidor".</p>';
    return;
  }
  grid.innerHTML = '';
  servers.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'explore-card';
    card.innerHTML = `
      <div class="explore-card-icon">${s.icon || serverInitials(s.category)}</div>
      <div class="explore-card-info">
        <strong>${escapeHtml(s.category)}</strong>
        <p>${s.description ? escapeHtml(s.description) : 'Sem descrição ainda.'}</p>
        <span class="explore-card-meta"># ${s.text_channels} texto · 🔊 ${s.voice_channels} voz · 👥 ${s.member_count} membros</span>
      </div>
      <button type="button" class="home-btn-primary explore-card-btn">${s.is_member ? 'Acessar' : 'Entrar'}</button>
    `;
    card.querySelector('.explore-card-btn').onclick = async () => {
      if (!s.is_member) {
        const r = await fetch(`/api/servers/discover/${encodeURIComponent(s.category)}/join`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          alert(d.error || 'Erro ao entrar');
          return;
        }
      }
      modalExplore.classList.add('hidden');
      activeServerCategory = s.category;
      await loadChannels();
      goHome();
    };
    grid.appendChild(card);
  });
}
document.getElementById('nav-comunidade').onclick = () => document.getElementById('btn-toggle-members').click();
// ---------- JOGAR: LFG, MATCHMAKING, PERFIS DE JOGO, TIMES, CLÃS ----------

const modalLfg = document.getElementById('modal-lfg');

document.getElementById('nav-lfg').onclick = () => {
  document.querySelectorAll('#modal-lfg .manage-tab').forEach((t, i) => t.classList.toggle('active', i === 0));
  document.querySelectorAll('#modal-lfg .manage-tab-panel').forEach((p, i) => p.classList.toggle('hidden', i !== 0));
  modalLfg.classList.remove('hidden');
  loadLfgPosts();
};
document.getElementById('btn-close-lfg').onclick = () => modalLfg.classList.add('hidden');

document.querySelectorAll('#modal-lfg .manage-tab').forEach((tabBtn) => {
  tabBtn.onclick = () => {
    document.querySelectorAll('#modal-lfg .manage-tab').forEach((t) => t.classList.remove('active'));
    tabBtn.classList.add('active');
    document.querySelectorAll('#modal-lfg .manage-tab-panel').forEach((p) => p.classList.add('hidden'));
    const tab = tabBtn.dataset.lfgTab;
    document.getElementById('lfg-tab-' + tab).classList.remove('hidden');
    if (tab === 'buscar') loadLfgPosts();
    if (tab === 'perfis') loadGameProfiles();
    if (tab === 'times') loadTeams();
    if (tab === 'clas') loadClans();
    if (tab === 'orgs') loadOrgs();
    if (tab === 'market') loadMarketplace();
  };
});

async function loadLfgPosts() {
  const listEl = document.getElementById('lfg-posts-list');
  listEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch('/api/lfg', { credentials: 'include' });
  const posts = await res.json();
  if (posts.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Nenhum grupo procurando jogador agora. Crie um na aba "Criar Post"!</p>';
    return;
  }
  listEl.innerHTML = '';
  posts.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'settings-row';
    const authorName = p.author ? p.author.username : '?';
    card.innerHTML = `
      <div class="settings-row-info">
        <span class="settings-row-title">🎮 ${escapeHtml(p.game)} — ${p.players_needed} jogador(es) · <span style="color:#23a55a;">${p.compatibility}% compatível</span></span>
        <span class="settings-row-meta">Por ${escapeHtml(authorName)} ${p.region ? '· região ' + escapeHtml(p.region) : ''} ${p.language ? '· ' + escapeHtml(p.language) : ''} ${p.role ? '· função ' + escapeHtml(p.role) : ''} · mic ${p.mic_required} · ${p.member_count} no grupo</span>
        ${p.note ? `<span class="settings-row-meta">"${escapeHtml(p.note)}"</span>` : ''}
      </div>
      ${p.user_id !== me.id ? '<button type="button" class="lfg-join-btn">Entrar</button>' : '<button type="button" class="lfg-close-btn">Fechar post</button>'}
    `;
    const joinBtn = card.querySelector('.lfg-join-btn');
    if (joinBtn) {
      joinBtn.onclick = async () => {
        const r = await fetch(`/api/lfg/${p.id}/join`, { method: 'POST', credentials: 'include' });
        const d = await r.json();
        if (!r.ok) return alert(d.error || 'Erro ao entrar no grupo');
        SFX.streakUp && SFX.streakUp();
        loadLfgPosts();
      };
    }
    const closeBtn = card.querySelector('.lfg-close-btn');
    if (closeBtn) {
      closeBtn.onclick = async () => {
        await fetch(`/api/lfg/${p.id}`, { method: 'DELETE', credentials: 'include' });
        loadLfgPosts();
      };
    }
    listEl.appendChild(card);
  });
}

document.getElementById('form-lfg-create').onsubmit = async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('lfg-create-error');
  errorEl.textContent = '';
  const body = {
    game: document.getElementById('lfg-game').value.trim(),
    players_needed: document.getElementById('lfg-players').value,
    role: document.getElementById('lfg-role').value.trim(),
    rank_min: document.getElementById('lfg-rank-min').value.trim(),
    rank_max: document.getElementById('lfg-rank-max').value.trim(),
    region: document.getElementById('lfg-region').value.trim(),
    language: document.getElementById('lfg-language').value.trim(),
    mic_required: document.getElementById('lfg-mic').value,
    available_time: document.getElementById('lfg-time').value.trim(),
    note: document.getElementById('lfg-note').value.trim(),
  };
  const res = await fetch('/api/lfg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error || 'Erro ao publicar';
    return;
  }
  document.getElementById('form-lfg-create').reset();
  document.querySelector('#modal-lfg .manage-tab[data-lfg-tab="buscar"]').click();
};

async function loadGameProfiles() {
  const listEl = document.getElementById('game-profiles-list');
  listEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch(`/api/game-profiles/${me.id}`, { credentials: 'include' });
  const rows = await res.json();
  if (rows.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Nenhum perfil de jogo ainda — adicione um abaixo.</p>';
    return;
  }
  listEl.innerHTML = '';
  rows.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.innerHTML = `
      <div class="settings-row-info">
        <span class="settings-row-title">🎮 ${escapeHtml(p.game)} ${p.rank ? '— ' + escapeHtml(p.rank) : ''}</span>
        <span class="settings-row-meta">${p.role ? escapeHtml(p.role) + ' · ' : ''}${p.hours}h · ${p.wins}V/${p.losses}D</span>
      </div>
      <button type="button" class="gp-delete-btn">Remover</button>
    `;
    row.querySelector('.gp-delete-btn').onclick = async () => {
      await fetch(`/api/me/game-profiles/${encodeURIComponent(p.game)}`, { method: 'DELETE', credentials: 'include' });
      loadGameProfiles();
    };
    listEl.appendChild(row);
  });
}

document.getElementById('form-game-profile').onsubmit = async (e) => {
  e.preventDefault();
  const game = document.getElementById('gp-game').value.trim();
  if (!game) return;
  await fetch(`/api/me/game-profiles/${encodeURIComponent(game)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      rank: document.getElementById('gp-rank').value.trim(),
      role: document.getElementById('gp-role').value.trim(),
      hours: document.getElementById('gp-hours').value,
      wins: document.getElementById('gp-wins').value,
      losses: document.getElementById('gp-losses').value,
    }),
  });
  document.getElementById('form-game-profile').reset();
  loadGameProfiles();
};

async function loadTeams() {
  const listEl = document.getElementById('teams-list');
  listEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch('/api/teams/mine', { credentials: 'include' });
  const rows = await res.json();
  if (rows.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Você não faz parte de nenhum time ainda.</p>';
    return;
  }
  listEl.innerHTML = '';
  rows.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.innerHTML = `
      <div class="settings-row-info">
        <span class="settings-row-title">🛡️ ${escapeHtml(t.name)} ${t.game ? '— ' + escapeHtml(t.game) : ''}</span>
        <span class="settings-row-meta">Seu cargo: ${escapeHtml(t.my_role)}</span>
      </div>
      ${t.my_role === 'lider' ? '<button type="button" class="team-invite-btn">Convidar</button>' : ''}
    `;
    const inviteBtn = row.querySelector('.team-invite-btn');
    if (inviteBtn) {
      inviteBtn.onclick = async () => {
        const username = prompt('Nome de usuário pra convidar:');
        if (!username) return;
        const r = await fetch(`/api/teams/${t.id}/invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username, role: 'jogador' }),
        });
        const d = await r.json();
        if (!r.ok) alert(d.error || 'Erro ao convidar');
        else loadTeams();
      };
    }
    listEl.appendChild(row);
  });
}

document.getElementById('form-team-create').onsubmit = async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('team-create-error');
  errorEl.textContent = '';
  const res = await fetch('/api/teams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      name: document.getElementById('team-name').value.trim(),
      game: document.getElementById('team-game').value.trim(),
      description: document.getElementById('team-description').value.trim(),
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error || 'Erro ao criar time';
    return;
  }
  document.getElementById('form-team-create').reset();
  loadTeams();
};

async function loadClans() {
  const listEl = document.getElementById('clans-list');
  listEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const [allRes, mineRes] = await Promise.all([
    fetch('/api/clans', { credentials: 'include' }),
    fetch('/api/clans/mine', { credentials: 'include' }),
  ]);
  const all = await allRes.json();
  const mine = await mineRes.json();
  const mineIds = new Set(mine.map((c) => c.id));
  if (all.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Nenhum clã criado ainda — crie o primeiro abaixo.</p>';
    return;
  }
  listEl.innerHTML = '';
  all.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const isMember = mineIds.has(c.id);
    row.innerHTML = `
      <div class="settings-row-info">
        <span class="settings-row-title">⚔️ ${escapeHtml(c.name)} — nível ${c.level}</span>
        <span class="settings-row-meta">${c.member_count} membro(s)${c.description ? ' · ' + escapeHtml(c.description) : ''}</span>
      </div>
      ${isMember ? '<span class="settings-row-badge">MEMBRO</span>' : '<button type="button" class="clan-join-btn">Entrar</button>'}
    `;
    const joinBtn = row.querySelector('.clan-join-btn');
    if (joinBtn) {
      joinBtn.onclick = async () => {
        await fetch(`/api/clans/${c.id}/join`, { method: 'POST', credentials: 'include' });
        loadClans();
      };
    }
    listEl.appendChild(row);
  });
}

document.getElementById('form-clan-create').onsubmit = async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('clan-create-error');
  errorEl.textContent = '';
  const res = await fetch('/api/clans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      name: document.getElementById('clan-name').value.trim(),
      description: document.getElementById('clan-description').value.trim(),
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error || 'Erro ao criar clã';
    return;
  }
  document.getElementById('form-clan-create').reset();
  loadClans();
};

async function loadOrgs() {
  const listEl = document.getElementById('orgs-list');
  listEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch('/api/organizations', { credentials: 'include' });
  const orgs = await res.json();
  if (orgs.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Nenhuma organização criada ainda.</p>';
    return;
  }
  listEl.innerHTML = '';
  orgs.forEach((o) => {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.innerHTML = `
      <div class="settings-row-info">
        <span class="settings-row-title">🏢 ${escapeHtml(o.name)}</span>
        <span class="settings-row-meta">${o.description ? escapeHtml(o.description) : 'Organização de esports'}</span>
      </div>
    `;
    listEl.appendChild(row);
  });
}

document.getElementById('form-org-create').onsubmit = async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('org-create-error');
  errorEl.textContent = '';
  const res = await fetch('/api/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      name: document.getElementById('org-name').value.trim(),
      description: document.getElementById('org-description').value.trim(),
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error || 'Erro ao criar organização';
    return;
  }
  document.getElementById('form-org-create').reset();
  loadOrgs();
};

const MARKET_CATEGORY_LABELS = {
  designer: 'Designer',
  editor: 'Editor de vídeo',
  coach: 'Coach',
  desenvolvedor: 'Desenvolvedor',
  caster: 'Caster',
  criador_conteudo: 'Criador de conteúdo',
};

async function loadMarketplace() {
  const listEl = document.getElementById('market-list');
  listEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const category = document.getElementById('market-filter-category').value;
  const res = await fetch(`/api/marketplace${category ? '?category=' + category : ''}`, { credentials: 'include' });
  const profiles = await res.json();
  if (profiles.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Nenhum perfil profissional publicado ainda.</p>';
    return;
  }
  listEl.innerHTML = '';
  profiles.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const rating = p.avg_rating ? `⭐ ${Number(p.avg_rating).toFixed(1)} (${p.review_count})` : 'sem avaliações ainda';
    row.innerHTML = `
      <div class="settings-row-info">
        <span class="settings-row-title">${escapeHtml(p.title)} — ${MARKET_CATEGORY_LABELS[p.category] || p.category}</span>
        <span class="settings-row-meta">${escapeHtml(p.username)} · ${rating} ${p.rate_display ? '· ' + escapeHtml(p.rate_display) : ''}</span>
        ${p.description ? `<span class="settings-row-meta">${escapeHtml(p.description)}</span>` : ''}
      </div>
      ${p.user_id !== me.id ? '<button type="button" class="market-contact-btn">💬 Contatar</button>' : ''}
    `;
    const contactBtn = row.querySelector('.market-contact-btn');
    if (contactBtn) {
      contactBtn.onclick = () => {
        modalLfg.classList.add('hidden');
        openDmText(p.user_id, p.username);
      };
    }
    listEl.appendChild(row);
  });
}
document.getElementById('market-filter-category').onchange = loadMarketplace;

document.getElementById('form-market-profile').onsubmit = async (e) => {
  e.preventDefault();
  await fetch('/api/marketplace/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      category: document.getElementById('market-category').value,
      title: document.getElementById('market-title').value.trim(),
      description: document.getElementById('market-description').value.trim(),
      portfolio_url: document.getElementById('market-portfolio').value.trim(),
      rate_display: document.getElementById('market-rate').value.trim(),
    }),
  });
  document.getElementById('form-market-profile').reset();
  loadMarketplace();
};

// ---------- LOJA NEXT COINS ----------

const modalShopCoins = document.getElementById('modal-shop-coins');
document.getElementById('btn-shop-coins').onclick = () => {
  modalShopCoins.classList.remove('hidden');
  loadShop();
};
document.getElementById('btn-close-shop-coins').onclick = () => modalShopCoins.classList.add('hidden');

async function loadShop() {
  const [coinsRes, itemsRes] = await Promise.all([
    fetch('/api/me/coins', { credentials: 'include' }),
    fetch('/api/shop', { credentials: 'include' }),
  ]);
  const coinsData = await coinsRes.json();
  const items = await itemsRes.json();
  document.getElementById('shop-coins-balance').textContent = coinsData.balance;

  const listEl = document.getElementById('shop-items-list');
  if (items.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Nenhum item na loja ainda — o admin pode adicionar itens.</p>';
    return;
  }
  listEl.innerHTML = '';
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.innerHTML = `
      <div class="settings-row-info">
        <span class="settings-row-title">${escapeHtml(item.name)} — 🪙 ${item.cost}</span>
        <span class="settings-row-meta">${item.description ? escapeHtml(item.description) : ''}</span>
      </div>
      ${item.owned ? '<span class="settings-row-badge">JÁ TENHO</span>' : `<button type="button" class="shop-buy-btn" ${coinsData.balance < item.cost ? 'disabled' : ''}>Comprar</button>`}
    `;
    const buyBtn = row.querySelector('.shop-buy-btn');
    if (buyBtn) {
      buyBtn.onclick = async () => {
        const r = await fetch(`/api/shop/${item.id}/purchase`, { method: 'POST', credentials: 'include' });
        const d = await r.json();
        if (!r.ok) return alert(d.error || 'Erro ao comprar');
        SFX.reward && SFX.reward();
        loadShop();
      };
    }
    listEl.appendChild(row);
  });
}

// ---------- INTEGRAÇÕES EXTERNAS (auto-declaradas) ----------

const INTEGRATION_LABELS = {
  steam: 'Steam',
  twitch: 'Twitch',
  youtube: 'YouTube',
  riot_games: 'Riot Games',
  epic_games: 'Epic Games',
  xbox: 'Xbox',
  playstation: 'PlayStation',
  ubisoft: 'Ubisoft',
  battlenet: 'Battle.net',
};

async function loadIntegrations() {
  const listEl = document.getElementById('integrations-list');
  listEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch('/api/integrations', { credentials: 'include' });
  const rows = await res.json();
  listEl.innerHTML = '';
  rows.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.innerHTML = `
      <div class="settings-row-info">
        <span class="settings-row-title">${INTEGRATION_LABELS[r.provider] || r.provider}</span>
        <span class="settings-row-meta">${r.connected ? 'Conectado: ' + escapeHtml(r.external_username) : 'Não conectado'}</span>
      </div>
      <button type="button" class="integration-toggle-btn">${r.connected ? 'Desconectar' : 'Conectar'}</button>
    `;
    row.querySelector('.integration-toggle-btn').onclick = async () => {
      if (r.connected) {
        await fetch(`/api/integrations/${r.provider}`, { method: 'DELETE', credentials: 'include' });
      } else {
        const username = prompt(`Seu nome de usuário no ${INTEGRATION_LABELS[r.provider] || r.provider}:`);
        if (!username) return;
        await fetch(`/api/integrations/${r.provider}/connect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ external_username: username }),
        });
      }
      loadIntegrations();
    };
    listEl.appendChild(row);
  });
}

// ---------- FEED, CLIPES, AO VIVO, EVENTOS ----------

const modalFeed = document.getElementById('modal-feed');

document.getElementById('nav-feed').onclick = () => {
  document.querySelectorAll('#modal-feed .manage-tab').forEach((t, i) => t.classList.toggle('active', i === 0));
  document.querySelectorAll('#modal-feed .manage-tab-panel').forEach((p, i) => p.classList.toggle('hidden', i !== 0));
  modalFeed.classList.remove('hidden');
  loadFeedPosts();
};
document.getElementById('btn-close-feed').onclick = () => modalFeed.classList.add('hidden');

document.querySelectorAll('#modal-feed .manage-tab').forEach((tabBtn) => {
  tabBtn.onclick = () => {
    document.querySelectorAll('#modal-feed .manage-tab').forEach((t) => t.classList.remove('active'));
    tabBtn.classList.add('active');
    document.querySelectorAll('#modal-feed .manage-tab-panel').forEach((p) => p.classList.add('hidden'));
    const tab = tabBtn.dataset.feedTab;
    document.getElementById('feed-tab-' + tab).classList.remove('hidden');
    if (tab === 'feed') loadFeedPosts();
    if (tab === 'clipes') loadClips();
    if (tab === 'aovivo') loadStreams();
    if (tab === 'eventos') loadEvents();
  };
});

const FEED_TYPE_LABELS = {
  post: '',
  clip: '🎬',
  tournament_win: '🏆',
  team_created: '🛡️',
  clan_created: '⚔️',
  event: '📅',
};

async function loadFeedPosts() {
  const listEl = document.getElementById('feed-posts-list');
  listEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch('/api/feed', { credentials: 'include' });
  const posts = await res.json();
  if (posts.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Nada no feed ainda — seja o primeiro a publicar!</p>';
    return;
  }
  listEl.innerHTML = '';
  posts.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'settings-row';
    const icon = FEED_TYPE_LABELS[p.type] || '';
    const when = new Date(p.created_at).toLocaleString('pt-BR');
    card.innerHTML = `
      <div class="settings-row-info" style="flex:1;">
        <span class="settings-row-title">${icon} ${escapeHtml(p.username)} ${escapeHtml(p.text || '')}</span>
        <span class="settings-row-meta">${when}</span>
        <div style="display:flex; gap:10px; margin-top:4px;">
          <button type="button" class="feed-like-btn" style="background:none; border:none; color:${p.liked_by_me ? '#f23f42' : '#949ba4'}; cursor:pointer; font-size:12px;">
            ${p.liked_by_me ? '❤️' : '🤍'} ${p.like_count}
          </button>
          <span style="font-size:12px; color:#949ba4;">💬 ${p.comment_count}</span>
        </div>
      </div>
    `;
    card.querySelector('.feed-like-btn').onclick = async (e) => {
      e.stopPropagation();
      const method = p.liked_by_me ? 'DELETE' : 'POST';
      await fetch(`/api/content/feed_post/${p.id}/like`, { method, credentials: 'include' });
      loadFeedPosts();
    };
    listEl.appendChild(card);
  });
}

document.getElementById('form-feed-post').onsubmit = async (e) => {
  e.preventDefault();
  const input = document.getElementById('feed-post-text');
  const text = input.value.trim();
  if (!text) return;
  await fetch('/api/feed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ text }),
  });
  input.value = '';
  loadFeedPosts();
};

async function loadClips() {
  const listEl = document.getElementById('clips-list');
  listEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch('/api/clips?sort=trending', { credentials: 'include' });
  const clips = await res.json();
  if (clips.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Nenhum clipe publicado ainda.</p>';
    return;
  }
  listEl.innerHTML = '';
  clips.forEach((c) => {
    const card = document.createElement('div');
    card.className = 'settings-row';
    card.innerHTML = `
      <div class="settings-row-info">
        <span class="settings-row-title">🎬 <a href="${escapeHtml(c.video_url)}" target="_blank" rel="noopener" style="color:#e6e6e6;">${escapeHtml(c.title)}</a></span>
        <span class="settings-row-meta">Por ${escapeHtml(c.username)} ${c.game ? '· ' + escapeHtml(c.game) : ''} · 👁️ ${c.views} views</span>
        ${c.description ? `<span class="settings-row-meta">${escapeHtml(c.description)}</span>` : ''}
      </div>
    `;
    const link = card.querySelector('a');
    link.addEventListener('click', () => {
      fetch(`/api/clips/${c.id}/view`, { method: 'POST', credentials: 'include' }).catch(() => {});
    });
    listEl.appendChild(card);
  });
}

document.getElementById('form-clip-create').onsubmit = async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('clip-create-error');
  errorEl.textContent = '';
  const res = await fetch('/api/clips', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      title: document.getElementById('clip-title').value.trim(),
      game: document.getElementById('clip-game').value.trim(),
      video_url: document.getElementById('clip-url').value.trim(),
      description: document.getElementById('clip-description').value.trim(),
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error || 'Erro ao publicar clipe';
    return;
  }
  document.getElementById('form-clip-create').reset();
  document.querySelector('#modal-feed .manage-tab[data-feed-tab="clipes"]').click();
};

async function loadStreams() {
  const listEl = document.getElementById('streams-list');
  listEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch('/api/streams', { credentials: 'include' });
  const streams = await res.json();
  if (streams.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Ninguém ao vivo agora.</p>';
    return;
  }
  listEl.innerHTML = '';
  streams.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'settings-row';
    card.innerHTML = `
      <div class="settings-row-info">
        <span class="settings-row-title">🔴 <a href="${escapeHtml(s.external_url)}" target="_blank" rel="noopener" style="color:#e6e6e6;">${escapeHtml(s.title)}</a></span>
        <span class="settings-row-meta">${escapeHtml(s.username)} ${s.game ? '· ' + escapeHtml(s.game) : ''}</span>
      </div>
      ${s.user_id !== me.id ? '<button type="button" class="stream-follow-btn">Seguir</button>' : ''}
    `;
    const followBtn = card.querySelector('.stream-follow-btn');
    if (followBtn) {
      followBtn.onclick = async () => {
        await fetch(`/api/streams/follow/${s.user_id}`, { method: 'POST', credentials: 'include' });
        showCopyToast(`Seguindo ${s.username}!`);
      };
    }
    listEl.appendChild(card);
  });
}

document.getElementById('form-go-live').onsubmit = async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('stream-error');
  errorEl.textContent = '';
  const res = await fetch('/api/streams/go-live', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      title: document.getElementById('stream-title').value.trim(),
      game: document.getElementById('stream-game').value.trim(),
      external_url: document.getElementById('stream-url').value.trim(),
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error || 'Erro ao ir ao vivo';
    return;
  }
  document.getElementById('form-go-live').reset();
  loadStreams();
};

document.getElementById('btn-end-stream').onclick = async () => {
  await fetch('/api/streams/end', { method: 'POST', credentials: 'include' });
  loadStreams();
};

async function loadEvents() {
  const listEl = document.getElementById('events-list');
  listEl.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch('/api/events', { credentials: 'include' });
  const events = await res.json();
  if (events.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Nenhum evento marcado ainda.</p>';
    return;
  }
  listEl.innerHTML = '';
  events.forEach((ev) => {
    const card = document.createElement('div');
    card.className = 'settings-row';
    const dateText = ev.event_date ? new Date(ev.event_date + 'T00:00:00').toLocaleDateString('pt-BR') : 'Data a definir';
    card.innerHTML = `
      <div class="settings-row-info">
        <span class="settings-row-title">📅 ${escapeHtml(ev.name)} ${ev.game ? '— ' + escapeHtml(ev.game) : ''}</span>
        <span class="settings-row-meta">${dateText} · ${ev.participant_count}${ev.max_participants ? '/' + ev.max_participants : ''} participante(s)</span>
      </div>
      <button type="button" class="event-toggle-btn">${ev.is_registered ? 'Sair' : 'Participar'}</button>
    `;
    card.querySelector('.event-toggle-btn').onclick = async () => {
      const method = ev.is_registered ? 'DELETE' : 'POST';
      await fetch(`/api/events/${ev.id}/register`, { method, credentials: 'include' });
      loadEvents();
    };
    listEl.appendChild(card);
  });
}

document.getElementById('form-event-create').onsubmit = async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('event-create-error');
  errorEl.textContent = '';
  const res = await fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      name: document.getElementById('event-name').value.trim(),
      game: document.getElementById('event-game').value.trim(),
      event_date: document.getElementById('event-date').value,
      max_participants: document.getElementById('event-max').value,
      description: document.getElementById('event-description').value.trim(),
      category: activeServerCategory,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error || 'Erro ao criar evento';
    return;
  }
  document.getElementById('form-event-create').reset();
  loadEvents();
};

document.getElementById('nav-torneios').onclick = () => {
  if (!activeServerCategory) {
    alert('Crie ou entre num servidor primeiro pra ver os torneios dele.');
    return;
  }
  document.getElementById('btn-tournaments').click();
};
document.getElementById('nav-sobre').onclick = () => {
  if (!activeServerCategory) {
    alert('Crie ou entre num servidor primeiro.');
    return;
  }
  document.getElementById('btn-server-info').click();
};
document.getElementById('nav-bell').onclick = () => {
  goHome();
  setTimeout(() => document.getElementById('home-activity').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
};
document.getElementById('nav-profile').onclick = () => document.getElementById('btn-edit-profile').click();

// Menu "..." do rodapé (som, admin, sair) — some por padrão, só abre no
// clique, pra não espremer o avatar numa fileira cheia de ícones.
const footerMoreMenu = document.getElementById('footer-more-menu');
document.getElementById('btn-footer-more').onclick = (e) => {
  e.stopPropagation();
  footerMoreMenu.classList.toggle('hidden');
};
document.addEventListener('click', (e) => {
  if (!footerMoreMenu.classList.contains('hidden') && !footerMoreMenu.contains(e.target)) {
    footerMoreMenu.classList.add('hidden');
  }
});
footerMoreMenu.querySelectorAll('button, a').forEach((el) => {
  el.addEventListener('click', () => footerMoreMenu.classList.add('hidden'));
});
// "Ranking" na sidebar nova reaproveita o ranking do servidor ativo.
document.getElementById('nav-ranking-link').onclick = () => {
  if (!activeServerCategory) {
    alert('Crie ou entre num servidor primeiro pra ver o ranking dele.');
    return;
  }
  document.getElementById('btn-ranking').click();
};
// "Chat" — só dois jeitos de chegar aqui agora (coluna esquerda da sidebar e
// o botão flutuante), pra não ter 3 caminhos diferentes pra mesma coisa.
document.getElementById('nav-sidebar-chat').onclick = () => enterChatMode('mensagens');
document.getElementById('btn-floating-chat').onclick = () => enterChatMode('mensagens');

// ---------- SONS E EFEITOS (liga/desliga geral) ----------

function updateSfxToggleButton() {
  const btn = document.getElementById('nav-sfx-toggle');
  const on = SFX.isEnabled();
  document.getElementById('sfx-toggle-label').textContent = on ? 'Sons ligados' : 'Sons desligados';
  btn.title = on ? 'Sons ligados (clique pra desligar)' : 'Sons desligados (clique pra ligar)';
}
document.getElementById('nav-sfx-toggle').onclick = () => {
  SFX.setEnabled(!SFX.isEnabled());
  updateSfxToggleButton();
  if (SFX.isEnabled()) SFX.click();
};
updateSfxToggleButton();

// Clique genérico sutil em qualquer botão da interface — e som ao abrir
// qualquer modal (detecta quando a classe "hidden" some de um .modal-overlay),
// assim não precisa caçar cada handler de abrir modal um por um.
document.addEventListener(
  'click',
  (e) => {
    const btn = e.target.closest('button');
    if (btn) SFX.click();
  },
  true
);

new MutationObserver((mutations) => {
  mutations.forEach((m) => {
    if (m.attributeName !== 'class') return;
    const el = m.target;
    if (el.classList.contains('modal-overlay') && !el.classList.contains('hidden')) {
      SFX.modalOpen();
    }
  });
}).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });

const navbarSearchInput = document.getElementById('navbar-search-input');
const navbarSearchDropdown = document.getElementById('navbar-search-dropdown');
let navbarSearchTimer = null;

navbarSearchInput.addEventListener('input', (e) => {
  const term = e.target.value.trim().toLowerCase();
  document.querySelectorAll('.server-row').forEach((el) => {
    el.style.opacity = !term || el.title.toLowerCase().includes(term) ? '1' : '0.25';
  });
  document.querySelectorAll('.home-server-card').forEach((el) => {
    el.style.display = !term || el.dataset.name.includes(term) ? '' : 'none';
  });

  clearTimeout(navbarSearchTimer);
  if (term.length < 2) {
    navbarSearchDropdown.classList.add('hidden');
    return;
  }
  navbarSearchTimer = setTimeout(() => runGlobalSearch(term), 300);
});
navbarSearchInput.addEventListener('focus', () => {
  if (navbarSearchInput.value.trim().length >= 2 && navbarSearchDropdown.innerHTML) {
    navbarSearchDropdown.classList.remove('hidden');
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.navbar-search')) navbarSearchDropdown.classList.add('hidden');
});
navbarSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { navbarSearchDropdown.classList.add('hidden'); navbarSearchInput.blur(); }
});

// Busca global (item 13 do plano): jogadores, servidores, torneios e clipes
// num dropdown só, sugestões enquanto digita.
async function runGlobalSearch(term) {
  let data;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { credentials: 'include' });
    data = await res.json();
  } catch {
    return;
  }
  const totalResults = data.players.length + data.servers.length + data.tournaments.length + data.clips.length;
  if (totalResults === 0) {
    navbarSearchDropdown.innerHTML = `<div class="search-empty">Nada encontrado pra "${escapeHtml(term)}"</div>`;
    navbarSearchDropdown.classList.remove('hidden');
    return;
  }

  let html = '';
  if (data.players.length) {
    html += `<div class="search-group"><div class="search-group-label">Jogadores</div>${data.players
      .map(
        (u) => `<div class="search-result-item" data-kind="player" data-id="${u.id}">
          <div class="search-result-icon round">${renderAvatarHtml(u)}</div>
          <div class="search-result-text"><span class="search-result-title">${escapeHtml(u.username)}${u.is_admin ? ' 👑' : ''}</span><span class="search-result-meta">${escapeHtml(userTag(u))}${u.status_message ? ' · 🎮 ' + escapeHtml(u.status_message) : ''}</span></div>
        </div>`
      )
      .join('')}</div>`;
  }
  if (data.servers.length) {
    html += `<div class="search-group"><div class="search-group-label">Servidores</div>${data.servers
      .map(
        (s) => `<div class="search-result-item" data-kind="server" data-category="${escapeHtml(s.category)}" data-member="${s.is_member ? '1' : '0'}">
          <div class="search-result-icon">${s.icon || serverInitials(s.category)}</div>
          <div class="search-result-text"><span class="search-result-title">${escapeHtml(s.category)}</span><span class="search-result-meta">👥 ${s.member_count} membros</span></div>
        </div>`
      )
      .join('')}</div>`;
  }
  if (data.tournaments.length) {
    html += `<div class="search-group"><div class="search-group-label">Torneios</div>${data.tournaments
      .map(
        (t) => `<div class="search-result-item" data-kind="tournament" data-category="${escapeHtml(t.category)}">
          <div class="search-result-icon">🏆</div>
          <div class="search-result-text"><span class="search-result-title">${escapeHtml(t.name)}</span><span class="search-result-meta">${escapeHtml(t.game)} · ${t.registered} inscritos</span></div>
        </div>`
      )
      .join('')}</div>`;
  }
  if (data.clips.length) {
    html += `<div class="search-group"><div class="search-group-label">Clipes</div>${data.clips
      .map(
        (c) => `<div class="search-result-item" data-kind="clip">
          <div class="search-result-icon">🎬</div>
          <div class="search-result-text"><span class="search-result-title">${escapeHtml(c.title)}</span><span class="search-result-meta">${escapeHtml(c.username)} · 👁️ ${c.views}</span></div>
        </div>`
      )
      .join('')}</div>`;
  }

  navbarSearchDropdown.innerHTML = html;
  navbarSearchDropdown.classList.remove('hidden');

  navbarSearchDropdown.querySelectorAll('.search-result-item').forEach((item) => {
    item.onclick = async () => {
      navbarSearchDropdown.classList.add('hidden');
      navbarSearchInput.value = '';
      const kind = item.dataset.kind;
      if (kind === 'player') {
        const u = [...data.players].find((p) => p.id === item.dataset.id);
        if (u) openProfilePreview(u);
      } else if (kind === 'server' || kind === 'tournament') {
        const category = item.dataset.category;
        if (kind === 'server' && item.dataset.member !== '1') {
          const r = await fetch(`/api/servers/discover/${encodeURIComponent(category)}/join`, {
            method: 'POST',
            credentials: 'include',
          });
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            alert(d.error || 'Não foi possível entrar nesse servidor (pode ser privado).');
            return;
          }
        }
        activeServerCategory = category;
        await loadChannels();
        goHome();
        if (kind === 'tournament') document.getElementById('btn-tournaments').click();
      } else if (kind === 'clip') {
        document.getElementById('nav-feed').click();
      }
    };
  });
}

// ---------- PAINEL DE INÍCIO (dashboard com dados reais) ----------

// Atividades rápidas: cada botão já leva pra uma ação de verdade do app,
// reaproveitando modais/painéis que já existem — nada de link decorativo.
document.getElementById('home-quick-lfg').onclick = () => document.getElementById('nav-lfg').click();
document.getElementById('home-quick-join').onclick = () => document.getElementById('btn-join-invite').click();
document.getElementById('home-quick-team').onclick = () => {
  document.getElementById('nav-lfg').click();
  setTimeout(() => document.querySelector('#modal-lfg .manage-tab[data-lfg-tab="times"]')?.click(), 50);
};
document.getElementById('home-quick-tournaments').onclick = () => {
  if (!activeServerCategory) {
    alert('Crie ou entre num servidor primeiro pra ver os torneios dele.');
    return;
  }
  document.getElementById('btn-tournaments').click();
};

async function loadHomeDashboard() {
  loadHomeStats();
  loadHomeServers();
  loadHomePlayingNow();
  loadHomeActivity();
  loadHomeTournamentBanner();
  loadHomeRanking();
  loadHomeStreakCard();
  loadHomeConversations();
}

// Prévia clicável das conversas diretas mais recentes — abre direto na
// conversa sem precisar passar pelo painel de Amigos primeiro.
async function loadHomeConversations() {
  const el = document.getElementById('home-conversations');
  if (!el) return;
  let conversations;
  try {
    const res = await fetch('/api/dm', { credentials: 'include' });
    conversations = await res.json();
  } catch (_) {
    el.innerHTML = '<p class="empty-hint">Erro ao carregar conversas.</p>';
    return;
  }
  if (!Array.isArray(conversations) || conversations.length === 0) {
    el.innerHTML = '<p class="empty-hint">Nenhuma conversa ainda. Chame um amigo pra jogar!</p>';
    return;
  }
  el.innerHTML = conversations
    .slice(0, 5)
    .map((c) => {
      const preview = c.last_message ? escapeHtml(messagePreviewText(c.last_message)).slice(0, 42) : 'Sem mensagens ainda';
      return `
      <div class="home-conversation-row" data-user-id="${c.other_user.id}" data-username="${escapeHtml(c.other_user.username)}">
        <div class="member-avatar ${avatarFrameClass(c.other_user)}">${renderAvatarHtml(c.other_user)}</div>
        <div class="home-conversation-info">
          <strong>${escapeHtml(c.other_user.username)}</strong>
          <span>${preview}</span>
        </div>
      </div>`;
    })
    .join('');
  el.querySelectorAll('.home-conversation-row').forEach((row) => {
    row.onclick = () => openDmText(row.dataset.userId, row.dataset.username);
  });
}

// Quem está online agora e com um jogo selecionado no status — dá vida ao
// painel de Início mostrando atividade real da comunidade, não só números.
async function loadHomePlayingNow() {
  const el = document.getElementById('home-playing-now');
  if (allUsers.length === 0) await loadMembers();
  const playing = allUsers.filter((u) => onlineUserIds.has(u.id) && u.status_message);
  if (playing.length === 0) {
    el.innerHTML = '<p class="empty-hint">Ninguém com um jogo selecionado no status agora. Defina o seu no perfil!</p>';
    return;
  }
  el.innerHTML = playing
    .map(
      (u) => `
    <div class="playing-now-card">
      <div class="member-avatar ${avatarFrameClass(u)}">${renderAvatarHtml(u)}</div>
      <div class="playing-now-info">
        <strong>${escapeHtml(u.username)}</strong>
        <span>🎮 ${escapeHtml(u.status_message)}</span>
      </div>
    </div>
  `
    )
    .join('');
}

// Card de streak/recompensas na coluna lateral da Início — atalho rápido
// pra loja de recompensas sem precisar caçar o ícone na navbar.
async function loadHomeStreakCard() {
  const el = document.getElementById('home-streak-card');
  if (!rewardsCache) {
    try {
      const res = await fetch('/api/rewards', { credentials: 'include' });
      rewardsCache = await res.json();
    } catch (_) {
      el.innerHTML = '';
      return;
    }
  }
  const nextGoal = rewardsCache.rewards.find((r) => r.type === 'streak' && !r.unlocked);
  el.innerHTML = `
    <div class="home-section-title">🔥 Sua Sequência</div>
    <div class="streak-summary-row" style="background:transparent;border:none;padding:0;">
      <div class="streak-flame-box">
        <span class="streak-flame">🔥</span>
        <div>
          <div class="streak-count">${rewardsCache.streak} ${rewardsCache.streak === 1 ? 'dia' : 'dias'} seguidos</div>
          <div class="streak-best">Recorde: ${rewardsCache.longest_streak} ${rewardsCache.longest_streak === 1 ? 'dia' : 'dias'}</div>
        </div>
      </div>
      ${
        nextGoal
          ? `<div class="streak-next-goal">
               <div class="streak-next-label">${escapeHtml(nextGoal.name)} em ${nextGoal.days} dias</div>
               <div class="streak-progress-bar"><div class="streak-progress-fill" style="width:${Math.min(100, (rewardsCache.streak / nextGoal.days) * 100)}%"></div></div>
             </div>`
          : ''
      }
    </div>
    <button type="button" class="home-btn-secondary" id="home-open-rewards" style="width:100%; margin-top:10px;">🎁 Ver loja de recompensas</button>
  `;
  document.getElementById('home-open-rewards').onclick = () => document.getElementById('nav-rewards').click();
}

async function loadHomeStats() {
  const res = await fetch('/api/stats', { credentials: 'include' });
  const stats = await res.json();
  const el = document.getElementById('home-stats');
  el.innerHTML = `
    <div class="home-stat"><span class="home-stat-num">${stats.members}</span><span class="home-stat-label">👥 Membros</span></div>
    <div class="home-stat"><span class="home-stat-num">${stats.servers}</span><span class="home-stat-label">🎮 Servidores</span></div>
    <div class="home-stat"><span class="home-stat-num">${stats.tournaments}</span><span class="home-stat-label">🏆 Torneios</span></div>
  `;
}

function loadHomeServers() {
  const grid = document.getElementById('home-servers-grid');
  grid.innerHTML = '';
  const categories = [...new Set(allChannels.map((c) => c.category))].sort((a, b) => a.localeCompare(b));
  if (categories.length === 0) {
    grid.innerHTML = '<p class="empty-hint">Nenhum servidor criado ainda — clique no + do trilho lateral pra criar o primeiro.</p>';
    return;
  }
  categories.forEach((category) => {
    const channelCount = allChannels.filter((c) => c.category === category).length;
    const card = document.createElement('div');
    card.className = 'home-server-card';
    card.dataset.name = category.toLowerCase();
    const voiceCount = allChannels.filter((c) => c.category === category && c.type === 'voz').length;
    card.innerHTML = `
      <div class="home-server-icon">${serverIcons[category] ? serverIcons[category] : serverInitials(category)}</div>
      <div class="home-server-name">${escapeHtml(category)}</div>
      <div class="home-server-meta">${channelCount} sala${channelCount === 1 ? '' : 's'}${voiceCount > 0 ? ` · 🎙️ ${voiceCount} de voz` : ''}</div>
    `;
    card.onclick = () => {
      activeServerCategory = category;
      renderServerRail([...new Set(allChannels.map((c) => c.category))]);
      const firstChannel = allChannels.find((c) => c.category === category);
      if (firstChannel) selectChannel(firstChannel);
    };
    grid.appendChild(card);
  });
}

async function loadHomeActivity() {
  const el = document.getElementById('home-activity');
  el.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch('/api/activity', { credentials: 'include' });
  const activity = await res.json();
  el.innerHTML = '';
  if (activity.length === 0) {
    el.innerHTML = '<p class="empty-hint">Sem atividade ainda — manda a primeira mensagem!</p>';
    return;
  }
  activity.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'activity-row';
    const time = timeAgo(a.created_at);
    row.innerHTML = `
      <div class="message-avatar">${renderAvatarHtml({ username: a.username })}</div>
      <div class="activity-text">
        <strong>${escapeHtml(a.username)}</strong> em <span class="activity-channel">#${escapeHtml(a.channel_name)}</span>
        <div class="activity-content">${escapeHtml(a.content.slice(0, 80))}</div>
      </div>
      <span class="activity-time">${time}</span>
    `;
    el.appendChild(row);
  });
}

function timeAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr + 'Z').getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `${mins} min atrás`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h atrás`;
  return `${Math.floor(hours / 24)}d atrás`;
}

// Banner grande no topo da tela de Início — destaca o próximo torneio de
// verdade (dados reais de /api/tournaments), igual ao cartão de destaque do
// esboço. Sem torneio nenhum marcado, mostra um convite genérico pra criar um.
async function loadHomeTournamentBanner() {
  const el = document.getElementById('home-tournament-banner');
  const res = await fetch('/api/tournaments', { credentials: 'include' });
  const tournaments = await res.json();
  const upcoming = tournaments.filter((t) => !t.event_date || new Date(t.event_date) >= new Date()).slice(0, 1)[0];

  if (!upcoming) {
    el.innerHTML = `
      <div class="home-tournament-banner-inner">
        <div class="home-tournament-banner-icon">🏆</div>
        <div class="home-tournament-banner-text">
          <span class="home-tournament-banner-kicker">SEM TORNEIOS NO MOMENTO</span>
          <h2>Que tal organizar o primeiro?</h2>
        </div>
        <button class="home-btn-primary" id="home-tournament-banner-cta">Ver Torneios</button>
      </div>
    `;
    document.getElementById('home-tournament-banner-cta').onclick = () => document.getElementById('home-quick-tournaments').click();
    return;
  }

  const dateText = upcoming.event_date
    ? new Date(upcoming.event_date + 'T00:00:00').toLocaleDateString('pt-BR')
    : 'Data a definir';
  el.innerHTML = `
    <div class="home-tournament-banner-inner">
      <div class="home-tournament-banner-icon">🏆</div>
      <div class="home-tournament-banner-text">
        <span class="home-tournament-banner-kicker">${escapeHtml(upcoming.game.toUpperCase())} · ${dateText}</span>
        <h2>${escapeHtml(upcoming.name)}</h2>
        ${upcoming.prize ? `<p class="home-tournament-banner-prize">Premiação total <strong>${escapeHtml(upcoming.prize)}</strong></p>` : ''}
        <span class="home-tournament-banner-slots">👥 ${upcoming.registered_count}/${upcoming.max_slots} inscritos</span>
      </div>
      <button class="home-btn-primary" id="home-tournament-banner-join">
        ${upcoming.is_registered ? 'Você já está inscrito ✅' : 'PARTICIPAR'}
      </button>
    </div>
  `;
  if (!upcoming.is_registered) {
    document.getElementById('home-tournament-banner-join').onclick = async () => {
      const res2 = await fetch(`/api/tournaments/${upcoming.id}/register`, { method: 'POST', credentials: 'include' });
      const data = await res2.json();
      if (!res2.ok) {
        alert(data.error || 'Erro');
        return;
      }
      loadHomeTournamentBanner();
    };
  }
}

async function loadHomeRanking() {
  const el = document.getElementById('home-ranking');
  const res = await fetch('/api/ranking', { credentials: 'include' });
  const ranking = await res.json();
  el.innerHTML = '';
  if (ranking.length === 0) {
    el.innerHTML = '<p class="empty-hint">Sem atividade suficiente essa semana.</p>';
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  ranking.slice(0, 5).forEach((u, i) => {
    const row = document.createElement('div');
    row.className = 'ranking-row';
    row.innerHTML = `
      <span class="ranking-position">${medals[i] || i + 1}</span>
      <div class="member-avatar">${renderAvatarHtml(u)}</div>
      <span class="ranking-name">${escapeHtml(u.username)}</span>
      <span class="ranking-points">${u.points} msgs</span>
    `;
    el.appendChild(row);
  });
}

// ---------- TEXT CHAT ----------

const REACTION_EMOJIS = ['👍', '❤️', '😂', '🔥', '😮', '🎮'];

async function joinTextChannel(channelId) {
  socket.emit('channel:join', channelId);
  typingUsers[channelId] = {};
  renderTypingIndicator();
  const res = await fetch(`/api/channels/${channelId}/messages`, { credentials: 'include' });
  const messages = await res.json();
  const container = document.getElementById('messages');
  container.innerHTML = '';
  messages.forEach(renderMessage);
  container.scrollTop = container.scrollHeight;
  markChannelRead(channelId);
}

// Marca a conversa como lida (zera o contador de não lidas) — chamado
// sempre que a pessoa realmente abre o canal/DM na tela.
function markChannelRead(channelId) {
  fetch(`/api/channels/${encodeURIComponent(channelId)}/read`, { method: 'POST', credentials: 'include' })
    .then(() => {
      if (channelId.startsWith('dm::')) refreshMessagesBadge();
    })
    .catch(() => {});
}

// Carrega o histórico do "Chat da Sala" (mesma conversa do channel_id da
// sala de voz, só que renderizada na coluna lateral).
async function loadVoiceChatHistory(channelId) {
  const res = await fetch(`/api/channels/${channelId}/messages`, { credentials: 'include' });
  const messages = await res.json();
  const container = document.getElementById('voice-chat-messages');
  container.innerHTML = '';
  messages.forEach(renderMessage);
  container.scrollTop = container.scrollHeight;
}

const BOT_USER_ID = 'system-bot';
const AI_BOT_USER_ID = 'ai-assistant-bot';

// Salas de voz também têm chat de texto (o "Chat da Sala" ao lado da
// chamada) — usa o mesmo channel_id, só muda pra qual <div> a mensagem vai.
function messagesContainerFor(channelId) {
  // Cobre tanto canais normais de voz quanto uma ligação individual (DM) —
  // nos dois casos, se você está conectado por voz nessa sala agora, a
  // mensagem vai pro "Chat da Sala" em vez do chat principal.
  const isVoiceChannel = channelId === connectedVoiceRoomId || allChannels.some((c) => c.id === channelId && c.type === 'voz');
  return document.getElementById(isVoiceChannel ? 'voice-chat-messages' : 'messages');
}

// ---------- CONVITE PARA JOGAR (dentro da conversa) ----------
// Reaproveita 100% a infraestrutura de mensagem existente — é só uma
// mensagem normal com um prefixo reconhecível, sem tabela nova no banco.
// "Aceitar/Recusar" simplesmente manda outra mensagem de resposta; não tem
// nenhum estado de "sessão de jogo" pra gerenciar, de propósito, pra não
// duplicar o sistema de LFG/matchmaking que já existe em outro lugar do app.
const GAME_INVITE_PREFIX = '__GAME_INVITE__::';

// Texto amigável pra prévias (lista de conversas, "última mensagem") —
// esconde o formato interno do convite de jogo atrás de um resumo legível.
// Aceita tanto uma string de conteúdo quanto o objeto de mensagem inteiro
// (pra também detectar anexo em mensagens sem texto nenhum).
function messagePreviewText(msgOrContent) {
  const isObj = msgOrContent && typeof msgOrContent === 'object';
  const content = isObj ? msgOrContent.content : msgOrContent;
  const attachment = isObj ? msgOrContent.attachment : null;
  if (content && content.startsWith(GAME_INVITE_PREFIX)) return '🎮 Convite pra jogar';
  // BUG CORRIGIDO: mensagem que era só um link (convite de servidor, por
  // exemplo) aparecia crua e enorme na prévia da lista de conversas,
  // estourando a largura da coluna. Mostra um resumo curto em vez do link.
  if (content && /^https?:\/\/\S+$/.test(content.trim())) return '🔗 Link enviado';
  if (content) return content.replace(/https?:\/\/\S+/g, '🔗 link');
  if (attachment) return (attachment.type || '').startsWith('image/') ? '📎 Imagem enviada' : '📎 Arquivo enviado';
  return '';
}

function renderMessageContentHtml(msg) {
  if (msg.content.startsWith(GAME_INVITE_PREFIX)) {
    let payload;
    try {
      payload = JSON.parse(msg.content.slice(GAME_INVITE_PREFIX.length));
    } catch (_) {
      payload = null;
    }
    if (payload && payload.game) {
      const isFromMe = msg.user_id === me.id;
      return `
        <div class="content game-invite-card">
          <div class="game-invite-header"><span class="ng-icon-wrap" data-icon="gamepad-2"></span> CONVITE PARA JOGAR</div>
          <div class="game-invite-body">${isFromMe ? 'Você convidou pra jogar' : escapeHtml(payload.from || msg.username) + ' te convidou pra jogar'} <strong>${escapeHtml(payload.game)}</strong>.</div>
          ${
            isFromMe
              ? '<div class="game-invite-waiting">Aguardando resposta...</div>'
              : `<div class="game-invite-actions">
                   <button type="button" class="game-invite-accept" data-game="${escapeHtml(payload.game)}">✅ Aceitar</button>
                   <button type="button" class="game-invite-decline" data-game="${escapeHtml(payload.game)}">❌ Recusar</button>
                 </div>`
          }
        </div>
      `;
    }
  }
  const textHtml = msg.content ? `<div class="content">${linkifyHtml(escapeHtml(msg.content))}</div>` : '';
  return textHtml + renderAttachmentHtml(msg.attachment);
}

// Anexo de arquivo numa mensagem — imagem aparece inline, qualquer outro
// tipo vira um cartão de download. O arquivo em si é um data URL (base64)
// que já veio junto com a mensagem, não precisa de nenhuma outra requisição.
function renderAttachmentHtml(attachment) {
  // .url = arquivo grande no R2 (NEXTGAME PLUS ou FREE dentro do limite
  // maior); .data = base64 pequeno direto na mensagem (caminho antigo, sem R2).
  const src = attachment && (attachment.url || attachment.data);
  if (!src) return '';
  const safeName = escapeHtml(attachment.name || 'arquivo');
  if ((attachment.type || '').startsWith('image/')) {
    return `
      <div class="message-attachment-image-wrap">
        <img class="message-attachment-image" src="${src}" alt="${safeName}" loading="lazy" />
        <a class="message-attachment-download-btn" href="${src}" download="${safeName}" title="Baixar imagem" onclick="event.stopPropagation()">
          <span class="ng-icon-wrap" data-icon="download"></span>
        </a>
      </div>
    `;
  }
  return `
    <a class="message-attachment-card" href="${src}" download="${safeName}" target="_blank" rel="noopener">
      <span class="ng-icon-wrap" data-icon="upload"></span>
      <div style="min-width:0;">
        <div class="attachment-name">${safeName}</div>
        <div class="attachment-size">${formatFileSize(attachment.size || 0)}</div>
      </div>
    </a>
  `;
}

function renderMessage(msg) {
  const container = messagesContainerFor(msg.channel_id);
  if (!container) return;
  const el = document.createElement('div');
  const isBot = msg.user_id === BOT_USER_ID;
  el.className = 'message' + (isBot ? ' bot-message' : '');
  el.dataset.id = msg.id;
  const time = new Date(msg.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const author = allUsers.find((u) => u.id === msg.user_id);
  const isOwn = msg.user_id === me.id;
  const canDelete = (isOwn || me.is_admin) && !isBot;

  const avatarHtml = isBot
    ? '<span>🤖</span>'
    : renderAvatarHtml(author || { username: msg.username });
  const avatarFrameCls = isBot ? '' : avatarFrameClass(author || {});

  el.innerHTML = `
    <div class="message-row">
      <div class="message-avatar ${avatarFrameCls}">${avatarHtml}</div>
      <div class="message-body">
        <div class="meta">
          <strong>${escapeHtml(msg.username)}</strong>
          ${isBot ? '<span class="bot-tag">BOT</span>' : ''}
          · ${time}
          ${msg.edited ? '<span class="edited-tag">(editado)</span>' : ''}
          ${msg.pinned ? '<span class="pinned-tag">📌 fixada</span>' : ''}
        </div>
        ${msg.thread_parent_id ? '<div class="thread-reply-tag">↪ resposta numa thread</div>' : ''}
        ${renderMessageContentHtml(msg)}
        <div class="message-reactions" id="reactions-${msg.id}"></div>
      </div>
    </div>
    <div class="message-actions">
      ${isBot ? '' : '<button class="act-react" title="Reagir">😀</button>'}
      ${isBot ? '' : '<button class="act-reply" title="Responder em thread">↩️</button>'}
      <button class="act-pin" title="${msg.pinned ? 'Desafixar' : 'Fixar'}">📌</button>
      ${isOwn && !isBot ? '<button class="act-edit" title="Editar">✏️</button>' : ''}
      ${canDelete ? '<button class="act-delete" title="Apagar">🗑️</button>' : ''}
      ${isBot ? '' : '<button class="act-report" title="Denunciar">🚩</button>'}
    </div>
    <div class="reaction-picker" id="picker-${msg.id}">
      ${REACTION_EMOJIS.map((e) => `<button data-emoji="${e}">${e}</button>`).join('')}
    </div>
  `;

  // Botões de aceitar/recusar do card de "convite pra jogar" — só existem
  // quando a mensagem é um convite recebido (não o meu próprio, que mostra
  // "aguardando resposta" em vez de botão).
  const gameAcceptBtn = el.querySelector('.game-invite-accept');
  if (gameAcceptBtn) {
    gameAcceptBtn.onclick = () => {
      socket.emit('chat:message', { channelId: msg.channel_id, content: `✅ Topei! Bora jogar ${gameAcceptBtn.dataset.game} 🎮` });
    };
  }
  const gameDeclineBtn = el.querySelector('.game-invite-decline');
  if (gameDeclineBtn) {
    gameDeclineBtn.onclick = () => {
      socket.emit('chat:message', { channelId: msg.channel_id, content: `❌ Não vai dar dessa vez, valeu pelo convite!` });
    };
  }

  // Clique no avatar/nome abre o perfil; clique direito abre o menu de
  // contexto (amizade, banir) — igual Discord. Não se aplica ao bot.
  if (!isBot && author) {
    const avatarEl = el.querySelector('.message-avatar');
    const nameEl = el.querySelector('.meta strong');
    [avatarEl, nameEl].forEach((elm) => {
      elm.style.cursor = 'pointer';
      elm.onclick = (e) => {
        e.stopPropagation();
        openProfilePreview(author);
      };
      elm.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, buildUserContextMenuItems(author));
      };
    });
  }

  if (!isBot) {
    el.querySelector('.act-react').onclick = (e) => {
      e.stopPropagation();
      document.querySelectorAll('.reaction-picker.open').forEach((p) => p.classList.remove('open'));
      el.querySelector('.reaction-picker').classList.toggle('open');
    };
    el.querySelectorAll('.reaction-picker button').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        socket.emit('chat:react', { messageId: msg.id, emoji: btn.dataset.emoji });
        el.querySelector('.reaction-picker').classList.remove('open');
      };
    });
  }
  if (isOwn) {
    el.querySelector('.act-edit').onclick = (e) => {
      e.stopPropagation();
      startEditMessage(el, msg);
    };
  }
  if (canDelete) {
    el.querySelector('.act-delete').onclick = (e) => {
      e.stopPropagation();
      if (confirm('Apagar essa mensagem?')) socket.emit('chat:delete', { messageId: msg.id });
    };
  }
  if (!isBot) {
    el.querySelector('.act-report').onclick = (e) => {
      e.stopPropagation();
      reportMessage(msg.id, msg.user_id);
    };
  }
  el.querySelector('.act-pin').onclick = async (e) => {
    e.stopPropagation();
    await fetch(`/api/messages/${msg.id}/${msg.pinned ? 'unpin' : 'pin'}`, { method: 'POST', credentials: 'include' });
  };
  if (!isBot) {
    el.querySelector('.act-reply').onclick = (e) => {
      e.stopPropagation();
      setReplyingTo({ id: msg.id, username: msg.username });
    };
  }

  container.appendChild(el);
  if (msg.reactions && msg.reactions.length > 0) renderReactions(msg.id, msg.reactions);
  container.scrollTop = container.scrollHeight;
}

function renderReactions(messageId, reactions) {
  const el = document.getElementById('reactions-' + messageId);
  if (!el) return;
  el.innerHTML = '';
  reactions
    .filter((r) => r.count > 0)
    .forEach((r) => {
      const chip = document.createElement('span');
      chip.className = 'reaction-chip' + (r.reacted ? ' reacted' : '');
      chip.textContent = `${r.emoji} ${r.count}`;
      chip.onclick = () => socket.emit('chat:react', { messageId, emoji: r.emoji });
      el.appendChild(chip);
    });
}

function startEditMessage(el, msg) {
  const contentEl = el.querySelector('.content');
  const original = msg.content;
  contentEl.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = original;
  input.className = 'edit-inline-input';
  input.style.cssText = 'width:100%;padding:6px;border-radius:4px;border:1px solid #5865f2;background:#26272e;color:#e6e6e6;';
  contentEl.appendChild(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  function save() {
    const newContent = input.value.trim();
    if (newContent && newContent !== original) {
      socket.emit('chat:edit', { messageId: msg.id, content: newContent });
    } else {
      contentEl.textContent = original;
    }
  }
  input.onkeydown = (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') contentEl.textContent = original;
  };
  input.onblur = save;
}

document.addEventListener('click', () => {
  document.querySelectorAll('.reaction-picker.open').forEach((p) => p.classList.remove('open'));
});

async function reportMessage(messageId, reportedUserId) {
  const reason = prompt('Motivo da denúncia (ex: assédio, conteúdo impróprio, spam):');
  if (!reason) return;
  await fetch('/api/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ message_id: messageId, reported_user_id: reportedUserId, reason }),
  });
  alert('Denúncia enviada. Um moderador irá revisar.');
}

// ---------- INDICADOR DE "DIGITANDO..." ----------

function renderTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  if (!el || !currentChannel) return;
  const users = Object.values(typingUsers[currentChannel.id] || {});
  if (users.length === 0) {
    el.textContent = '';
  } else if (users.length === 1) {
    el.textContent = `${users[0]} está digitando...`;
  } else {
    el.textContent = `${users.join(', ')} estão digitando...`;
  }
}

const messageInput = document.getElementById('message-input');
let isTyping = false;
messageInput.addEventListener('input', () => {
  if (!currentChannel) return;
  if (!isTyping) {
    isTyping = true;
    socket.emit('typing:start', currentChannel.id);
  }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    isTyping = false;
    socket.emit('typing:stop', currentChannel.id);
  }, 2000);
});

// ---------- RESPONDER EM THREAD (thread simples, dentro da mesma conversa) ----------
let replyingToMessage = null; // { id, username }

function setReplyingTo(msg) {
  replyingToMessage = msg ? { id: msg.id, username: msg.username } : null;
  const banner = document.getElementById('reply-banner');
  if (!banner) return;
  banner.classList.toggle('hidden', !replyingToMessage);
  if (replyingToMessage) {
    banner.querySelector('.reply-banner-text').textContent = `Respondendo a ${replyingToMessage.username}`;
    document.getElementById('message-input').focus();
  }
}

document.getElementById('btn-cancel-reply').onclick = () => setReplyingTo(null);

// Anexo de arquivo — igual Discord: escolhe o arquivo, aparece uma prévia
// acima da caixa de digitar, e vai junto quando manda a mensagem (mesmo sem
// nenhum texto). NEXTGAME PLUS: arquivo grande sobe direto pro storage
// (Cloudflare R2) com barra de progresso; sem R2 configurado no servidor,
// cai num limite pequeno guardado direto no banco (comportamento antigo).
let uploadLimits = { configured: false, limitBytes: 5 * 1024 * 1024, plan: 'free' };
async function loadUploadLimits() {
  try {
    const res = await fetch('/api/uploads/limits', { credentials: 'include' });
    if (res.ok) uploadLimits = await res.json();
  } catch (_) {}
}

let pendingAttachment = null;

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// Sobe (ou codifica em base64, se não tiver R2) um arquivo e devolve o
// objeto de anexo pronto pra mandar no chat:message. onProgress recebe um
// número de 0 a 100. Reaproveitado pelo chat principal e pelo chat da sala
// de voz — os dois têm a mesma lógica, só muda onde o resultado é guardado.
async function uploadAttachmentFile(file, onProgress) {
  if (file.size > uploadLimits.limitBytes) {
    throw new Error(`Arquivo muito grande — o limite do seu plano é ${formatFileSize(uploadLimits.limitBytes)}.`);
  }
  if (!uploadLimits.configured) {
    // Sem R2: volta pro caminho antigo (base64 direto no banco, arquivo
    // pequeno). Não dá progresso de verdade, mas é rápido o bastante pra
    // não fazer falta num arquivo desse tamanho.
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Erro ao ler o arquivo.'));
      reader.readAsDataURL(file);
    });
    if (onProgress) onProgress(100);
    return { name: file.name, type: file.type || 'application/octet-stream', size: file.size, data };
  }

  // Com R2: pede uma URL de upload assinada e manda o arquivo direto pro
  // storage (não passa pelo nosso servidor) — usa XMLHttpRequest em vez de
  // fetch porque só o XHR tem evento de progresso de upload.
  const presignRes = await fetch('/api/uploads/presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ filename: file.name, contentType: file.type || 'application/octet-stream', size: file.size }),
  });
  const presign = await presignRes.json();
  if (!presignRes.ok) throw new Error(presign.error || 'Erro ao preparar upload.');
  if (!presign.configured) {
    // Servidor perdeu a config no meio do caminho (raro) — cai pro base64.
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Erro ao ler o arquivo.'));
      reader.readAsDataURL(file);
    });
    if (onProgress) onProgress(100);
    return { name: file.name, type: file.type || 'application/octet-stream', size: file.size, data };
  }

  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', presign.uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('Erro ao subir o arquivo (' + xhr.status + ').')));
    xhr.onerror = () => reject(new Error('Erro de rede ao subir o arquivo.'));
    xhr.send(file);
  });

  return { name: file.name, type: file.type || 'application/octet-stream', size: file.size, url: presign.publicUrl };
}

document.getElementById('btn-attach-file').onclick = () => {
  document.getElementById('message-attachment-input').click();
};

document.getElementById('message-attachment-input').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const previewEl = document.getElementById('attachment-preview');
  const nameEl = document.getElementById('attachment-preview-name');
  previewEl.classList.remove('hidden');
  nameEl.textContent = `Enviando ${file.name}... 0%`;
  try {
    pendingAttachment = await uploadAttachmentFile(file, (pct) => {
      nameEl.textContent = `Enviando ${file.name}... ${pct}%`;
    });
    nameEl.textContent = `${file.name} (${formatFileSize(file.size)})`;
  } catch (err) {
    alert(err.message || 'Erro ao anexar arquivo.');
    pendingAttachment = null;
    previewEl.classList.add('hidden');
  }
};

document.getElementById('btn-remove-attachment').onclick = () => {
  pendingAttachment = null;
  document.getElementById('attachment-preview').classList.add('hidden');
};

document.getElementById('form-message').onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content && !pendingAttachment) return;
  if (!currentChannel) return;
  socket.emit('chat:message', {
    channelId: currentChannel.id,
    content,
    threadParentId: replyingToMessage ? replyingToMessage.id : undefined,
    attachment: pendingAttachment || undefined,
  });
  input.value = '';
  pendingAttachment = null;
  document.getElementById('attachment-preview').classList.add('hidden');
  setReplyingTo(null);
  clearTimeout(typingTimeout);
  isTyping = false;
  socket.emit('typing:stop', currentChannel.id);
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Transforma links (http/https) dentro de um texto JÁ escapado em <a>
// clicáveis — usado nas mensagens de chat, pra links de convite mandados
// por DM (ex: "entra aqui: https://.../?invite=...") funcionarem de
// verdade em vez de ficar como texto morto. Roda DEPOIS do escapeHtml,
// nunca antes, senão abriria brecha de XSS.
function linkifyHtml(escapedText) {
  return escapedText.replace(/(https?:\/\/[^\s<]+)/g, (url) => {
    // remove pontuação de fechamento grudada no fim (. , ) etc) pra não quebrar o link
    const trailingMatch = url.match(/[.,;:!?)]+$/);
    const trailing = trailingMatch ? trailingMatch[0] : '';
    const clean = trailing ? url.slice(0, -trailing.length) : url;
    return `<a href="${clean}" target="_blank" rel="noopener noreferrer" class="msg-link">${clean}</a>${trailing}`;
  });
}

// ---------- SOCKET HANDLERS ----------

function registerSocketHandlers() {
  // Reconectar (queda de internet, ou o servidor reiniciando por causa de
  // um deploy novo) é o gatilho mais rápido pra perceber uma atualização —
  // não precisa esperar o próximo tick do setInterval de 5 minutos.
  socket.on('connect', () => checkForUpdates());

  socket.on('chat:message', (msg) => {
    if (currentChannel && msg.channel_id === currentChannel.id) {
      renderMessage(msg);
      // Já está com essa DM aberta na tela — a mensagem que acabou de
      // chegar não deve contar como "não lida" no contador.
      if (msg.channel_id.startsWith('dm::') && msg.user_id !== me.id) markChannelRead(msg.channel_id);
    } else if (msg.channel_id.startsWith('dm::') && msg.user_id !== me.id) {
      refreshMessagesBadge();
    }
    if (msg.user_id !== me.id) {
      const mentioned = msg.content && msg.content.toLowerCase().includes('@' + me.username.toLowerCase());
      if (mentioned) SFX.mention();
      else SFX.message();
    }
  });

  socket.on('chat:blocked', ({ reason }) => {
    alert('⚠️ ' + reason);
  });

  // Alguém que eu sigo foi ao vivo — toast de notificação.
  socket.on('stream:live', ({ username, title }) => {
    if (window.notificationPrefs && window.notificationPrefs.transmissao === false) return;
    showCopyToast(`🔴 ${username} está ao vivo: ${title}`);
    SFX.mention && SFX.mention();
  });

  // Mensagem nova em algum canal de um servidor que não estou olhando agora
  // — acende o badge vermelho no ícone dele no trilho, igual Discord.
  socket.on('server:activity', ({ category, channel_id }) => {
    if (currentChannel && currentChannel.id === channel_id) return; // já estou vendo esse canal
    bumpUnreadServer(category);
  });

  socket.on('chat:edited', ({ id, content, channel_id }) => {
    if (!currentChannel || channel_id !== currentChannel.id) return;
    const el = document.querySelector(`.message[data-id="${id}"] .content`);
    if (el) el.textContent = content;
    const meta = document.querySelector(`.message[data-id="${id}"] .meta`);
    if (meta && !meta.querySelector('.edited-tag')) {
      const tag = document.createElement('span');
      tag.className = 'edited-tag';
      tag.textContent = '(editado)';
      meta.appendChild(tag);
    }
  });

  socket.on('chat:deleted', ({ id, channel_id }) => {
    if (!currentChannel || channel_id !== currentChannel.id) return;
    const el = document.querySelector(`.message[data-id="${id}"]`);
    if (el) el.remove();
  });

  socket.on('chat:reactions', ({ messageId, channel_id, reactions }) => {
    if (!currentChannel || channel_id !== currentChannel.id) return;
    renderReactions(messageId, reactions.map((r) => ({ emoji: r.emoji, count: r.count, reacted: r.users.includes(me.id) })));
  });

  socket.on('typing:update', ({ userId, username, typing }) => {
    if (!currentChannel) return;
    if (!typingUsers[currentChannel.id]) typingUsers[currentChannel.id] = {};
    if (typing) typingUsers[currentChannel.id][userId] = username;
    else delete typingUsers[currentChannel.id][userId];
    renderTypingIndicator();
  });

  socket.on('presence:online', (entries) => {
    // entries: [{id, status}] — quem está invisível nem aparece aqui (o
    // backend já filtra), então "está na lista" = "está visível pros outros".
    onlineUserIds = new Set(entries.map((e) => e.id));
    presenceStatusMap = {};
    entries.forEach((e) => (presenceStatusMap[e.id] = e.status));
    renderMembers();
  });

  // Sala de voz bateu no teto de participantes (mesh P2P não aguenta mais
  // sem travar pra todo mundo) — avisa e cancela a tentativa de entrar.
  socket.on('rtc:room-full', ({ max }) => {
    connectedVoiceRoomId = null;
    alert(`Essa sala de voz está cheia (máximo de ${max} pessoas ao mesmo tempo). Espera alguém sair ou crie outra sala.`);
    document.getElementById('voice-panel')?.classList.add('hidden');
  });

  // BUG DA DUPLICAÇÃO CORRIGIDO: você entrou nessa mesma sala em outra
  // aba/dispositivo, e o servidor derrubou a conexão de voz DESSA aba de
  // propósito pra não ficar duplicado. Limpa o estado local (mic, câmera,
  // conexões) sem re-tentar nada — a call continua normal na outra aba.
  socket.on('rtc:duplicate-session', ({ roomId }) => {
    if (connectedVoiceRoomId !== roomId) return;
    disconnectVoice(true);
    showCopyToast('Você entrou nessa chamada em outra aba — saiu dela aqui.');
    document.getElementById('voice-panel')?.classList.add('hidden');
  });

  socket.on('rtc:peer-joined', ({ socketId, username, avatar, avatar_frame }) => {
    const pc = createPeerConnection(socketId, username, { username, avatar, avatar_frame });
    addLocalTracksToPeer(pc);
    logVoiceActivity(`${username} entrou na sala`);
    updateVoiceParticipantCount();
    SFX.peerJoin();
  });

  socket.on('rtc:peer-left', ({ socketId, username }) => {
    clearReconnectAttempt(socketId);
    if (peers[socketId]) {
      peers[socketId].close();
      delete peers[socketId];
    }
    delete remoteStreams[socketId];
    delete remotePeerInfo[socketId];
    stopConnectionQualityMonitor(socketId);
    logVoiceActivity(`${username || 'Alguém'} saiu da sala`);
    updateVoiceParticipantCount();
    removeVideoTile(socketId);
    SFX.peerLeave();
  });

  socket.on('rtc:signal', async ({ from, username, avatar, avatar_frame, data }) => {
    let pc = peers[from];
    if (!pc) {
      pc = createPeerConnection(from, username, { username, avatar, avatar_frame });
      addLocalTracksToPeer(pc);
    }
    if (data.type === 'offer') {
      await pc.setRemoteDescription(data);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('rtc:signal', { to: from, data: pc.localDescription });
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(data);
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data);
      } catch (_) {}
    }
  });

  // Presença global: quem está em cada sala de voz, pra mostrar no menu
  // lateral mesmo pra quem não está conectado (igual Discord).
  socket.on('voice:state', (state) => {
    voiceParticipants = state;
    renderCategories(allChannels);
    if (currentChannel && currentChannel.type === 'voz') updateVoicePanelView(currentChannel);
  });

  socket.on('voice:update', ({ roomId, participants }) => {
    voiceParticipants[roomId] = participants;
    renderCategories(allChannels);
    if (currentChannel && currentChannel.type === 'voz' && currentChannel.id === roomId) {
      updateVoicePanelView(currentChannel);
    }
  });

  // Sala Rápida foi apagada sozinha (todo mundo saiu) — some da lista pra
  // todo mundo, e se alguém ainda estava com ela aberta na tela, volta pro Início.
  socket.on('channel:deleted', ({ id, category }) => {
    allChannels = allChannels.filter((c) => c.id !== id);
    if (connectedVoiceRoomId === id) {
      disconnectVoice();
      showCopyToast('Essa sala de voz foi apagada.');
    }
    if (currentChannel && currentChannel.id === id) {
      goHome();
    }
    if (category === activeServerCategory) renderCategories(allChannels);
  });

  // Sala foi renomeada — atualiza o nome na lista de canais e, se for a que
  // tá aberta agora, no cabeçalho também.
  socket.on('channel:renamed', ({ id, name }) => {
    const ch = allChannels.find((c) => c.id === id);
    if (ch) ch.name = name;
    if (currentChannel && currentChannel.id === id) {
      currentChannel.name = name;
      document.getElementById('current-channel-name').textContent = (currentChannel.type === 'voz' ? '🔊 ' : '# ') + name;
    }
    renderCategories(allChannels);
  });

  // O dono apagou o servidor inteiro — todo mundo que estava nele sai na hora.
  socket.on('server:deleted', ({ category }) => {
    allChannels = allChannels.filter((c) => c.category !== category);
    if (connectedVoiceRoomId && allChannels.every((c) => c.id !== connectedVoiceRoomId)) disconnectVoice();
    if (activeServerCategory === category) {
      activeServerCategory = null;
      showCopyToast('Esse servidor foi apagado pelo dono.');
      goHome();
    }
    loadChannels();
  });

  // NEXT Music — o servidor manda o estado completo (fila + o que tá
  // tocando + posição) toda vez que algo muda, então o cliente só precisa
  // "obedecer": não guarda estado próprio de verdade, só espelha o do servidor.
  socket.on('music:state', (state) => {
    if (state.roomId && state.roomId !== connectedVoiceRoomId) return;
    currentMusicState = state;
    renderMusicPanel(state);
    syncMusicPlayer(state);
  });

  // Alguém te ligou diretamente (DM) — mostra um toast com som pra atender.
  socket.on('dm:ring', ({ fromUsername, channelId }) => {
    SFX.join();
    showCallToast(fromUsername, channelId);
  });

  // Mensagem de DM chegou e a pessoa não está com essa conversa aberta —
  // mostra o pop-up (o som já toca no handler de chat:message, não repete aqui).
  socket.on('dm:notify', ({ fromUsername, channelId, preview }) => {
    if (currentChannel && currentChannel.id === channelId) return;
    showMessageToast(fromUsername, channelId, preview);
  });

  // Um admin limpou uma conversa — atualiza a view de quem estiver vendo agora.
  socket.on('chat:cleared', ({ channel_id }) => {
    if (currentChannel && currentChannel.id === channel_id) {
      clearMessagesView(channel_id);
    } else if (channel_id === connectedVoiceRoomId) {
      clearMessagesView(channel_id);
    }
  });

  // Alguém fixou/desafixou uma mensagem — atualiza a tag "📌 fixada" na hora,
  // sem precisar recarregar a conversa inteira.
  socket.on('message:pinned', ({ id, pinned }) => {
    document.querySelectorAll(`.message[data-id="${id}"]`).forEach((el) => {
      const meta = el.querySelector('.meta');
      const existingTag = meta.querySelector('.pinned-tag');
      if (pinned && !existingTag) {
        const tag = document.createElement('span');
        tag.className = 'pinned-tag';
        tag.textContent = '📌 fixada';
        meta.appendChild(tag);
      } else if (!pinned && existingTag) {
        existingTag.remove();
      }
      const pinBtn = el.querySelector('.act-pin');
      if (pinBtn) pinBtn.title = pinned ? 'Desafixar' : 'Fixar';
    });
    if (currentChannel && currentChannel.id === document.getElementById('modal-pinned-messages')?.dataset.channelId) {
      loadPinnedMessages(currentChannel.id);
    }
  });

  // Um admin viu um frame de transmissão marcado pela moderação — avisa na hora.
  socket.on('moderation:frame-flagged', ({ username, reason }) => {
    if (!me.is_admin) return;
    alert(`⚠️ Transmissão de ${username} foi marcada pela moderação: ${reason || 'conteúdo sinalizado'}. Confira no painel de admin.`);
  });

  // Alerta URGENTE pra admin: a IA suspendeu uma conta automaticamente
  // (suspeita de conteúdo infantil em contexto de risco) — precisa de
  // revisão humana o quanto antes.
  socket.on('moderation:auto-suspended-alert', ({ username, reason }) => {
    if (!me.is_admin) return;
    alert(`🚨 SUSPENSÃO AUTOMÁTICA: a conta de ${username} foi suspensa pela IA de moderação (${reason || 'conteúdo sinalizado'}). Revise urgentemente no painel de admin.`);
  });

  // A própria pessoa foi tirada da chamada pela moderação (tela/câmera
  // sinalizada) — sai da call na hora, sem esperar o servidor derrubar a
  // conexão P2P por timeout.
  socket.on('moderation:kicked-from-call', ({ reason }) => {
    alert('Você foi removido da chamada pelo filtro de segurança: ' + (reason || 'conteúdo sinalizado') + '. Isso foi registrado para revisão de um moderador.');
    disconnectVoice();
  });

  // A conta foi suspensa (banida) enquanto a pessoa estava com a aba
  // aberta — derruba a sessão local na hora, não espera a próxima ação.
  socket.on('account:suspended', () => {
    alert('Sua conta foi suspensa automaticamente pelo filtro de segurança, aguardando revisão de um moderador.');
    window.location.reload();
  });
}

// ---------- WEBRTC (voz / compartilhamento de tela) ----------

async function connectVoice(roomId) {
  // BUG DO "RETORNO" CORRIGIDO: sem essa trava, um duplo-clique em "Entrar na
  // chamada" (ou os dois caminhos que chamam connectVoice — auto-connect ao
  // selecionar o canal e o botão do preview — disparando quase juntos) rodava
  // startMicrophone() duas vezes pra mesma sala. Isso pegava o microfone de
  // novo SEM parar o stream antigo, e cada peer passava a receber DUAS
  // tracks de áudio com o seu mic (uma levemente atrasada da outra) — o que
  // todo mundo ouvia como eco/retorno na sua voz. Se já está conectado
  // nessa mesma sala, não faz nada de novo.
  if (connectedVoiceRoomId === roomId) return;

  // Espera a confirmação do servidor (sala não cheia, canal acessível) ANTES
  // de pegar o microfone — senão a pessoa via ouvia o próprio mic ligar numa
  // sala que na verdade rejeitou a entrada dela (ex: sala cheia).
  const joined = await new Promise((resolve) => {
    socket.emit('rtc:join', roomId, (response) => resolve(response || { ok: true }));
    // Servidor antigo sem suporte a ack — não trava esperando pra sempre.
    setTimeout(() => resolve({ ok: true }), 3000);
  });
  if (!joined.ok) {
    if (joined.reason === 'room-full') {
      alert(`Essa sala de voz está cheia (máximo de ${joined.max} pessoas ao mesmo tempo). Espera alguém sair ou crie outra sala.`);
    }
    return;
  }

  SFX.join();
  connectedVoiceRoomId = roomId;
  socket.emit('channel:join', roomId); // pro chat da sala funcionar (mesmo canal, uso duplo texto+voz)
  loadVoiceChatHistory(roomId);
  setupVoiceInvite(roomId);
  clearVoiceActivityLog();
  logVoiceActivity('Você entrou na sala');
  await startMicrophone();
  updateVoiceBar();
  updateVoiceParticipantCount();
}

// skipServerNotify=true quando o SERVIDOR já sabe que saímos (ex: essa aba
// levou um "rtc:duplicate-session" porque outra aba assumiu a call) — nesse
// caso não reemite rtc:leave, senão os outros participantes recebiam o
// aviso de "saiu da sala" em dobro (um do servidor derrubando, outro dessa
// aba se despedindo por conta própria logo em seguida).
function disconnectVoice(skipServerNotify) {
  if (!connectedVoiceRoomId) return;
  SFX.leave();
  stopFrameModeration();
  if (!skipServerNotify) {
    socket.emit('rtc:leave', connectedVoiceRoomId);
    socket.emit('channel:leave', connectedVoiceRoomId);
  }
  Object.keys(peers).forEach((id) => {
    clearReconnectAttempt(id);
    peers[id].close();
    delete peers[id];
    stopConnectionQualityMonitor(id);
  });
  Object.keys(remoteStreams).forEach((id) => delete remoteStreams[id]);
  Object.keys(speakingDetectors).forEach((id) => {
    speakingDetectors[id].ctx.close().catch(() => {});
    cancelAnimationFrame(speakingDetectors[id].rafId);
    delete speakingDetectors[id];
  });
  // Zera o estado de conexão ANTES de parar mic/tela, pra updateLocalTile()
  // não recriar uma tile "local" fantasma no meio da limpeza.
  connectedVoiceRoomId = null;
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  teardownNoiseGate();
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
    updateCameraButton();
    updateCameraModerationBadge();
  }
  document.getElementById('video-grid').innerHTML = '';
  document.getElementById('btn-share-screen').classList.remove('hidden');
  document.getElementById('btn-stop-share').classList.add('hidden');
  setMicStatus('');
  updateVoiceBar();
  renderCategories(allChannels);
  updateVoiceParticipantCount();
  // Saiu da sala — a música dela não é mais "sua", para o player local.
  currentMusicState = null;
  if (ytPlayer && ytPlayerReady) {
    try { ytPlayer.stopVideo(); } catch (_) {}
  }
}

// ---------- NEXT MUSIC (item 14 do plano) ----------
// Player oficial embutido do YouTube (iframe API) — nunca baixa nem guarda
// áudio, só toca o vídeo público direto do YouTube no navegador de cada
// pessoa. O servidor é só o "maestro" que sincroniza fila/posição/play-pause
// entre todo mundo na mesma sala de voz.

let ytPlayer = null;
let ytPlayerReady = false;
let currentMusicState = null;
let musicLastEndedIndex = -1; // evita mandar "acabou" mais de uma vez pro mesmo índice

function ensureMusicPlayerReady() {
  if (ytPlayer || typeof YT === 'undefined' || !YT.Player) return;
  ytPlayer = new YT.Player('music-player-mount', {
    height: '100%',
    width: '100%',
    playerVars: { playsinline: 1, controls: 1, modestbranding: 1, rel: 0 },
    events: {
      onReady: () => {
        ytPlayerReady = true;
        if (currentMusicState) syncMusicPlayer(currentMusicState);
      },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED && currentMusicState && currentMusicState.currentIndex !== musicLastEndedIndex) {
          musicLastEndedIndex = currentMusicState.currentIndex;
          socket.emit('music:track-ended', { roomId: connectedVoiceRoomId, atIndex: currentMusicState.currentIndex });
        }
      },
    },
  });
}

// Chamado pelo callback global da API do YouTube quando o script termina de
// carregar (pode acontecer antes ou depois da sala de voz abrir) — o
// elemento de destino (#music-player-mount) já existe no HTML desde o
// início, só fica escondido dentro de um painel fechado.
window.onYouTubeIframeAPIReady = function () {
  ensureMusicPlayerReady();
};

function syncMusicPlayer(state) {
  if (!ytPlayer || !ytPlayerReady) return;
  if (!state.currentTrack) {
    try { ytPlayer.stopVideo(); } catch (_) {}
    return;
  }
  const targetSeconds = Math.max(0, state.positionMs / 1000);
  let loadedId = null;
  try {
    const url = ytPlayer.getVideoUrl ? ytPlayer.getVideoUrl() : '';
    const m = url && url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    loadedId = m ? m[1] : null;
  } catch (_) {}

  if (loadedId !== state.currentTrack.videoId) {
    if (state.isPlaying) ytPlayer.loadVideoById({ videoId: state.currentTrack.videoId, startSeconds: targetSeconds });
    else ytPlayer.cueVideoById({ videoId: state.currentTrack.videoId, startSeconds: targetSeconds });
    return;
  }
  // Já é o mesmo vídeo — só corrige deriva grande de posição (>3s) e
  // play/pause, sem recarregar o player à toa a cada atualização.
  try {
    const currentSeconds = ytPlayer.getCurrentTime ? ytPlayer.getCurrentTime() : targetSeconds;
    if (Math.abs(currentSeconds - targetSeconds) > 3) ytPlayer.seekTo(targetSeconds, true);
  } catch (_) {}
  if (state.isPlaying) ytPlayer.playVideo();
  else ytPlayer.pauseVideo();
}

function renderMusicPanel(state) {
  const infoEl = document.getElementById('music-now-playing-info');
  const playPauseBtn = document.getElementById('btn-music-playpause');
  const queueEl = document.getElementById('music-queue-list');

  if (!state.currentTrack) {
    infoEl.textContent = 'Fila vazia — cole um link do YouTube abaixo pra começar.';
    playPauseBtn.innerHTML = icon('play');
  } else {
    infoEl.innerHTML = `<strong>${escapeHtml(state.currentTrack.title)}</strong><br/>adicionado por ${escapeHtml(state.currentTrack.addedByUsername)}`;
    playPauseBtn.innerHTML = icon(state.isPlaying ? 'pause' : 'play');
  }

  const upcoming = state.queue || [];
  if (upcoming.length === 0) {
    queueEl.innerHTML = '<p class="empty-hint">Nada na fila ainda.</p>';
    return;
  }
  queueEl.innerHTML = upcoming
    .map(
      (track, i) => `
    <div class="music-queue-item ${i === state.currentIndex ? 'current' : ''}">
      <div class="music-queue-item-info">
        <span class="music-queue-item-title">${i === state.currentIndex ? '▶ ' : ''}${escapeHtml(track.title)}</span>
        <span class="music-queue-item-by">${escapeHtml(track.addedByUsername)}</span>
      </div>
      <button type="button" class="music-queue-item-remove" data-queue-id="${track.id}" title="Remover">${icon('x')}</button>
    </div>
  `
    )
    .join('');
  queueEl.querySelectorAll('.music-queue-item-remove').forEach((btn) => {
    btn.onclick = () => socket.emit('music:remove', { roomId: connectedVoiceRoomId, queueId: btn.dataset.queueId });
  });
}

// Aceita link completo do YouTube (watch?v=, youtu.be/, /embed/) ou o ID puro.
function extractYouTubeId(raw) {
  const trimmed = raw.trim();
  const patterns = [/[?&]v=([a-zA-Z0-9_-]{11})/, /youtu\.be\/([a-zA-Z0-9_-]{11})/, /embed\/([a-zA-Z0-9_-]{11})/];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m) return m[1];
  }
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

document.getElementById('form-music-add').onsubmit = (e) => {
  e.preventDefault();
  if (!connectedVoiceRoomId) return;
  const input = document.getElementById('music-add-input');
  const videoId = extractYouTubeId(input.value);
  if (!videoId) {
    alert('Não reconheci esse link do YouTube. Cole o link completo ou só o ID do vídeo.');
    return;
  }
  socket.emit('music:add', { roomId: connectedVoiceRoomId, videoId });
  input.value = '';
};

document.getElementById('btn-music-playpause').onclick = () => {
  if (!connectedVoiceRoomId) return;
  socket.emit('music:playpause', { roomId: connectedVoiceRoomId });
};

document.getElementById('btn-music-skip').onclick = () => {
  if (!connectedVoiceRoomId) return;
  socket.emit('music:skip', { roomId: connectedVoiceRoomId });
};

// ---------- EXTRAS DA SALA DE VOZ: convite, atividade, participantes, qualidade ----------

async function setupVoiceInvite(roomId) {
  const input = document.getElementById('voice-invite-link');
  input.value = `${window.location.origin}/?channel=${roomId}`; // valor provisório enquanto busca o convite
  const ch = allChannels.find((c) => c.id === roomId);
  if (ch) input.value = await buildChannelInviteLink(ch);
}

document.getElementById('btn-copy-invite').onclick = () => {
  const input = document.getElementById('voice-invite-link');
  input.select();
  navigator.clipboard.writeText(input.value).then(
    () => {
      const btn = document.getElementById('btn-copy-invite');
      const original = btn.textContent;
      btn.textContent = 'Copiado!';
      setTimeout(() => (btn.textContent = original), 1500);
    },
    () => {}
  );
};

function clearVoiceActivityLog() {
  document.getElementById('voice-activity-log').innerHTML = '';
}

function logVoiceActivity(text) {
  const log = document.getElementById('voice-activity-log');
  if (!log) return;
  const line = document.createElement('div');
  line.className = 'activity-line';
  const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  line.innerHTML = `<span>${escapeHtml(text)}</span><span class="activity-line-time">${time}</span>`;
  log.prepend(line);
  while (log.children.length > 8) log.removeChild(log.lastChild);
}

function updateVoiceParticipantCount() {
  const el = document.getElementById('voice-participant-count');
  if (!el || !connectedVoiceRoomId) return;
  const count = Object.keys(peers).length + 1; // +1 é você mesmo
  el.textContent = `${count} na chamada`;
}

// IMPORTANTE: a classe utilitária ".hidden" usa "display: none !important",
// então só alternar uma classe no elemento PAI (chat-open/music-open) não
// basta — precisa remover/adicionar ".hidden" na própria coluna também,
// senão o !important trava ela escondida pra sempre (era o bug do chat e da
// música não aparecerem nunca, mesmo clicando no botão).
document.getElementById('btn-toggle-voice-chat').onclick = () => {
  const wrap = document.getElementById('voice-incall');
  const chatCol = document.getElementById('voice-chat-col');
  const musicCol = document.getElementById('voice-music-col');
  const opening = chatCol.classList.contains('hidden');

  musicCol.classList.add('hidden');
  wrap.classList.remove('music-open');
  document.getElementById('btn-toggle-voice-music').classList.remove('active-state');

  chatCol.classList.toggle('hidden', !opening);
  wrap.classList.toggle('chat-open', opening);
  document.getElementById('btn-toggle-voice-chat').classList.toggle('active-state', opening);
};

// NEXT Music e chat da sala dividem a mesma coluna lateral (só um por vez,
// igual abas) — abrir um fecha o outro.
document.getElementById('btn-toggle-voice-music').onclick = () => {
  const wrap = document.getElementById('voice-incall');
  const chatCol = document.getElementById('voice-chat-col');
  const musicCol = document.getElementById('voice-music-col');
  const opening = musicCol.classList.contains('hidden');

  chatCol.classList.add('hidden');
  wrap.classList.remove('chat-open');
  document.getElementById('btn-toggle-voice-chat').classList.remove('active-state');

  musicCol.classList.toggle('hidden', !opening);
  wrap.classList.toggle('music-open', opening);
  document.getElementById('btn-toggle-voice-music').classList.toggle('active-state', opening);
  if (opening) ensureMusicPlayerReady();
};

// Mesmo suporte a anexo do chat principal, só que com seu próprio estado
// (evita misturar com um anexo pendente no chat de texto do canal, caso a
// pessoa tenha os dois abertos ao mesmo tempo entre trocas de tela).
let pendingVoiceAttachment = null;

document.getElementById('btn-attach-file-voice').onclick = () => {
  document.getElementById('voice-message-attachment-input').click();
};

document.getElementById('voice-message-attachment-input').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const previewEl = document.getElementById('voice-attachment-preview');
  const nameEl = document.getElementById('voice-attachment-preview-name');
  previewEl.classList.remove('hidden');
  nameEl.textContent = `Enviando ${file.name}... 0%`;
  try {
    pendingVoiceAttachment = await uploadAttachmentFile(file, (pct) => {
      nameEl.textContent = `Enviando ${file.name}... ${pct}%`;
    });
    nameEl.textContent = `${file.name} (${formatFileSize(file.size)})`;
  } catch (err) {
    alert(err.message || 'Erro ao anexar arquivo.');
    pendingVoiceAttachment = null;
    previewEl.classList.add('hidden');
  }
};

document.getElementById('btn-remove-voice-attachment').onclick = () => {
  pendingVoiceAttachment = null;
  document.getElementById('voice-attachment-preview').classList.add('hidden');
};

document.getElementById('form-voice-message').onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById('voice-message-input');
  const content = input.value.trim();
  if ((!content && !pendingVoiceAttachment) || !connectedVoiceRoomId) return;
  socket.emit('chat:message', { channelId: connectedVoiceRoomId, content, attachment: pendingVoiceAttachment || undefined });
  input.value = '';
  pendingVoiceAttachment = null;
  document.getElementById('voice-attachment-preview').classList.add('hidden');
};

// Resumo geral de qualidade da chamada (média de todos os participantes),
// atualizado a partir dos mesmos dados do monitor por-participante.
function updateVoiceQualitySummary() {
  const el = document.getElementById('voice-quality-summary');
  if (!el || !connectedVoiceRoomId) return;
  const dots = document.querySelectorAll('#video-grid .quality-dot');
  if (dots.length === 0) {
    el.innerHTML = '<span class="hint" style="margin:0;">Sozinho na sala por enquanto.</span>';
    return;
  }
  const poorCount = document.querySelectorAll('#video-grid .quality-poor').length;
  const mediumCount = document.querySelectorAll('#video-grid .quality-medium').length;
  let label = 'Excelente';
  let cls = 'q-good';
  if (poorCount > 0) {
    label = 'Instável';
    cls = 'q-poor';
  } else if (mediumCount > 0) {
    label = 'Boa';
    cls = 'q-medium';
  }
  el.innerHTML = `
    <div class="voice-quality-badge ${cls}">📶 ${label}</div>
    <div class="voice-quality-ping">Baseado na conexão com ${dots.length} participante${dots.length === 1 ? '' : 's'}</div>
  `;
}
setInterval(updateVoiceQualitySummary, 3500);

function addLocalTracksToPeer(pc) {
  if (micStream) {
    const outgoing = getOutgoingMicStream();
    outgoing.getTracks().forEach((track) => pc.addTrack(track, outgoing));
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => pc.addTrack(track, cameraStream));
  }
}

function createPeerConnection(peerId, username, userInfo) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peers[peerId] = pc;
  // Guarda avatar/moldura de quem é esse peer — a tile usa isso pra mostrar a
  // FOTO de perfil de verdade (não só a inicial) quando a câmera tá desligada.
  remotePeerInfo[peerId] = userInfo || { username };

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('rtc:signal', { to: peerId, data: e.candidate });
  };

  pc.ontrack = (e) => {
    // Acumula as tracks (áudio do mic + vídeo da tela) numa única stream por
    // peer, pra tocar tudo junto num único elemento <video> (que também toca áudio).
    let stream = remoteStreams[peerId];
    if (!stream) {
      stream = new MediaStream();
      remoteStreams[peerId] = stream;
    }
    if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track);
    addVideoTile(peerId, username, stream, remotePeerInfo[peerId]);
  };

  pc.onnegotiationneeded = async () => {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('rtc:signal', { to: peerId, data: pc.localDescription });
    } catch (err) {
      console.error('Erro de negociação WebRTC:', err);
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === 'connected') {
      // Reconectou — cancela qualquer tentativa pendente e tira o aviso da tile.
      clearReconnectAttempt(peerId);
      const tile = document.getElementById('tile-' + peerId);
      if (tile) tile.classList.remove('tile-reconnecting');
      return;
    }
    if (state === 'closed') {
      // pc.close() já foi chamado de propósito (saiu da sala, peer saiu) —
      // não tenta reconectar, só limpa.
      clearReconnectAttempt(peerId);
      delete remoteStreams[peerId];
      removeVideoTile(peerId);
      return;
    }
    if (state === 'disconnected' || state === 'failed') {
      // Queda de conexão real (rede caiu, wifi oscilou etc) — tenta
      // reconectar sozinho antes de desistir e tirar a pessoa da call
      // (item 7 do plano: "Reconexão e tratamento de falhas").
      scheduleReconnectAttempt(peerId, pc, username);
    }
  };

  startConnectionQualityMonitor(peerId, pc);

  return pc;
}

// ---------- RECONEXÃO AUTOMÁTICA DE VOZ ----------
// failed/disconnected nem sempre é queda definitiva — WebRTC costuma dar um
// "disconnected" passageiro em qualquer soluço de rede. Em vez de tirar a
// pessoa da call na hora, tenta ICE restart algumas vezes com espera
// crescente, e só remove a tile de verdade se todas as tentativas falharem.
const reconnectTimers = {};
const reconnectAttempts = {};
const MAX_RECONNECT_ATTEMPTS = 4;

function clearReconnectAttempt(peerId) {
  if (reconnectTimers[peerId]) {
    clearTimeout(reconnectTimers[peerId]);
    delete reconnectTimers[peerId];
  }
  delete reconnectAttempts[peerId];
}

function scheduleReconnectAttempt(peerId, pc, username) {
  // Já tem uma tentativa agendada pra esse peer — não empilha outra.
  if (reconnectTimers[peerId]) return;

  const tile = document.getElementById('tile-' + peerId);
  if (tile) tile.classList.add('tile-reconnecting');

  const attempt = (reconnectAttempts[peerId] || 0) + 1;
  reconnectAttempts[peerId] = attempt;

  if (attempt > MAX_RECONNECT_ATTEMPTS) {
    logVoiceActivity(`${username || 'Alguém'} caiu da chamada`);
    clearReconnectAttempt(peerId);
    delete remoteStreams[peerId];
    if (peers[peerId]) {
      try {
        peers[peerId].close();
      } catch (_) {}
      delete peers[peerId];
    }
    removeVideoTile(peerId);
    return;
  }

  const delay = Math.min(1500 * attempt, 6000); // 1.5s, 3s, 4.5s, 6s
  reconnectTimers[peerId] = setTimeout(async () => {
    delete reconnectTimers[peerId];
    // Peer já sumiu (saiu de verdade nesse meio tempo) — nada a fazer.
    if (!peers[peerId] || peers[peerId] !== pc) return;
    if (pc.connectionState === 'connected') {
      clearReconnectAttempt(peerId);
      return;
    }
    try {
      if (typeof pc.restartIce === 'function') {
        pc.restartIce();
      } else {
        // Navegadores mais antigos: renegocia com iceRestart explícito.
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        socket.emit('rtc:signal', { to: peerId, data: pc.localDescription });
      }
    } catch (err) {
      console.error('Falha ao tentar reconectar com', username, err);
    }
    // Se depois dessa tentativa ainda não conectou, agenda a próxima.
    setTimeout(() => {
      if (peers[peerId] === pc && pc.connectionState !== 'connected' && pc.connectionState !== 'closed') {
        scheduleReconnectAttempt(peerId, pc, username);
      }
    }, 2500);
  }, delay);
}

// Checa a qualidade da conexão (perda de pacotes) a cada poucos segundos e
// acende um indicador verde/amarelo/vermelho na tile da pessoa, igual Discord.
const qualityIntervals = {};
const qualityLastStats = {};

function startConnectionQualityMonitor(peerId, pc) {
  stopConnectionQualityMonitor(peerId);
  qualityIntervals[peerId] = setInterval(async () => {
    try {
      const stats = await pc.getStats();
      let packetsLost = 0;
      let packetsReceived = 0;
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && !report.isRemote) {
          packetsLost += report.packetsLost || 0;
          packetsReceived += report.packetsReceived || 0;
        }
      });
      const last = qualityLastStats[peerId] || { packetsLost: 0, packetsReceived: 0 };
      const deltaLost = Math.max(0, packetsLost - last.packetsLost);
      const deltaReceived = Math.max(0, packetsReceived - last.packetsReceived);
      qualityLastStats[peerId] = { packetsLost, packetsReceived };

      const total = deltaLost + deltaReceived;
      const lossRatio = total > 0 ? deltaLost / total : 0;

      const dot = document.querySelector(`#tile-${peerId} .quality-dot`);
      if (dot) {
        dot.classList.remove('quality-good', 'quality-medium', 'quality-poor');
        if (lossRatio > 0.08) dot.classList.add('quality-poor');
        else if (lossRatio > 0.02) dot.classList.add('quality-medium');
        else dot.classList.add('quality-good');
      }
    } catch (_) {
      // getStats pode falhar logo depois que a conexão fecha — ignora
    }
  }, 3000);
}

function stopConnectionQualityMonitor(peerId) {
  if (qualityIntervals[peerId]) {
    clearInterval(qualityIntervals[peerId]);
    delete qualityIntervals[peerId];
  }
  delete qualityLastStats[peerId];
}

const speakingDetectors = {}; // peerId -> { ctx, rafId }

function addVideoTile(peerId, username, stream, userInfo) {
  let tile = document.getElementById('tile-' + peerId);
  const isNew = !tile;
  const isRemote = peerId !== 'local' && peerId !== 'local-camera';
  if (isNew) {
    tile = document.createElement('div');
    tile.className = 'video-tile tile-enter';
    tile.id = 'tile-' + peerId;
    // Foto de perfil de verdade quando a câmera tá desligada (item 11 da
    // especificação) — em vez de só a inicial do nome num círculo genérico.
    const avatarUser = userInfo || { username };
    tile.innerHTML = `
      <video autoplay playsinline></video>
      <div class="tile-avatar ${avatarFrameClass(avatarUser)}">${renderAvatarHtml(avatarUser)}</div>
      <div class="tile-waveform"><span></span><span></span><span></span><span></span></div>
      ${isRemote ? '<span class="quality-dot quality-good" title="Qualidade da conexão"></span>' : ''}
      <span class="label">${escapeHtml(username || 'Participante')}</span>
      <div class="tile-controls">
        ${isRemote ? '<input type="range" class="tile-volume" min="0" max="100" value="100" title="Volume" />' : ''}
        <button type="button" class="tile-btn tile-size-btn" title="Mudar tamanho">⬜</button>
        <button type="button" class="tile-btn tile-expand-btn" title="Ampliar">⤢</button>
        <button type="button" class="tile-btn tile-fullscreen-btn" title="Tela cheia">⛶</button>
      </div>
    `;
    document.getElementById('video-grid').appendChild(tile);
    // remove a classe de animação depois que ela roda, pra não repetir em updates futuros
    setTimeout(() => tile.classList.remove('tile-enter'), 260);

    // Tamanho manual da tile: alterna Padrão → Grande → Pequeno → Padrão.
    // Útil principalmente pra sua própria câmera, que abre no tamanho
    // "padrão" e nem sempre é o ideal.
    const TILE_SIZES = [
      { cls: '', icon: '⬜', title: 'Tamanho: padrão (clique pra aumentar)' },
      { cls: 'tile-size-lg', icon: '⬛', title: 'Tamanho: grande (clique pra diminuir)' },
      { cls: 'tile-size-sm', icon: '▫️', title: 'Tamanho: pequeno (clique pra voltar ao padrão)' },
    ];
    let tileSizeIndex = 0;
    tile.querySelector('.tile-size-btn').onclick = (e) => {
      e.stopPropagation();
      TILE_SIZES.forEach((s) => s.cls && tile.classList.remove(s.cls));
      tileSizeIndex = (tileSizeIndex + 1) % TILE_SIZES.length;
      const next = TILE_SIZES[tileSizeIndex];
      if (next.cls) tile.classList.add(next.cls);
      const btn = tile.querySelector('.tile-size-btn');
      btn.textContent = next.icon;
      btn.title = next.title;
    };

    // "Ampliar" — a tile ocupa o espaço todo dentro da própria página (sem
    // depender de nenhuma API do navegador, então nunca falha/buga).
    tile.querySelector('.tile-expand-btn').onclick = (e) => {
      e.stopPropagation();
      toggleExpandedTile(tile);
    };
    tile.querySelector('video').ondblclick = () => toggleExpandedTile(tile);

    // "Tela cheia" de verdade — usa a Fullscreen API nativa do navegador
    // direto no elemento de vídeo (o jeito mais confiável, mesmo padrão do
    // YouTube/Twitch), então o navegador cuida do redimensionamento sozinho.
    tile.querySelector('.tile-fullscreen-btn').onclick = (e) => {
      e.stopPropagation();
      const videoEl = tile.querySelector('video');
      if (document.fullscreenElement === videoEl) {
        document.exitFullscreen().catch(() => {});
      } else if (videoEl.requestFullscreen) {
        videoEl.requestFullscreen().catch(() => {});
      }
    };

    // Volume individual dessa pessoa, multiplicado pelo volume geral da
    // chamada (slider da barra fixa) — os dois se combinam, igual Discord:
    // o geral sobe/desce tudo de uma vez, e o individual ainda ajusta só
    // aquela pessoa por cima disso.
    const volumeSlider = tile.querySelector('.tile-volume');
    if (volumeSlider) {
      volumeSlider.oninput = (e) => {
        e.stopPropagation();
        tile.querySelector('video').volume = masterCallVolume * (Number(volumeSlider.value) / 100);
      };
      volumeSlider.onclick = (e) => e.stopPropagation();
    }
  }

  const videoEl = tile.querySelector('video');
  videoEl.srcObject = stream;
  // A tile "local" é a sua própria câmera/mic — sempre muda pra você mesmo
  // (senão você ouviria seu próprio microfone de volta, causando eco/feedback).
  videoEl.muted = peerId === 'local' ? true : isDeafened;
  if (isRemote) {
    const existingSlider = tile.querySelector('.tile-volume');
    const pct = existingSlider ? Number(existingSlider.value) : 100;
    videoEl.volume = masterCallVolume * (pct / 100);
  }
  applyOutputDevice(videoEl);
  videoEl.play().catch(() => {
    // Alguns navegadores bloqueiam autoplay com áudio fora de um gesto direto
    // do usuário — nesse caso o próprio elemento mostra o ícone de play.
  });

  // Mostra o avatar (círculo com inicial) quando não há vídeo de verdade
  // rolando (só áudio, ex.: alguém que não está compartilhando tela) —
  // igual Discord mostra o avatar em vez de tela preta em chamada de voz.
  const hasVideo = stream.getVideoTracks().length > 0;
  tile.classList.toggle('audio-only', !hasVideo);
  tile.classList.toggle('has-video', hasVideo);

  attachSpeakingDetector(peerId, stream, tile);
}

// "Ampliar": faz a tile ocupar o espaço da grade inteira, escondendo as
// outras — clique de novo (ou no X) pra voltar à grade normal. 100% CSS,
// sem depender de permissão nenhuma do navegador.
function toggleExpandedTile(tile) {
  const grid = document.getElementById('video-grid');
  const alreadyExpanded = tile.classList.contains('tile-expanded');
  grid.querySelectorAll('.video-tile.tile-expanded').forEach((t) => t.classList.remove('tile-expanded'));
  grid.classList.remove('grid-has-expanded');
  if (!alreadyExpanded) {
    tile.classList.add('tile-expanded');
    grid.classList.add('grid-has-expanded');
  }
}

// Detecta quando alguém está falando (nível de áudio) e acende um anel verde
// ao redor do avatar/tile, igual indicador de "falando" do Discord.
function attachSpeakingDetector(peerId, stream, tile) {
  if (speakingDetectors[peerId]) {
    speakingDetectors[peerId].ctx.close().catch(() => {});
    cancelAnimationFrame(speakingDetectors[peerId].rafId);
    delete speakingDetectors[peerId];
  }
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) return;

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaStreamSource(new MediaStream([audioTracks[0]]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    function tick() {
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      const stillThere = document.getElementById('tile-' + peerId);
      if (stillThere) stillThere.classList.toggle('speaking', rms > 0.04);
      speakingDetectors[peerId].rafId = requestAnimationFrame(tick);
    }
    speakingDetectors[peerId] = { ctx, rafId: null };
    tick();
  } catch (_) {
    // ambiente sem suporte a AudioContext pra essa stream — sem indicador, sem problema
  }
}

function removeVideoTile(peerId) {
  if (speakingDetectors[peerId]) {
    speakingDetectors[peerId].ctx.close().catch(() => {});
    cancelAnimationFrame(speakingDetectors[peerId].rafId);
    delete speakingDetectors[peerId];
  }
  const tile = document.getElementById('tile-' + peerId);
  if (tile) tile.remove();
}

// ---------- PORTÃO DE RUÍDO (silêncio total quando você não está falando) ----------
// Diferente do "noiseSuppression" do navegador (que só reduz ruído contínuo
// tipo ventilador), isso corta o áudio completamente quando você não está
// falando — nada passa pros outros participantes: silêncio de verdade.
let noiseGateEnabled = localStorage.getItem('ng_noise_gate') !== 'off'; // ligado por padrão
let noiseGateSensitivity = Number(localStorage.getItem('ng_noise_gate_sensitivity') || 30); // 0-100
let gateAudioCtx = null;
let gateStream = null;
let gateAnalyser = null;
let gateGainNode = null;
let gateRafId = null;
let gateOpen = false;
let gateLoopFn = null; // guarda o loop atual, pra retomar quando a aba volta a ficar visível

function buildNoiseGate(rawStream) {
  teardownNoiseGate();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  gateAudioCtx = new AudioCtx();
  const source = gateAudioCtx.createMediaStreamSource(rawStream);
  gateAnalyser = gateAudioCtx.createAnalyser();
  gateAnalyser.fftSize = 512;
  gateGainNode = gateAudioCtx.createGain();
  gateGainNode.gain.value = 0; // começa fechado até detectar fala
  const destination = gateAudioCtx.createMediaStreamDestination();

  source.connect(gateAnalyser);
  gateAnalyser.connect(gateGainNode);
  gateGainNode.connect(destination);
  gateStream = destination.stream;
  gateOpen = false;

  const dataArray = new Uint8Array(gateAnalyser.frequencyBinCount);
  const releaseFrames = 25; // "segura" a abertura um pouco pra não cortar palavras no meio
  let silentFrames = 0;

  function loop() {
    if (!gateAnalyser || document.hidden) return; // desligado, ou aba minimizada/oculta
    gateAnalyser.getByteTimeDomainData(dataArray);
    let sumSquares = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = (dataArray[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / dataArray.length);
    // sensibilidade 0-100: quanto maior, menor o limiar (abre com voz mais baixa)
    const threshold = 0.045 - (noiseGateSensitivity / 100) * 0.035;
    const now = gateAudioCtx.currentTime;
    if (rms > threshold) {
      silentFrames = 0;
      if (!gateOpen) {
        gateOpen = true;
        gateGainNode.gain.cancelScheduledValues(now);
        gateGainNode.gain.linearRampToValueAtTime(1, now + 0.02);
      }
    } else {
      silentFrames++;
      if (gateOpen && silentFrames > releaseFrames) {
        gateOpen = false;
        gateGainNode.gain.cancelScheduledValues(now);
        gateGainNode.gain.linearRampToValueAtTime(0, now + 0.08);
      }
    }
    gateRafId = requestAnimationFrame(loop);
  }
  gateLoopFn = loop;
  loop();
}

function teardownNoiseGate() {
  if (gateRafId) cancelAnimationFrame(gateRafId);
  gateRafId = null;
  gateAnalyser = null;
  gateLoopFn = null;
  if (gateAudioCtx) {
    gateAudioCtx.close().catch(() => {});
    gateAudioCtx = null;
  }
  gateStream = null;
  gateOpen = false;
}

// A aba minimizada/oculta faz o navegador pausar o requestAnimationFrame (pra
// economizar bateria) — sem isso, quem minimiza o navegador podia ficar com
// o portão "travado" fechado pra sempre (silêncio permanente, mesmo falando).
// Solução: ao esconder a aba, abre o portão totalmente (áudio passa igual
// sem portão nenhum); ao voltar, retoma a checagem normal de volume.
document.addEventListener('visibilitychange', () => {
  if (!gateAudioCtx || !gateGainNode) return;
  if (document.hidden) {
    if (gateRafId) cancelAnimationFrame(gateRafId);
    gateRafId = null;
    gateOpen = true;
    gateGainNode.gain.cancelScheduledValues(gateAudioCtx.currentTime);
    gateGainNode.gain.setValueAtTime(1, gateAudioCtx.currentTime);
  } else if (gateLoopFn && !gateRafId) {
    gateLoopFn();
  }
});

// A stream que realmente deve ser mandada pros outros participantes da call
// (com o portão de ruído aplicado, se estiver ligado).
function getOutgoingMicStream() {
  if (noiseGateEnabled && gateStream) return gateStream;
  return micStream;
}

// Troca a track de áudio já sendo enviada pra cada peer (sem precisar
// renegociar a conexão) — usado quando liga/desliga o portão de ruído no meio de uma call.
function applyOutgoingMicTrackToPeers() {
  const outgoing = getOutgoingMicStream();
  if (!outgoing) return;
  const newTrack = outgoing.getAudioTracks()[0];
  if (!newTrack) return;
  Object.values(peers).forEach((pc) => {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
    if (sender) sender.replaceTrack(newTrack).catch(() => {});
  });
  updateLocalTile();
}

// ---------- MICROFONE (voz de verdade, igual chamada de voz) ----------

async function startMicrophone() {
  // Segunda camada de proteção contra o bug do "retorno": se por algum
  // motivo já existe um microfone ativo (chamada duplicada, etc), para ele
  // antes de pegar um novo — nunca deixa dois streams de mic vivos ao mesmo
  // tempo mandando áudio duplicado pros peers.
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
    teardownNoiseGate();
  }
  showConnectingTile();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
  } catch (err) {
    removeConnectingTile();
    setMicStatus('Não foi possível acessar o microfone: ' + err.message);
    return;
  }
  if (noiseGateEnabled) buildNoiseGate(micStream);
  updateMicEnabledState();
  const outgoing = getOutgoingMicStream();
  Object.values(peers).forEach((pc) => {
    outgoing.getTracks().forEach((track) => pc.addTrack(track, outgoing));
  });
  updateMicButton();
  setMicStatus(micMuted ? '🎙️ Microfone mutado' : '🎙️ Microfone ativo');
  removeConnectingTile();
  updateLocalTile();
}

function stopMicrophone() {
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  teardownNoiseGate();
  setMicStatus('');
}

// Sua própria tile na chamada — combina áudio do mic + vídeo da tela (se
// estiver compartilhando) num único quadradinho com seu nome, igual todo mundo.
function updateLocalTile() {
  if (!connectedVoiceRoomId) {
    removeVideoTile('local');
    removeVideoTile('local-camera');
    return;
  }
  const combined = new MediaStream();
  if (micStream) getOutgoingMicStream().getAudioTracks().forEach((t) => combined.addTrack(t));
  if (localStream) localStream.getVideoTracks().forEach((t) => combined.addTrack(t));
  addVideoTile('local', me.username + ' (você)', combined, me);

  if (cameraStream) {
    addVideoTile('local-camera', me.username + ' (câmera)', cameraStream, me);
  } else {
    removeVideoTile('local-camera');
  }
}

// ---------- CÂMERA (webcam, separada da tela compartilhada) ----------

async function toggleCamera() {
  if (cameraStream) {
    const tracksToRemove = cameraStream.getTracks();
    Object.values(peers).forEach((pc) => {
      pc.getSenders()
        .filter((s) => s.track && tracksToRemove.includes(s.track))
        .forEach((s) => pc.removeTrack(s));
    });
    tracksToRemove.forEach((t) => t.stop());
    cameraStream = null;
    updateLocalTile();
    updateCameraButton();
    updateCameraModerationBadge();
    stopFrameModerationIfIdle();
    SFX.cameraOff();
    return;
  }

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
  } catch (err) {
    alert('Não foi possível acessar a câmera: ' + err.message);
    return;
  }
  Object.values(peers).forEach((pc) => {
    cameraStream.getTracks().forEach((track) => pc.addTrack(track, cameraStream));
  });
  updateLocalTile();
  updateCameraButton();
  updateCameraModerationBadge();
  startFrameModeration();
  SFX.cameraOn();
  cameraStream.getVideoTracks()[0].onended = () => {
    if (cameraStream) toggleCamera();
  };
}

function updateCameraButton() {
  document.getElementById('btn-toggle-camera').classList.toggle('active-state', !!cameraStream);
}

document.getElementById('btn-toggle-camera').onclick = toggleCamera;
document.getElementById('btn-mic-options').onclick = () => {
  toggleDeafen();
  document.getElementById('btn-mic-options').textContent = isDeafened ? '🔇' : '🔊';
};

// Quadradinho temporário de "Conectando..." enquanto o navegador pede
// permissão de microfone — assim a tela não fica vazia/parada nesse meio tempo.
function showConnectingTile() {
  const grid = document.getElementById('video-grid');
  if (document.getElementById('tile-connecting')) return;
  const tile = document.createElement('div');
  tile.className = 'video-tile audio-only tile-enter';
  tile.id = 'tile-connecting';
  tile.innerHTML = `<div class="tile-avatar tile-avatar-pulse"><span>…</span></div><span class="label">Conectando</span>`;
  grid.appendChild(tile);
}
function removeConnectingTile() {
  const tile = document.getElementById('tile-connecting');
  if (tile) tile.remove();
}

function setMicStatus(text) {
  const el = document.getElementById('mic-status');
  if (el) el.textContent = text;
}

function updateMicButton() {
  const btn = document.getElementById('btn-toggle-mic');
  btn.textContent = micMuted ? '🔇' : '🎙️';
  btn.title = micMuted ? 'Ativar microfone' : 'Mutar microfone';
  btn.classList.toggle('muted', micMuted);
  document.getElementById('bar-btn-mute').classList.toggle('active-state', micMuted);
}

function toggleMic() {
  micMuted = !micMuted;
  updateMicEnabledState();
  updateMicButton();
  setMicStatus(micStatusText());
  if (micMuted) SFX.mute();
  else SFX.unmute();
}

document.getElementById('btn-toggle-mic').onclick = toggleMic;

// ---------- PUSH-TO-TALK ----------

let talkMode = localStorage.getItem('ng_talk_mode') || 'voice'; // 'voice' | 'ptt'
let pttKeyCode = localStorage.getItem('ng_ptt_key') || 'Space';
let pttHeld = false;

function updateMicEnabledState() {
  if (!micStream) return;
  let enabled;
  if (micMuted) enabled = false;
  else if (talkMode === 'ptt') enabled = pttHeld;
  else enabled = true;
  micStream.getAudioTracks().forEach((t) => (t.enabled = enabled));
}

function micStatusText() {
  if (micMuted) return '🎙️ Microfone mutado';
  if (talkMode === 'ptt') return `🎙️ Push-to-talk — segure "${keyLabel(pttKeyCode)}" pra falar`;
  return '🎙️ Microfone ativo';
}

function keyLabel(code) {
  if (code === 'Space') return 'Espaço';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

window.addEventListener('keydown', (e) => {
  if (talkMode !== 'ptt' || !connectedVoiceRoomId) return;
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
  if (e.code === pttKeyCode && !pttHeld) {
    pttHeld = true;
    updateMicEnabledState();
    setMicStatus('🎙️ Falando (push-to-talk)');
  }
});
window.addEventListener('keyup', (e) => {
  if (talkMode !== 'ptt') return;
  if (e.code === pttKeyCode) {
    pttHeld = false;
    updateMicEnabledState();
    setMicStatus(micStatusText());
  }
});

document.getElementById('talk-mode-select').onchange = (e) => {
  talkMode = e.target.value;
  localStorage.setItem('ng_talk_mode', talkMode);
  document.getElementById('ptt-key-row').classList.toggle('hidden', talkMode !== 'ptt');
  pttHeld = false;
  updateMicEnabledState();
  setMicStatus(micStatusText());
};

document.getElementById('btn-ptt-key').onclick = (e) => {
  const btn = e.target;
  btn.textContent = 'Pressione uma tecla...';
  const capture = (ev) => {
    ev.preventDefault();
    pttKeyCode = ev.code;
    localStorage.setItem('ng_ptt_key', pttKeyCode);
    btn.textContent = keyLabel(pttKeyCode);
    window.removeEventListener('keydown', capture, true);
  };
  window.addEventListener('keydown', capture, true);
};

function toggleDeafen() {
  isDeafened = !isDeafened;
  // Ensurdecer também muta o microfone, igual Discord (não dá pra falar sem ouvir).
  if (isDeafened && !micMuted) toggleMic();
  document.querySelectorAll('#video-grid video').forEach((v) => (v.muted = isDeafened));
  document.getElementById('bar-btn-deafen').classList.toggle('active-state', isDeafened);
}

// ---------- BARRA FIXA "CONECTADO POR VOZ" ----------

function updateVoiceBar() {
  const bar = document.getElementById('voice-connected-bar');
  if (!connectedVoiceRoomId) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const channel = allChannels.find((c) => c.id === connectedVoiceRoomId);
  document.getElementById('voice-connected-room-name').textContent = channel ? channel.name : 'sala de voz';
}

document.getElementById('voice-connected-info').onclick = () => {
  if (!connectedVoiceRoomId) return;
  const channel = allChannels.find((c) => c.id === connectedVoiceRoomId);
  if (channel) selectChannel(channel);
};
document.getElementById('bar-btn-mute').onclick = toggleMic;
document.getElementById('bar-btn-deafen').onclick = toggleDeafen;

// ---------- VOLUME GERAL DA CHAMADA (aumentar/diminuir/mutar tudo de uma vez) ----------
function applyMasterVolumeToAllTiles() {
  document.querySelectorAll('#video-grid .video-tile').forEach((tile) => {
    if (tile.id === 'tile-local' || tile.id === 'tile-local-camera') return;
    const video = tile.querySelector('video');
    if (!video) return;
    const slider = tile.querySelector('.tile-volume');
    const pct = slider ? Number(slider.value) : 100;
    video.volume = masterCallVolume * (pct / 100);
  });
}

const barVolumeSlider = document.getElementById('bar-volume-slider');
const barVolumeIconBtn = document.getElementById('bar-btn-volume-icon');
let volumeBeforeMute = masterCallVolume * 100;

function updateVolumeIcon() {
  if (!barVolumeIconBtn) return;
  const wrap = barVolumeIconBtn.querySelector('.ng-icon-wrap');
  if (!wrap) return;
  const iconName = masterCallVolume <= 0 ? 'volume-x' : 'volume-2';
  wrap.setAttribute('data-icon', iconName);
  wrap.innerHTML = icon(iconName, wrap.getAttribute('data-icon-class') || '');
}

if (barVolumeSlider) {
  barVolumeSlider.value = Math.round(masterCallVolume * 100);
  barVolumeSlider.oninput = () => {
    masterCallVolume = Number(barVolumeSlider.value) / 100;
    localStorage.setItem('ng_master_volume', String(barVolumeSlider.value));
    applyMasterVolumeToAllTiles();
    updateVolumeIcon();
  };
}
if (barVolumeIconBtn) {
  // Clicar no ícone muta/desmuta rápido, sem perder o nível que você tinha ajustado.
  barVolumeIconBtn.onclick = () => {
    if (masterCallVolume > 0) {
      volumeBeforeMute = masterCallVolume * 100;
      masterCallVolume = 0;
    } else {
      masterCallVolume = (volumeBeforeMute || 100) / 100;
    }
    if (barVolumeSlider) barVolumeSlider.value = Math.round(masterCallVolume * 100);
    localStorage.setItem('ng_master_volume', String(Math.round(masterCallVolume * 100)));
    applyMasterVolumeToAllTiles();
    updateVolumeIcon();
  };
}
updateVolumeIcon();
document.getElementById('bar-btn-disconnect').onclick = () => {
  disconnectVoice();
  if (currentChannel && currentChannel.type === 'voz') {
    document.getElementById('voice-panel').classList.add('hidden');
    currentChannel = null;
    document.getElementById('current-channel-name').textContent = 'Selecione um canal';
    renderCategories(allChannels);
  }
};

// ---------- COMPARTILHAMENTO DE TELA ----------

// 720p30 como padrão: como a chamada é ponto-a-ponto (cada pessoa manda uma
// cópia da tela pra cada participante, sem servidor de mídia central), 1080p
// pesa demais em salas com mais gente e é a causa mais comum de lag/travada.
// Quem já tinha escolhido outra qualidade antes continua com a preferência salva.
let screenShareQuality = localStorage.getItem('ng_screen_quality') || '720p30';

const SCREEN_QUALITY_PRESETS = {
  '720p30': { width: 1280, height: 720, frameRate: 30 },
  '1080p30': { width: 1920, height: 1080, frameRate: 30 },
  '1080p60': { width: 1920, height: 1080, frameRate: 60 },
  '1440p60': { width: 2560, height: 1440, frameRate: 60 },
  '2160p60': { width: 3840, height: 2160, frameRate: 60 },
};

// NEXTGAME PLUS: qualquer coisa acima de 720p/30 é exclusiva do Plus (regra
// do plano de atualização). Se a conta era Plus e perdeu o plano (ou nunca
// foi), a preferência salva não pode continuar valendo escondida.
function isPlusUser() {
  return !!(me && me.plan === 'plus');
}

document.getElementById('screen-quality-select').onchange = (e) => {
  const option = e.target.selectedOptions[0];
  if (option.dataset.plus && !isPlusUser()) {
    e.target.value = screenShareQuality; // desfaz a seleção
    document.getElementById('screen-quality-upsell').classList.remove('hidden');
    return;
  }
  document.getElementById('screen-quality-upsell').classList.add('hidden');
  screenShareQuality = e.target.value;
  localStorage.setItem('ng_screen_quality', screenShareQuality);
};

document.getElementById('link-open-plus-from-quality').onclick = (e) => {
  e.preventDefault();
  openPlusUpgradeModal();
};

// Chamado no carregamento (startApp) — garante que ninguém sem Plus fica
// preso numa qualidade alta que só conseguiu escolher enquanto era Plus.
function enforceScreenQualityForPlan() {
  if (!isPlusUser() && SCREEN_QUALITY_PRESETS[screenShareQuality] && screenShareQuality !== '720p30') {
    screenShareQuality = '720p30';
    localStorage.setItem('ng_screen_quality', screenShareQuality);
  }
  const select = document.getElementById('screen-quality-select');
  if (select) select.value = screenShareQuality;
}

// ---------- MODAL "O que você quer compartilhar?" ----------
// Tela própria do NEXT GAME (estilo Discord) que aparece ANTES do seletor
// nativo do navegador. O navegador é quem de fato lista telas/janelas/abas —
// nenhum site consegue substituir esse picker por segurança — mas aqui a
// gente confirma a qualidade e lembra da opção de áudio antes de abrir ele.
function populateSharePickerQuality() {
  const select = document.getElementById('share-picker-quality-select');
  select.value = screenShareQuality;
}

document.getElementById('btn-share-screen').onclick = () => {
  populateSharePickerQuality();
  document.getElementById('share-picker-status').classList.add('hidden');
  document.getElementById('modal-share-picker').classList.remove('hidden');
};

document.getElementById('share-picker-quality-select').onchange = (e) => {
  const option = e.target.selectedOptions[0];
  if (option.dataset.plus && !isPlusUser()) {
    e.target.value = screenShareQuality;
    document.getElementById('share-picker-quality-upsell').classList.remove('hidden');
    return;
  }
  document.getElementById('share-picker-quality-upsell').classList.add('hidden');
  screenShareQuality = e.target.value;
  localStorage.setItem('ng_screen_quality', screenShareQuality);
  // mantém a outra seleção (dentro de Configurações de voz) em sincronia
  const otherSelect = document.getElementById('screen-quality-select');
  if (otherSelect) otherSelect.value = screenShareQuality;
};

document.getElementById('link-open-plus-from-share-picker').onclick = (e) => {
  e.preventDefault();
  document.getElementById('modal-share-picker').classList.add('hidden');
  openPlusUpgradeModal();
};

document.getElementById('btn-cancel-share-picker').onclick = () => {
  document.getElementById('modal-share-picker').classList.add('hidden');
};

document.getElementById('btn-confirm-share-picker').onclick = async () => {
  const statusEl = document.getElementById('share-picker-status');
  statusEl.classList.remove('hidden');
  statusEl.textContent = 'Abrindo o seletor do navegador...';

  // Defensivo: se por algum motivo ainda tinha uma tela antiga presa (ex.:
  // clique duplo, erro anterior), limpa direito antes de começar outra —
  // evita acumular sender fantasma na conexão (era a causa da tela preta
  // e do lag depois de parar/recomeçar o compartilhamento).
  if (localStream) stopScreenShare();

  try {
    const preset = SCREEN_QUALITY_PRESETS[screenShareQuality] || SCREEN_QUALITY_PRESETS['1080p30'];
    // audio: true pede pro navegador oferecer a opção de compartilhar o som
    // do conteúdo também (aparece um checkbox "Compartilhar áudio" na janela
    // de seleção de tela/aba do Chrome/Edge). Se a pessoa não marcar, ou o
    // navegador não suportar, a stream simplesmente vem sem faixa de áudio —
    // sem travar nada.
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: preset.frameRate },
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: false,
      },
    });
  } catch (err) {
    document.getElementById('modal-share-picker').classList.add('hidden');
    alert('Não foi possível iniciar o compartilhamento de tela: ' + err.message);
    return;
  }
  document.getElementById('modal-share-picker').classList.add('hidden');
  updateLocalTile();
  Object.values(peers).forEach((pc) => {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  });
  document.getElementById('btn-share-screen').classList.add('hidden');
  document.getElementById('btn-stop-share').classList.remove('hidden');
  SFX.screenShareStart();
  startFrameModeration();

  const hasSharedAudio = localStream.getAudioTracks().length > 0;
  setMicStatus(
    hasSharedAudio
      ? '🖥️ Compartilhando tela com áudio'
      : '🖥️ Compartilhando tela (sem áudio — a origem não permitiu ou você não marcou a opção)'
  );

  localStream.getVideoTracks()[0].onended = stopScreenShare;
};

document.getElementById('btn-stop-share').onclick = stopScreenShare;

function stopScreenShare() {
  if (localStream) {
    // BUG CRÍTICO CORRIGIDO: antes só parava as tracks (t.stop()) sem tirar
    // o sender da conexão. Uma track parada continua "presa" no
    // RTCPeerConnection como remetente morto — quem está assistindo fica
    // com tela preta/congelada em vez do vídeo sumir, e cada vez que a
    // pessoa compartilha de novo (sem sair da call) um sender morto novo se
    // acumula em cima do(s) anterior(es), pesando a negociação e causando
    // lag. A correção é sempre remover o sender de cada peer ANTES de parar
    // a track — mesmo padrão já usado ao desligar a câmera.
    const tracksToRemove = localStream.getTracks();
    Object.values(peers).forEach((pc) => {
      pc.getSenders()
        .filter((s) => s.track && tracksToRemove.includes(s.track))
        .forEach((s) => {
          try {
            pc.removeTrack(s);
          } catch (_) {}
        });
    });
    tracksToRemove.forEach((t) => t.stop());
    localStream = null;
  }
  document.getElementById('btn-share-screen').classList.remove('hidden');
  document.getElementById('btn-stop-share').classList.add('hidden');
  updateLocalTile();
  SFX.screenShareStop();
  stopFrameModerationIfIdle();
}

// ---------- MODERAÇÃO DE TELA COMPARTILHADA E CÂMERA (camada extra de segurança) ----------
// Enquanto alguém está compartilhando a tela OU com a câmera ligada numa
// chamada, manda um print periódico pro servidor analisar (armas, violência
// real, maus-tratos a animais, crime em andamento, conteúdo sexual
// explícito). Não é substituto de moderação humana nem de detecção
// especializada de CSAM — é só mais uma camada, com limitações reais.
// A pessoa é avisada disso com um aviso visível (ver updateCameraModerationBadge).
let frameModerationInterval = null;

function startFrameModeration() {
  stopFrameModeration();
  frameModerationInterval = setInterval(captureAndModerateFrame, 15000);
}

// Só para de verdade se NENHUMA fonte de vídeo local (tela OU câmera)
// ainda estiver ativa — senão desligar a câmera pararia também a checagem
// da tela compartilhada (e vice-versa).
function stopFrameModerationIfIdle() {
  if (!localStream && !cameraStream) stopFrameModeration();
}

function stopFrameModeration() {
  if (frameModerationInterval) clearInterval(frameModerationInterval);
  frameModerationInterval = null;
}

async function captureAndModerateFrame() {
  // Modera QUALQUER vídeo local ativo no momento: tela compartilhada
  // (#tile-local) e/ou câmera (#tile-local-camera) — as duas rodam
  // independentes, então podem coexistir.
  const videoEls = [
    document.querySelector('#tile-local video'),
    document.querySelector('#tile-local-camera video'),
  ].filter((el) => el && el.videoWidth);
  for (const videoEl of videoEls) {
    try {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 640 / videoEl.videoWidth);
      canvas.width = Math.round(videoEl.videoWidth * scale);
      canvas.height = Math.round(videoEl.videoHeight * scale);
      canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      const image = canvas.toDataURL('image/jpeg', 0.6);
      await fetch('/api/moderate-frame', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ image, channelId: connectedVoiceRoomId }),
      });
    } catch (_) {
      // falha silenciosa — não deve atrapalhar quem está na chamada
    }
  }
}

// Aviso visível de que a câmera está sob a mesma checagem de segurança da
// tela compartilhada — transparência: a pessoa precisa saber que isso roda.
function updateCameraModerationBadge() {
  const el = document.getElementById('camera-moderation-badge');
  if (!el) return;
  el.classList.toggle('hidden', !cameraStream);
}

document.getElementById('btn-leave-voice').onclick = () => {
  disconnectVoice();
  document.getElementById('voice-panel').classList.add('hidden');
  currentChannel = null;
  document.getElementById('current-channel-name').textContent = 'Selecione um canal';
  renderCategories(allChannels);
};

// ---------- CONFIGURAÇÕES DE VOZ (dispositivos + teste de microfone) ----------

const modalVoiceSettings = document.getElementById('modal-voice-settings');
let micTestStream = null;
let micTestAudioCtx = null;
let micTestRafId = null;

document.getElementById('btn-voice-settings').onclick = async () => {
  modalVoiceSettings.classList.remove('hidden');
  await populateAudioDevices();
};
document.getElementById('btn-close-voice-settings').onclick = () => {
  stopMicTest();
  modalVoiceSettings.classList.add('hidden');
};

async function populateAudioDevices() {
  document.getElementById('noise-suppression-toggle').checked = noiseSuppressionEnabled;
  document.getElementById('noise-gate-toggle').checked = noiseGateEnabled;
  document.getElementById('noise-gate-sensitivity').value = noiseGateSensitivity;
  document.getElementById('noise-gate-sensitivity-row').classList.toggle('hidden', !noiseGateEnabled);
  document.getElementById('talk-mode-select').value = talkMode;
  document.getElementById('ptt-key-row').classList.toggle('hidden', talkMode !== 'ptt');
  document.getElementById('btn-ptt-key').textContent = keyLabel(pttKeyCode);
  document.getElementById('screen-quality-select').value = screenShareQuality;

  // Precisa de uma permissão de mic concedida pelo menos uma vez pro navegador
  // revelar os nomes dos dispositivos (senão vem tudo em branco).
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (_) {
    // usuário pode ter negado — segue mesmo assim, só sem os nomes
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputSelect = document.getElementById('input-device-select');
  const outputSelect = document.getElementById('output-device-select');

  inputSelect.innerHTML = '';
  devices
    .filter((d) => d.kind === 'audioinput')
    .forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microfone ${i + 1}`;
      inputSelect.appendChild(opt);
    });
  if (preferredInputId) inputSelect.value = preferredInputId;

  outputSelect.innerHTML = '';
  const outputHint = document.getElementById('output-unsupported-hint');
  if (supportsOutputSelection) {
    outputHint.classList.add('hidden');
    devices
      .filter((d) => d.kind === 'audiooutput')
      .forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Saída de áudio ${i + 1}`;
        outputSelect.appendChild(opt);
      });
    if (preferredOutputId) outputSelect.value = preferredOutputId;
    outputSelect.disabled = false;
  } else {
    outputHint.classList.remove('hidden');
    outputSelect.disabled = true;
  }

  inputSelect.onchange = () => {
    preferredInputId = inputSelect.value;
    localStorage.setItem('ng_input_device', preferredInputId);
  };
  outputSelect.onchange = () => {
    preferredOutputId = outputSelect.value;
    localStorage.setItem('ng_output_device', preferredOutputId);
    document.querySelectorAll('#video-grid video').forEach(applyOutputDevice);
  };

  document.getElementById('noise-suppression-toggle').onchange = (e) => {
    noiseSuppressionEnabled = e.target.checked;
    localStorage.setItem('ng_noise_suppression', noiseSuppressionEnabled ? 'on' : 'off');
    // Aplica na hora, sem precisar sair e voltar da call.
    if (micStream) {
      micStream.getAudioTracks().forEach((t) => {
        t.applyConstraints({ noiseSuppression: noiseSuppressionEnabled }).catch(() => {});
      });
    }
  };

  document.getElementById('noise-gate-toggle').onchange = (e) => {
    noiseGateEnabled = e.target.checked;
    localStorage.setItem('ng_noise_gate', noiseGateEnabled ? 'on' : 'off');
    document.getElementById('noise-gate-sensitivity-row').classList.toggle('hidden', !noiseGateEnabled);
    if (micStream) {
      if (noiseGateEnabled) buildNoiseGate(micStream);
      else teardownNoiseGate();
      applyOutgoingMicTrackToPeers();
    }
  };

  document.getElementById('noise-gate-sensitivity').oninput = (e) => {
    noiseGateSensitivity = Number(e.target.value);
    localStorage.setItem('ng_noise_gate_sensitivity', noiseGateSensitivity);
  };
}

function applyOutputDevice(videoEl) {
  if (supportsOutputSelection && preferredOutputId && videoEl.setSinkId) {
    videoEl.setSinkId(preferredOutputId).catch(() => {});
  }
}

document.getElementById('btn-test-mic').onclick = async () => {
  const btn = document.getElementById('btn-test-mic');
  if (micTestStream) {
    stopMicTest();
    return;
  }
  try {
    micTestStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
  } catch (err) {
    document.getElementById('mic-test-hint').textContent = 'Erro ao acessar o microfone: ' + err.message;
    return;
  }
  btn.textContent = '⏹️ Parar teste';
  btn.classList.add('active');
  document.getElementById('mic-test-hint').textContent = 'Fale perto do microfone — a barra abaixo deve se mover.';

  micTestAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = micTestAudioCtx.createMediaStreamSource(micTestStream);
  const analyser = micTestAudioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  const meterBar = document.getElementById('mic-meter-bar');
  function tick() {
    analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / data.length);
    const level = Math.min(100, Math.round(rms * 300));
    meterBar.style.width = level + '%';
    micTestRafId = requestAnimationFrame(tick);
  }
  tick();
};

function stopMicTest() {
  if (micTestRafId) cancelAnimationFrame(micTestRafId);
  micTestRafId = null;
  if (micTestAudioCtx) {
    micTestAudioCtx.close().catch(() => {});
    micTestAudioCtx = null;
  }
  if (micTestStream) {
    micTestStream.getTracks().forEach((t) => t.stop());
    micTestStream = null;
  }
  const btn = document.getElementById('btn-test-mic');
  btn.textContent = '🎤 Testar microfone';
  btn.classList.remove('active');
  document.getElementById('mic-meter-bar').style.width = '0%';
}

document.getElementById('btn-test-output').onclick = async () => {
  // Gera um bipe curto e toca na saída de áudio escolhida, pra testar
  // caixinha/fone sem depender de arquivo de áudio externo.
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const oscillator = ctx.createOscillator();
  const dest = ctx.createMediaStreamDestination();
  oscillator.frequency.value = 440;
  oscillator.connect(dest);

  const audioEl = new Audio();
  audioEl.srcObject = dest.stream;
  if (supportsOutputSelection && preferredOutputId) {
    try {
      await audioEl.setSinkId(preferredOutputId);
    } catch (_) {}
  }
  audioEl.play();
  oscillator.start();
  setTimeout(() => {
    oscillator.stop();
    ctx.close();
  }, 600);
};

// ---------- FUNDO ANIMADO DA TELA DE LOGIN ----------
//
// Se algum vídeo existir em /videos/bg-1.mp4 (ou .webm), ele toca em loop
// atrás do login automaticamente. Sem nenhum vídeo, cai numa animação de
// partículas/ícones de jogo flutuando — nunca fica vazio.
(function initAuthBackground() {
  const video = document.getElementById('auth-bg-video');
  const candidates = ['/videos/bg-1.mp4', '/videos/bg-1.webm'];
  let found = false;

  function tryNext(i) {
    if (i >= candidates.length) return;
    video.src = candidates[i];
    video.oncanplay = () => {
      found = true;
      video.classList.remove('hidden');
      video.play().catch(() => {});
    };
    video.onerror = () => tryNext(i + 1);
  }
  tryNext(0);

  // Partículas (rodam sempre, ficam por baixo do vídeo se ele existir)
  const canvas = document.getElementById('auth-bg-canvas');
  const ctx = canvas.getContext('2d');
  const ICONS = ['🎮', '🕹️', '👾', '⚡', '🔥', '🚀', '🏆', '🎯', '🐉', '💥'];
  let particles = [];

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  function makeParticle() {
    return {
      icon: ICONS[Math.floor(Math.random() * ICONS.length)],
      x: Math.random() * canvas.width,
      y: canvas.height + 40 + Math.random() * 200,
      size: 18 + Math.random() * 26,
      speed: 0.3 + Math.random() * 0.9,
      drift: (Math.random() - 0.5) * 0.6,
      opacity: 0.12 + Math.random() * 0.22,
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 0.6,
    };
  }
  const PARTICLE_COUNT = 26;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const p = makeParticle();
    p.y = Math.random() * canvas.height; // espalha logo de cara, não só nasce embaixo
    particles.push(p);
  }

  let rafId;
  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach((p) => {
      p.y -= p.speed;
      p.x += p.drift;
      p.rotation += p.rotationSpeed;
      if (p.y < -60) Object.assign(p, makeParticle(), { y: canvas.height + 40 });

      ctx.save();
      ctx.globalAlpha = p.opacity;
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);
      ctx.font = p.size + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.icon, 0, 0);
      ctx.restore();
    });
    rafId = requestAnimationFrame(tick);
  }
  tick();

  // Economiza recursos: pausa a animação quando a tela de login não está mais visível.
  const observer = new MutationObserver(() => {
    const visible = !document.getElementById('auth-screen').classList.contains('hidden');
    if (!visible && rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
      video.pause();
    } else if (visible && !rafId) {
      tick();
      if (found) video.play().catch(() => {});
    }
  });
  observer.observe(document.getElementById('auth-screen'), { attributes: true, attributeFilter: ['class'] });
})();

// ---------- MÚSICA DE FUNDO DO LOGIN ----------
// Se existir /assets/music/login-theme.mp3, toca em loop atrás do login.
// Navegador bloqueia áudio automático COM SOM, então começa sempre mudo
// (autoplay mudo é permitido) e só ativa o som quando a pessoa clica no
// botão — aí sim conta como interação do usuário e o navegador libera.
(function initAuthMusic() {
  const audio = document.getElementById('auth-bg-audio');
  const toggleBtn = document.getElementById('btn-auth-music-toggle');
  let found = false;
  let soundOn = false;

  audio.muted = true;
  audio.volume = 0.5;
  audio.src = '/assets/music/login-theme.mp3';
  audio.oncanplay = () => {
    if (found) return;
    found = true;
    toggleBtn.classList.remove('hidden');
    audio.play().catch(() => {});
  };
  audio.onerror = () => {
    // Sem arquivo de música — some o botão, não quebra nada.
    toggleBtn.classList.add('hidden');
  };

  toggleBtn.onclick = () => {
    soundOn = !soundOn;
    audio.muted = !soundOn;
    if (soundOn) audio.play().catch(() => {});
    toggleBtn.classList.toggle('active', soundOn);
    toggleBtn.title = soundOn ? 'Desativar música' : 'Ativar música';
  };

  const observer = new MutationObserver(() => {
    const visible = !document.getElementById('auth-screen').classList.contains('hidden');
    if (!visible) {
      audio.pause();
    } else if (found) {
      audio.play().catch(() => {});
    }
  });
  observer.observe(document.getElementById('auth-screen'), { attributes: true, attributeFilter: ['class'] });
})();

// ?support=1 na URL abre direto a tela "Fale com o suporte" — usado pelo
// site da Blue Games pra linkar direto pro suporte do NEXT GAME sem duplicar
// o formulário em outro lugar. Espera o tryResumeSession terminar primeiro,
// pra já saber se a pessoa está logada (decide mostrar os campos de
// nome/e-mail de convidado ou não).
tryResumeSession().then(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('support') === '1') {
    openSupportModal();
    // Limpa o parâmetro da URL sem recarregar a página, pra não reabrir o
    // modal de novo se a pessoa der F5.
    params.delete('support');
    const cleanUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
    window.history.replaceState({}, '', cleanUrl);
  }
});
