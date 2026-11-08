(function () {
  var $ = function (id) { return document.getElementById(id); };
  var you = '';
  function msg(t) { var m = $('msg'); m.textContent = t; m.style.display = 'block'; clearTimeout(msg.t); msg.t = setTimeout(function () { m.style.display = 'none'; }, 3500); }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function fmt(n) { return Number(n || 0).toLocaleString('pt-BR'); }
  function api(path, body) {
    return fetch(path, { method: body ? 'POST' : 'GET', credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || ('Erro ' + r.status)); return d; }); });
  }
  function ban(ip, mins) {
    if (!confirm('Derrubar o IP ' + ip + ' por ' + (mins >= 60 ? mins / 60 + ' h' : mins + ' min') + '?')) return;
    api('/api/admin/shield/ban', { ip: ip, minutes: mins }).then(function () { msg('IP ' + ip + ' derrubado.'); load(); }).catch(function (e) { msg(e.message); });
  }
  function unban(ip) { api('/api/admin/shield/unban', { ip: ip }).then(function () { msg('IP ' + ip + ' liberado.'); load(); }).catch(function (e) { msg(e.message); }); }
  function fill(tbody, emptyId, rows) { tbody.textContent = ''; $(emptyId).style.display = rows.length ? 'none' : 'block'; rows.forEach(function (r) { tbody.appendChild(r); }); }
  function banBtns(ip) {
    var td = el('td'); if (ip === you) { td.appendChild(el('span', '(você)', 'mut')); return td; }
    [[10, '10 min'], [60, '1 h'], [1440, '24 h']].forEach(function (o) { var b = el('button', o[1], 'danger'); b.style.marginRight = '4px'; b.onclick = function () { ban(ip, o[0]); }; td.appendChild(b); });
    return td;
  }
  function chart(h, thr) {
    var c = $('chart'), w = c.clientWidth || 1000, ht = 220, dpr = window.devicePixelRatio || 1; c.width = w * dpr; c.height = ht * dpr;
    var x = c.getContext('2d'); x.scale(dpr, dpr); x.clearRect(0, 0, w, ht);
    var max = Math.max.apply(null, [thr.elevated || 1000].concat(h.map(function (p) { return p.total; }))) * 1.1, L = 46, B = 20, W = w - L - 6, H = ht - B - 6;
    x.font = '11px system-ui'; x.fillStyle = '#8a94a8'; x.strokeStyle = '#1f2633';
    [0, .25, .5, .75, 1].forEach(function (f) { var y = 6 + H - H * f; x.beginPath(); x.moveTo(L, y); x.lineTo(w - 6, y); x.stroke(); x.fillText(fmt(Math.round(max * f)), 2, y + 4); });
    [[thr.elevated, '#facc15'], [thr.suspect, '#fb923c'], [thr.extreme, '#ef4444']].forEach(function (t) { if (t[0] && t[0] < max) { var y = 6 + H - H * (t[0] / max); x.strokeStyle = t[1]; x.setLineDash([5, 4]); x.beginPath(); x.moveTo(L, y); x.lineTo(w - 6, y); x.stroke(); x.setLineDash([]); } });
    if (h.length < 2) { x.fillStyle = '#8a94a8'; x.fillText('Coletando dados… (1 ponto por minuto)', L + 10, 30); return; }
    function line(key, col) { x.strokeStyle = col; x.lineWidth = 2; x.beginPath(); h.forEach(function (p, i) { var px = L + W * i / (h.length - 1), py = 6 + H - H * (p[key] / max); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke(); }
    line('total', '#4f8cff'); line('blocked', '#ef4444'); x.lineWidth = 1;
    x.fillStyle = '#4f8cff'; x.fillText('● pedidos', L + 6, ht - 4); x.fillStyle = '#ef4444'; x.fillText('● bloqueados', L + 70, ht - 4);
  }
  function load() {
    api('/api/admin/shield').then(function (d) {
      if (!d.active) { $('lvl').textContent = 'Shield desligado'; return; }
      you = d.you || ''; var cm = d.currentMinute || {};
      var l = $('lvl'); l.textContent = (cm.level || 'normal').toUpperCase(); l.className = 'pill lv-' + (cm.level || 'normal');
      $('k-total').textContent = fmt(cm.total); $('k-blocked').textContent = fmt(cm.blocked); $('k-bans').textContent = fmt(cm.newBans);
      $('k-banned').textContent = fmt((d.banned || []).length); $('k-tracked').textContent = fmt(d.trackedIps);
      var t = d.thresholds || {}; $('thr').textContent = 'Níveis por minuto: elevado ≥ ' + fmt(t.elevated) + ' · suspeito ≥ ' + fmt(t.suspect) + ' · extremo ≥ ' + fmt(t.extreme) + (d.underAttack ? '  —  ⚠️ SOB ATAQUE' : '');
      $('upd').textContent = 'atualizado ' + new Date().toLocaleTimeString('pt-BR');
      chart(d.history || [], t);
      fill($('top'), 'top-empty', (d.top || []).map(function (r) { var tr = el('tr'), a = el('td', r.ip, 'mono'); if (r.ip === you) a.textContent += '  (você)'; tr.appendChild(a); tr.appendChild(el('td', fmt(r.n), 'n')); tr.appendChild(banBtns(r.ip)); return tr; }));
      fill($('banned'), 'banned-empty', (d.banned || []).map(function (r) { var tr = el('tr'); tr.appendChild(el('td', r.ip, 'mono')); tr.appendChild(el('td', r.minutesLeft + ' min')); tr.appendChild(el('td', String(r.bans))); var td = el('td'), b = el('button', 'Liberar'); b.onclick = function () { unban(r.ip); }; td.appendChild(b); tr.appendChild(td); return tr; }));
      fill($('susp'), 'susp-empty', (d.suspicious || []).slice(0, 40).map(function (r) { var tr = el('tr'); tr.appendChild(el('td', new Date(r.t).toLocaleTimeString('pt-BR'))); tr.appendChild(el('td', r.ip, 'mono')); tr.appendChild(el('td', String(r.reason || ''))); tr.appendChild(banBtns(r.ip)); return tr; }));
    }).catch(function (e) { $('lvl').textContent = e.message.indexOf('admin') >= 0 || /403|401|Não/.test(e.message) ? 'Entre como admin' : e.message; });
    api('/api/admin/shield-remote').then(function (r) {
      var c = $('remote-card'); if (!r || !r.configured) { c.style.display = 'none'; return; }
      c.style.display = 'block'; var box = $('remote'); box.textContent = '';
      var list = r.underAttack || [];
      if (!list.length && !(r.alerts || []).length) { box.appendChild(el('div', 'Nenhum site com atividade anormal.', 'empty')); }
      list.forEach(function (s) { box.appendChild(el('div', '⚠️ ' + s.name + ' — ' + String(s.level).toUpperCase() + ' · ' + fmt(s.total) + ' pedidos/min')); });
      box.appendChild(el('p', ''));
      var a = el('a', 'Abrir o monitor completo →'); a.href = (r.base || 'https://protection-bluex.onrender.com') + '/monitor.html'; a.target = '_blank'; a.rel = 'noopener'; box.appendChild(a);
    }).catch(function () {});
  }
  $('go').onclick = function () { var ip = $('ip').value.trim(); if (!ip) return msg('Digite um IP.'); ban(ip, parseInt($('mins').value, 10)); };
  load(); setInterval(load, 5000);
})();
