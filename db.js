// db.js - configuração do SQLite (usa o módulo nativo node:sqlite do Node 22+,
// sem necessidade de compilação de dependências nativas)
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Permite sobrescrever o caminho do banco via variável de ambiente. Útil se a
// pasta do projeto estiver em uma unidade sincronizada na nuvem (OneDrive,
// Dropbox, iCloud) — bancos SQLite podem falhar (erro de I/O) nesse tipo de
// pasta porque o locking de arquivo não funciona como num disco local.
// Nesse caso, rode com: DB_PATH=/caminho/local/data.sqlite npm start
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
const db = new DatabaseSync(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL, -- nome do "servidor"/comunidade (livre, criado por usuários)
  type TEXT NOT NULL DEFAULT 'texto', -- 'texto' | 'voz'
  created_by TEXT, -- id do usuário que criou a sala (nulo para as salas padrão)
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
  status TEXT NOT NULL DEFAULT 'pendente', -- 'pendente' | 'resolvido' | 'descartado'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Seed canais padrão (gamers + trabalho) se ainda não existirem.
const seedChannels = [
  { id: 'gamers-geral', name: 'geral', category: 'gamers', type: 'texto' },
  { id: 'gamers-lfg', name: 'procurando-grupo', category: 'gamers', type: 'texto' },
  { id: 'gamers-voz-1', name: 'Sala de Voz 1', category: 'gamers', type: 'voz' },
  { id: 'trabalho-geral', name: 'geral', category: 'trabalho', type: 'texto' },
  { id: 'trabalho-anuncios', name: 'anuncios', category: 'trabalho', type: 'texto' },
  { id: 'trabalho-reuniao', name: 'Sala de Reunião', category: 'trabalho', type: 'voz' },
];

const insertChannel = db.prepare(
  'INSERT OR IGNORE INTO channels (id, name, category, type) VALUES (@id, @name, @category, @type)'
);
seedChannels.forEach((r) => insertChannel.run(r));

// node:sqlite's StatementSync já expõe .run/.get/.all de forma compatível
// com o subconjunto de better-sqlite3 usado neste projeto, então o restante
// do código (server.js) usa db.prepare(...).run/get/all normalmente.
module.exports = db;
