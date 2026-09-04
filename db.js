// db.js - conexão com o banco de dados
//
// Usa o Turso (turso.tech) por padrão: compatível com SQLite, gratuito pra
// sempre (sem prazo de validade, sem cartão), e os dados sobrevivem a
// reinícios/redeploys do servidor — diferente de um arquivo SQLite local no
// Render, que é apagado a cada novo deploy.
//
// Configuração (variáveis de ambiente):
//   TURSO_DATABASE_URL - ex: libsql://seu-banco-sua-org.turso.io
//   TURSO_AUTH_TOKEN   - token de autenticação do banco
//
// Sem essas duas variáveis configuradas, cai automaticamente num arquivo
// SQLite local (data.sqlite) — funciona bem pra testar no seu computador,
// mas em produção sem Turso os dados não persistem entre reinícios. Veja o
// DEPLOY.md pra criar o banco grátis e configurar isso.
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');
// Sistema novo de personalização (temas, fundos, efeitos, chat, figurinhas,
// perfil) que substitui o antigo NEXTGAME PLUS simples — desenvolvido à
// parte em plus-v2/ e agora ligado aqui no init do banco.
const { ensurePlusV2Schema, seedPlusV2Defaults } = require('./plus-v2/db-plus2');

// ID fixo do usuário-bot assistente de IA — usado pelo server.js pra saber
// quando uma DM é uma conversa com a IA (em vez de com outra pessoa).
const AI_BOT_USER_ID = 'ai-assistant-bot';
const AI_BOT_USERNAME = 'NEXT GAME IA';

// Gera uma hashtag de 4 dígitos (0000-9999, com zero à esquerda quando
// precisar) e confere no banco se username+discriminator já existe — se
// existir, tenta de novo com outra. Como "username" já é único nesta
// aplicação (login/DMs/menções dependem disso — ver nota grande logo abaixo
// no initDb), essa colisão na prática nunca acontece, mas o código segue o
// padrão pedido mesmo assim, pra já vir pronto se um dia o username deixar
// de ser único.
async function generateUniqueDiscriminator(username) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const discriminator = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const clash = await get('SELECT id FROM users WHERE username = ? AND discriminator = ?', [
      username,
      discriminator,
    ]);
    if (!clash) return discriminator;
  }
  // Praticamente impossível cair aqui (precisaria de 20 colisões seguidas
  // num espaço de 10 mil combinações), mas não deixa a conta travar se cair.
  return String(Date.now()).slice(-4);
}

