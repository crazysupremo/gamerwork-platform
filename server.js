// server.js - servidor principal
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { createServer } = require('http');
const { Server } = require('socket.io');

const db = require('./db');
const { AI_BOT_USER_ID, AI_BOT_USERNAME } = require('./db');
const { scanText } = require('./moderation');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');

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

// Cada login/registro cria uma linha em user_sessions, além do cookie
// assinado de sempre — é o que permite listar "sessões ativas" de verdade e
// derrubar um dispositivo remotamente (revoked=1), coisa que um cookie
// sozinho (sem estado no servidor) não permitiria fazer.
async function createUserSession(userId, req) {
  const id = uuidv4();
  await db.run('INSERT INTO user_sessions (id, user_id, user_agent, ip) VALUES (?, ?, ?, ?)', [
    id,
    userId,
    String(req.headers['user-agent'] || '').slice(0, 300),
    req.ip || '',
  ]);
  return id;
}

async function requireAuth(req, res, next) {
  try {
    if (!req.session.userId || !req.session.sessionId) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    if (!user || user.is_banned) return res.status(403).json({ error: 'Conta banida ou inválida' });
    const sessionRow = await db.get('SELECT * FROM user_sessions WHERE id = ? AND user_id = ?', [
      req.session.sessionId,
      user.id,
    ]);
    if (!sessionRow || sessionRow.revoked) {
      return res.status(401).json({ error: 'Sua sessão foi encerrada — faça login de novo' });
    }
    // Atualiza "visto por último" sem travar a resposta nisso.
    db.run("UPDATE user_sessions SET last_seen_at = datetime('now') WHERE id = ?", [sessionRow.id]).catch(() => {});
    req.user = user;
    req.currentSessionId = sessionRow.id;
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

// Tokens temporários pra segunda etapa do login com 2FA — vivem só na
// memória do processo (não precisam persistir, expiram sozinhos em minutos).
const pending2FALogins = new Map(); // tempToken -> { userId, expires }
const PENDING_2FA_TTL_MS = 5 * 60 * 1000;
function createPending2FAToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  pending2FALogins.set(token, { userId, expires: Date.now() + PENDING_2FA_TTL_MS });
  return token;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- SERVIDORES: DONO, MEMBROS, CARGOS E PERMISSÕES ----------
// Cada "servidor" (identificado pelo nome da categoria, igual sempre foi)
// agora tem um dono e uma lista de membros — só quem foi convidado/entrou
// consegue ver e participar, igual Discord. Cargos dão permissões
// específicas dentro daquele servidor; o dono sempre tem todas.
const SERVER_PERMISSIONS = [
  { key: 'manage_server', label: 'Gerenciar servidor (nome, ícone, descrição)' },
  { key: 'manage_channels', label: 'Gerenciar canais (criar/excluir salas)' },
  { key: 'manage_roles', label: 'Gerenciar cargos' },
  { key: 'kick_members', label: 'Expulsar membros' },
  { key: 'mute_members', label: 'Mutar/ensurdecer membros na call' },
];
const SERVER_PERMISSION_KEYS = SERVER_PERMISSIONS.map((p) => p.key);

function generateInviteCode() {
  return crypto.randomBytes(5).toString('hex');
}

async function isServerMember(category, userId) {
  const row = await db.get('SELECT id FROM server_members WHERE category = ? AND user_id = ?', [category, userId]);
  return !!row;
}

// Dono tem tudo. Nos dois servidores padrão sem dono (gamers/trabalho),
// qualquer membro pode criar salas — é o comportamento histórico dessas
// duas comunidades públicas iniciais. Fora isso, permissão vem dos cargos.
async function getServerPermissions(category, userId) {
  const server = await db.get('SELECT owner_id FROM servers WHERE category = ?', [category]);
  if (!server) return new Set();
  if (server.owner_id === userId) return new Set(SERVER_PERMISSION_KEYS);
  if (!server.owner_id) return new Set(['manage_channels']);

  const roles = await db.all(
    `SELECT r.permissions FROM server_member_roles smr
     JOIN server_roles r ON r.id = smr.role_id
     WHERE smr.category = ? AND smr.user_id = ?`,
    [category, userId]
  );
  const perms = new Set();
  roles.forEach((r) => {
    try {
      JSON.parse(r.permissions).forEach((p) => perms.add(p));
    } catch (_) {}
  });
  return perms;
}

// Site admins (o painel /admin.html) sempre podem gerenciar qualquer
// servidor, pra fins de moderação — além do dono e de quem tem o cargo certo.
async function hasServerPermission(category, user, permission) {
  if (user.is_admin) return true;
  const perms = await getServerPermissions(category, user.id);
  return perms.has(permission);
}

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

// ---------- RECOMPENSAS / STREAK DE ACESSO ----------
// Catálogo fixo (não precisa de tabela própria pra isso, só pros
// desbloqueios de cada usuário, que ficam em user_rewards).
const REWARDS_CATALOG = [
  {
    key: 'starter',
    name: 'Primeiros Passos',
    description: 'Criar sua conta no NEXT GAME',
    frame: 'rainbow',
    type: 'account',
  },
  {
    key: 'week',
    name: 'Ativo',
    description: '7 dias seguidos acessando',
    frame: 'sparkle',
    type: 'streak',
    days: 7,
  },
  {
    key: 'month',
    name: 'Dedicado',
    description: '30 dias seguidos acessando',
    frame: 'fire',
    type: 'streak',
    days: 30,
  },
  {
    key: 'seal90',
    name: 'Selo Membro Exclusivo',
    description: '90 dias seguidos acessando — selo redondo oficial, auditável',
    frame: 'legend',
    type: 'streak',
    days: 90,
    rare: true,
    image: '/assets/seal-90.png',
  },
  {
    key: 'seal120',
    name: 'Selo Membro Lendário',
    description: '120 dias seguidos acessando — selo oficial com seu nome, auditável',
    frame: 'diamond',
    type: 'streak',
    days: 120,
    rare: true,
    image: '/assets/seal-120.png',
    hasName: true,
  },
  {
    key: 'founder-eternal',
    name: 'Fundador Eterno',
    description: '365 dias seguidos acessando — selo exclusivo, só para as 2 primeiras pessoas que chegarem lá',
    frame: 'eternal',
    type: 'streak',
    days: 365,
    rare: true,
    limitedSlots: 2,
    image: '/assets/seal-founder.png',
  },
];

// Catálogo de missões: cada uma libera num marco de dias de sequência e vale
// pontos se a pessoa acertar TODAS as perguntas do quiz sobre o NEXT GAME.
const MISSIONS_CATALOG = [
  {
    key: 'quiz_week',
    name: 'Quiz: Primeiros Passos',
    description: 'Disponível após 7 dias seguidos de acesso',
    unlockDays: 7,
    points: 10,
    questions: [
      { q: 'Qual ícone abre a Loja de Recompensas na barra de cima?', options: ['🔔 Sino', '🎁 Presente', '🔍 Lupa', '⚙️ Engrenagem'], correct: 1 },
      { q: 'O que acontece se você ficar um dia inteiro sem acessar o NEXT GAME?', options: ['Nada muda', 'Sua sequência de dias reinicia', 'Sua conta é banida', 'Você ganha pontos extra'], correct: 1 },
      { q: 'Como você cria uma nova sala de texto ou voz?', options: ['Só admins podem criar', 'Clicando no + do menu lateral', 'Mandando e-mail pro suporte', 'Não é possível criar salas'], correct: 1 },
    ],
  },
  {
    key: 'quiz_month',
    name: 'Quiz: Um Mês de NEXT GAME',
    description: 'Disponível após 30 dias seguidos de acesso',
    unlockDays: 30,
    points: 15,
    questions: [
      { q: 'Qual moldura de avatar você ganha ao completar 30 dias seguidos?', options: ['Rainbow', 'Sparkle', 'Fire', 'Legend'], correct: 2 },
      { q: 'Pra que serve o código de verificação de um selo?', options: ['É só um enfeite', 'Prova pública e auditável de que você desbloqueou aquela recompensa', 'Uma senha secreta', 'Um erro do sistema'], correct: 1 },
      { q: 'Onde você vê quem está jogando o quê agora, em tempo real?', options: ['No painel de Início, em "Jogando Agora"', 'Não dá pra ver', 'Só no perfil de cada um', 'Na tela de login'], correct: 0 },
    ],
  },
  {
    key: 'quiz_two_months',
    name: 'Quiz: Dois Meses de Dedicação',
    description: 'Disponível após 60 dias seguidos de acesso',
    unlockDays: 60,
    points: 20,
    questions: [
      { q: 'Pra que serve o botão 🔊/🔇 na barra de cima?', options: ['Mutar o microfone', 'Ligar/desligar todos os sons e efeitos do site', 'Ativar modo escuro', 'Sair da conta'], correct: 1 },
      { q: 'O que acontece quando alguém começa a compartilhar a tela numa call?', options: ['Nada muda no layout', 'A tela de quem compartilha fica em destaque (spotlight)', 'A call é encerrada', 'Só quem compartilha consegue ver'], correct: 1 },
      { q: 'Como funciona a verificação pública de um selo?', options: ['Precisa ser admin', 'Qualquer pessoa pode conferir o código, sem precisar de login', 'Só funciona uma vez', 'É automática, ninguém precisa verificar'], correct: 1 },
    ],
  },
  {
    key: 'quiz_seal90',
    name: 'Quiz: Rumo ao Selo de 90 Dias',
    description: 'Disponível após 90 dias seguidos de acesso',
    unlockDays: 90,
    points: 25,
    questions: [
      { q: 'Quantos dias seguidos são precisos pro Selo Membro Exclusivo (redondo)?', options: ['30', '60', '90', '120'], correct: 2 },
      { q: 'E pro Selo Membro Lendário (em faixa, com seu nome)?', options: ['90 dias', '100 dias', '120 dias', '365 dias'], correct: 2 },
      { q: 'O selo raro de 1 ano é limitado a quantas pessoas no total?', options: ['Sem limite', '10', '2', '100'], correct: 2 },
    ],
  },
  {
    key: 'quiz_seal120',
    name: 'Quiz: Rumo ao Selo de 120 Dias',
    description: 'Disponível após 120 dias seguidos de acesso',
    unlockDays: 120,
    points: 30,
    questions: [
      { q: 'O que faz sua sequência de dias reiniciar do zero?', options: ['Trocar de avatar', 'Ficar um dia sem acessar o NEXT GAME', 'Enviar muitas mensagens', 'Entrar numa call de voz'], correct: 1 },
      { q: 'Pra valer os pontos, o que uma missão exige?', options: ['Acertar pelo menos uma pergunta', 'Acertar TODAS as perguntas do quiz', 'Só abrir a missão', 'Pagar com dinheiro real'], correct: 1 },
      { q: 'Pra que serve o painel de Início (dashboard)?', options: ['Só mostra propaganda', 'Mostra servidores em destaque, quem está jogando, atividade recente e mais', 'É a tela de configurações', 'Só admins acessam'], correct: 1 },
    ],
  },
  {
    key: 'quiz_veteran',
    name: 'Quiz: Veterano NEXT GAME',
    description: 'Disponível após 180 dias seguidos de acesso',
    unlockDays: 180,
    points: 40,
    questions: [
      { q: 'Quantos dias seguidos são precisos pro selo exclusivo de Fundador Eterno?', options: ['180', '200', '300', '365'], correct: 3 },
      { q: 'O que torna um selo do NEXT GAME "auditável"?', options: ['A cor dourada', 'Um código público que qualquer um pode verificar', 'O tamanho da imagem', 'Nada, é só decoração'], correct: 1 },
      { q: 'Além do streak de acesso, o que mais rende pontos no NEXT GAME?', options: ['Comprar com dinheiro real', 'Completar as missões de quiz corretamente', 'Nada mais', 'Convidar amigos'], correct: 1 },
    ],
  },
];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

// Gera um código único e verificável (qualquer um pode conferir em
// /api/verify/:code sem precisar estar logado) — é o que torna o selo raro
// "auditável" de verdade, e não só uma imagem qualquer.
function generateVerificationCode(userId, rewardKey) {
  const hash = crypto
    .createHash('sha256')
    .update(`${userId}:${rewardKey}:${Date.now()}:${process.env.SESSION_SECRET || 'ng'}`)
    .digest('hex')
    .slice(0, 10)
    .toUpperCase();
  return `NG-${hash}`;
}

// Atualiza o streak de acesso do usuário e desbloqueia recompensas novas.
// Chamada tanto no registro (conta nova = dia 1) quanto em todo login.
async function updateStreakAndRewards(user) {
  const today = todayStr();
  let streak = user.login_streak || 0;
  let longest = user.longest_streak || 0;

  if (!user.last_login_date) {
    streak = 1;
  } else {
    const diff = daysBetween(user.last_login_date, today);
    if (diff === 0) {
      // já contou hoje, não mexe
    } else if (diff === 1) {
      streak += 1;
    } else {
      streak = 1; // quebrou a sequência
    }
  }
  longest = Math.max(longest, streak);

  await db.run('UPDATE users SET login_streak = ?, longest_streak = ?, last_login_date = ? WHERE id = ?', [
    streak,
    longest,
    today,
    user.id,
  ]);

  // Desbloqueia "Primeiros Passos" sempre (é só ter conta)
  await unlockReward(user.id, 'starter');

  for (const reward of REWARDS_CATALOG) {
    if (reward.type === 'streak' && streak >= reward.days) {
      await unlockReward(user.id, reward.key);
    }
  }

  return { streak, longest };
}

async function unlockReward(userId, rewardKey) {
  const existing = await db.get('SELECT id FROM user_rewards WHERE user_id = ? AND reward_key = ?', [
    userId,
    rewardKey,
  ]);
  if (existing) return;

  // Recompensas de "vagas limitadas" (ex.: só 2 pessoas no mundo) — checa se
  // ainda sobra vaga antes de conceder. Quem chegar depois das vagas
  // esgotadas simplesmente não recebe, mesmo batendo o requisito de dias.
  const catalogEntry = REWARDS_CATALOG.find((r) => r.key === rewardKey);
  if (catalogEntry && catalogEntry.limitedSlots) {
    const countRow = await db.get('SELECT COUNT(*) as c FROM user_rewards WHERE reward_key = ?', [rewardKey]);
    if (Number(countRow.c) >= catalogEntry.limitedSlots) return;
  }

  const code = generateVerificationCode(userId, rewardKey);
  await db.run('INSERT INTO user_rewards (id, user_id, reward_key, verification_code) VALUES (?, ?, ?, ?)', [
    uuidv4(),
    userId,
    rewardKey,
    code,
  ]);
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

    // Não conta o usuário-bot da IA aqui, senão a primeira pessoa de verdade
    // que se cadastra nunca vira admin (o bot já ocupa a "vaga" de primeiro).
    const countRow = await db.get('SELECT COUNT(*) as c FROM users WHERE id != ?', [AI_BOT_USER_ID]);
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
    req.session.sessionId = await createUserSession(id, req);
    res.json({ id, username, is_admin: isFirstUser ? 1 : 0 });

    // Toda conta nova já entra automaticamente nos dois servidores públicos
    // padrão (gamers/trabalho) — servidores criados por outros usuários daqui
    // pra frente são privados e exigem convite.
    for (const category of ['gamers', 'trabalho']) {
      db.run('INSERT OR IGNORE INTO server_members (id, category, user_id) VALUES (?, ?, ?)', [
        uuidv4(),
        category,
        id,
      ]).catch(() => {});
    }

    postSystemMessage(WELCOME_CHANNEL_ID, `🎉 ${username} acabou de entrar no NEXT GAME! Dê as boas-vindas.`);
    updateStreakAndRewards({ id, login_streak: 0, longest_streak: 0, last_login_date: null }).catch(() => {});
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

    // Conta com 2FA ligado: não loga direto — devolve um token temporário
    // que o cliente troca por uma sessão de verdade em /api/login/2fa,
    // depois de digitar o código do app autenticador.
    if (user.totp_enabled) {
      const tempToken = createPending2FAToken(user.id);
      return res.json({ requires2fa: true, tempToken });
    }

    req.session.userId = user.id;
    req.session.sessionId = await createUserSession(user.id, req);
    res.json({ id: user.id, username: user.username, is_admin: user.is_admin });
    updateStreakAndRewards(user).catch((err) => console.error('Erro ao atualizar streak:', err));
  })
);

