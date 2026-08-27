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

// 100kb era pouco pra imagem em base64 (avatar/evidência de torneio somados
// ao resto do corpo da requisição já passam disso) — 700kb dá folga
// confortável sem abrir espaço pra abuso.
app.use(express.json({ limit: '700kb' }));
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

// ---------- MONITORAMENTO (painel de admin: dados, erros e lag) ----------
// Tudo guardado em memória (não no banco) de propósito — é só pra
// diagnóstico ao vivo, não histórico permanente, e assim não pesa o banco
// nem sobrevive a um redeploy (o que é o comportamento certo aqui).
const MAX_LOG_ENTRIES = 200;
const SLOW_REQUEST_MS = 800; // acima disso conta como "lento" (lag) no painel
const recentErrors = [];
const recentSlowRequests = [];
const requestTimestamps = []; // usado só pra calcular requisições/minuto
const REQUEST_TIMESTAMPS_WINDOW_MS = 5 * 60 * 1000;

function logError(source, err) {
  recentErrors.unshift({
    time: new Date().toISOString(),
    source,
    message: err && err.message ? err.message : String(err),
  });
  if (recentErrors.length > MAX_LOG_ENTRIES) recentErrors.length = MAX_LOG_ENTRIES;
}

function logSlowRequest(entry) {
  recentSlowRequests.unshift(entry);
  if (recentSlowRequests.length > MAX_LOG_ENTRIES) recentSlowRequests.length = MAX_LOG_ENTRIES;
}

// Mede quanto tempo cada requisição de API demora — é isso que alimenta o
// "lag" do painel. Roda em TODA requisição (custo desprezível: só marca
// tempo antes/depois), não só nas que dão erro.
app.use('/api/', (req, res, next) => {
  const start = process.hrtime.bigint();
  requestTimestamps.push(Date.now());
  // limpa entradas velhas de vez em quando pra não crescer pra sempre
  if (requestTimestamps.length > 5000) {
    const cutoff = Date.now() - REQUEST_TIMESTAMPS_WINDOW_MS;
    while (requestTimestamps.length && requestTimestamps[0] < cutoff) requestTimestamps.shift();
  }
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    if (durationMs >= SLOW_REQUEST_MS) {
      logSlowRequest({
        time: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Math.round(durationMs),
      });
    }
  });
  next();
});

// Envolve handlers async pra erros (ex: banco fora do ar) virarem uma
// resposta 500 normal em vez de derrubar o processo.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error(err);
      logError(req.method + ' ' + req.originalUrl, err);
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

// "Continuar conectado": se a pessoa NÃO marcou a caixinha, o cookie de
// sessão vira um cookie de sessão de verdade (sem Max-Age/Expires) — some
// quando o navegador fecha. Marcando, dura os 7 dias padrão. O front-end
// ainda decide, à parte, se tenta reaproveitar isso a cada carregamento de
// página (ver localStorage "ng_remember_me" em app.js) — os dois trabalham
// juntos pra nunca logar ninguém automaticamente sem ter pedido.
function applySessionDuration(req, remember) {
  if (!remember) {
    req.sessionOptions.maxAge = null;
  }
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
function createPending2FAToken(userId, remember) {
  const token = crypto.randomBytes(24).toString('hex');
  pending2FALogins.set(token, { userId, remember: !!remember, expires: Date.now() + PENDING_2FA_TTL_MS });
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

// Canal privado por cargo (item 5 do plano): sem nenhuma linha em
// channel_role_access, o canal é visível pra todo mundo do servidor, igual
// sempre foi. Com pelo menos uma linha, só quem tem um daqueles cargos (ou
// é dono/admin do site) enxerga/acessa — verificado aqui no backend, não só
// escondido na tela.
async function canAccessChannel(channel, user) {
  if (user.is_admin) return true;
  const restrictions = await db.all('SELECT role_id FROM channel_role_access WHERE channel_id = ?', [channel.id]);
  if (restrictions.length === 0) return true;
  const server = await db.get('SELECT owner_id FROM servers WHERE category = ?', [channel.category]);
  if (server && server.owner_id === user.id) return true;
  const myRoles = await db.all('SELECT role_id FROM server_member_roles WHERE category = ? AND user_id = ?', [
    channel.category,
    user.id,
  ]);
  const myRoleIds = new Set(myRoles.map((r) => r.role_id));
  return restrictions.some((r) => myRoleIds.has(r.role_id));
}

async function filterChannelsByAccess(channels, user) {
  const results = [];
  for (const ch of channels) {
    if (await canAccessChannel(ch, user)) results.push(ch);
  }
  return results;
}

async function requireChannelAccess(channelId, user) {
  // DM não é uma linha na tabela "channels" (o id já é "dm::userA::userB"),
  // então não passa pela checagem de canal de servidor — só confirma que
  // quem está pedindo é uma das duas pessoas da conversa.
  if (channelId.startsWith('dm::')) {
    const parts = channelId.split('::');
    if (parts[1] !== user.id && parts[2] !== user.id) {
      return { ok: false, status: 403, error: 'Você não tem acesso a essa conversa' };
    }
    return { ok: true, channel: { id: channelId, type: 'dm' } };
  }
  const channel = await db.get('SELECT * FROM channels WHERE id = ?', [channelId]);
  if (!channel) return { ok: false, status: 404, error: 'Canal não encontrado' };
  if (!(await canAccessChannel(channel, user))) {
    return { ok: false, status: 403, error: 'Você não tem acesso a esse canal' };
  }
  return { ok: true, channel };
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

// ---------- AUDIT LOG ----------
// Registra toda ação administrativa/de moderação de verdade (banir, expulsar,
// limpar canal, apagar mensagem de outro, mudar cargo, aplicar timeout) —
// nunca ações comuns do dia a dia de um usuário normal. Não é decorativo:
// aparece filtrável no painel admin (usuário, ação, tipo de alvo).
async function logAudit(actor, action, targetType, targetId, details) {
  try {
    await db.run(
      'INSERT INTO audit_logs (id, actor_id, actor_username, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        uuidv4(),
        actor ? actor.id : null,
        actor ? actor.username : null,
        action,
        targetType || null,
        targetId || null,
        details ? JSON.stringify(details) : null,
      ]
    );
  } catch (err) {
    console.error('Erro ao registrar audit log:', err);
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
  await grantCoins(userId, 25, `Recompensa desbloqueada: ${rewardKey}`);
}

// ---------- NEXT COINS (moeda virtual cosmética — nunca envolve dinheiro real) ----------

async function grantCoins(userId, amount, reason) {
  try {
    await db.run('UPDATE users SET coins = coins + ? WHERE id = ?', [amount, userId]);
    await db.run('INSERT INTO coin_transactions (id, user_id, amount, reason) VALUES (?, ?, ?, ?)', [
      uuidv4(),
      userId,
      amount,
      reason,
    ]);
  } catch (err) {
    console.error('Erro ao conceder NEXT Coins:', err);
  }
}

// ---------- AUTH ----------

app.post(
  '/api/register',
  authLimiter,
  asyncHandler(async (req, res) => {
    const {
      username,
      email,
      password,
      remember,
      full_name,
      avatar,
      country,
      language,
      favorite_games,
      platforms,
      preferred_rank,
      play_style,
    } = req.body || {};
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

    // Campos do assistente de cadastro (passos 2 e 3) — todos opcionais, só
    // enriquecem o perfil gamer desde o início. Favoritos/plataforma vêm como
    // array e são guardados como JSON (lista curta, não precisa de tabela própria).
    let avatarValue = null;
    if (typeof avatar === 'string' && avatar.length <= 350000 && (avatar.startsWith('data:image/') || avatar.startsWith('emoji:'))) {
      avatarValue = avatar;
    }
    const favoriteGamesValue =
      Array.isArray(favorite_games) && favorite_games.length > 0
        ? JSON.stringify(favorite_games.slice(0, 10).map((g) => String(g).slice(0, 40)))
        : null;
    const platformsValue =
      Array.isArray(platforms) && platforms.length > 0
        ? JSON.stringify(platforms.slice(0, 6).map((p) => String(p).slice(0, 20)))
        : null;

    // Não conta o usuário-bot da IA aqui, senão a primeira pessoa de verdade
    // que se cadastra nunca vira admin (o bot já ocupa a "vaga" de primeiro).
    const countRow = await db.get('SELECT COUNT(*) as c FROM users WHERE id != ?', [AI_BOT_USER_ID]);
    const isFirstUser = Number(countRow.c) === 0;
    const id = uuidv4();
    const password_hash = bcrypt.hashSync(password, 10);
    // email_verified fica 1 direto — sem etapa de confirmação por código, o
    // e-mail é salvo só como dado de cadastro (a pedido do usuário).
    await db.run(
      `INSERT INTO users (
        id, username, password_hash, email, email_verified, is_admin, avatar, full_name,
        country, language, favorite_games, platforms, preferred_rank, play_style
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        username,
        password_hash,
        email,
        isFirstUser ? 1 : 0,
        avatarValue,
        (full_name || '').slice(0, 80) || null,
        (country || '').slice(0, 60) || null,
        (language || '').slice(0, 40) || null,
        favoriteGamesValue,
        platformsValue,
        (preferred_rank || '').slice(0, 40) || null,
        ['competitivo', 'casual', 'ambos'].includes(play_style) ? play_style : null,
      ]
    );

    applySessionDuration(req, remember !== false);
    req.session.userId = id;
    req.session.sessionId = await createUserSession(id, req);
    res.json({ id, username, is_admin: isFirstUser ? 1 : 0 });

    // Cada conta começa sem nenhum servidor — igual Discord: cria o seu
    // próprio (dono desde o início) ou entra em outro só com convite/senha.
    // Antes toda conta nova entrava automático em "gamers"/"trabalho"; isso
    // foi removido a pedido — cada perfil fica isolado por padrão.
    postSystemMessage(WELCOME_CHANNEL_ID, `🎉 ${username} acabou de entrar no NEXT GAME! Dê as boas-vindas.`);
    updateStreakAndRewards({ id, login_streak: 0, longest_streak: 0, last_login_date: null }).catch(() => {});
  })
);

app.post(
  '/api/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { username, password, remember } = req.body || {};
    // Sem isso, um POST sem "username" (ex: campo com nome errado do lado do
    // cliente, ou requisição malformada) derrubava com 500 — o driver do
    // banco não aceita "undefined" como parâmetro de bind. Corrige a causa
    // em vez de só engolir o erro (item 9 da auditoria).
    if (!username || typeof username !== 'string' || !password) {
      return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
    }
    const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }
    if (user.is_banned) return res.status(403).json({ error: 'Esta conta foi banida' });

    // Conta com 2FA ligado: não loga direto — devolve um token temporário
    // que o cliente troca por uma sessão de verdade em /api/login/2fa,
    // depois de digitar o código do app autenticador.
    if (user.totp_enabled) {
      const tempToken = createPending2FAToken(user.id, remember === true);
      return res.json({ requires2fa: true, tempToken });
    }

    applySessionDuration(req, remember === true);
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
    applySessionDuration(req, pending.remember === true);
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
      region: req.user.region,
      language: req.user.language,
      bio: req.user.bio,
      reputation: req.user.reputation || 0,
      full_name: req.user.full_name,
      country: req.user.country,
      platforms: req.user.platforms ? JSON.parse(req.user.platforms) : [],
      favorite_games: req.user.favorite_games ? JSON.parse(req.user.favorite_games) : [],
      preferred_rank: req.user.preferred_rank,
      play_style: req.user.play_style,
      coins: req.user.coins || 0,
      presence_status: req.user.presence_status || 'online',
    });
  })
);

// ---------- SERVIDORES ICE (STUN/TURN) PRA CHAMADA DE VOZ/VÍDEO ----------
// Por que isso é um endpoint e não uma constante fixa no app.js: sem um
// servidor TURN, dois usuários atrás de NAT restritivo (comum em dado móvel,
// wifi de empresa/escola/faculdade) simplesmente NÃO CONSEGUEM se conectar
// direto — a chamada falha silenciosamente pra eles, mesmo com só 2 pessoas
// na sala. Isso é bem mais comum do que parece e é a causa nº1 de "call não
// conecta" que só acontece com ALGUMAS pessoas.
//
// O TURN_URL/TURN_USERNAME/TURN_CREDENTIAL abaixo podem ser trocados a
// qualquer momento nas variáveis de ambiente do Render (sem precisar
// reempacotar/redeploy do frontend) — assim que você criar sua própria conta
// grátis num provedor de TURN (metered.ca/Open Relay tem 20GB grátis/mês,
// sem cartão), só troca essas 3 variáveis. Enquanto isso não acontece, cai
// no relay público de testes do Open Relay Project (compartilhado com o
// mundo inteiro, então pode ficar lento/instável se muita gente usar ao
// mesmo tempo — ok pra um grupo de amigos, não pra produção séria).
app.get(
  '/api/ice-servers',
  requireAuth,
  asyncHandler(async (req, res) => {
    const servers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.relay.metered.ca:80' },
    ];
    const turnUrl = process.env.TURN_URL;
    if (turnUrl) {
      // Suporta uma ou várias URLs separadas por vírgula (ex: udp + tcp + tls)
      turnUrl.split(',').map((u) => u.trim()).filter(Boolean).forEach((urls) => {
        servers.push({ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
      });
    } else {
      // Sem TURN próprio configurado — usa o relay público gratuito do Open
      // Relay Project (credenciais de teste documentadas publicamente por
      // eles mesmos, não é nenhum segredo vazado). As 3 variantes cobrem
      // redes diferentes: UDP é o caminho mais rápido/comum; TCP porta 80 e
      // TLS porta 443 salvam quem está atrás de firewall bem restritivo
      // (rede de empresa/escola) que só libera as portas normais de web.
      [
        'turn:relay.metered.ca:80',
        'turn:relay.metered.ca:80?transport=tcp',
        'turns:relay.metered.ca:443?transport=tcp',
      ].forEach((urls) => {
        servers.push({ urls, username: 'openrelayproject', credential: 'openrelayproject' });
      });
    }
    res.json({ iceServers: servers, usingSharedRelay: !turnUrl });
  })
);

// Editar perfil: trocar senha (exige senha atual), e-mail, status "jogando" e/ou avatar.
app.patch(
  '/api/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const {
      email,
      password,
      currentPassword,
      status_message,
      avatar,
      avatar_frame,
      region,
      language,
      bio,
      full_name,
      country,
      platforms,
      favorite_games,
      preferred_rank,
      play_style,
      presence_status,
    } = req.body || {};

    if (typeof presence_status === 'string') {
      if (!['online', 'ausente', 'ocupado', 'invisivel'].includes(presence_status)) {
        return res.status(400).json({ error: 'Status inválido' });
      }
      await db.run('UPDATE users SET presence_status = ? WHERE id = ?', [presence_status, req.user.id]);
      setUserPresenceStatus(req.user.id, presence_status);
    }

    if (typeof full_name === 'string') {
      await db.run('UPDATE users SET full_name = ? WHERE id = ?', [full_name.trim().slice(0, 80) || null, req.user.id]);
    }
    if (typeof country === 'string') {
      await db.run('UPDATE users SET country = ? WHERE id = ?', [country.trim().slice(0, 60) || null, req.user.id]);
    }
    if (Array.isArray(platforms)) {
      await db.run('UPDATE users SET platforms = ? WHERE id = ?', [
        platforms.length ? JSON.stringify(platforms.slice(0, 6).map((p) => String(p).slice(0, 20))) : null,
        req.user.id,
      ]);
    }
    if (Array.isArray(favorite_games)) {
      await db.run('UPDATE users SET favorite_games = ? WHERE id = ?', [
        favorite_games.length ? JSON.stringify(favorite_games.slice(0, 10).map((g) => String(g).slice(0, 40))) : null,
        req.user.id,
      ]);
    }
    if (typeof preferred_rank === 'string') {
      await db.run('UPDATE users SET preferred_rank = ? WHERE id = ?', [
        preferred_rank.trim().slice(0, 40) || null,
        req.user.id,
      ]);
    }
    if (typeof play_style === 'string' && ['competitivo', 'casual', 'ambos', ''].includes(play_style)) {
      await db.run('UPDATE users SET play_style = ? WHERE id = ?', [play_style || null, req.user.id]);
    }

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

    if (typeof region === 'string') {
      await db.run('UPDATE users SET region = ? WHERE id = ?', [region.trim().slice(0, 40) || null, req.user.id]);
    }
    if (typeof language === 'string') {
      await db.run('UPDATE users SET language = ? WHERE id = ?', [language.trim().slice(0, 40) || null, req.user.id]);
    }
    if (typeof bio === 'string') {
      if (bio.length > 300) return res.status(400).json({ error: 'Bio precisa ter no máximo 300 caracteres' });
      await db.run('UPDATE users SET bio = ? WHERE id = ?', [bio.trim() || null, req.user.id]);
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
      region: updated.region,
      language: updated.language,
      bio: updated.bio,
      full_name: updated.full_name,
      country: updated.country,
      platforms: updated.platforms ? JSON.parse(updated.platforms) : [],
      favorite_games: updated.favorite_games ? JSON.parse(updated.favorite_games) : [],
      preferred_rank: updated.preferred_rank,
      play_style: updated.play_style,
      presence_status: updated.presence_status,
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

// Perfil público — versão segura pra ver o perfil de QUALQUER pessoa (não só
// o seu), sem expor dados sensíveis (e-mail, senha etc). Usado na tela de
// perfil completo (banner, nível, troféus, conquistas).
app.get(
  '/api/users/:id/profile',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await db.get(
      `SELECT id, username, avatar, avatar_frame, status_message, is_admin, bio, country, language,
        region, reputation, points, login_streak, longest_streak, created_at, favorite_games, platforms,
        preferred_rank, play_style
       FROM users WHERE id = ? AND is_banned = 0`,
      [req.params.id]
    );
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    const messageCount = await db.get('SELECT COUNT(*) as c FROM messages WHERE user_id = ? AND deleted = 0', [
      user.id,
    ]);
    const rewardCount = await db.get('SELECT COUNT(*) as c FROM user_rewards WHERE user_id = ?', [user.id]);
    const tournamentWins = await db.get(
      "SELECT COUNT(*) as c FROM feed_posts WHERE user_id = ? AND type = 'tournament_win'",
      [user.id]
    );
    res.json({
      ...user,
      favorite_games: user.favorite_games ? JSON.parse(user.favorite_games) : [],
      platforms: user.platforms ? JSON.parse(user.platforms) : [],
      message_count: Number(messageCount.c),
      badge_count: Number(rewardCount.c),
      tournament_wins: Number(tournamentWins.c),
      level: Math.max(1, Math.floor(Number(messageCount.c) / 10) + 1),
    });
  })
);

// ---------- PERFIL GAMER (por jogo) ----------

app.get(
  '/api/game-profiles/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.all('SELECT * FROM game_profiles WHERE user_id = ? ORDER BY hours DESC', [
      req.params.userId,
    ]);
    res.json(rows);
  })
);

app.put(
  '/api/me/game-profiles/:game',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = String(req.params.game || '').trim().slice(0, 60);
    if (!game) return res.status(400).json({ error: 'Jogo inválido' });
    const { rank, role, hours, wins, losses, kills, deaths, assists } = req.body || {};
    const clampInt = (v) => Math.max(0, Math.min(999999, parseInt(v, 10) || 0));
    const existing = await db.get('SELECT id FROM game_profiles WHERE user_id = ? AND game = ?', [
      req.user.id,
      game,
    ]);
    if (existing) {
      await db.run(
        `UPDATE game_profiles SET rank = ?, role = ?, hours = ?, wins = ?, losses = ?, kills = ?, deaths = ?, assists = ?
         WHERE id = ?`,
        [
          rank || null,
          role || null,
          clampInt(hours),
          clampInt(wins),
          clampInt(losses),
          clampInt(kills),
          clampInt(deaths),
          clampInt(assists),
          existing.id,
        ]
      );
    } else {
      await db.run(
        `INSERT INTO game_profiles (id, user_id, game, rank, role, hours, wins, losses, kills, deaths, assists)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          req.user.id,
          game,
          rank || null,
          role || null,
          clampInt(hours),
          clampInt(wins),
          clampInt(losses),
          clampInt(kills),
          clampInt(deaths),
          clampInt(assists),
        ]
      );
    }
    res.json(await db.get('SELECT * FROM game_profiles WHERE user_id = ? AND game = ?', [req.user.id, game]));
  })
);

app.delete(
  '/api/me/game-profiles/:game',
  requireAuth,
  asyncHandler(async (req, res) => {
    await db.run('DELETE FROM game_profiles WHERE user_id = ? AND game = ?', [req.user.id, req.params.game]);
    res.json({ ok: true });
  })
);

// ---------- LFG (PROCURANDO JOGADORES) + MATCHMAKING INTELIGENTE ----------

// Compatibilidade simples entre a pessoa e um post de LFG: soma pontos por
// região, idioma, microfone e rank em comum, normalizada em 0-100%. Não é
// nenhum modelo sofisticado — só uma pontuação transparente e explicável.
function computeCompatibility(user, post) {
  let score = 0;
  let max = 0;

  max += 30;
  if (post.region) {
    if (user.region && user.region.toLowerCase() === post.region.toLowerCase()) score += 30;
  } else {
    score += 15;
  }

  max += 25;
  if (post.language) {
    if (user.language && user.language.toLowerCase() === post.language.toLowerCase()) score += 25;
  } else {
    score += 12;
  }

  max += 20;
  if (post.mic_required === 'opcional') score += 20;
  // se for obrigatório, não temos como confirmar client-side se a pessoa tem mic — dá metade do ponto.
  else score += 10;

  max += 25;
  if (post.rank_min || post.rank_max) score += 12; // não temos ranking cross-game pra comparar de verdade
  else score += 25;

  return Math.round((score / max) * 100);
}

app.get(
  '/api/lfg',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { game } = req.query;
    const conditions = ['active = 1'];
    const params = [];
    if (game) {
      conditions.push('game = ?');
      params.push(game);
    }
    const posts = await db.all(
      `SELECT * FROM lfg_posts WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 100`,
      params
    );
    const userIds = [...new Set(posts.map((p) => p.user_id))];
    const authors = userIds.length
      ? await db.all(
          `SELECT id, username, avatar, avatar_frame, region, language FROM users WHERE id IN (${userIds
            .map(() => '?')
            .join(',')})`,
          userIds
        )
      : [];
    const authorMap = Object.fromEntries(authors.map((a) => [a.id, a]));

    const withCompat = await Promise.all(
      posts.map(async (p) => {
        const memberCount = await db.get('SELECT COUNT(*) as c FROM lfg_group_members WHERE post_id = ?', [p.id]);
        return {
          ...p,
          author: authorMap[p.user_id] || null,
          compatibility: computeCompatibility(req.user, p),
          member_count: Number(memberCount.c) + 1, // +1 = quem criou o post
        };
      })
    );
    withCompat.sort((a, b) => b.compatibility - a.compatibility);
    res.json(withCompat);
  })
);

