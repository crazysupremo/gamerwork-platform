// ---------- BANCO DE DADOS (mesmo padrão do NEXT GAME: libsql, funciona com
// SQLite local em dev e Turso em produção sem trocar nada de código) ----------
const { createClient } = require('@libsql/client');

const client = createClient(
  process.env.TURSO_DATABASE_URL
    ? { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: 'file:data.sqlite' }
);

async function run(sql, args = []) {
  return client.execute({ sql, args });
}

async function get(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows[0] || null;
}

async function all(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows;
}

async function ensureColumn(table, columnDef) {
  const columnName = columnDef.trim().split(/\s+/)[0];
  const info = await client.execute(`PRAGMA table_info(${table})`);
  const exists = info.rows.some((r) => r.name === columnName);
  if (!exists) {
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  }
}

async function initDb() {
  if (!process.env.TURSO_DATABASE_URL) {
    console.warn(
      '[aviso] TURSO_DATABASE_URL não configurada — usando arquivo SQLite local. Em produção, isso significa que os dados podem ser apagados a cada redeploy.'
    );
  }

  // Empresas clientes que contratam a API — cada uma tem sua própria chave.
  await run(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      contact_email TEXT,
      api_key TEXT UNIQUE NOT NULL,
      plan TEXT NOT NULL DEFAULT 'trial',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Toda chamada de API fica registrada — pra cobrança por uso, auditoria e
  // pro cliente conseguir ver o próprio histórico se algum dia isso virar um
  // painel de cliente (hoje só o painel de admin lê essa tabela).
  await run(`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      flagged INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Só os casos SINALIZADOS (flagged=true) — fila de revisão. Nunca guarda a
  // imagem em si, só o resultado/motivo, mesma política do NEXT GAME.
  await run(`
    CREATE TABLE IF NOT EXISTS flagged_cases (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      categories TEXT,
      reason TEXT,
      confidence TEXT,
      reviewed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await ensureColumn('clients', 'contact_email TEXT');
  // Adicionada quando o modo "bem rigoroso" passou a sinalizar também
  // indícios ambíguos (confidence "baixa") em vez de só os óbvios — dá pra
  // priorizar a fila de revisão pelos casos de confidence "alta" primeiro.
  await ensureColumn('flagged_cases', 'confidence TEXT');

  console.log('[PROTECTION BLUEX] banco de dados pronto.');
}

module.exports = { run, get, all, initDb, ensureColumn };
