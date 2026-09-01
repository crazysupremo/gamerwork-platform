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
const BACKGROUND_TYPES = new Set(['solid', 'gradient', 'image', 'gif', 'effect']);
const STICKER_TYPES = new Set(['emoji', 'image']);
const HTTPS_URL_RE = /^https:\/\/\S+$/;
const BUBBLE_STYLES = new Set(['rounded', 'square', 'minimal']);
const COLOR_MODES = new Set(['per_user', 'theme', 'mono']);
const FONT_SIZES = new Set(['small', 'medium', 'large']);
const MENTION_EFFECTS = new Set(['none', 'highlight', 'shake', 'glow']);

function themeOut(t, unlocked) {
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
    premium: !!t.is_premium,
    preset: !!t.is_preset,
    custom: !t.is_preset,
    locked: !!t.is_premium && !unlocked,
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
  // Catálogo público (autenticado) — temas, badges e banners disponíveis,
  // já marcando `locked` de acordo com o plano da própria pessoa.
  // ---------------------------------------------------------------------
  router.get(
    '/catalog',
    requireAuth,
    asyncHandler(async (req, res) => {
      const unlocked = isPlusAccount(req.user);
      const themes = await db.all(
        'SELECT * FROM plus_v2_themes WHERE is_preset = 1 ORDER BY sort_order ASC'
      );
      const myCustomThemes = await db.all(
        'SELECT * FROM plus_v2_themes WHERE is_preset = 0 AND owner_user_id = ? ORDER BY created_at DESC',
        [req.user.id]
      );
      const badges = await db.all('SELECT * FROM plus_v2_badges ORDER BY sort_order ASC');
      const banners = await db.all('SELECT * FROM plus_v2_banners ORDER BY sort_order ASC');
      const backgrounds = await db.all('SELECT * FROM plus_v2_backgrounds ORDER BY sort_order ASC');

      res.json({
        isPlusUser: unlocked,
        themes: themes.map((t) => themeOut(t, unlocked)),
        myCustomThemes: myCustomThemes.map((t) => themeOut(t, unlocked)),
        badges: badges.map((b) => badgeOut(b, unlocked)),
        banners: banners.map((b) => bannerOut(b, unlocked)),
        backgrounds: backgrounds.map((b) => backgroundOut(b, unlocked)),
        current: {
          themeId: req.user.plus2_theme_id || null,
          bannerId: req.user.plus2_banner_id || null,
          badgeId: req.user.plus2_badge_id || null,
          backgroundId: req.user.plus2_background_id || null,
          customBannerUrl: req.user.plus2_custom_banner_url || null,
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
      const { id, name, primary, secondary, highlight, text, button, darkMode, effect } = req.body || {};
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
          `UPDATE plus_v2_themes SET name=?, primary_color=?, secondary_color=?, highlight_color=?, text_color=?, button_color=?, dark_mode=?, effect=?
           WHERE id = ?`,
          [cleanName, primary, secondary, highlight, text, button, darkMode ? 1 : 0, cleanEffect, id]
        );
        return res.json({ ok: true, id });
      }

      const newThemeId = newId();
      await db.run(
        `INSERT INTO plus_v2_themes
          (id, key, name, primary_color, secondary_color, highlight_color, text_color, button_color, dark_mode, effect, is_premium, is_preset, owner_user_id, sort_order)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0)`,
        [newThemeId, cleanName, primary, secondary, highlight, text, button, darkMode ? 1 : 0, cleanEffect, req.user.id]
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
          if (theme.is_premium && !unlocked) {
            return res.status(403).json({ error: 'Esse tema é exclusivo de quem tem NEXTGAME PLUS' });
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
          if (typeof url !== 'string' || url.length > 2048 || !HTTPS_URL_RE.test(url)) {
            return res.status(400).json({ error: 'URL de imagem inválida' });
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
          await db.run('UPDATE users SET plus2_background_id = ? WHERE id = ?', [backgroundId, req.user.id]);
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
      const { key, name, primary, secondary, highlight, text, button, darkMode, effect, premium, sortOrder } = req.body || {};
      const colors = { primary, secondary, highlight, text, button };
      for (const [k, v] of Object.entries(colors)) {
        if (typeof v !== 'string' || !HEX_COLOR_RE.test(v)) {
          return res.status(400).json({ error: `Cor inválida em "${k}"` });
        }
      }
      if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Nome é obrigatório' });
      const id = newId();
      await db.run(
        `INSERT INTO plus_v2_themes
          (id, key, name, primary_color, secondary_color, highlight_color, text_color, button_color, dark_mode, effect, is_premium, is_preset, owner_user_id, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)`,
        [id, key || null, name.trim(), primary, secondary, highlight, text, button, darkMode ? 1 : 0, EFFECTS.has(effect) ? effect : 'none', premium ? 1 : 0, sortOrder || 0]
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
