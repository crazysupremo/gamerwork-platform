// ============================================================================
// PLUS-V2 — rotas da API (MÓDULO SEPARADO, ainda não conectado ao site).
//
// Fábrica de router: recebe as mesmas peças que o server.js principal já tem
// (instância do db, requireAuth, requireAdmin, asyncHandler, isPlusAccount) e
// devolve um express.Router() prontinho. Na hora de integrar de verdade, o
// jeito mais simples é, lá no server.js:
//
//   const buildPlusV2Router = require('./plus-v2/routes-plus2');
//   app.use('/api/plus2', buildPlusV2Router({ db, requireAuth, requireAdmin, asyncHandler, isPlusAccount }));
//
// Por enquanto isso não é chamado de lugar nenhum em produção.
// ============================================================================

const express = require('express');
const { newId, mergeVisualPrefs } = require('./db-plus2');

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const EFFECTS = new Set(['none', 'shine', 'glow', 'pulse']);
// Efeitos "de verdade" (os da aba Efeitos — particles, buttonGlow etc, ver
// DEFAULT_VISUAL_PREFS em db-plus2.js), diferentes do EFFECTS acima (que é só
// a animação do CARD do tema na galeria). Usado pra validar o campo
// suggestedEffects de cada tema — os efeitos que ligam sozinhos quando a
// pessoa escolhe esse tema (pedido: "temas mais interativos").
const SITE_EFFECTS = new Set(['particles', 'buttonGlow', 'animatedGradients', 'messageReceive', 'callJoin', 'avatarGlow', 'transitions']);

// Faz parse seguro do JSON gravado em suggested_effects, descartando
// qualquer chave que não seja um efeito válido (proteção contra dado velho/
// corrompido no banco nunca quebrar a resposta da API).
function parseSuggestedEffects(json) {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((e) => SITE_EFFECTS.has(e)) : [];
  } catch (_) {
    return [];
  }
}
// v0.84.0 — catálogo repaginado: categorias da galeria, fontes e fundos
// animados ("scene") que cada tema pode ter (ver plus2-live.js).
const THEME_CATEGORIES = new Set(['essenciais', 'datas', 'gamer', 'espaco', 'luxo', 'natureza', 'sazonal', 'parceiros']);
const THEME_DECORS = new Set(['', 'natal', 'ano-novo', 'carnaval', 'pascoa', 'namorados', 'criancas']);
const cleanDecor = (v) => (typeof v === 'string' && THEME_DECORS.has(v) ? v : '');
const THEME_FONTS = new Set(['', 'modern', 'tech', 'retro', 'elegant', 'soft']);
const THEME_SCENES = new Set(['none', 'aurora', 'grid', 'waves', 'stars', 'embers', 'matrix', 'petals', 'snow', 'confetti', 'fireworks', 'hearts', 'balloons', 'easter']);
const cleanFont = (v) => (typeof v === 'string' && THEME_FONTS.has(v) ? v : '');
const cleanScene = (v) => (typeof v === 'string' && THEME_SCENES.has(v) ? v : 'none');
const cleanCategory = (v) => (typeof v === 'string' && THEME_CATEGORIES.has(v) ? v : null);

