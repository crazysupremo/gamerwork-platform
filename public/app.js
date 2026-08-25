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
  const titleEl = document.getElementById('auth-card-title');
  const subtitleEl = document.getElementById('auth-card-subtitle');
  if (titleEl && subtitleEl) {
    if (which === 'login') {
      titleEl.textContent = 'BEM-VINDO DE VOLTA';
      subtitleEl.innerHTML = 'Entre para continuar sua jornada no <strong>NEXT GAME</strong>.';
    } else {
      titleEl.textContent = 'CRIAR CONTA';
      subtitleEl.innerHTML = 'É grátis — junte-se à comunidade em segundos.';
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
  await authRequest('/api/login', { username, password });
};

formRegister.onsubmit = async (e) => {
  e.preventDefault();
  const username = document.getElementById('register-username').value.trim();
  const email = document.getElementById('register-email').value.trim();
  const password = document.getElementById('register-password').value;
  await authRequest('/api/register', { username, email, password });
};

let pending2FALoginToken = null;

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
    if (data.requires2fa) {
      pending2FALoginToken = data.tempToken;
      formLogin.classList.add('hidden');
      formRegister.classList.add('hidden');
      document.getElementById('form-2fa').classList.remove('hidden');
      document.getElementById('login-2fa-code').value = '';
      document.getElementById('login-2fa-code').focus();
      return;
    }
    me = data;
    startApp();
  } catch (err) {
    authError.textContent = 'Erro de conexão com o servidor';
  }
}

document.getElementById('form-2fa').onsubmit = async (e) => {
  e.preventDefault();
  const code = document.getElementById('login-2fa-code').value.trim();
  await authRequest('/api/login/2fa', { tempToken: pending2FALoginToken, code });
};

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
  refreshFriendsBadge();
  checkInviteLinkOnLoad();

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

    const unread = unreadByCategory[category];
    if (unread) {
      const badge = document.createElement('span');
      badge.className = 'server-icon-badge';
      badge.textContent = unread > 99 ? '99+' : String(unread);
      btn.appendChild(badge);
    }

    btn.onclick = () => {
      activeServerCategory = category;
      markServerRead(category);
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
      label.textContent = (ch.type === 'voz' ? '🔊 ' : '# ') + ch.name + (ch.read_only ? ' 🔒' : '');
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
      inviteBtn.onclick = (e) => {
        e.stopPropagation();
        const url = `${window.location.origin}/?channel=${ch.id}`;
        navigator.clipboard.writeText(url).catch(() => {});
        showCopyToast('Link do canal copiado!');
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
  modalJoinInvite.classList.remove('hidden');
};
document.getElementById('btn-close-join-invite').onclick = () => modalJoinInvite.classList.add('hidden');

// Aceita tanto o código puro quanto um link completo (?invite=CODIGO).
function extractInviteCode(raw) {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    const fromQuery = url.searchParams.get('invite');
    if (fromQuery) return fromQuery;
  } catch (_) {
    // não é uma URL válida, trata como código puro mesmo
  }
  return trimmed;
}

async function joinWithInviteCode(code) {
  const errorEl = document.getElementById('join-invite-error');
  errorEl.textContent = '';
  try {
    const res = await fetch(`/api/invite/${encodeURIComponent(code)}/join`, { method: 'POST', credentials: 'include' });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Convite inválido';
      return false;
    }
    modalJoinInvite.classList.add('hidden');
    activeServerCategory = data.category;
    await loadChannels();
    return true;
  } catch (_) {
    errorEl.textContent = 'Erro de conexão';
    return false;
  }
}

document.getElementById('btn-submit-invite').onclick = () => {
  const code = extractInviteCode(document.getElementById('join-invite-input').value);
  if (!code) return;
  joinWithInviteCode(code);
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

  await loadManageInvite();
  modalServerManage.classList.remove('hidden');
};
document.getElementById('btn-close-server-manage').onclick = () => modalServerManage.classList.add('hidden');

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
}

document.getElementById('btn-copy-invite').onclick = () => {
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
        <div class="server-member-name">${escapeHtml(m.username)}${m.is_owner ? ' 👑' : ''}</div>
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
        <button class="btn-view-bracket">🏆 Ver chave</button>
        ${t.created_by === me.id || me.is_admin ? '<button class="btn-generate-bracket">Gerar chave</button>' : ''}
        ${me.is_admin ? '<button class="btn-delete-tournament">Excluir</button>' : ''}
      </div>
      <div class="tournament-bracket hidden"></div>
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
    const generateBtn = card.querySelector('.btn-generate-bracket');
    if (generateBtn) {
      generateBtn.onclick = async () => {
        if (!confirm('Gerar a chave agora? Isso embaralha os inscritos e não pode ser refeito.')) return;
        const r = await fetch(`/api/tournaments/${t.id}/generate-bracket`, { method: 'POST', credentials: 'include' });
        const d = await r.json();
        if (!r.ok) return alert(d.error || 'Erro ao gerar chave');
        renderBracket(t.id, card.querySelector('.tournament-bracket'));
      };
    }
    card.querySelector('.btn-view-bracket').onclick = () => {
      const bracketEl = card.querySelector('.tournament-bracket');
      bracketEl.classList.toggle('hidden');
      if (!bracketEl.classList.contains('hidden')) renderBracket(t.id, bracketEl);
    };
    list.appendChild(card);
  });
}

