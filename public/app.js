// app.js - lógica do frontend (auth, canais, chat, WebRTC screen share)

let me = null;
let socket = null;
let currentChannel = null; // o que está sendo exibido no painel principal agora
let connectedVoiceRoomId = null; // sala de voz em que você está REALMENTE conectado (independe do que está vendo)
let localStream = null; // tela compartilhada
let micStream = null; // áudio do microfone
let micMuted = false;
let isDeafened = false;
const peers = {}; // socketId -> RTCPeerConnection
const remoteStreams = {}; // socketId -> MediaStream combinada (áudio + vídeo do peer)
let voiceParticipants = {}; // channelId -> [{socketId, userId, username}]
let cameraStream = null; // vídeo da webcam (separado da tela compartilhada)
let allUsers = []; // cache de /api/users pro painel de membros
let serverIcons = {}; // category -> emoji real escolhido por quem criou o servidor
let onlineUserIds = new Set();
let typingUsers = {}; // channelId -> { userId: username }
let typingTimeout = null;

const AVATAR_EMOJIS = ['🎮', '🕹️', '👾', '🔥', '⚡', '🐉', '🦊', '🐱', '💀', '👑', '🎯', '🚀'];
const SERVER_ICONS = ['🎮', '🕹️', '👾', '🔫', '⚔️', '🏆', '⚽', '🏎️', '🧙', '🐉', '💼', '💬', '🎧', '🚀'];

// Monta a fileira de ícones pra escolher o emoji de um novo servidor.
function buildRoomIconRow() {
  const row = document.getElementById('room-icon-row');
  const hiddenInput = document.getElementById('room-icon');
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

// Atalho pra quando o avatar vai direto num elemento já existente no DOM
// (em vez de dentro de um template de HTML string).
function renderAvatarInto(el, user) {
  el.innerHTML = renderAvatarHtml(user);
  el.className = el.className.replace(/\bavatar-frame-\S+/g, '').trim();
  const frameClass = avatarFrameClass(user);
  if (frameClass) el.classList.add(frameClass);
}

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

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
}

// ---------- LANDING PÚBLICA (antes do login) ----------

function scrollToAuthCard(which) {
  switchTab(which);
  document.getElementById('auth-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
document.getElementById('landing-nav-login').onclick = () => scrollToAuthCard('login');
document.getElementById('landing-cta-login').onclick = () => scrollToAuthCard('login');
document.getElementById('landing-nav-register').onclick = () => scrollToAuthCard('register');
document.getElementById('landing-cta-register').onclick = () => scrollToAuthCard('register');

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
  await authRequest('/api/login', { username, password });
};

formRegister.onsubmit = async (e) => {
  e.preventDefault();
  const username = document.getElementById('register-username').value.trim();
  const email = document.getElementById('register-email').value.trim();
  const password = document.getElementById('register-password').value;
  await authRequest('/api/register', { username, email, password });
};

async function authRequest(url, body) {
  authError.textContent = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      authError.textContent = data.error || 'Erro ao autenticar';
      return;
    }
    me = data;
    startApp();
  } catch (err) {
    authError.textContent = 'Erro de conexão com o servidor';
  }
}

document.getElementById('btn-logout').onclick = async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'include' });
  window.location.reload();
};

// ---------- BOOTSTRAP ----------

async function tryResumeSession() {
  try {
    const res = await fetch('/api/me', { credentials: 'include' });
    if (res.ok) {
      me = await res.json();
      startApp();
    }
  } catch (_) {}
}

function startApp() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('me-username').textContent = me.username;
  renderAvatarInto(document.getElementById('me-avatar'), me);
  if (me.is_admin) document.getElementById('admin-link').classList.remove('hidden');

  updateNavbarProfile();
  refreshStreakBadge();

  socket = io({ auth: { userId: me.id } });
  registerSocketHandlers();
  loadChannels().then(() => {
    // Link de convite (?channel=ID) — entra direto na sala em vez de cair na Início.
    const params = new URLSearchParams(window.location.search);
    const inviteChannelId = params.get('channel');
    const target = inviteChannelId && allChannels.find((c) => c.id === inviteChannelId);
    if (target) {
      selectChannel(target);
      history.replaceState({}, '', window.location.pathname);
    } else {
      loadHomeDashboard();
    }
  });
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

