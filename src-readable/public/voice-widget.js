// voice-widget.js — motor do widget embutível de áudio (public/voice-widget.html).
//
// Implementação INDEPENDENTE da sala de voz do app principal (app.js) — de
// propósito uma cópia enxuta, não um reaproveitamento direto, pra não correr
// risco nenhum de quebrar a call de dentro do NEXT GAME (que já funciona e é
// bem mais testada). Fala o MESMO protocolo de sinalização do servidor
// (rtc:join/rtc:signal/rtc:peer-joined/rtc:peer-left — ver server.js), só
// que focado só em ÁUDIO (sem câmera/tela, sem chat de texto) e pra rodar
// dentro de um <iframe> de outro site.
//
// Eventos mandados pro site que incluiu o iframe (via postMessage), todos
// com origin '*' (o conteúdo não é sensível — só presença/estado da call;
// nada de senha/token circula aqui):
//   { source: 'nextgame-voice', type: 'ready' }
//   { source: 'nextgame-voice', type: 'need-login' }
//   { source: 'nextgame-voice', type: 'connected', room, peers: [...] }
//   { source: 'nextgame-voice', type: 'peer-joined', peer: {userId, username} }
//   { source: 'nextgame-voice', type: 'peer-left', peer: {userId, username} }
//   { source: 'nextgame-voice', type: 'muted-changed', muted: bool }
//   { source: 'nextgame-voice', type: 'left' }
//   { source: 'nextgame-voice', type: 'error', message }
//
// Comandos aceitos vindos do site pai (também via postMessage):
//   { source: 'nextgame-voice-command', action: 'leave' }
//   { source: 'nextgame-voice-command', action: 'set-muted', value: bool }
(function () {
  'use strict';

  const qs = new URLSearchParams(window.location.search);

  // ---------- Resolve o id da sala a partir da URL (ver cabeçalho do .html) ----------
  function resolveRoomId() {
    const direct = qs.get('room');
    if (direct) return { roomId: direct, label: qs.get('label') || 'Sala de voz' };
    const mode = (qs.get('mode') || 'geral').toLowerCase();
    const game = (qs.get('game') || 'jogo').replace(/[^a-z0-9_-]/gi, '').toLowerCase();
    const match = (qs.get('match') || '').replace(/[^a-z0-9_-]/gi, '').toLowerCase();
    if (mode === 'lobby') return { roomId: `ext-lobby-${game}`, label: 'Lobby' };
    if (mode === 'match' || mode === 'partida') {
      if (!match) return { roomId: `ext-lobby-${game}`, label: 'Lobby' }; // sem matchId, cai no lobby
      return { roomId: `ext-match-${game}-${match}`, label: 'Partida' };
    }
    return { roomId: 'ext-geral', label: 'Geral' };
  }
  const { roomId, label } = resolveRoomId();
  const startMuted = qs.get('muted') === '1';
  const theme = qs.get('theme') === 'light' ? 'light' : 'dark';
  if (theme === 'light') document.getElementById('vw-root').classList.add('vw-theme-light');

  // ---------- Helpers de UI (troca de "tela" dentro do widget) ----------
  const screens = {
    loading: document.getElementById('vw-loading'),
    login: document.getElementById('vw-login'),
    error: document.getElementById('vw-error'),
    call: document.getElementById('vw-call'),
  };
  function showScreen(name) {
    Object.values(screens).forEach((el) => el.classList.add('hidden'));
    screens[name].classList.remove('hidden');
  }
  function showError(message) {
    document.getElementById('vw-error-text').textContent = message;
    showScreen('error');
    postToParent({ type: 'error', message });
  }

  function postToParent(payload) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(Object.assign({ source: 'nextgame-voice' }, payload), '*');
      }
    } catch (_) { /* iframe cross-origin estrito — ignora, não é crítico */ }
  }

  // ---------- Estado ----------
  let me = null; // { userId, username, avatar, avatar_frame }
  let socket = null;
  let micStream = null;
  let micMuted = startMuted;
  const peers = {}; // socketId -> RTCPeerConnection
  const peerInfo = {}; // socketId -> { userId, username, avatar }
  const remoteAudioEls = {}; // socketId -> <audio>
  let ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  async function loadIceServers() {
    try {
      const res = await fetch('/api/ice-servers', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) ICE_SERVERS = data.iceServers;
    } catch (_) { /* mantém fallback só-STUN */ }
  }

  function initials(name) {
    return (name || '?').trim().slice(0, 2).toUpperCase();
  }

  // ---------- Tiles (participantes) ----------
  function renderTile(socketId, info) {
    let tile = document.getElementById('vw-tile-' + socketId);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'vw-tile';
      tile.id = 'vw-tile-' + socketId;
      tile.innerHTML = `
        <div class="vw-tile-avatar">
          ${info.avatar ? `<img src="${info.avatar}" alt="" />` : initials(info.username)}
          <span class="vw-tile-muted-badge hidden">🔇</span>
        </div>
        <span class="vw-tile-name"></span>
      `;
      document.getElementById('vw-tiles').appendChild(tile);
    }
    tile.querySelector('.vw-tile-name').textContent = info.username || 'Participante';
    updateCallCount();
  }
  function removeTile(socketId) {
    const tile = document.getElementById('vw-tile-' + socketId);
    if (tile) tile.remove();
    updateCallCount();
  }
  function updateCallCount() {
    const n = document.querySelectorAll('.vw-tile').length + 1; // +1 = você
    document.getElementById('vw-call-count').textContent = n === 1 ? '1 na call' : n + ' na call';
  }

  // ---------- Microfone ----------
  async function startMic() {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    micStream.getAudioTracks().forEach((t) => { t.enabled = !micMuted; });
  }
  function setMuted(value) {
    micMuted = !!value;
    if (micStream) micStream.getAudioTracks().forEach((t) => { t.enabled = !micMuted; });
    const btn = document.getElementById('vw-btn-mute');
    btn.classList.toggle('vw-muted', micMuted);
    btn.textContent = micMuted ? '🔇' : '🎙️';
    postToParent({ type: 'muted-changed', muted: micMuted });
  }

  // ---------- WebRTC (mesh, mesmo protocolo do app principal) ----------
  function createPeerConnection(socketId, info) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peers[socketId] = pc;
    peerInfo[socketId] = info;
    renderTile(socketId, info);

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('rtc:signal', { to: socketId, data: e.candidate });
    };
    pc.ontrack = (e) => {
      let audioEl = remoteAudioEls[socketId];
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        document.body.appendChild(audioEl);
        remoteAudioEls[socketId] = audioEl;
      }
      audioEl.srcObject = e.streams[0];
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(socketId);
    };
    if (micStream) micStream.getTracks().forEach((t) => pc.addTrack(t, micStream));
    return pc;
  }

  function closePeer(socketId) {
    const pc = peers[socketId];
    if (pc) { pc.close(); delete peers[socketId]; }
    delete peerInfo[socketId];
    const audioEl = remoteAudioEls[socketId];
    if (audioEl) { audioEl.srcObject = null; audioEl.remove(); delete remoteAudioEls[socketId]; }
    removeTile(socketId);
  }

  async function initiateConnection(socketId, info) {
    const pc = createPeerConnection(socketId, info);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('rtc:signal', { to: socketId, data: offer });
  }

  async function handleSignal({ from, userId, username, avatar, data }) {
    let pc = peers[from];
    if (!pc) pc = createPeerConnection(from, { userId, username, avatar });
    if (data.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('rtc:signal', { to: from, data: answer });
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
    } else if (data.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(data)).catch(() => {});
    }
  }

  // ---------- Conexão principal ----------
  async function connect() {
    await loadIceServers();
    await startMic();

    socket = io({ auth: { userId: me.userId } });

    socket.on('connect_error', () => showError('Não foi possível conectar ao NEXT GAME. Tenta de novo.'));

    socket.on('rtc:signal', (payload) => { handleSignal(payload).catch(() => {}); });

    socket.on('rtc:peer-left', ({ socketId, username }) => {
      closePeer(socketId);
      postToParent({ type: 'peer-left', peer: { username } });
    });

    socket.on('rtc:peer-joined', ({ username, userId }) => {
      // Mesma regra do app principal: quem ACABA DE CHEGAR inicia a conexão
      // com todo mundo (ver o ack de rtc:join abaixo) — quem já estava na
      // sala só responde quando a oferta chegar (handleSignal), nunca inicia
      // sozinho. Evita os dois lados tentando negociar ao mesmo tempo.
      postToParent({ type: 'peer-joined', peer: { userId, username } });
    });

    socket.on('rtc:room-full', ({ max }) => {
      showError(`Essa sala já está no limite de ${max} pessoas.`);
    });

    socket.emit('rtc:join', roomId, async (ack) => {
      if (!ack || !ack.ok) {
        showError(ack && ack.reason === 'room-full' ? `Sala cheia (máx. ${ack.max}).` : 'Não foi possível entrar na sala.');
        return;
      }
      document.getElementById('vw-room-label').textContent = label;
      showScreen('call');
      setMuted(micMuted); // aplica o estado inicial (?muted=1) no botão
      postToParent({ type: 'connected', room: roomId, peers: ack.peers || [] });
      for (const peer of ack.peers || []) {
        if (peers[peer.socketId]) continue;
        await initiateConnection(peer.socketId, peer);
      }
    });
  }

  function leave() {
    if (socket) {
      socket.emit('rtc:leave', roomId);
      socket.disconnect();
    }
    Object.keys(peers).forEach(closePeer);
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    postToParent({ type: 'left' });
  }

  // ---------- Botões ----------
  document.getElementById('vw-btn-mute').onclick = () => setMuted(!micMuted);
  document.getElementById('vw-btn-leave').onclick = () => { leave(); showScreen('loading'); };
  document.getElementById('vw-retry-btn').onclick = () => { showScreen('loading'); boot(); };

  // Link de login abre o NEXT GAME numa aba nova (o widget roda dentro do
  // iframe de outro site — não dá, nem seria seguro, redirecionar a página
  // inteira do jogo do amigo pra tela de login do NEXT GAME e trazer de
  // volta sozinho). Ao voltar o foco pra essa aba/iframe, confere de novo
  // automaticamente se o login já foi feito, sem precisar clicar em nada.
  document.getElementById('vw-login-link').href = window.location.origin + '/';
  document.getElementById('vw-login-link').onclick = (e) => {
    e.preventDefault();
    window.open(window.location.origin + '/', '_blank', 'noopener');
  };
  window.addEventListener('focus', () => {
    if (!screens.login.classList.contains('hidden')) boot();
  });

  // ---------- Comandos vindos do site pai ----------
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.source !== 'nextgame-voice-command') return;
    if (msg.action === 'leave') leave();
    else if (msg.action === 'set-muted') setMuted(!!msg.value);
  });

  // ---------- Boot ----------
  async function boot() {
    try {
      const res = await fetch('/api/integration/voice/me', { credentials: 'include' });
      if (res.status === 401) { showScreen('login'); return; }
      if (!res.ok) { showError('Erro ao verificar login no NEXT GAME.'); return; }
      me = await res.json();
      await connect();
    } catch (err) {
      showError('Erro de conexão com o NEXT GAME.');
    }
  }

  postToParent({ type: 'ready' });
  boot();
})();
