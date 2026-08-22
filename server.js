// server.js - servidor principal
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { createServer } = require('http');
const { Server } = require('socket.io');

const db = require('./db');
const { scanText } = require('./moderation');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || 'troque-este-segredo-antes-de-ir-para-producao';

// Necessário no Render (e em qualquer host atrás de proxy reverso) para que
// cookies "secure" e detecção de HTTPS funcionem corretamente.
app.set('trust proxy', 1);

// Cabeçalhos de segurança (protege contra XSS, clickjacking, sniffing, etc.)
// CSP desabilitado por padrão aqui porque o app usa scripts inline simples;
// ative e ajuste se quiser uma política mais restrita.
app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  cookieSession({
    name: 'session',
    keys: [SESSION_SECRET],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
  })
);

// Limite de tentativas de login/registro por IP, pra dificultar força bruta
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' },
});

// Limite geral pras rotas de API, evita abuso/flood
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.is_banned) return res.status(403).json({ error: 'Conta banida ou inválida' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Somente admins' });
  next();
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- AUTH ----------

app.post('/api/register', authLimiter, (req, res) => {
  const { username, email, password } = req.body || {};
  if (
    !username ||
    !password ||
    typeof username !== 'string' ||
    typeof password !== 'string' ||
    username.length < 3 ||
    username.length > 32 ||
    password.length < 6 ||
    password.length > 200 ||
    !/^[a-zA-Z0-9_.-]+$/.test(username)
  ) {
    return res.status(400).json({
      error: 'Usuário (3-32 caracteres, só letras/números/._-) e senha (6-200 caracteres) são obrigatórios',
    });
  }
  if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email) || email.length > 200) {
    return res.status(400).json({ error: 'E-mail inválido' });
  }
  const existingUsername = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existingUsername) return res.status(409).json({ error: 'Usuário já existe' });
  const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existingEmail) return res.status(409).json({ error: 'Já existe uma conta com esse e-mail' });

  const isFirstUser = db.prepare('SELECT COUNT(*) as c FROM users').get().c === 0;
  const id = uuidv4();
  const password_hash = bcrypt.hashSync(password, 10);
  // email_verified fica 1 direto — sem etapa de confirmação por código, o
  // e-mail é salvo só como dado de cadastro (a pedido do usuário).
  db.prepare(
    'INSERT INTO users (id, username, password_hash, email, email_verified, is_admin) VALUES (?, ?, ?, ?, 1, ?)'
  ).run(id, username, password_hash, email, isFirstUser ? 1 : 0);

  req.session.userId = id;
  res.json({ id, username, is_admin: isFirstUser ? 1 : 0 });
});

app.post('/api/login', authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }
  if (user.is_banned) return res.status(403).json({ error: 'Esta conta foi banida' });

  req.session.userId = user.id;
  res.json({ id: user.id, username: user.username, is_admin: user.is_admin });
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    username: req.user.username,
    is_admin: req.user.is_admin,
    email: req.user.email,
  });
});

// Editar perfil: trocar senha (exige senha atual) e/ou e-mail (exige nova verificação).
app.patch('/api/me', requireAuth, (req, res) => {
  const { email, password, currentPassword } = req.body || {};

  if (password) {
    if (!currentPassword || !bcrypt.compareSync(currentPassword, req.user.password_hash)) {
      return res.status(401).json({ error: 'Senha atual incorreta' });
    }
    if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
      return res.status(400).json({ error: 'Nova senha precisa ter 6-200 caracteres' });
    }
    const newHash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);
  }

  if (email && email !== req.user.email) {
    if (!currentPassword || !bcrypt.compareSync(currentPassword, req.user.password_hash)) {
      return res.status(401).json({ error: 'Senha atual incorreta' });
    }
    if (!EMAIL_REGEX.test(email) || email.length > 200) {
      return res.status(400).json({ error: 'E-mail inválido' });
    }
    const existingEmail = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.user.id);
    if (existingEmail) return res.status(409).json({ error: 'Já existe uma conta com esse e-mail' });

    db.prepare('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?').run(email, req.user.id);
  }

  res.json({ ok: true });
});

// ---------- CHANNELS ----------

app.get('/api/channels', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM channels ORDER BY category, type, name').all());
});

