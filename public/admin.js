// admin.js - painel de moderação

// Conta de moderador (staff parcial — só ajuda com BLUEX/moderação básica,
// ver requireModerator no server.js) não tem is_admin=1, então só pode ver
// as abas "Segurança/BLUEX" e "Moderação". As outras nem aparecem na barra
// lateral pra ela, e as chamadas de API que só admin de verdade pode usar
// (usuários, loja, personalização, suporte, audit log, monitoramento) nem
// são feitas — evita 403 inúteis e deixa claro o que essa conta pode fazer.
const MODERATOR_ALLOWED_TABS = ['seguranca', 'moderacao'];
let isFullAdmin = false;

async function init() {
  const meRes = await fetch('/api/me', { credentials: 'include' });
  if (!meRes.ok) {
    document.getElementById('admin-guard').textContent = 'Você precisa estar logado.';
    return;
  }
  const me = await meRes.json();
  if (!me.is_admin && !me.is_moderator) {
    document.getElementById('admin-guard').textContent = 'Acesso restrito a administradores/moderadores.';
    return;
  }
  // SEGURANÇA: 2FA agora é obrigatório pra usar o painel (ver requireAdmin/
  // requireModerator no server.js) — se essa conta ainda não ativou, nem
  // tenta carregar os dados (todas as chamadas a /api/admin/* dariam 403
  // mesmo). Mostra direto a orientação de como ativar, em vez de uma tela
  // quebrada cheia de tabelas vazias/erros.
  if (!me.totp_enabled) {
    document.getElementById('admin-2fa-required').classList.remove('hidden');
    return;
  }
  isFullAdmin = !!me.is_admin;
  document.getElementById('admin-layout').classList.remove('hidden');
  initAdminTabs();

  if (!isFullAdmin) {
    // Moderador: some com as abas que não pode ver e abre direto em
    // Segurança/BLUEX (a primeira que ela tem acesso).
    document.querySelectorAll('.admin-nav-btn').forEach((btn) => {
      if (!MODERATOR_ALLOWED_TABS.includes(btn.dataset.tab)) btn.remove();
    });
    loadBluexPanel();
    setInterval(loadBluexPanel, 10000);
    loadSuspiciousAccounts();
    loadMinors();
    loadReports();
    loadBlocked();
    loadFlaggedFrames();
    loadFlagged();
    return;
  }

  loadMonitoring();
  setInterval(loadMonitoring, 10000);
  loadBluexPanel();
  setInterval(loadBluexPanel, 10000);
  loadAnalytics();
  loadSuspiciousAccounts();
  loadMinors();
  loadClipsAdmin();
  loadShopAdmin();
  loadRedeemCodes();
  loadReports();
  loadSupportTickets();
  setInterval(loadSupportTickets, 20000);
  loadBlocked();
  loadFlaggedFrames();
  loadFlagged();
  loadUsers();
  loadAuditLogs();
}

// ---------- Navegação por abas (sidebar) ----------
// O admin.html antes era uma página só com 15+ seções empilhadas — virou
// abas agrupadas por tema pra facilitar achar as coisas. Cada botão da
// sidebar tem um data-tab que casa com o id "admin-tab-<nome>" do painel
// correspondente; só o painel ativo fica visível.
function initAdminTabs() {
  const buttons = document.querySelectorAll('.admin-nav-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.admin-tab-panel').forEach((p) => p.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById('admin-tab-' + btn.dataset.tab).classList.remove('hidden');
      if (btn.dataset.tab === 'personalizacao') mountPlusV2AdminPanel();
    });
  });
}

// Carrega só quando a aba abre (evita puxar temas/fundos/figurinhas à toa
// pra quem nunca clica nela) e só uma vez — reabrir a aba não recarrega.
let plusV2AdminMounted = false;
function mountPlusV2AdminPanel() {
  if (plusV2AdminMounted) return;
  const root = document.getElementById('plus2-admin-root');
  if (!root || typeof PlusV2Admin === 'undefined') return;
  plusV2AdminMounted = true;
  const adapter = PlusV2Admin.createHttpAdapter({ fetch: window.fetch.bind(window) });
  PlusV2Admin.mount(root, adapter).catch((err) => {
    console.error('Erro ao carregar painel de personalização:', err);
    plusV2AdminMounted = false;
  });
}

// Toast simples no canto da tela — usado pra avisar de ticket de suporte
// novo sem precisar recarregar nem ficar de olho na aba o tempo todo.
function showAdminToast(text) {
  let el = document.getElementById('admin-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'admin-toast';
    el.className = 'admin-toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.remove('hidden');
  el.classList.add('show');
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => el.classList.remove('show'), 6000);
}