async function renderBracket(tournamentId, container) {
  container.innerHTML = '<p class="empty-hint">Carregando chave...</p>';
  const res = await fetch(`/api/tournaments/${tournamentId}/bracket`, { credentials: 'include' });
  const matches = await res.json();
  if (matches.length === 0) {
    container.innerHTML = '<p class="empty-hint">Chave ainda não foi gerada.</p>';
    return;
  }
  const rounds = {};
  matches.forEach((m) => {
    if (!rounds[m.round]) rounds[m.round] = [];
    rounds[m.round].push(m);
  });
  const roundNames = { 1: 'Primeira rodada', 2: 'Quartas', 3: 'Semifinal', 4: 'Final' };
  container.innerHTML = Object.keys(rounds)
    .sort((a, b) => a - b)
    .map((round) => {
      const label = roundNames[round] || `Rodada ${round}`;
      const matchesHtml = rounds[round]
        .map((m) => {
          return `
          <div class="bracket-match" data-match-id="${m.id}">
            <div class="bracket-side ${m.winner_id === m.player_a_id ? 'bracket-winner' : ''}">${escapeHtml(m.player_a_name || 'A definir')} ${m.score_a != null ? `(${m.score_a})` : ''}</div>
            <div class="bracket-side ${m.winner_id === m.player_b_id ? 'bracket-winner' : ''}">${escapeHtml(m.player_b_name || 'A definir')} ${m.score_b != null ? `(${m.score_b})` : ''}</div>
            ${m.player_a_id && m.player_b_id && m.status !== 'concluida' ? '<button type="button" class="bracket-report-btn">Registrar resultado</button>' : ''}
          </div>
        `;
        })
        .join('');
      return `<div class="bracket-round"><div class="bracket-round-label">${label}</div>${matchesHtml}</div>`;
    })
    .join('');

  container.querySelectorAll('.bracket-report-btn').forEach((btn) => {
    btn.onclick = async () => {
      const matchEl = btn.closest('.bracket-match');
      const matchId = matchEl.dataset.matchId;
      const match = matches.find((m) => m.id === matchId);
      const winnerName = prompt(
        `Quem venceu? Digite exatamente:\n1) ${match.player_a_name}\n2) ${match.player_b_name}`,
        match.player_a_name
      );
      if (!winnerName) return;
      const winnerId = winnerName.trim() === match.player_a_name ? match.player_a_id : match.player_b_id;
      const r = await fetch(`/api/tournaments/matches/${matchId}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ winner_id: winnerId }),
      });
      const d = await r.json();
      if (!r.ok) return alert(d.error || 'Erro ao registrar resultado');
      renderBracket(tournamentId, container);
    };
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

// ---------- AMIGOS ----------

const modalFriends = document.getElementById('modal-friends');

document.getElementById('nav-friends').onclick = () => {
  modalFriends.classList.remove('hidden');
  loadFriends();
};
document.getElementById('btn-close-friends').onclick = () => modalFriends.classList.add('hidden');

let friendsCache = { friends: [], incoming: [], outgoing: [] };

async function refreshFriendsBadge() {
  try {
    const res = await fetch('/api/friends', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    friendsCache = data;
    const badge = document.getElementById('navbar-friends-badge');
    if (data.incoming.length > 0) {
      badge.textContent = data.incoming.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch (_) {}
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
      <span class="friend-name">${escapeHtml(f.user.username)}</span>
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
      <span class="friend-name">${escapeHtml(f.user.username)}</span>
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
      <span class="friend-name">${escapeHtml(f.user.username)}${f.user.status_message ? ` <span class="friend-status">🎮 ${escapeHtml(f.user.status_message)}</span>` : ''}</span>
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
  modalFriends.classList.add('hidden');
  selectChannel({ id: data.channel_id, type: 'texto', name: '💬 ' + username });
}

async function openDmCall(userId, username) {
  const res = await fetch(`/api/dm/${userId}`, { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Não foi possível ligar');
    return;
  }
  modalFriends.classList.add('hidden');
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
      item.onClick();
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
      onClick: () => {
        navigator.clipboard.writeText(`${window.location.origin}/?channel=${ch.id}`).catch(() => {});
        showCopyToast('Link do canal copiado!');
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
  ];
}

function buildUserContextMenuItems(user) {
  const items = [{ icon: '👤', label: 'Ver perfil', onClick: () => openProfilePreview(user) }];
  const actions = userActionItems(user);
  if (actions.length > 0) items.push({ separator: true }, ...actions);
  return items;
}

// ---------- PREVIEW DE PERFIL (ver foto de perfil grande) ----------

const modalProfilePreview = document.getElementById('modal-profile-preview');

function openProfilePreview(user) {
  const avatarEl = document.getElementById('profile-preview-avatar');
  avatarEl.innerHTML = renderAvatarHtml(user);
  avatarEl.className = 'profile-preview-avatar ' + avatarFrameClass(user);
  document.getElementById('profile-preview-username').textContent = user.username + (user.is_admin ? ' 👑' : '');
  document.getElementById('profile-preview-status').textContent = user.status_message ? '🎮 ' + user.status_message : '';

  const actionsEl = document.getElementById('profile-preview-actions');
  actionsEl.innerHTML = '';
  userActionItems(user).forEach((item) => {
    if (item.separator) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'profile-preview-action-btn' + (item.danger ? ' profile-preview-action-danger' : '');
    btn.innerHTML = `${item.icon} ${escapeHtml(item.label)}`;
    btn.onclick = () => item.onClick();
    actionsEl.appendChild(btn);
  });

  modalProfilePreview.classList.remove('hidden');
}
document.getElementById('btn-close-profile-preview').onclick = () => modalProfilePreview.classList.add('hidden');

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
  document.getElementById('profile-bio').value = me.bio || '';
  document.getElementById('profile-region').value = me.region || '';
  document.getElementById('profile-language').value = me.language || '';
  document.getElementById('profile-new-password').value = '';
  document.getElementById('profile-current-password').value = '';
  pendingAvatar = undefined;
  updateAvatarPreview();
  document.querySelectorAll('#modal-profile .manage-tab').forEach((t, i) => t.classList.toggle('active', i === 0));
  document.querySelectorAll('#modal-profile .manage-tab-panel').forEach((p, i) => p.classList.toggle('hidden', i !== 0));
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
    loadMembers();
    alert('Perfil atualizado!');
  } catch (err) {
    errorEl.textContent = 'Erro de conexão com o servidor';
  }
};

// ---------- ABAS DE CONFIGURAÇÕES: Segurança (2FA + sessões), Privacidade
// (bloqueados) e Notificações ----------

document.querySelectorAll('#modal-profile .manage-tab').forEach((tabBtn) => {
  tabBtn.onclick = async () => {
    document.querySelectorAll('#modal-profile .manage-tab').forEach((t) => t.classList.remove('active'));
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

// ---------- BUSCA DE MENSAGENS ----------

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
    if (autoConnect && connectedVoiceRoomId !== channel.id) {
      if (connectedVoiceRoomId) disconnectVoice();
      connectVoice(channel.id);
    }
    updateVoicePanelView(channel);
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
  document.getElementById('btn-join-voice-preview').onclick = () => {
    if (connectedVoiceRoomId && connectedVoiceRoomId !== channel.id) disconnectVoice();
    connectVoice(channel.id);
    updateVoicePanelView(channel);
  };
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
  updateClearChannelButton();
  loadHomeDashboard();
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
document.getElementById('nav-jogos').onclick = () => {
  goHome();
  setTimeout(() => document.getElementById('home-servers-grid').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
};
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
        <div class="content">${escapeHtml(msg.content)}</div>
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

document.getElementById('form-message').onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content || !currentChannel) return;
  socket.emit('chat:message', {
    channelId: currentChannel.id,
    content,
    threadParentId: replyingToMessage ? replyingToMessage.id : undefined,
  });
  input.value = '';
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
    if (currentChannel && currentChannel.type === 'voz') updateVoicePanelView(currentChannel);
  });

  socket.on('voice:update', ({ roomId, participants }) => {
    voiceParticipants[roomId] = participants;
    renderCategories(allChannels);
    if (currentChannel && currentChannel.type === 'voz' && currentChannel.id === roomId) {
      updateVoicePanelView(currentChannel);
    }
  });

  // Alguém te ligou diretamente (DM) — mostra um toast com som pra atender.
  socket.on('dm:ring', ({ fromUsername, channelId }) => {
    SFX.join();
    showCallToast(fromUsername, channelId);
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
  stopFrameModeration();
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
  teardownNoiseGate();
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
  document.getElementById('voice-incall').classList.toggle('chat-open');
  document.getElementById('btn-toggle-voice-chat').classList.toggle(
    'active-state',
    document.getElementById('voice-incall').classList.contains('chat-open')
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
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  document.getElementById('btn-share-screen').classList.remove('hidden');
  document.getElementById('btn-stop-share').classList.add('hidden');
  updateLocalTile();
  SFX.screenShareStop();
  stopFrameModeration();
}

// ---------- MODERAÇÃO DE TELA COMPARTILHADA (camada extra de segurança) ----------
// Enquanto alguém está compartilhando a tela, manda um print periódico pro
// servidor analisar. Não é substituto de moderação humana nem de detecção
// especializada de CSAM — é só mais uma camada, com limitações reais.
let frameModerationInterval = null;

function startFrameModeration() {
  stopFrameModeration();
  frameModerationInterval = setInterval(captureAndModerateFrame, 15000);
}

function stopFrameModeration() {
  if (frameModerationInterval) clearInterval(frameModerationInterval);
  frameModerationInterval = null;
}

async function captureAndModerateFrame() {
  const videoEl = document.querySelector('#tile-local video');
  if (!videoEl || !videoEl.videoWidth) return;
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
    // falha silenciosa — não deve atrapalhar quem está compartilhando a tela
  }
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

tryResumeSession();