app.post(
  '/api/login/2fa',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { tempToken, code } = req.body || {};
    const pending = tempToken && pending2FALogins.get(tempToken);
    if (!pending || pending.expires < Date.now()) {
      if (tempToken) pending2FALogins.delete(tempToken);
      return res.status(401).json({ error: 'Login expirado — tente novamente desde o início.' });
    }
    const user = await db.get('SELECT * FROM users WHERE id = ?', [pending.userId]);
    if (!user || user.is_banned || !user.totp_enabled) {
      pending2FALogins.delete(tempToken);
      return res.status(401).json({ error: 'Não foi possível concluir o login' });
    }
    const valid = code && authenticator.check(String(code).trim(), user.totp_secret);
    if (!valid) return res.status(401).json({ error: 'Código incorreto' });

    pending2FALogins.delete(tempToken);
    req.session.userId = user.id;
    req.session.sessionId = await createUserSession(user.id, req);
    res.json({ id: user.id, username: user.username, is_admin: user.is_admin });
    updateStreakAndRewards(user).catch((err) => console.error('Erro ao atualizar streak:', err));
  })
);

app.post('/api/logout', (req, res) => {
  if (req.session && req.session.sessionId) {
    db.run('UPDATE user_sessions SET revoked = 1 WHERE id = ?', [req.session.sessionId]).catch(() => {});
  }
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
      avatar_frame: req.user.avatar_frame,
      message_count: Number(countRow.c),
      login_streak: req.user.login_streak || 0,
      longest_streak: req.user.longest_streak || 0,
      points: req.user.points || 0,
    });
  })
);

// Editar perfil: trocar senha (exige senha atual), e-mail, status "jogando" e/ou avatar.
app.patch(
  '/api/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { email, password, currentPassword, status_message, avatar, avatar_frame } = req.body || {};

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

    if (typeof avatar_frame === 'string') {
      if (avatar_frame) {
        // Só deixa equipar uma moldura que o usuário já desbloqueou de verdade.
        const reward = REWARDS_CATALOG.find((r) => r.frame === avatar_frame);
        const owned = reward && (await db.get('SELECT id FROM user_rewards WHERE user_id = ? AND reward_key = ?', [
          req.user.id,
          reward.key,
        ]));
        if (!owned) return res.status(403).json({ error: 'Você ainda não desbloqueou essa moldura' });
      }
      await db.run('UPDATE users SET avatar_frame = ? WHERE id = ?', [avatar_frame || null, req.user.id]);
    }

    const updated = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json({
      ok: true,
      status_message: updated.status_message,
      avatar: updated.avatar,
      avatar_frame: updated.avatar_frame,
    });
  })
);

// ---------- 2FA (autenticação em duas etapas via app autenticador, TOTP) ----------

