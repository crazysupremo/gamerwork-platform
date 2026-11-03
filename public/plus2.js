// ============================================================================
// PLUS-V2 — módulo de frontend (MÓDULO SEPARADO, ainda não linkado no app.js
// real). Fase 1: temas prontos, criador de tema personalizado e
// personalização de perfil (moldura/banner/badge).
//
// Desenhado pra já nascer "pronto pra integrar": toda a UI é montada por
// PlusV2.mount(containerEl, adapter) e não fala direto com fetch()/socket —
// quem decide de onde vêm os dados é o `adapter` passado por fora. Assim,
// esse mesmo arquivo serve tanto pro preview.html (adapter com dados mockados
// em memória) quanto pro site de verdade (adapter que chama /api/plus2/...),
// sem duplicar nenhuma lógica de UI.
//
// Uso no site de verdade, depois que a integração acontecer:
//   const adapter = PlusV2.createHttpAdapter({ fetch: window.fetch.bind(window) });
//   PlusV2.mount(document.getElementById('plus2-root'), adapter);
// ============================================================================

(function (global) {
  'use strict';

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        // undefined = "não define esse atributo" (ex: disabled: cond ? 'disabled' : undefined).
        // Sem esse skip, setAttribute('disabled', undefined) vira o texto "undefined",
        // e por HTML tratar QUALQUER valor do atributo disabled como desabilitado,
        // o elemento ficava sempre travado mesmo quando a intenção era liberar.
        if (v === undefined) continue;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      }
    }
    (children || []).forEach((c) => {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function applyMiniVars(node, theme) {
    node.style.setProperty('--pv2-mini-bg', theme.darkMode ? '#14151a' : '#f4f4f7');
    node.style.setProperty('--pv2-mini-text', theme.colors.text);
    node.style.setProperty('--pv2-mini-primary', theme.colors.primary);
    node.style.setProperty('--pv2-mini-secondary', theme.colors.secondary);
    node.style.setProperty('--pv2-mini-highlight', theme.colors.highlight);
    node.style.setProperty('--pv2-mini-button', theme.colors.button);
  }

  // Aplica um tema de verdade no site inteiro via CSS vars — é isso que, na
  // integração final, substitui as classes fixas --accent/--bg-app etc. do
  // style.css principal. Por enquanto só é usada dentro do live preview.
  function applyThemeVars(root, theme) {
    applyMiniVars(root, theme);
  }

  function effectClass(effect) {
    if (effect === 'shine') return 'pv2-effect-shine';
    if (effect === 'glow') return 'pv2-effect-glow';
    if (effect === 'pulse') return 'pv2-effect-pulse';
    return '';
  }

  // --------------------------------------------------------------------
  // Adapter mock — usado pelo preview.html standalone (sem servidor). Guarda
  // tudo em memória, simulando exatamente as mesmas respostas que a API real
  // (routes-plus2.js) vai devolver depois de integrada.
  // --------------------------------------------------------------------
  const FREE_EFFECT_KEYS = new Set(['buttonGlow', 'transitions', 'messageReceive', 'callJoin']);

  function createMockAdapter(seed) {
    const state = JSON.parse(JSON.stringify(seed));
    if (!state.visualPrefs) {
      state.visualPrefs = {
        background: { opacity: 100, blur: 0 },
        effects: { particles: false, buttonGlow: true, animatedGradients: false, messageReceive: true, callJoin: true, avatarGlow: false, transitions: true },
        performanceMode: false,
        chat: { bubbleStyle: 'rounded', showAvatars: true, colorMode: 'per_user', fontSize: 'medium', spacing: 16, showTimestamps: true, showReactions: true, mentionEffect: 'highlight' },
      };
    }
    if (!state.backgrounds) state.backgrounds = [];
    function delay(v) { return new Promise((r) => setTimeout(() => r(v), 120)); }
    return {
      async getCatalog() {
        return delay(JSON.parse(JSON.stringify(state)));
      },
      async saveMe({ themeId, bannerId, badgeId, backgroundId, customBannerUrl, customBackgroundUrl, customBackgroundType, visualPrefs }) {
        const unlocked = state.isPlusUser;
        if (themeId !== undefined) state.current.themeId = themeId;
        if (bannerId !== undefined) {
          state.current.bannerId = bannerId;
          if (bannerId !== null) state.current.customBannerUrl = null;
        }
        if (badgeId !== undefined) state.current.badgeId = badgeId;
        if (backgroundId !== undefined) {
          state.current.backgroundId = backgroundId;
          if (backgroundId !== null) state.current.customBackgroundUrl = null;
        }
        if (customBannerUrl !== undefined) {
          state.current.customBannerUrl = customBannerUrl;
          if (customBannerUrl !== null) state.current.bannerId = null;
        }
        if (customBackgroundUrl !== undefined) {
          state.current.customBackgroundUrl = customBackgroundUrl;
          if (customBackgroundUrl !== null) {
            state.current.backgroundId = null;
            state.current.customBackgroundType = customBackgroundType === 'gif' ? 'gif' : 'image';
          }
        }
        if (visualPrefs) {
          const current = state.visualPrefs;
          if (visualPrefs.background) {
            if (typeof visualPrefs.background.opacity === 'number') current.background.opacity = Math.max(0, Math.min(100, visualPrefs.background.opacity));
            if (typeof visualPrefs.background.blur === 'number') current.background.blur = Math.max(0, Math.min(100, visualPrefs.background.blur));
          }
          if (visualPrefs.effects) {
            for (const key of Object.keys(current.effects)) {
              if (typeof visualPrefs.effects[key] !== 'boolean') continue;
              if (!unlocked && !FREE_EFFECT_KEYS.has(key) && visualPrefs.effects[key]) continue;
              current.effects[key] = visualPrefs.effects[key];
            }
          }
          if (typeof visualPrefs.performanceMode === 'boolean') current.performanceMode = visualPrefs.performanceMode;
          if (visualPrefs.chat) {
            const c = visualPrefs.chat;
            if (c.bubbleStyle) current.chat.bubbleStyle = c.bubbleStyle;
            if (typeof c.showAvatars === 'boolean') current.chat.showAvatars = c.showAvatars;
            if (c.colorMode) current.chat.colorMode = (c.colorMode === 'per_user' && !unlocked) ? 'theme' : c.colorMode;
            if (c.fontSize) current.chat.fontSize = c.fontSize;
            if (typeof c.spacing === 'number') current.chat.spacing = Math.max(4, Math.min(32, c.spacing));
            if (typeof c.showTimestamps === 'boolean') current.chat.showTimestamps = c.showTimestamps;
            if (typeof c.showReactions === 'boolean') current.chat.showReactions = c.showReactions;
            if (c.mentionEffect) {
              const premiumOnly = c.mentionEffect === 'shake' || c.mentionEffect === 'glow';
              if (!premiumOnly || unlocked) current.chat.mentionEffect = c.mentionEffect;
            }
          }
        }
        return delay({ ok: true });
      },
      async saveCustomTheme(data) {
        const id = data.id || 'custom-' + Math.random().toString(36).slice(2, 9);
        const theme = {
          id, key: null, name: data.name, colors: { primary: data.primary, secondary: data.secondary, highlight: data.highlight, text: data.text, button: data.button },
          darkMode: data.darkMode, effect: data.effect, premium: false, preset: false, custom: true, locked: false,
        };
        const idx = state.myCustomThemes.findIndex((t) => t.id === id);
        if (idx >= 0) state.myCustomThemes[idx] = theme;
        else state.myCustomThemes.unshift(theme);
        return delay({ ok: true, id });
      },
      async deleteCustomTheme(id) {
        state.myCustomThemes = state.myCustomThemes.filter((t) => t.id !== id);
        if (state.current.themeId === id) state.current.themeId = null;
        return delay({ ok: true });
      },
      async getStickers() {
        return delay(JSON.parse(JSON.stringify({ isPlusUser: state.isPlusUser, packs: state.stickerPacks || [] })));
      },
      // Sem servidor de verdade aqui — lê o arquivo escolhido e devolve como
      // data URL, só pra já poder ver a própria imagem como banner na hora.
      // Na integração real, isso vira uma chamada pro /api/uploads/presign
      // que o site principal já tem (ver createHttpAdapter abaixo).
      async uploadBannerImage(file) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Não deu pra ler essa imagem'));
          reader.readAsDataURL(file);
        });
      },
      // Mesmo esquema do banner — no preview sem servidor, só lê o arquivo
      // como data URL (ver createHttpAdapter abaixo pro upload de verdade).
      async uploadBackgroundImage(file) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Não deu pra ler essa imagem'));
          reader.readAsDataURL(file);
        });
      },
      // Só pro preview: liga/desliga "sou PLUS" pra testar os dois lados.
      _setPlusUser(v) {
        state.isPlusUser = v;
        state.themes.forEach((t) => { t.locked = t.premium && !v; });
        state.badges.forEach((b) => { b.locked = b.premium && !v; });
        state.banners.forEach((b) => { b.locked = b.premium && !v; });
        state.backgrounds.forEach((bg) => { bg.locked = bg.premium && !v; });
        (state.stickerPacks || []).forEach((p) => { p.locked = p.premium && !v; });
      },
    };
  }

  // --------------------------------------------------------------------
  // Adapter real — fala com a API de verdade (só passa a funcionar quando
  // routes-plus2.js estiver montado no server.js principal).
  // --------------------------------------------------------------------
  function createHttpAdapter({ fetch: fetchFn, base }) {
    const root = base || '/api/plus2';
    async function req(path, opts) {
      const res = await fetchFn(root + path, {
        method: (opts && opts.method) || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
      });
      if (!res.ok) throw new Error('Erro na API plus2: ' + res.status);
      return res.json();
    }
    return {
      getCatalog: () => req('/catalog'),
      saveMe: (body) => req('/me', { method: 'PATCH', body }),
      saveCustomTheme: (body) => req('/themes/custom', { method: 'POST', body }),
      deleteCustomTheme: (id) => req('/themes/custom/' + id, { method: 'DELETE' }),
      getStickers: () => req('/stickers'),
      // Reaproveita o /api/uploads/presign que o site principal já usa pra
      // anexos de chat — sobe o arquivo direto pro storage (R2/S3) e devolve
      // a URL pública, sem passar o arquivo em si pela rota do plus2.
      async uploadBannerImage(file) {
        const presignRes = await fetchFn('/api/uploads/presign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
        });
        if (!presignRes.ok) throw new Error('Erro ao preparar upload: ' + presignRes.status);
        const presign = await presignRes.json();
        if (presign.configured) {
          const putRes = await fetchFn(presign.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
          if (!putRes.ok) throw new Error('Erro ao enviar a imagem: ' + putRes.status);
          return presign.publicUrl;
        }
        // CORRIGIDO — antes, sem storage externo (R2) configurado no
        // servidor, isso sempre falhava com "Upload de imagem não está
        // configurado" e não tinha jeito de colocar uma foto no banner de
        // jeito nenhum. Agora, se a imagem for pequena o bastante, guarda
        // ela embutida direto no banco (mesmo esquema já usado pro avatar
        // no cadastro) — funciona sem precisar configurar storage externo.
        const MAX_INLINE_FILE_BYTES = 250 * 1024; // ~250KB de arquivo -> cabe no limite do banco em base64
        if (file.size > MAX_INLINE_FILE_BYTES) {
          throw new Error(
            'Upload de imagem externo não está configurado no servidor, e essa imagem é grande demais pra guardar direto (máx. ~250KB). Tente uma imagem menor ou mais comprimida.'
          );
        }
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Não deu pra ler essa imagem'));
          reader.readAsDataURL(file);
        });
      },
      // Fundo com imagem/GIF próprio — mesmo caminho do banner (presign R2
      // com fallback embutido no banco quando não tem storage externo
      // configurado). Corrige "imagem/GIF não funciona" no painel de fundo.
      async uploadBackgroundImage(file) {
        const presignRes = await fetchFn('/api/uploads/presign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
        });
        if (!presignRes.ok) throw new Error('Erro ao preparar upload: ' + presignRes.status);
        const presign = await presignRes.json();
        if (presign.configured) {
          const putRes = await fetchFn(presign.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
          if (!putRes.ok) throw new Error('Erro ao enviar o arquivo: ' + putRes.status);
          return presign.publicUrl;
        }
        const MAX_INLINE_FILE_BYTES = 250 * 1024;
        if (file.size > MAX_INLINE_FILE_BYTES) {
          throw new Error(
            'Upload externo não está configurado no servidor, e esse arquivo é grande demais pra guardar direto (máx. ~250KB). Tente uma imagem/GIF menor ou mais comprimida.'
          );
        }
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Não deu pra ler esse arquivo'));
          reader.readAsDataURL(file);
        });
      },
    };
  }

  // --------------------------------------------------------------------
  // Montagem principal
  // --------------------------------------------------------------------
  async function mount(container, adapter, opts) {
    opts = opts || {};
    container.classList.add('pv2-root');
    container.innerHTML = '<p style="color:#9aa0ab;font-size:13px;">Carregando personalização…</p>';

    let data = await adapter.getCatalog();

    // Toda mudança salva (tema, fundo, efeito, chat, badge, banner) dispara
    // opts.onChange — é assim que o site de verdade sabe a hora de reaplicar
    // tudo na página real (ver mountPlusV2Personalization()/applyPlusV2Live()
    // em app.js e plus2-live.js). No preview isolado, sem esse callback, não
    // muda nada — só afeta quem realmente passar onChange.
    async function saveMe(payload) {
      const result = await adapter.saveMe(payload);
      if (opts.onChange) opts.onChange(payload);
      return result;
    }

    const tabs = [
      { key: 'themes', label: 'Temas' },
      { key: 'creator', label: 'Criar tema' },
      { key: 'backgrounds', label: 'Fundos' },
      { key: 'effects', label: 'Efeitos' },
      { key: 'chat', label: 'Chat' },
      { key: 'stickers', label: 'Figurinhas' },
      { key: 'profile', label: 'Perfil' },
    ];
    let activeTab = opts.initialTab || 'themes';

    container.innerHTML = '';
    const tabsBar = el('div', { class: 'pv2-tabs' });
    const panels = {};
    tabs.forEach((t) => {
      const btn = el('button', {
        class: 'pv2-tab' + (t.key === activeTab ? ' active' : ''),
        type: 'button',
        onclick: () => setActiveTab(t.key),
      }, [t.label]);
      btn.dataset.tabKey = t.key;
      tabsBar.appendChild(btn);
    });
    container.appendChild(tabsBar);

    const panelThemes = el('div', { class: 'pv2-panel' + (activeTab === 'themes' ? ' active' : '') });
    const panelCreator = el('div', { class: 'pv2-panel' + (activeTab === 'creator' ? ' active' : '') });
    const panelBackgrounds = el('div', { class: 'pv2-panel' + (activeTab === 'backgrounds' ? ' active' : '') });
    const panelEffects = el('div', { class: 'pv2-panel' + (activeTab === 'effects' ? ' active' : '') });
    const panelChat = el('div', { class: 'pv2-panel' + (activeTab === 'chat' ? ' active' : '') });
    const panelStickers = el('div', { class: 'pv2-panel' + (activeTab === 'stickers' ? ' active' : '') });
    const panelProfile = el('div', { class: 'pv2-panel' + (activeTab === 'profile' ? ' active' : '') });
    panels.themes = panelThemes; panels.creator = panelCreator; panels.backgrounds = panelBackgrounds;
    panels.effects = panelEffects; panels.chat = panelChat; panels.stickers = panelStickers; panels.profile = panelProfile;
    container.appendChild(panelThemes);
    container.appendChild(panelCreator);
    container.appendChild(panelBackgrounds);
    container.appendChild(panelEffects);
    container.appendChild(panelChat);
    container.appendChild(panelStickers);
    container.appendChild(panelProfile);

    let stickersData = null;
    function setActiveTab(key) {
      activeTab = key;
      tabsBar.querySelectorAll('.pv2-tab').forEach((b) => b.classList.toggle('active', b.dataset.tabKey === key));
      Object.entries(panels).forEach(([k, node]) => node.classList.toggle('active', k === key));
      if (key === 'stickers' && !stickersData) loadStickers();
    }

    async function loadStickers() {
      panelStickers.innerHTML = '<p style="color:#9aa0ab;font-size:13px;">Carregando figurinhas…</p>';
      stickersData = await adapter.getStickers();
      renderStickersPanel();
    }

    async function refresh() {
      data = await adapter.getCatalog();
      renderThemesPanel();
      renderCreatorPanel();
      renderBackgroundsPanel();
      renderEffectsPanel();
      renderChatPanel();
      renderProfilePanel();
      if (stickersData) { stickersData = await adapter.getStickers(); renderStickersPanel(); }
    }

    // ---------------- ABA: temas prontos (v0.84.0 — galeria repaginada) ----------------
    // Busca por nome, filtro por categoria, "Ver ao vivo" (aplica no site de
    // verdade sem salvar) e importar/exportar tema em JSON.
    const CATEGORY_LABELS = {
      essenciais: 'Essenciais', gamer: 'Gamer', espaco: 'Espaço', luxo: 'Luxo',
      natureza: 'Natureza', sazonal: 'Sazonais', parceiros: 'Parceiros', meus: 'Meus temas',
    };
    const CATEGORY_ORDER = ['essenciais', 'gamer', 'espaco', 'luxo', 'natureza', 'sazonal', 'parceiros', 'meus'];
    const FONT_LABELS = { '': 'Padrão', modern: 'Moderna', tech: 'Tech', retro: 'Retrô', elegant: 'Elegante', soft: 'Suave' };
    const SCENE_LABELS = {
      none: 'Sem fundo animado', aurora: 'Aurora', grid: 'Grade neon', waves: 'Ondas',
      stars: 'Estrelas', embers: 'Brasas', matrix: 'Chuva de código', petals: 'Pétalas', snow: 'Neve',
    };
    const galleryState = { search: '', category: 'todos', ieOpen: false };
    let previewingTheme = null;
    let previewBar = null;

    function themeToShareJson(theme) {
      return JSON.stringify({
        nextgameTheme: 1,
        name: theme.name,
        colors: theme.colors,
        darkMode: theme.darkMode !== false,
        effect: theme.effect || 'none',
        font: theme.font || '',
        scene: theme.scene || 'none',
      });
    }

    function parseSharedTheme(text) {
      let obj;
      try { obj = JSON.parse(String(text).trim()); } catch (_) { throw new Error('Esse código não é um JSON válido.'); }
      if (!obj || obj.nextgameTheme !== 1 || !obj.colors) throw new Error('Esse JSON não é um tema do NEXT GAME.');
      const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
      for (const k of ['primary', 'secondary', 'highlight', 'text', 'button']) {
        if (!hex.test(obj.colors[k] || '')) throw new Error('Cor inválida no tema: ' + k);
      }
      return {
        name: String(obj.name || 'Tema importado').slice(0, 40),
        primary: obj.colors.primary, secondary: obj.colors.secondary, highlight: obj.colors.highlight,
        text: obj.colors.text, button: obj.colors.button,
        darkMode: obj.darkMode !== false,
        effect: ['none', 'shine', 'glow', 'pulse'].includes(obj.effect) ? obj.effect : 'none',
        font: Object.prototype.hasOwnProperty.call(FONT_LABELS, obj.font) ? obj.font : '',
        scene: Object.prototype.hasOwnProperty.call(SCENE_LABELS, obj.scene) ? obj.scene : 'none',
      };
    }

    function overlayAncestor() {
      let n = container.parentElement;
      while (n && n !== document.body) {
        if (getComputedStyle(n).position === 'fixed') return n;
        n = n.parentElement;
      }
      return null;
    }

    function startPreview(theme) {
      if (!global.PlusV2Live || !global.PlusV2Live.previewTheme) return;
      previewingTheme = theme;
      global.PlusV2Live.previewTheme(theme);
      const overlay = overlayAncestor();
      if (overlay) overlay.classList.add('pv2-hide-for-preview');
      if (previewBar) previewBar.remove();
      previewBar = el('div', { class: 'pv2-preview-bar' }, [
        el('span', {}, ['👁 Vendo ao vivo: ' + theme.name]),
        theme.key === 'custom-draft' ? null : el('button', {
          type: 'button', class: 'pv2-card-btn primary',
          style: `--pv2-mini-primary:${theme.colors.primary};--pv2-mini-secondary:${theme.colors.secondary};`,
          onclick: async () => { const t = previewingTheme; endPreview(!!t.locked); await selectTheme(t); },
        }, [theme.locked ? '🔒 PLUS' : 'Aplicar']),
        el('button', { type: 'button', class: 'pv2-card-btn', onclick: () => endPreview(true) }, [theme.key === 'custom-draft' ? 'Voltar ao criador' : 'Cancelar']),
      ]);
      document.body.appendChild(previewBar);
    }

    function endPreview(restore) {
      if (previewBar) { previewBar.remove(); previewBar = null; }
      const overlay = overlayAncestor() || document.querySelector('.pv2-hide-for-preview');
      if (overlay) overlay.classList.remove('pv2-hide-for-preview');
      document.querySelectorAll('.pv2-hide-for-preview').forEach((n) => n.classList.remove('pv2-hide-for-preview'));
      if (restore && global.PlusV2Live && global.PlusV2Live.cancelPreview) global.PlusV2Live.cancelPreview();
      previewingTheme = null;
    }

    function renderThemesPanel() {
      panelThemes.innerHTML = '';
      panelThemes.appendChild(el('div', { class: 'pv2-section-title' }, ['Temas']));
      panelThemes.appendChild(el('p', { class: 'pv2-section-hint' }, [
        'Cada tema traz cores, fonte e fundo animado próprios. Use "Ver ao vivo" para testar no site inteiro antes de aplicar. Os marcados com 🔒 são exclusivos de quem tem NEXTGAME PLUS.',
      ]));

      const allThemes = [...data.themes, ...data.myCustomThemes];
      const catOf = (t) => (t.custom ? 'meus' : (t.category || 'essenciais'));
      const counts = { todos: allThemes.length };
      allThemes.forEach((t) => { const c = catOf(t); counts[c] = (counts[c] || 0) + 1; });

      // ---- toolbar: busca + importar/exportar + chips de categoria ----
      const searchInput = el('input', { class: 'pv2-search', type: 'search', placeholder: '🔎 Buscar tema…', value: galleryState.search });
      const toolbar = el('div', { class: 'pv2-gal-toolbar' });
      const top = el('div', { class: 'pv2-gal-top' }, [
        searchInput,
        el('button', {
          type: 'button', class: 'pv2-ghost-btn',
          onclick: () => { galleryState.ieOpen = !galleryState.ieOpen; ieBox.classList.toggle('open', galleryState.ieOpen); },
        }, ['⇄ Importar / Exportar']),
      ]);
      const chips = el('div', { class: 'pv2-chips' });
      [['todos', 'Todos'], ...CATEGORY_ORDER.filter((c) => counts[c]).map((c) => [c, CATEGORY_LABELS[c]])].forEach(([key, label]) => {
        chips.appendChild(el('button', {
          type: 'button', class: 'pv2-chip' + (galleryState.category === key ? ' active' : ''),
          onclick: () => { galleryState.category = key; renderThemesPanel(); },
        }, [label, el('span', { class: 'pv2-chip-n' }, [String(counts[key] || 0)])]));
      });

      // ---- caixa de importar/exportar ----
      const ieText = el('textarea', { placeholder: 'Cole aqui o código de um tema para importar, ou clique em "Copiar tema atual" para compartilhar o seu.' });
      const ieMsg = el('span', { class: 'pv2-ie-msg' });
      const currentTheme = allThemes.find((t) => t.id === data.current.themeId);
      const ieBox = el('div', { class: 'pv2-ie-box' + (galleryState.ieOpen ? ' open' : '') }, [
        ieText,
        el('div', { class: 'pv2-ie-row' }, [
          el('button', {
            type: 'button', class: 'pv2-ghost-btn',
            onclick: async () => {
              if (!currentTheme) return;
              const json = themeToShareJson(currentTheme);
              ieText.value = json;
              try { await navigator.clipboard.writeText(json); ieMsg.className = 'pv2-ie-msg'; ieMsg.textContent = 'Código do tema "' + currentTheme.name + '" copiado ✓'; }
              catch (_) { ieText.select(); ieMsg.className = 'pv2-ie-msg'; ieMsg.textContent = 'Selecione e copie o código acima.'; }
            },
          }, ['Copiar tema atual']),
          el('button', {
            type: 'button', class: 'pv2-ghost-btn',
            disabled: data.isPlusUser ? undefined : 'disabled',
            onclick: async () => {
              try {
                const draftTheme = parseSharedTheme(ieText.value);
                await adapter.saveCustomTheme(draftTheme);
                ieMsg.className = 'pv2-ie-msg'; ieMsg.textContent = 'Tema "' + draftTheme.name + '" importado ✓';
                galleryState.category = 'meus';
                await refresh();
              } catch (err) { ieMsg.className = 'pv2-ie-msg err'; ieMsg.textContent = err.message || 'Erro ao importar.'; }
            },
          }, ['Importar como meu tema']),
          data.isPlusUser ? null : el('span', { class: 'pv2-ie-msg' }, ['🔒 Importar é exclusivo do NEXTGAME PLUS']),
          ieMsg,
        ]),
      ]);

      toolbar.appendChild(top);
      toolbar.appendChild(chips);
      panelThemes.appendChild(toolbar);
      panelThemes.appendChild(ieBox);

      // ---- grade ----
      const grid = el('div', { class: 'pv2-theme-grid' });
      panelThemes.appendChild(grid);
      function paintGrid() {
        grid.innerHTML = '';
        const q = galleryState.search.trim().toLowerCase();
        const list = allThemes.filter((t) => {
          if (galleryState.category !== 'todos' && catOf(t) !== galleryState.category) return false;
          if (!q) return true;
          return (t.name + ' ' + (t.tagline || '') + ' ' + (CATEGORY_LABELS[catOf(t)] || '') + ' ' + (SCENE_LABELS[t.scene] || '')).toLowerCase().includes(q);
        });
        if (!list.length) {
          grid.appendChild(el('div', { class: 'pv2-gal-empty', style: 'grid-column:1/-1;' }, ['Nenhum tema encontrado.']));
          return;
        }
        list.forEach((theme) => grid.appendChild(buildThemeCard(theme)));
      }
      searchInput.addEventListener('input', () => { galleryState.search = searchInput.value; paintGrid(); });
      paintGrid();
    }

    function buildThemeCard(theme) {
      const selected = data.current.themeId === theme.id;
      // Prévia em miniatura: mini-interface (servidores, topo, chat, input)
      // pintada com a paleta do tema, sobre um brilho com as cores dele.
      const mini = el('div', { class: 'pv2-theme-mini ' + effectClass(theme.effect) }, [
        el('div', { class: 'pv2-theme-mini-body' }, [
          el('div', { class: 'pv2-theme-mini-side' }, [
            el('div', { class: 'pv2-theme-mini-server' }),
            el('div', { class: 'pv2-theme-mini-server active' }),
            el('div', { class: 'pv2-theme-mini-server' }),
          ]),
          el('div', { class: 'pv2-theme-mini-main' }, [
            el('div', { class: 'pv2-theme-mini-topbar' }),
            el('div', { class: 'pv2-theme-mini-chat' }, [
              el('div', { class: 'pv2-theme-mini-bubble other' }),
              el('div', { class: 'pv2-theme-mini-bubble mine' }),
            ]),
            el('div', { class: 'pv2-theme-mini-input' }),
          ]),
        ]),
      ]);
      applyMiniVars(mini, theme);

      const metaTags = [];
      if (theme.scene && theme.scene !== 'none') metaTags.push('🎬 ' + (SCENE_LABELS[theme.scene] || theme.scene));
      if (theme.font) metaTags.push('Aa ' + (FONT_LABELS[theme.font] || theme.font));
      if (theme.suggestedEffects && theme.suggestedEffects.length) metaTags.push('✨ ' + theme.suggestedEffects.length + ' efeitos');

      const card = el('div', {
        class: 'pv2-theme-card' + (selected ? ' selected' : '') + (theme.locked ? ' locked' : ''),
      }, [
        mini,
        el('div', { class: 'pv2-theme-name' }, [
          el('div', { class: 'pv2-theme-name-row' }, [
            theme.name,
            theme.premium ? el('span', { class: 'pv2-premium-pill' }, ['PLUS']) : null,
            selected ? el('span', { class: 'pv2-meta-tag' }, ['em uso']) : null,
          ]),
          theme.tagline ? el('div', { class: 'pv2-theme-tagline' }, [theme.tagline]) : null,
          metaTags.length ? el('div', { class: 'pv2-theme-meta' }, metaTags.map((m) => el('span', { class: 'pv2-meta-tag' }, [m]))) : null,
        ]),
        el('div', { class: 'pv2-theme-actions' }, [
          el('button', { type: 'button', class: 'pv2-card-btn', onclick: (e) => { e.stopPropagation(); startPreview(theme); } }, ['👁 Ver ao vivo']),
          el('button', {
            type: 'button', class: 'pv2-card-btn primary',
            onclick: (e) => { e.stopPropagation(); selectTheme(theme); },
          }, [selected ? '✓ Em uso' : (theme.locked ? '🔒' : 'Aplicar')]),
        ]),
      ]);
      // CSS var só desce pra filho — o brilho do hover/seleção e os botões do
      // card leem estas variáveis do próprio card.
      card.style.setProperty('--pv2-mini-primary', theme.colors.primary);
      card.style.setProperty('--pv2-mini-secondary', theme.colors.secondary);
      card.addEventListener('click', () => startPreview(theme));
      if (theme.comingSoon) {
        const d = theme.releaseAt ? new Date(theme.releaseAt) : null;
        const formatted = d && !Number.isNaN(d.getTime())
          ? d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
          : null;
        card.appendChild(el('div', { class: 'pv2-lock-badge pv2-lock-badge-soon' }, [formatted ? ('⏳ em ' + formatted) : '⏳ em breve']));
      } else if (theme.locked) {
        card.appendChild(el('div', { class: 'pv2-lock-badge' }, ['🔒 PLUS']));
      }
      return card;
    }

    async function selectTheme(theme) {
      if (previewingTheme) endPreview(false);
      if (theme.locked) {
        if (opts.onLockedClick) opts.onLockedClick('theme', theme);
        return;
      }
      data.current.themeId = theme.id;
      renderThemesPanel();
      await saveMe({ themeId: theme.id });
      await applyThemeSuggestedEffects(theme);
      if (opts.onThemeApplied) opts.onThemeApplied(theme);
    }

    // Liga sozinho os efeitos que esse tema recomenda (pedido: "temas mais
    // interativos", em vez da pessoa escolher o tema e ainda ter que ir na
    // aba Efeitos ligar cada coisa na mão). Duas travas importantes:
    // 1) só liga quem ainda está DESLIGADO — nunca desliga nada que a pessoa
    //    já tinha ajustado do jeito dela;
    // 2) um efeito que é exclusivo PLUS só liga sozinho se a conta for PLUS
    //    de verdade — senão ficaria "ligado" no banco mas sem aparecer pra
    //    quem não pode usar, dando a entender que tem algo quebrado.
    async function applyThemeSuggestedEffects(theme) {
      const suggested = Array.isArray(theme.suggestedEffects) ? theme.suggestedEffects : [];
      if (!suggested.length) return;
      const toEnable = suggested.filter((key) => {
        if (data.visualPrefs.effects[key]) return false;
        const def = EFFECT_DEFS.find((d) => d.key === key);
        if (!def) return false;
        if (!def.free && !data.isPlusUser) return false;
        return true;
      });
      if (!toEnable.length) return;
      const patch = {};
      toEnable.forEach((key) => { data.visualPrefs.effects[key] = true; patch[key] = true; });
      await saveMe({ visualPrefs: { effects: patch } });
      if (opts.onEffectsAutoApplied) {
        const labels = toEnable.map((key) => (EFFECT_DEFS.find((d) => d.key === key) || {}).label || key);
        opts.onEffectsAutoApplied(labels);
      }
    }

    // ---------------- ABA: criar tema ----------------
    function renderCreatorPanel() {
      panelCreator.innerHTML = '';
      panelCreator.appendChild(el('div', { class: 'pv2-section-title' }, ['Criar tema personalizado']));
      panelCreator.appendChild(el('p', { class: 'pv2-section-hint' }, [
        'Escolha cada cor do seu jeito e veja a prévia mudar em tempo real ao lado.',
      ]));

      if (!data.isPlusUser) {
        panelCreator.appendChild(el('div', { class: 'pv2-locked-note' }, [
          '🔒 Criar um tema personalizado com cores ilimitadas é exclusivo de quem tem NEXTGAME PLUS. Você ainda pode usar qualquer um dos temas prontos gratuitos na aba anterior.',
        ]));
      }

      const draft = {
        name: 'Meu tema',
        primary: '#00ff9d', secondary: '#00e5ff', highlight: '#00d4ff', text: '#e6e6e6', button: '#1e1e2f',
        darkMode: true, effect: 'none', font: '', scene: 'none',
      };

      const layout = el('div', { class: 'pv2-creator-layout' });
      const controls = el('div', { class: 'pv2-creator-controls' });
      const previewWrap = el('div', { class: 'pv2-preview-wrap' });

      const nameInput = el('input', {
        class: 'pv2-name-input', type: 'text', value: draft.name, placeholder: 'Nome do tema',
        disabled: data.isPlusUser ? undefined : 'disabled',
      });
      nameInput.addEventListener('input', () => { draft.name = nameInput.value; });
      controls.appendChild(nameInput);

      const colorFields = [
        ['primary', 'Cor primária'], ['secondary', 'Cor secundária'], ['highlight', 'Cor de destaque'],
        ['text', 'Cor dos textos'], ['button', 'Cor dos botões'],
      ];
      const frame = buildPreviewFrame();
      // Guarda a função update() de cada campo de cor, indexada pela chave —
      // é o que deixa os presets/aleatorizar abaixo preencherem as 5 cores
      // de uma vez só (inclusive atualizando o color picker + campo de texto
      // de cada uma), sem duplicar a lógica de validação/preview.
      const fieldUpdaters = {};
      colorFields.forEach(([key, label]) => {
        const colorPicker = el('input', { type: 'color', value: draft[key], disabled: data.isPlusUser ? undefined : 'disabled' });
        const textInput = el('input', { type: 'text', value: draft[key], disabled: data.isPlusUser ? undefined : 'disabled' });
        function update(v) {
          draft[key] = v;
          colorPicker.value = v;
          textInput.value = v;
          updatePreview();
        }
        fieldUpdaters[key] = update;
        colorPicker.addEventListener('input', () => update(colorPicker.value));
        textInput.addEventListener('change', () => {
          if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(textInput.value)) update(textInput.value);
          else textInput.value = draft[key];
        });
        controls.appendChild(el('div', { class: 'pv2-color-row' }, [
          el('label', {}, [label]),
          el('div', { class: 'pv2-color-input-wrap' }, [colorPicker, textInput]),
        ]));
      });

      // Pedido: "criador de tema mais poderoso" — presets de paleta (combos
      // já testados e harmoniosos, um clique aplica as 5 cores de uma vez) e
      // um botão de aleatorizar (gera uma paleta nova, sempre com bom
      // contraste, pra quem não sabe por onde começar ou só quer inspiração).
      const PALETTE_PRESETS = [
        { name: 'Esmeralda', primary: '#0f9b6e', secondary: '#0a3d2e', highlight: '#d4af37', text: '#eafff5', button: '#07211a' },
        { name: 'Vaporwave', primary: '#ff6ec7', secondary: '#7b2ff7', highlight: '#01cdfe', text: '#fdf0ff', button: '#1a0b2e' },
        { name: 'Platina', primary: '#5b6b7d', secondary: '#c7cdd6', highlight: '#5ec8ff', text: '#f3f6f9', button: '#1b2228' },
        { name: 'Fantasma', primary: '#e21818', secondary: '#1a1a1a', highlight: '#ff5757', text: '#fff0f0', button: '#0c0c0c' },
        { name: 'Oceano', primary: '#0e4d92', secondary: '#00b8d9', highlight: '#7fe7ff', text: '#e6f7ff', button: '#08283f' },
        { name: 'Pôr do sol', primary: '#8e44ad', secondary: '#ff7e33', highlight: '#ff6fa3', text: '#fff0f5', button: '#2b1a2e' },
      ];
      function applyPalette(p) {
        fieldUpdaters.primary(p.primary);
        fieldUpdaters.secondary(p.secondary);
        fieldUpdaters.highlight(p.highlight);
        fieldUpdaters.text(p.text);
        fieldUpdaters.button(p.button);
      }
      const presetsRow = el('div', { class: 'pv2-presets-row' });
      PALETTE_PRESETS.forEach((p) => {
        const swatch = el('button', {
          type: 'button', class: 'pv2-preset-swatch', title: p.name,
          disabled: data.isPlusUser ? undefined : 'disabled',
          style: `background:linear-gradient(135deg, ${p.primary}, ${p.secondary} 60%, ${p.highlight});`,
          onclick: () => applyPalette(p),
        });
        presetsRow.appendChild(swatch);
      });
      controls.appendChild(el('label', { style: 'font-size:12.5px;font-weight:600;color:#cfd2d8;margin-top:4px;' }, ['Presets rápidos']));
      controls.appendChild(presetsRow);

      // Aleatoriza por matiz (HSL) em vez de RGB puro — gira um matiz
      // aleatório e deriva secundária/destaque dele com saturação/luz
      // diferentes, então a combinação sempre fica harmoniosa (nunca duas
      // cores "brigando" sem nenhuma relação entre si, que é o problema
      // comum de sortear RGB totalmente solto).
      function hslToHexLocal(h, s, l) {
        s /= 100; l /= 100;
        const k = (n) => (n + h / 30) % 12;
        const a = s * Math.min(l, 1 - l);
        const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
        const toHex = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
        return '#' + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
      }
      function randomizePalette() {
        const baseHue = Math.floor(Math.random() * 360);
        const dark = draft.darkMode;
        applyPalette({
          primary: hslToHexLocal(baseHue, 70, 55),
          secondary: hslToHexLocal((baseHue + 40) % 360, 65, 50),
          highlight: hslToHexLocal((baseHue + 200) % 360, 85, 65),
          text: dark ? '#eef0f5' : '#1a1b20',
          button: dark ? hslToHexLocal(baseHue, 35, 12) : hslToHexLocal(baseHue, 20, 92),
        });
      }
      const randomizeBtn = el('button', {
        type: 'button', class: 'pv2-randomize-btn', disabled: data.isPlusUser ? undefined : 'disabled',
        onclick: randomizePalette,
      }, ['🎲 Aleatorizar cores']);
      controls.appendChild(randomizeBtn);

      const effectSelect = el('select', { class: 'pv2-effect-select', disabled: data.isPlusUser ? undefined : 'disabled' }, [
        el('option', { value: 'none' }, ['Sem efeito']),
        el('option', { value: 'shine' }, ['Brilho (shine)']),
        el('option', { value: 'glow' }, ['Glow pulsante']),
        el('option', { value: 'pulse' }, ['Pulso']),
      ]);
      effectSelect.value = draft.effect;
      effectSelect.addEventListener('change', () => { draft.effect = effectSelect.value; updatePreview(); });
      controls.appendChild(el('label', { style: 'font-size:12.5px;font-weight:600;color:#cfd2d8;' }, ['Efeito visual']));
      controls.appendChild(effectSelect);

      const fontSelect = el('select', { class: 'pv2-effect-select', disabled: data.isPlusUser ? undefined : 'disabled' },
        Object.entries(FONT_LABELS).map(([v, l]) => el('option', { value: v }, [l])));
      fontSelect.value = draft.font;
      fontSelect.addEventListener('change', () => { draft.font = fontSelect.value; updatePreview(); });
      controls.appendChild(el('label', { class: 'pv2-lbl' }, ['Fonte do tema']));
      controls.appendChild(fontSelect);

      const sceneSelect = el('select', { class: 'pv2-effect-select', disabled: data.isPlusUser ? undefined : 'disabled' },
        Object.entries(SCENE_LABELS).map(([v, l]) => el('option', { value: v }, [l])));
      sceneSelect.value = draft.scene;
      sceneSelect.addEventListener('change', () => { draft.scene = sceneSelect.value; updatePreview(); });
      controls.appendChild(el('label', { class: 'pv2-lbl' }, ['Fundo animado']));
      controls.appendChild(sceneSelect);

      const liveBtn = el('button', {
        type: 'button', class: 'pv2-ghost-btn', style: 'margin-top:10px;',
        onclick: () => startPreview({
          key: 'custom-draft', name: draft.name || 'Meu tema', custom: true, locked: !data.isPlusUser,
          colors: { primary: draft.primary, secondary: draft.secondary, highlight: draft.highlight, text: draft.text, button: draft.button },
          darkMode: draft.darkMode, effect: draft.effect, font: draft.font, scene: draft.scene,
        }),
      }, ['👁 Ver no site inteiro']);
      controls.appendChild(liveBtn);

      const darkToggleLabel = el('label', { class: 'pv2-toggle-row' }, [
        el('span', { style: 'font-size:12.5px;font-weight:600;color:#cfd2d8;' }, ['Modo escuro']),
      ]);
      const darkToggle = el('input', { type: 'checkbox', disabled: data.isPlusUser ? undefined : 'disabled' });
      darkToggle.checked = draft.darkMode;
      darkToggle.addEventListener('change', () => { draft.darkMode = darkToggle.checked; updatePreview(); });
      darkToggleLabel.appendChild(darkToggle);
      controls.appendChild(darkToggleLabel);

      const saveBtn = el('button', {
        class: 'pv2-save-btn', type: 'button', disabled: data.isPlusUser ? undefined : 'disabled',
        onclick: async () => {
          saveBtn.disabled = true;
          saveBtn.textContent = 'Salvando…';
          await adapter.saveCustomTheme(draft);
          await refresh();
          saveBtn.disabled = false;
          saveBtn.textContent = 'Salvar tema';
          setActiveTab('themes');
        },
      }, ['Salvar tema']);
      controls.appendChild(saveBtn);

      function updatePreview() {
        let sceneEl = frame.root.querySelector('.pv2-preview-scene');
        if (!sceneEl) { sceneEl = el('div', { class: 'pv2-preview-scene' }); frame.root.insertBefore(sceneEl, frame.root.firstChild); }
        sceneEl.style.background = draft.scene === 'none'
          ? 'none'
          : `radial-gradient(circle at 20% 10%, ${draft.primary}66, transparent 55%), radial-gradient(circle at 90% 90%, ${draft.secondary}55, transparent 55%), radial-gradient(circle at 60% 40%, ${draft.highlight}22, transparent 50%)`;
        frame.mini.className = 'pv2-theme-mini ' + effectClass(draft.effect);
        applyThemeVars(frame.root, {
          colors: { primary: draft.primary, secondary: draft.secondary, highlight: draft.highlight, text: draft.text, button: draft.button },
          darkMode: draft.darkMode,
        });
      }

      previewWrap.appendChild(frame.root);
      layout.appendChild(controls);
      layout.appendChild(previewWrap);
      panelCreator.appendChild(layout);
      updatePreview();
    }

    function buildPreviewFrame() {
      const topbar = el('div', { class: 'pv2-preview-topbar' }, [el('div', { class: 'pv2-dot' }), 'NEXT GAME']);
      const rail = el('div', { class: 'pv2-preview-rail' }, [
        el('div', { class: 'pv2-preview-rail-dot' }), el('div', { class: 'pv2-preview-rail-dot' }), el('div', { class: 'pv2-preview-rail-dot' }),
      ]);
      const sidebar = el('div', { class: 'pv2-preview-sidebar' }, [
        el('div', { class: 'pv2-preview-sidebar-item active' }),
        el('div', { class: 'pv2-preview-sidebar-item' }),
        el('div', { class: 'pv2-preview-sidebar-item' }),
        el('div', { class: 'pv2-preview-sidebar-item' }),
      ]);
      const chat = el('div', { class: 'pv2-preview-chat' }, [
        el('div', { class: 'pv2-preview-bubble' }, ['E aí, bora jogar hoje?']),
        el('div', { class: 'pv2-preview-bubble own' }, ['Bora sim! 🔥']),
        el('div', { class: 'pv2-preview-btn' }, ['Enviar']),
      ]);
      const body = el('div', { class: 'pv2-preview-body' }, [rail, sidebar, chat]);
      const root = el('div', { class: 'pv2-preview-frame' }, [topbar, body]);
      return { root, mini: root };
    }

    // ---------------- ABA: perfil ----------------
    let profileSubTab = 'banner';
    function renderProfilePanel() {
      panelProfile.innerHTML = '';
      panelProfile.appendChild(el('div', { class: 'pv2-section-title' }, ['Personalização de perfil']));
      panelProfile.appendChild(el('p', { class: 'pv2-section-hint' }, ['Deixe seu perfil com a sua cara: banner (sua própria imagem ou um da galeria) e badge ao lado do nome — além da sua foto de perfil normal.']));

      const layout = el('div', { class: 'pv2-profile-layout' });
      const tabsCol = el('div', { class: 'pv2-profile-tabs' });
      const content = el('div', { class: 'pv2-profile-content' });

      const subTabs = [
        ['banner', '🖼️ Banner'],
        ['badge', '🎖️ Badge'],
      ];
      subTabs.forEach(([key, label]) => {
        tabsCol.appendChild(el('button', {
          class: 'pv2-profile-tab' + (profileSubTab === key ? ' active' : ''),
          type: 'button',
          onclick: () => { profileSubTab = key; renderProfilePanel(); },
        }, [label]));
      });

      const currentTheme = [...data.themes, ...data.myCustomThemes].find((t) => t.id === data.current.themeId) || data.themes[0];
      const currentBanner = data.banners.find((b) => b.id === data.current.bannerId);
      const currentBadge = data.badges.find((b) => b.id === data.current.badgeId);

      const cardPreview = el('div', { class: 'pv2-card-preview' });
      const bannerDiv = el('div', { class: 'pv2-card-banner', style: bannerCssActive() });
      const avatar = el('div', { class: 'pv2-card-avatar' }, ['🎮']);
      if (currentBadge) avatar.appendChild(el('div', { class: 'pv2-card-badge' }, [currentBadge.icon]));
      bannerDiv.appendChild(avatar);
      cardPreview.appendChild(bannerDiv);
      cardPreview.appendChild(el('div', { class: 'pv2-card-body' }, [
        el('div', { class: 'pv2-card-name' }, ['Renato']),
        el('div', { class: 'pv2-card-tag' }, ['@renato · ' + (currentTheme ? currentTheme.name : 'Tema padrão')]),
      ]));

      if (profileSubTab === 'banner') {
        content.appendChild(el('div', { class: 'pv2-section-title', style: 'font-size:13px;margin-bottom:4px;' }, ['Sua própria imagem']));
        const uploadRow = el('div', { class: 'pv2-upload-row' });
        // O input de arquivo fica DENTRO do <label> em vez de escondido em
        // outro lugar e "clicado" via JavaScript — clicar num <label>
        // associado sempre abre o seletor nativo em qualquer navegador, sem
        // depender de um .click() disparado por script.
        const fileInput = el('input', {
          type: 'file', accept: 'image/*',
          disabled: data.isPlusUser ? undefined : 'disabled',
          style: 'position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0;',
        });
        const uploadBtnLabel = el('span', {}, [data.isPlusUser ? '📤 Enviar minha foto' : '🔒 Enviar minha foto (PLUS)']);
        const uploadBtn = el('label', {
          class: 'pv2-upload-btn', style: `display:inline-flex; align-items:center; ${data.isPlusUser ? 'cursor:pointer;' : 'cursor:not-allowed; opacity:0.5;'}`,
        }, [fileInput, uploadBtnLabel]);
        fileInput.addEventListener('change', async () => {
          const file = fileInput.files && fileInput.files[0];
          if (!file) return;
          fileInput.disabled = true;
          uploadBtn.style.opacity = '0.6';
          uploadBtnLabel.textContent = 'Enviando…';
          try {
            const url = await adapter.uploadBannerImage(file);
            data.current.customBannerUrl = url;
            data.current.bannerId = null;
            await saveMe({ customBannerUrl: url });
            renderProfilePanel();
          } catch (err) {
            if (opts.onUploadError) opts.onUploadError(err);
          } finally {
            fileInput.disabled = false;
            uploadBtn.style.opacity = '';
            uploadBtnLabel.textContent = '📤 Enviar minha foto';
          }
        });
        uploadRow.appendChild(uploadBtn);
        if (data.current.customBannerUrl) {
          uploadRow.appendChild(el('div', { class: 'pv2-upload-preview selected', style: `background-image:url(${data.current.customBannerUrl});` }));
          uploadRow.appendChild(el('button', {
            class: 'pv2-upload-btn', type: 'button',
            onclick: async () => { data.current.customBannerUrl = null; renderProfilePanel(); await saveMe({ customBannerUrl: null }); },
          }, ['Remover']));
        }
        content.appendChild(uploadRow);
        if (!data.isPlusUser) {
          content.appendChild(el('div', { class: 'pv2-upload-hint' }, ['Banner com imagem própria é exclusivo de quem tem NEXTGAME PLUS.']));
        }

        const grid = el('div', { class: 'pv2-banner-grid' });
        data.banners.forEach((b) => {
          const swatch = el('div', {
            class: 'pv2-banner-swatch' + (!data.current.customBannerUrl && data.current.bannerId === b.id ? ' selected' : '') + (b.locked ? ' locked' : ''),
            style: bannerCss(b),
            title: b.name,
            onclick: () => selectBanner(b),
          });
          if (b.locked) swatch.appendChild(el('span', { style: 'position:absolute;top:2px;right:4px;font-size:10px;' }, ['🔒']));
          grid.appendChild(swatch);
        });
        content.appendChild(el('div', { class: 'pv2-section-title', style: 'font-size:13px;margin:16px 0 8px;' }, ['Ou escolha da galeria']));
        content.appendChild(grid);
      } else {
        const grid = el('div', { class: 'pv2-badge-grid' });
        grid.appendChild(el('div', {
          class: 'pv2-badge-chip' + (!data.current.badgeId ? ' selected' : ''),
          title: 'Nenhum', onclick: () => selectBadge(null),
        }, ['—']));
        data.badges.forEach((b) => {
          const chip = el('div', {
            class: 'pv2-badge-chip' + (data.current.badgeId === b.id ? ' selected' : '') + (b.locked ? ' locked' : ''),
            title: b.name, onclick: () => selectBadge(b),
          }, [b.icon]);
          if (b.locked) chip.appendChild(el('span', { class: 'pv2-mini-lock' }, ['🔒']));
          grid.appendChild(chip);
        });
        content.appendChild(el('div', { class: 'pv2-section-title', style: 'font-size:13px;margin-bottom:8px;' }, ['Escolha um badge']));
        content.appendChild(grid);
      }

      if (!data.isPlusUser) {
        content.appendChild(el('div', { class: 'pv2-plus-cta' }, [
          el('div', { class: 'pv2-plus-cta-title' }, ['✨ Quero ser NEXTGAME PLUS']),
          el('div', { class: 'pv2-plus-cta-text' }, ['Desbloqueia temas premium, criador de tema com cores ilimitadas, banners e badges exclusivos.']),
        ]));
      }

      layout.appendChild(tabsCol);
      layout.appendChild(content);
      layout.appendChild(cardPreview);
      panelProfile.appendChild(layout);
    }

    function bannerCss(banner) {
      if (!banner) return 'background:#26272e;';
      if (banner.style === 'gradient') {
        const [a, b] = banner.value.split(',');
        return `background:linear-gradient(120deg, ${a}, ${b});`;
      }
      return `background:${banner.value};`;
    }
    function bannerCssActive() {
      if (data.current.customBannerUrl) return `background-image:url(${data.current.customBannerUrl});background-size:cover;background-position:center;`;
      return bannerCss(data.banners.find((b) => b.id === data.current.bannerId));
    }

    async function selectBanner(banner) {
      if (banner.locked) { if (opts.onLockedClick) opts.onLockedClick('banner', banner); return; }
      data.current.bannerId = banner.id;
      data.current.customBannerUrl = null;
      renderProfilePanel();
      await saveMe({ bannerId: banner.id });
    }
    async function selectBadge(badge) {
      if (badge && badge.locked) { if (opts.onLockedClick) opts.onLockedClick('badge', badge); return; }
      data.current.badgeId = badge ? badge.id : null;
      renderProfilePanel();
      await saveMe({ badgeId: badge ? badge.id : null });
    }

    // ---------------- ABA: fundos personalizados ----------------
    let particleCanvasStop = null;
    function stopParticleDemo() {
      if (particleCanvasStop) { particleCanvasStop(); particleCanvasStop = null; }
    }
    function startParticleDemo(canvas) {
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx) return () => {};
      const dpr = (global.devicePixelRatio || 1);
      function size() {
        canvas.width = canvas.clientWidth * dpr;
        canvas.height = canvas.clientHeight * dpr;
      }
      size();
      const N = 26;
      const particles = Array.from({ length: N }, () => ({
        x: Math.random() * canvas.width, y: Math.random() * canvas.height,
        r: 1 + Math.random() * 2, vy: 0.15 + Math.random() * 0.35, vx: (Math.random() - 0.5) * 0.2,
      }));
      let raf;
      function tick() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        particles.forEach((p) => {
          p.y -= p.vy; p.x += p.vx;
          if (p.y < -4) { p.y = canvas.height + 4; p.x = Math.random() * canvas.width; }
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * dpr, 0, Math.PI * 2);
          ctx.fill();
        });
        raf = requestAnimationFrame(tick);
      }
      tick();
      return () => cancelAnimationFrame(raf);
    }

    function bgSwatchStyle(bg) {
      if (bg.type === 'solid') return `background:${bg.value};`;
      if (bg.type === 'gradient') {
        const parts = bg.value.split(',');
        const angle = parts[2] || '135';
        return `background:linear-gradient(${angle}deg, ${parts[0]}, ${parts[1]});`;
      }
      if (bg.type === 'image' || bg.type === 'gif') {
        return 'background:repeating-linear-gradient(45deg, #2a2b32, #2a2b32 8px, #35373c 8px, #35373c 16px);';
      }
      if (bg.type === 'effect') {
        if (bg.value === 'particles') {
          return 'background:radial-gradient(circle at 30% 30%, #5865f2 0 2px, transparent 3px), radial-gradient(circle at 70% 60%, #9147ff 0 2px, transparent 3px), radial-gradient(circle at 50% 85%, #00d4ff 0 2px, transparent 3px), radial-gradient(circle at 85% 25%, #fff 0 1.5px, transparent 2.5px), #14151a;';
        }
        return 'background:linear-gradient(120deg, #12c2a9, #7d5fff, #12c2a9); background-size:220% 220%;';
      }
      return 'background:#26272e;';
    }
    function typeIcon(type) {
      return { solid: '', gradient: '', image: '🖼️', gif: '🎞️', effect: '✨' }[type] || '';
    }
    function typeGroupLabel(type) {
      return { solid: 'Cores sólidas', gradient: 'Gradientes', image: 'Imagens', gif: 'GIFs animados', effect: 'Efeitos' }[type] || type;
    }

    function renderBackgroundsPanel() {
      stopParticleDemo();
      panelBackgrounds.innerHTML = '';
      panelBackgrounds.appendChild(el('div', { class: 'pv2-section-title' }, ['Fundos personalizados']));
      panelBackgrounds.appendChild(el('p', { class: 'pv2-section-hint' }, [
        'Escolha o fundo do app inteiro: cor sólida, gradiente, imagem, GIF animado ou um efeito ao vivo (partículas, ondas).',
      ]));
      panelBackgrounds.appendChild(el('div', { class: 'pv2-locked-note' }, [
        '✅ Cor sólida, gradiente, efeitos (partículas/ondas) e agora também imagem/GIF próprio já aplicam de verdade no fundo do app. Os itens "(exemplo)" do catálogo abaixo continuam sendo só ilustração — envie a sua própria imagem/GIF pra um fundo de verdade.',
      ]));

      // Upload de fundo próprio (imagem ou GIF) — mesmo esquema do upload de
      // banner na aba Perfil. Corrige "imagem/GIF não funciona": antes só
      // existiam exemplos de ilustração no catálogo, sem jeito de mandar um
      // arquivo de verdade.
      panelBackgrounds.appendChild(el('div', { class: 'pv2-section-title', style: 'font-size:13px;margin-bottom:4px;' }, ['Sua própria imagem ou GIF']));
      const bgUploadRow = el('div', { class: 'pv2-upload-row' });
      const bgFileInput = el('input', {
        type: 'file', accept: 'image/*,.gif',
        disabled: data.isPlusUser ? undefined : 'disabled',
        style: 'position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0;',
      });
      const bgUploadBtnLabel = el('span', {}, [data.isPlusUser ? '📤 Enviar imagem/GIF' : '🔒 Enviar imagem/GIF (PLUS)']);
      const bgUploadBtn = el('label', {
        class: 'pv2-upload-btn', style: `display:inline-flex; align-items:center; ${data.isPlusUser ? 'cursor:pointer;' : 'cursor:not-allowed; opacity:0.5;'}`,
      }, [bgFileInput, bgUploadBtnLabel]);
      bgFileInput.addEventListener('change', async () => {
        const file = bgFileInput.files && bgFileInput.files[0];
        if (!file) return;
        bgFileInput.disabled = true;
        bgUploadBtn.style.opacity = '0.6';
        bgUploadBtnLabel.textContent = 'Enviando…';
        try {
          const url = await adapter.uploadBackgroundImage(file);
          const bgType = /\.gif$/i.test(file.name) || file.type === 'image/gif' ? 'gif' : 'image';
          data.current.customBackgroundUrl = url;
          data.current.customBackgroundType = bgType;
          data.current.backgroundId = null;
          await saveMe({ customBackgroundUrl: url, customBackgroundType: bgType });
          renderBackgroundsPanel();
        } catch (err) {
          if (opts.onUploadError) opts.onUploadError(err);
        } finally {
          bgFileInput.disabled = false;
          bgUploadBtn.style.opacity = '';
          bgUploadBtnLabel.textContent = '📤 Enviar imagem/GIF';
        }
      });
      bgUploadRow.appendChild(bgUploadBtn);
      if (data.current.customBackgroundUrl) {
        bgUploadRow.appendChild(el('div', { class: 'pv2-upload-preview selected', style: `background-image:url(${data.current.customBackgroundUrl});` }));
        bgUploadRow.appendChild(el('button', {
          class: 'pv2-upload-btn', type: 'button',
          onclick: async () => { data.current.customBackgroundUrl = null; renderBackgroundsPanel(); await saveMe({ customBackgroundUrl: null }); },
        }, ['Remover']));
      }
      panelBackgrounds.appendChild(bgUploadRow);
      if (!data.isPlusUser) {
        panelBackgrounds.appendChild(el('div', { class: 'pv2-upload-hint' }, ['Fundo com imagem/GIF próprio é exclusivo de quem tem NEXTGAME PLUS.']));
      }
      panelBackgrounds.appendChild(el('div', { class: 'pv2-section-title', style: 'font-size:13px;margin:16px 0 8px;' }, ['Ou escolha da galeria']));

      const layout = el('div', { class: 'pv2-bg-layout' });
      const controls = el('div', { class: 'pv2-bg-controls' });
      const previewWrap = el('div', { class: 'pv2-bg-preview-wrap' });

      const grouped = {};
      (data.backgrounds || []).forEach((bg) => { (grouped[bg.type] = grouped[bg.type] || []).push(bg); });
      ['solid', 'gradient', 'image', 'gif', 'effect'].forEach((type) => {
        if (!grouped[type] || !grouped[type].length) return;
        controls.appendChild(el('div', { class: 'pv2-bg-group-title' }, [typeGroupLabel(type)]));
        const grid = el('div', { class: 'pv2-bg-grid' });
        grouped[type].forEach((bg) => {
          const swatch = el('div', {
            class: 'pv2-bg-swatch' + (data.current.backgroundId === bg.id ? ' selected' : '') + (bg.locked ? ' locked' : ''),
            style: bgSwatchStyle(bg),
            title: bg.name,
            onclick: () => selectBackground(bg),
          }, [el('span', {}, [(typeIcon(type) ? typeIcon(type) + ' ' : '') + bg.name])]);
          if (bg.locked) swatch.appendChild(el('span', { class: 'pv2-mini-lock' }, ['🔒']));
          grid.appendChild(swatch);
        });
        controls.appendChild(grid);
      });

      const prefs = data.visualPrefs.background;
      const opacityRow = el('div', { class: 'pv2-slider-row' });
      const opacityHead = el('div', { class: 'pv2-slider-row-head' }, ['Opacidade', el('b', {}, [prefs.opacity + '%'])]);
      const opacityInput = el('input', { type: 'range', min: '10', max: '100', value: String(prefs.opacity) });
      opacityInput.addEventListener('input', () => {
        opacityHead.lastChild.textContent = opacityInput.value + '%';
        updateStageLayer();
      });
      opacityInput.addEventListener('change', async () => {
        prefs.opacity = Number(opacityInput.value);
        await saveMe({ visualPrefs: { background: { opacity: prefs.opacity } } });
      });
      opacityRow.appendChild(opacityHead);
      opacityRow.appendChild(opacityInput);

      const blurRow = el('div', { class: 'pv2-slider-row' });
      const blurHead = el('div', { class: 'pv2-slider-row-head' }, ['Desfoque', el('b', {}, [prefs.blur + 'px'])]);
      const blurInput = el('input', { type: 'range', min: '0', max: '30', value: String(prefs.blur) });
      blurInput.addEventListener('input', () => {
        blurHead.lastChild.textContent = blurInput.value + 'px';
        updateStageLayer();
      });
      blurInput.addEventListener('change', async () => {
        prefs.blur = Number(blurInput.value);
        await saveMe({ visualPrefs: { background: { blur: prefs.blur } } });
      });
      blurRow.appendChild(blurHead);
      blurRow.appendChild(blurInput);

      controls.appendChild(el('div', { class: 'pv2-bg-group-title' }, ['Ajustes']));
      controls.appendChild(opacityRow);
      controls.appendChild(blurRow);

      const stage = el('div', { class: 'pv2-bg-preview-stage' });
      const layer = el('div', { class: 'pv2-bg-preview-layer' });
      const frame = buildPreviewFrame();
      frame.root.classList.add('pv2-bg-preview-content');
      let particleCanvas = null;

      function updateStageLayer() {
        const current = (data.backgrounds || []).find((b) => b.id === data.current.backgroundId);
        stopParticleDemo();
        layer.innerHTML = '';
        layer.setAttribute('style', current ? bgSwatchStyle(current) : 'background:#14151a;');
        layer.style.opacity = String(Number(opacityInput.value) / 100);
        layer.style.filter = `blur(${blurInput.value}px)`;
        if (current && current.type === 'effect' && current.value === 'particles') {
          particleCanvas = el('canvas', { style: 'width:100%;height:100%;display:block;' });
          layer.appendChild(particleCanvas);
          particleCanvasStop = startParticleDemo(particleCanvas);
        }
      }

      stage.appendChild(layer);
      stage.appendChild(frame.root);
      previewWrap.appendChild(stage);
      updateStageLayer();

      if (!data.isPlusUser) {
        controls.appendChild(el('div', { class: 'pv2-plus-cta' }, [
          el('div', { class: 'pv2-plus-cta-title' }, ['✨ Fundos com imagem, GIF e efeitos ao vivo']),
          el('div', { class: 'pv2-plus-cta-text' }, ['São exclusivos de quem tem NEXTGAME PLUS. As cores sólidas e o gradiente básico continuam liberados pra todo mundo.']),
        ]));
      }

      layout.appendChild(controls);
      layout.appendChild(previewWrap);
      panelBackgrounds.appendChild(layout);
    }

    async function selectBackground(bg) {
      if (bg.locked) { if (opts.onLockedClick) opts.onLockedClick('background', bg); return; }
      data.current.backgroundId = bg.id;
      data.current.customBackgroundUrl = null;
      renderBackgroundsPanel();
      await saveMe({ backgroundId: bg.id });
    }

    // ---------------- ABA: efeitos e animações ----------------
    const EFFECT_DEFS = [
      { key: 'particles', label: 'Partículas flutuantes', hint: 'Pontinhos animados subindo no fundo do app.', free: false },
      { key: 'buttonGlow', label: 'Brilho nos botões', hint: 'Botões principais ganham um leve brilho pulsante.', free: true },
      { key: 'animatedGradients', label: 'Gradientes animados', hint: 'Fundo do menu lateral com gradiente em movimento.', free: false },
      { key: 'messageReceive', label: 'Efeito ao receber mensagem', hint: 'Bolha de mensagem nova desliza suavemente.', free: true },
      { key: 'callJoin', label: 'Efeito ao entrar em call', hint: 'Aro pulsante em volta do avatar de quem entrou.', free: true },
      { key: 'avatarGlow', label: 'Glow no avatar', hint: 'Contorno brilhante no seu próprio avatar.', free: false },
      { key: 'transitions', label: 'Animações de transição', hint: 'Troca de tela/aba com uma transição suave.', free: true },
    ];

    function renderEffectsPanel() {
      panelEffects.innerHTML = '';
      panelEffects.appendChild(el('div', { class: 'pv2-section-title' }, ['Efeitos e animações']));
      panelEffects.appendChild(el('p', { class: 'pv2-section-hint' }, ['Deixe a experiência mais viva — ou desligue tudo pra ganhar performance.']));

      const perf = data.visualPrefs.performanceMode;
      if (perf) {
        panelEffects.appendChild(el('div', { class: 'pv2-perf-banner' }, [
          '⚡ Modo desempenho está ativo — todos os efeitos abaixo ficam desligados automaticamente, mesmo que estejam marcados, pra priorizar FPS.',
        ]));
      }

      const layout = el('div', { class: 'pv2-creator-layout' });
      const controls = el('div', { class: 'pv2-creator-controls' });
      const previewWrap = el('div', { class: 'pv2-preview-wrap' });

      const perfRow = el('div', { class: 'pv2-toggle-item' }, [
        el('div', {}, [
          el('div', { class: 'pv2-toggle-item-label' }, ['⚡ Modo desempenho']),
          el('div', { class: 'pv2-toggle-item-hint' }, ['Desliga todos os efeitos de uma vez, pra rodar melhor em PC/celular mais fraco.']),
        ]),
      ]);
      const perfSwitch = el('label', { class: 'pv2-switch' }, [
        el('input', { type: 'checkbox' }),
        el('span', { class: 'pv2-switch-track' }),
      ]);
      const perfCheckbox = perfSwitch.children[0];
      perfCheckbox.checked = perf;
      perfCheckbox.addEventListener('change', async () => {
        data.visualPrefs.performanceMode = perfCheckbox.checked;
        await saveMe({ visualPrefs: { performanceMode: perfCheckbox.checked } });
        renderEffectsPanel();
      });
      perfRow.appendChild(perfSwitch);
      controls.appendChild(perfRow);

      const list = el('div', { class: 'pv2-toggle-list' });
      EFFECT_DEFS.forEach((def) => {
        const locked = !def.free && !data.isPlusUser;
        const row = el('div', { class: 'pv2-toggle-item' }, [
          el('div', {}, [
            el('div', { class: 'pv2-toggle-item-label' }, [def.label, !def.free ? el('span', { class: 'pv2-premium-pill' }, ['PLUS']) : null]),
            el('div', { class: 'pv2-toggle-item-hint' }, [def.hint]),
          ]),
        ]);
        const sw = el('label', { class: 'pv2-switch' }, [
          el('input', { type: 'checkbox', disabled: locked ? 'disabled' : undefined }),
          el('span', { class: 'pv2-switch-track' }),
        ]);
        const cb = sw.children[0];
        cb.checked = !!data.visualPrefs.effects[def.key];
        cb.addEventListener('change', async () => {
          if (locked) { cb.checked = false; if (opts.onLockedClick) opts.onLockedClick('effect', def); return; }
          data.visualPrefs.effects[def.key] = cb.checked;
          await saveMe({ visualPrefs: { effects: { [def.key]: cb.checked } } });
          renderPreviewEffects();
        });
        if (locked) {
          row.style.opacity = '0.6';
          row.appendChild(el('span', { onclick: () => { if (opts.onLockedClick) opts.onLockedClick('effect', def); } }, ['🔒']));
        }
        row.appendChild(sw);
        list.appendChild(row);
      });
      controls.appendChild(list);

      const demoActions = el('div', { class: 'pv2-demo-actions' }, [
        el('button', { class: 'pv2-demo-btn', type: 'button', onclick: () => demoMessageReceive() }, ['💬 Simular mensagem']),
        el('button', { class: 'pv2-demo-btn', type: 'button', onclick: () => demoCallJoin() }, ['📞 Simular entrar na call']),
      ]);
      controls.appendChild(demoActions);

      const frame = buildPreviewFrame();
      previewWrap.appendChild(frame.root);
      layout.appendChild(controls);
      layout.appendChild(previewWrap);
      panelEffects.appendChild(layout);

      // frame.root = [topbar, body] ; body = [rail, sidebar, chat] ; chat = [bubble, bubble(own), sendBtn]
      const bodyEl = frame.root.children[1];
      const railEl = bodyEl.children[0];
      const sidebarEl = bodyEl.children[1];
      const chatEl = bodyEl.children[2];
      const sendBtnEl = chatEl.children[chatEl.children.length - 1];
      const myAvatarDotEl = railEl.children[0];

      function effectsActive() {
        return perf ? {} : data.visualPrefs.effects;
      }
      function renderPreviewEffects() {
        const fx = effectsActive();
        sendBtnEl.classList.toggle('pv2-fx-button-glow', !!fx.buttonGlow);
        myAvatarDotEl.classList.toggle('pv2-fx-avatar-glow', !!fx.avatarGlow);
        sidebarEl.classList.toggle('pv2-fx-gradient-anim', !!fx.animatedGradients);
      }
      function demoMessageReceive() {
        const fx = effectsActive();
        const bubble = el('div', { class: 'pv2-preview-bubble' + (fx.messageReceive ? ' pv2-fx-msg-receive' : '') }, ['Novo evento hoje às 20h! 🎮']);
        // insere logo antes do botão de enviar, pra ficar junto das outras bolhas
        chatEl.insertBefore(bubble, sendBtnEl);
      }
      function demoCallJoin() {
        const fx = effectsActive();
        if (!fx.callJoin) return;
        myAvatarDotEl.classList.add('pv2-fx-call-ring');
        setTimeout(() => myAvatarDotEl.classList.remove('pv2-fx-call-ring'), 1200);
      }

      renderPreviewEffects();
    }

    // ---------------- ABA: personalização do chat ----------------
    function renderChatPanel() {
      panelChat.innerHTML = '';
      panelChat.appendChild(el('div', { class: 'pv2-section-title' }, ['Personalização do chat']));
      panelChat.appendChild(el('p', { class: 'pv2-section-hint' }, ['Aparência das mensagens e conversas.']));

      const chat = data.visualPrefs.chat;
      const layout = el('div', { class: 'pv2-chat-layout' });
      const controls = el('div', { class: 'pv2-chat-controls' });
      const previewWrap = el('div', { class: 'pv2-chat-preview-wrap' });

      function field(labelText, node) {
        const wrap = el('div', {});
        wrap.appendChild(el('div', { class: 'pv2-field-label' }, [labelText]));
        wrap.appendChild(node);
        return wrap;
      }
      async function patchChat(partial) {
        Object.assign(chat, partial);
        await saveMe({ visualPrefs: { chat: partial } });
        renderChatPanel();
      }

      // Bolhas de mensagem
      const bubbleGroup = el('div', { class: 'pv2-radio-group' });
      [['rounded', 'Arredondadas'], ['square', 'Quadradas'], ['minimal', 'Minimalista']].forEach(([val, label]) => {
        bubbleGroup.appendChild(el('button', {
          class: 'pv2-radio-chip' + (chat.bubbleStyle === val ? ' active' : ''), type: 'button',
          onclick: () => patchChat({ bubbleStyle: val }),
        }, [label]));
      });
      controls.appendChild(field('Bolhas de mensagem', bubbleGroup));

      // Mostrar avatares
      const avatarToggleRow = el('div', { class: 'pv2-chat-toggle-row' });
      const avatarSwitch = el('label', { class: 'pv2-switch' }, [el('input', { type: 'checkbox' }), el('span', { class: 'pv2-switch-track' })]);
      avatarSwitch.children[0].checked = chat.showAvatars;
      avatarSwitch.children[0].addEventListener('change', (e) => patchChat({ showAvatars: e.target.checked }));
      avatarToggleRow.appendChild(el('span', {}, ['Mostrar avatares']));
      avatarToggleRow.appendChild(avatarSwitch);
      controls.appendChild(avatarToggleRow);

      // Cores das mensagens
      const colorSelect = el('select', { class: 'pv2-select' }, [
        el('option', { value: 'per_user' }, ['Por usuário' + (!data.isPlusUser ? ' 🔒 (PLUS)' : '')]),
        el('option', { value: 'theme' }, ['Cor do tema']),
        el('option', { value: 'mono' }, ['Neutra (sem cor)']),
      ]);
      colorSelect.value = chat.colorMode;
      colorSelect.addEventListener('change', () => {
        if (colorSelect.value === 'per_user' && !data.isPlusUser) {
          if (opts.onLockedClick) opts.onLockedClick('chatColor', { name: 'Cor por usuário' });
          colorSelect.value = chat.colorMode;
          return;
        }
        patchChat({ colorMode: colorSelect.value });
      });
      controls.appendChild(field('Cores das mensagens', colorSelect));

      // Tamanho da fonte
      const fontSelect = el('select', { class: 'pv2-select' }, [
        el('option', { value: 'small' }, ['Pequeno']),
        el('option', { value: 'medium' }, ['Médio']),
        el('option', { value: 'large' }, ['Grande']),
      ]);
      fontSelect.value = chat.fontSize;
      fontSelect.addEventListener('change', () => patchChat({ fontSize: fontSelect.value }));
      controls.appendChild(field('Tamanho da fonte', fontSelect));

      // Espaçamento
      const spacingRow = el('div', { class: 'pv2-slider-row' });
      const spacingHead = el('div', { class: 'pv2-slider-row-head' }, ['Espaçamento', el('b', {}, [chat.spacing + 'px'])]);
      const spacingInput = el('input', { type: 'range', min: '4', max: '32', value: String(chat.spacing) });
      spacingInput.addEventListener('input', () => { spacingHead.lastChild.textContent = spacingInput.value + 'px'; previewChat.style.gap = spacingInput.value + 'px'; });
      spacingInput.addEventListener('change', () => patchChat({ spacing: Number(spacingInput.value) }));
      spacingRow.appendChild(spacingHead);
      spacingRow.appendChild(spacingInput);
      controls.appendChild(spacingRow);

      // Timestamps
      const tsRow = el('div', { class: 'pv2-chat-toggle-row' });
      const tsSwitch = el('label', { class: 'pv2-switch' }, [el('input', { type: 'checkbox' }), el('span', { class: 'pv2-switch-track' })]);
      tsSwitch.children[0].checked = chat.showTimestamps;
      tsSwitch.children[0].addEventListener('change', (e) => patchChat({ showTimestamps: e.target.checked }));
      tsRow.appendChild(el('span', {}, ['Mostrar horários']));
      tsRow.appendChild(tsSwitch);
      controls.appendChild(tsRow);

      // Reações
      const reactRow = el('div', { class: 'pv2-chat-toggle-row' });
      const reactSwitch = el('label', { class: 'pv2-switch' }, [el('input', { type: 'checkbox' }), el('span', { class: 'pv2-switch-track' })]);
      reactSwitch.children[0].checked = chat.showReactions;
      reactSwitch.children[0].addEventListener('change', (e) => patchChat({ showReactions: e.target.checked }));
      reactRow.appendChild(el('span', {}, ['Mostrar reações']));
      reactRow.appendChild(reactSwitch);
      controls.appendChild(reactRow);

      // Efeito nas menções
      const mentionSelect = el('select', { class: 'pv2-select' }, [
        el('option', { value: 'none' }, ['Nenhum']),
        el('option', { value: 'highlight' }, ['Destaque (fundo)']),
        el('option', { value: 'shake' }, ['Tremida' + (!data.isPlusUser ? ' 🔒 (PLUS)' : '')]),
        el('option', { value: 'glow' }, ['Glow' + (!data.isPlusUser ? ' 🔒 (PLUS)' : '')]),
      ]);
      mentionSelect.value = chat.mentionEffect;
      mentionSelect.addEventListener('change', () => {
        const premiumOnly = mentionSelect.value === 'shake' || mentionSelect.value === 'glow';
        if (premiumOnly && !data.isPlusUser) {
          if (opts.onLockedClick) opts.onLockedClick('mentionEffect', { name: 'Efeito de menção' });
          mentionSelect.value = chat.mentionEffect;
          return;
        }
        patchChat({ mentionEffect: mentionSelect.value });
      });
      controls.appendChild(field('Efeito nas menções', mentionSelect));

      // ---- prévia ----
      const previewFrame = el('div', { class: 'pv2-preview-frame' });
      const previewChat = el('div', { class: 'pv2-chat-preview' });
      previewChat.style.gap = chat.spacing + 'px';
      const fontPx = { small: '11px', medium: '12.5px', large: '14.5px' }[chat.fontSize];

      function bubble(name, text, own, mentioned, color) {
        const row = el('div', { class: 'pv2-chat-msg-row', style: own ? 'flex-direction: row-reverse;' : '' });
        if (chat.showAvatars) row.appendChild(el('div', { class: 'pv2-chat-avatar' }, [own ? '🎮' : '👤']));
        const col = el('div', { class: 'pv2-chat-msg-col' });
        if (chat.showTimestamps) col.appendChild(el('div', { class: 'pv2-chat-msg-meta' }, [name, '· 20:41']));
        const bubbleClass = 'pv2-chat-bubble pv2-bubble-' + chat.bubbleStyle + (mentioned && chat.mentionEffect !== 'none' ? ' pv2-chat-mention pv2-mention-' + chat.mentionEffect : '');
        const bStyle = chat.bubbleStyle === 'minimal' ? `--pv2-chat-color:${color};` : `background:${color};`;
        const b = el('div', { class: bubbleClass, style: bStyle + `font-size:${fontPx};` }, [text]);
        col.appendChild(b);
        if (chat.showReactions && !mentioned) {
          col.appendChild(el('div', { class: 'pv2-chat-reactions' }, [el('span', { class: 'pv2-chat-reaction' }, ['🔥 3'])]));
        }
        row.appendChild(col);
        return row;
      }

      const colorFor = (isOwn) => {
        if (chat.colorMode === 'mono') return '#2a2b32';
        if (chat.colorMode === 'theme') return isOwn ? '#00ff9d' : '#35373c';
        return isOwn ? '#00ff9d' : '#00c896';
      };
      previewChat.appendChild(bubble('João', 'Bora jogar hoje à noite?', false, false, colorFor(false)));
      previewChat.appendChild(bubble('Você', 'Bora sim! 🔥', true, false, colorFor(true)));
      previewChat.appendChild(bubble('Maria', '@Você chega que já vamos começar!', false, true, colorFor(false)));

      previewFrame.appendChild(previewChat);
      previewWrap.appendChild(previewFrame);

      layout.appendChild(controls);
      layout.appendChild(previewWrap);
      panelChat.appendChild(layout);
    }

    // ---------------- ABA: figurinhas ----------------
    let activePackId = null;
    function renderStickersPanel() {
      panelStickers.innerHTML = '';
      panelStickers.appendChild(el('div', { class: 'pv2-section-title' }, ['Figurinhas']));
      panelStickers.appendChild(el('p', { class: 'pv2-section-hint' }, [
        'Um emoji grande ou uma imagem, do jeito WhatsApp/Telegram. Pacotes com 🔒 são exclusivos de quem tem NEXTGAME PLUS.',
      ]));

      if (!stickersData || !stickersData.packs || !stickersData.packs.length) {
        panelStickers.appendChild(el('p', { class: 'pv2-section-hint' }, ['Nenhum pacote de figurinha configurado ainda.']));
        return;
      }

      if (!activePackId || !stickersData.packs.some((p) => p.id === activePackId)) {
        activePackId = stickersData.packs[0].id;
      }

      const packRow = el('div', { class: 'pv2-radio-group', style: 'margin-bottom:14px;' });
      stickersData.packs.forEach((pack) => {
        packRow.appendChild(el('button', {
          class: 'pv2-radio-chip' + (activePackId === pack.id ? ' active' : ''),
          type: 'button',
          onclick: () => { activePackId = pack.id; renderStickersPanel(); },
        }, [pack.name + (pack.locked ? ' 🔒' : '')]));
      });
      panelStickers.appendChild(packRow);

      const activePack = stickersData.packs.find((p) => p.id === activePackId);
      const grid = el('div', { class: 'pv2-sticker-grid' });
      (activePack.stickers || []).forEach((s) => {
        const item = el('button', {
          class: 'pv2-sticker-item' + (activePack.locked ? ' locked' : ''), type: 'button',
          title: activePack.locked ? 'Exclusivo NEXTGAME PLUS' : 'Enviar',
          onclick: () => sendStickerDemo(s, activePack),
        }, [s.type === 'image' ? el('img', { src: s.content, alt: '', loading: 'lazy' }) : el('span', {}, [s.content])]);
        grid.appendChild(item);
      });
      panelStickers.appendChild(grid);

      panelStickers.appendChild(el('div', { class: 'pv2-section-title', style: 'font-size:13px;margin:18px 0 8px;' }, ['Prévia — como fica no chat']));
      panelStickers.appendChild(stickerDemoLog);

      if (!stickersData.isPlusUser) {
        panelStickers.appendChild(el('div', { class: 'pv2-plus-cta' }, [
          el('div', { class: 'pv2-plus-cta-title' }, ['✨ Mais pacotes com NEXTGAME PLUS']),
          el('div', { class: 'pv2-plus-cta-text' }, ['Pacotes exclusivos (ex: PLUS Dourado, PLUS Neon) ficam disponíveis pra quem assina.']),
        ]));
      }
    }

    const stickerDemoLog = el('div', { class: 'pv2-sticker-demo-log' });
    function sendStickerDemo(sticker, pack) {
      if (pack.locked) { if (opts.onLockedClick) opts.onLockedClick('stickerPack', pack); return; }
      const bubble = sticker.type === 'image'
        ? el('div', { class: 'pv2-sticker-demo-bubble pv2-sticker-demo-bubble-img' }, [el('img', { src: sticker.content, alt: '' })])
        : el('div', { class: 'pv2-sticker-demo-bubble' }, [sticker.content]);
      stickerDemoLog.appendChild(bubble);
      stickerDemoLog.scrollTop = stickerDemoLog.scrollHeight;
      if (opts.onStickerSent) opts.onStickerSent(sticker, pack);
    }

    renderThemesPanel();
    renderCreatorPanel();
    renderBackgroundsPanel();
    renderEffectsPanel();
    renderChatPanel();
    renderProfilePanel();
    if (activeTab === 'stickers') loadStickers();

    return {
      refresh,
      setActiveTab,
      getData: () => data,
      destroy: () => stopParticleDemo(),
    };
  }

  global.PlusV2 = { mount, createMockAdapter, createHttpAdapter, applyThemeVars };
})(typeof window !== 'undefined' ? window : globalThis);