app.post(
  '/api/lfg',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { game, players_needed, rank_min, rank_max, region, language, mic_required, role, available_time, note } =
      req.body || {};
    if (!game || typeof game !== 'string' || !game.trim()) {
      return res.status(400).json({ error: 'Escolha um jogo' });
    }
    const id = uuidv4();
    await db.run(
      `INSERT INTO lfg_posts (id, user_id, game, players_needed, rank_min, rank_max, region, language, mic_required, role, available_time, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        req.user.id,
        game.trim().slice(0, 60),
        Math.max(1, Math.min(20, parseInt(players_needed, 10) || 1)),
        rank_min || null,
        rank_max || null,
        region || null,
        language || null,
        ['obrigatorio', 'opcional'].includes(mic_required) ? mic_required : 'opcional',
        role || null,
        available_time || null,
        (note || '').slice(0, 300),
      ]
    );
    res.json(await db.get('SELECT * FROM lfg_posts WHERE id = ?', [id]));
  })
);

app.delete(
  '/api/lfg/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const post = await db.get('SELECT user_id FROM lfg_posts WHERE id = ?', [req.params.id]);
    if (!post) return res.status(404).json({ error: 'Post não encontrado' });
    if (post.user_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: 'Só quem criou pode fechar esse post' });
    }
    await db.run('UPDATE lfg_posts SET active = 0 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  })
);

app.post(
  '/api/lfg/:id/join',
  requireAuth,
  asyncHandler(async (req, res) => {
    const post = await db.get('SELECT * FROM lfg_posts WHERE id = ? AND active = 1', [req.params.id]);
    if (!post) return res.status(404).json({ error: 'Post não encontrado ou já fechado' });
    if (post.user_id === req.user.id) return res.status(400).json({ error: 'Esse post é seu' });
    await db.run('INSERT OR IGNORE INTO lfg_group_members (id, post_id, user_id) VALUES (?, ?, ?)', [
      uuidv4(),
      post.id,
      req.user.id,
    ]);
    res.json({ ok: true });
  })
);

app.get(
  '/api/lfg/:id/members',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      `SELECT u.id, u.username, u.avatar, u.avatar_frame FROM lfg_group_members m
       JOIN users u ON u.id = m.user_id WHERE m.post_id = ?`,
      [req.params.id]
    );
    res.json(rows);
  })
);

// ---------- TIMES ----------

app.post(
  '/api/teams',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name, description, game, logo } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ error: 'Nome do time precisa ter pelo menos 2 caracteres' });
    }
    const existing = await db.get('SELECT id FROM teams WHERE name = ?', [name.trim()]);
    if (existing) return res.status(409).json({ error: 'Já existe um time com esse nome' });
    const id = uuidv4();
    await db.run('INSERT INTO teams (id, name, description, game, logo, leader_id) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      name.trim().slice(0, 60),
      (description || '').slice(0, 500),
      (game || '').slice(0, 60),
      logo || null,
      req.user.id,
    ]);
    await db.run('INSERT INTO team_members (id, team_id, user_id, role) VALUES (?, ?, ?, ?)', [
      uuidv4(),
      id,
      req.user.id,
      'lider',
    ]);
    createFeedPost(req.user, 'team_created', `criou o time "${name.trim()}"`, 'team', id);
    res.json(await db.get('SELECT * FROM teams WHERE id = ?', [id]));
  })
);

app.get(
  '/api/teams/mine',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      `SELECT t.*, tm.role as my_role FROM teams t
       JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ?`,
      [req.user.id]
    );
    res.json(rows);
  })
);

app.get(
  '/api/teams/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await db.get('SELECT * FROM teams WHERE id = ?', [req.params.id]);
    if (!team) return res.status(404).json({ error: 'Time não encontrado' });
    const members = await db.all(
      `SELECT u.id, u.username, u.avatar, u.avatar_frame, tm.role FROM team_members tm
       JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? ORDER BY tm.role`,
      [team.id]
    );
    res.json({ ...team, members });
  })
);

app.post(
  '/api/teams/:id/invite',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await db.get('SELECT * FROM teams WHERE id = ?', [req.params.id]);
    if (!team) return res.status(404).json({ error: 'Time não encontrado' });
    if (team.leader_id !== req.user.id) return res.status(403).json({ error: 'Só o líder pode convidar' });
    const { username, role } = req.body || {};
    const target = await db.get('SELECT id FROM users WHERE username = ?', [String(username || '').trim()]);
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
    await db.run('INSERT OR IGNORE INTO team_members (id, team_id, user_id, role) VALUES (?, ?, ?, ?)', [
      uuidv4(),
      team.id,
      target.id,
      ['jogador', 'reserva', 'coach'].includes(role) ? role : 'jogador',
    ]);
    res.json({ ok: true });
  })
);

app.delete(
  '/api/teams/:id/members/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await db.get('SELECT * FROM teams WHERE id = ?', [req.params.id]);
    if (!team) return res.status(404).json({ error: 'Time não encontrado' });
    if (team.leader_id !== req.user.id && req.params.userId !== req.user.id) {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    if (req.params.userId === team.leader_id) return res.status(400).json({ error: 'O líder não pode sair — exclua o time' });
    await db.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', [team.id, req.params.userId]);
    res.json({ ok: true });
  })
);

app.delete(
  '/api/teams/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await db.get('SELECT * FROM teams WHERE id = ?', [req.params.id]);
    if (!team) return res.status(404).json({ error: 'Time não encontrado' });
    if (team.leader_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Sem permissão' });
    await db.run('DELETE FROM team_members WHERE team_id = ?', [team.id]);
    await db.run('DELETE FROM teams WHERE id = ?', [team.id]);
    res.json({ ok: true });
  })
);

// ---------- CLÃS ----------

app.post(
  '/api/clans',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name, description } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ error: 'Nome do clã precisa ter pelo menos 2 caracteres' });
    }
    const existing = await db.get('SELECT id FROM clans WHERE name = ?', [name.trim()]);
    if (existing) return res.status(409).json({ error: 'Já existe um clã com esse nome' });
    const id = uuidv4();
    await db.run('INSERT INTO clans (id, name, description, created_by) VALUES (?, ?, ?, ?)', [
      id,
      name.trim().slice(0, 60),
      (description || '').slice(0, 500),
      req.user.id,
    ]);
    await db.run('INSERT INTO clan_members (id, clan_id, user_id, role) VALUES (?, ?, ?, ?)', [
      uuidv4(),
      id,
      req.user.id,
      'lider',
    ]);
    createFeedPost(req.user, 'clan_created', `fundou o clã "${name.trim()}"`, 'clan', id);
    res.json(await db.get('SELECT * FROM clans WHERE id = ?', [id]));
  })
);

app.get(
  '/api/clans',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM clan_members WHERE clan_id = c.id) as member_count FROM clans c ORDER BY c.level DESC, c.created_at DESC LIMIT 100`
    );
    res.json(rows);
  })
);

app.get(
  '/api/clans/mine',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      `SELECT c.*, cm.role as my_role FROM clans c JOIN clan_members cm ON cm.clan_id = c.id WHERE cm.user_id = ?`,
      [req.user.id]
    );
    res.json(rows);
  })
);

app.get(
  '/api/clans/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const clan = await db.get('SELECT * FROM clans WHERE id = ?', [req.params.id]);
    if (!clan) return res.status(404).json({ error: 'Clã não encontrado' });
    const members = await db.all(
      `SELECT u.id, u.username, u.avatar, u.avatar_frame, cm.role FROM clan_members cm
       JOIN users u ON u.id = cm.user_id WHERE cm.clan_id = ? ORDER BY cm.role`,
      [clan.id]
    );
    res.json({ ...clan, members });
  })
);

// Clãs são abertos por padrão (qualquer um entra) — mais simples que um
// sistema de convite/aprovação separado, e cobre o "disputas entre clãs" do
// plano sem exigir uma camada extra de moderação de entrada.
app.post(
  '/api/clans/:id/join',
  requireAuth,
  asyncHandler(async (req, res) => {
    const clan = await db.get('SELECT id FROM clans WHERE id = ?', [req.params.id]);
    if (!clan) return res.status(404).json({ error: 'Clã não encontrado' });
    await db.run('INSERT OR IGNORE INTO clan_members (id, clan_id, user_id, role) VALUES (?, ?, ?, ?)', [
      uuidv4(),
      clan.id,
      req.user.id,
      'membro',
    ]);
    res.json({ ok: true });
  })
);

app.delete(
  '/api/clans/:id/members/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const clan = await db.get('SELECT * FROM clans WHERE id = ?', [req.params.id]);
    if (!clan) return res.status(404).json({ error: 'Clã não encontrado' });
    const myRow = await db.get('SELECT role FROM clan_members WHERE clan_id = ? AND user_id = ?', [
      clan.id,
      req.user.id,
    ]);
    const canManage = req.user.is_admin || (myRow && myRow.role === 'lider');
    if (!canManage && req.params.userId !== req.user.id) return res.status(403).json({ error: 'Sem permissão' });
    await db.run('DELETE FROM clan_members WHERE clan_id = ? AND user_id = ?', [clan.id, req.params.userId]);
    res.json({ ok: true });
  })
);

// ---------- REPUTAÇÃO ----------
// Endosso simples entre jogadores (uma vez por par de pessoas) — reflete
// "comportamento de equipe" sem precisar de um sistema de denúncia completo.
app.post(
  '/api/users/:id/endorse',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Não dá pra endossar a si mesmo' });
    const target = await db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
    const existing = await db.get(
      'SELECT id FROM reputation_endorsements WHERE from_user_id = ? AND to_user_id = ?',
      [req.user.id, req.params.id]
    );
    if (existing) return res.status(409).json({ error: 'Você já endossou essa pessoa' });
    await db.run('INSERT INTO reputation_endorsements (id, from_user_id, to_user_id) VALUES (?, ?, ?)', [
      uuidv4(),
      req.user.id,
      req.params.id,
    ]);
    await db.run('UPDATE users SET reputation = reputation + 1 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
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
    await grantCoins(req.user.id, mission.points * 2, `Missão concluída: ${mission.name}`);
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
    const channels = await db.all(
      `SELECT * FROM channels WHERE category IN (${placeholders}) ORDER BY category, type, name`,
      categories
    );
    const visible = await filterChannelsByAccess(channels, req.user);
    res.json(visible);
  })
);

// Criar um SERVIDOR novo — separado de criar uma sala. Quem cria vira dono
// automaticamente, já entra como membro, e ganha um canal #geral padrão pra
// ter onde conversar assim que entra (não precisa criar a primeira sala à mão).
app.post(
  '/api/servers',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name, icon } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 40) {
      return res.status(400).json({ error: 'Nome do servidor precisa ter entre 2 e 40 caracteres' });
    }
    const cleanCategory = name.trim().slice(0, 40);
    const existing = await db.get('SELECT category FROM servers WHERE category = ?', [cleanCategory]);
    if (existing) return res.status(400).json({ error: 'Já existe um servidor com esse nome' });

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

    const channelId = uuidv4();
    await db.run('INSERT INTO channels (id, name, category, type, created_by) VALUES (?, ?, ?, ?, ?)', [
      channelId,
      'geral',
      cleanCategory,
      'texto',
      req.user.id,
    ]);

    res.json({ category: cleanCategory, channelId, invite_code: inviteCode });
  })
);