// Qualquer usuário logado pode criar uma sala nova. Se a "categoria" (nome do
// servidor/comunidade) informada ainda não existir, ela é criada na hora —
// é assim que usuários criam servidores próprios (ex: "Valorant", "Minecraft").
app.post('/api/channels', requireAuth, (req, res) => {
  const { name, category, type } = req.body || {};
  if (
    !name ||
    !category ||
    typeof name !== 'string' ||
    typeof category !== 'string' ||
    name.trim().length < 2 ||
    name.trim().length > 40 ||
    category.trim().length < 2 ||
    category.trim().length > 40
  ) {
    return res.status(400).json({ error: 'Nome e servidor/categoria precisam ter entre 2 e 40 caracteres' });
  }
  if (!['texto', 'voz'].includes(type)) {
    return res.status(400).json({ error: 'Tipo inválido' });
  }

  const cleanName = name.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
  const cleanCategory = category.trim().slice(0, 40);
  const id = uuidv4();

  db.prepare(
    'INSERT INTO channels (id, name, category, type, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(id, cleanName, cleanCategory, type, req.user.id);

  res.json({ id, name: cleanName, category: cleanCategory, type });
});

app.get('/api/channels/:id/messages', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      'SELECT id, channel_id, user_id, username, content, created_at FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT 50'
    )
    .all(req.params.id);
  res.json(rows.reverse());
});

// ---------- REPORTS (denúncia manual) ----------

app.post('/api/reports', requireAuth, (req, res) => {
  const { message_id, reported_user_id, reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'Motivo da denúncia é obrigatório' });
  const id = uuidv4();
  db.prepare(
    'INSERT INTO reports (id, message_id, reported_user_id, reporter_user_id, reason) VALUES (?, ?, ?, ?, ?)'
  ).run(id, message_id || null, reported_user_id || null, req.user.id, reason);
  res.json({ ok: true, id });
});

// ---------- ADMIN ----------

app.get('/api/admin/reports', requireAuth, requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM reports ORDER BY created_at DESC').all());
});

app.post('/api/admin/reports/:id/resolve', requireAuth, requireAdmin, (req, res) => {
  const { status } = req.body || {};
  db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(status || 'resolvido', req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/flagged-messages', requireAuth, requireAdmin, (req, res) => {
  res.json(
    db.prepare('SELECT * FROM messages WHERE flagged = 1 ORDER BY created_at DESC LIMIT 200').all()
  );
});

app.get('/api/admin/blocked-messages', requireAuth, requireAdmin, (req, res) => {
  res.json(
    db.prepare('SELECT * FROM blocked_messages ORDER BY created_at DESC LIMIT 200').all()
  );
});

app.post('/api/admin/users/:id/ban', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/unban', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET is_banned = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  res.json(
    db.prepare('SELECT id, username, is_admin, is_banned, created_at FROM users ORDER BY created_at DESC').all()
  );
});

// ---------- SOCKET.IO: chat + sinalização WebRTC ----------

io.use((socket, next) => {
  // O cliente busca /api/me (autenticado via cookie de sessão) antes de conectar
  // e envia o userId no handshake. Aqui revalidamos esse userId contra o banco.
  try {
    const userId = socket.handshake.auth && socket.handshake.auth.userId;
    if (!userId) return next(new Error('userId ausente no handshake'));
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || user.is_banned) return next(new Error('Usuário inválido ou banido'));
    socket.user = user;
    next();
  } catch (err) {
    next(err);
  }
});

// Limite simples de mensagens por socket, pra evitar flood/spam (não é
// proteção contra ataque coordenado sério, mas cobre o caso comum).
const MESSAGE_RATE_LIMIT = 8; // mensagens
const MESSAGE_RATE_WINDOW_MS = 10 * 1000;
const messageTimestamps = new Map(); // socket.id -> array de timestamps

function isRateLimited(socketId) {
  const now = Date.now();
  const timestamps = (messageTimestamps.get(socketId) || []).filter(
    (t) => now - t < MESSAGE_RATE_WINDOW_MS
  );
  timestamps.push(now);
  messageTimestamps.set(socketId, timestamps);
  return timestamps.length > MESSAGE_RATE_LIMIT;
}

// Presença global de quem está em cada sala de voz (roomId -> Map(socketId -> username)),
// transmitida pra TODO MUNDO (não só pra quem já está na sala) — é assim que
// dá pra mostrar "quem está na call" embaixo do nome do canal no menu, igual Discord.
const voiceRooms = new Map();