app.post(
  '/api/2fa/setup',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.totp_enabled) return res.status(400).json({ error: '2FA já está ativado nessa conta' });
    const secret = authenticator.generateSecret();
    // Guarda o segredo já, mas totp_enabled só vira 1 depois de confirmar com
    // um código válido em /api/2fa/verify — assim não trava a conta se a
    // pessoa fechar a tela no meio do processo.
    await db.run('UPDATE users SET totp_secret = ? WHERE id = ?', [secret, req.user.id]);
    const otpauth = authenticator.keyuri(req.user.username, 'NEXT GAME', secret);
    const qrDataUrl = await QRCode.toDataURL(otpauth);
    res.json({ secret, qr: qrDataUrl });
  })
);

app.post(
  '/api/2fa/verify',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { code } = req.body || {};
    if (!req.user.totp_secret) return res.status(400).json({ error: 'Comece pelo /2fa/setup primeiro' });
    const valid = code && authenticator.check(String(code).trim(), req.user.totp_secret);
    if (!valid) return res.status(400).json({ error: 'Código incorreto — confira o app autenticador' });
    await db.run('UPDATE users SET totp_enabled = 1 WHERE id = ?', [req.user.id]);
    res.json({ ok: true });
  })
);

app.post(
  '/api/2fa/disable',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword } = req.body || {};
    if (!currentPassword || !bcrypt.compareSync(currentPassword, req.user.password_hash)) {
      return res.status(401).json({ error: 'Senha atual incorreta' });
    }
    await db.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', [req.user.id]);
    res.json({ ok: true });
  })
);

app.get(
  '/api/2fa/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ enabled: !!req.user.totp_enabled });
  })
);

// ---------- SESSÕES ATIVAS / LOGOUT REMOTO ----------

app.get(
  '/api/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessions = await db.all(
      'SELECT id, user_agent, ip, created_at, last_seen_at FROM user_sessions WHERE user_id = ? AND revoked = 0 ORDER BY last_seen_at DESC',
      [req.user.id]
    );
    res.json(sessions.map((s) => ({ ...s, is_current: s.id === req.currentSessionId })));
  })
);

