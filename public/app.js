// app.js - lógica do frontend (auth, canais, chat, WebRTC screen share)

let me = null;
let socket = null;
let currentChannel = null;
let currentVoiceRoom = null;
let localStream = null;
const peers = {}; // socketId -> RTCPeerConnection

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

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

formLogin.onsubmit = async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  await authRequest('/api/login', { username, password });
};

formRegister.onsubmit = async (e) => {
  e.preventDefault();
  const username = document.getElementById('register-username').value.trim();
  const password = document.getElementById('register-password').value;
  await authRequest('/api/register', { username, password });
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
  if (me.is_admin) document.getElementById('admin-link').classList.remove('hidden');

  socket = io({ auth: { userId: me.id } });
  registerSocketHandlers();
  loadChannels();
}

// ---------- CHANNELS ----------

let allChannels = [];

async function loadChannels() {
  const res = await fetch('/api/channels', { credentials: 'include' });
  allChannels = await res.json();
  renderCategories(allChannels);
  updateCategoryDatalist(allChannels);
}

function renderCategories(channels) {
  const container = document.getElementById('categories-container');
  container.innerHTML = '';

  // Agrupa canais por categoria (cada categoria = um "servidor"/comunidade)
  const byCategory = {};
  channels.forEach((ch) => {
    if (!byCategory[ch.category]) byCategory[ch.category] = [];
    byCategory[ch.category].push(ch);
  });

  Object.keys(byCategory)
    .sort((a, b) => a.localeCompare(b))
    .forEach((category) => {
      const section = document.createElement('div');
      section.className = 'category';
      section.dataset.category = category;

      const title = document.createElement('div');
      title.className = 'category-title';
      title.textContent = categoryIcon(category) + ' ' + category;
      section.appendChild(title);

      const list = document.createElement('div');
      list.className = 'channel-list';
      byCategory[category].forEach((ch) => {
        const el = document.createElement('div');
        el.className = 'channel-item';
        el.textContent = (ch.type === 'voz' ? '🔊 ' : '# ') + ch.name;
        el.onclick = () => selectChannel(ch, el);
        list.appendChild(el);
      });
      section.appendChild(list);
      container.appendChild(section);
    });
}

function categoryIcon(category) {
  const normalized = category.toLowerCase();
  if (normalized.includes('trabalho')) return '💼';
  return '🎮';
}

function updateCategoryDatalist(channels) {
  const datalist = document.getElementById('category-options');
  const categories = [...new Set(channels.map((c) => c.category))];
  datalist.innerHTML = categories.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('');
}

// ---------- CRIAR SALA (modal) ----------

const modalNewRoom = document.getElementById('modal-new-room');
document.getElementById('btn-new-room').onclick = () => {
  document.getElementById('room-error').textContent = '';
  document.getElementById('form-new-room').reset();
  modalNewRoom.classList.remove('hidden');
};
document.getElementById('btn-cancel-room').onclick = () => modalNewRoom.classList.add('hidden');

document.getElementById('form-new-room').onsubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById('room-name').value.trim();
  const category = document.getElementById('room-category').value.trim();
  const type = document.getElementById('room-type').value;
  const errorEl = document.getElementById('room-error');
  errorEl.textContent = '';

  try {
    const res = await fetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, category, type }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Erro ao criar sala';
      return;
    }
    modalNewRoom.classList.add('hidden');
    await loadChannels();
  } catch (err) {
    errorEl.textContent = 'Erro de conexão com o servidor';
  }
};