// Criar uma sala DENTRO de um servidor que já existe. Precisa ser membro e
// ter permissão de gerenciar canais (dono sempre tem; nos servidores padrão
// sem dono, qualquer membro tem). Não cria mais servidor implicitamente —
// isso agora é sempre via POST /api/servers.
const VOICE_TYPES = ['conversa', 'jogo', 'evento'];

app.post(
  '/api/channels',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name, category, type, voice_type, voice_game } = req.body || {};
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
    // Sala de voz pode ser "conversa normal", "vinculada a um jogo" ou
    // "evento/torneio" — só faz sentido pra canais de voz.
    let cleanVoiceType = 'conversa';
    let cleanVoiceGame = null;
    if (type === 'voz') {
      if (voice_type && !VOICE_TYPES.includes(voice_type)) {
        return res.status(400).json({ error: 'Tipo de sala de voz inválido' });
      }
      cleanVoiceType = voice_type || 'conversa';
      if (cleanVoiceType === 'jogo') {
        if (!voice_game || typeof voice_game !== 'string' || !voice_game.trim()) {
          return res.status(400).json({ error: 'Escolha o jogo dessa sala de voz' });
        }
        cleanVoiceGame = voice_game.trim().slice(0, 40);
      }
    }

    const cleanName = name.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    const cleanCategory = category.trim().slice(0, 40);

    const existingServer = await db.get('SELECT category FROM servers WHERE category = ?', [cleanCategory]);
    if (!existingServer) {
      return res
        .status(400)
        .json({ error: 'Esse servidor ainda não existe. Crie o servidor primeiro em "+ Criar Servidor".' });
    }
    const isMember = await isServerMember(cleanCategory, req.user.id);
    if (!isMember) return res.status(403).json({ error: 'Você precisa ser membro desse servidor pra criar salas nele' });
    const canManage = await hasServerPermission(cleanCategory, req.user, 'manage_channels');
    if (!canManage) return res.status(403).json({ error: 'Você não tem permissão pra criar salas nesse servidor' });

    const id = uuidv4();
    await db.run(
      'INSERT INTO channels (id, name, category, type, created_by, voice_type, voice_game) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, cleanName, cleanCategory, type, req.user.id, cleanVoiceType, cleanVoiceGame]
    );

    res.json({ id, name: cleanName, category: cleanCategory, type, voice_type: cleanVoiceType, voice_game: cleanVoiceGame });
  })
);

// Sala Rápida: um clique cria uma sala de voz temporária no servidor ativo,
// que se apaga sozinha quando o último participante sai (ver rtc:leave e a
// desconexão de socket mais abaixo).
app.post(
  '/api/channels/quick',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { category } = req.body || {};
    if (!category || typeof category !== 'string' || !category.trim()) {
      return res.status(400).json({ error: 'Servidor inválido' });
    }
    const cleanCategory = category.trim().slice(0, 40);
    const isMember = await isServerMember(cleanCategory, req.user.id);
    if (!isMember) return res.status(403).json({ error: 'Você precisa ser membro desse servidor' });

    const id = uuidv4();
    const shortId = id.slice(0, 4);
    const cleanName = `sala-rapida-${shortId}`;
    await db.run(
      'INSERT INTO channels (id, name, category, type, created_by, voice_type, is_quick) VALUES (?, ?, ?, ?, ?, ?, 1)',
      [id, cleanName, cleanCategory, 'voz', req.user.id, 'conversa']
    );

    res.json({ id, name: cleanName, category: cleanCategory, type: 'voz', is_quick: true });
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
// Confere se um convite ainda vale: existe, não foi revogado, não expirou
// e não bateu no limite de usos. Devolve um motivo legível quando não vale,
// pra mostrar pro usuário em vez de um genérico "convite inválido".
function inviteValidity(server) {
  if (!server) return { ok: false, reason: 'Convite inválido ou expirado' };
  if (!server.invite_active) return { ok: false, reason: 'Esse convite foi revogado por quem administra o servidor' };
  if (server.invite_expires_at && new Date(server.invite_expires_at) < new Date()) {
    return { ok: false, reason: 'Esse convite expirou' };
  }
  if (server.invite_max_uses != null && server.invite_uses >= server.invite_max_uses) {
    return { ok: false, reason: 'Esse convite já atingiu o limite de usos' };
  }
  return { ok: true };
}

app.get(
  '/api/invite/:code',
  asyncHandler(async (req, res) => {
    const server = await db.get(
      'SELECT category, icon, description, invite_active, invite_expires_at, invite_max_uses, invite_uses FROM servers WHERE invite_code = ?',
      [req.params.code]
    );
    const validity = inviteValidity(server);
    if (!validity.ok) return res.status(404).json({ error: validity.reason });
    const countRow = await db.get('SELECT COUNT(*) as c FROM server_members WHERE category = ?', [server.category]);
    res.json({
      category: server.category,
      icon: server.icon,
      description: server.description,
      member_count: Number(countRow.c),
    });
  })
);

app.post(
  '/api/invite/:code/join',
  requireAuth,
  asyncHandler(async (req, res) => {
    const server = await db.get(
      'SELECT category, access_mode, invite_active, invite_expires_at, invite_max_uses, invite_uses FROM servers WHERE invite_code = ?',
      [req.params.code]
    );
    const validity = inviteValidity(server);
    if (!validity.ok) return res.status(404).json({ error: validity.reason });
    if (server.access_mode === 'senha') {
      // Dono trocou pra modo senha — o link de convite antigo para de valer,
      // já que os dois modos são mutuamente exclusivos.
      return res.status(400).json({
        error: 'Esse servidor agora usa senha em vez de convite. Peça a senha pra quem administra.',
      });
    }
    const result = await db.run(
      'INSERT OR IGNORE INTO server_members (id, category, user_id) VALUES (?, ?, ?)',
      [uuidv4(), server.category, req.user.id]
    );
    // Só conta uso se a pessoa realmente entrou agora (não recontava se já
    // era membro e clicou no link de novo).
    if (result.changes > 0) {
      await db.run('UPDATE servers SET invite_uses = invite_uses + 1 WHERE category = ?', [server.category]);
    }
    res.json({ category: server.category });
  })
);

// Entrar num servidor por senha (alternativa ao convite, item 6 do plano) —
// só precisa saber o nome do servidor e a senha, não precisa de link.
app.post(
  '/api/servers/:category/join-by-password',
  authLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    const server = await db.get('SELECT category, access_mode, password_hash FROM servers WHERE category = ?', [
      req.params.category,
    ]);
    if (!server || server.access_mode !== 'senha' || !server.password_hash) {
      return res.status(404).json({ error: 'Servidor não encontrado ou não usa senha' });
    }
    const { password } = req.body || {};
    if (!password || !bcrypt.compareSync(String(password), server.password_hash)) {
      return res.status(403).json({ error: 'Senha incorreta' });
    }
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
    const server = await db.get(
      'SELECT invite_code, invite_expires_at, invite_max_uses, invite_uses, invite_active FROM servers WHERE category = ?',
      [req.params.category]
    );
    if (!server) return res.status(404).json({ error: 'Servidor não encontrado' });
    res.json(server);
  })
);

app.post(
  '/api/servers/:category/invite/regenerate',
  requireAuth,
  asyncHandler(async (req, res) => {
    const canManage = await hasServerPermission(req.params.category, req.user, 'manage_server');
    if (!canManage) return res.status(403).json({ error: 'Você não tem permissão pra gerenciar esse servidor' });
    const newCode = generateInviteCode();
    // Gerar um código novo reseta os contadores e reativa — é um convite
    // novo de verdade, não faz sentido carregar o uso/expiração do anterior.
    await db.run(
      "UPDATE servers SET invite_code = ?, invite_uses = 0, invite_active = 1, invite_expires_at = NULL, invite_max_uses = NULL WHERE category = ?",
      [newCode, req.params.category]
    );
    logAudit(req.user, 'regenerate_invite', 'server', req.params.category, {});
    res.json({ invite_code: newCode });
  })
);

// Revoga o convite sem gerar um código novo — o link atual simplesmente
// para de funcionar até alguém reativar ou regenerar.
app.post(
  '/api/servers/:category/invite/revoke',
  requireAuth,
  asyncHandler(async (req, res) => {
    const canManage = await hasServerPermission(req.params.category, req.user, 'manage_server');
    if (!canManage) return res.status(403).json({ error: 'Você não tem permissão pra gerenciar esse servidor' });
    await db.run('UPDATE servers SET invite_active = 0 WHERE category = ?', [req.params.category]);
    logAudit(req.user, 'revoke_invite', 'server', req.params.category, {});
    res.json({ ok: true });
  })
);

app.post(
  '/api/servers/:category/invite/reactivate',
  requireAuth,
  asyncHandler(async (req, res) => {
    const canManage = await hasServerPermission(req.params.category, req.user, 'manage_server');
    if (!canManage) return res.status(403).json({ error: 'Você não tem permissão pra gerenciar esse servidor' });
    await db.run('UPDATE servers SET invite_active = 1 WHERE category = ?', [req.params.category]);
    res.json({ ok: true });
  })
);

// Define validade e/ou limite de usos do convite atual (item 4 do plano).
// minutes_valid: null = nunca expira. max_uses: null = usos ilimitados.
app.patch(
  '/api/servers/:category/invite',
  requireAuth,
  asyncHandler(async (req, res) => {
    const canManage = await hasServerPermission(req.params.category, req.user, 'manage_server');
    if (!canManage) return res.status(403).json({ error: 'Você não tem permissão pra gerenciar esse servidor' });
    const { minutes_valid, max_uses } = req.body || {};

    let expiresAt = null;
    if (minutes_valid !== undefined && minutes_valid !== null && minutes_valid !== '') {
      const minutes = Number(minutes_valid);
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60 * 24 * 365) {
        return res.status(400).json({ error: 'Validade inválida' });
      }
      expiresAt = new Date(Date.now() + minutes * 60000).toISOString();
    }

    let maxUses = null;
    if (max_uses !== undefined && max_uses !== null && max_uses !== '') {
      const uses = Number(max_uses);
      if (!Number.isInteger(uses) || uses < 1 || uses > 100000) {
        return res.status(400).json({ error: 'Limite de usos inválido' });
      }
      maxUses = uses;
    }

    await db.run('UPDATE servers SET invite_expires_at = ?, invite_max_uses = ? WHERE category = ?', [
      expiresAt,
      maxUses,
      req.params.category,
    ]);
    res.json({ invite_expires_at: expiresAt, invite_max_uses: maxUses });
  })
);

// ---------- EXPLORAR SERVIDORES (descoberta pública) ----------
// Precisa vir ANTES de '/api/servers/:category' — senão o Express casa
// "discover" como se fosse o nome de uma categoria (rota genérica captura
// primeiro quem for registrada primeiro). Só servidores que o dono marcou
// como "descobrível" aparecem aqui — o padrão continua sendo privado.
app.get(
  '/api/servers/discover',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { game, q } = req.query;
    const rows = await db.all(
      `SELECT s.category, s.icon, s.description,
        (SELECT COUNT(*) FROM server_members WHERE category = s.category) as member_count,
        (SELECT COUNT(*) FROM channels WHERE category = s.category AND type = 'texto') as text_channels,
        (SELECT COUNT(*) FROM channels WHERE category = s.category AND type = 'voz') as voice_channels
       FROM servers s WHERE s.discoverable = 1 ORDER BY member_count DESC LIMIT 100`
    );
    const myMemberships = await db.all('SELECT category FROM server_members WHERE user_id = ?', [req.user.id]);
    const myCategories = new Set(myMemberships.map((m) => m.category));
    let filtered = rows.map((r) => ({ ...r, is_member: myCategories.has(r.category) }));
    if (q) {
      const term = String(q).toLowerCase();
      filtered = filtered.filter((r) => r.category.toLowerCase().includes(term));
    }
    if (game) {
      filtered = filtered.filter((r) => r.category.toLowerCase().includes(String(game).toLowerCase()));
    }
    res.json(filtered);
  })
);