app.post(
  '/api/sessions/:id/revoke',
  requireAuth,
  asyncHandler(async (req, res) => {
    await db.run('UPDATE user_sessions SET revoked = 1 WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  })
);

app.post(
  '/api/sessions/revoke-others',
  requireAuth,
  asyncHandler(async (req, res) => {
    await db.run('UPDATE user_sessions SET revoked = 1 WHERE user_id = ? AND id != ?', [
      req.user.id,
      req.currentSessionId,
    ]);
    res.json({ ok: true });
  })
);

// ---------- BLOQUEIO DE USUÁRIOS ----------

app.get(
  '/api/blocked-users',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      `SELECT u.id, u.username, u.avatar FROM blocked_users b
       JOIN users u ON u.id = b.blocked_user_id
       WHERE b.user_id = ? ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  })
);

app.post(
  '/api/blocked-users/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.params.userId === req.user.id) return res.status(400).json({ error: 'Você não pode bloquear a si mesmo' });
    await db.run('INSERT OR IGNORE INTO blocked_users (id, user_id, blocked_user_id) VALUES (?, ?, ?)', [
      uuidv4(),
      req.user.id,
      req.params.userId,
    ]);
    res.json({ ok: true });
  })
);

app.delete(
  '/api/blocked-users/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    await db.run('DELETE FROM blocked_users WHERE user_id = ? AND blocked_user_id = ?', [
      req.user.id,
      req.params.userId,
    ]);
    res.json({ ok: true });
  })
);

// ---------- PREFERÊNCIAS DE NOTIFICAÇÃO ----------

const DEFAULT_NOTIFICATION_PREFS = {
  mensagem: true,
  convite_amizade: true,
  convite_servidor: true,
  torneio: true,
  conquista: true,
  transmissao: true,
};

app.get(
  '/api/notification-prefs',
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = await db.get('SELECT prefs FROM notification_prefs WHERE user_id = ?', [req.user.id]);
    let prefs = { ...DEFAULT_NOTIFICATION_PREFS };
    if (row) {
      try {
        prefs = { ...prefs, ...JSON.parse(row.prefs) };
      } catch (_) {}
    }
    res.json(prefs);
  })
);

app.put(
  '/api/notification-prefs',
  requireAuth,
  asyncHandler(async (req, res) => {
    const prefs = { ...DEFAULT_NOTIFICATION_PREFS };
    Object.keys(DEFAULT_NOTIFICATION_PREFS).forEach((key) => {
      if (typeof req.body[key] === 'boolean') prefs[key] = req.body[key];
    });
    await db.run(
      `INSERT INTO notification_prefs (user_id, prefs) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs`,
      [req.user.id, JSON.stringify(prefs)]
    );
    res.json(prefs);
  })
);

// ---------- RECOMPENSAS ----------

app.get(
  '/api/rewards',
  requireAuth,
  asyncHandler(async (req, res) => {
    const unlocked = await db.all('SELECT reward_key, verification_code, unlocked_at FROM user_rewards WHERE user_id = ?', [
      req.user.id,
    ]);
    const unlockedMap = {};
    unlocked.forEach((u) => (unlockedMap[u.reward_key] = u));

    // Pra recompensas de vaga limitada, mostra quantas já foram preenchidas
    // (mesmo pra quem ainda não desbloqueou, pra criar aquela corrida saudável).
    const slotsInfo = {};
    for (const r of REWARDS_CATALOG) {
      if (r.limitedSlots) {
        const countRow = await db.get('SELECT COUNT(*) as c FROM user_rewards WHERE reward_key = ?', [r.key]);
        slotsInfo[r.key] = { taken: Number(countRow.c), total: r.limitedSlots };
      }
    }

    const rewards = REWARDS_CATALOG.map((r) => ({
      ...r,
      unlocked: !!unlockedMap[r.key],
      verification_code: unlockedMap[r.key] ? unlockedMap[r.key].verification_code : null,
      unlocked_at: unlockedMap[r.key] ? unlockedMap[r.key].unlocked_at : null,
      slots: slotsInfo[r.key] || null,
    }));

    res.json({
      streak: req.user.login_streak || 0,
      longest_streak: req.user.longest_streak || 0,
      points: req.user.points || 0,
      rewards,
      equipped_frame: req.user.avatar_frame || null,
      username: req.user.username,
    });
  })
);

// ---------- MISSÕES (quiz com pontos) ----------

app.get(
  '/api/missions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const completedRows = await db.all(
      'SELECT mission_key, points_awarded, completed_at FROM user_mission_progress WHERE user_id = ?',
      [req.user.id]
    );
    const completedMap = {};
    completedRows.forEach((r) => (completedMap[r.mission_key] = r));

    const streak = req.user.login_streak || 0;
    const missions = MISSIONS_CATALOG.map((m) => {
      const completed = completedMap[m.key];
      const available = streak >= m.unlockDays;
      return {
        key: m.key,
        name: m.name,
        description: m.description,
        unlockDays: m.unlockDays,
        points: m.points,
        available,
        completed: !!completed,
        completed_at: completed ? completed.completed_at : null,
        // só manda as perguntas/opções se estiver disponível e ainda não
        // concluída — e nunca manda o índice da resposta certa, claro.
        questions: available && !completed ? m.questions.map((q) => ({ q: q.q, options: q.options })) : undefined,
      };
    });

    res.json({ points: req.user.points || 0, streak, missions });
  })
);

app.post(
  '/api/missions/:key/submit',
  requireAuth,
  asyncHandler(async (req, res) => {
    const mission = MISSIONS_CATALOG.find((m) => m.key === req.params.key);
    if (!mission) return res.status(404).json({ error: 'Missão não encontrada' });

    const streak = req.user.login_streak || 0;
    if (streak < mission.unlockDays) {
      return res.status(403).json({ error: 'Essa missão ainda não está disponível pra você' });
    }

    const already = await db.get('SELECT id FROM user_mission_progress WHERE user_id = ? AND mission_key = ?', [
      req.user.id,
      mission.key,
    ]);
    if (already) return res.status(409).json({ error: 'Você já completou essa missão' });

    const answers = Array.isArray(req.body && req.body.answers) ? req.body.answers : [];
    let correctCount = 0;
    mission.questions.forEach((q, i) => {
      if (answers[i] === q.correct) correctCount++;
    });
    const allCorrect = correctCount === mission.questions.length && answers.length === mission.questions.length;

    if (!allCorrect) {
      return res.json({ success: false, correctCount, total: mission.questions.length });
    }

    await db.run('INSERT INTO user_mission_progress (id, user_id, mission_key, points_awarded) VALUES (?, ?, ?, ?)', [
      uuidv4(),
      req.user.id,
      mission.key,
      mission.points,
    ]);
    await db.run('UPDATE users SET points = points + ? WHERE id = ?', [mission.points, req.user.id]);
    const updated = await db.get('SELECT points FROM users WHERE id = ?', [req.user.id]);

    res.json({ success: true, points_awarded: mission.points, total_points: updated.points });
  })
);

// Verificação pública do selo — qualquer pessoa com o código consegue
// conferir se é autêntico, sem precisar estar logada. Isso é o que torna a
// recompensa rara "auditável" de verdade.
app.get(
  '/api/verify/:code',
  asyncHandler(async (req, res) => {
    const row = await db.get(
      `SELECT ur.reward_key, ur.unlocked_at, u.username
       FROM user_rewards ur JOIN users u ON u.id = ur.user_id
       WHERE ur.verification_code = ?`,
      [req.params.code]
    );
    if (!row) return res.status(404).json({ valid: false });
    const reward = REWARDS_CATALOG.find((r) => r.key === row.reward_key);
    res.json({
      valid: true,
      username: row.username,
      reward_name: reward ? reward.name : row.reward_key,
      unlocked_at: row.unlocked_at,
    });
  })
);

// ---------- CHANNELS ----------

// Só mostra canais dos servidores em que a pessoa realmente é membro — igual
// Discord, onde você só vê o que faz parte.
app.get(
  '/api/channels',
  requireAuth,
  asyncHandler(async (req, res) => {
    const memberships = await db.all('SELECT category FROM server_members WHERE user_id = ?', [req.user.id]);
    const categories = memberships.map((m) => m.category);
    if (categories.length === 0) return res.json([]);
    const placeholders = categories.map(() => '?').join(',');
    res.json(
      await db.all(`SELECT * FROM channels WHERE category IN (${placeholders}) ORDER BY category, type, name`, categories)
    );
  })
);

// Criar uma sala. Se a categoria/"servidor" ainda não existir, ela nasce
// aqui — e quem criou vira o dono (igual criar um servidor novo no Discord).
// Se a categoria já existir, precisa ser membro e ter permissão de gerenciar
// canais (dono sempre tem; nos servidores padrão sem dono, qualquer membro tem).
app.post(
  '/api/channels',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name, category, type, icon } = req.body || {};
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

    const existingServer = await db.get('SELECT category FROM servers WHERE category = ?', [cleanCategory]);

    if (!existingServer) {
      // Servidor novo — quem cria vira dono automaticamente e já entra como membro.
      const inviteCode = generateInviteCode();
      await db.run(
        'INSERT INTO servers (category, icon, owner_id, invite_code, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))',
        [cleanCategory, icon && typeof icon === 'string' && icon.length <= 8 ? icon : null, req.user.id, inviteCode, req.user.id]
      );
      await db.run('INSERT INTO server_members (id, category, user_id) VALUES (?, ?, ?)', [
        uuidv4(),
        cleanCategory,
        req.user.id,
      ]);
    } else {
      const isMember = await isServerMember(cleanCategory, req.user.id);
      if (!isMember) return res.status(403).json({ error: 'Você precisa ser membro desse servidor pra criar salas nele' });
      const canManage = await hasServerPermission(cleanCategory, req.user, 'manage_channels');
      if (!canManage) return res.status(403).json({ error: 'Você não tem permissão pra criar salas nesse servidor' });
    }

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

// Lista enxuta (categoria + ícone) dos servidores em que a pessoa é membro —
// usada pro trilho de servidores e pro dashboard de Início.
app.get(
  '/api/servers',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(
      await db.all(
        `SELECT s.category, s.icon FROM servers s
         JOIN server_members sm ON sm.category = s.category
         WHERE sm.user_id = ?`,
        [req.user.id]
      )
    );
  })
);

// Meus servidores com mais detalhes (dono, quantidade de membros) — usado no
// modal de gerenciamento e em telas que precisam saber se sou dono.
app.get(
  '/api/servers/mine',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      `SELECT s.category, s.icon, s.owner_id,
              (SELECT COUNT(*) FROM server_members WHERE category = s.category) as member_count
       FROM servers s
       JOIN server_members sm ON sm.category = s.category
       WHERE sm.user_id = ?`,
      [req.user.id]
    );
    res.json(rows.map((r) => ({ ...r, is_owner: r.owner_id === req.user.id })));
  })
);

// Convite: qualquer um com o código consegue ver uma prévia do servidor sem
// precisar estar logado — só entra de fato com POST (aí sim exige login).
app.get(
  '/api/invite/:code',
  asyncHandler(async (req, res) => {
    const server = await db.get('SELECT category, icon, description FROM servers WHERE invite_code = ?', [
      req.params.code,
    ]);
    if (!server) return res.status(404).json({ error: 'Convite inválido ou expirado' });
    const countRow = await db.get('SELECT COUNT(*) as c FROM server_members WHERE category = ?', [server.category]);
    res.json({ ...server, member_count: Number(countRow.c) });
  })
);

app.post(
  '/api/invite/:code/join',
  requireAuth,
  asyncHandler(async (req, res) => {
    const server = await db.get('SELECT category FROM servers WHERE invite_code = ?', [req.params.code]);
    if (!server) return res.status(404).json({ error: 'Convite inválido ou expirado' });
    await db.run('INSERT OR IGNORE INTO server_members (id, category, user_id) VALUES (?, ?, ?)', [
      uuidv4(),
      server.category,
      req.user.id,
    ]);
    res.json({ category: server.category });
  })
);

// Ver/gerar o código de convite do servidor — só quem tem permissão de
// gerenciar o servidor (dono, admin do site, ou cargo com manage_server).
app.get(
  '/api/servers/:category/invite',
  requireAuth,
  asyncHandler(async (req, res) => {
    const isMember = await isServerMember(req.params.category, req.user.id);
    if (!isMember) return res.status(403).json({ error: 'Você não é membro desse servidor' });
    const server = await db.get('SELECT invite_code FROM servers WHERE category = ?', [req.params.category]);
    if (!server) return res.status(404).json({ error: 'Servidor não encontrado' });
    res.json({ invite_code: server.invite_code });
  })
);

app.post(
  '/api/servers/:category/invite/regenerate',
  requireAuth,
  asyncHandler(async (req, res) => {
    const canManage = await hasServerPermission(req.params.category, req.user, 'manage_server');
    if (!canManage) return res.status(403).json({ error: 'Você não tem permissão pra gerenciar esse servidor' });
    const newCode = generateInviteCode();
    await db.run('UPDATE servers SET invite_code = ? WHERE category = ?', [newCode, req.params.category]);
    res.json({ invite_code: newCode });
  })
);

// Informações/regras do servidor (categoria) — igual tela de boas-vindas do Discord.
// Só membros conseguem ver (servidor é privado).
app.get(
  '/api/servers/:category',
  requireAuth,
  asyncHandler(async (req, res) => {
    const isMember = await isServerMember(req.params.category, req.user.id);
    if (!isMember && !req.user.is_admin) return res.status(403).json({ error: 'Você não é membro desse servidor' });
    const info = await db.get('SELECT * FROM servers WHERE category = ?', [req.params.category]);
    const perms = await getServerPermissions(req.params.category, req.user.id);
    res.json({
      ...(info || { category: req.params.category, description: null, rules: null }),
      is_owner: info && info.owner_id === req.user.id,
      my_permissions: [...perms],
    });
  })
);

app.patch(
  '/api/servers/:category',
  requireAuth,
  asyncHandler(async (req, res) => {
    const canManage = await hasServerPermission(req.params.category, req.user, 'manage_server');
    if (!canManage) return res.status(403).json({ error: 'Você não tem permissão pra gerenciar esse servidor' });
    const { description, rules, icon } = req.body || {};
    if ((description && description.length > 500) || (rules && rules.length > 2000)) {
      return res.status(400).json({ error: 'Descrição (máx. 500) ou regras (máx. 2000) muito longas' });
    }
    await db.run(
      `INSERT INTO servers (category, description, rules, icon, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(category) DO UPDATE SET
         description = excluded.description,
         rules = excluded.rules,
         icon = COALESCE(excluded.icon, servers.icon),
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
      [req.params.category, description || null, rules || null, icon && icon.length <= 8 ? icon : null, req.user.id]
    );
    res.json({ ok: true });
  })
);

// ---------- MEMBROS, CARGOS E PERMISSÕES DO SERVIDOR ----------

app.get(
  '/api/servers/:category/members',
  requireAuth,
  asyncHandler(async (req, res) => {
    const isMember = await isServerMember(req.params.category, req.user.id);
    if (!isMember && !req.user.is_admin) return res.status(403).json({ error: 'Você não é membro desse servidor' });

    const server = await db.get('SELECT owner_id FROM servers WHERE category = ?', [req.params.category]);
    const members = await db.all(
      `SELECT u.id, u.username, u.avatar, u.avatar_frame
       FROM server_members sm JOIN users u ON u.id = sm.user_id
       WHERE sm.category = ? ORDER BY u.username`,
      [req.params.category]
    );
    const roleRows = await db.all(
      `SELECT smr.user_id, r.id as role_id, r.name, r.color
       FROM server_member_roles smr JOIN server_roles r ON r.id = smr.role_id
       WHERE smr.category = ?`,
      [req.params.category]
    );
    res.json(
      members.map((m) => ({
        ...m,
        is_owner: server && server.owner_id === m.id,
        roles: roleRows.filter((r) => r.user_id === m.id).map((r) => ({ id: r.role_id, name: r.name, color: r.color })),
      }))
    );
  })
);

app.post(
  '/api/servers/:category/kick/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const canKick = await hasServerPermission(req.params.category, req.user, 'kick_members');
    if (!canKick) return res.status(403).json({ error: 'Você não tem permissão pra expulsar membros' });
    const server = await db.get('SELECT owner_id FROM servers WHERE category = ?', [req.params.category]);
    if (server && server.owner_id === req.params.userId) {
      return res.status(400).json({ error: 'Não dá pra expulsar o dono do servidor' });
    }
    await db.run('DELETE FROM server_members WHERE category = ? AND user_id = ?', [req.params.category, req.params.userId]);
    await db.run('DELETE FROM server_member_roles WHERE category = ? AND user_id = ?', [
      req.params.category,
      req.params.userId,
    ]);
    res.json({ ok: true });
  })
);