function selectChannel(channel, el) {
  document.querySelectorAll('.channel-item').forEach((c) => c.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('current-channel-name').textContent =
    (channel.type === 'voz' ? '🔊 ' : '# ') + channel.name;

  leaveCurrentChannel();
  currentChannel = channel;

  if (channel.type === 'voz') {
    document.getElementById('text-panel').classList.add('hidden');
    document.getElementById('voice-panel').classList.remove('hidden');
    joinVoiceRoom(channel.id);
  } else {
    document.getElementById('voice-panel').classList.add('hidden');
    document.getElementById('text-panel').classList.remove('hidden');
    joinTextChannel(channel.id);
  }
}

function leaveCurrentChannel() {
  if (!currentChannel) return;
  if (currentChannel.type === 'voz') {
    leaveVoiceRoom();
  } else {
    socket.emit('channel:leave', currentChannel.id);
  }
}

// ---------- TEXT CHAT ----------

async function joinTextChannel(channelId) {
  socket.emit('channel:join', channelId);
  const res = await fetch(`/api/channels/${channelId}/messages`, { credentials: 'include' });
  const messages = await res.json();
  const container = document.getElementById('messages');
  container.innerHTML = '';
  messages.forEach(renderMessage);
  container.scrollTop = container.scrollHeight;
}

function renderMessage(msg) {
  const container = document.getElementById('messages');
  const el = document.createElement('div');
  el.className = 'message';
  const time = new Date(msg.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `
    <div class="meta"><strong>${escapeHtml(msg.username)}</strong> · ${time}</div>
    <div class="content">${escapeHtml(msg.content)}</div>
    <span class="report-link" data-id="${msg.id}" data-user="${msg.user_id}">Denunciar</span>
  `;
  el.querySelector('.report-link').onclick = () => reportMessage(msg.id, msg.user_id);
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

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

document.getElementById('form-message').onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content || !currentChannel) return;
  socket.emit('chat:message', { channelId: currentChannel.id, content });
  input.value = '';
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
  });

  socket.on('chat:blocked', ({ reason }) => {
    alert('⚠️ ' + reason);
  });

  socket.on('rtc:peer-joined', ({ socketId, username }) => {
    const pc = createPeerConnection(socketId, username);
    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }
  });

  socket.on('rtc:peer-left', ({ socketId }) => {
    if (peers[socketId]) {
      peers[socketId].close();
      delete peers[socketId];
    }
    removeVideoTile(socketId);
  });

  socket.on('rtc:signal', async ({ from, username, data }) => {
    let pc = peers[from];
    if (!pc) {
      pc = createPeerConnection(from, username);
      if (localStream) {
        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
      }
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
}

// ---------- WEBRTC (voz / compartilhamento de tela) ----------

function joinVoiceRoom(roomId) {
  currentVoiceRoom = roomId;
  socket.emit('rtc:join', roomId);
}

function leaveVoiceRoom() {
  if (!currentVoiceRoom) return;
  socket.emit('rtc:leave', currentVoiceRoom);
  Object.keys(peers).forEach((id) => {
    peers[id].close();
    delete peers[id];
  });
  document.getElementById('video-grid').innerHTML = '';
  stopScreenShare();
  currentVoiceRoom = null;
}

function createPeerConnection(peerId, username) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peers[peerId] = pc;

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('rtc:signal', { to: peerId, data: e.candidate });
  };

  pc.ontrack = (e) => {
    addVideoTile(peerId, username, e.streams[0]);
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
      removeVideoTile(peerId);
    }
  };

  return pc;
}

function addVideoTile(peerId, username, stream) {
  let tile = document.getElementById('tile-' + peerId);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = 'tile-' + peerId;
    tile.innerHTML = `<video autoplay playsinline></video><span class="label">${escapeHtml(username || 'Participante')}</span>`;
    document.getElementById('video-grid').appendChild(tile);
  }
  tile.querySelector('video').srcObject = stream;
}

function removeVideoTile(peerId) {
  const tile = document.getElementById('tile-' + peerId);
  if (tile) tile.remove();
}

document.getElementById('btn-share-screen').onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (err) {
    alert('Não foi possível iniciar o compartilhamento de tela: ' + err.message);
    return;
  }
  addVideoTile('local', me.username + ' (você)', localStream);
  Object.values(peers).forEach((pc) => {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  });
  document.getElementById('btn-share-screen').classList.add('hidden');
  document.getElementById('btn-stop-share').classList.remove('hidden');

  localStream.getVideoTracks()[0].onended = stopScreenShare;
};

document.getElementById('btn-stop-share').onclick = stopScreenShare;

function stopScreenShare() {
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  removeVideoTile('local');
  document.getElementById('btn-share-screen').classList.remove('hidden');
  document.getElementById('btn-stop-share').classList.add('hidden');
}

document.getElementById('btn-leave-voice').onclick = () => {
  leaveVoiceRoom();
  document.getElementById('voice-panel').classList.add('hidden');
  currentChannel = null;
  document.getElementById('current-channel-name').textContent = 'Selecione um canal';
  document.querySelectorAll('.channel-item').forEach((c) => c.classList.remove('active'));
};

tryResumeSession();
