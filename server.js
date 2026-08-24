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

// Envolve handlers async pra erros (ex: banco fora do ar) virarem uma
// resposta 500 normal em vez de derrubar o processo.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error(err);
      res.status(500).json({ error: 'Erro interno do servidor' });
    });
  };
}

async function requireAuth(req, res, next) {
  try {
    if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado' });
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    if (!user || user.is_banned) return res.status(403).json({ error: 'Conta banida ou inválida' });
    req.user = user;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Somente admins' });
  next();
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- BOT DE BOAS-VINDAS/AVISOS ----------
// Um "bot" simples do sistema que posta mensagens automáticas (não é um bot
// de verdade tipo Discord com comandos próprios — é automação de servidor).
const BOT_USER_ID = 'system-bot';
const BOT_USERNAME = 'NEXT GAME Bot';
const WELCOME_CHANNEL_ID = 'gamers-geral';

async function postSystemMessage(channelId, content) {
  try {
    const id = uuidv4();
    await db.run('INSERT INTO messages (id, channel_id, user_id, username, content) VALUES (?, ?, ?, ?, ?)', [
      id,
      channelId,
      BOT_USER_ID,
      BOT_USERNAME,
      content,
    ]);
    io.to(channelId).emit('chat:message', {
      id,
      channel_id: channelId,
      user_id: BOT_USER_ID,
      username: BOT_USERNAME,
      content,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Erro ao postar mensagem do bot:', err);
  }
}

// ---------- AUTH ----------

app.post(
  '/api/register',
  authLimiter,
  asyncHandler(async (req, res) => {
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
    const existingUsername = await db.get('SELECT id FROM users WHERE username = ?', [username]);
    if (existingUsername) return res.status(409).json({ error: 'Usuário já existe' });
    const existingEmail = await db.get('SELECT id FROM users WHERE email = ?', [email]);
    if (existingEmail) return res.status(409).json({ error: 'Já existe uma conta com esse e-mail' });

    const countRow = await db.get('SELECT COUNT(*) as c FROM users');
    const isFirstUser = Number(countRow.c) === 0;
    const id = uuidv4();
    const password_hash = bcrypt.hashSync(password, 10);
    // email_verified fica 1 direto — sem etapa de confirmação por código, o
    // e-mail é salvo só como dado de cadastro (a pedido do usuário).
    await db.run(
      'INSERT INTO users (id, username, password_hash, email, email_verified, is_admin) VALUES (?, ?, ?, ?, 1, ?)',
      [id, username, password_hash, email, isFirstUser ? 1 : 0]
    );

    req.session.userId = id;
    res.json({ id, username, is_admin: isFirstUser ? 1 : 0 });

    postSystemMessage(WELCOME_CHANNEL_ID, `🎉 ${username} acabou de entrar no NEXT GAME! Dê as boas-vindas.`);
  })
);

app.post(
  '/api/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }
    if (user.is_banned) return res.status(403).json({ error: 'Esta conta foi banida' });

    req.session.userId = user.id;
    res.json({ id: user.id, username: user.username, is_admin: user.is_admin });
  })
);

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get(
  '/api/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    // Total de mensagens enviadas (histórico completo), usado só pra calcular
    // um "nível" divertido no perfil — não é uma métrica séria de nada.
    const countRow = await db.get('SELECT COUNT(*) as c FROM messages WHERE user_id = ? AND deleted = 0', [
      req.user.id,
    ]);
    res.json({
      id: req.user.id,
      username: req.user.username,
      is_admin: req.user.is_admin,
      email: req.user.email,
      status_message: req.user.status_message,
      avatar: req.user.avatar,
      message_count: Number(countRow.c),
    });
  })
);