// Mostra um número em destaque no botão da sidebar (ex: quantas contas
// suspensas aguardando revisão) — ajuda a notar o que precisa de atenção
// sem precisar entrar em cada aba pra descobrir.
function setNavBadge(tabName, count) {
  const btn = document.querySelector(`.admin-nav-btn[data-tab="${tabName}"]`);
  if (!btn) return;
  let badge = btn.querySelector('.badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'badge';
    btn.appendChild(badge);
  }
  badge.textContent = count;
  badge.classList.toggle('hidden', !count);
}

// A aba "Moderação" junta várias fontes (denúncias, mensagens bloqueadas,
// transmissões marcadas) — cada load*() abaixo atualiza sua própria fatia
// aqui, e o badge mostra a soma, sem uma sobrescrever a contagem da outra.
const moderationCounts = { reports: 0, frames: 0 };
function updateModeracaoBadge() {
  setNavBadge('moderacao', moderationCounts.reports + moderationCounts.frames);
}

function fmtDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h${m}min`;
  return `${m}min`;
}

async function loadMonitoring() {
  let m;
  try {
    const res = await fetch('/api/admin/monitoring', { credentials: 'include' });
    if (!res.ok) return;
    m = await res.json();
  } catch (_) {
    return;
  }

  document.getElementById('monitoring-updated').textContent =
    'Última atualização: ' + new Date().toLocaleTimeString('pt-BR');

  const ramPct = Math.round((m.server.memory_rss_mb / m.server.render_free_tier_ram_mb) * 100);
  const stats = [
    ['Online agora', m.realtime.users_online],
    ['Em chamada agora', m.realtime.people_in_calls],
    ['Salas de voz ativas', m.realtime.voice_rooms_active],
    ['Conexões abertas (sockets)', m.realtime.sockets_connected],
    ['Requisições/min', m.requests.last_minute],
    ['No ar há', fmtDuration(m.server.uptime_seconds)],
    ['Memória usada', `${m.server.memory_rss_mb}MB (${ramPct}% do free tier)`],
    ['Erros recentes', m.recent_errors.length],
  ];
  document.getElementById('monitoring-grid').innerHTML = stats
    .map(([label, num]) => `<div class="stat-card"><div class="num">${num}</div><div class="label">${label}</div></div>`)
    .join('');

  // Avisos de configuração que afetam diretamente confiabilidade/capacidade
  const warnings = [];
  if (!m.environment.turso_configured) {
    warnings.push('⚠️ Turso não configurado — o banco de dados é apagado a cada redeploy no Render.');
  }
  if (!m.environment.turn_configured) {
    warnings.push('⚠️ Servidor TURN próprio não configurado — chamadas de voz estão usando um relay público compartilhado (openrelay), que pode ficar instável com mais uso. Configure TURN_URL/TURN_USERNAME/TURN_CREDENTIAL.');
  }
  if (ramPct > 80) {
    warnings.push(`⚠️ Uso de memória em ${ramPct}% do limite do plano gratuito do Render (512MB) — risco de o processo travar/reiniciar sozinho.`);
  }
  const warnEl = document.getElementById('monitoring-env-warning');
  if (warnings.length > 0) {
    warnEl.innerHTML = warnings.map((w) => `<div>${w}</div>`).join('');
    warnEl.classList.remove('hidden');
  } else {
    warnEl.classList.add('hidden');
  }

  const roomsBody = document.querySelector('#monitoring-rooms-table tbody');
  roomsBody.innerHTML = m.realtime.voice_rooms.length
    ? m.realtime.voice_rooms
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r.roomId)}</td><td>${r.participants} / ${m.realtime.max_participants_per_room}</td></tr>`
        )
        .join('')
    : '<tr><td colspan="2" style="color:#949ba4;">Nenhuma sala de voz ativa agora.</td></tr>';

  const slowBody = document.querySelector('#monitoring-slow-table tbody');
  slowBody.innerHTML = m.recent_slow_requests.length
    ? m.recent_slow_requests
        .map(
          (r) =>
            `<tr><td>${new Date(r.time).toLocaleTimeString('pt-BR')}</td><td>${escapeHtml(r.method + ' ' + r.path)}</td><td>${r.status}</td><td>${r.durationMs}ms</td></tr>`
        )
        .join('')
    : '<tr><td colspan="4" style="color:#949ba4;">Nenhuma requisição lenta recente.</td></tr>';

  const errorsBody = document.querySelector('#monitoring-errors-table tbody');
  errorsBody.innerHTML = m.recent_errors.length
    ? m.recent_errors
        .map(
          (e) => `
        <tr>
          <td>${new Date(e.time).toLocaleTimeString('pt-BR')}</td>
          <td>${escapeHtml(e.source)}</td>
          <td>${escapeHtml(e.message)}</td>
          <td><button type="button" class="action" data-action="diagnose" data-id="${e.id}">${e.diagnosis ? '🤖 Ver diagnóstico' : '🤖 Perguntar à IA'}</button></td>
        </tr>`
        )
        .join('')
    : '<tr><td colspan="4" style="color:#949ba4;">Nenhum erro recente. 🎉</td></tr>';
  errorsBody.querySelectorAll('button[data-action="diagnose"]').forEach((btn) => {
    btn.onclick = () => diagnoseError(btn.dataset.id, btn);
  });
}