// Entrar direto (sem código de convite) num servidor que o dono deixou
// descobrível — o mesmo servidor continua exigindo convite pra quem não
// achou ele por aqui, já que descoberta pública é opt-in por servidor.
app.post(
  '/api/servers/discover/:category/join',
  requireAuth,
  asyncHandler(async (req, res) => {
    const server = await db.get('SELECT category FROM servers WHERE category = ? AND discoverable = 1', [
      req.params.category,
    ]);
    if (!server) return res.status(404).json({ error: 'Servidor não encontrado ou não é público' });
    await db.run('INSERT OR IGNORE INTO server_members (id, category, user_id) VALUES (?, ?, ?)', [
      uuidv4(),
      server.category,
      req.user.id,
    ]);
    res.json({ ok: true, category: server.category });
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
    if (info) delete info.password_hash; // nunca expõe o hash, nem pra quem é dono
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
    const { description, rules, icon, discoverable, access_mode, password } = req.body || {};
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
    if (typeof discoverable === 'boolean') {
      await db.run('UPDATE servers SET discoverable = ? WHERE category = ?', [discoverable ? 1 : 0, req.params.category]);
    }
    // Modo de acesso do servidor (item 6 do plano): convite (padrão, como
    // sempre foi) ou senha — são mutuamente exclusivos, o dono escolhe um.
    if (access_mode === 'convite') {
      await db.run("UPDATE servers SET access_mode = 'convite', password_hash = NULL WHERE category = ?", [
        req.params.category,
      ]);
    } else if (access_mode === 'senha') {
      if (!password || String(password).length < 4 || String(password).length > 60) {
        return res.status(400).json({ error: 'Senha precisa ter entre 4 e 60 caracteres' });
      }
      const passwordHash = bcrypt.hashSync(String(password), 10);
      await db.run("UPDATE servers SET access_mode = 'senha', password_hash = ? WHERE category = ?", [
        passwordHash,
        req.params.category,
      ]);
    }
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

// Adicionar alguém direto como membro (sem precisar de link de convite) —
// pra quem já gerencia membros no servidor. Não passa por senha/validade de
// convite: é uma ação explícita de quem tem permissão, não um convite público.
app.post(
  '/api/servers/:category/members',
  requireAuth,
  asyncHandler(async (req, res) => {
    const canAdd = await hasServerPermission(req.params.category, req.user, 'kick_members');
    if (!canAdd) return res.status(403).json({ error: 'Você não tem permissão pra adicionar membros' });

    const { username } = req.body || {};
    if (!username || typeof username !== 'string') return res.status(400).json({ error: 'Usuário inválido' });
    const target = await db.get('SELECT id, username FROM users WHERE username = ?', [username.trim()]);
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });

    const alreadyMember = await isServerMember(req.params.category, target.id);
    if (alreadyMember) return res.status(409).json({ error: `${target.username} já é membro desse servidor` });

    await db.run('INSERT INTO server_members (id, category, user_id) VALUES (?, ?, ?)', [
      uuidv4(),
      req.params.category,
      target.id,
    ]);
    logAudit(req.user, 'add_member', 'server', req.params.category, { added_user_id: target.id });
    res.json({ ok: true, username: target.username });
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
    logAudit(req.user, 'kick_member', 'server', req.params.category, { kicked_user_id: req.params.userId });
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

// Apagar o servidor inteiro — só o dono. Some com tudo: canais (e mensagens,
// reações, restrição por cargo), membros, cargos, torneios (e inscrições,
// partidas) e eventos ligados a ele. Ação sem volta, por isso exige o nome
// do servidor digitado de novo como confirmação (checado aqui no backend).
app.delete(
  '/api/servers/:category',
  requireAuth,
  asyncHandler(async (req, res) => {
    const category = req.params.category;
    const server = await db.get('SELECT owner_id FROM servers WHERE category = ?', [category]);
    if (!server) return res.status(404).json({ error: 'Servidor não encontrado' });
    if (server.owner_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: 'Só o dono pode apagar o servidor' });
    }
    const { confirmName } = req.body || {};
    if (confirmName !== category) {
      return res.status(400).json({ error: 'Digite o nome do servidor certinho pra confirmar' });
    }

    const channels = await db.all('SELECT id FROM channels WHERE category = ?', [category]);
    for (const ch of channels) {
      const messageIds = (await db.all('SELECT id FROM messages WHERE channel_id = ?', [ch.id])).map((m) => m.id);
      for (const msgId of messageIds) {
        await db.run('DELETE FROM message_reactions WHERE message_id = ?', [msgId]);
      }
      await db.run('DELETE FROM messages WHERE channel_id = ?', [ch.id]);
      await db.run('DELETE FROM channel_role_access WHERE channel_id = ?', [ch.id]);
    }
    await db.run('DELETE FROM channels WHERE category = ?', [category]);

    const tournaments = await db.all('SELECT id FROM tournaments WHERE category = ?', [category]);
    for (const t of tournaments) {
      await db.run('DELETE FROM tournament_registrations WHERE tournament_id = ?', [t.id]);
      await db.run('DELETE FROM tournament_matches WHERE tournament_id = ?', [t.id]);
    }
    await db.run('DELETE FROM tournaments WHERE category = ?', [category]);

    await db.run('DELETE FROM server_member_roles WHERE category = ?', [category]);
    await db.run('DELETE FROM server_roles WHERE category = ?', [category]);
    await db.run('DELETE FROM server_members WHERE category = ?', [category]);
    await db.run('DELETE FROM events WHERE category = ?', [category]);
    await db.run('DELETE FROM servers WHERE category = ?', [category]);

    logAudit(req.user, 'delete_server', 'server', category, {});
    io.to('server:' + category).emit('server:deleted', { category });
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
      // Amigos sempre podem. Sem amizade, ainda dá pra conversar se as duas
      // pessoas estiverem no MESMO servidor — pedia amizade antes até pra
      // quem já tava jogando junto no mesmo lugar, travava demais.
      const sharedServer = friendship
        ? null
        : await db.get(
            `SELECT sm1.category FROM server_members sm1
             JOIN server_members sm2 ON sm2.category = sm1.category
             WHERE sm1.user_id = ? AND sm2.user_id = ? LIMIT 1`,
            [req.user.id, targetId]
          );
      if (!friendship && !sharedServer) {
        return res.status(403).json({ error: 'Vocês precisam ser amigos ou estar no mesmo servidor pra conversar diretamente' });
      }
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

// Lista minhas conversas diretas (última mensagem, contador de não lidas,
// escondendo as que eu ocultei — item 3/6/7 da auditoria: "contador de
// mensagens não lidas" e "apagar/ocultar conversa pra mim mesmo").
app.get(
  '/api/dm',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.all('SELECT * FROM dm_channels WHERE user_a = ? OR user_b = ?', [req.user.id, req.user.id]);
    const results = [];
    for (const row of rows) {
      const otherId = row.user_a === req.user.id ? row.user_b : row.user_a;
      const iAmA = row.user_a === req.user.id;
      const hiddenAt = iAmA ? row.hidden_for_a : row.hidden_for_b;

      const other = await db.get('SELECT id, username, avatar, avatar_frame FROM users WHERE id = ?', [otherId]);
      if (!other) continue;
      const lastMsg = await db.get(
        'SELECT content, created_at FROM messages WHERE channel_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1',
        [row.id]
      );
      // Ocultei essa conversa — some da lista, A NÃO SER que tenha chegado
      // mensagem nova depois que eu ocultei (aí ela "reabre" sozinha,
      // igual "Fechar DM" do Discord, que reaparece se a pessoa escrever de novo).
      if (hiddenAt && (!lastMsg || lastMsg.created_at <= hiddenAt)) continue;

      const readRow = await db.get('SELECT last_read_at FROM channel_reads WHERE channel_id = ? AND user_id = ?', [
        row.id,
        req.user.id,
      ]);
      const unreadRow = await db.get(
        `SELECT COUNT(*) as c FROM messages
         WHERE channel_id = ? AND deleted = 0 AND user_id != ?
         ${readRow ? 'AND created_at > ?' : ''}`,
        readRow ? [row.id, req.user.id, readRow.last_read_at] : [row.id, req.user.id]
      );

      results.push({
        channel_id: row.id,
        other_user: other,
        last_message: lastMsg || null,
        unread_count: Number(unreadRow.c),
      });
    }
    results.sort((x, y) => {
      const tx = x.last_message ? x.last_message.created_at : '';
      const ty = y.last_message ? y.last_message.created_at : '';
      return ty.localeCompare(tx);
    });
    res.json(results);
  })
);

// Marca uma conversa (DM ou canal) como lida até agora — zera o contador de
// não lidas pra quem chamou. Chamado sempre que a pessoa abre a conversa.
app.post(
  '/api/channels/:id/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    await db.run(
      `INSERT INTO channel_reads (channel_id, user_id, last_read_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_at = excluded.last_read_at`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  })
);

// "Apagar conversa" só pro meu lado — a outra pessoa continua vendo
// normalmente, e se ela mandar mensagem nova a conversa reaparece pra mim.
app.delete(
  '/api/dm/:channelId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = await db.get('SELECT * FROM dm_channels WHERE id = ?', [req.params.channelId]);
    if (!row || (row.user_a !== req.user.id && row.user_b !== req.user.id)) {
      return res.status(404).json({ error: 'Conversa não encontrada' });
    }
    const column = row.user_a === req.user.id ? 'hidden_for_a' : 'hidden_for_b';
    await db.run(`UPDATE dm_channels SET ${column} = datetime('now') WHERE id = ?`, [req.params.channelId]);
    res.json({ ok: true });
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
  {
    type: 'function',
    function: {
      name: 'create_lfg_post',
      description: 'Publica um post de "procurando jogadores" (LFG) em nome de quem está conversando.',
      parameters: {
        type: 'object',
        properties: {
          game: { type: 'string', description: 'Nome do jogo' },
          players_needed: { type: 'number', description: 'Quantos jogadores procura' },
          region: { type: 'string' },
          role: { type: 'string', description: 'Função procurada (ex: suporte, IGL)' },
        },
        required: ['game'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_event',
      description: 'Cria um evento comunitário ou competitivo em nome de quem está conversando.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          game: { type: 'string' },
          event_date: { type: 'string', description: 'Data no formato AAAA-MM-DD' },
          description: { type: 'string' },
        },
        required: ['name'],
      },
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
    case 'create_lfg_post': {
      const game = String(args.game || '').trim().slice(0, 60);
      if (!game) return 'Preciso saber qual jogo pra publicar o post.';
      const id = uuidv4();
      await db.run(
        `INSERT INTO lfg_posts (id, user_id, game, players_needed, region, role, mic_required)
         VALUES (?, ?, ?, ?, ?, ?, 'opcional')`,
        [id, user.id, game, Math.max(1, Math.min(20, parseInt(args.players_needed, 10) || 1)), args.region || null, args.role || null]
      );
      return `Post de LFG publicado pra "${game}"! Já aparece no 🎯 Jogar pra outros jogadores verem.`;
    }
    case 'create_event': {
      const name = String(args.name || '').trim().slice(0, 100);
      if (!name) return 'Preciso de um nome pra criar o evento.';
      const id = uuidv4();
      await db.run(
        'INSERT INTO events (id, name, game, description, event_date, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        [id, name, (args.game || '').slice(0, 60), (args.description || '').slice(0, 500), args.event_date || null, user.id]
      );
      createFeedPost(user, 'event', `criou o evento "${name}"`, 'event', id);
      return `Evento "${name}" criado! Já aparece na aba de Eventos.`;
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
      // A Groq aposentou o meta-llama/llama-4-scout em 17/07/2026 — todo
      // pedido pra esse modelo passou a voltar 404 "model_not_found", daí os
      // logs cheios de erro repetido a cada captura de frame (a cada ~15s
      // durante qualquer compartilhamento de tela). Modelo de visão atual
      // recomendado pela própria Groq: qwen/qwen3.6-27b.
      const visionModel = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';
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
        `SELECT tournament_id, user_id, team_name, checked_in FROM tournament_registrations WHERE tournament_id IN (${placeholders})`,
        ids
      );
      const bracketRows = await db.all(
        `SELECT DISTINCT tournament_id FROM tournament_matches WHERE tournament_id IN (${placeholders})`,
        ids
      );
      const bracketSet = new Set(bracketRows.map((b) => b.tournament_id));
      tournaments.forEach((t) => {
        const regs = regRows.filter((r) => r.tournament_id === t.id);
        const myReg = regs.find((r) => r.user_id === req.user.id);
        t.registered_count = regs.length;
        t.checked_in_count = regs.filter((r) => r.checked_in).length;
        t.is_registered = !!myReg;
        t.is_checked_in = !!myReg && !!myReg.checked_in;
        t.bracket_generated = bracketSet.has(t.id);
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
    const { category, name, game, event_date, prize, max_slots, format } = req.body || {};
    if (!category || !name || !game || !String(name).trim() || !String(game).trim()) {
      return res.status(400).json({ error: 'Categoria, nome e jogo são obrigatórios' });
    }
    const cleanFormat = format === 'liga' ? 'liga' : 'eliminacao';
    const id = uuidv4();
    await db.run(
      'INSERT INTO tournaments (id, category, name, game, event_date, prize, max_slots, created_by, format) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        category,
        String(name).trim().slice(0, 80),
        String(game).trim().slice(0, 40),
        event_date || null,
        (prize || '').slice(0, 60) || null,
        Math.min(Math.max(Number(max_slots) || 32, 2), 500),
        req.user.id,
        cleanFormat,
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

// ---------- CHECK-IN (item 9 do plano) ----------
// Quem se inscreveu precisa confirmar presença antes da chave ser sorteada —
// evita gerar confrontos com gente que nem vai aparecer.

app.get(
  '/api/tournaments/:id/registrations',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      `SELECT r.user_id, r.team_name, r.checked_in, r.checked_in_at, u.username, u.avatar
       FROM tournament_registrations r JOIN users u ON u.id = r.user_id
       WHERE r.tournament_id = ? ORDER BY r.created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  })
);

app.post(
  '/api/tournaments/:id/check-in',
  requireAuth,
  asyncHandler(async (req, res) => {
    const reg = await db.get('SELECT * FROM tournament_registrations WHERE tournament_id = ? AND user_id = ?', [
      req.params.id,
      req.user.id,
    ]);
    if (!reg) return res.status(404).json({ error: 'Você não está inscrito nesse torneio' });
    const existingMatches = await db.get('SELECT COUNT(*) as c FROM tournament_matches WHERE tournament_id = ?', [
      req.params.id,
    ]);
    if (Number(existingMatches.c) > 0) {
      return res.status(400).json({ error: 'A chave desse torneio já foi sorteada, check-in não é mais possível' });
    }
    await db.run(
      "UPDATE tournament_registrations SET checked_in = 1, checked_in_at = datetime('now') WHERE tournament_id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  })
);

// ---------- CHAVES DE TORNEIO (eliminatória simples, gerada automaticamente) ----------

function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

// Embaralha com o algoritmo Fisher-Yates — sorteio justo dos confrontos.
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

app.post(
  '/api/tournaments/:id/generate-bracket',
  requireAuth,
  asyncHandler(async (req, res) => {
    const tournament = await db.get('SELECT * FROM tournaments WHERE id = ?', [req.params.id]);
    if (!tournament) return res.status(404).json({ error: 'Torneio não encontrado' });
    if (tournament.created_by !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: 'Só quem criou o torneio (ou um admin) pode gerar a chave' });
    }
    const existingMatches = await db.get('SELECT COUNT(*) as c FROM tournament_matches WHERE tournament_id = ?', [
      tournament.id,
    ]);
    if (Number(existingMatches.c) > 0) {
      return res.status(400).json({ error: 'Esse torneio já tem uma chave gerada' });
    }

    // Só entra na chave quem fez check-in — evita sortear confronto com
    // gente que se inscreveu e nem apareceu (item 9 do plano).
    const registrations = await db.all(
      `SELECT r.user_id, r.team_name, u.username FROM tournament_registrations r
       JOIN users u ON u.id = r.user_id WHERE r.tournament_id = ? AND r.checked_in = 1`,
      [tournament.id]
    );
    if (registrations.length < 2) {
      return res
        .status(400)
        .json({ error: 'Precisa de pelo menos 2 inscritos com check-in confirmado pra gerar a chave' });
    }

    const shuffledPlayers = shuffle(registrations.map((r) => ({ id: r.user_id, name: r.team_name || r.username })));

    // Formato "liga" (item 9 do plano): todos contra todos, sem chave de
    // eliminação — cada dupla joga uma vez, classificação por vitórias.
    if (tournament.format === 'liga') {
      const matchesToInsert = [];
      let idx = 0;
      for (let i = 0; i < shuffledPlayers.length; i++) {
        for (let j = i + 1; j < shuffledPlayers.length; j++) {
          matchesToInsert.push({
            id: uuidv4(),
            round: 1,
            match_index: idx++,
            a: shuffledPlayers[i],
            b: shuffledPlayers[j],
          });
        }
      }
      for (const m of matchesToInsert) {
        await db.run(
          `INSERT INTO tournament_matches (id, tournament_id, round, match_index, player_a_id, player_a_name, player_b_id, player_b_name, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendente')`,
          [m.id, tournament.id, m.round, m.match_index, m.a.id, m.a.name, m.b.id, m.b.name]
        );
      }
      logAudit(req.user, 'generate_bracket', 'tournament', tournament.id, {
        players: registrations.length,
        format: 'liga',
      });
      return res.json({ ok: true });
    }

    const players = shuffledPlayers;
    const bracketSize = nextPowerOfTwo(players.length);
    // Preenche vagas vazias com "bye" (avança sozinho) até completar potência de 2.
    while (players.length < bracketSize) players.push(null);

    const firstRoundMatches = [];
    for (let i = 0; i < bracketSize / 2; i++) {
      const a = players[i * 2];
      const b = players[i * 2 + 1];
      const id = uuidv4();
      const isBye = !a || !b;
      firstRoundMatches.push({
        id,
        tournament_id: tournament.id,
        round: 1,
        match_index: i,
        player_a_id: a ? a.id : null,
        player_a_name: a ? a.name : null,
        player_b_id: b ? b.id : null,
        player_b_name: b ? b.name : null,
        winner_id: isBye ? (a ? a.id : b ? b.id : null) : null,
        status: isBye ? 'concluida' : 'pendente',
      });
    }
    for (const m of firstRoundMatches) {
      await db.run(
        `INSERT INTO tournament_matches (id, tournament_id, round, match_index, player_a_id, player_a_name, player_b_id, player_b_name, winner_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          m.id,
          m.tournament_id,
          m.round,
          m.match_index,
          m.player_a_id,
          m.player_a_name,
          m.player_b_id,
          m.player_b_name,
          m.winner_id,
          m.status,
        ]
      );
    }

    // Cria os slots das rodadas seguintes vazios (quartas, semis, final...),
    // já ligados entre si por round+match_index — o avanço automático só
    // precisa preencher esses slots quando um resultado é registrado.
    let roundSize = bracketSize / 2;
    let round = 2;
    while (roundSize > 1) {
      roundSize = roundSize / 2;
      for (let i = 0; i < roundSize; i++) {
        await db.run(
          'INSERT INTO tournament_matches (id, tournament_id, round, match_index, status) VALUES (?, ?, ?, ?, ?)',
          [uuidv4(), tournament.id, round, i, 'aguardando']
        );
      }
      round++;
    }

    // Já resolve avanços automáticos de "bye" da primeira rodada.
    for (const m of firstRoundMatches) {
      if (m.status === 'concluida' && m.winner_id) {
        await advanceWinner(tournament.id, m.round, m.match_index, m.winner_id, m.winner_id === m.player_a_id ? m.player_a_name : m.player_b_name);
      }
    }

    logAudit(req.user, 'generate_bracket', 'tournament', tournament.id, { players: registrations.length });
    res.json({ ok: true });
  })
);

// Avança o vencedor pra próxima rodada, preenchendo o slot A ou B do
// confronto seguinte (baseado na posição matemática dentro da chave).
async function advanceWinner(tournamentId, fromRound, fromIndex, winnerId, winnerName) {
  const nextRound = fromRound + 1;
  const nextIndex = Math.floor(fromIndex / 2);
  const isSlotA = fromIndex % 2 === 0;
  const nextMatch = await db.get(
    'SELECT * FROM tournament_matches WHERE tournament_id = ? AND round = ? AND match_index = ?',
    [tournamentId, nextRound, nextIndex]
  );
  if (!nextMatch) {
    // Era a final — não tem próxima rodada, então essa vitória é o título
    // do torneio. Publica no feed como "vitória" (item 23 do plano).
    const tournament = await db.get('SELECT name FROM tournaments WHERE id = ?', [tournamentId]);
    const champion = await db.get('SELECT * FROM users WHERE id = ?', [winnerId]);
    if (champion && tournament) {
      createFeedPost(champion, 'tournament_win', `venceu o torneio "${tournament.name}"! 🏆`, 'tournament', tournamentId);
      grantCoins(winnerId, 200, `Campeão do torneio: ${tournament.name}`);
    }
    return;
  }
  if (isSlotA) {
    await db.run('UPDATE tournament_matches SET player_a_id = ?, player_a_name = ?, status = ? WHERE id = ?', [
      winnerId,
      winnerName,
      nextMatch.player_b_id ? 'pendente' : 'aguardando',
      nextMatch.id,
    ]);
  } else {
    await db.run('UPDATE tournament_matches SET player_b_id = ?, player_b_name = ?, status = ? WHERE id = ?', [
      winnerId,
      winnerName,
      nextMatch.player_a_id ? 'pendente' : 'aguardando',
      nextMatch.id,
    ]);
  }
}

app.get(
  '/api/tournaments/:id/bracket',
  requireAuth,
  asyncHandler(async (req, res) => {
    const matches = await db.all(
      'SELECT * FROM tournament_matches WHERE tournament_id = ? ORDER BY round, match_index',
      [req.params.id]
    );
    res.json(matches);
  })
);

// Registrar resultado: só quem criou o torneio ou um admin (papel de
// "árbitro" do item 16 do plano) — evita disputa de resultado sem
// necessidade de um sistema de contestação separado por enquanto.
app.post(
  '/api/tournaments/matches/:matchId/result',
  requireAuth,
  asyncHandler(async (req, res) => {
    const match = await db.get('SELECT * FROM tournament_matches WHERE id = ?', [req.params.matchId]);
    if (!match) return res.status(404).json({ error: 'Partida não encontrada' });
    const tournament = await db.get('SELECT * FROM tournaments WHERE id = ?', [match.tournament_id]);
    if (tournament.created_by !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: 'Só o organizador do torneio pode registrar resultado' });
    }
    if (!match.player_a_id || !match.player_b_id) {
      return res.status(400).json({ error: 'Essa partida ainda não tem os dois lados definidos' });
    }
    const { winner_id, score_a, score_b, evidence } = req.body || {};
    if (winner_id !== match.player_a_id && winner_id !== match.player_b_id) {
      return res.status(400).json({ error: 'winner_id precisa ser um dos dois jogadores da partida' });
    }
    // Evidência (print do resultado) é opcional, mas se vier precisa ser uma
    // imagem de verdade — mesmo padrão de validação usado no avatar (item 9
    // do plano: "evidência/screenshot de resultado").
    let evidenceUrl = null;
    if (evidence) {
      if (typeof evidence !== 'string' || evidence.length > 500000 || !evidence.startsWith('data:image/')) {
        return res.status(400).json({ error: 'Evidência precisa ser uma imagem válida (máx. ~350KB)' });
      }
      evidenceUrl = evidence;
    }
    const winnerName = winner_id === match.player_a_id ? match.player_a_name : match.player_b_name;
    await db.run(
      'UPDATE tournament_matches SET winner_id = ?, score_a = ?, score_b = ?, status = ?, evidence_url = COALESCE(?, evidence_url) WHERE id = ?',
      [winner_id, score_a ?? null, score_b ?? null, 'concluida', evidenceUrl, match.id]
    );
    // Liga é todos-contra-todos, sem rodadas seguintes pra avançar — cada
    // resultado só entra na classificação (calculada sob demanda em
    // /standings). Eliminatória sim precisa empurrar o vencedor pro próximo
    // confronto da chave.
    if (tournament.format !== 'liga') {
      await advanceWinner(match.tournament_id, match.round, match.match_index, winner_id, winnerName);
    }
    logAudit(req.user, 'record_match_result', 'tournament_match', match.id, { winner_id });
    res.json({ ok: true });
  })
);

// Classificação da liga: vitórias, derrotas e pontos (3 por vitória, 1 por
// empate — como não há empate real em jogos 1x1, na prática é 3/0, mas
// deixamos a regra pronta caso algum jogo registre placar igual).
app.get(
  '/api/tournaments/:id/standings',
  requireAuth,
  asyncHandler(async (req, res) => {
    const tournament = await db.get('SELECT * FROM tournaments WHERE id = ?', [req.params.id]);
    if (!tournament) return res.status(404).json({ error: 'Torneio não encontrado' });
    const matches = await db.all('SELECT * FROM tournament_matches WHERE tournament_id = ?', [req.params.id]);
    const table = {};
    const ensure = (id, name) => {
      if (!table[id]) table[id] = { id, name, wins: 0, losses: 0, draws: 0, played: 0, points: 0 };
    };
    matches.forEach((m) => {
      if (!m.player_a_id || !m.player_b_id) return;
      ensure(m.player_a_id, m.player_a_name);
      ensure(m.player_b_id, m.player_b_name);
      if (m.status !== 'concluida') return;
      table[m.player_a_id].played++;
      table[m.player_b_id].played++;
      if (!m.winner_id) {
        table[m.player_a_id].draws++;
        table[m.player_b_id].draws++;
        table[m.player_a_id].points += 1;
        table[m.player_b_id].points += 1;
      } else if (m.winner_id === m.player_a_id) {
        table[m.player_a_id].wins++;
        table[m.player_b_id].losses++;
        table[m.player_a_id].points += 3;
      } else {
        table[m.player_b_id].wins++;
        table[m.player_a_id].losses++;
        table[m.player_b_id].points += 3;
      }
    });
    const standings = Object.values(table).sort((a, b) => b.points - a.points || b.wins - a.wins);
    res.json(standings);
  })
);

// ---------- TEMPORADAS ----------

app.get(
  '/api/seasons',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await db.all('SELECT * FROM seasons ORDER BY starts_at DESC'));
  })
);

app.post(
  '/api/seasons',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { name, starts_at, ends_at } = req.body || {};
    if (!name || !starts_at) return res.status(400).json({ error: 'Nome e data de início são obrigatórios' });
    const id = uuidv4();
    await db.run('UPDATE seasons SET active = 0'); // só uma temporada ativa por vez
    await db.run('INSERT INTO seasons (id, name, starts_at, ends_at, active) VALUES (?, ?, ?, ?, 1)', [
      id,
      String(name).slice(0, 80),
      starts_at,
      ends_at || null,
    ]);
    logAudit(req.user, 'create_season', 'season', id, { name });
    res.json(await db.get('SELECT * FROM seasons WHERE id = ?', [id]));
  })
);

app.post(
  '/api/seasons/:id/close',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    await db.run("UPDATE seasons SET active = 0, ends_at = datetime('now') WHERE id = ?", [req.params.id]);
    logAudit(req.user, 'close_season', 'season', req.params.id);
    res.json({ ok: true });
  })
);

// Ranking da temporada ativa (ou de uma específica via ?season_id=) — mesma
// lógica do ranking semanal, só que usando a janela de datas da temporada
// em vez de fixo em 7 dias.
app.get(
  '/api/ranking/season',
  requireAuth,
  asyncHandler(async (req, res) => {
    let season;
    if (req.query.season_id) {
      season = await db.get('SELECT * FROM seasons WHERE id = ?', [req.query.season_id]);
    } else {
      season = await db.get('SELECT * FROM seasons WHERE active = 1 ORDER BY starts_at DESC LIMIT 1');
    }
    if (!season) return res.json({ season: null, ranking: [] });
    const rows = await db.all(
      `SELECT u.id, u.username, u.avatar, COUNT(m.id) as points
       FROM users u JOIN messages m ON m.user_id = u.id
       WHERE m.created_at >= ? AND (? IS NULL OR m.created_at <= ?) AND m.deleted = 0
       GROUP BY u.id ORDER BY points DESC LIMIT 20`,
      [season.starts_at, season.ends_at, season.ends_at]
    );
    res.json({ season, ranking: rows });
  })
);

// ---------- RANKING SEMANAL (baseado em atividade real: mensagens enviadas) ----------

app.get(
  '/api/ranking',
  requireAuth,
  asyncHandler(async (req, res) => {
    // scope: global (padrão) | pais | amigos | servidor — todos usam a mesma
    // métrica (mensagens dos últimos 7 dias), só muda quem entra na conta.
    const { scope, category } = req.query;
    let userFilterSql = '';
    let params = [];

    if (scope === 'pais' && req.user.country) {
      userFilterSql = 'AND u.country = ?';
      params.push(req.user.country);
    } else if (scope === 'amigos') {
      const friendRows = await db.all(
        "SELECT user_a, user_b FROM friendships WHERE status = 'accepted' AND (user_a = ? OR user_b = ?)",
        [req.user.id, req.user.id]
      );
      const friendIds = new Set([req.user.id]);
      friendRows.forEach((f) => {
        friendIds.add(f.user_a === req.user.id ? f.user_b : f.user_a);
      });
      const ids = [...friendIds];
      if (ids.length === 0) return res.json([]);
      userFilterSql = `AND u.id IN (${ids.map(() => '?').join(',')})`;
      params = ids;
    } else if (scope === 'servidor' && category) {
      const memberRows = await db.all('SELECT user_id FROM server_members WHERE category = ?', [category]);
      const ids = memberRows.map((m) => m.user_id);
      if (ids.length === 0) return res.json([]);
      userFilterSql = `AND u.id IN (${ids.map(() => '?').join(',')})`;
      params = ids;
    }

    const rows = await db.all(
      `SELECT u.id, u.username, u.avatar, COUNT(m.id) as points
       FROM users u
       JOIN messages m ON m.user_id = u.id
       WHERE m.created_at >= datetime('now', '-7 days') AND m.deleted = 0 ${userFilterSql}
       GROUP BY u.id
       ORDER BY points DESC
       LIMIT 20`,
      params
    );
    res.json(rows);
  })
);

// ---------- FEED SOCIAL (publicações, clipes, vitórias, conquistas...) ----------

async function createFeedPost(user, type, text, refType, refId) {
  try {
    const id = uuidv4();
    await db.run(
      'INSERT INTO feed_posts (id, user_id, username, type, text, ref_type, ref_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, user.id, user.username, type, text || null, refType || null, refId || null]
    );
    io.emit('feed:new-post', { id });
    return id;
  } catch (err) {
    console.error('Erro ao criar post no feed:', err);
    return null;
  }
}

app.get(
  '/api/feed',
  requireAuth,
  asyncHandler(async (req, res) => {
    const posts = await db.all('SELECT * FROM feed_posts ORDER BY created_at DESC LIMIT 50');
    if (posts.length === 0) return res.json([]);
    const ids = posts.map((p) => p.id);
    const placeholders = ids.map(() => '?').join(',');
    const [likeRows, commentCountRows] = await Promise.all([
      db.all(
        `SELECT content_id, COUNT(*) as c, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) as liked_by_me
         FROM content_likes WHERE content_type = 'feed_post' AND content_id IN (${placeholders}) GROUP BY content_id`,
        [req.user.id, ...ids]
      ),
      db.all(
        `SELECT content_id, COUNT(*) as c FROM content_comments WHERE content_type = 'feed_post' AND content_id IN (${placeholders}) GROUP BY content_id`,
        ids
      ),
    ]);
    const likeMap = Object.fromEntries(likeRows.map((r) => [r.content_id, r]));
    const commentMap = Object.fromEntries(commentCountRows.map((r) => [r.content_id, Number(r.c)]));
    res.json(
      posts.map((p) => ({
        ...p,
        like_count: likeMap[p.id] ? Number(likeMap[p.id].c) : 0,
        liked_by_me: likeMap[p.id] ? !!likeMap[p.id].liked_by_me : false,
        comment_count: commentMap[p.id] || 0,
      }))
    );
  })
);

app.post(
  '/api/feed',
  requireAuth,
  asyncHandler(async (req, res) => {
    const text = String((req.body || {}).text || '').trim();
    if (!text) return res.status(400).json({ error: 'Escreva algo pra publicar' });
    if (text.length > 500) return res.status(400).json({ error: 'Máximo 500 caracteres' });
    const id = await createFeedPost(req.user, 'post', text);
    res.json({ id });
  })
);

// Curtidas e comentários genéricos — reaproveitados por feed_post e clip,
// pra não duplicar a mesma lógica duas vezes.
app.post(
  '/api/content/:type/:id/like',
  requireAuth,
  asyncHandler(async (req, res) => {
    await db.run('INSERT OR IGNORE INTO content_likes (id, content_type, content_id, user_id) VALUES (?, ?, ?, ?)', [
      uuidv4(),
      req.params.type,
      req.params.id,
      req.user.id,
    ]);
    res.json({ ok: true });
  })
);

app.delete(
  '/api/content/:type/:id/like',
  requireAuth,
  asyncHandler(async (req, res) => {
    await db.run('DELETE FROM content_likes WHERE content_type = ? AND content_id = ? AND user_id = ?', [
      req.params.type,
      req.params.id,
      req.user.id,
    ]);
    res.json({ ok: true });
  })
);

app.get(
  '/api/content/:type/:id/comments',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      'SELECT * FROM content_comments WHERE content_type = ? AND content_id = ? ORDER BY created_at ASC',
      [req.params.type, req.params.id]
    );
    res.json(rows);
  })
);

app.post(
  '/api/content/:type/:id/comments',
  requireAuth,
  asyncHandler(async (req, res) => {
    const text = String((req.body || {}).text || '').trim();
    if (!text) return res.status(400).json({ error: 'Comentário vazio' });
    if (text.length > 300) return res.status(400).json({ error: 'Máximo 300 caracteres' });
    const id = uuidv4();
    await db.run(
      'INSERT INTO content_comments (id, content_type, content_id, user_id, username, text) VALUES (?, ?, ?, ?, ?, ?)',
      [id, req.params.type, req.params.id, req.user.id, req.user.username, text]
    );
    res.json({ id });
  })
);

// ---------- CLIPES ----------

app.post(
  '/api/clips',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { title, description, game, video_url, tags } = req.body || {};
    if (!title || !video_url) return res.status(400).json({ error: 'Título e link do vídeo são obrigatórios' });
    if (!/^https?:\/\//i.test(video_url)) return res.status(400).json({ error: 'Link do vídeo precisa ser uma URL válida' });
    const id = uuidv4();
    await db.run(
      'INSERT INTO clips (id, user_id, username, title, description, game, video_url, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        req.user.id,
        req.user.username,
        String(title).slice(0, 100),
        (description || '').slice(0, 500),
        (game || '').slice(0, 60),
        video_url,
        (tags || '').slice(0, 200),
      ]
    );
    createFeedPost(req.user, 'clip', `publicou um clipe: "${title}"`, 'clip', id);
    res.json(await db.get('SELECT * FROM clips WHERE id = ?', [id]));
  })
);

app.get(
  '/api/clips',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { game, sort } = req.query;
    const conditions = [];
    const params = [];
    if (game) {
      conditions.push('game = ?');
      params.push(game);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const orderBy = sort === 'trending' ? 'views DESC' : 'created_at DESC';
    const rows = await db.all(`SELECT * FROM clips ${where} ORDER BY ${orderBy} LIMIT 50`, params);
    res.json(rows);
  })
);

app.post(
  '/api/clips/:id/view',
  requireAuth,
  asyncHandler(async (req, res) => {
    await db.run('UPDATE clips SET views = views + 1 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  })
);

app.delete(
  '/api/clips/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const clip = await db.get('SELECT user_id FROM clips WHERE id = ?', [req.params.id]);
    if (!clip) return res.status(404).json({ error: 'Clipe não encontrado' });
    if (clip.user_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Sem permissão' });
    await db.run('DELETE FROM clips WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  })
);

// ---------- STREAMING (área de transmissões ao vivo, via link externo) ----------
// Não hospedamos vídeo/stream de verdade aqui — cada streamer usa a
// plataforma que já usa (Twitch, YouTube etc) e só linka pra cá, que vira um
// diretório com "ao vivo agora", seguir streamer e notificação de quando
// entrar ao vivo.

app.post(
  '/api/streams/go-live',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { title, game, external_url } = req.body || {};
    if (!title || !external_url) return res.status(400).json({ error: 'Título e link da transmissão são obrigatórios' });
    if (!/^https?:\/\//i.test(external_url)) return res.status(400).json({ error: 'Link precisa ser uma URL válida' });
    await db.run('UPDATE streams SET is_live = 0 WHERE user_id = ?', [req.user.id]); // encerra streams antigas
    const id = uuidv4();
    await db.run(
      'INSERT INTO streams (id, user_id, username, title, game, external_url, is_live) VALUES (?, ?, ?, ?, ?, ?, 1)',
      [id, req.user.id, req.user.username, String(title).slice(0, 100), (game || '').slice(0, 60), external_url]
    );
    // Notifica quem segue esse streamer.
    const followers = await db.all('SELECT follower_id FROM stream_follows WHERE streamer_id = ?', [req.user.id]);
    followers.forEach((f) => {
      io.to('user:' + f.follower_id).emit('stream:live', { username: req.user.username, title, streamId: id });
    });
    res.json({ id });
  })
);

app.post(
  '/api/streams/end',
  requireAuth,
  asyncHandler(async (req, res) => {
    await db.run('UPDATE streams SET is_live = 0 WHERE user_id = ?', [req.user.id]);
    res.json({ ok: true });
  })
);

app.get(
  '/api/streams',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { game } = req.query;
    const conditions = ['is_live = 1'];
    const params = [];
    if (game) {
      conditions.push('game = ?');
      params.push(game);
    }
    const rows = await db.all(
      `SELECT * FROM streams WHERE ${conditions.join(' AND ')} ORDER BY started_at DESC LIMIT 50`,
      params
    );
    res.json(rows);
  })
);

app.post(
  '/api/streams/follow/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    await db.run('INSERT OR IGNORE INTO stream_follows (id, follower_id, streamer_id) VALUES (?, ?, ?)', [
      uuidv4(),
      req.user.id,
      req.params.userId,
    ]);
    res.json({ ok: true });
  })
);

app.delete(
  '/api/streams/follow/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    await db.run('DELETE FROM stream_follows WHERE follower_id = ? AND streamer_id = ?', [req.user.id, req.params.userId]);
    res.json({ ok: true });
  })
);

// ---------- EVENTOS ----------

app.post(
  '/api/events',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name, game, description, event_date, max_participants, category } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Nome do evento é obrigatório' });
    const id = uuidv4();
    await db.run(
      'INSERT INTO events (id, category, name, game, description, event_date, max_participants, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        category || activeServerCategoryFallback(req),
        String(name).slice(0, 100),
        (game || '').slice(0, 60),
        (description || '').slice(0, 500),
        event_date || null,
        max_participants ? Math.max(1, parseInt(max_participants, 10)) : null,
        req.user.id,
      ]
    );
    createFeedPost(req.user, 'event', `criou o evento "${name}"`, 'event', id);
    res.json(await db.get('SELECT * FROM events WHERE id = ?', [id]));
  })
);
function activeServerCategoryFallback(req) {
  return (req.body && req.body.category) || null;
}

app.get(
  '/api/events',
  requireAuth,
  asyncHandler(async (req, res) => {
    const events = await db.all(
      "SELECT * FROM events WHERE event_date IS NULL OR event_date >= date('now') ORDER BY event_date IS NULL, event_date ASC LIMIT 50"
    );
    if (events.length === 0) return res.json([]);
    const ids = events.map((e) => e.id);
    const placeholders = ids.map(() => '?').join(',');
    const countRows = await db.all(
      `SELECT event_id, COUNT(*) as c FROM event_participants WHERE event_id IN (${placeholders}) GROUP BY event_id`,
      ids
    );
    const myRows = await db.all(
      `SELECT event_id FROM event_participants WHERE event_id IN (${placeholders}) AND user_id = ?`,
      [...ids, req.user.id]
    );
    const countMap = Object.fromEntries(countRows.map((r) => [r.event_id, Number(r.c)]));
    const myIds = new Set(myRows.map((r) => r.event_id));
    res.json(events.map((e) => ({ ...e, participant_count: countMap[e.id] || 0, is_registered: myIds.has(e.id) })));
  })
);

app.post(
  '/api/events/:id/register',
  requireAuth,
  asyncHandler(async (req, res) => {
    const event = await db.get('SELECT * FROM events WHERE id = ?', [req.params.id]);
    if (!event) return res.status(404).json({ error: 'Evento não encontrado' });
    if (event.max_participants) {
      const countRow = await db.get('SELECT COUNT(*) as c FROM event_participants WHERE event_id = ?', [event.id]);
      if (Number(countRow.c) >= event.max_participants) return res.status(400).json({ error: 'Evento lotado' });
    }
    await db.run('INSERT OR IGNORE INTO event_participants (id, event_id, user_id) VALUES (?, ?, ?)', [
      uuidv4(),
      event.id,
      req.user.id,
    ]);
    res.json({ ok: true });
  })
);

app.delete(
  '/api/events/:id/register',
  requireAuth,
  asyncHandler(async (req, res) => {
    await db.run('DELETE FROM event_participants WHERE event_id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  })
);

// ---------- LOJA (gasta NEXT Coins em itens cosméticos) ----------

app.get(
  '/api/me/coins',
  requireAuth,
  asyncHandler(async (req, res) => {
    const history = await db.all(
      'SELECT * FROM coin_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
      [req.user.id]
    );
    res.json({ balance: req.user.coins || 0, history });
  })
);

app.get(
  '/api/shop',
  requireAuth,
  asyncHandler(async (req, res) => {
    const items = await db.all('SELECT * FROM shop_items WHERE active = 1 ORDER BY cost ASC');
    const owned = await db.all('SELECT item_id FROM coin_purchases WHERE user_id = ?', [req.user.id]);
    const ownedIds = new Set(owned.map((o) => o.item_id));
    res.json(items.map((i) => ({ ...i, owned: ownedIds.has(i.id) })));
  })
);

app.post(
  '/api/shop/:id/purchase',
  requireAuth,
  asyncHandler(async (req, res) => {
    const item = await db.get('SELECT * FROM shop_items WHERE id = ? AND active = 1', [req.params.id]);
    if (!item) return res.status(404).json({ error: 'Item não encontrado' });
    const already = await db.get('SELECT id FROM coin_purchases WHERE user_id = ? AND item_id = ?', [
      req.user.id,
      item.id,
    ]);
    if (already) return res.status(409).json({ error: 'Você já tem esse item' });
    if ((req.user.coins || 0) < item.cost) return res.status(400).json({ error: 'NEXT Coins insuficientes' });
    await db.run('UPDATE users SET coins = coins - ? WHERE id = ?', [item.cost, req.user.id]);
    await db.run('INSERT INTO coin_transactions (id, user_id, amount, reason) VALUES (?, ?, ?, ?)', [
      uuidv4(),
      req.user.id,
      -item.cost,
      `Compra: ${item.name}`,
    ]);
    await db.run('INSERT INTO coin_purchases (id, user_id, item_id) VALUES (?, ?, ?)', [uuidv4(), req.user.id, item.id]);
    res.json({ ok: true });
  })
);

// Controle administrativo da economia (item 22 do plano) — só admin cria
// item na loja ou concede moedas manualmente.
app.post(
  '/api/admin/shop-items',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { name, description, type, cost, image } = req.body || {};
    if (!name || !cost) return res.status(400).json({ error: 'Nome e custo são obrigatórios' });
    const id = uuidv4();
    await db.run('INSERT INTO shop_items (id, name, description, type, cost, image) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      String(name).slice(0, 80),
      (description || '').slice(0, 300),
      type || 'cosmetico',
      Math.max(1, parseInt(cost, 10) || 1),
      image || null,
    ]);
    logAudit(req.user, 'create_shop_item', 'shop_item', id, { name });
    res.json(await db.get('SELECT * FROM shop_items WHERE id = ?', [id]));
  })
);

app.delete(
  '/api/admin/shop-items/:id',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    await db.run('UPDATE shop_items SET active = 0 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  })
);

app.post(
  '/api/admin/users/:id/grant-coins',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const amount = parseInt((req.body || {}).amount, 10);
    if (!amount) return res.status(400).json({ error: 'Quantidade inválida' });
    await grantCoins(req.params.id, amount, `Concedido por admin: ${req.user.username}`);
    logAudit(req.user, 'grant_coins', 'user', req.params.id, { amount });
    res.json({ ok: true });
  })
);

// ---------- ORGANIZAÇÕES DE ESPORTS ----------

app.post(
  '/api/organizations',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name, description, logo } = req.body || {};
    if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Nome inválido' });
    const existing = await db.get('SELECT id FROM organizations WHERE name = ?', [name.trim()]);
    if (existing) return res.status(409).json({ error: 'Já existe uma organização com esse nome' });
    const id = uuidv4();
    await db.run('INSERT INTO organizations (id, name, description, logo, owner_id) VALUES (?, ?, ?, ?, ?)', [
      id,
      name.trim().slice(0, 80),
      (description || '').slice(0, 500),
      logo || null,
      req.user.id,
    ]);
    res.json(await db.get('SELECT * FROM organizations WHERE id = ?', [id]));
  })
);

app.get(
  '/api/organizations',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await db.all('SELECT * FROM organizations ORDER BY created_at DESC LIMIT 100'));
  })
);

app.get(
  '/api/organizations/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const org = await db.get('SELECT * FROM organizations WHERE id = ?', [req.params.id]);
    if (!org) return res.status(404).json({ error: 'Organização não encontrada' });
    const teams = await db.all(
      `SELECT t.* FROM organization_teams ot JOIN teams t ON t.id = ot.team_id WHERE ot.org_id = ?`,
      [org.id]
    );
    const sponsors = await db.all('SELECT * FROM organization_sponsors WHERE org_id = ?', [org.id]);
    const tryouts = await db.all('SELECT * FROM org_tryouts WHERE org_id = ? ORDER BY created_at DESC', [org.id]);
    res.json({ ...org, teams, sponsors, tryouts });
  })
);

app.post(
  '/api/organizations/:id/sponsors',
  requireAuth,
  asyncHandler(async (req, res) => {
    const org = await db.get('SELECT * FROM organizations WHERE id = ?', [req.params.id]);
    if (!org) return res.status(404).json({ error: 'Organização não encontrada' });
    if (org.owner_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Sem permissão' });
    const { name, logo_url } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Nome do patrocinador é obrigatório' });
    await db.run('INSERT INTO organization_sponsors (id, org_id, name, logo_url) VALUES (?, ?, ?, ?)', [
      uuidv4(),
      org.id,
      String(name).slice(0, 80),
      logo_url || null,
    ]);
    res.json({ ok: true });
  })
);

app.post(
  '/api/organizations/:id/teams',
  requireAuth,
  asyncHandler(async (req, res) => {
    const org = await db.get('SELECT * FROM organizations WHERE id = ?', [req.params.id]);
    if (!org) return res.status(404).json({ error: 'Organização não encontrada' });
    if (org.owner_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Sem permissão' });
    const { team_id } = req.body || {};
    const team = await db.get('SELECT id FROM teams WHERE id = ?', [team_id]);
    if (!team) return res.status(404).json({ error: 'Time não encontrado' });
    await db.run('INSERT OR IGNORE INTO organization_teams (id, org_id, team_id) VALUES (?, ?, ?)', [
      uuidv4(),
      org.id,
      team_id,
    ]);
    res.json({ ok: true });
  })
);

// Seletivas ("publicação de seletivas" + "busca de jogadores" do item 29)
app.post(
  '/api/organizations/:id/tryouts',
  requireAuth,
  asyncHandler(async (req, res) => {
    const org = await db.get('SELECT * FROM organizations WHERE id = ?', [req.params.id]);
    if (!org) return res.status(404).json({ error: 'Organização não encontrada' });
    if (org.owner_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Sem permissão' });
    const { title, game, description } = req.body || {};
    if (!title) return res.status(400).json({ error: 'Título é obrigatório' });
    const id = uuidv4();
    await db.run('INSERT INTO org_tryouts (id, org_id, title, game, description) VALUES (?, ?, ?, ?, ?)', [
      id,
      org.id,
      String(title).slice(0, 100),
      (game || '').slice(0, 60),
      (description || '').slice(0, 500),
    ]);
    res.json(await db.get('SELECT * FROM org_tryouts WHERE id = ?', [id]));
  })
);

app.get(
  '/api/tryouts',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      `SELECT t.*, o.name as org_name FROM org_tryouts t JOIN organizations o ON o.id = t.org_id ORDER BY t.created_at DESC LIMIT 50`
    );
    res.json(rows);
  })
);

app.post(
  '/api/tryouts/:id/apply',
  requireAuth,
  asyncHandler(async (req, res) => {
    const tryout = await db.get('SELECT * FROM org_tryouts WHERE id = ?', [req.params.id]);
    if (!tryout) return res.status(404).json({ error: 'Seletiva não encontrada' });
    await db.run('INSERT OR IGNORE INTO org_tryout_applications (id, tryout_id, user_id, message) VALUES (?, ?, ?, ?)', [
      uuidv4(),
      tryout.id,
      req.user.id,
      ((req.body || {}).message || '').slice(0, 300),
    ]);
    res.json({ ok: true });
  })
);

app.get(
  '/api/tryouts/:id/applications',
  requireAuth,
  asyncHandler(async (req, res) => {
    const tryout = await db.get('SELECT * FROM org_tryouts WHERE id = ?', [req.params.id]);
    if (!tryout) return res.status(404).json({ error: 'Seletiva não encontrada' });
    const org = await db.get('SELECT owner_id FROM organizations WHERE id = ?', [tryout.org_id]);
    if (org.owner_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Sem permissão' });
    const rows = await db.all(
      `SELECT a.*, u.username, u.avatar FROM org_tryout_applications a JOIN users u ON u.id = a.user_id WHERE a.tryout_id = ?`,
      [tryout.id]
    );
    res.json(rows);
  })
);

// ---------- MARKETPLACE GAMER (divulgação de perfis profissionais — sem processar pagamento) ----------

app.put(
  '/api/marketplace/profile',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { category, title, description, portfolio_url, rate_display } = req.body || {};
    const validCategories = ['designer', 'editor', 'coach', 'desenvolvedor', 'caster', 'criador_conteudo'];
    if (!validCategories.includes(category)) return res.status(400).json({ error: 'Categoria inválida' });
    if (!title) return res.status(400).json({ error: 'Título é obrigatório' });
    const existing = await db.get('SELECT id FROM marketplace_profiles WHERE user_id = ?', [req.user.id]);
    if (existing) {
      await db.run(
        'UPDATE marketplace_profiles SET category = ?, title = ?, description = ?, portfolio_url = ?, rate_display = ? WHERE id = ?',
        [category, title.slice(0, 100), (description || '').slice(0, 500), portfolio_url || null, rate_display || null, existing.id]
      );
    } else {
      await db.run(
        `INSERT INTO marketplace_profiles (id, user_id, category, title, description, portfolio_url, rate_display)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), req.user.id, category, title.slice(0, 100), (description || '').slice(0, 500), portfolio_url || null, rate_display || null]
      );
    }
    res.json(await db.get('SELECT * FROM marketplace_profiles WHERE user_id = ?', [req.user.id]));
  })
);