app.post(
  '/api/servers/:category/leave',
  requireAuth,
  asyncHandler(async (req, res) => {
    const server = await db.get('SELECT owner_id FROM servers WHERE category = ?', [req.params.category]);
    if (server && server.owner_id === req.user.id) {
      return res.status(400).json({ error: 'O dono não pode sair do próprio servidor — exclua ou transfira antes' });
    }
    await db.run('DELETE FROM server_members WHERE category = ? AND user_id = ?', [req.params.category, req.user.id]);
    await db.run('DELETE FROM server_member_roles WHERE category = ? AND user_id = ?', [
      req.params.category,
      req.user.id,
    ]);
    res.json({ ok: true });
  })
);

app.get(
  '/api/servers/:category/roles',
  requireAuth,
  asyncHandler(async (req, res) => {
    const isMember = await isServerMember(req.params.category, req.user.id);
    if (!isMember && !req.user.is_admin) return res.status(403).json({ error: 'Você não é membro desse servidor' });
    const roles = await db.all('SELECT * FROM server_roles WHERE category = ? ORDER BY position DESC, created_at', [
      req.params.category,
    ]);
    res.json({
      permissions_catalog: SERVER_PERMISSIONS,
      roles: roles.map((r) => ({ ...r, permissions: JSON.parse(r.permissions || '[]') })),
    });
  })
);

app.post(
  '/api/servers/:category/roles',
  requireAuth,
  asyncHandler(async (req, res) => {
    const canManage = await hasServerPermission(req.params.category, req.user, 'manage_roles');
    if (!canManage) return res.status(403).json({ error: 'Você não tem permissão pra gerenciar cargos' });
    const { name, color, permissions } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 30) {
      return res.status(400).json({ error: 'Nome do cargo precisa ter 2-30 caracteres' });
    }
    const cleanColor = typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#99aab5';
    const cleanPermissions = Array.isArray(permissions) ? permissions.filter((p) => SERVER_PERMISSION_KEYS.includes(p)) : [];
    const id = uuidv4();
    await db.run('INSERT INTO server_roles (id, category, name, color, permissions) VALUES (?, ?, ?, ?, ?)', [
      id,
      req.params.category,
      name.trim(),
      cleanColor,
      JSON.stringify(cleanPermissions),
    ]);
    res.json({ id, name: name.trim(), color: cleanColor, permissions: cleanPermissions });
  })
);

app.patch(
  '/api/servers/:category/roles/:roleId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const canManage = await hasServerPermission(req.params.category, req.user, 'manage_roles');
    if (!canManage) return res.status(403).json({ error: 'Você não tem permissão pra gerenciar cargos' });
    const { name, color, permissions } = req.body || {};
    const role = await db.get('SELECT * FROM server_roles WHERE id = ? AND category = ?', [
      req.params.roleId,
      req.params.category,
    ]);
    if (!role) return res.status(404).json({ error: 'Cargo não encontrado' });

    const cleanName = name && name.trim().length >= 2 && name.trim().length <= 30 ? name.trim() : role.name;
    const cleanColor = typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color : role.color;
    const cleanPermissions = Array.isArray(permissions)
      ? permissions.filter((p) => SERVER_PERMISSION_KEYS.includes(p))
      : JSON.parse(role.permissions || '[]');

    await db.run('UPDATE server_roles SET name = ?, color = ?, permissions = ? WHERE id = ?', [
      cleanName,
      cleanColor,
      JSON.stringify(cleanPermissions),
      req.params.roleId,
    ]);
    res.json({ ok: true });
  })
);

app.delete(
  '/api/servers/:category/roles/:roleId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const canManage = await hasServerPermission(req.params.category, req.user, 'manage_roles');
    if (!canManage) return res.status(403).json({ error: 'Você não tem permissão pra gerenciar cargos' });
    await db.run('DELETE FROM server_roles WHERE id = ? AND category = ?', [req.params.roleId, req.params.category]);
    await db.run('DELETE FROM server_member_roles WHERE role_id = ?', [req.params.roleId]);
    res.json({ ok: true });
  })
);

// Atribuir ou remover um cargo de um membro.
app.post(
  '/api/servers/:category/members/:userId/roles',
  requireAuth,
  asyncHandler(async (req, res) => {
    const canManage = await hasServerPermission(req.params.category, req.user, 'manage_roles');
    if (!canManage) return res.status(403).json({ error: 'Você não tem permissão pra gerenciar cargos' });
    const { roleId, action } = req.body || {};
    if (!roleId || !['add', 'remove'].includes(action)) {
      return res.status(400).json({ error: 'Dados inválidos' });
    }
    if (action === 'add') {
      await db.run('INSERT OR IGNORE INTO server_member_roles (id, category, user_id, role_id) VALUES (?, ?, ?, ?)', [
        uuidv4(),
        req.params.category,
        req.params.userId,
        roleId,
      ]);
    } else {
      await db.run('DELETE FROM server_member_roles WHERE category = ? AND user_id = ? AND role_id = ?', [
        req.params.category,
        req.params.userId,
        roleId,
      ]);
    }
    res.json({ ok: true });
  })
);

// ---------- AMIZADES ----------

app.get(
  '/api/friends',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      `SELECT f.id, f.status, f.requested_by, f.created_at,
              CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END as other_id
       FROM friendships f
       WHERE f.user_a = ? OR f.user_b = ?`,
      [req.user.id, req.user.id, req.user.id]
    );
    if (rows.length === 0) return res.json({ friends: [], incoming: [], outgoing: [] });

    const otherIds = rows.map((r) => r.other_id);
    const placeholders = otherIds.map(() => '?').join(',');
    const users = await db.all(
      `SELECT id, username, avatar, avatar_frame, status_message FROM users WHERE id IN (${placeholders})`,
      otherIds
    );
    const usersMap = {};
    users.forEach((u) => (usersMap[u.id] = u));

    const friends = [];
    const incoming = [];
    const outgoing = [];
    rows.forEach((r) => {
      const entry = { friendship_id: r.id, user: usersMap[r.other_id], created_at: r.created_at };
      if (r.status === 'accepted') friends.push(entry);
      else if (r.requested_by === req.user.id) outgoing.push(entry);
      else incoming.push(entry);
    });
    res.json({ friends, incoming, outgoing });
  })
);

app.post(
  '/api/friends/request',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { username } = req.body || {};
    if (!username || typeof username !== 'string') return res.status(400).json({ error: 'Usuário inválido' });
    const target = await db.get('SELECT id FROM users WHERE username = ?', [username.trim()]);
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'Você não pode adicionar a si mesmo' });

    const blockedEitherWay = await db.get(
      'SELECT id FROM blocked_users WHERE (user_id = ? AND blocked_user_id = ?) OR (user_id = ? AND blocked_user_id = ?)',
      [req.user.id, target.id, target.id, req.user.id]
    );
    if (blockedEitherWay) return res.status(403).json({ error: 'Não é possível enviar esse pedido de amizade' });

    const [userA, userB] = [req.user.id, target.id].sort();
    const existing = await db.get('SELECT id, status FROM friendships WHERE user_a = ? AND user_b = ?', [userA, userB]);
    if (existing) {
      return res.status(409).json({ error: existing.status === 'accepted' ? 'Vocês já são amigos' : 'Já existe um pedido pendente' });
    }
    const id = uuidv4();
    await db.run('INSERT INTO friendships (id, user_a, user_b, status, requested_by) VALUES (?, ?, ?, ?, ?)', [
      id,
      userA,
      userB,
      'pending',
      req.user.id,
    ]);
    res.json({ id, status: 'pending' });
  })
);

app.post(
  '/api/friends/:id/accept',
  requireAuth,
  asyncHandler(async (req, res) => {
    const friendship = await db.get('SELECT * FROM friendships WHERE id = ?', [req.params.id]);
    if (!friendship || (friendship.user_a !== req.user.id && friendship.user_b !== req.user.id)) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    if (friendship.requested_by === req.user.id) {
      return res.status(400).json({ error: 'Você não pode aceitar seu próprio pedido' });
    }
    await db.run("UPDATE friendships SET status = 'accepted' WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  })
);

// Cobre recusar um pedido pendente, cancelar um pedido enviado, ou desfazer
// uma amizade já aceita — as três ações são só "apagar essa linha".
app.delete(
  '/api/friends/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const friendship = await db.get('SELECT * FROM friendships WHERE id = ?', [req.params.id]);
    if (!friendship || (friendship.user_a !== req.user.id && friendship.user_b !== req.user.id)) {
      return res.status(404).json({ error: 'Não encontrado' });
    }
    await db.run('DELETE FROM friendships WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  })
);

// ---------- MENSAGENS DIRETAS (DM) ----------
// Reaproveita 100% a infraestrutura de chat/voz já existente (tabela
// messages, socket chat:message, rtc:join) — o "channel_id" de uma DM é só
// um id determinístico calculado a partir dos dois usuários, então tudo que
// já funciona pra canais de servidor funciona pra DM sem mudar nada.
function dmChannelId(a, b) {
  return 'dm::' + [a, b].sort().join('::');
}

app.get(
  '/api/dm/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const targetId = req.params.userId;
    if (targetId === req.user.id) return res.status(400).json({ error: 'Não dá pra mandar mensagem pra você mesmo' });

    const blockedEitherWay = await db.get(
      'SELECT id FROM blocked_users WHERE (user_id = ? AND blocked_user_id = ?) OR (user_id = ? AND blocked_user_id = ?)',
      [req.user.id, targetId, targetId, req.user.id]
    );
    if (blockedEitherWay) return res.status(403).json({ error: 'Não é possível conversar com esse usuário' });

    if (targetId !== AI_BOT_USER_ID) {
      const [a, b] = [req.user.id, targetId].sort();
      const friendship = await db.get(
        "SELECT id FROM friendships WHERE user_a = ? AND user_b = ? AND status = 'accepted'",
        [a, b]
      );
      if (!friendship) return res.status(403).json({ error: 'Vocês precisam ser amigos pra conversar diretamente' });
    }

    const target = await db.get('SELECT id, username, avatar, avatar_frame, is_admin FROM users WHERE id = ?', [
      targetId,
    ]);
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });

    const id = dmChannelId(req.user.id, targetId);
    const [userA, userB] = [req.user.id, targetId].sort();
    await db.run('INSERT OR IGNORE INTO dm_channels (id, user_a, user_b) VALUES (?, ?, ?)', [id, userA, userB]);

    res.json({ channel_id: id, other_user: target });
  })
);