function renderMembers() {
  const container = document.getElementById('members-list');
  if (!container) return;
  container.innerHTML = '';

  const online = allUsers.filter((u) => onlineUserIds.has(u.id));
  const offline = allUsers.filter((u) => !onlineUserIds.has(u.id));

  const buildGroup = (title, users, isOffline) => {
    if (users.length === 0) return;
    const groupTitle = document.createElement('div');
    groupTitle.className = 'member-group-title';
    groupTitle.textContent = `${title} — ${users.length}`;
    container.appendChild(groupTitle);

    users.forEach((u) => {
      const row = document.createElement('div');
      row.className = 'member-row' + (isOffline ? ' offline' : '');
      row.innerHTML = `
        <div class="member-avatar-wrap">
          <div class="member-avatar ${avatarFrameClass(u)}">${renderAvatarHtml(u)}</div>
          <span class="member-status-dot"></span>
        </div>
        <div class="member-info">
          <div class="member-name">${escapeHtml(u.username)}${u.is_admin ? ' 👑' : ''}</div>
          ${u.status_message ? `<div class="member-game">🎮 ${escapeHtml(u.status_message)}</div>` : ''}
        </div>
      `;
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
};

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
  updateCategoryDatalist(allChannels);
}

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

// Trilho de servidores (coluna de ícones à esquerda, igual Discord) —
// cada categoria criada pelos usuários vira um "servidor" clicável aqui.
function renderServerRail(categories) {
  const list = document.getElementById('server-rail-list');
  list.innerHTML = '';
  categories.forEach((category) => {
    const btn = document.createElement('button');
    btn.className = 'server-icon';
    if (category === activeServerCategory) btn.classList.add('active');
    btn.title = category;
    btn.textContent = serverIcons[category] || serverInitials(category);
    btn.onclick = () => {
      activeServerCategory = category;
      renderServerRail(categories);
      renderCategories(allChannels);
    };
    list.appendChild(btn);
  });
}

function serverInitials(category) {
  const words = category.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] || '?').slice(0, 2).toUpperCase();
}

