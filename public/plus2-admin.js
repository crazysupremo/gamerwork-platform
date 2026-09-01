// ============================================================================
// PLUS-V2 — painel de administração (MÓDULO SEPARADO, ainda não linkado no
// admin.html real). Telas de CRUD pra gerenciar temas, fundos, banners,
// badges e pacotes de figurinha sem precisar mexer em código.
//
// Mesmo padrão do plus2.js: PlusV2Admin.mount(containerEl, adapter) monta
// tudo, e quem decide de onde vêm os dados é o adapter passado por fora
// (mock em memória pro admin-preview.html, HTTP de verdade na integração).
// ============================================================================

(function (global) {
  'use strict';

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
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

  function fieldInput(field, value) {
    if (field.type === 'checkbox') {
      const input = el('input', { type: 'checkbox' });
      input.checked = !!value;
      return input;
    }
    if (field.type === 'select') {
      const select = el('select', { class: 'pv2a-input' }, field.options.map((o) => el('option', { value: o.value }, [o.label])));
      select.value = value !== undefined ? value : field.options[0].value;
      return select;
    }
    if (field.type === 'color') {
      const input = el('input', { type: 'color', class: 'pv2a-color-input', value: value || '#5865f2' });
      return input;
    }
    if (field.type === 'number') {
      const input = el('input', { type: 'number', class: 'pv2a-input', value: value !== undefined ? String(value) : '0' });
      return input;
    }
    const input = el('input', { type: 'text', class: 'pv2a-input', value: value || '' });
    return input;
  }

  function fieldValue(field, input) {
    if (field.type === 'checkbox') return input.checked;
    if (field.type === 'number') return Number(input.value) || 0;
    return input.value;
  }

  // ------------------------------------------------------------------
  // Tabela de CRUD genérica — usada pra temas, fundos, banners e badges.
  // config: { title, hint, fields, items, idKey, onCreate, onUpdate, onDelete, previewFn }
  // ------------------------------------------------------------------
  function renderCrudTable(container, config) {
    container.innerHTML = '';
    container.appendChild(el('div', { class: 'pv2a-section-title' }, [config.title]));
    if (config.hint) container.appendChild(el('p', { class: 'pv2a-section-hint' }, [config.hint]));

    const table = el('table', { class: 'pv2a-table' });
    const thead = el('thead', {}, [
      el('tr', {}, [
        ...(config.previewFn ? [el('th', {}, ['Prévia'])] : []),
        ...config.fields.map((f) => el('th', {}, [f.label])),
        el('th', {}, ['']),
      ]),
    ]);
    const tbody = el('tbody');
    table.appendChild(thead);
    table.appendChild(tbody);

    function renderRow(item) {
      const inputs = {};
      const row = el('tr');
      if (config.previewFn) {
        const previewCell = el('td');
        previewCell.appendChild(config.previewFn(item));
        row.appendChild(previewCell);
      }
      config.fields.forEach((f) => {
        const input = fieldInput(f, item[f.key]);
        inputs[f.key] = input;
        row.appendChild(el('td', {}, [input]));
      });
      const actions = el('td', { class: 'pv2a-row-actions' });
      const saveBtn = el('button', {
        class: 'pv2a-btn pv2a-btn-small', type: 'button',
        onclick: async () => {
          const patch = {};
          config.fields.forEach((f) => { patch[f.key] = fieldValue(f, inputs[f.key]); });
          saveBtn.textContent = 'Salvando…';
          saveBtn.disabled = true;
          try {
            await config.onUpdate(item[config.idKey], patch);
            showAdminToast('Salvo ✓');
          } catch (err) {
            showAdminToast('Erro: ' + err.message);
          }
          saveBtn.textContent = 'Salvar';
          saveBtn.disabled = false;
        },
      }, ['Salvar']);
      const delBtn = el('button', {
        class: 'pv2a-btn pv2a-btn-small pv2a-btn-danger', type: 'button',
        onclick: async () => {
          if (!confirm('Remover "' + (item.name || item.key || item[config.idKey]) + '"? Essa ação não tem volta.')) return;
          try {
            await config.onDelete(item[config.idKey]);
            renderAll();
            showAdminToast('Removido ✓');
          } catch (err) {
            showAdminToast('Erro: ' + err.message);
          }
        },
      }, ['Remover']);
      actions.appendChild(saveBtn);
      actions.appendChild(delBtn);
      if (config.extraRowAction) actions.appendChild(config.extraRowAction(item));
      row.appendChild(actions);
      tbody.appendChild(row);
    }

    function renderAll() {
      tbody.innerHTML = '';
      config.items.forEach(renderRow);
    }
    renderAll();
    container.appendChild(table);

    // ---- form de criação ----
    container.appendChild(el('div', { class: 'pv2a-section-title', style: 'font-size:13px;margin-top:20px;' }, ['Adicionar novo']));
    const createInputs = {};
    const createRow = el('div', { class: 'pv2a-create-row' });
    config.fields.forEach((f) => {
      const input = fieldInput(f, f.default);
      createInputs[f.key] = input;
      createRow.appendChild(el('div', { class: 'pv2a-create-field' }, [el('label', {}, [f.label]), input]));
    });
    const addBtn = el('button', {
      class: 'pv2a-btn', type: 'button',
      onclick: async () => {
        const data = {};
        config.fields.forEach((f) => { data[f.key] = fieldValue(f, createInputs[f.key]); });
        addBtn.textContent = 'Adicionando…';
        addBtn.disabled = true;
        try {
          await config.onCreate(data);
          config.fields.forEach((f) => { createInputs[f.key].value = f.type === 'checkbox' ? undefined : (f.default || ''); if (f.type === 'checkbox') createInputs[f.key].checked = !!f.default; });
          showAdminToast('Criado ✓');
        } catch (err) {
          showAdminToast('Erro: ' + err.message);
        }
        addBtn.textContent = '+ Adicionar';
        addBtn.disabled = false;
      },
    }, ['+ Adicionar']);
    createRow.appendChild(addBtn);
    container.appendChild(createRow);

    return { refresh: renderAll };
  }

  let toastEl = null;
  function showAdminToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(showAdminToast._t);
    showAdminToast._t = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  const THEME_FIELDS = [
    { key: 'name', label: 'Nome', type: 'text' },
    { key: 'primary', label: 'Primária', type: 'color', default: '#5865f2' },
    { key: 'secondary', label: 'Secundária', type: 'color', default: '#9147ff' },
    { key: 'highlight', label: 'Destaque', type: 'color', default: '#00d4ff' },
    { key: 'text', label: 'Texto', type: 'color', default: '#e6e6e6' },
    { key: 'button', label: 'Botão', type: 'color', default: '#1e1e2f' },
    { key: 'effect', label: 'Efeito', type: 'select', options: [{ value: 'none', label: 'Nenhum' }, { value: 'shine', label: 'Shine' }, { value: 'glow', label: 'Glow' }, { value: 'pulse', label: 'Pulse' }] },
    { key: 'premium', label: 'PLUS', type: 'checkbox' },
    { key: 'sortOrder', label: 'Ordem', type: 'number', default: 0 },
  ];
  const BACKGROUND_FIELDS = [
    { key: 'name', label: 'Nome', type: 'text' },
    { key: 'type', label: 'Tipo', type: 'select', options: [{ value: 'solid', label: 'Cor sólida' }, { value: 'gradient', label: 'Gradiente' }, { value: 'image', label: 'Imagem' }, { value: 'gif', label: 'GIF' }, { value: 'effect', label: 'Efeito' }] },
    { key: 'value', label: 'Value (cor / "a,b,ângulo" / URL / chave do efeito)', type: 'text' },
    { key: 'premium', label: 'PLUS', type: 'checkbox' },
    { key: 'sortOrder', label: 'Ordem', type: 'number', default: 0 },
  ];
  const BANNER_FIELDS = [
    { key: 'name', label: 'Nome', type: 'text' },
    { key: 'style', label: 'Estilo', type: 'select', options: [{ value: 'solid', label: 'Cor sólida' }, { value: 'gradient', label: 'Gradiente' }] },
    { key: 'value', label: 'Value (cor ou "corA,corB")', type: 'text' },
    { key: 'premium', label: 'PLUS', type: 'checkbox' },
    { key: 'sortOrder', label: 'Ordem', type: 'number', default: 0 },
  ];
  const BADGE_FIELDS = [
    { key: 'name', label: 'Nome', type: 'text' },
    { key: 'icon', label: 'Ícone (emoji ou URL)', type: 'text' },
    { key: 'premium', label: 'PLUS', type: 'checkbox' },
    { key: 'sortOrder', label: 'Ordem', type: 'number', default: 0 },
  ];
  const PACK_FIELDS = [
    { key: 'name', label: 'Nome do pacote', type: 'text' },
    { key: 'premium', label: 'PLUS', type: 'checkbox' },
    { key: 'sortOrder', label: 'Ordem', type: 'number', default: 0 },
  ];
  const STICKER_FIELDS = [
    { key: 'type', label: 'Tipo', type: 'select', options: [{ value: 'emoji', label: 'Emoji' }, { value: 'image', label: 'Imagem' }] },
    { key: 'content', label: 'Conteúdo (emoji ou URL da imagem)', type: 'text' },
  ];

  function themePreview(t) {
    const dot = el('div', { style: `width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg, ${t.primary || '#5865f2'}, ${t.secondary || '#9147ff'});` });
    return dot;
  }
  function backgroundPreview(b) {
    let style = 'width:44px;height:28px;border-radius:6px;';
    if (b.type === 'solid') style += `background:${b.value};`;
    else if (b.type === 'gradient') { const [a, c] = (b.value || '').split(','); style += `background:linear-gradient(135deg, ${a || '#333'}, ${c || '#111'});`; }
    else style += 'background:repeating-linear-gradient(45deg, #2a2b32, #2a2b32 6px, #35373c 6px, #35373c 12px);';
    return el('div', { style });
  }
  function bannerPreview(b) {
    let style = 'width:44px;height:28px;border-radius:6px;';
    if (b.style === 'gradient') { const [a, c] = (b.value || '').split(','); style += `background:linear-gradient(135deg, ${a || '#333'}, ${c || '#111'});`; }
    else style += `background:${b.value};`;
    return el('div', { style });
  }
  function badgePreview(b) {
    return el('div', { style: 'font-size:20px;width:30px;text-align:center;' }, [b.icon || '']);
  }

  async function mount(container, adapter) {
    container.classList.add('pv2a-root');
    container.innerHTML = '<p style="color:#9aa0ab;font-size:13px;">Carregando…</p>';
    let data = await adapter.getAll();

    container.innerHTML = '';
    toastEl = el('div', { class: 'pv2a-toast' });
    document.body.appendChild(toastEl);

    const tabs = [
      { key: 'themes', label: 'Temas' },
      { key: 'backgrounds', label: 'Fundos' },
      { key: 'banners', label: 'Banners' },
      { key: 'badges', label: 'Badges' },
      { key: 'stickers', label: 'Figurinhas' },
    ];
    let activeTab = 'themes';
    const tabsBar = el('div', { class: 'pv2a-tabs' });
    const panels = {};
    tabs.forEach((t) => {
      const btn = el('button', {
        class: 'pv2a-tab' + (t.key === activeTab ? ' active' : ''), type: 'button',
        onclick: () => {
          activeTab = t.key;
          tabsBar.querySelectorAll('.pv2a-tab').forEach((b) => b.classList.toggle('active', b.dataset.k === t.key));
          Object.entries(panels).forEach(([k, p]) => p.classList.toggle('active', k === t.key));
        },
      }, [t.label]);
      btn.dataset.k = t.key;
      tabsBar.appendChild(btn);
    });
    container.appendChild(tabsBar);
    tabs.forEach((t) => { panels[t.key] = el('div', { class: 'pv2a-panel' + (t.key === activeTab ? ' active' : '') }); container.appendChild(panels[t.key]); });

    renderCrudTable(panels.themes, {
      title: 'Temas', hint: 'Temas prontos que aparecem na galeria pros usuários.', fields: THEME_FIELDS,
      items: data.themes, idKey: 'id', previewFn: themePreview,
      onCreate: async (d) => { const r = await adapter.createTheme(d); data.themes.push({ id: r.id, ...d }); },
      onUpdate: (id, d) => adapter.updateTheme(id, d),
      onDelete: async (id) => { await adapter.deleteTheme(id); data.themes = data.themes.filter((x) => x.id !== id); },
    });
    renderCrudTable(panels.backgrounds, {
      title: 'Fundos', hint: 'Fundos personalizados do app inteiro (cor, gradiente, imagem, GIF ou efeito).', fields: BACKGROUND_FIELDS,
      items: data.backgrounds, idKey: 'id', previewFn: backgroundPreview,
      onCreate: async (d) => { const r = await adapter.createBackground(d); data.backgrounds.push({ id: r.id, ...d }); },
      onUpdate: (id, d) => adapter.updateBackground(id, d),
      onDelete: async (id) => { await adapter.deleteBackground(id); data.backgrounds = data.backgrounds.filter((x) => x.id !== id); },
    });
    renderCrudTable(panels.banners, {
      title: 'Banners de perfil', hint: 'Opções de banner (cor/gradiente) na aba Perfil.', fields: BANNER_FIELDS,
      items: data.banners, idKey: 'id', previewFn: bannerPreview,
      onCreate: async (d) => { const r = await adapter.createBanner(d); data.banners.push({ id: r.id, ...d }); },
      onUpdate: (id, d) => adapter.updateBanner(id, d),
      onDelete: async (id) => { await adapter.deleteBanner(id); data.banners = data.banners.filter((x) => x.id !== id); },
    });
    renderCrudTable(panels.badges, {
      title: 'Badges', hint: 'Selo ao lado do nome, no chat e no perfil.', fields: BADGE_FIELDS,
      items: data.badges, idKey: 'id', previewFn: badgePreview,
      onCreate: async (d) => { const r = await adapter.createBadge(d); data.badges.push({ id: r.id, ...d }); },
      onUpdate: (id, d) => adapter.updateBadge(id, d),
      onDelete: async (id) => { await adapter.deleteBadge(id); data.badges = data.badges.filter((x) => x.id !== id); },
    });

    renderStickerAdminPanel(panels.stickers, data.stickerPacks, adapter);
  }

  function renderStickerAdminPanel(container, packs, adapter) {
    container.innerHTML = '';
    container.appendChild(el('div', { class: 'pv2a-section-title' }, ['Pacotes de figurinha']));
    container.appendChild(el('p', { class: 'pv2a-section-hint' }, ['Cada pacote tem seu próprio grupo de figurinhas (emoji ou imagem).']));

    const packsWrap = el('div');
    container.appendChild(packsWrap);

    function renderPacks() {
      packsWrap.innerHTML = '';
      packs.forEach((pack) => {
        const packCard = el('div', { class: 'pv2a-pack-card' });
        packCard.appendChild(el('div', { class: 'pv2a-pack-head' }, [
          el('strong', {}, [pack.name + (pack.premium ? ' · PLUS' : '')]),
          el('button', {
            class: 'pv2a-btn pv2a-btn-small pv2a-btn-danger', type: 'button',
            onclick: async () => {
              if (!confirm('Remover o pacote "' + pack.name + '" e todas as figurinhas dele?')) return;
              await adapter.deleteStickerPack(pack.id);
              packs.splice(packs.indexOf(pack), 1);
              renderPacks();
            },
          }, ['Remover pacote']),
        ]));
        const grid = el('div', { class: 'pv2a-sticker-admin-grid' });
        pack.stickers.forEach((s) => {
          grid.appendChild(el('div', { class: 'pv2a-sticker-admin-item' }, [
            s.type === 'image' ? el('img', { src: s.content, alt: '', style: 'width:28px;height:28px;object-fit:contain;' }) : el('span', { style: 'font-size:22px;' }, [s.content]),
            el('button', {
              class: 'pv2a-mini-x', type: 'button', title: 'Remover figurinha',
              onclick: async () => { await adapter.deleteSticker(s.id); pack.stickers.splice(pack.stickers.indexOf(s), 1); renderPacks(); },
            }, ['×']),
          ]));
        });
        packCard.appendChild(grid);

        const addRow = el('div', { class: 'pv2a-create-row' });
        const typeInput = fieldInput(STICKER_FIELDS[0], 'emoji');
        const contentInput = fieldInput(STICKER_FIELDS[1], '');
        addRow.appendChild(el('div', { class: 'pv2a-create-field' }, [el('label', {}, ['Tipo']), typeInput]));
        addRow.appendChild(el('div', { class: 'pv2a-create-field' }, [el('label', {}, ['Conteúdo']), contentInput]));
        addRow.appendChild(el('button', {
          class: 'pv2a-btn pv2a-btn-small', type: 'button',
          onclick: async () => {
            const stickerData = { type: typeInput.value, content: contentInput.value };
            if (!stickerData.content) return;
            const r = await adapter.createSticker(pack.id, stickerData);
            pack.stickers.push({ id: r.id, ...stickerData });
            contentInput.value = '';
            renderPacks();
          },
        }, ['+ Figurinha']));
        packCard.appendChild(addRow);

        // ---- envio em massa: escolhe várias imagens de uma vez e sobe tudo,
        // criando uma figurinha pra cada uma automaticamente.
        //
        // O input de arquivo fica DENTRO do <label> (em vez de escondido em
        // outro lugar e "clicado" por JavaScript) — clicar num <label>
        // associado sempre abre o seletor nativo, em qualquer navegador, sem
        // depender de um .click() disparado por script (que em alguns casos
        // não abre o seletor de forma confiável). ----
        const bulkRow = el('div', { class: 'pv2a-create-row', style: 'margin-top:10px;padding-top:10px;border-top:1px solid #24252c;' });
        const bulkInput = el('input', {
          type: 'file', accept: 'image/*', multiple: 'multiple',
          style: 'position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0;',
        });
        const bulkStatus = el('span', { style: 'font-size:11.5px;color:#9aa0ab;' }, ['']);
        const bulkBtn = el('label', {
          class: 'pv2a-btn pv2a-btn-small', style: 'display:inline-flex; align-items:center; cursor:pointer;',
        }, [bulkInput, '📦 Enviar várias figurinhas de uma vez']);
        bulkInput.addEventListener('change', async () => {
          const files = Array.from(bulkInput.files || []);
          if (!files.length) return;
          if (typeof adapter.uploadStickerImage !== 'function') {
            showAdminToast('Envio em massa não disponível nesse adapter.');
            return;
          }
          bulkInput.disabled = true;
          bulkBtn.style.opacity = '0.6';
          bulkBtn.style.pointerEvents = 'none';
          let done = 0;
          let failed = 0;
          const failedNames = [];
          for (const file of files) {
            bulkStatus.textContent = `Enviando ${done + failed + 1}/${files.length}…`;
            try {
              const url = await adapter.uploadStickerImage(file);
              const stickerData = { type: 'image', content: url };
              const r = await adapter.createSticker(pack.id, stickerData);
              pack.stickers.push({ id: r.id, ...stickerData });
              done++;
            } catch (err) {
              failed++;
              failedNames.push(file.name);
              console.error('Erro ao enviar figurinha:', file.name, err);
            }
          }
          bulkStatus.textContent = '';
          bulkInput.disabled = false;
          bulkBtn.style.opacity = '';
          bulkBtn.style.pointerEvents = '';
          bulkInput.value = '';
          // Erro visível de verdade (não só um toast que passa rápido) — se
          // TUDO falhou, o motivo mais comum é o upload de arquivo não estar
          // configurado no servidor (variáveis de ambiente do R2/S3).
          if (failed > 0 && done === 0) {
            alert('Nenhuma figurinha foi enviada. Erro: upload de imagem pode não estar configurado no servidor (variáveis do R2/S3 no Render). Arquivos que falharam: ' + failedNames.join(', '));
          }
          renderPacks();
          showAdminToast(`${done} figurinha(s) adicionada(s)` + (failed ? `, ${failed} falhou/falharam` : '') + ' ✓');
        });
        bulkRow.appendChild(bulkInput);
        bulkRow.appendChild(bulkBtn);
        bulkRow.appendChild(bulkStatus);
        packCard.appendChild(bulkRow);

        packsWrap.appendChild(packCard);
      });
    }
    renderPacks();

    container.appendChild(el('div', { class: 'pv2a-section-title', style: 'font-size:13px;margin-top:20px;' }, ['Novo pacote']));
    const createRow = el('div', { class: 'pv2a-create-row' });
    const inputs = {};
    PACK_FIELDS.forEach((f) => {
      const input = fieldInput(f, f.default);
      inputs[f.key] = input;
      createRow.appendChild(el('div', { class: 'pv2a-create-field' }, [el('label', {}, [f.label]), input]));
    });
    createRow.appendChild(el('button', {
      class: 'pv2a-btn', type: 'button',
      onclick: async () => {
        const data = {};
        PACK_FIELDS.forEach((f) => { data[f.key] = fieldValue(f, inputs[f.key]); });
        if (!data.name) return;
        const r = await adapter.createStickerPack(data);
        packs.push({ id: r.id, ...data, stickers: [] });
        renderPacks();
        showAdminToast('Pacote criado ✓');
      },
    }, ['+ Adicionar pacote']));
    container.appendChild(createRow);
  }

  // ------------------------------------------------------------------
  // Adapter real — fala com /api/plus2/admin/* (só funciona depois que
  // routes-plus2.js estiver montado no server.js principal).
  // ------------------------------------------------------------------
  function createHttpAdapter({ fetch: fetchFn, base }) {
    const root = base || '/api/plus2';
    async function req(path, opts) {
      const res = await fetchFn(root + path, {
        method: (opts && opts.method) || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || ('Erro na API: ' + res.status));
      }
      return res.json();
    }
    return {
      // Usa /admin/all — visão "achatada" (sem colors: {} aninhado, com
      // sortOrder incluído) própria pra preencher formulário de edição.
      // Reaproveitar /catalog aqui seria um bug: aquele endpoint é
      // pensado pro usuário final (nested colors, sem sortOrder).
      getAll: () => req('/admin/all'),
      createTheme: (d) => req('/admin/themes', { method: 'POST', body: colorPayload(d) }),
      updateTheme: (id, d) => req('/admin/themes/' + id, { method: 'PATCH', body: colorPayload(d) }),
      deleteTheme: (id) => req('/admin/themes/' + id, { method: 'DELETE' }),
      createBackground: (d) => req('/admin/backgrounds', { method: 'POST', body: d }),
      updateBackground: (id, d) => req('/admin/backgrounds/' + id, { method: 'PATCH', body: d }),
      deleteBackground: (id) => req('/admin/backgrounds/' + id, { method: 'DELETE' }),
      createBanner: (d) => req('/admin/banners', { method: 'POST', body: d }),
      updateBanner: (id, d) => req('/admin/banners/' + id, { method: 'PATCH', body: d }),
      deleteBanner: (id) => req('/admin/banners/' + id, { method: 'DELETE' }),
      createBadge: (d) => req('/admin/badges', { method: 'POST', body: d }),
      updateBadge: (id, d) => req('/admin/badges/' + id, { method: 'PATCH', body: d }),
      deleteBadge: (id) => req('/admin/badges/' + id, { method: 'DELETE' }),
      createStickerPack: (d) => req('/admin/sticker-packs', { method: 'POST', body: d }),
      deleteStickerPack: (id) => req('/admin/sticker-packs/' + id, { method: 'DELETE' }),
      createSticker: (packId, d) => req('/admin/sticker-packs/' + packId + '/stickers', { method: 'POST', body: d }),
      deleteSticker: (id) => req('/admin/stickers/' + id, { method: 'DELETE' }),
      // Reaproveita o /api/uploads/presign que o site principal já usa (mesmo
      // fluxo do upload de banner em plus2.js) — sobe a imagem direto pro
      // storage (R2/S3) e devolve a URL pública, sem passar o arquivo pela
      // rota do plus2.
      async uploadStickerImage(file) {
        const presignRes = await fetchFn('/api/uploads/presign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
        });
        if (!presignRes.ok) throw new Error('Erro ao preparar upload: ' + presignRes.status);
        const presign = await presignRes.json();
        if (!presign.configured) throw new Error('Upload de imagem não está configurado no servidor.');
        const putRes = await fetchFn(presign.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
        if (!putRes.ok) throw new Error('Erro ao enviar a imagem: ' + putRes.status);
        return presign.publicUrl;
      },
    };
  }
  // Os campos do form usam nomes curtos (primary/secondary/...) mas a API
  // espera esses mesmos nomes — sem transformação necessária, só isolado
  // aqui caso a forma do payload precise mudar no futuro.
  function colorPayload(d) { return d; }

  // ------------------------------------------------------------------
  // Adapter mock — pro admin-preview.html standalone, tudo em memória.
  // ------------------------------------------------------------------
  function createMockAdapter(seed) {
    const state = JSON.parse(JSON.stringify(seed));
    function delay(v) { return new Promise((r) => setTimeout(() => r(v), 100)); }
    function genId() { return 'a-' + Math.random().toString(36).slice(2, 10); }
    return {
      async getAll() { return delay(JSON.parse(JSON.stringify(state))); },
      async createTheme(d) { const id = genId(); state.themes.push({ id, ...d }); return delay({ ok: true, id }); },
      async updateTheme(id, d) { Object.assign(state.themes.find((t) => t.id === id) || {}, d); return delay({ ok: true }); },
      async deleteTheme(id) { state.themes = state.themes.filter((t) => t.id !== id); return delay({ ok: true }); },
      async createBackground(d) { const id = genId(); state.backgrounds.push({ id, ...d }); return delay({ ok: true, id }); },
      async updateBackground(id, d) { Object.assign(state.backgrounds.find((t) => t.id === id) || {}, d); return delay({ ok: true }); },
      async deleteBackground(id) { state.backgrounds = state.backgrounds.filter((t) => t.id !== id); return delay({ ok: true }); },
      async createBanner(d) { const id = genId(); state.banners.push({ id, ...d }); return delay({ ok: true, id }); },
      async updateBanner(id, d) { Object.assign(state.banners.find((t) => t.id === id) || {}, d); return delay({ ok: true }); },
      async deleteBanner(id) { state.banners = state.banners.filter((t) => t.id !== id); return delay({ ok: true }); },
      async createBadge(d) { const id = genId(); state.badges.push({ id, ...d }); return delay({ ok: true, id }); },
      async updateBadge(id, d) { Object.assign(state.badges.find((t) => t.id === id) || {}, d); return delay({ ok: true }); },
      async deleteBadge(id) { state.badges = state.badges.filter((t) => t.id !== id); return delay({ ok: true }); },
      async createStickerPack(d) { const id = genId(); state.stickerPacks.push({ id, ...d, stickers: [] }); return delay({ ok: true, id }); },
      async deleteStickerPack(id) { state.stickerPacks = state.stickerPacks.filter((p) => p.id !== id); return delay({ ok: true }); },
      async createSticker(packId, d) {
        const id = genId();
        const pack = state.stickerPacks.find((p) => p.id === packId);
        if (pack) pack.stickers.push({ id, ...d });
        return delay({ ok: true, id });
      },
      async deleteSticker(id) {
        state.stickerPacks.forEach((p) => { p.stickers = p.stickers.filter((s) => s.id !== id); });
        return delay({ ok: true });
      },
      // Sem servidor de verdade aqui — lê o arquivo e devolve como data URL,
      // só pra já poder ver a figurinha de verdade no preview.
      async uploadStickerImage(file) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Não deu pra ler essa imagem'));
          reader.readAsDataURL(file);
        });
      },
    };
  }

  global.PlusV2Admin = { mount, createHttpAdapter, createMockAdapter };
})(typeof window !== 'undefined' ? window : globalThis);
