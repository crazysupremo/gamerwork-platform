// ============================================================================
// PLUS-V2 — camada de dados (MÓDULO SEPARADO, ainda não conectado ao site).
//
// Isso é a Fase 1 do novo sistema de personalização visual que vai substituir
// o NEXTGAME PLUS atual (temas de cor simples + figurinhas fixas) por algo bem
// mais completo: temas prontos, criador de tema do zero (cores customizadas) e
// personalização de perfil (moldura/banner/badge).
//
// Por enquanto este arquivo não é importado por nada em produção — é só a
// "base" pedida, pra revisar e testar isolado antes de juntar no site de
// verdade (server.js / db.js / app.js). Quando for integrar, o jeito mais
// simples é: copiar as funções ensurePlusV2Schema()/seedPlusV2Defaults() pra
// dentro de db.js (chamando elas junto com o resto do init()), e apontar as
// rotas de routes-plus2.js pro app principal.
//
// Nomes de coluna/tabela usam o prefixo "plus2_"/"plus_v2_" de propósito, pra
// não colidir com a antiga coluna plus_theme (já removida do users).
// ============================================================================

const crypto = require('crypto');
const { NEXTGAME_OFICIAL_STICKERS } = require('./sticker-assets');

function newId() {
  return crypto.randomUUID();
}