// Lista minhas conversas diretas (com a última mensagem, pra mostrar uma prévia).
app.get(
  '/api/dm',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.all('SELECT * FROM dm_channels WHERE user_a = ? OR user_b = ?', [req.user.id, req.user.id]);
    const results = [];
    for (const row of rows) {
      const otherId = row.user_a === req.user.id ? row.user_b : row.user_a;
      const other = await db.get('SELECT id, username, avatar, avatar_frame FROM users WHERE id = ?', [otherId]);
      if (!other) continue;
      const lastMsg = await db.get(
        'SELECT content, created_at FROM messages WHERE channel_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1',
        [row.id]
      );
      results.push({ channel_id: row.id, other_user: other, last_message: lastMsg || null });
    }
    results.sort((x, y) => {
      const tx = x.last_message ? x.last_message.created_at : '';
      const ty = y.last_message ? y.last_message.created_at : '';
      return ty.localeCompare(tx);
    });
    res.json(results);
  })
);

// ---------- ASSISTENTE DE IA (bot que responde nas DMs com ele) ----------

async function postAiMessage(channelId, content) {
  const id = uuidv4();
  await db.run('INSERT INTO messages (id, channel_id, user_id, username, content) VALUES (?, ?, ?, ?, ?)', [
    id,
    channelId,
    AI_BOT_USER_ID,
    AI_BOT_USERNAME,
    content,
  ]);
  io.to(channelId).emit('chat:message', {
    id,
    channel_id: channelId,
    user_id: AI_BOT_USER_ID,
    username: AI_BOT_USERNAME,
    content,
    created_at: new Date().toISOString(),
  });
}

// ---------- FERRAMENTAS QUE A IA PODE EXECUTAR DE VERDADE ----------
// Duas camadas de segurança, sempre baseadas no usuário REAL da sessão
// autenticada (nunca em nada que o texto da conversa afirme sobre si mesmo):
//   1) Ferramentas de admin (banir, desbanir, limpar sala) só entram na lista
//      oferecida ao modelo quando user.is_admin é true — e são revalidadas de
//      novo dentro de executeAiTool antes de rodar, por segurança extra.
//   2) Ações destrutivas (banir e limpar sala) nunca executam na hora: ficam
//      "pendentes" até a pessoa confirmar explicitamente com "sim"/"confirmo"
//      na mensagem seguinte. Isso é tratado com regex direto, sem depender do
//      modelo reinterpretar a confirmação certo.
const pendingAiActions = new Map(); // userId -> { type, params, createdAt }
const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;
const DESTRUCTIVE_AI_TOOLS = new Set(['ban_user', 'clear_channel', 'kick_member']);

