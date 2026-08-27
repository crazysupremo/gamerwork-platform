// admin.js - painel de moderação

async function init() {
  const meRes = await fetch('/api/me', { credentials: 'include' });
  if (!meRes.ok) {
    document.getElementById('admin-guard').textContent = 'Você precisa estar logado.';
    return;
  }
  const me = await meRes.json();
  if (!me.is_admin) {
    document.getElementById('admin-guard').textContent = 'Acesso restrito a administradores.';
    return;
  }
  document.getElementById('admin-content').classList.remove('hidden');
  loadMonitoring();
  setInterval(loadMonitoring, 10000);
  loadAnalytics();
  loadSuspiciousAccounts();
  loadMinors();
  loadClipsAdmin();
  loadShopAdmin();
  loadReports();
  loadBlocked();
  loadFlaggedFrames();
  loadFlagged();
  loadUsers();
  loadAuditLogs();
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
          (e) =>
            `<tr><td>${new Date(e.time).toLocaleTimeString('pt-BR')}</td><td>${escapeHtml(e.source)}</td><td>${escapeHtml(e.message)}</td></tr>`
        )
        .join('')
    : '<tr><td colspan="3" style="color:#949ba4;">Nenhum erro recente. 🎉</td></tr>';
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

async function loadUsers() {
  const res = await fetch('/api/admin/users', { credentials: 'include' });
  const users = await res.json();
  const tbody = document.querySelector('#users-table tbody');
  tbody.innerHTML = '';
  users.forEach((u) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(u.username)}</td>
      <td>${new Date(u.created_at).toLocaleString('pt-BR')}</td>
      <td>${u.is_admin ? 'Sim' : 'Não'}</td>
      <td>${u.plan === 'plus' ? '✨ PLUS' : 'Free'}</td>
      <td>${u.is_banned ? 'Banido' : 'Ativo'}</td>
      <td>
        ${u.is_banned
          ? `<button class="action" data-action="unban" data-id="${u.id}">Desbanir</button>`
          : `<button class="action danger" data-action="ban" data-id="${u.id}">Banir</button>`}
        <button class="action" data-action="timeout" data-id="${u.id}">Timeout 10min</button>
        ${u.plan === 'plus'
          ? `<button class="action" data-action="revoke-plan" data-id="${u.id}">Remover Plus</button>`
          : `<button class="action" data-action="grant-plan" data-id="${u.id}">Conceder Plus</button>`}
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