app.delete(
  '/api/marketplace/profile',
  requireAuth,
  asyncHandler(async (req, res) => {
    await db.run('DELETE FROM marketplace_profiles WHERE user_id = ?', [req.user.id]);
    res.json({ ok: true });
  })
);

app.get(
  '/api/marketplace',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { category } = req.query;
    const conditions = [];
    const params = [];
    if (category) {
      conditions.push('mp.category = ?');
      params.push(category);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = await db.all(
      `SELECT mp.*, u.username, u.avatar,
        (SELECT AVG(rating) FROM marketplace_reviews WHERE profile_id = mp.id) as avg_rating,
        (SELECT COUNT(*) FROM marketplace_reviews WHERE profile_id = mp.id) as review_count
       FROM marketplace_profiles mp JOIN users u ON u.id = mp.user_id ${where} ORDER BY mp.created_at DESC LIMIT 100`,
      params
    );
    res.json(rows);
  })
);

app.post(
  '/api/marketplace/:profileId/review',
  requireAuth,
  asyncHandler(async (req, res) => {
    const profile = await db.get('SELECT * FROM marketplace_profiles WHERE id = ?', [req.params.profileId]);
    if (!profile) return res.status(404).json({ error: 'Perfil não encontrado' });
    if (profile.user_id === req.user.id) return res.status(400).json({ error: 'Não dá pra avaliar seu próprio perfil' });
    const rating = Math.max(1, Math.min(5, parseInt((req.body || {}).rating, 10) || 0));
    if (!rating) return res.status(400).json({ error: 'Nota precisa ser de 1 a 5' });
    await db.run(
      `INSERT INTO marketplace_reviews (id, profile_id, reviewer_id, rating, comment) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, reviewer_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment`,
      [uuidv4(), profile.id, req.user.id, rating, ((req.body || {}).comment || '').slice(0, 300)]
    );
    res.json({ ok: true });
  })
);