const AI_SELF_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'set_status_message',
      description: 'Muda o status "jogando/fazendo" do próprio usuário que está conversando agora.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Novo texto de status, até 60 caracteres. Vazio pra remover.' },
        },
        required: ['status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'join_server_by_invite',
      description: 'Entra em um servidor usando um código de convite que a pessoa forneceu na conversa.',
      parameters: {
        type: 'object',
        properties: { invite_code: { type: 'string', description: 'O código de convite' } },
        required: ['invite_code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_server',
      description: 'Cria um novo servidor com um canal de texto padrão chamado "geral", com quem pediu como dono.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nome do novo servidor, 2 a 40 caracteres' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_rewards',
      description: 'Consulta a sequência de dias, pontos e recompensas já desbloqueadas de quem está conversando.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const AI_ADMIN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'ban_user',
      description:
        'Bane um usuário do site inteiro. Só para administradores. É uma ação séria: sempre peça confirmação antes.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'Nome de usuário exato a banir' },
          reason: { type: 'string', description: 'Motivo do banimento' },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'unban_user',
      description: 'Remove o banimento de um usuário. Só para administradores.',
      parameters: {
        type: 'object',
        properties: { username: { type: 'string' } },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clear_channel',
      description:
        'Apaga todas as mensagens de uma sala/canal. Só para administradores. É irreversível: sempre peça confirmação antes.',
      parameters: {
        type: 'object',
        properties: { channel_name: { type: 'string', description: 'Nome do canal/sala a limpar' } },
        required: ['channel_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kick_member',
      description:
        'Expulsa um membro de um servidor específico (a pessoa pode voltar com um convite novo). Só para administradores. Sempre peça confirmação antes.',
      parameters: {
        type: 'object',
        properties: {
          server_name: { type: 'string', description: 'Nome do servidor (categoria)' },
          username: { type: 'string', description: 'Nome de usuário exato a expulsar' },
        },
        required: ['server_name', 'username'],
      },
    },
  },
];

function isAffirmative(text) {
  return /^(sim|s|confirmo|confirmar|pode|isso mesmo|manda ver|ok|beleza|confirma)\b/i.test((text || '').trim());
}
function isNegative(text) {
  return /^(n[ãa]o|nao|cancela|cancelar|deixa (pra lá|pra la|quieto)|para)\b/i.test((text || '').trim());
}

// Executa de fato a ação. Revalida permissão de admin aqui dentro também —
// nunca confia só no fato de a ferramenta ter sido oferecida ao modelo.
async function executeAiTool(name, args, user) {
  switch (name) {
    case 'set_status_message': {
      const status = String(args.status || '').slice(0, 60).trim();
      await db.run('UPDATE users SET status_message = ? WHERE id = ?', [status || null, user.id]);
      return status ? `Prontinho, seu status agora é "${status}".` : 'Status removido.';
    }
    case 'join_server_by_invite': {
      const code = String(args.invite_code || '').trim();
      const server = await db.get('SELECT category FROM servers WHERE invite_code = ?', [code]);
      if (!server) return 'Esse código de convite não é válido.';
      await db.run('INSERT OR IGNORE INTO server_members (id, category, user_id) VALUES (?, ?, ?)', [
        uuidv4(),
        server.category,
        user.id,
      ]);
      return `Você entrou no servidor "${server.category}"!`;
    }
    case 'create_server': {
      const name = String(args.name || '').trim().slice(0, 40);
      if (name.length < 2) return 'O nome do servidor precisa ter pelo menos 2 caracteres.';
      const existing = await db.get('SELECT category FROM servers WHERE category = ?', [name]);
      if (existing) return `Já existe um servidor chamado "${name}" — escolhe outro nome.`;
      const inviteCode = generateInviteCode();
      await db.run(
        "INSERT INTO servers (category, owner_id, invite_code, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime('now'))",
        [name, user.id, inviteCode, user.id]
      );
      await db.run('INSERT INTO server_members (id, category, user_id) VALUES (?, ?, ?)', [uuidv4(), name, user.id]);
      await db.run('INSERT INTO channels (id, name, category, type, created_by) VALUES (?, ?, ?, ?, ?)', [
        uuidv4(),
        'geral',
        name,
        'texto',
        user.id,
      ]);
      return `Servidor "${name}" criado! Você já entrou automaticamente, com um canal #geral.`;
    }
    case 'get_my_rewards': {
      const countRow = await db.get('SELECT COUNT(*) as c FROM user_rewards WHERE user_id = ?', [user.id]);
      return `Sequência atual: ${user.login_streak || 0} dia(s) (recorde: ${user.longest_streak || 0}). Pontos: ${
        user.points || 0
      }. Recompensas desbloqueadas: ${Number(countRow.c)}.`;
    }
    case 'ban_user': {
      if (!user.is_admin) return 'Você precisa ser administrador do site pra fazer isso.';
      const target = await db.get('SELECT id, username FROM users WHERE username = ?', [
        String(args.username || '').trim(),
      ]);
      if (!target) return `Não encontrei ninguém com o nome "${args.username}".`;
      await db.run('UPDATE users SET is_banned = 1 WHERE id = ?', [target.id]);
      postSystemMessage(WELCOME_CHANNEL_ID, `🔨 ${target.username} foi banido(a) por um moderador.`);
      return `${target.username} foi banido(a).`;
    }
    case 'unban_user': {
      if (!user.is_admin) return 'Você precisa ser administrador do site pra fazer isso.';
      const target = await db.get('SELECT id, username FROM users WHERE username = ?', [
        String(args.username || '').trim(),
      ]);
      if (!target) return `Não encontrei ninguém com o nome "${args.username}".`;
      await db.run('UPDATE users SET is_banned = 0 WHERE id = ?', [target.id]);
      return `${target.username} foi desbanido(a).`;
    }
    case 'clear_channel': {
      if (!user.is_admin) return 'Você precisa ser administrador do site pra fazer isso.';
      const channelName = String(args.channel_name || '').trim();
      const matches = await db.all('SELECT id, name, category FROM channels WHERE name = ?', [channelName]);
      if (matches.length === 0) return `Não encontrei nenhuma sala chamada "${channelName}".`;
      if (matches.length > 1) {
        return `Tem mais de uma sala "${channelName}" (nos servidores: ${matches
          .map((m) => m.category)
          .join(', ')}). Me diz o nome do servidor também.`;
      }
      const channel = matches[0];
      await db.run('UPDATE messages SET deleted = 1 WHERE channel_id = ?', [channel.id]);
      io.to(channel.id).emit('chat:cleared', { channel_id: channel.id });
      return `Conversa da sala "${channel.name}" foi limpa.`;
    }
    case 'kick_member': {
      if (!user.is_admin) return 'Você precisa ser administrador do site pra fazer isso.';
      const serverName = String(args.server_name || '').trim();
      const server = await db.get('SELECT category, owner_id FROM servers WHERE category = ?', [serverName]);
      if (!server) return `Não encontrei nenhum servidor chamado "${serverName}".`;
      const target = await db.get('SELECT id, username FROM users WHERE username = ?', [
        String(args.username || '').trim(),
      ]);
      if (!target) return `Não encontrei ninguém com o nome "${args.username}".`;
      if (server.owner_id === target.id) return 'Não dá pra expulsar o dono do servidor.';
      await db.run('DELETE FROM server_members WHERE category = ? AND user_id = ?', [server.category, target.id]);
      await db.run('DELETE FROM server_member_roles WHERE category = ? AND user_id = ?', [
        server.category,
        target.id,
      ]);
      return `${target.username} foi expulso(a) do servidor "${server.category}".`;
    }
    default:
      return 'Não sei fazer isso ainda.';
  }
}

function describeActionForConfirmation(name, args) {
  if (name === 'ban_user') {
    return `banir o usuário **${args.username}**${args.reason ? ` (motivo: ${args.reason})` : ''}`;
  }
  if (name === 'clear_channel') {
    return `apagar TODAS as mensagens da sala **${args.channel_name}**`;
  }
  if (name === 'kick_member') {
    return `expulsar **${args.username}** do servidor **${args.server_name}**`;
  }
  return 'fazer essa ação';
}

async function triggerAiReply(channelId, user) {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      await postAiMessage(
        channelId,
        'Ainda não fui configurado! Peça pro administrador do site adicionar a variável de ambiente GROQ_API_KEY nas configurações do servidor (veja o DEPLOY.md — é grátis, sem cartão).'
      );
      return;
    }

    // Se há uma ação pendente de confirmação pra essa pessoa, trata a
    // resposta diretamente por regex — mais confiável do que depender do
    // modelo reinterpretar um "sim" solto numa nova chamada de API.
    const pending = pendingAiActions.get(user.id);
    if (pending && Date.now() - pending.createdAt < PENDING_ACTION_TTL_MS) {
      const lastMsg = await db.get(
        'SELECT content FROM messages WHERE channel_id = ? AND user_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1',
        [channelId, user.id]
      );
      const text = (lastMsg && lastMsg.content) || '';
      if (isAffirmative(text)) {
        pendingAiActions.delete(user.id);
        const resultMsg = await executeAiTool(pending.type, pending.params, user);
        await postAiMessage(channelId, resultMsg);
        return;
      }
      if (isNegative(text)) {
        pendingAiActions.delete(user.id);
        await postAiMessage(channelId, 'Ok, cancelado.');
        return;
      }
      // Nem confirmou nem cancelou claramente — deixa a ação pendente
      // expirar sozinha (5 min) e segue com uma resposta normal abaixo.
    } else if (pending) {
      pendingAiActions.delete(user.id); // expirou
    }

    // Pega as últimas mensagens da conversa como contexto (janela pequena,
    // pra manter dentro do limite gratuito e a resposta rápida).
    const history = await db.all(
      'SELECT user_id, content FROM messages WHERE channel_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 12',
      [channelId]
    );
    const conversation = history
      .reverse()
      .filter((m) => m.content && m.content.trim())
      .map((m) => ({ role: m.user_id === AI_BOT_USER_ID ? 'assistant' : 'user', content: m.content }));
    if (conversation.length === 0) return;

    // API da Groq — compatível com o formato da OpenAI (chat completions),
    // incluindo tool/function calling. Gratuita sem cartão de crédito, com
    // limite de mensagens por minuto/dia.
    const model = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
    const tools = user.is_admin ? [...AI_SELF_TOOLS, ...AI_ADMIN_TOOLS] : AI_SELF_TOOLS;
    const systemMessage = {
      role: 'system',
      content:
        'Você é o assistente de IA do NEXT GAME, uma plataforma de chat e voz pra gamers e equipes de trabalho. ' +
        'Responda sempre em português do Brasil, de forma curta, direta e simpática. Pode ajudar com dúvidas ' +
        'gerais, dicas de jogos, produtividade, ou sobre como usar a própria plataforma. ' +
        'Você também tem ferramentas reais que executam ações na conta de quem está falando com você — use-as ' +
        'quando a pessoa pedir algo que uma delas resolve, em vez de só explicar como fazer manualmente. Nunca ' +
        'diga que fez algo sem realmente ter chamado a ferramenta correspondente.' +
        (user.is_admin
          ? ' Essa pessoa é administradora do site, então também tem ferramentas de moderação (banir usuário, ' +
            'limpar sala) — são ações sérias e irreversíveis, sempre chame a ferramenta pedindo confirmação em ' +
            'vez de executar sem avisar.'
          : ''),
    };

    const apiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model,
        max_tokens: 500,
        messages: [systemMessage, ...conversation],
        tools,
        tool_choice: 'auto',
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('Erro na API da Groq:', apiRes.status, errText);
      const friendly =
        apiRes.status === 429
          ? 'Bati no limite de mensagens gratuitas por agora — tenta de novo daqui a pouco.'
          : 'Deu um erro aqui do meu lado tentando responder. Tenta de novo daqui a pouco?';
      await postAiMessage(channelId, friendly);
      return;
    }

    const data = await apiRes.json();
    const message = data.choices && data.choices[0] && data.choices[0].message;
    if (!message) {
      await postAiMessage(channelId, 'Não consegui pensar em uma resposta agora — tenta reformular a pergunta?');
      return;
    }

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        const name = call.function && call.function.name;
        let args = {};
        try {
          args = JSON.parse((call.function && call.function.arguments) || '{}');
        } catch (_) {
          args = {};
        }

        // Defesa extra: mesmo que o modelo tente, ferramentas de admin nunca
        // executam pra quem não é admin de verdade na sessão real.
        const isAdminTool = AI_ADMIN_TOOLS.some((t) => t.function.name === name);
        if (isAdminTool && !user.is_admin) {
          await postAiMessage(channelId, 'Você precisa ser administrador do site pra isso.');
          continue;
        }

        if (DESTRUCTIVE_AI_TOOLS.has(name)) {
          pendingAiActions.set(user.id, { type: name, params: args, createdAt: Date.now() });
          await postAiMessage(
            channelId,
            `⚠️ Confirma que quer ${describeActionForConfirmation(
              name,
              args
            )}? Essa ação não pode ser desfeita. Responda **sim** pra confirmar ou **não** pra cancelar.`
          );
          continue;
        }

        const resultMsg = await executeAiTool(name, args, user);
        await postAiMessage(channelId, resultMsg);
      }
      return;
    }

    const reply = (message.content || '').trim() || 'Não consegui pensar em uma resposta agora — tenta reformular a pergunta?';
    await postAiMessage(channelId, reply);
  } catch (err) {
    console.error('Erro ao chamar a IA:', err);
    await postAiMessage(channelId, 'Deu um erro aqui do meu lado. Tenta de novo?');
  }
}

// ---------- MODERAÇÃO DE TELA COMPARTILHADA (câmera adicional de segurança) ----------
// IMPORTANTE: isso usa um modelo de visão de propósito geral (Groq) pra dar
// uma camada A MAIS de segurança sobre transmissões — NÃO é, e não deve ser
// tratado como, um substituto de serviços especializados de detecção de CSAM
// (PhotoDNA/Thorn), que comparam contra bancos de hashes conhecidos em vez de
// "olhar e julgar" a imagem. Por isso o prompt abaixo pede pra marcar só
// categorias gerais (armas, violência gráfica real, conteúdo sexual
// explícito) — nunca pedimos ao modelo pra tentar identificar exploração
// infantil especificamente, porque isso não é um uso apropriado/confiável de
// um modelo generativo e a maioria dos provedores de IA proíbe esse uso.
// Nunca guardamos a imagem em si — só o veredito, pra revisão humana.
app.post(
  '/api/moderate-frame',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { image, channelId } = req.body || {};
    if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Imagem inválida' });
    }
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.json({ flagged: false, skipped: true });

    try {
      const visionModel = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
      const apiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({
          model: visionModel,
          max_tokens: 200,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    'Esta imagem é um print de uma tela compartilhada numa plataforma de chat/voz pra gamers e ' +
                    'equipes de trabalho. Responda APENAS um JSON, sem texto extra, no formato ' +
                    '{"flagged": true ou false, "categories": [...], "reason": "..."}. ' +
                    'Marque flagged=true SOMENTE se a imagem mostrar claramente: armas de fogo reais anunciadas ' +
                    'pra venda, instruções de fabricação de explosivos, violência física grave/sangue real (não ' +
                    'de jogos, filmes ou desenhos), ou conteúdo sexual explícito real. NÃO marque telas de jogos, ' +
                    'código, memes, capturas de tela comuns, ou qualquer conteúdo fictício/ficcional. Na dúvida, ' +
                    'marque flagged=false.',
                },
                { type: 'image_url', image_url: { url: image } },
              ],
            },
          ],
        }),
      });

      if (!apiRes.ok) {
        const errText = await apiRes.text();
        console.error('Erro na moderação de frame (Groq):', apiRes.status, errText);
        return res.json({ flagged: false, error: true });
      }

      const data = await apiRes.json();
      const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '{}';
      let parsed = {};
      try {
        const match = text.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(match ? match[0] : text);
      } catch (_) {
        parsed = {};
      }

      if (parsed.flagged) {
        const id = uuidv4();
        await db.run(
          'INSERT INTO flagged_frames (id, channel_id, user_id, username, reason, categories) VALUES (?, ?, ?, ?, ?, ?)',
          [
            id,
            channelId || null,
            req.user.id,
            req.user.username,
            parsed.reason || null,
            JSON.stringify(parsed.categories || []),
          ]
        );
        // Avisa admins conectados na hora — a ação de verdade (banir, encerrar
        // a call) fica com um humano revisando no painel, nunca automática.
        io.emit('moderation:frame-flagged', {
          username: req.user.username,
          reason: parsed.reason || 'conteúdo sinalizado',
        });
      }

      res.json({ flagged: !!parsed.flagged });
    } catch (err) {
      console.error('Erro ao moderar frame:', err);
      res.json({ flagged: false, error: true });
    }
  })
);