// Mostra só os canais do servidor (categoria) ativo no momento.
function renderCategories(channels) {
  const container = document.getElementById('categories-container');
  container.innerHTML = '';

  const nameEl = document.getElementById('active-server-name');
  nameEl.textContent = activeServerCategory
    ? categoryIcon(activeServerCategory) + ' ' + activeServerCategory
    : 'NEXT GAME';

  const channelsInServer = channels.filter((ch) => ch.category === activeServerCategory);

  const list = document.createElement('div');
  list.className = 'channel-list';
  channelsInServer.forEach((ch) => {
    const row = document.createElement('div');
    row.className = 'channel-item-row';

    const el = document.createElement('div');
    el.className = 'channel-item';
    if (currentChannel && currentChannel.id === ch.id) el.classList.add('active');
    if (ch.type === 'voz' && connectedVoiceRoomId === ch.id) el.classList.add('connected');
    el.textContent = (ch.type === 'voz' ? '🔊 ' : '# ') + ch.name;
    el.onclick = () => selectChannel(ch);
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
  document.getElementById('btn-edit-server-info').classList.toggle('hidden', !me.is_admin);

  const res = await fetch(`/api/servers/${encodeURIComponent(activeServerCategory)}`, { credentials: 'include' });
  const info = await res.json();
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

async function loadTournaments() {
  const list = document.getElementById('tournaments-list');
  list.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch(`/api/tournaments?category=${encodeURIComponent(activeServerCategory)}`, {
    credentials: 'include',
  });
  const tournaments = await res.json();
  list.innerHTML = '';

  if (tournaments.length === 0) {
    list.innerHTML = '<p class="empty-hint">Nenhum torneio criado ainda nesse servidor.</p>';
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
          <span>🎮 ${escapeHtml(t.game)}</span>
          <span>📅 ${dateText}</span>
          ${t.prize ? `<span>💰 ${escapeHtml(t.prize)}</span>` : ''}
          <span>👥 ${t.registered_count}/${t.max_slots}</span>
        </div>
      </div>
      <div class="tournament-actions">
        <button class="${t.is_registered ? 'btn-unregister' : 'btn-register'}">
          ${t.is_registered ? 'Sair' : 'Participar'}
        </button>
        ${me.is_admin ? '<button class="btn-delete-tournament">Excluir</button>' : ''}
      </div>
    `;
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
    list.appendChild(card);
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
document.getElementById('btn-ranking').onclick = async () => {
  modalRanking.classList.remove('hidden');
  const list = document.getElementById('ranking-list');
  list.innerHTML = '<p class="empty-hint">Carregando...</p>';
  const res = await fetch('/api/ranking', { credentials: 'include' });
  const ranking = await res.json();
  list.innerHTML = '';
  if (ranking.length === 0) {
    list.innerHTML = '<p class="empty-hint">Ainda sem atividade suficiente essa semana.</p>';
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
};
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
    const card = document.createElement('div');
    card.className = 'reward-card' + (r.unlocked ? '' : ' reward-card-locked') + (r.rare ? ' reward-card-rare' : '');

    const previewFrameClass = r.unlocked && r.frame ? 'avatar-frame-' + r.frame : '';
    const progress = r.type === 'streak' && !r.unlocked ? Math.min(data.streak, r.days) : null;

    let actionsHtml = '';
    if (r.unlocked) {
      const isEquipped = me.avatar_frame === r.frame;
      actionsHtml = `
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
      actionsHtml = `<div class="reward-locked-hint">🔒 ${
        r.type === 'streak' ? `${progress}/${r.days} dias de acesso seguido` : 'Ainda não desbloqueado'
      }</div>`;
    }

    card.innerHTML = `
      ${r.rare ? `<img src="/assets/logo.png" alt="" class="reward-rare-logo" />` : ''}
      <div class="reward-icon-wrap">
        <div class="reward-frame-preview member-avatar-lg ${previewFrameClass}">${renderAvatarHtml(me)}</div>
      </div>
      <div class="reward-info">
        <h3>${r.rare ? '⭐ ' : ''}${escapeHtml(r.name)}</h3>
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

function updateCategoryDatalist(channels) {
  const datalist = document.getElementById('category-options');
  const categories = [...new Set(channels.map((c) => c.category))];
  datalist.innerHTML = categories.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('');
}

// ---------- CRIAR SALA (modal) ----------

const modalNewRoom = document.getElementById('modal-new-room');

function openNewRoomModal(prefillCategory) {
  document.getElementById('room-error').textContent = '';
  document.getElementById('form-new-room').reset();
  if (prefillCategory) document.getElementById('room-category').value = prefillCategory;
  buildRoomIconRow();
  modalNewRoom.classList.remove('hidden');
  document.getElementById('room-name').focus();
}

// "+" dentro do servidor atual: cria uma sala nesse mesmo servidor (categoria já preenchida)
document.getElementById('btn-new-room').onclick = () => openNewRoomModal(activeServerCategory);
// "+" do trilho de servidores: cria um servidor novo (categoria em branco pra digitar o nome)
document.getElementById('btn-new-server').onclick = () => openNewRoomModal('');

document.getElementById('btn-cancel-room').onclick = () => modalNewRoom.classList.add('hidden');

document.getElementById('form-new-room').onsubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById('room-name').value.trim();
  const category = document.getElementById('room-category').value.trim();
  const type = document.getElementById('room-type').value;
  const icon = document.getElementById('room-icon').value || '🎮';
  const errorEl = document.getElementById('room-error');
  errorEl.textContent = '';

  try {
    const res = await fetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, category, type, icon }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Erro ao criar sala';
      return;
    }
    modalNewRoom.classList.add('hidden');
    activeServerCategory = data.category; // já entra direto no servidor recém-criado/atualizado
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
  document.getElementById('profile-email').value = me.email || '';
  setProfileStatusFields(me.status_message);
  document.getElementById('profile-new-password').value = '';
  document.getElementById('profile-current-password').value = '';
  pendingAvatar = undefined;
  updateAvatarPreview();
  modalProfile.classList.remove('hidden');
};
document.getElementById('btn-cancel-profile').onclick = () => modalProfile.classList.add('hidden');

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
    loadMembers();
    alert('Perfil atualizado!');
  } catch (err) {
    errorEl.textContent = 'Erro de conexão com o servidor';
  }
};

// Clicar num canal SEMPRE troca o que aparece no painel principal. Só entra
// (ou sai) de uma conexão de voz de verdade quando faz sentido — navegar por
// canais de texto NÃO desconecta você da call, igual Discord.
function selectChannel(channel) {
  // sai do canal de TEXTO anterior (sala de voz não é "deixada" só por trocar de tela)
  if (currentChannel && currentChannel.type === 'texto') {
    socket.emit('channel:leave', currentChannel.id);
  }

  currentChannel = channel;
  document.getElementById('current-channel-name').textContent =
    (channel.type === 'voz' ? '🔊 ' : '# ') + channel.name;
  document.getElementById('home-panel').classList.add('hidden');
  setNavActive('nav-inicio', false);

  if (channel.type === 'voz') {
    document.getElementById('text-panel').classList.add('hidden');
    document.getElementById('voice-panel').classList.remove('hidden');
    if (connectedVoiceRoomId !== channel.id) {
      // já conectado em outra sala de voz? troca (só dá pra estar em uma por vez)
      if (connectedVoiceRoomId) disconnectVoice();
      connectVoice(channel.id);
    }
    // se já está conectado nessa mesma sala, só mostra a tela de novo — os
    // tiles de vídeo/áudio continuam vivos desde a última vez.
  } else {
    document.getElementById('voice-panel').classList.add('hidden');
    document.getElementById('text-panel').classList.remove('hidden');
    joinTextChannel(channel.id);
  }

  renderCategories(allChannels);
}

// Volta pra tela de Início (dashboard), saindo do canal de texto atual (a
// sala de voz continua conectada em segundo plano, igual Discord).
function goHome() {
  if (currentChannel && currentChannel.type === 'texto') {
    socket.emit('channel:leave', currentChannel.id);
  }
  currentChannel = null;
  document.getElementById('current-channel-name').textContent = 'Início';
  document.getElementById('text-panel').classList.add('hidden');
  document.getElementById('voice-panel').classList.add('hidden');
  document.getElementById('home-panel').classList.remove('hidden');
  setNavActive('nav-inicio', true);
  renderCategories(allChannels);
  loadHomeDashboard();
}

function setNavActive(id, active) {
  document.querySelectorAll('.navbar-link').forEach((el) => el.classList.remove('active'));
  if (active) document.getElementById(id).classList.add('active');
}

// ---------- NAVBAR (busca, sino, perfil, navegação) ----------

function updateNavbarProfile() {
  renderAvatarInto(document.getElementById('navbar-avatar'), me);
  document.getElementById('navbar-username').textContent = me.username;
  const level = Math.max(1, Math.floor((me.message_count || 0) / 10) + 1);
  document.getElementById('navbar-level').textContent = `Nível ${level}`;
}

document.getElementById('nav-inicio').onclick = () => goHome();
document.getElementById('nav-jogos').onclick = () => {
  goHome();
  setTimeout(() => document.getElementById('home-servers-grid').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
};
document.getElementById('nav-comunidade').onclick = () => document.getElementById('btn-toggle-members').click();
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

// ---------- SONS E EFEITOS (liga/desliga geral) ----------

function updateSfxToggleButton() {
  const btn = document.getElementById('nav-sfx-toggle');
  const on = SFX.isEnabled();
  btn.textContent = on ? '🔊' : '🔇';
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

document.getElementById('navbar-search-input').addEventListener('input', (e) => {
  const term = e.target.value.trim().toLowerCase();
  document.querySelectorAll('.server-icon:not(.server-icon-add)').forEach((el) => {
    el.style.opacity = !term || el.title.toLowerCase().includes(term) ? '1' : '0.25';
  });
  document.querySelectorAll('.home-server-card').forEach((el) => {
    el.style.display = !term || el.dataset.name.includes(term) ? '' : 'none';
  });
});

// ---------- PAINEL DE INÍCIO (dashboard com dados reais) ----------

document.getElementById('home-btn-explore').onclick = () => {
  document.getElementById('home-servers-grid').scrollIntoView({ behavior: 'smooth', block: 'start' });
};
document.getElementById('home-btn-community').onclick = () => document.getElementById('btn-toggle-members').click();

async function loadHomeDashboard() {
  loadHomeStats();
  loadHomeServers();
  loadHomePlayingNow();
  loadHomeActivity();
  loadHomeTournament();
  loadHomeRanking();
  loadHomeStreakCard();
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

async function loadHomeTournament() {
  const el = document.getElementById('home-tournament');
  const res = await fetch('/api/tournaments', { credentials: 'include' });
  const tournaments = await res.json();
  const upcoming = tournaments.filter((t) => !t.event_date || new Date(t.event_date) >= new Date()).slice(0, 1)[0];
  if (!upcoming) {
    el.innerHTML = '<p class="empty-hint">Nenhum torneio marcado ainda.</p>';
    return;
  }
  const dateText = upcoming.event_date
    ? new Date(upcoming.event_date + 'T00:00:00').toLocaleDateString('pt-BR')
    : 'Data a definir';
  el.innerHTML = `
    <div class="home-tournament-card">
      <h3>🏆 ${escapeHtml(upcoming.name)}</h3>
      <div class="tournament-meta">
        <span>🎮 ${escapeHtml(upcoming.game)}</span>
        <span>📅 ${dateText}</span>
      </div>
      <div class="tournament-meta">
        ${upcoming.prize ? `<span>💰 ${escapeHtml(upcoming.prize)}</span>` : ''}
        <span>👥 ${upcoming.registered_count}/${upcoming.max_slots}</span>
      </div>
      <button class="home-btn-primary" id="home-tournament-join" style="width:100%; margin-top:8px;">
        ${upcoming.is_registered ? 'Você já está inscrito ✅' : 'Inscrever-se Agora'}
      </button>
    </div>
  `;
  if (!upcoming.is_registered) {
    document.getElementById('home-tournament-join').onclick = async () => {
      const res2 = await fetch(`/api/tournaments/${upcoming.id}/register`, { method: 'POST', credentials: 'include' });
      const data = await res2.json();
      if (!res2.ok) {
        alert(data.error || 'Erro');
        return;
      }
      loadHomeTournament();
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

// Salas de voz também têm chat de texto (o "Chat da Sala" ao lado da
// chamada) — usa o mesmo channel_id, só muda pra qual <div> a mensagem vai.
function messagesContainerFor(channelId) {
  const isVoiceChannel = allChannels.some((c) => c.id === channelId && c.type === 'voz');
  return document.getElementById(isVoiceChannel ? 'voice-chat-messages' : 'messages');
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
        </div>
        <div class="content">${escapeHtml(msg.content)}</div>
        <div class="message-reactions" id="reactions-${msg.id}"></div>
      </div>
    </div>
    <div class="message-actions">
      ${isBot ? '' : '<button class="act-react" title="Reagir">😀</button>'}
      ${isOwn && !isBot ? '<button class="act-edit" title="Editar">✏️</button>' : ''}
      ${canDelete ? '<button class="act-delete" title="Apagar">🗑️</button>' : ''}
      ${isBot ? '' : '<button class="act-report" title="Denunciar">🚩</button>'}
    </div>
    <div class="reaction-picker" id="picker-${msg.id}">
      ${REACTION_EMOJIS.map((e) => `<button data-emoji="${e}">${e}</button>`).join('')}
    </div>
  `;

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

document.getElementById('form-message').onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content || !currentChannel) return;
  socket.emit('chat:message', { channelId: currentChannel.id, content });
  input.value = '';
  clearTimeout(typingTimeout);
  isTyping = false;
  socket.emit('typing:stop', currentChannel.id);
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- SOCKET HANDLERS ----------

function registerSocketHandlers() {
  socket.on('chat:message', (msg) => {
    if (currentChannel && msg.channel_id === currentChannel.id) renderMessage(msg);
    if (msg.user_id !== me.id) {
      const mentioned = msg.content && msg.content.toLowerCase().includes('@' + me.username.toLowerCase());
      if (mentioned) SFX.mention();
      else SFX.message();
    }
  });

  socket.on('chat:blocked', ({ reason }) => {
    alert('⚠️ ' + reason);
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

  socket.on('presence:online', (userIds) => {
    onlineUserIds = new Set(userIds);
    renderMembers();
  });

  socket.on('rtc:peer-joined', ({ socketId, username }) => {
    const pc = createPeerConnection(socketId, username);
    addLocalTracksToPeer(pc);
    logVoiceActivity(`${username} entrou na sala`);
    updateVoiceParticipantCount();
    SFX.peerJoin();
  });

  socket.on('rtc:peer-left', ({ socketId, username }) => {
    if (peers[socketId]) {
      peers[socketId].close();
      delete peers[socketId];
    }
    delete remoteStreams[socketId];
    stopConnectionQualityMonitor(socketId);
    logVoiceActivity(`${username || 'Alguém'} saiu da sala`);
    updateVoiceParticipantCount();
    removeVideoTile(socketId);
    SFX.peerLeave();
  });

  socket.on('rtc:signal', async ({ from, username, data }) => {
    let pc = peers[from];
    if (!pc) {
      pc = createPeerConnection(from, username);
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
  });

  socket.on('voice:update', ({ roomId, participants }) => {
    voiceParticipants[roomId] = participants;
    renderCategories(allChannels);
  });
}

// ---------- WEBRTC (voz / compartilhamento de tela) ----------

async function connectVoice(roomId) {
  SFX.join();
  connectedVoiceRoomId = roomId;
  socket.emit('rtc:join', roomId);
  socket.emit('channel:join', roomId); // pro chat da sala funcionar (mesmo canal, uso duplo texto+voz)
  loadVoiceChatHistory(roomId);
  setupVoiceInvite(roomId);
  clearVoiceActivityLog();
  logVoiceActivity('Você entrou na sala');
  await startMicrophone();
  updateVoiceBar();
  updateVoiceParticipantCount();
}

function disconnectVoice() {
  if (!connectedVoiceRoomId) return;
  SFX.leave();
  socket.emit('rtc:leave', connectedVoiceRoomId);
  socket.emit('channel:leave', connectedVoiceRoomId);
  Object.keys(peers).forEach((id) => {
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
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
    updateCameraButton();
  }
  document.getElementById('video-grid').innerHTML = '';
  document.getElementById('btn-share-screen').classList.remove('hidden');
  document.getElementById('btn-stop-share').classList.add('hidden');
  setMicStatus('');
  updateVoiceBar();
  renderCategories(allChannels);
  updateVoiceParticipantCount();
}

// ---------- EXTRAS DA SALA DE VOZ: convite, atividade, participantes, qualidade ----------

function setupVoiceInvite(roomId) {
  const input = document.getElementById('voice-invite-link');
  input.value = `${window.location.origin}/?channel=${roomId}`;
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

document.getElementById('btn-toggle-voice-chat').onclick = () => {
  document.getElementById('voice-panel').classList.toggle('chat-open');
  document.getElementById('btn-toggle-voice-chat').classList.toggle(
    'active-state',
    document.getElementById('voice-panel').classList.contains('chat-open')
  );
};

document.getElementById('form-voice-message').onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById('voice-message-input');
  const content = input.value.trim();
  if (!content || !connectedVoiceRoomId) return;
  socket.emit('chat:message', { channelId: connectedVoiceRoomId, content });
  input.value = '';
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
    micStream.getTracks().forEach((track) => pc.addTrack(track, micStream));
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => pc.addTrack(track, cameraStream));
  }
}

function createPeerConnection(peerId, username) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peers[peerId] = pc;

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
    addVideoTile(peerId, username, stream);
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
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      delete remoteStreams[peerId];
      removeVideoTile(peerId);
    }
  };

  startConnectionQualityMonitor(peerId, pc);

  return pc;
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

function addVideoTile(peerId, username, stream) {
  let tile = document.getElementById('tile-' + peerId);
  const isNew = !tile;
  const isRemote = peerId !== 'local' && peerId !== 'local-camera';
  if (isNew) {
    tile = document.createElement('div');
    tile.className = 'video-tile tile-enter';
    tile.id = 'tile-' + peerId;
    const initial = escapeHtml((username || '?')[0].toUpperCase());
    tile.innerHTML = `
      <video autoplay playsinline></video>
      <div class="tile-avatar"><span>${initial}</span></div>
      <div class="tile-waveform"><span></span><span></span><span></span><span></span></div>
      ${isRemote ? '<span class="quality-dot quality-good" title="Qualidade da conexão"></span>' : ''}
      <span class="label">${escapeHtml(username || 'Participante')}</span>
      <div class="tile-controls">
        ${isRemote ? '<input type="range" class="tile-volume" min="0" max="100" value="100" title="Volume" />' : ''}
        <button type="button" class="tile-btn tile-expand-btn" title="Ampliar">⤢</button>
        <button type="button" class="tile-btn tile-fullscreen-btn" title="Tela cheia">⛶</button>
      </div>
    `;
    document.getElementById('video-grid').appendChild(tile);
    // remove a classe de animação depois que ela roda, pra não repetir em updates futuros
    setTimeout(() => tile.classList.remove('tile-enter'), 260);

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

    // Volume individual dessa pessoa (só ajusta o que você ouve, não afeta os outros)
    const volumeSlider = tile.querySelector('.tile-volume');
    if (volumeSlider) {
      volumeSlider.oninput = (e) => {
        e.stopPropagation();
        tile.querySelector('video').volume = Number(volumeSlider.value) / 100;
      };
      volumeSlider.onclick = (e) => e.stopPropagation();
    }
  }

  const videoEl = tile.querySelector('video');
  videoEl.srcObject = stream;
  // A tile "local" é a sua própria câmera/mic — sempre muda pra você mesmo
  // (senão você ouviria seu próprio microfone de volta, causando eco/feedback).
  videoEl.muted = peerId === 'local' ? true : isDeafened;
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

// ---------- MICROFONE (voz de verdade, igual chamada de voz) ----------

async function startMicrophone() {
  showConnectingTile();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
  } catch (err) {
    removeConnectingTile();
    setMicStatus('Não foi possível acessar o microfone: ' + err.message);
    return;
  }
  updateMicEnabledState();
  Object.values(peers).forEach((pc) => {
    micStream.getTracks().forEach((track) => pc.addTrack(track, micStream));
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
  if (micStream) micStream.getAudioTracks().forEach((t) => combined.addTrack(t));
  if (localStream) localStream.getVideoTracks().forEach((t) => combined.addTrack(t));
  addVideoTile('local', me.username + ' (você)', combined);

  if (cameraStream) {
    addVideoTile('local-camera', me.username + ' (câmera)', cameraStream);
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

let screenShareQuality = localStorage.getItem('ng_screen_quality') || '1080p30';

const SCREEN_QUALITY_PRESETS = {
  '720p30': { width: 1280, height: 720, frameRate: 30 },
  '1080p30': { width: 1920, height: 1080, frameRate: 30 },
  '1080p60': { width: 1920, height: 1080, frameRate: 60 },
};

document.getElementById('screen-quality-select').onchange = (e) => {
  screenShareQuality = e.target.value;
  localStorage.setItem('ng_screen_quality', screenShareQuality);
};

document.getElementById('btn-share-screen').onclick = async () => {
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
    alert('Não foi possível iniciar o compartilhamento de tela: ' + err.message);
    return;
  }
  updateLocalTile();
  Object.values(peers).forEach((pc) => {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  });
  document.getElementById('btn-share-screen').classList.add('hidden');
  document.getElementById('btn-stop-share').classList.remove('hidden');
  SFX.screenShareStart();

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
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  document.getElementById('btn-share-screen').classList.remove('hidden');
  document.getElementById('btn-stop-share').classList.add('hidden');
  updateLocalTile();
  SFX.screenShareStop();
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

tryResumeSession();