// ---------- Diagnóstico de erro por IA ----------
// Só explica/sugere — quem aplica qualquer correção é uma pessoa (você, ou
// pedindo pra alguém aplicar de verdade), nunca automático.
async function diagnoseError(id, btn) {
  const panel = document.getElementById('error-diagnosis-panel');
  const body = document.getElementById('error-diagnosis-body');
  panel.classList.remove('hidden');
  body.innerHTML = '<p style="color:#949ba4;">Analisando com a IA...</p>';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Analisando...';
  try {
    const res = await fetch(`/api/admin/errors/${id}/diagnose`, { method: 'POST', credentials: 'include' });
    const data = await res.json();
    if (!res.ok) {
      body.innerHTML = `<p style="color:#f23f42;">${escapeHtml(data.error || 'Erro ao gerar diagnóstico.')}</p>`;
      btn.textContent = originalLabel;
      btn.disabled = false;
      return;
    }
    // Preserva quebras de linha da resposta da IA sem interpretar como HTML.
    body.innerHTML = `<pre class="error-diagnosis-text">${escapeHtml(data.diagnosis)}</pre>`;
    btn.textContent = '🤖 Ver diagnóstico';
    btn.disabled = false;
  } catch (err) {
    body.innerHTML = '<p style="color:#f23f42;">Erro de conexão ao pedir o diagnóstico.</p>';
    btn.textContent = originalLabel;
    btn.disabled = false;
  }
}
document.getElementById('btn-close-diagnosis').onclick = () => {
  document.getElementById('error-diagnosis-panel').classList.add('hidden');
};

// ---------- 🔷 BLUEX — Painel de Proteção ----------
// Junta em um lugar só: status da proteção (Groq embutido + BLUEX externo,
// se configurado), contas suspensas automaticamente aguardando revisão
// (o item mais urgente), e um resumo de quantas sinalizações recentes
// existem — sem duplicar as tabelas detalhadas que já existem mais abaixo
// (Mensagens bloqueadas / Transmissões marcadas), só reaproveita os mesmos
// dados numa visão consolidada.
async function loadBluexPanel() {
  try {
    // Rotas enxutas (ver server.js) — antes usava /api/admin/monitoring e
    // /api/admin/users (dados de servidor e lista completa com e-mail de
    // todo mundo) só pra pegar 2-3 campos. Trocado pra funcionar também com
    // a conta de moderador parcial, que não tem acesso a essas duas.
    const [statusRes, suspendedRes, framesRes, blockedRes] = await Promise.all([
      fetch('/api/admin/bluex/status', { credentials: 'include' }),
      fetch('/api/admin/bluex/suspended', { credentials: 'include' }),
      fetch('/api/admin/flagged-frames', { credentials: 'include' }),
      fetch('/api/admin/blocked-messages', { credentials: 'include' }),
    ]);
    if (!statusRes.ok || !suspendedRes.ok || !framesRes.ok || !blockedRes.ok) return;
    const status = await statusRes.json();
    const suspended = await suspendedRes.json();
    const frames = await framesRes.json();
    const blocked = await blockedRes.json();

    // Status — o que está de fato rodando agora
    const statusRow = document.getElementById('bluex-status-row');
    const statusCards = [
      {
        label: 'Moderação de imagem/texto (Groq embutido)',
        ok: status.groq_configured,
        okText: 'Ativa',
        offText: 'Falta GROQ_API_KEY',
      },
      {
        label: 'BLUEX externo (opcional, centraliza vários apps)',
        ok: status.bluex_configured,
        okText: 'Conectado',
        offText: 'Não configurado — usando só o Groq embutido, funciona igual',
      },
    ];
    statusRow.innerHTML = statusCards
      .map(
        (c) => `
        <div class="stat-card" style="background:${c.ok ? '#23a55a22' : '#f23f4222'};">
          <div class="num" style="font-size:15px; color:${c.ok ? '#23a55a' : '#f23f42'};">${c.ok ? '✅ ' + c.okText : '⚠️ ' + c.offText}</div>
          <div class="label">${c.label}</div>
        </div>`
      )
      .join('');

    // Contas suspensas automaticamente — o item mais urgente de todos
    const suspTbody = document.querySelector('#bluex-suspended-table tbody');
    suspTbody.innerHTML = suspended
      .map(
        (u) => `
        <tr>
          <td>${escapeHtml(u.username)}</td>
          <td>${escapeHtml(u.ban_reason || '—')}</td>
          <td><button class="action" data-action="unban" data-id="${u.id}">Revisei — desbanir</button></td>
        </tr>`
      )
      .join('');
    document.getElementById('bluex-suspended-empty').classList.toggle('hidden', suspended.length > 0);
    document.getElementById('bluex-suspended-table').classList.toggle('hidden', suspended.length === 0);
    suspTbody.querySelectorAll('button[data-action="unban"]').forEach((btn) =>
      btn.addEventListener('click', () => unbanUser(btn.dataset.id))
    );
    setNavBadge('seguranca', suspended.length);

    // Resumo de sinalizações — só contagem, detalhe fica nas tabelas de baixo
    const framesUnreviewed = frames.filter((f) => !f.reviewed).length;
    const flagsGrid = document.getElementById('bluex-flags-grid');
    flagsGrid.innerHTML = [
      ['Imagens/telas sinalizadas (total)', frames.length],
      ['Ainda sem revisão', framesUnreviewed],
      ['Mensagens de texto bloqueadas', blocked.length],
      ['Contas suspensas aguardando revisão', suspended.length],
    ]
      .map(([label, num]) => `<div class="stat-card"><div class="num">${num}</div><div class="label">${label}</div></div>`)
      .join('');
  } catch (err) {
    console.error('Erro ao carregar painel BLUEX:', err);
  }
}

