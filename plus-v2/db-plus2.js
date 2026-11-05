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

  // Data/hora exata de lançamento de um tema especial (ex.: "Natal" só fica
  // disponível a partir de 25/12/2026 00:00) — controlável pelo admin, em vez
  // de datas escondidas no código-fonte (era assim que o Halloween funcionava
  // antes). NULL = tema sempre disponível, sem data de lançamento. Formato
  // ISO completo (ex.: "2026-12-25T00:00:00"), comparado em UTC no servidor.
  await ensureColumn('plus_v2_themes', 'release_at TEXT');

  // Efeitos visuais (os mesmos da aba "Efeitos" — particles, buttonGlow etc)
  // que esse tema recomenda ligar sozinho quando a pessoa escolhe ele —
  // pedido explícito: "deixar os temas mais interativos", em vez do tema só
  // mudar cor e a pessoa ter que ir na outra aba ligar os efeitos na mão.
  // Guardado como JSON (array de chaves, ex: '["particles","buttonGlow"]').
  // NULL/vazio = tema não sugere nenhum efeito extra (comportamento de
  // antes, continua funcionando igual pros temas que não configurarem isso).
  await ensureColumn('plus_v2_themes', 'suggested_effects TEXT');

  // v0.84.0 — repaginada dos temas: categoria da galeria, frase curta, fonte
  // e fundo animado ("scene") de cada tema. Todos opcionais (NULL = padrão),
  // então temas antigos/personalizados continuam funcionando sem mudança.
  await ensureColumn('plus_v2_themes', 'category TEXT');
  await ensureColumn('plus_v2_themes', 'tagline TEXT');
  await ensureColumn('plus_v2_themes', 'font_key TEXT');
  await ensureColumn('plus_v2_themes', 'scene TEXT');
  // v0.85.0 — decoração temática de datas comemorativas (natal, ano-novo...).
  await ensureColumn('plus_v2_themes', 'decor_key TEXT');
  // v0.88.0 — Estúdio de Temas: rascunho x publicado. 1 = publicado (aparece
  // na galeria e na API pública), 0 = rascunho (só o admin vê no Estúdio).
  await ensureColumn('plus_v2_themes', 'published INTEGER DEFAULT 1');
  // v0.89.0 — efeitos personalizados (JSON: emojis/imagens, queda, moldura, bichinhos, mascote).
  await ensureColumn('plus_v2_themes', 'fx_json TEXT');
}

// ---------------------------------------------------------------------------
// Catálogo padrão — os 6 temas "prontos" gratuitos + 6 temas premium (só pra
// quem é NEXTGAME PLUS), igual à referência de design, e um punhado de
// badges/banners padrão. Roda uma vez só (INSERT OR IGNORE por key).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// v0.84.0 — CATÁLOGO REPAGINADO (estilo neon/glass). Pedido: "repaginar os
// temas, atualização grande, temas incríveis, não quero tema feio".
//
// Cada tema agora é um "pacote" completo, não só 5 cores:
//   - category: aba da galeria (essenciais, gamer, espaco, luxo, natureza,
//               sazonal, parceiros)
//   - tagline:  frase curta mostrada no card
//   - font:     família de fonte do tema (modern/tech/retro/elegant/soft ou
//               '' = fonte padrão do site) — ver FONT_PACKS em plus2-live.js
//   - scene:    fundo animado do tema (aurora/grid/waves = CSS puro;
//               stars/embers/matrix/petals/snow = canvas leve; 'none' = sem)
//   - suggestedEffects: efeitos da aba "Efeitos" que ligam sozinhos
//
// As cores foram escolhidas à mão (não sorteadas): fundo escuro profundo
// tingido pela cor primária (ver deriveSurfaces) + um acento saturado + um
// destaque de contraste, que é a receita do visual neon/glass.
// ---------------------------------------------------------------------------