// Editar perfil: trocar senha (exige senha atual), e-mail, status "jogando" e/ou avatar.
app.patch(
  '/api/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { email, password, currentPassword, status_message, avatar } = req.body || {};

    if (password) {
      if (!currentPassword || !bcrypt.compareSync(currentPassword, req.user.password_hash)) {
        return res.status(401).json({ error: 'Senha atual incorreta' });
      }
      if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
        return res.status(400).json({ error: 'Nova senha precisa ter 6-200 caracteres' });
      }
      const newHash = bcrypt.hashSync(password, 10);
      await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.user.id]);
    }

    if (email && email !== req.user.email) {
      if (!currentPassword || !bcrypt.compareSync(currentPassword, req.user.password_hash)) {
        return res.status(401).json({ error: 'Senha atual incorreta' });
      }
      if (!EMAIL_REGEX.test(email) || email.length > 200) {
        return res.status(400).json({ error: 'E-mail inválido' });
      }
      const existingEmail = await db.get('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.user.id]);
      if (existingEmail) return res.status(409).json({ error: 'Já existe uma conta com esse e-mail' });

      await db.run('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?', [email, req.user.id]);
    }

    if (typeof status_message === 'string') {
      if (status_message.length > 60) {
        return res.status(400).json({ error: 'Status "jogando" precisa ter no máximo 60 caracteres' });
      }
      await db.run('UPDATE users SET status_message = ? WHERE id = ?', [status_message.trim() || null, req.user.id]);
    }

    if (typeof avatar === 'string') {
      // Aceita tanto uma imagem em base64 (data URL) quanto vazio (remover avatar).
      // Limite de tamanho pra não inchar o banco com imagens gigantes.
      if (avatar.length > 350000) {
        return res.status(400).json({ error: 'Imagem muito grande — escolha uma menor' });
      }
      if (avatar && !avatar.startsWith('data:image/') && !avatar.startsWith('emoji:')) {
        return res.status(400).json({ error: 'Formato de avatar inválido' });
      }
      await db.run('UPDATE users SET avatar = ? WHERE id = ?', [avatar || null, req.user.id]);
    }

    const updated = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json({
      ok: true,
      status_message: updated.status_message,
      avatar: updated.avatar,
    });
  })
);

// ---------- CHANNELS ----------

app.get(
  '/api/channels',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await db.all('SELECT * FROM channels ORDER BY category, type, name'));
  })
);

// Qualquer usuário logado pode criar uma sala nova. Se a "categoria" (nome do
// servidor/comunidade) informada ainda não existir, ela é criada na hora —
// é assim que usuários criam servidores próprios (ex: "Valorant", "Minecraft").
app.post(
  '/api/channels',
  requireAuth,
  asyncHandler(async (req, res) => {
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

    await db.run('INSERT INTO channels (id, name, category, type, created_by) VALUES (?, ?, ?, ?, ?)', [
      id,
      cleanName,
      cleanCategory,
      type,
      req.user.id,
    ]);

    res.json({ id, name: cleanName, category: cleanCategory, type });
  })
);

// Informações/regras do servidor (categoria) — igual tela de boas-vindas do Discord.
app.get(
  '/api/servers/:category',
  requireAuth,
  asyncHandler(async (req, res) => {
    const info = await db.get('SELECT * FROM servers WHERE category = ?', [req.params.category]);
    res.json(info || { category: req.params.category, description: null, rules: null });
  })
);