async function loadAnalytics() {
  const res = await fetch('/api/admin/analytics', { credentials: 'include' });
  const a = await res.json();
  const grid = document.getElementById('analytics-grid');
  const stats = [
    ['Usuários', a.total_users],
    ['Banidos', a.banned_users],
    ['Servidores', a.total_servers],
    ['Canais', a.total_channels],
    ['Msgs hoje', a.messages_today],
    ['Msgs 7 dias', a.messages_week],
    ['Torneios', a.total_tournaments],
    ['Sessões ativas', a.active_sessions],
    ['Clipes', a.total_clips],
    ['Times', a.total_teams],
    ['Clãs', a.total_clans],
    ['Organizações', a.total_orgs],
    ['Eventos', a.total_events],
  ];
  grid.innerHTML = stats
    .map(([label, num]) => `<div class="stat-card"><div class="num">${num}</div><div class="label">${label}</div></div>`)
    .join('');
}

async function loadSuspiciousAccounts() {
  const res = await fetch('/api/admin/suspicious-accounts', { credentials: 'include' });
  const rows = await res.json();
  const tbody = document.querySelector('#suspicious-table tbody');
  tbody.innerHTML = '';
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:#949ba4;">Nenhum sinal de contas duplicadas.</td></tr>';
    return;
  }
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(r.ip)}</td><td>${escapeHtml(r.usernames)}</td><td>${r.account_count}</td>`;
    tbody.appendChild(tr);
  });
}

async function loadClipsAdmin() {
  const res = await fetch('/api/admin/clips', { credentials: 'include' });
  const rows = await res.json();
  const tbody = document.querySelector('#clips-admin-table tbody');
  tbody.innerHTML = '';
  rows.forEach((c) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(c.created_at).toLocaleString('pt-BR')}</td>
      <td>${escapeHtml(c.username)}</td>
      <td>${escapeHtml(c.title)}</td>
      <td>${c.views}</td>
      <td><button class="action danger" data-action="delete-clip" data-id="${c.id}">Excluir</button></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('button[data-action="delete-clip"]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Excluir esse clipe?')) return;
      await fetch(`/api/admin/clips/${btn.dataset.id}`, { method: 'DELETE', credentials: 'include' });
      loadClipsAdmin();
    })
  );
}

async function loadShopAdmin() {
  const res = await fetch('/api/admin/shop-items', { credentials: 'include' });
  const rows = await res.json();
  const tbody = document.querySelector('#shop-admin-table tbody');
  tbody.innerHTML = '';
  rows
    .filter((i) => i.active)
    .forEach((i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(i.name)}</td>
        <td>🪙 ${i.cost}</td>
        <td><button class="action danger" data-action="delete-item" data-id="${i.id}">Remover</button></td>
      `;
      tbody.appendChild(tr);
    });
  tbody.querySelectorAll('button[data-action="delete-item"]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await fetch(`/api/admin/shop-items/${btn.dataset.id}`, { method: 'DELETE', credentials: 'include' });
      loadShopAdmin();
    })
  );
}

document.getElementById('btn-shop-add').addEventListener('click', async () => {
  const name = document.getElementById('shop-new-name').value.trim();
  const description = document.getElementById('shop-new-description').value.trim();
  const cost = document.getElementById('shop-new-cost').value;
  if (!name || !cost) return alert('Preencha nome e custo');
  await fetch('/api/admin/shop-items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ name, description, cost }),
  });
  document.getElementById('shop-new-name').value = '';
  document.getElementById('shop-new-description').value = '';
  document.getElementById('shop-new-cost').value = '';
  loadShopAdmin();
});

