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
const { createClient } = require('@libsql/client');

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
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migração leve pra bancos criados antes de alguma dessas colunas existir.
  await ensureColumn('users', 'email TEXT');
  await ensureColumn('users', 'email_verified INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'verification_code TEXT');
  await ensureColumn('users', 'verification_expires TEXT');
  await ensureColumn('users', 'status_message TEXT');
  await ensureColumn('users', 'avatar TEXT');
  await ensureColumn('channels', 'created_by TEXT');
  await ensureColumn('messages', 'edited INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('messages', 'deleted INTEGER NOT NULL DEFAULT 0');

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
}

module.exports = { run, get, all, initDb };