// ---------- INTEGRAÇÕES EXTERNAS ----------
// IMPORTANTE: isso NÃO é OAuth de verdade — não temos (nem poderíamos gerar
// sozinhos) credenciais de desenvolvedor da Steam/Twitch/Riot/Epic/Xbox/
// PlayStation/Ubisoft/Battle.net. O que existe aqui é um diretório onde a
// pessoa informa seu nome de usuário em cada plataforma (auto-declarado, sem
// verificação), só pra aparecer no perfil — igual muita gente já faz com
// "meu Steam: fulano123" na bio. Pra virar OAuth de verdade, o dono do site
// precisa registrar um app em cada plataforma e configurar as credenciais
// (client id/secret) como variável de ambiente aqui no servidor; o código
// server-side ficaria pronto pra receber isso, mas não inventamos a conexão.
const SUPPORTED_INTEGRATION_PROVIDERS = [
  'steam',
  'twitch',
  'youtube',
  'riot_games',
  'epic_games',
  'xbox',
  'playstation',
  'ubisoft',
  'battlenet',
];

app.get(
  '/api/integrations',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.all('SELECT provider, external_username, connected_at FROM external_integrations WHERE user_id = ?', [
      req.user.id,
    ]);
    const connected = Object.fromEntries(rows.map((r) => [r.provider, r]));
    res.json(
      SUPPORTED_INTEGRATION_PROVIDERS.map((p) => ({
        provider: p,
        connected: !!connected[p],
        external_username: connected[p] ? connected[p].external_username : null,
      }))
    );
  })
);