// ---------- Cupons de resgate (ex: recarga full no Magic Tank -> PLUS) ----------
async function loadRedeemCodes() {
  const res = await fetch('/api/admin/redeem-codes', { credentials: 'include' });
  const rows = await res.json();
  const tbody = document.querySelector('#redeem-codes-table tbody');
  tbody.innerHTML = '';
  rows.forEach((c) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-family:monospace; font-weight:700;">${escapeHtml(c.code)}</td>
      <td>${c.days > 0 ? c.days + ' dias' : 'sem prazo'}</td>
      <td>${escapeHtml(c.note || '—')}</td>
      <td>${
        c.used_by
          ? `<span style="color:#949ba4;">Resgatado por ${escapeHtml(c.used_by_username || '?')}</span>`
          : '<span style="color:#23a55a; font-weight:700;">Disponível</span>'
      }</td>
      <td>${escapeHtml(c.created_by || '—')}</td>
      <td>${
        c.used_by
          ? '—'
          : `<button class="action danger" data-action="delete-redeem" data-id="${c.id}">Apagar</button>`
      }</td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('button[data-action="delete-redeem"]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Apagar esse código? (só dá pra apagar os que ainda não foram resgatados)')) return;
      await fetch(`/api/admin/redeem-codes/${btn.dataset.id}`, { method: 'DELETE', credentials: 'include' });
      loadRedeemCodes();
    })
  );
}

