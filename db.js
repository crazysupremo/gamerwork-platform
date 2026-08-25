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

// ID fixo do usuário-bot assistente de IA — usado pelo server.js pra saber
// quando uma DM é uma conversa com a IA (em vez de com outra pessoa).
const AI_BOT_USER_ID = 'ai-assistant-bot';
const AI_BOT_USERNAME = 'NEXT GAME IA';

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
    await run(
      `INSERT INTO users (id, username, password_hash, is_admin, is_banned, email_verified, avatar, status_message)
       VALUES (?, ?, ?, 0, 0, 1, ?, ?)`,
      [AI_BOT_USER_ID, AI_BOT_USERNAME, unusablePassword, 'emoji:🤖:#00d9c0', 'Sempre pronto pra ajudar']
    );
  }
}

module.exports = { run, get, all, initDb, AI_BOT_USER_ID, AI_BOT_USERNAME };
