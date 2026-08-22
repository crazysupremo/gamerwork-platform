// server.js - servidor principal
const path = require('path');
const express = require('express');
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
const SESSION_SECRET = process.env.SESSION_SECRET || 'troque-este-segredo-antes-de-ir-para-producao';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  cookieSession({
    name: 'session',
    keys: [SESSION_SECRET],
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })
);

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

// ---------- AUTH ----------

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: 'Usuário (min 3) e senha (min 6) são obrigatórios' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Usuário já existe' });

  const isFirstUser = db.prepare('SELECT COUNT(*) as c FROM users').get().c === 0;
  const id = uuidv4();
  const password_hash = bcrypt.hashSync(password, 10);
  db.prepare(
    'INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)'
  ).run(id, username, password_hash, isFirstUser ? 1 : 0);

  req.session.userId = id;
  res.json({ id, username, is_admin: isFirstUser ? 1 : 0 });
});

app.post('/api/login', (req, res) => {
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
  res.json({ id: req.user.id, username: req.user.username, is_admin: req.user.is_admin });
});

// ---------- CHANNELS ----------

app.get('/api/channels', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM channels ORDER BY category, type, name').all());
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

io.on('connection', (socket) => {
  const user = socket.user;

  socket.on('channel:join', (channelId) => {
    socket.join(channelId);
    socket.to(channelId).emit('presence:join', { userId: user.id, username: user.username });
  });

  socket.on('channel:leave', (channelId) => {
    socket.leave(channelId);
    socket.to(channelId).emit('presence:leave', { userId: user.id, username: user.username });
  });

  socket.on('chat:message', ({ channelId, content }) => {
    if (!channelId || !content || !content.trim()) return;

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
    socket.join('rtc:' + roomId);
    socket.to('rtc:' + roomId).emit('rtc:peer-joined', { socketId: socket.id, username: user.username });
  });

  socket.on('rtc:leave', (roomId) => {
    socket.leave('rtc:' + roomId);
    socket.to('rtc:' + roomId).emit('rtc:peer-left', { socketId: socket.id });
  });

  socket.on('rtc:signal', ({ to, data }) => {
    io.to(to).emit('rtc:signal', { from: socket.id, username: user.username, data });
  });

  socket.on('disconnect', () => {
    io.emit('presence:disconnect', { userId: user.id });
  });
});

httpServer.listen(PORT, () => {
  console.log(`GamerWork rodando em http://localhost:${PORT}`);
});