// v0.90.1 — figurinhas dos temas de data prontos (emojis). mkFx monta o JSON de
// efeitos (itens, chuva, moldura, bichinhos, mascote, tsParticles).
const seg = (s) => (typeof Intl !== 'undefined' && Intl.Segmenter ? Array.from(new Intl.Segmenter('pt', { granularity: 'grapheme' }).segment(s), (x) => x.segment) : Array.from(s)).filter((c) => c.trim());
function mkFx(o) {
  const items = seg(o.items).map((v) => ({ t: 'emoji', v }));
  const idx = (s) => seg(s || '').map((e) => items.findIndex((x) => x.v === e)).filter((i) => i >= 0);
  const fx = { items, chat: { burst: true } };
  if (o.fall) fx.fall = { on: true, mode: o.fall[0], count: o.fall[1], size: o.fall[2], speed: 1 };
  if (o.garland) fx.garland = { on: true, size: o.garland };
  if (o.frame) fx.frame = { type: o.frame, color: '', power: 1 };
  if (o.crit) fx.critters = { on: true, mode: o.crit[0], count: o.crit[1], size: 44, items: idx(o.crit[2]) };
  if (o.mascot) fx.mascot = { on: true, item: Math.max(0, items.findIndex((x) => x.v === o.mascot[0])), name: o.mascot[1], lines: o.mascot[2].split('|') };
  if (o.tsp) fx.tsp = { preset: o.tsp, color: '' };
  if (o.chatStyle) fx.chatStyle = o.chatStyle;
  return fx;
}
const DEFAULT_THEMES = [
  // ===== ESSENCIAIS (gratuitos) =====
  { key: 'blue', name: 'Next Blue', tagline: 'A cara do NEXT GAME', category: 'essenciais', primary: '#5b6cff', secondary: '#8b5cf6', highlight: '#22d3ee', text: '#eef0ff', button: '#12142b', premium: false, effect: 'glow', scene: 'aurora', font: 'modern', suggestedEffects: ['buttonGlow', 'transitions'] },
  { key: 'obsidian', name: 'Obsidian', tagline: 'Preto vidro, zero distração', category: 'essenciais', primary: '#94a3b8', secondary: '#475569', highlight: '#7dd3fc', text: '#f1f5f9', button: '#0b0f16', premium: false, effect: 'shine', scene: 'none', font: 'modern', suggestedEffects: ['transitions'] },
  { key: 'ocean', name: 'Ocean Deep', tagline: 'Mergulho azul-turquesa', category: 'essenciais', primary: '#0ea5e9', secondary: '#2563eb', highlight: '#67e8f9', text: '#e8f8ff', button: '#06182b', premium: false, effect: 'shine', scene: 'waves', font: 'modern', suggestedEffects: ['buttonGlow', 'transitions'] },

  // ===== GAMER =====
  { key: 'cyber-green', name: 'Matrix', tagline: 'Chuva de código verde', category: 'gamer', primary: '#00e08a', secondary: '#047857', highlight: '#b6ffd9', text: '#e8fff4', button: '#04170f', premium: false, effect: 'glow', scene: 'matrix', font: 'tech', suggestedEffects: ['buttonGlow'] },
  { key: 'crimson', name: 'Crimson', tagline: 'Brasa vermelha no escuro', category: 'gamer', primary: '#ef233c', secondary: '#7f1d1d', highlight: '#ff6b81', text: '#fff1f2', button: '#14070a', premium: false, effect: 'pulse', scene: 'embers', font: 'tech', suggestedEffects: ['buttonGlow', 'messageReceive'] },
  { key: 'gamex', name: 'GAMEX', tagline: 'Verde elétrico + violeta', category: 'gamer', primary: '#39ff6a', secondary: '#7c3aed', highlight: '#ffe14d', text: '#eafff0', button: '#08180f', premium: true, effect: 'glow', scene: 'grid', font: 'tech', suggestedEffects: ['particles', 'buttonGlow', 'avatarGlow'] },
  { key: 'cyberpunk', name: 'Cyberpunk', tagline: 'Rosa neon, ciano e amarelo', category: 'gamer', primary: '#ff2a8a', secondary: '#00e5ff', highlight: '#fcee0a', text: '#fbf4ff', button: '#12081f', premium: true, effect: 'glow', scene: 'grid', font: 'tech', suggestedEffects: ['animatedGradients', 'buttonGlow', 'avatarGlow'] },
  { key: 'vaporwave', name: 'Vaporwave', tagline: 'Pôr do sol retrô anos 80', category: 'gamer', primary: '#ff71ce', secondary: '#b967ff', highlight: '#01cdfe', text: '#fff0fc', button: '#190a2e', premium: true, effect: 'glow', scene: 'grid', font: 'retro', suggestedEffects: ['animatedGradients', 'buttonGlow'] },
  { key: 'inferno', name: 'Inferno', tagline: 'Fogo vivo subindo da tela', category: 'gamer', primary: '#ff5a1f', secondary: '#b91c1c', highlight: '#ffd166', text: '#fff4ea', button: '#1c0a05', premium: true, effect: 'pulse', scene: 'embers', font: 'tech', suggestedEffects: ['particles', 'buttonGlow'] },

  // ===== ESPAÇO =====
  { key: 'galaxy', name: 'Galaxy', tagline: 'Estrelas e nebulosa roxa', category: 'espaco', primary: '#6d5dfc', secondary: '#a855f7', highlight: '#38bdf8', text: '#f1f0ff', button: '#110d2b', premium: true, effect: 'shine', scene: 'stars', font: 'modern', suggestedEffects: ['buttonGlow', 'transitions'] },
  { key: 'eclipse', name: 'Eclipse', tagline: 'Quase preto, brilho violeta', category: 'espaco', primary: '#7c3aed', secondary: '#312e81', highlight: '#c4b5fd', text: '#ede9fe', button: '#07040f', premium: true, effect: 'glow', scene: 'stars', font: 'modern', suggestedEffects: ['avatarGlow', 'transitions'] },
  { key: 'nebula', name: 'Nebula', tagline: 'Lilás cósmico suave', category: 'espaco', primary: '#a855f7', secondary: '#6366f1', highlight: '#f0abfc', text: '#f8f0ff', button: '#160e29', premium: false, effect: 'shine', scene: 'stars', font: 'modern', suggestedEffects: ['buttonGlow'] },

  // ===== LUXO (premium) =====
  { key: 'royal', name: 'Royal', tagline: 'Roxo imperial e ouro', category: 'luxo', primary: '#7c3aed', secondary: '#d4af37', highlight: '#ffe08a', text: '#faf3e0', button: '#0f0818', premium: true, effect: 'shine', scene: 'stars', font: 'elegant', suggestedEffects: ['buttonGlow', 'avatarGlow'] },
  { key: 'diamond', name: 'Diamond', tagline: 'Cristal gelado e cintilante', category: 'luxo', primary: '#7dd3fc', secondary: '#c7d2fe', highlight: '#ffffff', text: '#f0f9ff', button: '#0a1c28', premium: true, effect: 'shine', scene: 'snow', font: 'elegant', suggestedEffects: ['buttonGlow', 'transitions'] },
  { key: 'emerald-elite', name: 'Emerald Elite', tagline: 'Esmeralda com detalhes dourados', category: 'luxo', primary: '#10b981', secondary: '#065f46', highlight: '#e6c35c', text: '#ecfff7', button: '#06201a', premium: true, effect: 'shine', scene: 'aurora', font: 'elegant', suggestedEffects: ['buttonGlow', 'avatarGlow'] },
  { key: 'platinum-pro', name: 'Platinum Pro', tagline: 'Aço escovado, estilo executivo', category: 'luxo', primary: '#8fa3b8', secondary: '#cbd5e1', highlight: '#5ec8ff', text: '#f4f7fa', button: '#141b22', premium: true, effect: 'shine', scene: 'grid', font: 'modern', suggestedEffects: ['buttonGlow', 'transitions'] },

  // ===== NATUREZA =====
  { key: 'aurora', name: 'Aurora', tagline: 'Luzes do norte em movimento', category: 'natureza', primary: '#10d9a8', secondary: '#7c5cff', highlight: '#b8f5ff', text: '#eafff9', button: '#08181f', premium: true, effect: 'shine', scene: 'aurora', font: 'modern', suggestedEffects: ['animatedGradients', 'buttonGlow'] },
  { key: 'sunset', name: 'Sunset', tagline: 'Entardecer laranja e magenta', category: 'natureza', primary: '#ff7a59', secondary: '#c026d3', highlight: '#ffd166', text: '#fff3ee', button: '#240f26', premium: true, effect: 'shine', scene: 'waves', font: 'soft', suggestedEffects: ['animatedGradients', 'buttonGlow'] },
  { key: 'sakura', name: 'Sakura', tagline: 'Pétalas caindo em rosa', category: 'natureza', primary: '#ff8fb8', secondary: '#c084fc', highlight: '#ffe4ef', text: '#fff4f8', button: '#241020', premium: true, effect: 'glow', scene: 'petals', font: 'soft', suggestedEffects: ['buttonGlow', 'messageReceive'] },

  // ===== SAZONAIS =====
  { key: 'halloween', name: 'Halloween', tagline: 'Laranja-abóbora na escuridão', category: 'datas', primary: '#ff7a1a', secondary: '#0d0d0d', highlight: '#ff2e2e', text: '#f6efdc', button: '#07050c', premium: false, effect: 'glow', scene: 'embers', font: '', releaseAt: '2027-10-15T03:00:00.000Z', suggestedEffects: ['particles', 'buttonGlow'], fx: mkFx({ items: '🎃👻🦇🕷️', fall: ['fall', 20, 28], frame: 'fire', crit: ['fight', 4, '👻🎃'], mascot: ['🎃', 'Abóbora', 'Buuu, {nome}!|Cuidado com o fogo!|Doce ou travessura?'], chatStyle: { bubble: 'neon', entry: 'glow', radius: 10 } }) },
  { key: 'winter-night', name: 'Winter Night', tagline: 'Noite de neve azulada', category: 'sazonal', primary: '#4f8fd6', secondary: '#1e3a5f', highlight: '#e0f2ff', text: '#eef7ff', button: '#0a1622', premium: true, effect: 'shine', scene: 'snow', font: 'modern', suggestedEffects: ['buttonGlow', 'transitions'] },

  // ===== DATAS COMEMORATIVAS (v0.85.0) =====
  // Cada um traz "decor": enfeites temáticos pelo site inteiro (luzes, bicho/
  // objeto que atravessa a tela, acessório na logo, cantinho decorado, faixa
  // na sidebar) além do fundo animado. Liberação automática por data
  // (releaseAt) — o admin pode mudar a data a qualquer momento no painel;
  // até lá, o tema aparece com cadeado "disponível em..." e dá pra ver
  // ao vivo mesmo assim.
  { key: 'natal', name: 'Natal', tagline: 'Neve, luzes piscando e Papai Noel', category: 'datas', primary: '#d62839', secondary: '#1f8a4c', highlight: '#ffd54a', text: '#fff7f0', button: '#1a0a0d', premium: false, effect: 'glow', scene: 'snow', font: 'soft', decor: 'natal', releaseAt: '2026-12-01T03:00:00.000Z', suggestedEffects: ['buttonGlow', 'avatarGlow', 'messageReceive', 'callJoin'] },
  { key: 'ano-novo', name: 'Ano Novo', tagline: 'Fogos de artifício e dourado', category: 'datas', primary: '#ffc83d', secondary: '#1b2a6b', highlight: '#ffffff', text: '#fff8e1', button: '#0a0d1f', premium: false, effect: 'shine', scene: 'fireworks', font: 'elegant', decor: 'ano-novo', releaseAt: '2026-12-26T03:00:00.000Z', suggestedEffects: ['buttonGlow', 'avatarGlow'] },
  { key: 'carnaval', name: 'Carnaval', tagline: 'Confete, serpentina e muita cor', category: 'datas', primary: '#ff2e93', secondary: '#00b85c', highlight: '#ffd600', text: '#fff4fb', button: '#1c0716', premium: false, effect: 'pulse', scene: 'confetti', font: 'soft', decor: 'carnaval', releaseAt: '2027-02-01T03:00:00.000Z', suggestedEffects: ['buttonGlow', 'messageReceive', 'callJoin'] },
  { key: 'pascoa', name: 'Páscoa', tagline: 'Ovinhos, coelhos e tons pastel', category: 'datas', primary: '#b388ff', secondary: '#ff9ec7', highlight: '#fff3a0', text: '#fbf6ff', button: '#1a1226', premium: false, effect: 'glow', scene: 'easter', font: 'soft', decor: 'pascoa', releaseAt: '2027-03-15T03:00:00.000Z', suggestedEffects: ['buttonGlow', 'messageReceive'] },
  { key: 'namorados', name: 'Dia dos Namorados', tagline: 'Corações flutuando em rosa', category: 'datas', primary: '#ff4d79', secondary: '#b0124a', highlight: '#ffc2d4', text: '#fff1f5', button: '#1f0711', premium: false, effect: 'glow', scene: 'hearts', font: 'soft', decor: 'namorados', releaseAt: '2027-06-01T03:00:00.000Z', suggestedEffects: ['buttonGlow', 'avatarGlow', 'messageReceive'] },
  { key: 'criancas', name: 'Dia das Crianças', tagline: 'Balões e cores alegres', category: 'datas', primary: '#22b8f0', secondary: '#ff7043', highlight: '#ffee58', text: '#f2fbff', button: '#08202e', premium: false, effect: 'pulse', scene: 'balloons', font: 'soft', decor: 'criancas', releaseAt: '2027-10-01T03:00:00.000Z', suggestedEffects: ['buttonGlow', 'messageReceive', 'callJoin'] },

  // ===== DATAS EXTRAS (v0.90.1) =====
  { key: 'dia-das-maes', name: 'Dia das Mães', tagline: 'Flores, borboletas e carinho', category: 'datas', primary: '#ff6fa5', secondary: '#c77dff', highlight: '#ffd6a5', text: '#fff0f6', button: '#2a0d1c', premium: false, effect: 'glow', scene: 'petals', font: 'elegant', releaseAt: '2027-04-25T03:00:00.000Z', suggestedEffects: ['buttonGlow', 'avatarGlow'], fx: mkFx({ items: '🌸💐❤️🌷🦋', fall: ['rise', 18, 30], garland: 28, frame: 'sparkle', mascot: ['💐', 'Florzinha', 'Feliz Dia das Mães!|Ligou pra sua mãe, {nome}?|Com muito carinho!'], chatStyle: { bubble: 'round', entry: 'pop', radius: 22 } }) },
  { key: 'dia-dos-pais', name: 'Dia dos Pais', tagline: 'Azul, troféus e churrasco', category: 'datas', primary: '#3b82f6', secondary: '#0ea5e9', highlight: '#fbbf24', text: '#eff6ff', button: '#08142b', premium: false, effect: 'shine', scene: 'aurora', font: 'modern', releaseAt: '2027-07-25T03:00:00.000Z', suggestedEffects: ['buttonGlow'], fx: mkFx({ items: '🏆👔⚽🎣🍖', fall: ['float', 14, 30], frame: 'neon', tsp: 'links', mascot: ['🏆', 'Super Pai', 'Feliz Dia dos Pais!|Hoje o campeão é você!|Bora jogar, {nome}?'], chatStyle: { bubble: 'solid', entry: 'slide', radius: 10 } }) },
  { key: 'festa-junina', name: 'Festa Junina', tagline: 'Fogueira, bandeirinhas e quadrilha', category: 'datas', primary: '#ffb300', secondary: '#e53935', highlight: '#7cb342', text: '#fff8e1', button: '#2a1405', premium: false, effect: 'glow', scene: 'confetti', font: 'soft', releaseAt: '2027-06-13T03:00:00.000Z', suggestedEffects: ['buttonGlow', 'messageReceive'], fx: mkFx({ items: '🌽🎈🔥🪅🎆', fall: ['float', 20, 30], garland: 30, frame: 'sparkle', tsp: 'fire', mascot: ['🌽', 'Caipira', 'Arraiá do {nome}!|Bora dançar quadrilha!|Pé de moleque!'], chatStyle: { bubble: 'solid', entry: 'pop', radius: 16 } }) },
  { key: 'black-friday', name: 'Black Friday', tagline: 'Preto, amarelo e ofertas relâmpago', category: 'datas', primary: '#ffd600', secondary: '#ff1744', highlight: '#00e5ff', text: '#fffde7', button: '#0d0d0d', premium: false, effect: 'pulse', scene: 'grid', font: 'tech', releaseAt: '2026-11-20T03:00:00.000Z', suggestedEffects: ['buttonGlow', 'animatedGradients'], fx: mkFx({ items: '💸🛒🔥⚡🏷️', fall: ['fall', 24, 26], frame: 'neon', mascot: ['🛒', 'Ofertinha', 'Tudo 80% off!|Corre, {nome}!|Só hoje!'], chatStyle: { bubble: 'neon', entry: 'glow', radius: 6 } }) },
  { key: 'dia-do-gamer', name: 'Dia do Gamer', tagline: 'Pixels, neon e fases secretas', category: 'datas', primary: '#a855f7', secondary: '#22d3ee', highlight: '#f472b6', text: '#f5f3ff', button: '#12071f', premium: false, effect: 'glow', scene: 'matrix', font: 'tech', releaseAt: '2027-09-15T03:00:00.000Z', suggestedEffects: ['buttonGlow', 'avatarGlow', 'callJoin'], fx: mkFx({ items: '🎮🕹️👾🤖🏆⚡', fall: ['fall', 20, 28], frame: 'neon', crit: ['fight', 4, '👾🤖'], tsp: 'stars', mascot: ['👾', 'Pixel', 'Player {nome} entrou!|Bora de ranked?|Fase secreta liberada!'], chatStyle: { bubble: 'neon', entry: 'pop', radius: 8 } }) },
  { key: 'sete-de-setembro', name: 'Sete de Setembro', tagline: 'Verde, amarelo e muito orgulho', category: 'datas', primary: '#16a34a', secondary: '#facc15', highlight: '#2563eb', text: '#f0fdf4', button: '#04180b', premium: false, effect: 'shine', scene: 'confetti', font: 'modern', releaseAt: '2027-08-30T03:00:00.000Z', suggestedEffects: ['buttonGlow'], fx: mkFx({ items: '🇧🇷⚽🥁🌴🎉', fall: ['fall', 18, 28], frame: 'glow', mascot: ['🇧🇷', 'Brasil', 'Vai, Brasil!|Feliz Independência!|Orgulho de jogar com você, {nome}!'] }) },
  { key: 'dia-do-amigo', name: 'Dia do Amigo', tagline: 'Quem joga junto, fica junto', category: 'datas', primary: '#fb7185', secondary: '#60a5fa', highlight: '#fcd34d', text: '#fff1f2', button: '#1f0a14', premium: false, effect: 'glow', scene: 'hearts', font: 'soft', releaseAt: '2027-07-10T03:00:00.000Z', suggestedEffects: ['buttonGlow', 'avatarGlow', 'messageReceive'], fx: mkFx({ items: '🤝💛🎮🎁🫶', fall: ['rise', 16, 30], garland: 28, frame: 'sparkle', mascot: ['🤝', 'Parça', 'Feliz Dia do Amigo, {nome}!|Chama a galera!|Amigo bom joga junto.'], chatStyle: { bubble: 'round', entry: 'pop', radius: 22 } }) },

  // ===== PARCEIROS =====
  { key: 'magic-tank', name: 'Magic Tank', tagline: 'Azul neon + dourado (parceiro)', category: 'parceiros', primary: '#00a8ff', secondary: '#fbdc70', highlight: '#7fd9ff', text: '#e2e8f0', button: '#050810', premium: true, effect: 'glow', scene: 'none', font: '', suggestedEffects: ['buttonGlow'] },
  { key: 'ddtank', name: 'DDTank', tagline: 'Fofo e vibrante (parceiro)', category: 'parceiros', primary: '#ff5fa0', secondary: '#5fd4ff', highlight: '#ffd34d', text: '#fff2f8', button: '#210c1c', premium: true, effect: 'shine', scene: 'none', font: '', suggestedEffects: ['buttonGlow'] },
];

