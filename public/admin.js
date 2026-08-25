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
  loadAnalytics();
  loadSuspiciousAccounts();
  loadClipsAdmin();
  loadShopAdmin();
  loadReports();
  loadBlocked();
  loadFlaggedFrames();
  loadFlagged();
  loadUsers();
  loadAuditLogs();
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
      <td>${u.is_banned ? 'Banido' : 'Ativo'}</td>
      <td>
        ${u.is_banned
          ? `<button class="action" data-action="unban" data-id="${u.id}">Desbanir</button>`
          : `<button class="action danger" data-action="ban" data-id="${u.id}">Banir</button>`}
        <button class="action" data-action="timeout" data-id="${u.id}">Timeout 10min</button>
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