const url = process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, 'data.sqlite')}`;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!process.env.TURSO_DATABASE_URL) {
  console.warn(
    '[aviso] TURSO_DATABASE_URL não configurada — usando arquivo SQLite local. ' +
      'Em produção (Render), isso significa que os dados podem ser apagados a cada redeploy. Veja o DEPLOY.md.'
  );
}

const client = createClient(authToken ? { url, authToken } : { url });

async function run(sql, args = []) {
  const res = await client.execute({ sql, args });
  return { lastInsertRowid: res.lastInsertRowid, changes: res.rowsAffected };
}

async function get(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows[0];
}

async function all(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows;
}

async function ensureColumn(table, columnDef) {
  try {
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (err) {
    // coluna já existe — ignora
  }
}

// Precisa ser chamada (e esperada) antes do servidor começar a atender
// requisições, já que aqui é tudo assíncrono (banco remoto).
async function initDb() {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      email TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      verification_code TEXT,
      verification_expires TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_banned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'texto',
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Canal privado por cargo (item 5 do plano): se um canal tem QUALQUER
    -- linha aqui, só quem tem um desses cargos (ou é dono/admin) o vê e
    -- acessa. Sem nenhuma linha = visível pra todo mundo do servidor, igual
    -- sempre foi (retrocompatível, não quebra nada que já existe).
    CREATE TABLE IF NOT EXISTS channel_role_access (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      UNIQUE(channel_id, role_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      flagged INTEGER NOT NULL DEFAULT 0,
      flag_categories TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Toda leitura de histórico (canal de servidor OU DM) faz
    -- "WHERE channel_id = ? ORDER BY created_at" — sem índice isso vira
    -- table scan completo conforme a tabela de mensagens cresce (item 5 do
    -- PDF de auditoria: "criar índices pra evitar lentidão").
    CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at);

    CREATE TABLE IF NOT EXISTS blocked_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      flag_categories TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      reported_user_id TEXT,
      reporter_user_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Canal de reclamação/suporte com a Blue (empresa por trás do NEXT GAME) —
    -- separado de "reports" (que é denúncia de UM USUÁRIO sobre OUTRO). Aqui é
    -- a pessoa falando direto com o suporte da plataforma. user_id fica NULL
    -- quando quem manda nem tem conta ativa (ex: alguém banido tentando
    -- recorrer) — nesse caso name/email vêm preenchidos manualmente no form.
    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      username TEXT,
      name TEXT,
      email TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'outro',
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'aberto',
      admin_response TEXT,
      responded_by TEXT,
      responded_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Cupons de resgate (ex: "quem faz recarga full no Magic Tank ganha
    -- NEXT GAME PLUS") — código de uso único que o admin gera e entrega por
    -- fora (nenhum pagamento passa pelo NEXT GAME nisso), a pessoa digita em
    -- Configurações > NEXTGAME PLUS pra liberar o plano por um tempo.
    CREATE TABLE IF NOT EXISTS redeem_codes (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      plan TEXT NOT NULL DEFAULT 'plus',
      days INTEGER NOT NULL DEFAULT 30,
      note TEXT,
      used_by TEXT,
      used_at TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS message_reactions (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(message_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS servers (
      category TEXT PRIMARY KEY,
      description TEXT,
      rules TEXT,
      icon TEXT,
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Configurações gerais do site, uma linha por chave (liga/desliga
    -- simples que o admin controla). Começou com "official_servers_pinned"
    -- (servidores com selo oficial sempre no topo de "Servidores em
    -- Destaque"), mas serve pra qualquer outro toggle parecido no futuro.
    CREATE TABLE IF NOT EXISTS site_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tournaments (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      game TEXT NOT NULL,
      event_date TEXT,
      prize TEXT,
      max_slots INTEGER NOT NULL DEFAULT 32,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tournament_registrations (
      id TEXT PRIMARY KEY,
      tournament_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      team_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tournament_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS user_rewards (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      reward_key TEXT NOT NULL,
      verification_code TEXT,
      unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, reward_key)
    );

    CREATE TABLE IF NOT EXISTS user_mission_progress (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      mission_key TEXT NOT NULL,
      points_awarded INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, mission_key)
    );

    CREATE TABLE IF NOT EXISTS server_members (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(category, user_id)
    );

    CREATE TABLE IF NOT EXISTS server_roles (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#99aab5',
      permissions TEXT NOT NULL DEFAULT '[]',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS server_member_roles (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      UNIQUE(category, user_id, role_id)
    );

    CREATE TABLE IF NOT EXISTS friendships (
      id TEXT PRIMARY KEY,
      user_a TEXT NOT NULL,
      user_b TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_a, user_b)
    );

    CREATE TABLE IF NOT EXISTS dm_channels (
      id TEXT PRIMARY KEY,
      user_a TEXT NOT NULL,
      user_b TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dm_channels_user_a ON dm_channels(user_a);
    CREATE INDEX IF NOT EXISTS idx_dm_channels_user_b ON dm_channels(user_b);
    CREATE INDEX IF NOT EXISTS idx_friendships_user_a ON friendships(user_a);
    CREATE INDEX IF NOT EXISTS idx_friendships_user_b ON friendships(user_b);

    -- Marca de "última leitura" por usuário/canal — usada pra calcular
    -- contador de mensagens não lidas nas DMs (item 3 do PDF de auditoria).
    -- Serve tanto pra DM (channel_id = 'dm::a::b') quanto, no futuro, pra
    -- canal de servidor, sem precisar de tabela nova pra cada tipo.
    CREATE TABLE IF NOT EXISTS channel_reads (
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_read_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (channel_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_reads_user ON channel_reads(user_id);

    CREATE TABLE IF NOT EXISTS flagged_frames (
      id TEXT PRIMARY KEY,
      channel_id TEXT,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      reason TEXT,
      categories TEXT,
      reviewed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- NEXTGAME PLUS — histórico de assinaturas via PayPal. Uma linha por
    -- assinatura criada (não por cobrança individual); o status é atualizado
    -- via webhook do PayPal conforme ela é aprovada/cancelada/expira. Guardar
    -- isso separado de "users.plan" permite auditoria (quando começou, qual
    -- assinatura do PayPal deu origem ao Plus de cada conta) sem precisar
    -- confiar só no estado atual.
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      paypal_subscription_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);

    CREATE TABLE IF NOT EXISTS blocked_users (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      blocked_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, blocked_user_id)
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_agent TEXT,
      ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS notification_prefs (
      user_id TEXT PRIMARY KEY,
      prefs TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      actor_username TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS game_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      game TEXT NOT NULL,
      rank TEXT,
      role TEXT,
      hours INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      kills INTEGER NOT NULL DEFAULT 0,
      deaths INTEGER NOT NULL DEFAULT 0,
      assists INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, game)
    );

    CREATE TABLE IF NOT EXISTS lfg_posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      game TEXT NOT NULL,
      players_needed INTEGER NOT NULL DEFAULT 1,
      rank_min TEXT,
      rank_max TEXT,
      region TEXT,
      language TEXT,
      mic_required TEXT NOT NULL DEFAULT 'opcional',
      role TEXT,
      available_time TEXT,
      note TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lfg_group_members (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      logo TEXT,
      banner TEXT,
      description TEXT,
      game TEXT,
      leader_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'jogador',
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(team_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS clans (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      logo TEXT,
      level INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clan_members (
      id TEXT PRIMARY KEY,
      clan_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'membro',
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(clan_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS reputation_endorsements (
      id TEXT PRIMARY KEY,
      from_user_id TEXT NOT NULL,
      to_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(from_user_id, to_user_id)
    );

    CREATE TABLE IF NOT EXISTS tournament_matches (
      id TEXT PRIMARY KEY,
      tournament_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      match_index INTEGER NOT NULL,
      player_a_id TEXT,
      player_a_name TEXT,
      player_b_id TEXT,
      player_b_name TEXT,
      winner_id TEXT,
      score_a INTEGER,
      score_b INTEGER,
      status TEXT NOT NULL DEFAULT 'pendente',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS seasons (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS feed_posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT,
      ref_type TEXT,
      ref_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clips (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      game TEXT,
      video_url TEXT NOT NULL,
      tags TEXT,
      views INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS content_comments (
      id TEXT PRIMARY KEY,
      content_type TEXT NOT NULL,
      content_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS content_likes (
      id TEXT PRIMARY KEY,
      content_type TEXT NOT NULL,
      content_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(content_type, content_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS streams (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      title TEXT NOT NULL,
      game TEXT,
      external_url TEXT NOT NULL,
      is_live INTEGER NOT NULL DEFAULT 1,
      started_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stream_follows (
      id TEXT PRIMARY KEY,
      follower_id TEXT NOT NULL,
      streamer_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(follower_id, streamer_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      category TEXT,
      name TEXT NOT NULL,
      game TEXT,
      description TEXT,
      event_date TEXT,
      max_participants INTEGER,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS event_participants (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(event_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS coin_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS shop_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL DEFAULT 'cosmetico',
      cost INTEGER NOT NULL,
      image TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS coin_purchases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      logo TEXT,
      banner TEXT,
      description TEXT,
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS organization_teams (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      UNIQUE(org_id, team_id)
    );

    CREATE TABLE IF NOT EXISTS organization_sponsors (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      logo_url TEXT
    );

    CREATE TABLE IF NOT EXISTS org_tryouts (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      title TEXT NOT NULL,
      game TEXT,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS org_tryout_applications (
      id TEXT PRIMARY KEY,
      tryout_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tryout_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS marketplace_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      portfolio_url TEXT,
      rate_display TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS marketplace_reviews (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      reviewer_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(profile_id, reviewer_id)
    );

    CREATE TABLE IF NOT EXISTS external_integrations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      external_username TEXT,
      connected_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, provider)
    );
  `);

  // Migração leve pra bancos criados antes de alguma dessas colunas existir.
  await ensureColumn('users', 'email TEXT');
  await ensureColumn('users', 'login_streak INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'longest_streak INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'last_login_date TEXT');
  await ensureColumn('users', 'avatar_frame TEXT');
  await ensureColumn('users', 'points INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('servers', 'icon TEXT');
  await ensureColumn('servers', 'discoverable INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('servers', 'owner_id TEXT');
  await ensureColumn('servers', 'invite_code TEXT');
  await ensureColumn('users', 'email_verified INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'verification_code TEXT');
  await ensureColumn('users', 'verification_expires TEXT');
  await ensureColumn('users', 'status_message TEXT');
  await ensureColumn('users', 'avatar TEXT');
  await ensureColumn('channels', 'created_by TEXT');
  await ensureColumn('messages', 'edited INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('messages', 'deleted INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('messages', 'pinned INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('channels', 'slow_mode_seconds INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('channels', 'read_only INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'totp_secret TEXT');
  await ensureColumn('users', 'totp_enabled INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'timeout_until TEXT');
  // Suspensão AUTOMÁTICA da IA de moderação (distinta de um admin banindo na
  // mão) — pra suspeita de conteúdo infantil em contexto de risco flagrada
  // em foto/tela/câmera. auto_suspended=1 marca que precisa de revisão
  // humana urgente (não é uma decisão definitiva, é uma pausa de segurança).
  await ensureColumn('users', 'auto_suspended INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'ban_reason TEXT');
  await ensureColumn('messages', 'thread_parent_id TEXT');
  await ensureColumn('messages', 'has_link INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'reputation INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'region TEXT');
  await ensureColumn('users', 'bio TEXT');
  await ensureColumn('users', 'language TEXT');
  await ensureColumn('users', 'coins INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'full_name TEXT');
  await ensureColumn('users', 'country TEXT');
  await ensureColumn('users', 'platforms TEXT');
  await ensureColumn('users', 'play_style TEXT');
  await ensureColumn('users', 'favorite_games TEXT');
  await ensureColumn('users', 'preferred_rank TEXT');
  await ensureColumn('tournaments', "format TEXT NOT NULL DEFAULT 'eliminacao'");
  await ensureColumn('tournaments', 'checkin_opens_minutes INTEGER NOT NULL DEFAULT 30');
  await ensureColumn('tournament_registrations', 'checked_in INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('tournament_registrations', 'checked_in_at TEXT');
  await ensureColumn('tournament_matches', 'evidence_url TEXT');
  await ensureColumn('servers', "access_mode TEXT NOT NULL DEFAULT 'convite'");
  await ensureColumn('servers', 'password_hash TEXT');
  await ensureColumn('users', "presence_status TEXT NOT NULL DEFAULT 'online'");
  await ensureColumn('servers', 'invite_expires_at TEXT');
  await ensureColumn('servers', 'invite_max_uses INTEGER');
  await ensureColumn('servers', 'invite_uses INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('servers', 'invite_active INTEGER NOT NULL DEFAULT 1');
  // Tipos de sala de voz: 'conversa' (padrão), 'jogo' (vinculada a um jogo) ou
  // 'evento' (torneio/evento). voice_game só é usado quando voice_type='jogo'.
  // is_quick marca salas rápidas/temporárias que se apagam quando todos saem.
  await ensureColumn('channels', "voice_type TEXT NOT NULL DEFAULT 'conversa'");
  await ensureColumn('channels', 'voice_game TEXT');
  await ensureColumn('channels', 'is_quick INTEGER NOT NULL DEFAULT 0');
  // "Apagar conversa" da auditoria — na verdade oculta só pro usuário que
  // pediu (igual Discord "Fechar DM"): se chegar mensagem nova depois disso,
  // a conversa reaparece sozinha pra essa pessoa.
  await ensureColumn('dm_channels', 'hidden_for_a TEXT');
  await ensureColumn('dm_channels', 'hidden_for_b TEXT');
  // PEDIDO DE MENSAGEM: antes, mandar DM pra alguém que não é seu amigo e
  // não está em nenhum servidor com você era bloqueado com erro — agora vira
  // um "pedido de mensagem" (igual Instagram/Messenger): o canal já existe e
  // quem mandou pode escrever, mas fica como status='pending' até a outra
  // pessoa aceitar (POST /api/dm/:channelId/accept) ou recusar
  // (POST /api/dm/:channelId/decline). Amigos e gente do mesmo servidor
  // continuam abrindo a conversa direto, status='active', sem pedido nenhum.
  await ensureColumn('dm_channels', "status TEXT NOT NULL DEFAULT 'active'");
  await ensureColumn('dm_channels', 'requested_by TEXT');

  // ---------- IDENTIFICAÇÃO POR HASHTAG (@Username#1234, estilo Discord) ----------
  // discriminator = os 4 dígitos; username_tag = "username#1234" já pronto
  // pra exibir/pesquisar sem precisar concatenar toda hora. O "id" continua
  // sendo a chave interna de verdade — a hashtag é só uma camada pública de
  // identificação por cima, nunca usada pra autorização (login continua por
  // username, que já era único antes disso; ver nota abaixo).
  await ensureColumn('users', 'discriminator TEXT');
  await ensureColumn('users', 'username_tag TEXT');

  // ECA Digital (Lei 15.211/25) — data de nascimento coletada no cadastro
  // pra permitir sinalizar/priorizar moderação de contas de menores.
  await ensureColumn('users', 'birth_date TEXT');

  // Anexo de arquivo em mensagem — JSON com {name, type, size, data (data
  // URL base64)}. Guardado igual avatar (base64 direto na coluna), sem
  // storage externo — simples, mas por isso o limite de tamanho é apertado
  // (5MB) pra não inchar o banco.
  await ensureColumn('messages', 'attachment TEXT');

  // NEXTGAME PLUS — plano da conta ('free' ou 'plus'). Fonte da verdade pra
  // qualquer checagem de limite/feature no site inteiro (transmissão em
  // 1080p60, arquivos maiores etc). O histórico de "por quê" essa conta é
  // Plus fica na tabela subscriptions; aqui é só o estado atual, rápido de
  // checar em qualquer request sem join.
  await ensureColumn('users', "plan TEXT NOT NULL DEFAULT 'free'");
  // De onde veio o plano Plus ('paypal' = assinatura paga real, 'reward' =
  // ganhou de prêmio, null = concedido manualmente por admin) e quando
  // expira (só usado pra prêmios; assinatura paga não expira por tempo, só
  // por cancelamento via webhook). Importante separar isso pra nunca a
  // expiração de um prêmio derrubar quem está pagando de verdade.
  await ensureColumn('users', 'plan_source TEXT');
  await ensureColumn('users', 'plan_expires_at TEXT');

  // ECA Digital — verificação de idade por câmera (opcional, feita 100% no
  // navegador da pessoa via face-api.js; nenhuma imagem/rosto chega no
  // nosso servidor, só esse número estimado). Usado como sinal extra pra
  // priorizar revisão, nunca pra bloquear cadastro sozinho.
  await ensureColumn('users', 'estimated_age INTEGER');

  // Admin (dono/moderador da plataforma) sempre tem acesso Plus completo,
  // sem precisar assinar — grava isso de verdade no banco (não só calcula
  // na hora) pra ficar consistente em qualquer lugar que leia o usuário
  // direto do banco. Roda toda vez que o servidor sobe, então cobre também
  // quem virar admin depois.
  await run(
    "UPDATE users SET plan = 'plus', plan_source = 'admin' WHERE is_admin = 1 AND (plan IS NULL OR plan != 'plus' OR plan_source IS NULL OR plan_source != 'admin')"
  );

  const seedChannels = [
    { id: 'gamers-geral', name: 'geral', category: 'gamers', type: 'texto' },
    { id: 'gamers-lfg', name: 'procurando-grupo', category: 'gamers', type: 'texto' },
    { id: 'gamers-voz-1', name: 'Sala de Voz 1', category: 'gamers', type: 'voz' },
    { id: 'trabalho-geral', name: 'geral', category: 'trabalho', type: 'texto' },
    { id: 'trabalho-anuncios', name: 'anuncios', category: 'trabalho', type: 'texto' },
    { id: 'trabalho-reuniao', name: 'Sala de Reunião', category: 'trabalho', type: 'voz' },
  ];
  for (const ch of seedChannels) {
    await run('INSERT OR IGNORE INTO channels (id, name, category, type) VALUES (?, ?, ?, ?)', [
      ch.id,
      ch.name,
      ch.category,
      ch.type,
    ]);
  }

  // Os dois servidores padrão (gamers/trabalho) não têm dono — são as
  // "comunidades públicas" iniciais, abertas a todo mundo que se cadastra
  // (diferente de um servidor criado por um usuário depois, que já nasce
  // privado e com dono). Precisam existir na tabela servers com um código de
  // convite pra o resto do sistema de permissões/convite funcionar com eles.
  for (const category of ['gamers', 'trabalho']) {
    const existing = await get('SELECT category FROM servers WHERE category = ?', [category]);
    if (!existing) {
      const inviteCode = crypto.randomBytes(5).toString('hex');
      await run('INSERT INTO servers (category, invite_code) VALUES (?, ?)', [category, inviteCode]);
    }
  }

  // Migração pra contas criadas antes do sistema de membros existir: quem
  // ainda não é membro de nenhum servidor entra automaticamente nos dois
  // públicos padrão, senão a conta ficaria "presa" sem ver servidor nenhum.
  const usersWithoutMembership = await all(`
    SELECT id FROM users WHERE id NOT IN (SELECT DISTINCT user_id FROM server_members)
  `);
  for (const u of usersWithoutMembership) {
    for (const category of ['gamers', 'trabalho']) {
      await run('INSERT OR IGNORE INTO server_members (id, category, user_id) VALUES (?, ?, ?)', [
        crypto.randomUUID(),
        category,
        u.id,
      ]);
    }
  }

  // Usuário real do bot assistente de IA — precisa existir na tabela users
  // pra aparecer com avatar/nome normalmente em qualquer lugar que mostra
  // quem mandou uma mensagem. A senha é um valor aleatório inutilizável (só
  // existe pra satisfazer o NOT NULL da coluna); ninguém consegue logar com
  // essa conta.
  const existingBot = await get('SELECT id FROM users WHERE id = ?', [AI_BOT_USER_ID]);
  if (!existingBot) {
    const unusablePassword = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
    const botDiscriminator = await generateUniqueDiscriminator(AI_BOT_USERNAME);
    await run(
      `INSERT INTO users (id, username, password_hash, is_admin, is_banned, email_verified, avatar, status_message, discriminator, username_tag)
       VALUES (?, ?, ?, 0, 0, 1, ?, ?, ?, ?)`,
      [
        AI_BOT_USER_ID,
        AI_BOT_USERNAME,
        unusablePassword,
        'emoji:🤖:#00d9c0',
        'Sempre pronto pra ajudar',
        botDiscriminator,
        `${AI_BOT_USERNAME}#${botDiscriminator}`,
      ]
    );
  }

  // Migração pra contas criadas antes do sistema de hashtag existir — toda
  // conta precisa ter @username#1234, então preenche quem ainda não tem.
  const usersWithoutTag = await all('SELECT id, username FROM users WHERE discriminator IS NULL OR username_tag IS NULL');
  for (const u of usersWithoutTag) {
    const discriminator = await generateUniqueDiscriminator(u.username);
    await run('UPDATE users SET discriminator = ?, username_tag = ? WHERE id = ?', [
      discriminator,
      `${u.username}#${discriminator}`,
      u.id,
    ]);
  }

  // ---------- JOGOS SALVOS ("biblioteca" pessoal na barra lateral) ----------
  await run(`
    CREATE TABLE IF NOT EXISTS saved_games (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      game_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, game_name)
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_saved_games_user ON saved_games(user_id)');

  // ---------- SELO VERIFICADO (conta oficial NEXT GAME) ----------
  // Separado do 👑 de admin de propósito: admin é poder de moderação, selo
  // verificado é só "essa conta é oficial/confiável" — dá pra um admin
  // verificar gente que trabalha pra ele (suporte, staff) sem dar acesso de
  // moderação, e vice-versa. Toda conta admin e o bot de IA vêm verificados
  // por padrão (roda a cada início pra garantir isso mesmo se alguém tirar
  // sem querer); qualquer outra conta o admin verifica manualmente pelo
  // painel /admin.html.
  await ensureColumn('users', 'is_verified INTEGER NOT NULL DEFAULT 0');
  await run('UPDATE users SET is_verified = 1 WHERE is_admin = 1');
  await run('UPDATE users SET is_verified = 1 WHERE id = ?', [AI_BOT_USER_ID]);

  // Selo dourado — mesma ideia do selo azul (is_verified), mas pra contas
  // de PARCEIRO oficial (ex: dono/representante do jogo parceiro Magic
  // Tank), visualmente diferente do azul da própria NEXT GAME. Sempre junto
  // com is_verified=1 (é um selo "verificado", só muda a cor); o admin liga
  // pelo painel /admin.html > Usuários quando quiser (ver /verify-gold).
  await ensureColumn('users', 'verified_gold INTEGER NOT NULL DEFAULT 0');

  // Recuperação de senha por e-mail — token de uso único com validade curta,
  // separado do verification_code (que é só pra confirmação de cadastro).
  await ensureColumn('users', 'reset_token TEXT');
  await ensureColumn('users', 'reset_token_expires TEXT');

  // E-mail alternativo (recuperação) — a pessoa cadastra um segundo e-mail
  // (precisa confirmar que é dono dele, igual o e-mail principal) pra usar
  // caso um dia perca acesso ao e-mail principal. backup_email_verified só
  // vira 1 depois de confirmar o código enviado pra esse endereço; enquanto
  // não confirma, não serve pra recuperação nenhuma (evita alguém colocar um
  // e-mail que não é dela e sequestrar a conta de outra pessoa depois).
  await ensureColumn('users', 'backup_email TEXT');
  await ensureColumn('users', 'backup_email_verified INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'backup_email_code TEXT');
  await ensureColumn('users', 'backup_email_code_expires TEXT');

  // Recuperação de conta via e-mail alternativo — código separado do
  // reset_token de senha, usado no fluxo "Perdi acesso ao e-mail" (login ->
  // troca o e-mail principal e, se quiser, a senha também).
  await ensureColumn('users', 'recovery_code TEXT');
  await ensureColumn('users', 'recovery_code_expires TEXT');

  // ---------- PERSONALIZAÇÃO (Plus V2): temas, fundos, efeitos, chat,
  // figurinhas e perfil — substitui o antigo sistema simples de tema de cor
  // do NEXTGAME PLUS. Ver plus-v2/db-plus2.js pro catálogo padrão completo.
  await ensurePlusV2Schema({ run, get, all, ensureColumn });
  await seedPlusV2Defaults({ run, get, all, ensureColumn });

  // ---------- CUPONS PRÉ-GERADOS (Magic Tank — recarga full -> 1 mês de PLUS) ----------
  // Lote pronto pra entregar direto ao parceiro (ele distribui pra quem
  // compra a recarga full) — sem precisar entrar no /admin.html toda vez.
  // Idempotente: cada código só é inserido se ainda não existir.
  await seedMagicTankCoupons({ run, get });

  // ---------- SERVIDORES OFICIAIS (selo de verificado) ----------
  await ensureColumn('servers', 'is_official INTEGER NOT NULL DEFAULT 0');
  await seedOfficialServers({ run, get, all });

  // ---------- CONTA DE MODERADOR (acesso parcial: BLUEX + moderação básica) ----------
  await ensureColumn('users', 'is_moderator INTEGER NOT NULL DEFAULT 0');
  await seedModeratorAccount({ run, get });
}

// Conta de staff com acesso PARCIAL ao painel /admin.html — só as abas
// "Segurança/BLUEX" e "Moderação" (denúncias, contas suspeitas/menores,
// mensagens bloqueadas/sinalizadas, banir/suspender conta flagrada). Sem
// acesso a Usuários, Loja, Personalização, Suporte ou Audit Log — essas
// continuam exclusivas de quem tem is_admin=1 de verdade (ver requireAdmin
// vs requireModerator em server.js). Roda só uma vez: se a conta já existe
// (foi criada aqui ou alguém já trocou a senha dela), não mexe em nada.
// Lote de 100 códigos de uso único (30 dias de PLUS cada) pra entregar ao
// parceiro Magic Tank — ele distribui um código pra cada pessoa que faz a
// recarga full, e cada código só funciona UMA vez (ver /api/redeem-code em
// server.js: assim que alguém resgata, marca used_by e nunca mais aceita de
// novo). Idempotente: roda toda vez que o servidor sobe, mas só insere quem
// ainda não existe — não duplica nem recria os que já foram resgatados.
const MAGIC_TANK_COUPON_CODES = [
  'NEXT-25V6-9NQ5', 'NEXT-2ADG-43YZ', 'NEXT-2AMN-QC76', 'NEXT-2NU8-2VNG', 'NEXT-2NUB-MZPM',
  'NEXT-3S73-TE36', 'NEXT-3SRR-58BA', 'NEXT-3Y4F-CAWA', 'NEXT-4244-2HP3', 'NEXT-4U9V-Z4ME',
  'NEXT-4X77-73W8', 'NEXT-52KT-U6M9', 'NEXT-5XG3-WBY5', 'NEXT-6VDX-XBYY', 'NEXT-6WWR-EDJM',
  'NEXT-78S2-CQFR', 'NEXT-7DBU-7NAR', 'NEXT-8JK2-KE6B', 'NEXT-8QNC-4N4P', 'NEXT-8SYS-SCXU',
  'NEXT-8Z7R-NACK', 'NEXT-9MMF-TQQ5', 'NEXT-9RTU-ZZEB', 'NEXT-9SKV-SRQP', 'NEXT-AD8Y-HUNN',
  'NEXT-AJ3P-HGN2', 'NEXT-AQYM-5QJB', 'NEXT-AXSE-7R67', 'NEXT-BA7G-CDVS', 'NEXT-BADG-6GMZ',
  'NEXT-BBMS-824E', 'NEXT-BH3C-TGWZ', 'NEXT-BS42-JRNW', 'NEXT-BYNC-BFHE', 'NEXT-CCUZ-J2XG',
  'NEXT-CDEH-2NRX', 'NEXT-CJWF-M2F7', 'NEXT-CT58-Y9UD', 'NEXT-DBMZ-Z9G2', 'NEXT-DJ22-MHVH',
  'NEXT-EWY9-ZK3J', 'NEXT-FCP9-2PF4', 'NEXT-FJM5-ER8K', 'NEXT-FT87-ED5A', 'NEXT-GHJA-WFHV',
  'NEXT-GKPH-GQ5P', 'NEXT-GQBY-KDBG', 'NEXT-H2PR-7AG2', 'NEXT-H62M-ZSH8', 'NEXT-HXB4-2NJS',
  'NEXT-JQE8-SSX4', 'NEXT-JZM5-C5TG', 'NEXT-KEFB-3JM3', 'NEXT-KMQT-EX2B', 'NEXT-KP9A-5JX7',
  'NEXT-KPER-34ZT', 'NEXT-KV7B-6TV9', 'NEXT-M6U7-4VR5', 'NEXT-ME2S-P2MW', 'NEXT-MEN2-TK7F',
  'NEXT-NGQF-B965', 'NEXT-NNXZ-GPWR', 'NEXT-PBWK-Q6WH', 'NEXT-PG4P-SBQU', 'NEXT-PQ47-D6JS',
  'NEXT-PQ85-FAS3', 'NEXT-PSBV-TH83', 'NEXT-QHPC-8C7S', 'NEXT-QNYZ-UUJA', 'NEXT-QRXN-MBDA',
  'NEXT-QW8N-ZSTT', 'NEXT-R7PK-4PZC', 'NEXT-S7X3-PQ9K', 'NEXT-SFMW-RZVT', 'NEXT-TJ3M-W4ZU',
  'NEXT-TJ8J-KYNZ', 'NEXT-UPG9-YTNN', 'NEXT-UTBR-H4BD', 'NEXT-VUY9-DSBQ', 'NEXT-W2WJ-3MTX',
  'NEXT-W3VN-4GZ4', 'NEXT-WECG-GGJ9', 'NEXT-WEMH-795D', 'NEXT-WFDV-79XE', 'NEXT-WMJ9-JSV8',
  'NEXT-WMKF-BBRN', 'NEXT-WMKZ-M5WA', 'NEXT-X5XS-XXU2', 'NEXT-X842-M7V9', 'NEXT-XJAA-3ZX9',
  'NEXT-XM4F-755F', 'NEXT-XW7T-898E', 'NEXT-XZAQ-Y782', 'NEXT-YAV9-3MGC', 'NEXT-YAZX-HEF9',
  'NEXT-YJGT-KRH9', 'NEXT-YN5K-X6N2', 'NEXT-YSG2-JQHP', 'NEXT-YSH2-4EDV', 'NEXT-YYUW-R6DT',
];
async function seedMagicTankCoupons({ run, get }) {
  for (const code of MAGIC_TANK_COUPON_CODES) {
    const existing = await get('SELECT id FROM redeem_codes WHERE code = ?', [code]);
    if (existing) continue;
    await run(
      'INSERT INTO redeem_codes (id, code, plan, days, note, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), code, 'plus', 30, 'Magic Tank — recarga full', 'seed']
    );
  }
}

async function seedModeratorAccount({ run, get }) {
  const USERNAME = 'moderador_bluex';
  // Senha inicial temporária — a pessoa que for usar essa conta deve trocar
  // em Configurações > Segurança assim que entrar pela primeira vez (e
  // precisa ativar 2FA antes de conseguir abrir o painel /admin.html, igual
  // qualquer conta admin/moderadora — ver requireModerator).
  const INITIAL_PASSWORD = 'BluexMod#2026';
  const existing = await get('SELECT id FROM users WHERE username = ?', [USERNAME]);
  if (existing) {
    // Já existe — só garante que continua marcada como moderadora (não
    // sobrescreve senha/e-mail, pra não derrubar quem já está usando).
    await run('UPDATE users SET is_moderator = 1 WHERE id = ?', [existing.id]);
    return;
  }
  const id = crypto.randomUUID();
  const passwordHash = bcrypt.hashSync(INITIAL_PASSWORD, 10);
  const discriminator = await generateUniqueDiscriminator(USERNAME);
  await run(
    `INSERT INTO users (id, username, password_hash, is_admin, is_moderator, is_banned, email_verified, avatar, status_message, discriminator, username_tag)
     VALUES (?, ?, ?, 0, 1, 0, 1, ?, ?, ?, ?)`,
    [
      id,
      USERNAME,
      passwordHash,
      'emoji:🛡️:#5865f2',
      'Moderação — Segurança/BLUEX',
      discriminator,
      `${USERNAME}#${discriminator}`,
    ]
  );
}

// Servidor "NEXT GAME" (oficial da plataforma) e "Magic Tank" (jogo
// parceiro oficial) — a pedido, aparecem com selo de verificado (mesmo selo
// azul de conta oficial, ver .verified-badge) e com a logo de verdade (não
// emoji) como ícone. Dono é o bot assistente (AI_BOT_USER_ID), que já é
// verificado por padrão — assim o selo aparece tanto no card do servidor
// quanto em qualquer mensagem que o bot mandar dentro dele.
// Roda sempre no início (idempotente): cria os canais só na primeira vez,
// mas ícone/descrição/selo destes DOIS nomes reservados ficam sempre em
// sincronia com este catálogo (são servidores geridos pela plataforma, não
// customizáveis por usuário comum — diferente de um servidor normal, que
// nunca é tocado aqui). Todo admin entra automaticamente como membro, pra
// aparecer na barra lateral dele sem precisar procurar em Explorar.
async function seedOfficialServers({ run, get, all }) {
  const OFFICIAL_SERVERS = [
    {
      category: 'NEXT GAME',
      icon: '/assets/logo.png',
      description: 'Servidor oficial do NEXT GAME — novidades, avisos, dúvidas e bate-papo com a comunidade.',
    },
    {
      category: 'Magic Tank',
      icon: '/assets/partner-magic-tank.png',
      description: 'Servidor oficial do jogo parceiro Magic Tank — bate-papo, dúvidas e novidades do jogo.',
    },
  ];
  const admins = await all('SELECT id FROM users WHERE is_admin = 1');
  for (const srv of OFFICIAL_SERVERS) {
    const existing = await get('SELECT category FROM servers WHERE category = ?', [srv.category]);
    if (existing) {
      await run('UPDATE servers SET icon = ?, description = ?, is_official = 1, discoverable = 1 WHERE category = ?', [
        srv.icon,
        srv.description,
        srv.category,
      ]);
    } else {
      const inviteCode = crypto.randomBytes(5).toString('hex');
      await run(
        `INSERT INTO servers (category, icon, description, owner_id, invite_code, discoverable, is_official, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 1, ?, datetime('now'))`,
        [srv.category, srv.icon, srv.description, AI_BOT_USER_ID, inviteCode, AI_BOT_USER_ID]
      );
    }
    // Canal de texto #geral e sala de voz oficial — checa se já existe antes
    // de criar (idempotente), pra servir tanto quem tá vendo isso pela
    // primeira vez quanto quem já tinha os servidores de uma versão anterior
    // (que só vinham com o canal de texto).
    const existingText = await get("SELECT id FROM channels WHERE category = ? AND type = 'texto' AND name = 'geral'", [
      srv.category,
    ]);
    if (!existingText) {
      await run('INSERT INTO channels (id, name, category, type, created_by) VALUES (?, ?, ?, ?, ?)', [
        crypto.randomUUID(),
        'geral',
        srv.category,
        'texto',
        AI_BOT_USER_ID,
      ]);
    }
    const existingVoice = await get("SELECT id FROM channels WHERE category = ? AND type = 'voz'", [srv.category]);
    if (!existingVoice) {
      await run(
        "INSERT INTO channels (id, name, category, type, created_by, voice_type) VALUES (?, ?, ?, ?, ?, 'conversa')",
        [crypto.randomUUID(), 'Sala Oficial', srv.category, 'voz', AI_BOT_USER_ID]
      );
    }
    await run('INSERT OR IGNORE INTO server_members (id, category, user_id) VALUES (?, ?, ?)', [
      crypto.randomUUID(),
      srv.category,
      AI_BOT_USER_ID,
    ]);
    for (const admin of admins) {
      await run('INSERT OR IGNORE INTO server_members (id, category, user_id) VALUES (?, ?, ?)', [
        crypto.randomUUID(),
        srv.category,
        admin.id,
      ]);
    }
  }
}

module.exports = { run, get, all, initDb, AI_BOT_USER_ID, AI_BOT_USERNAME, generateUniqueDiscriminator };