// Temas antigos aposentados nessa repaginada (visual repetido/sem graça).
// Quem estava usando um deles é migrado pro "Next Blue" na hora do seed —
// nada fica quebrado nem sem tema. Ver seedPlusV2Defaults().
const RETIRED_THEME_KEYS = ['midnight', 'gold', 'neon-dreams', 'phantom-red'];

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
    const extra = [t.category || null, t.tagline || null, t.font || null, t.scene || 'none', t.decor || null];
    if (exists) {
      // Tema já existia (site em produção já rodou o seed antes) — atualiza
      // o visual inteiro sem duplicar linha nem mexer no id (preserva a
      // escolha de quem já tinha esse tema selecionado).
      await run(
        `UPDATE plus_v2_themes
           SET name = ?, primary_color = ?, secondary_color = ?, highlight_color = ?,
               text_color = ?, button_color = ?, effect = ?, is_premium = ?, sort_order = ?,
               suggested_effects = ?, category = ?, tagline = ?, font_key = ?, scene = ?, decor_key = ?,
               fx_json = COALESCE(fx_json, ?), release_at = COALESCE(release_at, ?)
         WHERE key = ?`,
        [t.name, t.primary, t.secondary, t.highlight, t.text, t.button, t.effect, t.premium ? 1 : 0, i, JSON.stringify(t.suggestedEffects || []), ...extra, t.fx ? JSON.stringify(t.fx) : null, t.releaseAt || null, t.key]
      );
      continue;
    }
    await run(
      `INSERT INTO plus_v2_themes
        (id, key, name, primary_color, secondary_color, highlight_color, text_color, button_color, dark_mode, effect, is_premium, is_preset, owner_user_id, sort_order, suggested_effects, category, tagline, font_key, scene, decor_key, release_at, fx_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), t.key, t.name, t.primary, t.secondary, t.highlight, t.text, t.button, t.effect, t.premium ? 1 : 0, i, JSON.stringify(t.suggestedEffects || []), ...extra, t.releaseAt || null, t.fx ? JSON.stringify(t.fx) : null]
    );
  }
  // v0.90.8: o Matrix ficou só com a chuva de código (sem moldura/balões neon).
  await run(`UPDATE plus_v2_themes SET fx_json = NULL WHERE key = 'cyber-green' AND is_preset = 1 AND fx_json LIKE '%"neon"%'`);
  // Aposenta os temas antigos: move quem usava pro Next Blue e apaga a linha.
  const fallback = await get('SELECT id FROM plus_v2_themes WHERE key = ?', ['blue']);
  for (const oldKey of RETIRED_THEME_KEYS) {
    const old = await get('SELECT id FROM plus_v2_themes WHERE key = ? AND is_preset = 1', [oldKey]);
    if (!old) continue;
    if (fallback) await run('UPDATE users SET plus2_theme_id = ? WHERE plus2_theme_id = ?', [fallback.id, old.id]);
    await run('DELETE FROM plus_v2_themes WHERE id = ?', [old.id]);
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
  RETIRED_THEME_KEYS,
  DEFAULT_BADGES,
  DEFAULT_BANNERS,
  DEFAULT_BACKGROUNDS,
  DEFAULT_VISUAL_PREFS,
  DEFAULT_STICKER_PACKS,
};