app.post(
  '/api/integrations/:provider/connect',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!SUPPORTED_INTEGRATION_PROVIDERS.includes(req.params.provider)) {
      return res.status(400).json({ error: 'Plataforma não suportada' });
    }
    const { external_username } = req.body || {};
    if (!external_username) return res.status(400).json({ error: 'Informe seu nome de usuário nessa plataforma' });
    await db.run(
      `INSERT INTO external_integrations (id, user_id, provider, external_username) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET external_username = excluded.external_username`,
      [uuidv4(), req.user.id, req.params.provider, String(external_username).slice(0, 60)]
    );
    res.json({
      ok: true,
      note: 'Conexão auto-declarada (sem OAuth verificado) — o administrador do site pode configurar OAuth real depois.',
    });
  })
);

app.delete(
  '/api/integrations/:provider',
  requireAuth,
  asyncHandler(async (req, res) => {
    await db.run('DELETE FROM external_integrations WHERE user_id = ? AND provider = ?', [
      req.user.id,
      req.params.provider,
    ]);
    res.json({ ok: true });
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
    const access = await requireChannelAccess(req.params.id, req.user);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const rows = await db.all(
      'SELECT id, channel_id, user_id, username, content, edited, pinned, thread_parent_id, created_at FROM messages WHERE channel_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 50',
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
    logAudit(req.user, 'clear_channel', 'channel', req.params.id);
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

// ---------- BUSCA GLOBAL (item 13 do plano) ----------
// Uma busca só no topo que cobre jogadores, servidores, torneios e clipes de
// uma vez, com resultados separados por categoria — pensada tanto pro
// dropdown de sugestões (poucos resultados, digitando) quanto pra uma
// eventual página de resultados completa.

app.get(
  '/api/search',
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ players: [], servers: [], tournaments: [], clips: [] });
    const like = `%${q}%`;
    const limit = Math.min(Number(req.query.limit) || 6, 20);

    const [players, serversRaw, tournaments, clips] = await Promise.all([
      db.all(
        `SELECT id, username, avatar, avatar_frame, status_message, is_admin
         FROM users WHERE is_banned = 0 AND username LIKE ? AND id != ? ORDER BY username LIMIT ?`,
        [like, req.user.id, limit]
      ),
      db.all(
        `SELECT s.category, s.icon, s.description,
          (SELECT COUNT(*) FROM server_members WHERE category = s.category) as member_count
         FROM servers s WHERE s.discoverable = 1 AND s.category LIKE ? ORDER BY member_count DESC LIMIT ?`,
        [like, limit]
      ),
      db.all(
        `SELECT id, category, name, game, event_date, max_slots,
          (SELECT COUNT(*) FROM tournament_registrations WHERE tournament_id = tournaments.id) as registered
         FROM tournaments WHERE name LIKE ? OR game LIKE ? ORDER BY created_at DESC LIMIT ?`,
        [like, like, limit]
      ),
      db.all(
        `SELECT id, user_id, username, title, game, video_url, views, created_at
         FROM clips WHERE title LIKE ? OR game LIKE ? ORDER BY views DESC LIMIT ?`,
        [like, like, limit]
      ),
    ]);

    const myMemberships = await db.all('SELECT category FROM server_members WHERE user_id = ?', [req.user.id]);
    const myCategories = new Set(myMemberships.map((m) => m.category));
    const servers = serversRaw.map((s) => ({ ...s, is_member: myCategories.has(s.category) }));

    res.json({ players, servers, tournaments, clips });
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

    const { slow_mode_seconds, read_only, name } = req.body || {};
    if (typeof slow_mode_seconds === 'number') {
      const clamped = Math.max(0, Math.min(21600, Math.floor(slow_mode_seconds)));
      await db.run('UPDATE channels SET slow_mode_seconds = ? WHERE id = ?', [clamped, channel.id]);
    }
    if (typeof read_only === 'boolean') {
      await db.run('UPDATE channels SET read_only = ? WHERE id = ?', [read_only ? 1 : 0, channel.id]);
    }
    if (typeof name === 'string') {
      const cleanName = name.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
      if (cleanName.length < 2) return res.status(400).json({ error: 'Nome precisa ter pelo menos 2 caracteres' });
      await db.run('UPDATE channels SET name = ? WHERE id = ?', [cleanName, channel.id]);
    }
    const updated = await db.get('SELECT id, name, slow_mode_seconds, read_only FROM channels WHERE id = ?', [channel.id]);
    io.to(channel.id).emit('channel:settings-updated', updated);
    if (typeof name === 'string') io.to('server:' + channel.category).emit('channel:renamed', updated);
    res.json(updated);
  })
);

// ---------- CANAL PRIVADO POR CARGO ----------

app.get(
  '/api/channels/:id/access',
  requireAuth,
  asyncHandler(async (req, res) => {
    const channel = await db.get('SELECT id, category FROM channels WHERE id = ?', [req.params.id]);
    if (!channel) return res.status(404).json({ error: 'Canal não encontrado' });
    const canManage = await hasServerPermission(channel.category, req.user, 'manage_channels');
    if (!canManage) return res.status(403).json({ error: 'Você não tem permissão pra configurar esse canal' });
    const rows = await db.all('SELECT role_id FROM channel_role_access WHERE channel_id = ?', [channel.id]);
    res.json({ role_ids: rows.map((r) => r.role_id) });
  })
);

// Substitui a lista inteira de cargos com acesso. role_ids: [] = remove a
// restrição (canal volta a ser visível pra todo mundo do servidor).
app.put(
  '/api/channels/:id/access',
  requireAuth,
  asyncHandler(async (req, res) => {
    const channel = await db.get('SELECT id, category FROM channels WHERE id = ?', [req.params.id]);
    if (!channel) return res.status(404).json({ error: 'Canal não encontrado' });
    const canManage = await hasServerPermission(channel.category, req.user, 'manage_channels');
    if (!canManage) return res.status(403).json({ error: 'Você não tem permissão pra configurar esse canal' });

    const { role_ids } = req.body || {};
    if (!Array.isArray(role_ids)) return res.status(400).json({ error: 'role_ids precisa ser uma lista' });

    // Só aceita cargos que realmente existem nesse servidor — evita lixo/id inventado.
    const validRoles = await db.all('SELECT id FROM server_roles WHERE category = ?', [channel.category]);
    const validIds = new Set(validRoles.map((r) => r.id));
    const clean = [...new Set(role_ids.filter((id) => validIds.has(id)))];

    await db.run('DELETE FROM channel_role_access WHERE channel_id = ?', [channel.id]);
    for (const roleId of clean) {
      await db.run('INSERT INTO channel_role_access (id, channel_id, role_id) VALUES (?, ?, ?)', [
        uuidv4(),
        channel.id,
        roleId,
      ]);
    }
    logAudit(req.user, 'set_channel_access', 'channel', channel.id, { role_ids: clean });
    res.json({ role_ids: clean });
  })
);

// Apagar uma sala (canal de texto ou de voz), inclusive Salas Rápidas que
// alguém queira remover antes de todo mundo sair. Só quem gerencia canais no
// servidor pode. Se for uma sala de voz com gente conectada, todo mundo é
// tirado dela primeiro.
app.delete(
  '/api/channels/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const channel = await db.get('SELECT * FROM channels WHERE id = ?', [req.params.id]);
    if (!channel) return res.status(404).json({ error: 'Canal não encontrado' });
    const canManage = await hasServerPermission(channel.category, req.user, 'manage_channels');
    if (!canManage) return res.status(403).json({ error: 'Você não tem permissão pra apagar essa sala' });

    if (channel.type === 'voz' && voiceRooms.has(channel.id)) {
      voiceRooms.delete(channel.id);
      musicRooms.delete(channel.id);
    }

    const messageIds = (await db.all('SELECT id FROM messages WHERE channel_id = ?', [channel.id])).map((m) => m.id);
    for (const msgId of messageIds) {
      await db.run('DELETE FROM message_reactions WHERE message_id = ?', [msgId]);
    }
    await db.run('DELETE FROM messages WHERE channel_id = ?', [channel.id]);
    await db.run('DELETE FROM channel_role_access WHERE channel_id = ?', [channel.id]);
    await db.run('DELETE FROM channels WHERE id = ?', [channel.id]);

    logAudit(req.user, 'delete_channel', 'channel', channel.id, { name: channel.name, category: channel.category });
    io.emit('channel:deleted', { id: channel.id, category: channel.category });
    res.json({ ok: true });
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
    logAudit(req.user, 'ban_user', 'user', req.params.id, { username: banned && banned.username });
  })
);

app.post(
  '/api/admin/users/:id/unban',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    await db.run('UPDATE users SET is_banned = 0 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
    logAudit(req.user, 'unban_user', 'user', req.params.id);
  })
);

// Timeout: mute temporário (diferente de banir — a conta continua acessível,
// só fica impedida de mandar mensagem até o prazo passar). É o "timeout" do
// item 9 do plano de desenvolvimento.
app.post(
  '/api/admin/users/:id/timeout',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const minutes = Math.max(1, Math.min(10080, parseInt((req.body || {}).minutes, 10) || 10));
    const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    await db.run('UPDATE users SET timeout_until = ? WHERE id = ?', [until, req.params.id]);
    const target = await db.get('SELECT username FROM users WHERE id = ?', [req.params.id]);
    logAudit(req.user, 'timeout_user', 'user', req.params.id, { minutes, username: target && target.username });
    res.json({ ok: true, timeout_until: until });
  })
);

app.post(
  '/api/admin/users/:id/untimeout',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    await db.run('UPDATE users SET timeout_until = NULL WHERE id = ?', [req.params.id]);
    logAudit(req.user, 'untimeout_user', 'user', req.params.id);
    res.json({ ok: true });
  })
);

// ---------- AUDIT LOG (painel admin) ----------

app.get(
  '/api/admin/audit-logs',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { actor, action, target_type } = req.query;
    const conditions = [];
    const params = [];
    if (actor) {
      conditions.push('actor_username LIKE ?');
      params.push(`%${actor}%`);
    }
    if (action) {
      conditions.push('action = ?');
      params.push(action);
    }
    if (target_type) {
      conditions.push('target_type = ?');
      params.push(target_type);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = await db.all(
      `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT 200`,
      params
    );
    res.json(rows);
  })
);

app.get(
  '/api/admin/users',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(
      await db.all(
        'SELECT id, username, is_admin, is_banned, timeout_until, coins, reputation, created_at FROM users ORDER BY created_at DESC'
      )
    );
  })
);

// ---------- DASHBOARD ADMINISTRATIVO: MONITORAMENTO (dados, erros, lag) ----------
// Serve pra responder "quanta gente cabe aqui sem travar" com dados de
// verdade em vez de achismo: uso de memória/CPU real do processo, quantas
// conexões de socket estão abertas AGORA, quantas pessoas estão em cada sala
// de voz, e os erros/requisições lentas mais recentes.
const SERVER_STARTED_AT = Date.now();

app.get(
  '/api/admin/monitoring',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const mem = process.memoryUsage();
    const toMb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;

    const voiceRoomsSnapshot = [...voiceRooms.entries()]
      .filter(([, participants]) => participants.size > 0)
      .map(([roomId, participants]) => ({ roomId, participants: participants.size }))
      .sort((a, b) => b.participants - a.participants);
    const totalInCalls = voiceRoomsSnapshot.reduce((sum, r) => sum + r.participants, 0);

    const now = Date.now();
    const requestsLastMinute = requestTimestamps.filter((t) => now - t <= 60 * 1000).length;
    const requestsLast5Min = requestTimestamps.length;

    const [dbCounts] = await Promise.all([
      db.get(
        `SELECT
          (SELECT COUNT(*) FROM users) as total_users,
          (SELECT COUNT(*) FROM messages) as total_messages,
          (SELECT COUNT(DISTINCT category) FROM servers) as total_servers`
      ),
    ]);

    res.json({
      server: {
        uptime_seconds: Math.round((now - SERVER_STARTED_AT) / 1000),
        node_version: process.version,
        memory_rss_mb: toMb(mem.rss),
        memory_heap_used_mb: toMb(mem.heapUsed),
        memory_heap_total_mb: toMb(mem.heapTotal),
        // O free tier do Render dá 512MB de RAM/0.1 vCPU pro processo inteiro
        // — isso é o teto real, não o quanto o Node "poderia" usar num servidor maior.
        render_free_tier_ram_mb: 512,
      },
      environment: {
        turso_configured: !!process.env.TURSO_DATABASE_URL,
        groq_configured: !!process.env.GROQ_API_KEY,
        resend_configured: !!process.env.RESEND_API_KEY,
        anthropic_configured: !!process.env.ANTHROPIC_API_KEY,
        turn_configured: !!process.env.TURN_URL,
        node_env: process.env.NODE_ENV || 'development',
      },
      realtime: {
        sockets_connected: io.engine.clientsCount,
        users_online: onlineUsers.size,
        voice_rooms_active: voiceRoomsSnapshot.length,
        people_in_calls: totalInCalls,
        voice_rooms: voiceRoomsSnapshot,
        max_participants_per_room: MAX_VOICE_ROOM_PARTICIPANTS,
      },
      requests: {
        last_minute: requestsLastMinute,
        last_5_minutes: requestsLast5Min,
        slow_threshold_ms: SLOW_REQUEST_MS,
      },
      database: {
        total_users: Number(dbCounts.total_users),
        total_messages: Number(dbCounts.total_messages),
        total_servers: Number(dbCounts.total_servers),
      },
      recent_slow_requests: recentSlowRequests.slice(0, 30),
      recent_errors: recentErrors.slice(0, 30),
    });
  })
);

// ---------- DASHBOARD ADMINISTRATIVO: ANALYTICS ----------

app.get(
  '/api/admin/analytics',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const [
      totalUsers,
      bannedUsers,
      totalServers,
      totalChannels,
      messagesToday,
      messagesWeek,
      totalTournaments,
      activeSessions,
      totalClips,
      totalTeams,
      totalClans,
      totalOrgs,
      totalEvents,
      newUsersByDay,
    ] = await Promise.all([
      db.get('SELECT COUNT(*) as c FROM users WHERE id != ?', [AI_BOT_USER_ID]),
      db.get('SELECT COUNT(*) as c FROM users WHERE is_banned = 1'),
      db.get('SELECT COUNT(DISTINCT category) as c FROM channels'),
      db.get('SELECT COUNT(*) as c FROM channels'),
      db.get("SELECT COUNT(*) as c FROM messages WHERE created_at >= date('now') AND deleted = 0"),
      db.get("SELECT COUNT(*) as c FROM messages WHERE created_at >= datetime('now', '-7 days') AND deleted = 0"),
      db.get('SELECT COUNT(*) as c FROM tournaments'),
      db.get('SELECT COUNT(*) as c FROM user_sessions WHERE revoked = 0'),
      db.get('SELECT COUNT(*) as c FROM clips'),
      db.get('SELECT COUNT(*) as c FROM teams'),
      db.get('SELECT COUNT(*) as c FROM clans'),
      db.get('SELECT COUNT(*) as c FROM organizations'),
      db.get('SELECT COUNT(*) as c FROM events'),
      db.all(
        `SELECT date(created_at) as day, COUNT(*) as c FROM users
         WHERE created_at >= datetime('now', '-14 days') AND id != ?
         GROUP BY date(created_at) ORDER BY day ASC`,
        [AI_BOT_USER_ID]
      ),
    ]);
    res.json({
      total_users: Number(totalUsers.c),
      banned_users: Number(bannedUsers.c),
      total_servers: Number(totalServers.c),
      total_channels: Number(totalChannels.c),
      messages_today: Number(messagesToday.c),
      messages_week: Number(messagesWeek.c),
      total_tournaments: Number(totalTournaments.c),
      active_sessions: Number(activeSessions.c),
      total_clips: Number(totalClips.c),
      total_teams: Number(totalTeams.c),
      total_clans: Number(totalClans.c),
      total_orgs: Number(totalOrgs.c),
      total_events: Number(totalEvents.c),
      new_users_by_day: newUsersByDay,
    });
  })
);

// Contas que compartilham IP com outra conta — só um sinal pra revisão
// humana (contas na mesma casa/faculdade/lan house são normais e não devem
// ser banidas automaticamente por isso).
app.get(
  '/api/admin/suspicious-accounts',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const rows = await db.all(`
      SELECT s.ip, GROUP_CONCAT(DISTINCT u.username) as usernames, COUNT(DISTINCT s.user_id) as account_count
      FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.ip IS NOT NULL AND s.ip != ''
      GROUP BY s.ip HAVING account_count > 1
      ORDER BY account_count DESC
    `);
    res.json(rows);
  })
);

// ---------- CONTROLE DE CONTEÚDO (admin) ----------

app.get(
  '/api/admin/clips',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await db.all('SELECT * FROM clips ORDER BY created_at DESC LIMIT 100'));
  })
);

app.delete(
  '/api/admin/clips/:id',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    await db.run('DELETE FROM clips WHERE id = ?', [req.params.id]);
    logAudit(req.user, 'delete_clip', 'clip', req.params.id);
    res.json({ ok: true });
  })
);