app.patch(
  '/api/servers/:category',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { description, rules } = req.body || {};
    if ((description && description.length > 500) || (rules && rules.length > 2000)) {
      return res.status(400).json({ error: 'Descrição (máx. 500) ou regras (máx. 2000) muito longas' });
    }
    await db.run(
      `INSERT INTO servers (category, description, rules, updated_by, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(category) DO UPDATE SET description = excluded.description, rules = excluded.rules, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [req.params.category, description || null, rules || null, req.user.id]
    );
    res.json({ ok: true });
  })
);

// ---------- TORNEIOS ----------

app.get(
  '/api/tournaments',
  requireAuth,
  asyncHandler(async (req, res) => {
    const category = req.query.category;
    const tournaments = category
      ? await db.all('SELECT * FROM tournaments WHERE category = ? ORDER BY event_date IS NULL, event_date ASC', [category])
      : await db.all('SELECT * FROM tournaments ORDER BY event_date IS NULL, event_date ASC');

    if (tournaments.length > 0) {
      const ids = tournaments.map((t) => t.id);
      const placeholders = ids.map(() => '?').join(',');
      const regRows = await db.all(
        `SELECT tournament_id, user_id, team_name FROM tournament_registrations WHERE tournament_id IN (${placeholders})`,
        ids
      );
      tournaments.forEach((t) => {
        const regs = regRows.filter((r) => r.tournament_id === t.id);
        t.registered_count = regs.length;
        t.is_registered = regs.some((r) => r.user_id === req.user.id);
      });
    }
    res.json(tournaments);
  })
);

app.post(
  '/api/tournaments',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { category, name, game, event_date, prize, max_slots } = req.body || {};
    if (!category || !name || !game || !String(name).trim() || !String(game).trim()) {
      return res.status(400).json({ error: 'Categoria, nome e jogo são obrigatórios' });
    }
    const id = uuidv4();
    await db.run(
      'INSERT INTO tournaments (id, category, name, game, event_date, prize, max_slots, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        category,
        String(name).trim().slice(0, 80),
        String(game).trim().slice(0, 40),
        event_date || null,
        (prize || '').slice(0, 60) || null,
        Math.min(Math.max(Number(max_slots) || 32, 2), 500),
        req.user.id,
      ]
    );
    res.json({ id });
  })
);

app.delete(
  '/api/tournaments/:id',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    await db.run('DELETE FROM tournament_registrations WHERE tournament_id = ?', [req.params.id]);
    await db.run('DELETE FROM tournaments WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  })
);

app.post(
  '/api/tournaments/:id/register',
  requireAuth,
  asyncHandler(async (req, res) => {
    const tournament = await db.get('SELECT * FROM tournaments WHERE id = ?', [req.params.id]);
    if (!tournament) return res.status(404).json({ error: 'Torneio não encontrado' });
    const countRow = await db.get('SELECT COUNT(*) as c FROM tournament_registrations WHERE tournament_id = ?', [
      req.params.id,
    ]);
    if (Number(countRow.c) >= tournament.max_slots) {
      return res.status(400).json({ error: 'Torneio lotado' });
    }
    try {
      await db.run('INSERT INTO tournament_registrations (id, tournament_id, user_id, team_name) VALUES (?, ?, ?, ?)', [
        uuidv4(),
        req.params.id,
        req.user.id,
        req.body && req.body.team_name ? String(req.body.team_name).slice(0, 40) : null,
      ]);
    } catch (err) {
      return res.status(409).json({ error: 'Você já está inscrito nesse torneio' });
    }
    res.json({ ok: true });
  })
);

app.post(
  '/api/tournaments/:id/unregister',
  requireAuth,
  asyncHandler(async (req, res) => {
    await db.run('DELETE FROM tournament_registrations WHERE tournament_id = ? AND user_id = ?', [
      req.params.id,
      req.user.id,
    ]);
    res.json({ ok: true });
  })
);

// ---------- RANKING SEMANAL (baseado em atividade real: mensagens enviadas) ----------

app.get(
  '/api/ranking',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      `SELECT u.id, u.username, u.avatar, COUNT(m.id) as points
       FROM users u
       JOIN messages m ON m.user_id = u.id
       WHERE m.created_at >= datetime('now', '-7 days') AND m.deleted = 0
       GROUP BY u.id
       ORDER BY points DESC
       LIMIT 10`
    );
    res.json(rows);
  })
);

// Feed de atividade recente pra tela de início (mensagens reais de todos os
// canais, sem as bloqueadas/apagadas).
app.get(
  '/api/activity',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      `SELECT m.id, m.channel_id, m.user_id, m.username, m.content, m.created_at, c.name as channel_name, c.category
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       WHERE m.deleted = 0 AND m.user_id != 'system-bot'
       ORDER BY m.created_at DESC
       LIMIT 15`
    );
    res.json(rows);
  })
);

// Estatísticas gerais da plataforma pra tela de início.
app.get(
  '/api/stats',
  // Sem requireAuth de propósito: são só contagens (nada pessoal), usadas
  // também na landing pública antes do login.
  asyncHandler(async (req, res) => {
    const [users, servers, tournaments] = await Promise.all([
      db.get('SELECT COUNT(*) as c FROM users WHERE is_banned = 0'),
      db.get('SELECT COUNT(DISTINCT category) as c FROM channels'),
      db.get('SELECT COUNT(*) as c FROM tournaments'),
    ]);
    res.json({
      members: Number(users.c),
      servers: Number(servers.c),
      tournaments: Number(tournaments.c),
    });
  })
);

app.get(
  '/api/channels/:id/messages',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      'SELECT id, channel_id, user_id, username, content, edited, created_at FROM messages WHERE channel_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 50',
      [req.params.id]
    );
    const messages = rows.reverse();
    if (messages.length > 0) {
      const ids = messages.map((m) => m.id);
      const placeholders = ids.map(() => '?').join(',');
      const reactionRows = await db.all(
        `SELECT message_id, user_id, emoji FROM message_reactions WHERE message_id IN (${placeholders})`,
        ids
      );
      const byMessage = {};
      reactionRows.forEach((r) => {
        if (!byMessage[r.message_id]) byMessage[r.message_id] = {};
        if (!byMessage[r.message_id][r.emoji]) byMessage[r.message_id][r.emoji] = { emoji: r.emoji, count: 0, reacted: false };
        byMessage[r.message_id][r.emoji].count++;
        if (r.user_id === req.user.id) byMessage[r.message_id][r.emoji].reacted = true;
      });
      messages.forEach((m) => {
        m.reactions = byMessage[m.id] ? Object.values(byMessage[m.id]) : [];
      });
    }
    res.json(messages);
  })
);

// Lista pública de usuários (pra painel de membros) — status online é
// combinado no cliente com o que chega em tempo real via socket.
app.get(
  '/api/users',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(
      await db.all(
        'SELECT id, username, avatar, status_message, is_admin FROM users WHERE is_banned = 0 ORDER BY username'
      )
    );
  })
);

// ---------- REPORTS (denúncia manual) ----------

app.post(
  '/api/reports',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { message_id, reported_user_id, reason } = req.body || {};
    if (!reason) return res.status(400).json({ error: 'Motivo da denúncia é obrigatório' });
    const id = uuidv4();
    await db.run(
      'INSERT INTO reports (id, message_id, reported_user_id, reporter_user_id, reason) VALUES (?, ?, ?, ?, ?)',
      [id, message_id || null, reported_user_id || null, req.user.id, reason]
    );
    res.json({ ok: true, id });
  })
);

// ---------- ADMIN ----------

app.get(
  '/api/admin/reports',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await db.all('SELECT * FROM reports ORDER BY created_at DESC'));
  })
);

app.post(
  '/api/admin/reports/:id/resolve',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { status } = req.body || {};
    await db.run('UPDATE reports SET status = ? WHERE id = ?', [status || 'resolvido', req.params.id]);
    res.json({ ok: true });
  })
);

app.get(
  '/api/admin/flagged-messages',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await db.all('SELECT * FROM messages WHERE flagged = 1 ORDER BY created_at DESC LIMIT 200'));
  })
);

app.get(
  '/api/admin/blocked-messages',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await db.all('SELECT * FROM blocked_messages ORDER BY created_at DESC LIMIT 200'));
  })
);

app.post(
  '/api/admin/users/:id/ban',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    await db.run('UPDATE users SET is_banned = 1 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
    const banned = await db.get('SELECT username FROM users WHERE id = ?', [req.params.id]);
    if (banned) postSystemMessage(WELCOME_CHANNEL_ID, `🔨 ${banned.username} foi banido(a) por um moderador.`);
  })
);

app.post(
  '/api/admin/users/:id/unban',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    await db.run('UPDATE users SET is_banned = 0 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  })
);

app.get(
  '/api/admin/users',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await db.all('SELECT id, username, is_admin, is_banned, created_at FROM users ORDER BY created_at DESC'));
  })
);

// ---------- SOCKET.IO: chat + sinalização WebRTC ----------

io.use(async (socket, next) => {
  // O cliente busca /api/me (autenticado via cookie de sessão) antes de conectar
  // e envia o userId no handshake. Aqui revalidamos esse userId contra o banco.
  try {
    const userId = socket.handshake.auth && socket.handshake.auth.userId;
    if (!userId) return next(new Error('userId ausente no handshake'));
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
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

// Presença online global (quem está com o site aberto, em qualquer tela) —
// userId -> quantidade de conexões abertas (várias abas contam como 1 online).
const onlineUsers = new Map();

function broadcastOnlineUsers() {
  io.emit('presence:online', [...onlineUsers.keys()]);
}

io.on('connection', (socket) => {
  const user = socket.user;

  socket.emit('voice:state', voiceStateSnapshot());

  onlineUsers.set(user.id, (onlineUsers.get(user.id) || 0) + 1);
  broadcastOnlineUsers();
  socket.emit('presence:online', [...onlineUsers.keys()]);

  socket.on('disconnect', () => {
    messageTimestamps.delete(socket.id);
    removeFromAllVoiceRooms(socket.id);
    const count = (onlineUsers.get(user.id) || 1) - 1;
    if (count <= 0) onlineUsers.delete(user.id);
    else onlineUsers.set(user.id, count);
    broadcastOnlineUsers();
  });

  socket.on('channel:join', (channelId) => {
    socket.join(channelId);
    socket.to(channelId).emit('presence:join', { userId: user.id, username: user.username });
  });

  socket.on('channel:leave', (channelId) => {
    socket.leave(channelId);
    socket.to(channelId).emit('presence:leave', { userId: user.id, username: user.username });
  });

  socket.on('chat:message', async ({ channelId, content }) => {
    try {
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
        await db.run(
          'INSERT INTO blocked_messages (id, channel_id, user_id, username, content, flag_categories) VALUES (?, ?, ?, ?, ?, ?)',
          [blockedId, channelId, user.id, user.username, content, JSON.stringify(scan.categories)]
        );

        socket.emit('chat:blocked', {
          reason: 'Mensagem bloqueada pelo filtro de conteúdo e registrada para revisão de um moderador.',
          categories: scan.categories,
        });
        return;
      }

      const id = uuidv4();
      await db.run(
        'INSERT INTO messages (id, channel_id, user_id, username, content, flagged, flag_categories) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, channelId, user.id, user.username, content, scan.flagged ? 1 : 0, JSON.stringify(scan.categories)]
      );

      const payload = {
        id,
        channel_id: channelId,
        user_id: user.id,
        username: user.username,
        content,
        created_at: new Date().toISOString(),
      };
      io.to(channelId).emit('chat:message', payload);
    } catch (err) {
      console.error('Erro ao processar chat:message:', err);
    }
  });

  // Editar mensagem própria (passa pelo mesmo filtro de moderação)
  socket.on('chat:edit', async ({ messageId, content }) => {
    try {
      if (!messageId || !content || typeof content !== 'string' || !content.trim()) return;
      if (content.length > 2000) return;
      const msg = await db.get('SELECT * FROM messages WHERE id = ?', [messageId]);
      if (!msg || msg.user_id !== user.id || msg.deleted) return;

      const scan = scanText(content);
      if (scan.block) {
        socket.emit('chat:blocked', {
          reason: 'Edição bloqueada pelo filtro de conteúdo.',
          categories: scan.categories,
        });
        return;
      }

      await db.run('UPDATE messages SET content = ?, edited = 1, flagged = ?, flag_categories = ? WHERE id = ?', [
        content,
        scan.flagged ? 1 : 0,
        JSON.stringify(scan.categories),
        messageId,
      ]);
      io.to(msg.channel_id).emit('chat:edited', { id: messageId, content, channel_id: msg.channel_id });
    } catch (err) {
      console.error('Erro ao processar chat:edit:', err);
    }
  });

  // Apagar mensagem (dono da mensagem ou admin)
  socket.on('chat:delete', async ({ messageId }) => {
    try {
      const msg = await db.get('SELECT * FROM messages WHERE id = ?', [messageId]);
      if (!msg) return;
      if (msg.user_id !== user.id && !user.is_admin) return;
      await db.run('UPDATE messages SET deleted = 1 WHERE id = ?', [messageId]);
      io.to(msg.channel_id).emit('chat:deleted', { id: messageId, channel_id: msg.channel_id });
    } catch (err) {
      console.error('Erro ao processar chat:delete:', err);
    }
  });

  // Reagir com emoji (clicar de novo no mesmo emoji remove a reação)
  socket.on('chat:react', async ({ messageId, emoji }) => {
    try {
      if (!messageId || !emoji || typeof emoji !== 'string' || emoji.length > 8) return;
      const msg = await db.get('SELECT * FROM messages WHERE id = ?', [messageId]);
      if (!msg || msg.deleted) return;

      const existing = await db.get(
        'SELECT id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
        [messageId, user.id, emoji]
      );
      if (existing) {
        await db.run('DELETE FROM message_reactions WHERE id = ?', [existing.id]);
      } else {
        await db.run('INSERT INTO message_reactions (id, message_id, user_id, emoji) VALUES (?, ?, ?, ?)', [
          uuidv4(),
          messageId,
          user.id,
          emoji,
        ]);
      }

      const rows = await db.all('SELECT user_id, emoji FROM message_reactions WHERE message_id = ?', [messageId]);
      const grouped = {};
      rows.forEach((r) => {
        if (!grouped[r.emoji]) grouped[r.emoji] = { emoji: r.emoji, count: 0, users: [] };
        grouped[r.emoji].count++;
        grouped[r.emoji].users.push(r.user_id);
      });
      io.to(msg.channel_id).emit('chat:reactions', {
        messageId,
        channel_id: msg.channel_id,
        reactions: Object.values(grouped),
      });
    } catch (err) {
      console.error('Erro ao processar chat:react:', err);
    }
  });

  // Indicador de "digitando..." — só retransmite, não salva nada.
  socket.on('typing:start', (channelId) => {
    if (!channelId) return;
    socket.to(channelId).emit('typing:update', { userId: user.id, username: user.username, typing: true });
  });
  socket.on('typing:stop', (channelId) => {
    if (!channelId) return;
    socket.to(channelId).emit('typing:update', { userId: user.id, username: user.username, typing: false });
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
    socket.to('rtc:' + roomId).emit('rtc:peer-left', { socketId: socket.id, username: user.username });
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

async function main() {
  await db.initDb();
  httpServer.listen(PORT, () => {
    console.log(`NEXT GAME rodando em http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Erro ao iniciar o servidor:', err);
  process.exit(1);
});
