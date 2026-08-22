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
  loadReports();
  loadBlocked();
  loadFlagged();
  loadUsers();
}

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
}

async function banUser(id) {
  if (!confirm('Confirma o banimento deste usuário?')) return;
  await fetch(`/api/admin/users/${id}/ban`, { method: 'POST', credentials: 'include' });
  loadUsers();
  loadReports();
  loadBlocked();
}

async function unbanUser(id) {
  await fetch(`/api/admin/users/${id}/unban`, { method: 'POST', credentials: 'include' });
  loadUsers();
}

init();