app.delete(
  '/api/admin/feed/:id',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    await db.run('DELETE FROM feed_posts WHERE id = ?', [req.params.id]);
    logAudit(req.user, 'delete_feed_post', 'feed_post', req.params.id);
    res.json({ ok: true });
  })
);

app.get(
  '/api/admin/shop-items',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await db.all('SELECT * FROM shop_items ORDER BY created_at DESC'));
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

// Teto de participantes por sala de voz. A chamada aqui é P2P "mesh" (cada
// pessoa manda áudio/vídeo direto pra cada outra pessoa, sem passar pelo
// servidor) — funciona liso até uns 6-8 participantes; passando disso, cada
// participante precisa enviar sua própria câmera/tela N vezes ao mesmo tempo
// (upload do celular/PC de cada um, não do servidor) e a call trava/engasga
// pra todo mundo, não só pra quem entrou por último. Em vez de deixar isso
// acontecer silenciosamente, barra num número seguro com um aviso claro.
const MAX_VOICE_ROOM_PARTICIPANTS = 8;

function voiceStateSnapshot() {
  const snapshot = {};
  for (const [roomId, participants] of voiceRooms.entries()) {
    snapshot[roomId] = [...participants.values()];
  }
  return snapshot;
}

// NEXT Music (item 14 do plano): fila e estado de reprodução por sala de
// voz, só em memória — não é histórico permanente, é só "o que tá tocando
// agora nessa sala", zera quando o servidor reinicia (igual voiceRooms).
const musicRooms = new Map();

function musicRoomState(roomId, createIfMissing) {
  if (!musicRooms.has(roomId)) {
    if (!createIfMissing) return { queue: [], currentIndex: -1, isPlaying: false, positionMs: 0, lastUpdate: Date.now() };
    musicRooms.set(roomId, { queue: [], currentIndex: -1, isPlaying: false, positionMs: 0, lastUpdate: Date.now() });
  }
  return musicRooms.get(roomId);
}

// Versão pra mandar pro cliente: calcula a posição atual (se tocando, soma o
// tempo que passou desde a última atualização) em vez de mandar timestamps
// crus que cada navegador teria que reinterpretar.
function musicRoomStateForClient(roomId) {
  const room = musicRoomState(roomId);
  const positionMs = room.isPlaying ? room.positionMs + (Date.now() - room.lastUpdate) : room.positionMs;
  return {
    roomId,
    queue: room.queue,
    currentIndex: room.currentIndex,
    isPlaying: room.isPlaying,
    positionMs,
    currentTrack: room.currentIndex >= 0 ? room.queue[room.currentIndex] : null,
  };
}

function broadcastVoiceRoom(roomId) {
  const participants = voiceRooms.has(roomId) ? [...voiceRooms.get(roomId).values()] : [];
  io.emit('voice:update', { roomId, participants });
}

function removeFromAllVoiceRooms(socketId) {
  for (const [roomId, participants] of voiceRooms.entries()) {
    if (participants.delete(socketId)) {
      broadcastVoiceRoom(roomId);
      maybeDeleteEmptyQuickRoom(roomId);
    }
  }
}

// Sala Rápida: se o último participante saiu e a sala é temporária
// (is_quick), apaga ela do banco e avisa todo mundo pra sumir da lista.
async function maybeDeleteEmptyQuickRoom(roomId) {
  const participants = voiceRooms.get(roomId);
  if (participants && participants.size > 0) return;
  try {
    const channel = await db.get('SELECT * FROM channels WHERE id = ?', [roomId]);
    if (!channel || !channel.is_quick) return;
    await db.run('DELETE FROM channels WHERE id = ?', [roomId]);
    await db.run('DELETE FROM messages WHERE channel_id = ?', [roomId]);
    voiceRooms.delete(roomId);
    musicRooms.delete(roomId);
    io.emit('channel:deleted', { id: roomId, category: channel.category });
  } catch (err) {
    console.error('Erro ao apagar sala rápida vazia:', err);
  }
}

// Presença online global (quem está com o site aberto, em qualquer tela) —
// userId -> quantidade de conexões abertas (várias abas contam como 1 online).
const onlineUsers = new Map();
// userId -> status escolhido pela pessoa (online/ausente/ocupado/invisivel).
// Carregado do banco na conexão, atualizado na hora quando a pessoa troca no
// perfil — sem precisar reconectar o socket.
const userPresenceStatus = new Map();

function setUserPresenceStatus(userId, status) {
  userPresenceStatus.set(userId, status);
  broadcastOnlineUsers();
}

// Quem está "invisível" continua contando como conectado pra tudo (recebe
// mensagens, aparece em salas de voz etc.) mas não aparece na lista pública
// de presença — pros outros, ele parece offline. É assim que o item 1 da
// especificação define o status Invisível.
function broadcastOnlineUsers() {
  const visible = [...onlineUsers.keys()]
    .filter((id) => userPresenceStatus.get(id) !== 'invisivel')
    .map((id) => ({ id, status: userPresenceStatus.get(id) || 'online' }));
  io.emit('presence:online', visible);
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
  if (!userPresenceStatus.has(user.id)) {
    userPresenceStatus.set(user.id, user.presence_status || 'online');
  }
  broadcastOnlineUsers();

  socket.on('disconnect', () => {
    messageTimestamps.delete(socket.id);
    removeFromAllVoiceRooms(socket.id);
    const count = (onlineUsers.get(user.id) || 1) - 1;
    if (count <= 0) {
      onlineUsers.delete(user.id);
      userPresenceStatus.delete(user.id);
    } else {
      onlineUsers.set(user.id, count);
    }
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

  socket.on('chat:message', async ({ channelId, content, threadParentId }) => {
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

      // Timeout (mute temporário aplicado por um admin) — checa fresco no
      // banco a cada mensagem, já que o "user" da conexão pode estar
      // desatualizado se o timeout foi aplicado depois de conectar.
      const freshUser = await db.get('SELECT timeout_until FROM users WHERE id = ?', [user.id]);
      if (freshUser && freshUser.timeout_until && new Date(freshUser.timeout_until) > new Date()) {
        const remainingMin = Math.ceil((new Date(freshUser.timeout_until) - new Date()) / 60000);
        socket.emit('chat:blocked', {
          reason: `Você está em timeout por mais ${remainingMin} minuto(s) e não pode mandar mensagens.`,
          categories: [],
        });
        return;
      }

      // Canal somente-leitura e slow mode — só se aplicam a salas de
      // servidor de verdade (não a DMs, que não têm linha em "channels").
      // Admin do site e quem tem manage_channels passam direto por cima.
      if (!channelId.startsWith('dm::')) {
        // Canal privado por cargo (item 5 do plano) — verificado aqui no
        // backend, não só escondido da lista no frontend.
        const channelForAccess = await db.get('SELECT * FROM channels WHERE id = ?', [channelId]);
        if (!channelForAccess || !(await canAccessChannel(channelForAccess, user))) {
          socket.emit('chat:blocked', { reason: 'Você não tem acesso a esse canal.', categories: [] });
          return;
        }
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

      // Anti-link "leve": só marca a mensagem (fica visível pro remetente e
      // consultável por um admin), não bloqueia — link é uso legítimo demais
      // nesse app (convites, clipes, etc) pra travar todo mundo.
      const hasLink = /https?:\/\/|www\./i.test(content);

      // Se veio com threadParentId, precisa ser uma resposta válida a uma
      // mensagem existente do MESMO canal (não deixa criar thread cruzando
      // canais/DMs por engano).
      let validThreadParentId = null;
      if (threadParentId) {
        const parentMsg = await db.get('SELECT id FROM messages WHERE id = ? AND channel_id = ? AND deleted = 0', [
          threadParentId,
          channelId,
        ]);
        if (parentMsg) validThreadParentId = parentMsg.id;
      }

      const id = uuidv4();
      await db.run(
        'INSERT INTO messages (id, channel_id, user_id, username, content, flagged, flag_categories, has_link, thread_parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          channelId,
          user.id,
          user.username,
          content,
          scan.flagged ? 1 : 0,
          JSON.stringify(scan.categories),
          hasLink ? 1 : 0,
          validThreadParentId,
        ]
      );

      const payload = {
        id,
        channel_id: channelId,
        user_id: user.id,
        username: user.username,
        content,
        created_at: new Date().toISOString(),
        thread_parent_id: validThreadParentId,
      };
      io.to(channelId).emit('chat:message', payload);
      if (validThreadParentId) {
        io.to(channelId).emit('thread:reply', { parent_id: validThreadParentId, message: payload });
      }

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

      // DM: avisa quem recebeu com um pop-up (igual "fulano está te ligando"),
      // mesmo que essa pessoa não esteja com a conversa aberta agora — manda
      // pra sala pessoal dela (user:<id>), não só pro canal em si.
      if (channelId.startsWith('dm::')) {
        const parts = channelId.split('::');
        const otherId = parts[1] === user.id ? parts[2] : parts[2] === user.id ? parts[1] : null;
        if (otherId) {
          io.to('user:' + otherId).emit('dm:notify', {
            fromUsername: user.username,
            channelId,
            preview: content.length > 140 ? content.slice(0, 140) + '…' : content,
          });
        }
        // Se essa DM é com o bot assistente de IA, gera a resposta dele.
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
  socket.on('rtc:join', async (roomId, ack) => {
    // "ack" é opcional (callback do socket.io) — cliente antigo sem essa
    // versão do app.js simplesmente não manda, então sempre checa antes de chamar.
    const reply = (payload) => {
      if (typeof ack === 'function') ack(payload);
    };

    // Canal de voz privado por cargo — mesma checagem do texto.
    const voiceChannel = await db.get('SELECT * FROM channels WHERE id = ?', [roomId]);
    if (voiceChannel && !(await canAccessChannel(voiceChannel, user))) {
      return reply({ ok: false, reason: 'no-access' });
    }

    // Sala já no teto de participantes (mesh P2P não aguenta mais gente sem
    // travar a call de todo mundo) — barra a entrada com aviso claro em vez
    // de deixar entrar e travar geral.
    const currentRoom = voiceRooms.get(roomId);
    if (currentRoom && currentRoom.size >= MAX_VOICE_ROOM_PARTICIPANTS && !currentRoom.has(socket.id)) {
      socket.emit('rtc:room-full', { roomId, max: MAX_VOICE_ROOM_PARTICIPANTS });
      return reply({ ok: false, reason: 'room-full', max: MAX_VOICE_ROOM_PARTICIPANTS });
    }

    // Sai de qualquer outra sala de voz antes (só dá pra estar em uma por vez)
    removeFromAllVoiceRooms(socket.id);

    socket.join('rtc:' + roomId);
    socket.to('rtc:' + roomId).emit('rtc:peer-joined', {
      socketId: socket.id,
      username: user.username,
      avatar: user.avatar,
      avatar_frame: user.avatar_frame,
    });

    if (!voiceRooms.has(roomId)) voiceRooms.set(roomId, new Map());
    voiceRooms.get(roomId).set(socket.id, { socketId: socket.id, userId: user.id, username: user.username });
    broadcastVoiceRoom(roomId);

    // Manda o estado atual da fila de música pra quem acabou de entrar, pra
    // ele já cair sincronizado com o resto da sala.
    socket.emit('music:state', musicRoomStateForClient(roomId));
    reply({ ok: true });
  });

  socket.on('rtc:leave', (roomId) => {
    socket.leave('rtc:' + roomId);
    socket.to('rtc:' + roomId).emit('rtc:peer-left', { socketId: socket.id, username: user.username });
    if (voiceRooms.has(roomId)) {
      voiceRooms.get(roomId).delete(socket.id);
      broadcastVoiceRoom(roomId);
      maybeDeleteEmptyQuickRoom(roomId);
    }
  });

  // ---------- NEXT MUSIC (item 14 do plano) ----------
  // Fila de música por sala de voz, tocada via player oficial embutido do
  // YouTube em cada navegador — nunca baixa nem guarda áudio no servidor,
  // só a lista de vídeos (id + título) e o estado de reprodução (o quê,
  // pausado/tocando, em que posição), pra sincronizar todo mundo na sala.

  socket.on('music:add', async ({ roomId, videoId }) => {
    if (!roomId || !videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return;
    // Busca o título de verdade pelo oEmbed público do YouTube (sem precisar
    // de chave de API, sem baixar o vídeo — só metadados públicos).
    let title = 'Vídeo do YouTube';
    try {
      const oembedRes = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`
      );
      if (oembedRes.ok) {
        const oembed = await oembedRes.json();
        if (oembed.title) title = String(oembed.title).slice(0, 120);
      } else {
        return; // vídeo não existe/privado/removido — não adiciona lixo na fila
      }
    } catch (_) {
      // Rede falhou — segue com título genérico em vez de travar a fila.
    }
    const room = musicRoomState(roomId, true);
    room.queue.push({
      id: uuidv4(),
      videoId,
      title,
      addedBy: user.id,
      addedByUsername: user.username,
    });
    // Fila tava vazia — começa a tocar direto, sem precisar de "play" manual.
    if (room.currentIndex === -1) {
      room.currentIndex = 0;
      room.isPlaying = true;
      room.positionMs = 0;
      room.lastUpdate = Date.now();
    }
    io.to('rtc:' + roomId).emit('music:state', musicRoomStateForClient(roomId));
  });

  async function canControlMusic(roomId) {
    if (user.is_admin) return true;
    const channel = await db.get('SELECT category FROM channels WHERE id = ?', [roomId]);
    if (!channel) return false;
    return hasServerPermission(channel.category, user, 'manage_channels');
  }

  socket.on('music:remove', async ({ roomId, queueId }) => {
    if (!(await canControlMusic(roomId))) return;
    const room = musicRoomState(roomId, true);
    const idx = room.queue.findIndex((t) => t.id === queueId);
    if (idx === -1) return;
    room.queue.splice(idx, 1);
    if (idx === room.currentIndex) {
      room.positionMs = 0;
      room.lastUpdate = Date.now();
      room.isPlaying = room.queue.length > 0 && room.currentIndex < room.queue.length;
      if (room.currentIndex >= room.queue.length) room.currentIndex = room.queue.length > 0 ? 0 : -1;
    } else if (idx < room.currentIndex) {
      room.currentIndex--;
    }
    io.to('rtc:' + roomId).emit('music:state', musicRoomStateForClient(roomId));
  });

  socket.on('music:playpause', async ({ roomId }) => {
    if (!(await canControlMusic(roomId))) return;
    const room = musicRoomState(roomId, true);
    if (room.currentIndex === -1) return;
    if (room.isPlaying) {
      room.positionMs += Date.now() - room.lastUpdate;
      room.isPlaying = false;
    } else {
      room.isPlaying = true;
    }
    room.lastUpdate = Date.now();
    io.to('rtc:' + roomId).emit('music:state', musicRoomStateForClient(roomId));
  });

  socket.on('music:skip', async ({ roomId }) => {
    if (!(await canControlMusic(roomId))) return;
    const room = musicRoomState(roomId, true);
    if (room.currentIndex === -1) return;
    room.currentIndex++;
    room.positionMs = 0;
    room.lastUpdate = Date.now();
    room.isPlaying = room.currentIndex < room.queue.length;
    if (!room.isPlaying) room.currentIndex = -1;
    io.to('rtc:' + roomId).emit('music:state', musicRoomStateForClient(roomId));
  });

  // Quando o vídeo termina naturalmente, qualquer pessoa na sala pode avisar
  // (não precisa de permissão de moderador pra isso — é só "acabou, próxima")
  // — mas só avança de verdade se o índice bater com o estado atual, pra não
  // pular duas vezes quando várias pessoas percebem o fim ao mesmo tempo.
  socket.on('music:track-ended', ({ roomId, atIndex }) => {
    const room = musicRoomState(roomId, true);
    if (room.currentIndex !== atIndex) return;
    room.currentIndex++;
    room.positionMs = 0;
    room.lastUpdate = Date.now();
    room.isPlaying = room.currentIndex < room.queue.length;
    if (!room.isPlaying) room.currentIndex = -1;
    io.to('rtc:' + roomId).emit('music:state', musicRoomStateForClient(roomId));
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
    io.to(to).emit('rtc:signal', {
      from: socket.id,
      username: user.username,
      avatar: user.avatar,
      avatar_frame: user.avatar_frame,
      data,
    });
  });

  socket.on('disconnect', () => {
    io.emit('presence:disconnect', { userId: user.id });
  });
});

// Pega erro que escapou de qualquer try/catch (ex: dentro de um handler de
// socket.io fora do padrão asyncHandler) — sem isso esses erros só apareciam
// no log do Render e nunca no painel de monitoramento. Não derruba o
// processo (só loga), pra não tirar todo mundo do ar por causa de um erro
// isolado numa única requisição/socket.
process.on('uncaughtException', (err) => {
  console.error('Exceção não tratada:', err);
  logError('uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Promise rejeitada sem catch:', reason);
  logError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
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