// Cria as tabelas novas e as colunas novas em `users`, sem mexer em nada que
// já existe. Idempotente — pode chamar toda vez que o servidor sobe, igual o
// resto do db.js faz com ensureColumn().
async function ensurePlusV2Schema(db) {
  const { run, ensureColumn } = db;

  // Catálogo de temas — tanto os "prontos" (feitos por nós/admin) quanto os
  // criados por cada usuário no criador de tema personalizado. is_preset
  // distingue um do outro; owner_user_id é null pros temas prontos.
  await run(`
    CREATE TABLE IF NOT EXISTS plus_v2_themes (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE,
      name TEXT NOT NULL,
      primary_color TEXT NOT NULL,
      secondary_color TEXT NOT NULL,
      highlight_color TEXT NOT NULL,
      text_color TEXT NOT NULL,
      button_color TEXT NOT NULL,
      dark_mode INTEGER NOT NULL DEFAULT 1,
      effect TEXT NOT NULL DEFAULT 'none',
      is_premium INTEGER NOT NULL DEFAULT 0,
      is_preset INTEGER NOT NULL DEFAULT 1,
      owner_user_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Catálogo de badges (selo pequeno ao lado do nome, separado da moldura de
  // avatar) — mostrado no chat e no perfil.
  await run(`
    CREATE TABLE IF NOT EXISTS plus_v2_badges (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE,
      name TEXT NOT NULL,
      icon TEXT NOT NULL,
      is_premium INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Estilos de banner de perfil disponíveis (só do card de perfil — não
  // confundir com o fundo do app inteiro, que é a tabela plus_v2_backgrounds
  // abaixo).
  await run(`
    CREATE TABLE IF NOT EXISTS plus_v2_banners (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE,
      name TEXT NOT NULL,
      style TEXT NOT NULL,
      value TEXT NOT NULL,
      is_premium INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Fundo personalizado do app inteiro (Fase 2) — type diferencia como
  // `value` deve ser interpretado no frontend:
  //   'solid'   -> value = cor hex
  //   'gradient'-> value = "corA,corB[,ângulo]"
  //   'image'   -> value = URL de imagem estática
  //   'gif'     -> value = URL de imagem animada
  //   'effect'  -> value = chave de um efeito de fundo embutido no app
  //                (ex: 'particles', 'waves') — não é URL nenhuma.
  await run(`
    CREATE TABLE IF NOT EXISTS plus_v2_backgrounds (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      is_premium INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Pacotes de figurinha (Fase 4) — cada pacote pode ser gratuito ou
  // exclusivo do NEXTGAME PLUS; as figurinhas dentro dele podem ser um
  // emoji (sem nenhum arquivo) ou uma imagem de verdade (PNG do pacote de
  // marca, por exemplo).
  await run(`
    CREATE TABLE IF NOT EXISTS plus_v2_sticker_packs (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE,
      name TEXT NOT NULL,
      is_premium INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS plus_v2_stickers (
      id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (pack_id) REFERENCES plus_v2_sticker_packs(id)
    )
  `);

  // Preferência atual de cada usuário — tudo em colunas novas e prefixadas
  // (plus2_*) pra não colidir com nada antigo.
  await ensureColumn('users', 'plus2_theme_id TEXT');
  await ensureColumn('users', 'plus2_banner_id TEXT');
  await ensureColumn('users', 'plus2_badge_id TEXT');
  await ensureColumn('users', 'plus2_background_id TEXT');
  // Banner de perfil como imagem própria (upload) — quando preenchida, tem
  // prioridade sobre plus2_banner_id (a escolha de um exclui a do outro; a
  // rota PATCH /me cuida disso). Reaproveita o mesmo fluxo de upload que o
  // site principal já usa pra anexos de chat (/api/uploads/presign, direto
  // pro R2) — não duplica nenhuma lógica de storage aqui.
  await ensureColumn('users', 'plus2_custom_banner_url TEXT');
  // Preferências "soltas" que não são catálogo (opacidade/desfoque do fundo,
  // efeitos ligados/desligados, modo desempenho, personalização do chat) —
  // ficam todas num JSON só, pra não precisar de uma coluna nova pra cada
  // checkbox futuro. Ver DEFAULT_VISUAL_PREFS abaixo pro formato.
  await ensureColumn('users', 'plus2_visual_prefs TEXT');
}

// ---------------------------------------------------------------------------
// Catálogo padrão — os 6 temas "prontos" gratuitos + 6 temas premium (só pra
// quem é NEXTGAME PLUS), igual à referência de design, e um punhado de
// badges/banners padrão. Roda uma vez só (INSERT OR IGNORE por key).
// ---------------------------------------------------------------------------
const DEFAULT_THEMES = [
  // ---- Prontos, gratuitos ----
  { key: 'blue', name: 'Blue', primary: '#5865f2', secondary: '#9147ff', highlight: '#00d4ff', text: '#e6e6e6', button: '#1e1e2f', premium: false, effect: 'none' },
  { key: 'midnight', name: 'Midnight', primary: '#3a3d52', secondary: '#5c6082', highlight: '#8f9bff', text: '#e6e6e6', button: '#1a1b26', premium: false, effect: 'none' },
  { key: 'nebula', name: 'Nebula', primary: '#9146ff', secondary: '#c04fff', highlight: '#ff6ec7', text: '#e6e6e6', button: '#241a33', premium: false, effect: 'none' },
  { key: 'crimson', name: 'Crimson', primary: '#e0344c', secondary: '#ff5c72', highlight: '#ff9f43', text: '#e6e6e6', button: '#2b1418', premium: false, effect: 'none' },
  { key: 'cyber-green', name: 'Cyber Green', primary: '#00c896', secondary: '#00e6a8', highlight: '#7dffcb', text: '#e6e6e6', button: '#0f2a22', premium: false, effect: 'none' },
  { key: 'gold', name: 'Gold', primary: '#c9982f', secondary: '#ffd93d', highlight: '#fff2b8', text: '#e6e6e6', button: '#2b2410', premium: false, effect: 'none' },
  // ---- Premium (NEXTGAME PLUS) ----
  { key: 'galaxy', name: 'Galaxy', primary: '#4b3fa0', secondary: '#7c5cff', highlight: '#00e5ff', text: '#f0f0ff', button: '#1a1433', premium: true, effect: 'shine' },
  { key: 'cyberpunk', name: 'Cyberpunk', primary: '#ff2e88', secondary: '#00e5ff', highlight: '#f6ff3d', text: '#f5f5ff', button: '#160a24', premium: true, effect: 'glow' },
  { key: 'aurora', name: 'Aurora', primary: '#12c2a9', secondary: '#7d5fff', highlight: '#c2f9ff', text: '#eafff9', button: '#0d1f2e', premium: true, effect: 'shine' },
  { key: 'inferno', name: 'Inferno', primary: '#ff4b2b', secondary: '#ff9f1c', highlight: '#ffe66d', text: '#fff2e6', button: '#2b0f0a', premium: true, effect: 'pulse' },
  { key: 'neon-dreams', name: 'Neon Dreams', primary: '#ff00e5', secondary: '#00fff0', highlight: '#fefe00', text: '#f7f7ff', button: '#100a1f', premium: true, effect: 'glow' },
  { key: 'winter-night', name: 'Winter Night', primary: '#3b6fa0', secondary: '#8fd6ff', highlight: '#ffffff', text: '#eaf6ff', button: '#0e1b26', premium: true, effect: 'shine' },
];

const DEFAULT_BADGES = [
  { key: 'founder', name: 'Fundador', icon: '👑', premium: false },
  { key: 'plus-member', name: 'Membro Plus', icon: '⭐', premium: true },
  { key: 'diamond', name: 'Diamante', icon: '💎', premium: true },
  { key: 'veteran', name: 'Veterano', icon: '🔥', premium: true },
  { key: 'beta-tester', name: 'Beta Tester', icon: '🎖️', premium: false },
  { key: 'moderator', name: 'Moderador', icon: '🛡️', premium: false },
];

const DEFAULT_BANNERS = [
  { key: 'solid-blue', name: 'Azul sólido', style: 'solid', value: '#5865f2', premium: false },
  { key: 'solid-dark', name: 'Escuro sólido', style: 'solid', value: '#1a1b20', premium: false },
  { key: 'grad-blue-purple', name: 'Azul → Roxo', style: 'gradient', value: '#5865f2,#9146ff', premium: false },
  { key: 'grad-fire', name: 'Fogo', style: 'gradient', value: '#ff4b2b,#ffd93d', premium: true },
  { key: 'grad-aurora', name: 'Aurora', style: 'gradient', value: '#12c2a9,#7d5fff', premium: true },
  { key: 'grad-neon', name: 'Neon', style: 'gradient', value: '#ff00e5,#00fff0', premium: true },
];

// Fundos do app inteiro (Fase 2). As entradas do tipo 'image'/'gif' usam
// gradientes SVG gerados na hora como PLACEHOLDER — na integração de
// verdade, é só trocar `value` pela URL da imagem/GIF real hospedada
// (ex: no S3, igual os outros uploads do site já fazem).
const DEFAULT_BACKGROUNDS = [
  { key: 'bg-solid-dark', name: 'Escuro padrão', type: 'solid', value: '#14151a', premium: false },
  { key: 'bg-solid-midnight', name: 'Meia-noite', type: 'solid', value: '#0e0f13', premium: false },
  { key: 'bg-grad-soft-blue', name: 'Azul suave', type: 'gradient', value: '#1a1b2e,#2a2d4a,135', premium: false },
  { key: 'bg-grad-fire', name: 'Fogo', type: 'gradient', value: '#2b0f0a,#5c1f12,135', premium: true },
  { key: 'bg-grad-aurora', name: 'Aurora', type: 'gradient', value: '#0d1f2e,#123a33,135', premium: true },
  { key: 'bg-image-city', name: 'Skyline (exemplo)', type: 'image', value: 'placeholder:city', premium: true },
  { key: 'bg-image-space', name: 'Espaço (exemplo)', type: 'image', value: 'placeholder:space', premium: true },
  { key: 'bg-gif-glow', name: 'Glow animado (exemplo)', type: 'gif', value: 'placeholder:glow', premium: true },
  { key: 'bg-effect-particles', name: 'Partículas', type: 'effect', value: 'particles', premium: true },
  { key: 'bg-effect-waves', name: 'Ondas', type: 'effect', value: 'waves', premium: true },
];

// Pacotes de figurinha (Fase 4). Pacotes do tipo 'image' apontam pro mesmo
// diretório de assets de marca que o site principal já usa
// (/assets/brand/sticker-*.png) — na integração, é só garantir que esses
// arquivos existem em public/assets/brand (alguns já existiam antes da
// remoção do sistema antigo de figurinhas).
const DEFAULT_STICKER_PACKS = [
  {
    key: 'classics', name: 'Clássicos', premium: false,
    stickers: ['😂', '❤️', '🔥', '👑', '🎮', '🏆', '👍', '🎉', '😭', '😡', '🤝', '💯', '😎', '👀', '🥳', '💀'].map((e) => ({ type: 'emoji', content: e })),
  },
  {
    key: 'gamer-reactions', name: 'Reações Gamer', premium: false,
    stickers: ['🎯', '🕹️', '🏅', '⚔️', '🛡️', '💥', '🚀', '🐉'].map((e) => ({ type: 'emoji', content: e })),
  },
  {
    key: 'memes', name: 'Memes', premium: false,
    stickers: ['💀', '🫠', '😳', '🗿', '🤡', '🥸', '🙃', '😵‍💫'].map((e) => ({ type: 'emoji', content: e })),
  },
  {
    key: 'rage-tilt', name: 'Rage / Tilt', premium: false,
    stickers: ['😤', '🤬', '💢', '😩', '🫡', '🚩'].map((e) => ({ type: 'emoji', content: e })),
  },
  {
    // Pacote oficial de verdade (99 figurinhas desenhadas pra marca NEXTGAME).
    // As imagens ficam embutidas em sticker-assets.js como data URIs, em vez
    // de 99 arquivos PNG separados — o GitHub recusa subir mais de 100
    // arquivos de uma vez pela tela do site, e 99 arquivos de figurinha somados
    // aos outros arquivos que mudam numa atualização normal estourava esse
    // limite. Assim, essa mudança inteira é só ESTE arquivo + sticker-assets.js.
    // Key nova de propósito ('oficial') pra não colidir com o pacote antigo
    // 'brand', que apontava pra arquivos que nunca existiram de verdade —
    // esse antigo pode ser removido no painel de admin (Personalização →
    // Figurinhas → Remover pacote) já que ficou vazio/quebrado.
    key: 'oficial', name: 'NEXTGAME Oficial', premium: false,
    stickers: NEXTGAME_OFICIAL_STICKERS.map((dataUri) => ({ type: 'image', content: dataUri })),
  },
  {
    key: 'plus-gold', name: 'PLUS Dourado', premium: true,
    stickers: ['💎', '🚀', '⚡', '🐐', '🫡', '🎯', '🥇', '💪'].map((e) => ({ type: 'emoji', content: e })),
  },
  {
    key: 'plus-neon', name: 'PLUS Neon', premium: true,
    stickers: ['🌈', '🔮', '🛸', '🦄', '🎆', '🪩', '🧿', '✨'].map((e) => ({ type: 'emoji', content: e })),
  },
];

// Formato padrão de plus2_visual_prefs (JSON) — usado como base quando o
// usuário ainda não personalizou nada (coluna vem NULL do banco).
const DEFAULT_VISUAL_PREFS = {
  background: { opacity: 100, blur: 0 },
  effects: {
    particles: false,
    buttonGlow: true,
    animatedGradients: false,
    messageReceive: true,
    callJoin: true,
    avatarGlow: false,
    transitions: true,
  },
  performanceMode: false,
  chat: {
    bubbleStyle: 'rounded', // 'rounded' | 'square' | 'minimal'
    showAvatars: true,
    colorMode: 'per_user', // 'per_user' | 'theme' | 'mono'
    fontSize: 'medium', // 'small' | 'medium' | 'large'
    spacing: 16,
    showTimestamps: true,
    showReactions: true,
    mentionEffect: 'highlight', // 'none' | 'highlight' | 'shake' | 'glow'
  },
};

async function seedPlusV2Defaults(db) {
  const { run, get } = db;
  for (let i = 0; i < DEFAULT_THEMES.length; i++) {
    const t = DEFAULT_THEMES[i];
    const exists = await get('SELECT id FROM plus_v2_themes WHERE key = ?', [t.key]);
    if (exists) continue;
    await run(
      `INSERT INTO plus_v2_themes
        (id, key, name, primary_color, secondary_color, highlight_color, text_color, button_color, dark_mode, effect, is_premium, is_preset, owner_user_id, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, NULL, ?)`,
      [newId(), t.key, t.name, t.primary, t.secondary, t.highlight, t.text, t.button, t.effect, t.premium ? 1 : 0, i]
    );
  }
  for (let i = 0; i < DEFAULT_BADGES.length; i++) {
    const b = DEFAULT_BADGES[i];
    const exists = await get('SELECT id FROM plus_v2_badges WHERE key = ?', [b.key]);
    if (exists) continue;
    await run(
      'INSERT INTO plus_v2_badges (id, key, name, icon, is_premium, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [newId(), b.key, b.name, b.icon, b.premium ? 1 : 0, i]
    );
  }
  for (let i = 0; i < DEFAULT_BANNERS.length; i++) {
    const bn = DEFAULT_BANNERS[i];
    const exists = await get('SELECT id FROM plus_v2_banners WHERE key = ?', [bn.key]);
    if (exists) continue;
    await run(
      'INSERT INTO plus_v2_banners (id, key, name, style, value, is_premium, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), bn.key, bn.name, bn.style, bn.value, bn.premium ? 1 : 0, i]
    );
  }
  for (let i = 0; i < DEFAULT_BACKGROUNDS.length; i++) {
    const bg = DEFAULT_BACKGROUNDS[i];
    const exists = await get('SELECT id FROM plus_v2_backgrounds WHERE key = ?', [bg.key]);
    if (exists) continue;
    await run(
      'INSERT INTO plus_v2_backgrounds (id, key, name, type, value, is_premium, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), bg.key, bg.name, bg.type, bg.value, bg.premium ? 1 : 0, i]
    );
  }
  for (let i = 0; i < DEFAULT_STICKER_PACKS.length; i++) {
    const pack = DEFAULT_STICKER_PACKS[i];
    let packRow = await get('SELECT id FROM plus_v2_sticker_packs WHERE key = ?', [pack.key]);
    let packId = packRow && packRow.id;
    if (!packId) {
      packId = newId();
      await run(
        'INSERT INTO plus_v2_sticker_packs (id, key, name, is_premium, sort_order) VALUES (?, ?, ?, ?, ?)',
        [packId, pack.key, pack.name, pack.premium ? 1 : 0, i]
      );
    }
    const existingCount = await get('SELECT COUNT(*) AS c FROM plus_v2_stickers WHERE pack_id = ?', [packId]);
    if (existingCount && existingCount.c > 0) continue; // já populado, não duplica
    for (let j = 0; j < pack.stickers.length; j++) {
      const s = pack.stickers[j];
      await run(
        'INSERT INTO plus_v2_stickers (id, pack_id, type, content, sort_order) VALUES (?, ?, ?, ?, ?)',
        [newId(), packId, s.type, s.content, j]
      );
    }
  }
}

// Combina o que está gravado no banco (pode ter só algumas chaves, ou vir
// NULL pra quem nunca mexeu em nada) com o formato padrão, campo por campo —
// assim adicionar uma preferência nova no futuro nunca quebra quem já tinha
// JSON salvo de antes.
function mergeVisualPrefs(storedJson) {
  let stored = {};
  if (storedJson) {
    try { stored = JSON.parse(storedJson); } catch (_) { stored = {}; }
  }
  return {
    background: { ...DEFAULT_VISUAL_PREFS.background, ...(stored.background || {}) },
    effects: { ...DEFAULT_VISUAL_PREFS.effects, ...(stored.effects || {}) },
    performanceMode: typeof stored.performanceMode === 'boolean' ? stored.performanceMode : DEFAULT_VISUAL_PREFS.performanceMode,
    chat: { ...DEFAULT_VISUAL_PREFS.chat, ...(stored.chat || {}) },
  };
}

module.exports = {
  ensurePlusV2Schema,
  seedPlusV2Defaults,
  mergeVisualPrefs,
  newId,
  DEFAULT_THEMES,
  DEFAULT_BADGES,
  DEFAULT_BANNERS,
  DEFAULT_BACKGROUNDS,
  DEFAULT_VISUAL_PREFS,
  DEFAULT_STICKER_PACKS,
};