// v0.89.0 — efeitos personalizados do tema (Estúdio): itens (emoji ou imagem
// pequena em data URL), chuva/subida, varal, moldura (fogo/neon/gelo...),
// bichinhos andando/brigando, mascote próprio e reação ao chat.
const FX_FRAMES = new Set(['none', 'fire', 'neon', 'ice', 'sparkle', 'glow']);
const FX_FALL = new Set(['fall', 'rise', 'float']);
const FX_CRIT = new Set(['walk', 'fight']);
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
function cleanFxItem(it) {
  if (!it || typeof it !== 'object' || typeof it.v !== 'string') return null;
  if (it.t === 'emoji') { const v = it.v.trim().slice(0, 16); return v ? { t: 'emoji', v } : null; }
  if (it.t === 'img') {
    const v = it.v.trim();
    if (/^data:image\/(png|webp|jpeg|gif);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length <= 90000) return { t: 'img', v };
    if (/^https:\/\/[^\s"'<>]{4,400}$/.test(v)) return { t: 'img', v };
  }
  return null;
}
function cleanFx(fx) {
  if (!fx || typeof fx !== 'object') return null;
  const items = (Array.isArray(fx.items) ? fx.items : []).map(cleanFxItem).filter(Boolean).slice(0, 14);
  const pick = (a) => (Array.isArray(a) ? a.map((i) => Math.floor(Number(i))).filter((i) => i >= 0 && i < items.length).slice(0, 14) : []);
  const out = {
    items,
    fall: { on: !!(fx.fall && fx.fall.on), mode: FX_FALL.has(fx.fall && fx.fall.mode) ? fx.fall.mode : 'fall', count: num(fx.fall && fx.fall.count, 3, 80, 24), size: num(fx.fall && fx.fall.size, 12, 64, 28), speed: num(fx.fall && fx.fall.speed, 0.3, 3, 1) },
    garland: { on: !!(fx.garland && fx.garland.on), size: num(fx.garland && fx.garland.size, 18, 56, 30) },
    frame: { type: FX_FRAMES.has(fx.frame && fx.frame.type) ? fx.frame.type : 'none', color: /^#[0-9a-fA-F]{6}$/.test((fx.frame && fx.frame.color) || '') ? fx.frame.color : '' , power: num(fx.frame && fx.frame.power, 0.3, 2, 1) },
    critters: { on: !!(fx.critters && fx.critters.on), mode: FX_CRIT.has(fx.critters && fx.critters.mode) ? fx.critters.mode : 'walk', count: num(fx.critters && fx.critters.count, 1, 8, 4), size: num(fx.critters && fx.critters.size, 24, 80, 44), items: pick(fx.critters && fx.critters.items) },
    mascot: fx.mascot && typeof fx.mascot === 'object' ? { on: !!fx.mascot.on, item: Math.max(0, Math.min(items.length - 1, Math.floor(Number(fx.mascot.item) || 0))), name: String(fx.mascot.name || '').trim().slice(0, 24), lines: (Array.isArray(fx.mascot.lines) ? fx.mascot.lines : []).map((l) => String(l).trim().slice(0, 90)).filter(Boolean).slice(0, 10) } : { on: false, item: 0, name: '', lines: [] },
    chat: { burst: !(fx.chat && fx.chat.burst === false) },
    chatStyle: (() => { const c = fx.chatStyle || {}; const hx = (v) => (/^#[0-9a-fA-F]{6}$/.test(v || '') ? v : ''); return { bubble: ['default', 'glass', 'solid', 'outline', 'neon', 'round'].includes(c.bubble) ? c.bubble : 'default', entry: ['none', 'pop', 'slide', 'glow'].includes(c.entry) ? c.entry : 'none', radius: num(c.radius, 0, 28, 14), own: hx(c.own), other: hx(c.other) }; })(),
    tsp: { preset: ['fire', 'snow', 'stars', 'fireflies', 'bubbles', 'links', 'confetti'].includes(fx.tsp && fx.tsp.preset) ? fx.tsp.preset : '', color: /^#[0-9a-fA-F]{6}$/.test((fx.tsp && fx.tsp.color) || '') ? fx.tsp.color : '' },
    googleFont: typeof fx.googleFont === 'string' && /^[A-Za-z0-9 ]{2,40}$/.test(fx.googleFont.trim()) ? fx.googleFont.trim() : '',
  };
  const json = JSON.stringify(out);
  if (json.length > 420000) return null;
  return out;
}
function parseFx(s) {
  if (!s) return null;
  try { return cleanFx(JSON.parse(s)); } catch (_) { return null; }
}
const cleanTagline = (v) => (typeof v === 'string' ? v.trim().slice(0, 60) : '');

const BACKGROUND_TYPES = new Set(['solid', 'gradient', 'image', 'gif', 'effect']);
const STICKER_TYPES = new Set(['emoji', 'image']);
const HTTPS_URL_RE = /^https:\/\/\S+$/;
// Aceita também uma imagem embutida como data URI (base64) — usada como
// fallback quando o servidor não tem storage externo (R2) configurado pra
// receber upload de verdade. Mesmo padrão/limite de tamanho já usado pro
// avatar no cadastro (350.000 caracteres de texto).
const DATA_IMAGE_URI_RE = /^data:image\/(png|jpe?g|webp|gif);base64,/;
const MAX_INLINE_IMAGE_LENGTH = 350000;
const BUBBLE_STYLES = new Set(['rounded', 'square', 'minimal']);
const COLOR_MODES = new Set(['per_user', 'theme', 'mono']);
const FONT_SIZES = new Set(['small', 'medium', 'large']);
const MENTION_EFFECTS = new Set(['none', 'highlight', 'shake', 'glow']);

// Valida/normaliza a data de lançamento vinda do admin (campo <input
// type="datetime-local">, formato "2026-12-25T00:00") — devolve null (sem
// data = tema já disponível) ou uma string ISO completa pra gravar no banco.
function normalizeReleaseAt(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { ok: false };
  return { ok: true, value: d.toISOString() };
}

// Tema com release_at no futuro = "lançamento programado": a pessoa ainda
// não pode usar, mas o tema continua aparecendo na galeria (com cadeado + a
// data exata), em vez de simplesmente sumir do catálogo (era assim que o
// Halloween funcionava antes — removido da lista por completo depois de uma
// data fixa no código). Controlável pelo admin via o campo release_at.
function isThemeReleased(t, now) {
  if (!t.release_at) return true;
  return new Date(t.release_at).getTime() <= now.getTime();
}

// Acesso a temas exclusivos por cupom (ex.: Magic Tank). users.partner_magic_tank
// = NULL | 'forever' | data ISO de expiração. Admin sempre tem acesso.
function hasCouponAccess(user, coupon) {
  if (!user) return false;
  if (user.is_admin) return true;
  if (coupon === 'magic_tank') {
    const v = user.partner_magic_tank;
    if (!v) return false;
    if (v === 'forever') return true;
    const ts = new Date(v).getTime();
    return !Number.isNaN(ts) && ts > Date.now();
  }
  return false;
}

// Quem pode usar tema de data/agendado ANTES do lançamento (para teste):
// só admin COM selo de verificado.
function canTestEarly(user) {
  return !!(user && user.is_admin && user.is_verified);
}

function themeOut(t, unlocked, now, isAdmin, user) {
  const trulyReleased = isThemeReleased(t, now || new Date());
  const released = trulyReleased || canTestEarly(user);
  const exclusive = t.exclusive_coupon || null;
  const couponLocked = !!exclusive && !hasCouponAccess(user, exclusive);
  return {
    id: t.id,
    key: t.key,
    name: t.name,
    colors: {
      primary: t.primary_color,
      secondary: t.secondary_color,
      highlight: t.highlight_color,
      text: t.text_color,
      button: t.button_color,
    },
    darkMode: !!t.dark_mode,
    effect: t.effect,
    category: t.category || (t.is_preset ? 'essenciais' : 'meus'),
    tagline: t.tagline || '',
    font: t.font_key || '',
    scene: t.scene || 'none',
    decor: t.decor_key || '',
    fx: parseFx(t.fx_json),
    draft: t.published === 0,
    // Efeitos que esse tema recomenda ligar sozinho ao ser escolhido (ver
    // applyThemeEffects() em plus2.js) — [] pra tema sem nenhum sugerido.
    suggestedEffects: parseSuggestedEffects(t.suggested_effects),
    premium: !!t.is_premium,
    preset: !!t.is_preset,
    custom: !t.is_preset,
    // Data exata de lançamento definida pelo admin (null = sem data, tema já
    // disponível desde sempre). comingSoon fica true enquanto a data ainda
    // não chegou — o frontend usa isso pra mostrar "disponível em XX/XX".
    releaseAt: t.release_at || null,
    comingSoon: !trulyReleased,
    earlyAccess: !trulyReleased && released,
    exclusive,
    couponLocked,
    // v0.98.2: tema exclusivo por código (ex.: Magic Tank) — o CÓDIGO é a
    // única chave (admin sempre pode). Antes ele também exigia PLUS, e quem
    // resgatava um código "só tema" continuava trancado.
    locked: exclusive ? (couponLocked || !released) : ((!!t.is_premium && !unlocked && !isAdmin) || !released),
  };
}

function badgeOut(b, unlocked) {
  return {
    id: b.id,
    key: b.key,
    name: b.name,
    icon: b.icon,
    premium: !!b.is_premium,
    locked: !!b.is_premium && !unlocked,
  };
}

function bannerOut(b, unlocked) {
  return {
    id: b.id,
    key: b.key,
    name: b.name,
    style: b.style,
    value: b.value,
    premium: !!b.is_premium,
    locked: !!b.is_premium && !unlocked,
  };
}

function backgroundOut(b, unlocked) {
  return {
    id: b.id,
    key: b.key,
    name: b.name,
    type: b.type,
    value: b.value,
    premium: !!b.is_premium,
    locked: !!b.is_premium && !unlocked,
  };
}

function stickerOut(s) {
  return { id: s.id, type: s.type, content: s.content };
}

function buildPlusV2Router({ db, requireAuth, requireAdmin, asyncHandler, isPlusAccount }) {
  const router = express.Router();


  // ---------------------------------------------------------------------
  // v0.88.0 — API PÚBLICA DE TEMAS (parceiros / jogos integrados).
  // Sem login, com CORS aberto (só leitura): devolve os temas oficiais já
  // PUBLICADOS e LIBERADOS. Usada pelo SDK /sdk/nextgame-themes.js.
  // ---------------------------------------------------------------------
  function publicTheme(t) {
    return {
      key: t.key, name: t.name, tagline: t.tagline || '', category: t.category || 'essenciais',
      colors: { primary: t.primary_color, secondary: t.secondary_color, highlight: t.highlight_color, text: t.text_color, button: t.button_color },
      darkMode: !!t.dark_mode, effect: t.effect, font: t.font_key || '', scene: t.scene || 'none', decor: t.decor_key || '', fx: parseFx(t.fx_json),
      premium: !!t.is_premium, releaseAt: t.release_at || null,
    };
  }
  function openCors(res) {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Cache-Control', 'public, max-age=60');
  }
  router.options('/public/themes', (req, res) => { openCors(res); res.sendStatus(204); });
  router.options('/public/themes/:key', (req, res) => { openCors(res); res.sendStatus(204); });
  router.get(
    '/public/themes',
    asyncHandler(async (req, res) => {
      openCors(res);
      const rows = await db.all('SELECT * FROM plus_v2_themes WHERE is_preset = 1 AND COALESCE(published, 1) = 1 ORDER BY sort_order ASC');
      const now = new Date();
      const themes = rows.filter((t) => t.key && !t.exclusive_coupon && isThemeReleased(t, now)).map(publicTheme);
      res.json({ version: 1, generatedAt: now.toISOString(), count: themes.length, themes });
    })
  );
  router.get(
    '/public/themes/:key',
    asyncHandler(async (req, res) => {
      openCors(res);
      const t = await db.get('SELECT * FROM plus_v2_themes WHERE is_preset = 1 AND key = ? AND COALESCE(published, 1) = 1', [req.params.key]);
      if (!t || t.exclusive_coupon || !isThemeReleased(t, new Date())) return res.status(404).json({ error: 'Tema não encontrado' });
      res.json(publicTheme(t));
    })
  );

  // ---------------------------------------------------------------------
  // Catálogo público (autenticado) — temas, badges e banners disponíveis,
  // já marcando `locked` de acordo com o plano da própria pessoa.
  // ---------------------------------------------------------------------
  router.get(
    '/catalog',
    requireAuth,
    asyncHandler(async (req, res) => {
      const unlocked = isPlusAccount(req.user);
      let themes = await db.all(
        req.user.is_admin
          ? 'SELECT * FROM plus_v2_themes WHERE is_preset = 1 ORDER BY sort_order ASC'
          : 'SELECT * FROM plus_v2_themes WHERE is_preset = 1 AND COALESCE(published, 1) = 1 ORDER BY sort_order ASC'
      );
      // O tema sazonal fica disponível até 31 de outubro (inclusive), no
      // fuso da Espanha. Depois disso some do catálogo para novas escolhas.
      const madridDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
      const myCustomThemes = await db.all(
        'SELECT * FROM plus_v2_themes WHERE is_preset = 0 AND owner_user_id = ? ORDER BY created_at DESC',
        [req.user.id]
      );
      const badges = await db.all('SELECT * FROM plus_v2_badges ORDER BY sort_order ASC');
      const banners = await db.all('SELECT * FROM plus_v2_banners ORDER BY sort_order ASC');
      const backgrounds = await db.all('SELECT * FROM plus_v2_backgrounds ORDER BY sort_order ASC');

      // Perdeu o acesso (cupom expirou)? Volta pro tema padrão em vez de manter
      // um tema exclusivo que não é mais dele.
      if (req.user.plus2_theme_id) {
        const cur = themes.find((t) => t.id === req.user.plus2_theme_id);
        if (cur && cur.exclusive_coupon && !hasCouponAccess(req.user, cur.exclusive_coupon)) {
          await db.run('UPDATE users SET plus2_theme_id = NULL WHERE id = ?', [req.user.id]);
          req.user.plus2_theme_id = null;
        }
      }

      res.json({
        isPlusUser: unlocked,
        themes: themes.map((t) => themeOut(t, unlocked, undefined, !!req.user.is_admin, req.user)),
        myCustomThemes: myCustomThemes.map((t) => themeOut(t, unlocked)),
        partnerAccess: { magicTank: hasCouponAccess(req.user, 'magic_tank') },
        badges: badges.map((b) => badgeOut(b, unlocked)),
        banners: banners.map((b) => bannerOut(b, unlocked)),
        backgrounds: backgrounds.map((b) => backgroundOut(b, unlocked)),
        current: {
          themeId: req.user.plus2_theme_id || null,
          bannerId: req.user.plus2_banner_id || null,
          badgeId: req.user.plus2_badge_id || null,
          backgroundId: req.user.plus2_background_id || null,
          customBannerUrl: req.user.plus2_custom_banner_url || null,
          customBackgroundUrl: req.user.plus2_custom_bg_url || null,
          customBackgroundType: req.user.plus2_custom_bg_type || 'image',
        },
        visualPrefs: mergeVisualPrefs(req.user.plus2_visual_prefs),
      });
    })
  );

  // ---------------------------------------------------------------------
  // Figurinhas — carregado à parte do /catalog (lazy, só quando a aba abre)
  // porque pode ter bastante coisa (vários pacotes com várias figurinhas
  // cada) e a maioria das visitas nem chega a abrir essa aba.
  // ---------------------------------------------------------------------
  router.get(
    '/stickers',
    requireAuth,
    asyncHandler(async (req, res) => {
      const unlocked = isPlusAccount(req.user);
      const packs = await db.all('SELECT * FROM plus_v2_sticker_packs ORDER BY sort_order ASC');
      const allStickers = await db.all('SELECT * FROM plus_v2_stickers ORDER BY sort_order ASC');
      const stickersByPack = {};
      allStickers.forEach((s) => { (stickersByPack[s.pack_id] = stickersByPack[s.pack_id] || []).push(stickerOut(s)); });
      res.json({
        isPlusUser: unlocked,
        packs: packs.map((p) => ({
          id: p.id,
          key: p.key,
          name: p.name,
          premium: !!p.is_premium,
          locked: !!p.is_premium && !unlocked,
          stickers: stickersByPack[p.id] || [],
        })),
      });
    })
  );

  // ---------------------------------------------------------------------
  // Criador de tema personalizado — salva (cria ou atualiza) um tema do
  // próprio usuário. Exclusivo de quem é NEXTGAME PLUS, igual ao "Recursos
  // exclusivos" do material de referência (cores ilimitadas / temas premium).
  // ---------------------------------------------------------------------
  router.post(
    '/themes/custom',
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!isPlusAccount(req.user)) {
        return res.status(403).json({ error: 'Criar tema personalizado é exclusivo de quem tem NEXTGAME PLUS' });
      }
      const { id, name, primary, secondary, highlight, text, button, darkMode, effect, font, scene } = req.body || {};
      const colors = { primary, secondary, highlight, text, button };
      for (const [k, v] of Object.entries(colors)) {
        if (typeof v !== 'string' || !HEX_COLOR_RE.test(v)) {
          return res.status(400).json({ error: `Cor inválida em "${k}" — use um hex tipo #5865F2` });
        }
      }
      const cleanName = (typeof name === 'string' ? name.trim() : '').slice(0, 40) || 'Meu tema';
      const cleanEffect = EFFECTS.has(effect) ? effect : 'none';

      // Um usuário free nunca chega aqui (bloqueado acima), mas mesmo assim
      // nunca deixamos ninguém, plus ou não, marcar o próprio tema como
      // "premium" — isso é reservado pro catálogo de presets.
      if (id) {
        const existing = await db.get('SELECT * FROM plus_v2_themes WHERE id = ? AND owner_user_id = ?', [id, req.user.id]);
        if (!existing) return res.status(404).json({ error: 'Tema não encontrado' });
        await db.run(
          `UPDATE plus_v2_themes SET name=?, primary_color=?, secondary_color=?, highlight_color=?, text_color=?, button_color=?, dark_mode=?, effect=?, font_key=?, scene=?
           WHERE id = ?`,
          [cleanName, primary, secondary, highlight, text, button, darkMode ? 1 : 0, cleanEffect, cleanFont(font), cleanScene(scene), id]
        );
        return res.json({ ok: true, id });
      }

      const newThemeId = newId();
      await db.run(
        `INSERT INTO plus_v2_themes
          (id, key, name, primary_color, secondary_color, highlight_color, text_color, button_color, dark_mode, effect, is_premium, is_preset, owner_user_id, sort_order, font_key, scene)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?)`,
        [newThemeId, cleanName, primary, secondary, highlight, text, button, darkMode ? 1 : 0, cleanEffect, req.user.id, cleanFont(font), cleanScene(scene)]
      );
      res.json({ ok: true, id: newThemeId });
    })
  );

  router.delete(
    '/themes/custom/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const existing = await db.get('SELECT * FROM plus_v2_themes WHERE id = ? AND owner_user_id = ?', [req.params.id, req.user.id]);
      if (!existing) return res.status(404).json({ error: 'Tema não encontrado' });
      await db.run('DELETE FROM plus_v2_themes WHERE id = ?', [req.params.id]);
      if (req.user.plus2_theme_id === req.params.id) {
        await db.run('UPDATE users SET plus2_theme_id = NULL WHERE id = ?', [req.user.id]);
      }
      res.json({ ok: true });
    })
  );

  // ---------------------------------------------------------------------
  // Aplicar tema / banner / badge escolhidos — valida que a pessoa realmente
  // tem acesso (não é premium trancado) antes de gravar.
  // ---------------------------------------------------------------------
  router.patch(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      const unlocked = isPlusAccount(req.user);
      const { themeId, bannerId, badgeId } = req.body || {};

      if (themeId !== undefined) {
        if (themeId === null) {
          await db.run('UPDATE users SET plus2_theme_id = NULL WHERE id = ?', [req.user.id]);
        } else {
          const theme = await db.get(
            'SELECT * FROM plus_v2_themes WHERE id = ? AND (is_preset = 1 OR owner_user_id = ?)',
            [themeId, req.user.id]
          );
          if (!theme) return res.status(404).json({ error: 'Tema não encontrado' });
          if (theme.exclusive_coupon && !hasCouponAccess(req.user, theme.exclusive_coupon)) {
            return res.status(403).json({
              error: 'Tema exclusivo — resgate o cupom do parceiro em NEXTGAME PLUS > Resgatar cupom.',
              exclusive: theme.exclusive_coupon,
            });
          }
          if (!theme.exclusive_coupon && theme.is_premium && !unlocked && !req.user.is_admin) {
            return res.status(403).json({ error: 'Esse tema é exclusivo de quem tem NEXTGAME PLUS' });
          }
          // Reforça no servidor a data de lançamento (release_at) definida
          // pelo admin — sem isso, dava pra escolher um tema "ainda não
          // lançado" direto pela API, mesmo que a galeria mostrasse cadeado.
          if (!isThemeReleased(theme, new Date()) && !canTestEarly(req.user)) {
            return res.status(403).json({
              error: 'Esse tema ainda não foi lançado.',
              releaseAt: theme.release_at,
            });
          }
          await db.run('UPDATE users SET plus2_theme_id = ? WHERE id = ?', [themeId, req.user.id]);
        }
      }

      if (bannerId !== undefined) {
        if (bannerId === null) {
          await db.run('UPDATE users SET plus2_banner_id = NULL WHERE id = ?', [req.user.id]);
        } else {
          const banner = await db.get('SELECT * FROM plus_v2_banners WHERE id = ?', [bannerId]);
          if (!banner) return res.status(404).json({ error: 'Banner não encontrado' });
          if (banner.is_premium && !unlocked) {
            return res.status(403).json({ error: 'Esse banner é exclusivo de quem tem NEXTGAME PLUS' });
          }
          // Escolher um banner do catálogo desliga a imagem própria (só um
          // dos dois fica ativo por vez) — evita ambiguidade de qual mostrar.
          await db.run('UPDATE users SET plus2_banner_id = ?, plus2_custom_banner_url = NULL WHERE id = ?', [bannerId, req.user.id]);
        }
      }

      // Banner com imagem própria (upload) — exclusivo de quem tem NEXTGAME
      // PLUS. `customBannerUrl` já vem pronta (a pessoa fez upload direto
      // pro storage via /api/uploads/presign do site principal; aqui só
      // guardamos a URL pública resultante).
      if (req.body && req.body.customBannerUrl !== undefined) {
        const url = req.body.customBannerUrl;
        if (url === null) {
          await db.run('UPDATE users SET plus2_custom_banner_url = NULL WHERE id = ?', [req.user.id]);
        } else {
          if (!unlocked) {
            return res.status(403).json({ error: 'Banner com imagem própria é exclusivo de quem tem NEXTGAME PLUS' });
          }
          const isHttpsUrl = typeof url === 'string' && url.length <= 2048 && HTTPS_URL_RE.test(url);
          const isInlineImage =
            typeof url === 'string' && url.length <= MAX_INLINE_IMAGE_LENGTH && DATA_IMAGE_URI_RE.test(url);
          if (!isHttpsUrl && !isInlineImage) {
            return res.status(400).json({ error: 'URL de imagem inválida ou imagem grande demais.' });
          }
          // Imagem própria desliga o banner escolhido do catálogo.
          await db.run('UPDATE users SET plus2_custom_banner_url = ?, plus2_banner_id = NULL WHERE id = ?', [url, req.user.id]);
        }
      }

      if (badgeId !== undefined) {
        if (badgeId === null) {
          await db.run('UPDATE users SET plus2_badge_id = NULL WHERE id = ?', [req.user.id]);
        } else {
          const badge = await db.get('SELECT * FROM plus_v2_badges WHERE id = ?', [badgeId]);
          if (!badge) return res.status(404).json({ error: 'Badge não encontrado' });
          if (badge.is_premium && !unlocked) {
            return res.status(403).json({ error: 'Esse badge é exclusivo de quem tem NEXTGAME PLUS' });
          }
          await db.run('UPDATE users SET plus2_badge_id = ? WHERE id = ?', [badgeId, req.user.id]);
        }
      }

      if (req.body && req.body.backgroundId !== undefined) {
        const backgroundId = req.body.backgroundId;
        if (backgroundId === null) {
          await db.run('UPDATE users SET plus2_background_id = NULL WHERE id = ?', [req.user.id]);
        } else {
          const background = await db.get('SELECT * FROM plus_v2_backgrounds WHERE id = ?', [backgroundId]);
          if (!background) return res.status(404).json({ error: 'Fundo não encontrado' });
          if (background.is_premium && !unlocked) {
            return res.status(403).json({ error: 'Esse fundo é exclusivo de quem tem NEXTGAME PLUS' });
          }
          await db.run('UPDATE users SET plus2_background_id = ?, plus2_custom_bg_url = NULL WHERE id = ?', [backgroundId, req.user.id]);
        }
      }

      // Fundo com imagem/GIF próprio (upload) — exclusivo de quem tem
      // NEXTGAME PLUS. Mesmo padrão do customBannerUrl acima: a URL já vem
      // pronta (upload direto pro storage via /api/uploads/presign do site
      // principal), aqui só valida e guarda. Corrige o "imagem/GIF não
      // funciona" — antes só existiam exemplos de ilustração no catálogo,
      // sem nenhum jeito de a pessoa mandar um arquivo de verdade.
      if (req.body && req.body.customBackgroundUrl !== undefined) {
        const url = req.body.customBackgroundUrl;
        if (url === null) {
          await db.run('UPDATE users SET plus2_custom_bg_url = NULL WHERE id = ?', [req.user.id]);
        } else {
          if (!unlocked) {
            return res.status(403).json({ error: 'Fundo com imagem própria é exclusivo de quem tem NEXTGAME PLUS' });
          }
          const isHttpsUrl = typeof url === 'string' && url.length <= 2048 && HTTPS_URL_RE.test(url);
          const isInlineImage =
            typeof url === 'string' && url.length <= MAX_INLINE_IMAGE_LENGTH && DATA_IMAGE_URI_RE.test(url);
          if (!isHttpsUrl && !isInlineImage) {
            return res.status(400).json({ error: 'URL de imagem/GIF inválida ou arquivo grande demais.' });
          }
          const bgType = req.body.customBackgroundType === 'gif' ? 'gif' : 'image';
          // Imagem própria desliga o fundo escolhido do catálogo (só um dos
          // dois fica ativo por vez, igual banner/tema).
          await db.run(
            'UPDATE users SET plus2_custom_bg_url = ?, plus2_custom_bg_type = ?, plus2_background_id = NULL WHERE id = ?',
            [url, bgType, req.user.id]
          );
        }
      }

      // Preferências "soltas" (opacidade/desfoque do fundo, efeitos, modo
      // desempenho, personalização do chat) — merge-patch: só sobrescreve as
      // chaves que vierem no corpo, preservando o resto do que já tava salvo.
      // Efeitos visuais avançados (partículas, glow, gradiente animado etc.)
      // são exclusivos de quem tem NEXTGAME PLUS — free sempre volta pro
      // padrão "tudo desligado, exceto o básico" se tentar ligar algo preso.
      if (req.body && req.body.visualPrefs !== undefined) {
        const current = mergeVisualPrefs(req.user.plus2_visual_prefs);
        const incoming = req.body.visualPrefs || {};

        if (incoming.background) {
          if (typeof incoming.background.opacity === 'number') {
            current.background.opacity = Math.max(0, Math.min(100, incoming.background.opacity));
          }
          if (typeof incoming.background.blur === 'number') {
            current.background.blur = Math.max(0, Math.min(100, incoming.background.blur));
          }
        }

        if (incoming.effects) {
          for (const key of Object.keys(current.effects)) {
            if (typeof incoming.effects[key] !== 'boolean') continue;
            // brilho nos botões e animações de transição são gratuitos —
            // o resto (partículas, gradiente animado, glow no avatar etc.)
            // é exclusivo Plus, seguindo o material de referência.
            const freeEffectKeys = new Set(['buttonGlow', 'transitions', 'messageReceive', 'callJoin']);
            if (!unlocked && !freeEffectKeys.has(key) && incoming.effects[key]) continue;
            current.effects[key] = incoming.effects[key];
          }
        }

        if (typeof incoming.performanceMode === 'boolean') {
          current.performanceMode = incoming.performanceMode;
        }

        if (incoming.chat) {
          if (BUBBLE_STYLES.has(incoming.chat.bubbleStyle)) current.chat.bubbleStyle = incoming.chat.bubbleStyle;
          if (typeof incoming.chat.showAvatars === 'boolean') current.chat.showAvatars = incoming.chat.showAvatars;
          if (COLOR_MODES.has(incoming.chat.colorMode)) {
            // "cor por usuário" ilimitada é um perk Plus — free fica preso
            // no modo 'theme' (cor única vinda do tema escolhido).
            if (incoming.chat.colorMode === 'per_user' && !unlocked) {
              current.chat.colorMode = 'theme';
            } else {
              current.chat.colorMode = incoming.chat.colorMode;
            }
          }
          if (FONT_SIZES.has(incoming.chat.fontSize)) current.chat.fontSize = incoming.chat.fontSize;
          if (typeof incoming.chat.spacing === 'number') current.chat.spacing = Math.max(4, Math.min(32, incoming.chat.spacing));
          if (typeof incoming.chat.showTimestamps === 'boolean') current.chat.showTimestamps = incoming.chat.showTimestamps;
          if (typeof incoming.chat.showReactions === 'boolean') current.chat.showReactions = incoming.chat.showReactions;
          if (MENTION_EFFECTS.has(incoming.chat.mentionEffect)) {
            if (incoming.chat.mentionEffect !== 'none' && incoming.chat.mentionEffect !== 'highlight' && !unlocked) {
              // shake/glow são efeitos premium; free fica em highlight.
            } else {
              current.chat.mentionEffect = incoming.chat.mentionEffect;
            }
          }
        }

        await db.run('UPDATE users SET plus2_visual_prefs = ? WHERE id = ?', [JSON.stringify(current), req.user.id]);
      }

      res.json({ ok: true });
    })
  );

  // ---------------------------------------------------------------------
  // Admin — leitura de tudo, num formato "achatado" (sem colors: {} aninhado,
  // com sort_order incluído) pronto pra preencher os formulários de edição.
  // Diferente do /catalog: não filtra nada por locked/plano, é visão de
  // administrador mesmo.
  // ---------------------------------------------------------------------
  router.get(
    '/admin/all',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const [themes, backgrounds, banners, badges, packs, stickers] = await Promise.all([
        db.all('SELECT * FROM plus_v2_themes WHERE is_preset = 1 ORDER BY sort_order ASC'),
        db.all('SELECT * FROM plus_v2_backgrounds ORDER BY sort_order ASC'),
        db.all('SELECT * FROM plus_v2_banners ORDER BY sort_order ASC'),
        db.all('SELECT * FROM plus_v2_badges ORDER BY sort_order ASC'),
        db.all('SELECT * FROM plus_v2_sticker_packs ORDER BY sort_order ASC'),
        db.all('SELECT * FROM plus_v2_stickers ORDER BY sort_order ASC'),
      ]);
      const stickersByPack = {};
      stickers.forEach((s) => { (stickersByPack[s.pack_id] = stickersByPack[s.pack_id] || []).push(stickerOut(s)); });
      res.json({
        themes: themes.map((t) => ({
          id: t.id, key: t.key, name: t.name,
          primary: t.primary_color, secondary: t.secondary_color, highlight: t.highlight_color,
          text: t.text_color, button: t.button_color, darkMode: !!t.dark_mode, effect: t.effect,
          premium: !!t.is_premium, sortOrder: t.sort_order,
          // Data exata de lançamento (null = sem data, já disponível).
          releaseAt: t.release_at || null,
          // Efeitos que ligam sozinhos quando o usuário escolhe esse tema —
          // editável no admin (ver campo "Efeitos sugeridos" no formulário).
          suggestedEffects: parseSuggestedEffects(t.suggested_effects),
          category: t.category || '', tagline: t.tagline || '', font: t.font_key || '', scene: t.scene || 'none', decor: t.decor_key || '', fx: parseFx(t.fx_json), published: t.published === null || t.published === undefined ? true : !!t.published,
        })),
        backgrounds: backgrounds.map((b) => ({ id: b.id, key: b.key, name: b.name, type: b.type, value: b.value, premium: !!b.is_premium, sortOrder: b.sort_order })),
        banners: banners.map((b) => ({ id: b.id, key: b.key, name: b.name, style: b.style, value: b.value, premium: !!b.is_premium, sortOrder: b.sort_order })),
        badges: badges.map((b) => ({ id: b.id, key: b.key, name: b.name, icon: b.icon, premium: !!b.is_premium, sortOrder: b.sort_order })),
        stickerPacks: packs.map((p) => ({ id: p.id, key: p.key, name: p.name, premium: !!p.is_premium, sortOrder: p.sort_order, stickers: stickersByPack[p.id] || [] })),
      });
    })
  );

  // ---------------------------------------------------------------------
  // Admin — CRUD do catálogo de fundos disponíveis, pra dar pra
  // adicionar/editar/remover sem mexer em código (painel /admin.html).
  // ---------------------------------------------------------------------
  router.post(
    '/admin/backgrounds',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { key, name, type, value, premium, sortOrder } = req.body || {};
      if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Nome é obrigatório' });
      if (!BACKGROUND_TYPES.has(type)) return res.status(400).json({ error: 'Tipo inválido (use solid/gradient/image/gif/effect)' });
      if (!value || typeof value !== 'string') return res.status(400).json({ error: 'Value é obrigatório' });
      const id = newId();
      await db.run(
        'INSERT INTO plus_v2_backgrounds (id, key, name, type, value, is_premium, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, key || null, name.trim(), type, value, premium ? 1 : 0, sortOrder || 0]
      );
      res.json({ ok: true, id });
    })
  );

  router.patch(
    '/admin/backgrounds/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const existing = await db.get('SELECT * FROM plus_v2_backgrounds WHERE id = ?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Fundo não encontrado' });
      const { name, type, value, premium, sortOrder } = req.body || {};
      const sets = [];
      const values = [];
      if (typeof name === 'string') { sets.push('name = ?'); values.push(name.trim()); }
      if (typeof type === 'string' && BACKGROUND_TYPES.has(type)) { sets.push('type = ?'); values.push(type); }
      if (typeof value === 'string') { sets.push('value = ?'); values.push(value); }
      if (typeof premium === 'boolean') { sets.push('is_premium = ?'); values.push(premium ? 1 : 0); }
      if (typeof sortOrder === 'number') { sets.push('sort_order = ?'); values.push(sortOrder); }
      if (!sets.length) return res.json({ ok: true });
      values.push(req.params.id);
      await db.run(`UPDATE plus_v2_backgrounds SET ${sets.join(', ')} WHERE id = ?`, values);
      res.json({ ok: true });
    })
  );

  router.delete(
    '/admin/backgrounds/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      await db.run('DELETE FROM plus_v2_backgrounds WHERE id = ?', [req.params.id]);
      await db.run('UPDATE users SET plus2_background_id = NULL WHERE plus2_background_id = ?', [req.params.id]);
      res.json({ ok: true });
    })
  );

  // ---------------------------------------------------------------------
  // Admin — CRUD do catálogo de banners de perfil (cor sólida/gradiente).
  // ---------------------------------------------------------------------
  const BANNER_STYLES = new Set(['solid', 'gradient']);
  router.post(
    '/admin/banners',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { key, name, style, value, premium, sortOrder } = req.body || {};
      if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Nome é obrigatório' });
      if (!BANNER_STYLES.has(style)) return res.status(400).json({ error: 'Estilo inválido (use solid/gradient)' });
      if (!value || typeof value !== 'string') return res.status(400).json({ error: 'Value é obrigatório' });
      const id = newId();
      await db.run(
        'INSERT INTO plus_v2_banners (id, key, name, style, value, is_premium, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, key || null, name.trim(), style, value, premium ? 1 : 0, sortOrder || 0]
      );
      res.json({ ok: true, id });
    })
  );

  router.patch(
    '/admin/banners/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const existing = await db.get('SELECT * FROM plus_v2_banners WHERE id = ?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Banner não encontrado' });
      const { name, style, value, premium, sortOrder } = req.body || {};
      const sets = [];
      const values = [];
      if (typeof name === 'string') { sets.push('name = ?'); values.push(name.trim()); }
      if (typeof style === 'string' && BANNER_STYLES.has(style)) { sets.push('style = ?'); values.push(style); }
      if (typeof value === 'string') { sets.push('value = ?'); values.push(value); }
      if (typeof premium === 'boolean') { sets.push('is_premium = ?'); values.push(premium ? 1 : 0); }
      if (typeof sortOrder === 'number') { sets.push('sort_order = ?'); values.push(sortOrder); }
      if (!sets.length) return res.json({ ok: true });
      values.push(req.params.id);
      await db.run(`UPDATE plus_v2_banners SET ${sets.join(', ')} WHERE id = ?`, values);
      res.json({ ok: true });
    })
  );

  router.delete(
    '/admin/banners/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      await db.run('DELETE FROM plus_v2_banners WHERE id = ?', [req.params.id]);
      await db.run('UPDATE users SET plus2_banner_id = NULL WHERE plus2_banner_id = ?', [req.params.id]);
      res.json({ ok: true });
    })
  );

  // ---------------------------------------------------------------------
  // Admin — CRUD do catálogo de temas prontos e badges, pra dar pra
  // adicionar/editar/remover sem mexer em código (painel /admin.html).
  // ---------------------------------------------------------------------
  router.post(
    '/admin/themes',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { key, name, primary, secondary, highlight, text, button, darkMode, effect, premium, sortOrder, releaseAt, suggestedEffects, category, tagline, font, scene, decor, published, fx } = req.body || {};
      const colors = { primary, secondary, highlight, text, button };
      for (const [k, v] of Object.entries(colors)) {
        if (typeof v !== 'string' || !HEX_COLOR_RE.test(v)) {
          return res.status(400).json({ error: `Cor inválida em "${k}"` });
        }
      }
      if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Nome é obrigatório' });
      const releaseAtResult = normalizeReleaseAt(releaseAt);
      if (!releaseAtResult.ok) return res.status(400).json({ error: 'Data de lançamento inválida' });
      // Filtra pra só aceitar chaves de efeito que a gente conhece — mesma
      // lógica defensiva do parseSuggestedEffects usado na leitura.
      const suggestedEffectsClean = Array.isArray(suggestedEffects) ? suggestedEffects.filter((e) => SITE_EFFECTS.has(e)) : [];
      const id = newId();
      await db.run(
        `INSERT INTO plus_v2_themes
          (id, key, name, primary_color, secondary_color, highlight_color, text_color, button_color, dark_mode, effect, is_premium, is_preset, owner_user_id, sort_order, release_at, suggested_effects, category, tagline, font_key, scene, decor_key, published, fx_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, key || null, name.trim(), primary, secondary, highlight, text, button, darkMode ? 1 : 0, EFFECTS.has(effect) ? effect : 'none', premium ? 1 : 0, sortOrder || 0, releaseAtResult.value, JSON.stringify(suggestedEffectsClean), cleanCategory(category), cleanTagline(tagline), cleanFont(font), cleanScene(scene), cleanDecor(decor), published === false ? 0 : 1, (() => { const c = cleanFx(fx); return c ? JSON.stringify(c) : null; })()]
      );
      res.json({ ok: true, id });
    })
  );

  router.patch(
    '/admin/themes/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const existing = await db.get('SELECT * FROM plus_v2_themes WHERE id = ? AND is_preset = 1', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Tema não encontrado' });
      const fields = req.body || {};
      const colorMap = { primary: 'primary_color', secondary: 'secondary_color', highlight: 'highlight_color', text: 'text_color', button: 'button_color' };
      const sets = [];
      const values = [];
      if (typeof fields.name === 'string') { sets.push('name = ?'); values.push(fields.name.trim()); }
      for (const [inKey, col] of Object.entries(colorMap)) {
        if (typeof fields[inKey] === 'string') {
          if (!HEX_COLOR_RE.test(fields[inKey])) return res.status(400).json({ error: `Cor inválida em "${inKey}"` });
          sets.push(`${col} = ?`);
          values.push(fields[inKey]);
        }
      }
      if (typeof fields.darkMode === 'boolean') { sets.push('dark_mode = ?'); values.push(fields.darkMode ? 1 : 0); }
      if (typeof fields.effect === 'string' && EFFECTS.has(fields.effect)) { sets.push('effect = ?'); values.push(fields.effect); }
      if (typeof fields.premium === 'boolean') { sets.push('is_premium = ?'); values.push(fields.premium ? 1 : 0); }
      if (typeof fields.sortOrder === 'number') { sets.push('sort_order = ?'); values.push(fields.sortOrder); }
      if (fields.releaseAt !== undefined) {
        const releaseAtResult = normalizeReleaseAt(fields.releaseAt);
        if (!releaseAtResult.ok) return res.status(400).json({ error: 'Data de lançamento inválida' });
        sets.push('release_at = ?');
        values.push(releaseAtResult.value);
      }
      if (Array.isArray(fields.suggestedEffects)) {
        const clean = fields.suggestedEffects.filter((e) => SITE_EFFECTS.has(e));
        sets.push('suggested_effects = ?');
        values.push(JSON.stringify(clean));
      }
      if (fields.category !== undefined) { sets.push('category = ?'); values.push(cleanCategory(fields.category)); }
      if (fields.tagline !== undefined) { sets.push('tagline = ?'); values.push(cleanTagline(fields.tagline)); }
      if (fields.font !== undefined) { sets.push('font_key = ?'); values.push(cleanFont(fields.font)); }
      if (fields.scene !== undefined) { sets.push('scene = ?'); values.push(cleanScene(fields.scene)); }
      if (fields.decor !== undefined) { sets.push('decor_key = ?'); values.push(cleanDecor(fields.decor)); }
      if (fields.fx !== undefined) { const c = cleanFx(fields.fx); sets.push('fx_json = ?'); values.push(c ? JSON.stringify(c) : null); }
      if (typeof fields.published === 'boolean') { sets.push('published = ?'); values.push(fields.published ? 1 : 0); }
      if (!sets.length) return res.json({ ok: true });
      values.push(req.params.id);
      await db.run(`UPDATE plus_v2_themes SET ${sets.join(', ')} WHERE id = ?`, values);
      res.json({ ok: true });
    })
  );

  router.delete(
    '/admin/themes/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      await db.run('DELETE FROM plus_v2_themes WHERE id = ? AND is_preset = 1', [req.params.id]);
      await db.run('UPDATE users SET plus2_theme_id = NULL WHERE plus2_theme_id = ?', [req.params.id]);
      res.json({ ok: true });
    })
  );

  router.post(
    '/admin/badges',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { key, name, icon, premium, sortOrder } = req.body || {};
      if (!name || !icon) return res.status(400).json({ error: 'Nome e ícone são obrigatórios' });
      const id = newId();
      await db.run(
        'INSERT INTO plus_v2_badges (id, key, name, icon, is_premium, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
        [id, key || null, String(name).trim(), String(icon).trim(), premium ? 1 : 0, sortOrder || 0]
      );
      res.json({ ok: true, id });
    })
  );

  router.patch(
    '/admin/badges/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const existing = await db.get('SELECT * FROM plus_v2_badges WHERE id = ?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Badge não encontrado' });
      const { name, icon, premium, sortOrder } = req.body || {};
      const sets = [];
      const values = [];
      if (typeof name === 'string') { sets.push('name = ?'); values.push(name.trim()); }
      if (typeof icon === 'string') { sets.push('icon = ?'); values.push(icon.trim()); }
      if (typeof premium === 'boolean') { sets.push('is_premium = ?'); values.push(premium ? 1 : 0); }
      if (typeof sortOrder === 'number') { sets.push('sort_order = ?'); values.push(sortOrder); }
      if (!sets.length) return res.json({ ok: true });
      values.push(req.params.id);
      await db.run(`UPDATE plus_v2_badges SET ${sets.join(', ')} WHERE id = ?`, values);
      res.json({ ok: true });
    })
  );

  router.delete(
    '/admin/badges/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      await db.run('DELETE FROM plus_v2_badges WHERE id = ?', [req.params.id]);
      await db.run('UPDATE users SET plus2_badge_id = NULL WHERE plus2_badge_id = ?', [req.params.id]);
      res.json({ ok: true });
    })
  );

  // ---------------------------------------------------------------------
  // Admin — CRUD de pacotes de figurinha e das figurinhas dentro deles.
  // ---------------------------------------------------------------------
  router.post(
    '/admin/sticker-packs',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { key, name, premium, sortOrder } = req.body || {};
      if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Nome é obrigatório' });
      const id = newId();
      await db.run(
        'INSERT INTO plus_v2_sticker_packs (id, key, name, is_premium, sort_order) VALUES (?, ?, ?, ?, ?)',
        [id, key || null, name.trim(), premium ? 1 : 0, sortOrder || 0]
      );
      res.json({ ok: true, id });
    })
  );

  router.patch(
    '/admin/sticker-packs/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const existing = await db.get('SELECT * FROM plus_v2_sticker_packs WHERE id = ?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Pacote não encontrado' });
      const { name, premium, sortOrder } = req.body || {};
      const sets = [];
      const values = [];
      if (typeof name === 'string') { sets.push('name = ?'); values.push(name.trim()); }
      if (typeof premium === 'boolean') { sets.push('is_premium = ?'); values.push(premium ? 1 : 0); }
      if (typeof sortOrder === 'number') { sets.push('sort_order = ?'); values.push(sortOrder); }
      if (!sets.length) return res.json({ ok: true });
      values.push(req.params.id);
      await db.run(`UPDATE plus_v2_sticker_packs SET ${sets.join(', ')} WHERE id = ?`, values);
      res.json({ ok: true });
    })
  );

  router.delete(
    '/admin/sticker-packs/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      await db.run('DELETE FROM plus_v2_stickers WHERE pack_id = ?', [req.params.id]);
      await db.run('DELETE FROM plus_v2_sticker_packs WHERE id = ?', [req.params.id]);
      res.json({ ok: true });
    })
  );

  router.post(
    '/admin/sticker-packs/:packId/stickers',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const pack = await db.get('SELECT * FROM plus_v2_sticker_packs WHERE id = ?', [req.params.packId]);
      if (!pack) return res.status(404).json({ error: 'Pacote não encontrado' });
      const { type, content, sortOrder } = req.body || {};
      if (!STICKER_TYPES.has(type)) return res.status(400).json({ error: 'Tipo inválido (use emoji/image)' });
      if (!content || typeof content !== 'string') return res.status(400).json({ error: 'Conteúdo é obrigatório' });
      const id = newId();
      await db.run(
        'INSERT INTO plus_v2_stickers (id, pack_id, type, content, sort_order) VALUES (?, ?, ?, ?, ?)',
        [id, pack.id, type, content, sortOrder || 0]
      );
      res.json({ ok: true, id });
    })
  );

  router.delete(
    '/admin/stickers/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      await db.run('DELETE FROM plus_v2_stickers WHERE id = ?', [req.params.id]);
      res.json({ ok: true });
    })
  );

  return router;
}

module.exports = buildPlusV2Router;