document.getElementById('btn-redeem-generate').addEventListener('click', async () => {
  const days = document.getElementById('redeem-new-days').value;
  const note = document.getElementById('redeem-new-note').value.trim();
  const quantity = document.getElementById('redeem-new-quantity').value;
  const res = await fetch('/api/admin/redeem-codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ days, note, quantity }),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'Erro ao gerar código(s)');
  const box = document.getElementById('redeem-generated-box');
  box.classList.remove('hidden');
  box.innerHTML =
    `<strong>${data.codes.length} código(s) gerado(s):</strong><br>` +
    data.codes.map((c) => `<span style="font-family:monospace; font-weight:700;">${escapeHtml(c)}</span>`).join(' · ');
  document.getElementById('redeem-new-note').value = '';
  loadRedeemCodes();
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function loadReports() {
  const res = await fetch('/api/admin/reports', { credentials: 'include' });
  const reports = await res.json();
  const tbody = document.querySelector('#reports-table tbody');
  tbody.innerHTML = '';
  reports.forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(r.created_at).toLocaleString('pt-BR')}</td>
      <td>${escapeHtml(r.reason)}</td>
      <td>${escapeHtml(r.reporter_user_id)}</td>
      <td>${escapeHtml(r.reported_user_id || '-')}</td>
      <td>${escapeHtml(r.status)}</td>
      <td>
        <button class="action" data-action="resolve" data-id="${r.id}">Resolver</button>
        <button class="action" data-action="dismiss" data-id="${r.id}">Descartar</button>
        ${r.reported_user_id ? `<button class="action danger" data-action="ban" data-id="${r.reported_user_id}">Banir usuário</button>` : ''}
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('button[data-action="resolve"]').forEach((btn) =>
    btn.addEventListener('click', () => updateReport(btn.dataset.id, 'resolvido'))
  );
  tbody.querySelectorAll('button[data-action="dismiss"]').forEach((btn) =>
    btn.addEventListener('click', () => updateReport(btn.dataset.id, 'descartado'))
  );
  tbody.querySelectorAll('button[data-action="ban"]').forEach((btn) =>
    btn.addEventListener('click', () => banUser(btn.dataset.id))
  );

  moderationCounts.reports = reports.filter((r) => r.status === 'pendente').length;
  updateModeracaoBadge();
}

async function updateReport(id, status) {
  await fetch(`/api/admin/reports/${id}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ status }),
  });
  loadReports();
}

const SUPPORT_CATEGORY_LABELS = {
  reclamacao: 'Reclamação',
  duvida: 'Dúvida',
  conta_banida: 'Recurso de banimento',
  cobranca: 'Cobrança/Plus',
  denuncia: 'Denúncia',
  outro: 'Outro',
};

// Pra saber se apareceu ticket NOVO desde a última checagem (não só reabrir
// a mesma lista) e poder avisar com um toast, sem precisar de socket.io —
// polling a cada 20s já é rápido o bastante pra um painel de admin.
let lastSeenSupportTicketIds = null;

async function loadSupportTickets() {
  const res = await fetch('/api/admin/support/tickets', { credentials: 'include' });
  const tickets = await res.json();

  // Badge de "quantos tickets em aberto" no botão "📨 Suporte" da sidebar —
  // dá pra ver de longe que chegou coisa nova sem precisar clicar na aba.
  const openCount = tickets.filter((t) => t.status === 'aberto').length;
  setNavBadge('suporte', openCount);

  if (lastSeenSupportTicketIds) {
    const newOnes = tickets.filter((t) => !lastSeenSupportTicketIds.has(t.id));
    if (newOnes.length > 0) {
      showAdminToast(
        newOnes.length === 1
          ? `📨 Novo ticket de suporte: "${newOnes[0].subject}"`
          : `📨 ${newOnes.length} novos tickets de suporte`
      );
    }
  }
  lastSeenSupportTicketIds = new Set(tickets.map((t) => t.id));

  const tbody = document.querySelector('#support-tickets-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  tickets.forEach((t) => {
    const tr = document.createElement('tr');
    const statusColor = t.status === 'aberto' ? '#f23f42' : t.status === 'respondido' ? '#faa61a' : '#3ba55c';
    tr.innerHTML = `
      <td>${new Date(t.created_at).toLocaleString('pt-BR')}</td>
      <td>${escapeHtml(t.username || t.name || '-')}<br><span style="color:#949ba4; font-size:11px;">${escapeHtml(t.email)}</span></td>
      <td>${escapeHtml(SUPPORT_CATEGORY_LABELS[t.category] || t.category)}</td>
      <td>${escapeHtml(t.subject)}</td>
      <td style="max-width:260px; white-space:pre-wrap;">${escapeHtml(t.message)}</td>
      <td style="color:${statusColor}; font-weight:700;">${escapeHtml(t.status)}</td>
      <td>
        <button class="action" data-action="support-respond" data-id="${t.id}">Responder/Fechar</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('button[data-action="support-respond"]').forEach((btn) =>
    btn.addEventListener('click', () => respondSupportTicket(btn.dataset.id))
  );
}

async function respondSupportTicket(id) {
  const admin_response = prompt('Resposta (opcional, fica só registrada aqui pro seu controle — a plataforma ainda não manda essa resposta por e-mail automaticamente):');
  if (admin_response === null) return;
  const status = confirm('Marcar como FECHADO? (Cancelar = marca só como "respondido", continua na lista)') ? 'fechado' : 'respondido';
  await fetch(`/api/admin/support/tickets/${id}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ admin_response, status }),
  });
  loadSupportTickets();
}

async function loadBlocked() {
  const res = await fetch('/api/admin/blocked-messages', { credentials: 'include' });
  const rows = await res.json();
  const tbody = document.querySelector('#blocked-table tbody');
  tbody.innerHTML = '';
  rows.forEach((m) => {
    const categories = (() => {
      try {
        return JSON.parse(m.flag_categories || '[]').join(', ');
      } catch (_) {
        return '';
      }
    })();
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(m.created_at).toLocaleString('pt-BR')}</td>
      <td>${escapeHtml(m.username)}</td>
      <td>${escapeHtml(m.content)}</td>
      <td>${escapeHtml(categories)}</td>
      <td><button class="action danger" data-action="ban" data-id="${m.user_id}">Banir usuário</button></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('button[data-action="ban"]').forEach((btn) =>
    btn.addEventListener('click', () => banUser(btn.dataset.id))
  );
}

async function loadMinors() {
  const res = await fetch('/api/admin/minors', { credentials: 'include' });
  const data = await res.json();
  const summaryEl = document.getElementById('minors-summary');
  summaryEl.innerHTML = `
    <div class="stat-card"><div class="num">${data.total_minors}</div><div class="label">Contas de menores</div></div>
    <div class="stat-card"><div class="num">${data.total_with_birth_date}</div><div class="label">Total com data informada</div></div>
  `;
  const tbody = document.querySelector('#minors-table tbody');
  tbody.innerHTML = '';
  data.minors.forEach((u) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(u.username_tag || u.username)}</td>
      <td>${u.age} anos</td>
      <td>${escapeHtml(u.email || '-')}</td>
      <td>${u.created_at ? new Date(u.created_at).toLocaleDateString('pt-BR') : '-'}</td>
    `;
    tbody.appendChild(tr);
  });

  const mismatchTbody = document.querySelector('#age-mismatch-table tbody');
  mismatchTbody.innerHTML = '';
  (data.age_mismatches || []).forEach((u) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(u.username_tag || u.username)}</td>
      <td>${u.declared_age} anos</td>
      <td>~${u.estimated_age} anos</td>
      <td>${escapeHtml(u.email || '-')}</td>
    `;
    mismatchTbody.appendChild(tr);
  });
}

async function loadFlaggedFrames() {
  const res = await fetch('/api/admin/flagged-frames', { credentials: 'include' });
  const rows = await res.json();
  const tbody = document.querySelector('#flagged-frames-table tbody');
  tbody.innerHTML = '';
  rows.forEach((f) => {
    const categories = (() => {
      try {
        return JSON.parse(f.categories || '[]').join(', ');
      } catch (_) {
        return '';
      }
    })();
    const tr = document.createElement('tr');
    if (f.reviewed) tr.style.opacity = '0.5';
    tr.innerHTML = `
      <td>${new Date(f.created_at).toLocaleString('pt-BR')}</td>
      <td>${escapeHtml(f.username)}</td>
      <td>${escapeHtml(f.reason || '-')}</td>
      <td>${escapeHtml(categories)}</td>
      <td>
        ${f.reviewed ? 'Revisado' : `<button class="action" data-action="review" data-id="${f.id}">Marcar revisado</button>`}
        <button class="action danger" data-action="ban" data-id="${f.user_id}">Banir usuário</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('button[data-action="review"]').forEach((btn) =>
    btn.addEventListener('click', () => reviewFlaggedFrame(btn.dataset.id))
  );
  tbody.querySelectorAll('button[data-action="ban"]').forEach((btn) =>
    btn.addEventListener('click', () => banUser(btn.dataset.id))
  );

  moderationCounts.frames = rows.filter((f) => !f.reviewed).length;
  updateModeracaoBadge();
}

async function reviewFlaggedFrame(id) {
  await fetch(`/api/admin/flagged-frames/${id}/review`, { method: 'POST', credentials: 'include' });
  loadFlaggedFrames();
}

async function loadFlagged() {
  const res = await fetch('/api/admin/flagged-messages', { credentials: 'include' });
  const rows = await res.json();
  const tbody = document.querySelector('#flagged-table tbody');
  tbody.innerHTML = '';
  rows.forEach((m) => {
    const categories = (() => {
      try {
        return JSON.parse(m.flag_categories || '[]').join(', ');
      } catch (_) {
        return '';
      }
    })();
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(m.created_at).toLocaleString('pt-BR')}</td>
      <td>${escapeHtml(m.username)}</td>
      <td>${escapeHtml(m.content)}</td>
      <td>${escapeHtml(categories)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// Repaginado (a pedido — "erro por que todo mundo tá podendo usar o Plus"):
// a coluna "Plano" só mostrava "✨ PLUS" sem dizer DE ONDE veio, então não
// dava pra saber se era uma conta legítima (pagou, você concedeu, ou
// resgatou por cupom) ou algo fora do esperado. Agora mostra a origem bem
// clara, com destaque em amarelo pra qualquer PLUS que não seja uma dessas
// 3 fontes — pra você revisar e remover se não fizer sentido.
const PLAN_SOURCE_LABELS = {
  paypal: { text: '✨ PLUS — pago (PayPal)', color: '#3ba55c' },
  admin: { text: '✨ PLUS — concedido por admin', color: '#5865f2' },
  coupon: { text: '✨ PLUS — cupom resgatado', color: '#faa61a' },
};
function planLabelHtml(u) {
  if (u.plan !== 'plus') return '<span style="color:#949ba4;">Free</span>';
  const known = PLAN_SOURCE_LABELS[u.plan_source];
  if (known) {
    const expires = u.plan_expires_at ? ` (até ${new Date(u.plan_expires_at).toLocaleDateString('pt-BR')})` : '';
    return `<span style="color:${known.color}; font-weight:700;">${known.text}${expires}</span>`;
  }
  // plan_source fora das 3 fontes esperadas (ex: "reward" do prêmio de
  // streak de 365 dias, ou vazio/inconsistente) — não é bug em si, mas fica
  // sinalizado pra você decidir se quer manter.
  const label = u.plan_source === 'reward' ? 'prêmio de streak (365 dias)' : u.plan_source || 'origem desconhecida';
  return `<span style="color:#faa61a; font-weight:700;" title="Fora das 3 fontes esperadas (pago/admin/cupom)">⚠️ PLUS — ${escapeHtml(label)}</span>`;
}

async function loadUsers() {
  const res = await fetch('/api/admin/users', { credentials: 'include' });
  const users = await res.json();
  const tbody = document.querySelector('#users-table tbody');
  tbody.innerHTML = '';
  users.forEach((u) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(u.username)}</td>
      <td>${escapeHtml(u.email || '—')}</td>
      <td>${new Date(u.created_at).toLocaleString('pt-BR')}</td>
      <td>${u.is_admin ? 'Sim' : 'Não'}</td>
      <td>${u.verified_gold ? '🥇 Verificado (dourado)' : u.is_verified ? '✔️ Verificado' : '—'}</td>
      <td>${planLabelHtml(u)}</td>
      <td>${
        u.auto_suspended
          ? `<span title="${escapeHtml(u.ban_reason || '')}" style="color:#f23f42;font-weight:700;">⚠️ Suspensão automática — revisar</span>`
          : u.is_banned
          ? 'Banido'
          : 'Ativo'
      }</td>
      <td>
        ${u.is_banned
          ? `<button class="action" data-action="unban" data-id="${u.id}">Desbanir</button>`
          : `<button class="action danger" data-action="ban" data-id="${u.id}">Banir</button>`}
        <button class="action" data-action="timeout" data-id="${u.id}">Timeout 10min</button>
        ${u.plan === 'plus'
          ? `<button class="action" data-action="revoke-plan" data-id="${u.id}">Remover Plus</button>`
          : `<button class="action" data-action="grant-plan" data-id="${u.id}">Conceder Plus</button>`}
        <button class="action" data-action="toggle-verify" data-id="${u.id}">${u.is_verified ? 'Remover selo' : '✔️ Verificar'}</button>
        <button class="action" data-action="toggle-verify-gold" data-id="${u.id}">${u.verified_gold ? 'Remover dourado' : '🥇 Verificar (dourado, parceiro)'}</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('button[data-action="ban"]').forEach((btn) =>
    btn.addEventListener('click', () => banUser(btn.dataset.id))
  );
  tbody.querySelectorAll('button[data-action="unban"]').forEach((btn) =>
    btn.addEventListener('click', () => unbanUser(btn.dataset.id))
  );
  tbody.querySelectorAll('button[data-action="timeout"]').forEach((btn) =>
    btn.addEventListener('click', () => timeoutUser(btn.dataset.id))
  );
  tbody.querySelectorAll('button[data-action="grant-plan"]').forEach((btn) =>
    btn.addEventListener('click', () => setUserPlanAdmin(btn.dataset.id, 'plus'))
  );
  tbody.querySelectorAll('button[data-action="revoke-plan"]').forEach((btn) =>
    btn.addEventListener('click', () => setUserPlanAdmin(btn.dataset.id, 'free'))
  );
  tbody.querySelectorAll('button[data-action="toggle-verify"]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await fetch(`/api/admin/users/${btn.dataset.id}/verify`, { method: 'POST', credentials: 'include' });
      loadUsers();
      loadAuditLogs();
    })
  );
  tbody.querySelectorAll('button[data-action="toggle-verify-gold"]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await fetch(`/api/admin/users/${btn.dataset.id}/verify-gold`, { method: 'POST', credentials: 'include' });
      loadUsers();
      loadAuditLogs();
    })
  );
}

async function setUserPlanAdmin(id, plan) {
  await fetch(`/api/admin/users/${id}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ plan }),
  });
  loadUsers();
}

async function banUser(id) {
  if (!confirm('Confirma o banimento deste usuário?')) return;
  await fetch(`/api/admin/users/${id}/ban`, { method: 'POST', credentials: 'include' });
  loadUsers();
  loadReports();
  loadBlocked();
  loadFlaggedFrames();
  loadAuditLogs();
}

async function unbanUser(id) {
  await fetch(`/api/admin/users/${id}/unban`, { method: 'POST', credentials: 'include' });
  loadUsers();
  loadAuditLogs();
}

async function timeoutUser(id) {
  const minutes = prompt('Timeout de quantos minutos?', '10');
  if (minutes === null) return;
  await fetch(`/api/admin/users/${id}/timeout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ minutes: parseInt(minutes, 10) || 10 }),
  });
  loadAuditLogs();
  alert('Timeout aplicado.');
}

async function loadAuditLogs() {
  const actor = document.getElementById('audit-filter-actor').value.trim();
  const action = document.getElementById('audit-filter-action').value.trim();
  const params = new URLSearchParams();
  if (actor) params.set('actor', actor);
  if (action) params.set('action', action);
  const res = await fetch(`/api/admin/audit-logs?${params.toString()}`, { credentials: 'include' });
  const rows = await res.json();
  const tbody = document.querySelector('#audit-table tbody');
  tbody.innerHTML = '';
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    let details = '';
    try {
      details = r.details ? JSON.stringify(JSON.parse(r.details)) : '';
    } catch (_) {
      details = r.details || '';
    }
    tr.innerHTML = `
      <td>${new Date(r.created_at).toLocaleString('pt-BR')}</td>
      <td>${escapeHtml(r.actor_username || '-')}</td>
      <td>${escapeHtml(r.action)}</td>
      <td>${escapeHtml(r.target_type || '-')}</td>
      <td>${escapeHtml(r.target_id || '-')}</td>
      <td>${escapeHtml(details)}</td>
    `;
    tbody.appendChild(tr);
  });
}
document.getElementById('btn-audit-filter').addEventListener('click', loadAuditLogs);

init();