app.get(
  '/api/admin/flagged-frames',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await db.all('SELECT * FROM flagged_frames ORDER BY created_at DESC LIMIT 200'));
  })
);

app.post(
  '/api/admin/flagged-frames/:id/review',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    await db.run('UPDATE flagged_frames SET reviewed = 1 WHERE id = ?', [req.params.id]);
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
      'SELECT id, channel_id, user_id, username, content, edited, pinned, created_at FROM messages WHERE channel_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 50',
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

// Limpa todas as mensagens de um canal/DM de uma vez — poder de moderador,
// só pra admins do site (não é algo que qualquer usuário ou a IA pode fazer).
// Apaga por soft-delete (mesmo campo "deleted" do apagar individual), então
// fica no banco pra auditoria, só some da visualização normal.
app.post(
  '/api/channels/:id/clear',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    await db.run('UPDATE messages SET deleted = 1 WHERE channel_id = ?', [req.params.id]);
    io.to(req.params.id).emit('chat:cleared', { channel_id: req.params.id });
    res.json({ ok: true });
  })
);

// Confere se a pessoa pode gerenciar mensagens (fixar, apagar de outros) num
// canal — tanto salas de servidor quanto DMs (nas DMs, qualquer um dos dois
// participantes pode fixar/desfixar, já que não existe cargo lá).
async function canManageChannelMessages(channelId, user) {
  if (channelId.startsWith('dm::')) {
    const parts = channelId.split('::');
    return parts[1] === user.id || parts[2] === user.id;
  }
  const channel = await db.get('SELECT category FROM channels WHERE id = ?', [channelId]);
  if (!channel) return false;
  return hasServerPermission(channel.category, user, 'manage_channels');
}

// ---------- MENSAGENS FIXADAS ----------

app.post(
  '/api/messages/:id/pin',
  requireAuth,
  asyncHandler(async (req, res) => {
    const message = await db.get('SELECT id, channel_id FROM messages WHERE id = ? AND deleted = 0', [req.params.id]);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (!(await canManageChannelMessages(message.channel_id, req.user))) {
      return res.status(403).json({ error: 'Você não tem permissão pra fixar mensagens nesse canal' });
    }
    await db.run('UPDATE messages SET pinned = 1 WHERE id = ?', [message.id]);
    io.to(message.channel_id).emit('message:pinned', { id: message.id, channel_id: message.channel_id, pinned: true });
    res.json({ ok: true });
  })
);

app.post(
  '/api/messages/:id/unpin',
  requireAuth,
  asyncHandler(async (req, res) => {
    const message = await db.get('SELECT id, channel_id FROM messages WHERE id = ?', [req.params.id]);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (!(await canManageChannelMessages(message.channel_id, req.user))) {
      return res.status(403).json({ error: 'Você não tem permissão pra desfixar mensagens nesse canal' });
    }
    await db.run('UPDATE messages SET pinned = 0 WHERE id = ?', [message.id]);
    io.to(message.channel_id).emit('message:pinned', { id: message.id, channel_id: message.channel_id, pinned: false });
    res.json({ ok: true });
  })
);

app.get(
  '/api/channels/:id/pinned',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      'SELECT id, channel_id, user_id, username, content, created_at FROM messages WHERE channel_id = ? AND pinned = 1 AND deleted = 0 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(rows);
  })
);

// ---------- BUSCA DE MENSAGENS ----------

app.get(
  '/api/channels/:id/search',
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const rows = await db.all(
      `SELECT id, channel_id, user_id, username, content, created_at FROM messages
       WHERE channel_id = ? AND deleted = 0 AND content LIKE ? ORDER BY created_at DESC LIMIT 50`,
      [req.params.id, `%${q}%`]
    );
    res.json(rows);
  })
);

// ---------- SLOW MODE E CANAL SOMENTE-LEITURA ----------

app.patch(
  '/api/channels/:id/settings',
  requireAuth,
  asyncHandler(async (req, res) => {
    const channel = await db.get('SELECT id, category FROM channels WHERE id = ?', [req.params.id]);
    if (!channel) return res.status(404).json({ error: 'Canal não encontrado' });
    const canManage = await hasServerPermission(channel.category, req.user, 'manage_channels');
    if (!canManage) return res.status(403).json({ error: 'Você não tem permissão pra configurar esse canal' });

    const { slow_mode_seconds, read_only } = req.body || {};
    if (typeof slow_mode_seconds === 'number') {
      const clamped = Math.max(0, Math.min(21600, Math.floor(slow_mode_seconds)));
      await db.run('UPDATE channels SET slow_mode_seconds = ? WHERE id = ?', [clamped, channel.id]);
    }
    if (typeof read_only === 'boolean') {
      await db.run('UPDATE channels SET read_only = ? WHERE id = ?', [read_only ? 1 : 0, channel.id]);
    }
    const updated = await db.get('SELECT id, slow_mode_seconds, read_only FROM channels WHERE id = ?', [channel.id]);
    io.to(channel.id).emit('channel:settings-updated', updated);
    res.json(updated);
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
        'SELECT id, username, avatar, avatar_frame, status_message, is_admin FROM users WHERE is_banned = 0 AND id != ? ORDER BY username',
        [AI_BOT_USER_ID]
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
const slowModeLastMessage = new Map(); // "channelId::userId" -> timestamp da última mensagem

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

  // Sala pessoal (uma por usuário, todas as abas/conexões dele) — usada pra
  // mandar notificações direcionadas, tipo "alguém está te ligando".
  socket.join('user:' + user.id);

  // Entra numa sala por servidor do qual é membro — usada só pra avisar "tem
  // mensagem nova em algum canal desse servidor" (badge de não lida no
  // trilho lateral), sem precisar estar com aquele canal aberto de verdade.
  db.all('SELECT category FROM server_members WHERE user_id = ?', [user.id])
    .then((rows) => rows.forEach((r) => socket.join('server:' + r.category)))
    .catch((err) => console.error('Erro ao entrar nas salas de servidor:', err));

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

      // Canal somente-leitura e slow mode — só se aplicam a salas de
      // servidor de verdade (não a DMs, que não têm linha em "channels").
      // Admin do site e quem tem manage_channels passam direto por cima.
      if (!channelId.startsWith('dm::')) {
        const channelRow = await db.get('SELECT category, read_only, slow_mode_seconds FROM channels WHERE id = ?', [
          channelId,
        ]);
        if (channelRow) {
          const bypass = user.is_admin || (await hasServerPermission(channelRow.category, user, 'manage_channels'));
          if (channelRow.read_only && !bypass) {
            socket.emit('chat:blocked', { reason: 'Esse canal está em modo somente-leitura.', categories: [] });
            return;
          }
          if (channelRow.slow_mode_seconds > 0 && !bypass) {
            const key = channelId + '::' + user.id;
            const lastSentAt = slowModeLastMessage.get(key) || 0;
            const waitMs = channelRow.slow_mode_seconds * 1000 - (Date.now() - lastSentAt);
            if (waitMs > 0) {
              socket.emit('chat:blocked', {
                reason: `Modo lento ativo — aguarde ${Math.ceil(waitMs / 1000)}s pra mandar outra mensagem.`,
                categories: [],
              });
              return;
            }
            slowModeLastMessage.set(key, Date.now());
          }
        }
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

      // Avisa (só um evento leve, sem o conteúdo) todo mundo que é membro do
      // MESMO SERVIDOR desse canal, mesmo quem não está com ele aberto agora
      // — é o que acende o badge de não lida no ícone do trilho lateral.
      if (!channelId.startsWith('dm::')) {
        const parentChannel = await db.get('SELECT category FROM channels WHERE id = ?', [channelId]);
        if (parentChannel) {
          socket.to('server:' + parentChannel.category).emit('server:activity', {
            category: parentChannel.category,
            channel_id: channelId,
          });
        }
      }

      // Se essa DM é com o bot assistente de IA, gera a resposta dele.
      if (channelId.startsWith('dm::')) {
        const parts = channelId.split('::');
        const otherId = parts[1] === user.id ? parts[2] : parts[2] === user.id ? parts[1] : null;
        if (otherId === AI_BOT_USER_ID) {
          triggerAiReply(channelId, user).catch((err) => console.error('Erro ao gerar resposta da IA:', err));
        }
      }
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

  // Notifica a pessoa específica que alguém está ligando pra ela (DM de voz)
  // — só chega pras conexões dela, não é um broadcast geral.
  socket.on('dm:ring', ({ toUserId, channelId, fromUsername }) => {
    if (!toUserId || !channelId) return;
    io.to('user:' + toUserId).emit('dm:ring', {
      fromUsername: fromUsername || user.username,
      channelId,
    });
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