function voiceStateSnapshot() {
  const snapshot = {};
  for (const [roomId, participants] of voiceRooms.entries()) {
    snapshot[roomId] = [...participants.values()];
  }
  return snapshot;
}

function broadcastVoiceRoom(roomId) {
  const participants = voiceRooms.has(roomId) ? [...voiceRooms.get(roomId).values()] : [];
  io.emit('voice:update', { roomId, participants });
}

function removeFromAllVoiceRooms(socketId) {
  for (const [roomId, participants] of voiceRooms.entries()) {
    if (participants.delete(socketId)) broadcastVoiceRoom(roomId);
  }
}

io.on('connection', (socket) => {
  const user = socket.user;

  socket.emit('voice:state', voiceStateSnapshot());

  socket.on('disconnect', () => {
    messageTimestamps.delete(socket.id);
    removeFromAllVoiceRooms(socket.id);
  });

  socket.on('channel:join', (channelId) => {
    socket.join(channelId);
    socket.to(channelId).emit('presence:join', { userId: user.id, username: user.username });
  });

  socket.on('channel:leave', (channelId) => {
    socket.leave(channelId);
    socket.to(channelId).emit('presence:leave', { userId: user.id, username: user.username });
  });

  socket.on('chat:message', ({ channelId, content }) => {
    if (!channelId || !content || typeof content !== 'string' || !content.trim()) return;
    if (content.length > 2000) {
      socket.emit('chat:blocked', { reason: 'Mensagem muito longa (limite: 2000 caracteres).', categories: [] });
      return;
    }
    if (isRateLimited(socket.id)) {
      socket.emit('chat:blocked', { reason: 'Você está enviando mensagens rápido demais. Aguarde um pouco.', categories: [] });
      return;
    }

    const scan = scanText(content);
    if (scan.block) {
      // Mensagem bloqueada: não é enviada aos outros usuários, mas fica
      // registrada em log de auditoria para revisão de um admin (nunca é
      // simplesmente descartada em silêncio).
      const blockedId = uuidv4();
      db.prepare(
        'INSERT INTO blocked_messages (id, channel_id, user_id, username, content, flag_categories) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(blockedId, channelId, user.id, user.username, content, JSON.stringify(scan.categories));

      socket.emit('chat:blocked', {
        reason: 'Mensagem bloqueada pelo filtro de conteúdo e registrada para revisão de um moderador.',
        categories: scan.categories,
      });
      return;
    }

    const id = uuidv4();
    db.prepare(
      'INSERT INTO messages (id, channel_id, user_id, username, content, flagged, flag_categories) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, channelId, user.id, user.username, content, scan.flagged ? 1 : 0, JSON.stringify(scan.categories));

    const payload = {
      id,
      channel_id: channelId,
      user_id: user.id,
      username: user.username,
      content,
      created_at: new Date().toISOString(),
    };
    io.to(channelId).emit('chat:message', payload);
  });

  // --- Sinalização WebRTC para voz/vídeo/compartilhamento de tela ---
  // Modelo simples: mesh entre participantes de uma sala de voz.
  socket.on('rtc:join', (roomId) => {
    // Sai de qualquer outra sala de voz antes (só dá pra estar em uma por vez)
    removeFromAllVoiceRooms(socket.id);

    socket.join('rtc:' + roomId);
    socket.to('rtc:' + roomId).emit('rtc:peer-joined', { socketId: socket.id, username: user.username });

    if (!voiceRooms.has(roomId)) voiceRooms.set(roomId, new Map());
    voiceRooms.get(roomId).set(socket.id, { socketId: socket.id, userId: user.id, username: user.username });
    broadcastVoiceRoom(roomId);
  });

  socket.on('rtc:leave', (roomId) => {
    socket.leave('rtc:' + roomId);
    socket.to('rtc:' + roomId).emit('rtc:peer-left', { socketId: socket.id });
    if (voiceRooms.has(roomId)) {
      voiceRooms.get(roomId).delete(socket.id);
      broadcastVoiceRoom(roomId);
    }
  });

  socket.on('rtc:signal', ({ to, data }) => {
    io.to(to).emit('rtc:signal', { from: socket.id, username: user.username, data });
  });

  socket.on('disconnect', () => {
    io.emit('presence:disconnect', { userId: user.id });
  });
});

httpServer.listen(PORT, () => {
  console.log(`NEXT GAME rodando em http://localhost:${PORT}`);
});
