(function () {
  var $ = function (id) { return document.getElementById(id); };
  var you = '', range = 60, DATA = null, permSet = {};
  function msg(t) { var m = $('msg'); m.textContent = t; m.style.display = 'block'; clearTimeout(msg.t); msg.t = setTimeout(function () { m.style.display = 'none'; }, 3800); }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function fmt(n) { return Number(n || 0).toLocaleString('pt-BR'); }
  function api(path, body) {
    return fetch(path, { method: body ? 'POST' : 'GET', credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || ('Erro ' + r.status)); return d; }); });
  }
  function human(m) { return m === 'perm' ? 'PARA SEMPRE' : (m >= 60 ? (m / 60) + ' h' : m + ' min'); }
  function ban(ips, mins, reason) {
    ips = [].concat(ips); var perm = mins === 'perm';
    var what = ips.length > 1 ? ips.length + ' IPs' : 'o IP ' + ips[0];
    if (!confirm('Derrubar ' + what + ' por ' + human(mins) + '?' + (perm ? '\n\nFica banido até você liberar manualmente.' : ''))) return;
    api('/api/admin/shield/ban', { ips: ips, minutes: perm ? 10 : mins, permanent: perm, reason: reason || '' })
      .then(function (r) { msg((r.banned || []).length + ' IP(s) derrubado(s) — ' + human(mins) + '.'); load(); }).catch(function (e) { msg(e.message); });
  }
  function unban(ip) { api('/api/admin/shield/unban', { ip: ip }).then(function () { msg('IP ' + ip + ' liberado.'); load(); }).catch(function (e) { msg(e.message); }); }
  function fill(tbody, emptyId, rows) { tbody.textContent = ''; $(emptyId).style.display = rows.length ? 'none' : 'block'; rows.forEach(function (r) { tbody.appendChild(r); }); }
  function banBtns(ip, reason) {
    var td = el('td'); if (ip === you) { td.appendChild(el('span', '(você)', 'mut')); return td; }
    [[10, '10 min', 'danger'], [60, '1 h', 'danger'], [1440, '24 h', 'danger'], ['perm', '♾ Sempre', 'perm']].forEach(function (o) {
      var b = el('button', o[1], o[2]); b.style.marginRight = '4px'; b.onclick = function () { ban(ip, o[0], reason); }; td.appendChild(b);
    });
    return td;
  }

  // ---------- GRÁFICO ----------
  var pts = [], geo = null;
  function chart() {
    var d = DATA || {}, h = (d.history || []).slice(-range), thr = d.thresholds || {};
    var c = $('chart'), w = c.clientWidth || 1000, ht = 260, dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = ht * dpr; var x = c.getContext('2d'); x.scale(dpr, dpr); x.clearRect(0, 0, w, ht);
    var L = 54, R = 12, T = 12, B = 26, W = w - L - R, H = ht - T - B;
    var maxData = Math.max.apply(null, [10].concat(h.map(function (p) { return p.total; })));
    var max = maxData * 1.25; if (thr.elevated && maxData > thr.elevated * 0.4) max = Math.max(max, thr.elevated * 1.15);
    max = niceMax(max);
    geo = { L: L, T: T, W: W, H: H, max: max, n: h.length, h: h };
    x.font = '11px system-ui'; x.textBaseline = 'middle';
    // zonas de nível
    [[thr.elevated, thr.suspect, 'rgba(250,204,21,.07)'], [thr.suspect, thr.extreme, 'rgba(251,146,60,.09)'], [thr.extreme, max, 'rgba(239,68,68,.10)']].forEach(function (z) {
      if (z[0] && z[0] < max) { var y1 = T + H - H * (Math.min(z[1] || max, max) / max), y2 = T + H - H * (z[0] / max); x.fillStyle = z[2]; x.fillRect(L, y1, W, y2 - y1); }
    });
    for (var i = 0; i <= 4; i++) { var f = i / 4, y = T + H - H * f; x.strokeStyle = 'rgba(255,255,255,.06)'; x.beginPath(); x.moveTo(L, y); x.lineTo(w - R, y); x.stroke(); x.fillStyle = '#7f8ba5'; x.textAlign = 'right'; x.fillText(fmt(Math.round(max * f)), L - 8, y); }
    [[thr.elevated, '#facc15', 'elevado'], [thr.suspect, '#fb923c', 'suspeito'], [thr.extreme, '#ef4444', 'extremo']].forEach(function (t) {
      if (t[0] && t[0] < max) { var y = T + H - H * (t[0] / max); x.strokeStyle = t[1]; x.globalAlpha = .55; x.setLineDash([6, 5]); x.beginPath(); x.moveTo(L, y); x.lineTo(w - R, y); x.stroke(); x.setLineDash([]); x.globalAlpha = 1; x.fillStyle = t[1]; x.textAlign = 'left'; x.fillText(t[2] + ' ' + fmt(t[0]), L + 6, y - 7); }
    });
    if (h.length < 2) { x.fillStyle = '#7f8ba5'; x.textAlign = 'left'; x.fillText('Coletando dados… (1 ponto por minuto)', L + 12, T + 24); pts = []; return; }
    pts = h.map(function (p, i) { return { x: L + W * i / (h.length - 1), yT: T + H - H * (p.total / max), yB: T + H - H * (p.blocked / max), p: p }; });
    function curve(key) { x.beginPath(); pts.forEach(function (q, i) { var yy = q[key]; if (i === 0) x.moveTo(q.x, yy); else { var pr = pts[i - 1], cx = (pr.x + q.x) / 2; x.bezierCurveTo(cx, pr[key], cx, yy, q.x, yy); } }); }
    var g = x.createLinearGradient(0, T, 0, T + H); g.addColorStop(0, 'rgba(91,140,255,.45)'); g.addColorStop(1, 'rgba(91,140,255,0)');
    curve('yT'); x.lineTo(pts[pts.length - 1].x, T + H); x.lineTo(pts[0].x, T + H); x.closePath(); x.fillStyle = g; x.fill();
    curve('yT'); x.strokeStyle = '#6f9bff'; x.lineWidth = 2.4; x.shadowColor = 'rgba(91,140,255,.6)'; x.shadowBlur = 10; x.stroke(); x.shadowBlur = 0;
    if (h.some(function (p) { return p.blocked > 0; })) {
      var g2 = x.createLinearGradient(0, T, 0, T + H); g2.addColorStop(0, 'rgba(239,68,68,.35)'); g2.addColorStop(1, 'rgba(239,68,68,0)');
      curve('yB'); x.lineTo(pts[pts.length - 1].x, T + H); x.lineTo(pts[0].x, T + H); x.closePath(); x.fillStyle = g2; x.fill();
      curve('yB'); x.strokeStyle = '#ef4444'; x.lineWidth = 1.8; x.stroke();
    }
    pts.forEach(function (q) { if (q.p.newBans > 0) { x.beginPath(); x.arc(q.x, q.yT, 5, 0, 7); x.fillStyle = '#a78bfa'; x.fill(); x.strokeStyle = '#0e1320'; x.lineWidth = 2; x.stroke(); } });
    var last = pts[pts.length - 1]; x.beginPath(); x.arc(last.x, last.yT, 4.5, 0, 7); x.fillStyle = '#fff'; x.fill();
    x.fillStyle = '#7f8ba5'; x.textAlign = 'center'; x.textBaseline = 'top';
    [0, .25, .5, .75, 1].forEach(function (f) { var i = Math.round((h.length - 1) * f), t = new Date(h[i].t); x.fillText(t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), L + W * f, T + H + 8); });
    x.lineWidth = 1;
  }
  function niceMax(v) { var p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p; var steps=[1,1.5,2,2.5,3,4,5,6,8,10];for(var i=0;i<steps.length;i++){if(n<=steps[i])return steps[i]*p;}return 10*p; }
  (function hover() {
    var c = $('chart'), tip = $('tip');
    c.addEventListener('mousemove', function (e) {
      if (!pts.length) return; var r = c.getBoundingClientRect(), mx = e.clientX - r.left, best = pts[0];
      pts.forEach(function (q) { if (Math.abs(q.x - mx) < Math.abs(best.x - mx)) best = q; });
      var p = best.p; tip.textContent = '';
      tip.appendChild(el('b', new Date(p.t).toLocaleTimeString('pt-BR'))); tip.appendChild(el('div', 'Pedidos: ' + fmt(p.total)));
      tip.appendChild(el('div', 'Bloqueados: ' + fmt(p.blocked))); if (p.newBans) tip.appendChild(el('div', 'Bans novos: ' + p.newBans)); tip.appendChild(el('div', 'Nível: ' + String(p.level || 'normal')));
      tip.style.display = 'block'; tip.style.left = Math.min(best.x + 14, r.width - 170) + 'px'; tip.style.top = Math.max(best.yT - 30, 0) + 'px';
    });
    c.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
  })();

  // ---------- DIAGNÓSTICO ----------
  function diagnose(d) {
    var cm = d.currentMinute || {}, top = d.top || [], total = cm.total || 0, t = d.thresholds || {};
    var icon = '✅', title = 'Tudo tranquilo', text = 'Tráfego normal: ' + fmt(total) + ' pedidos neste minuto.', acts = [];
    var big = top[0], share = big && total ? Math.round(100 * big.n / total) : 0;
    var sus = {}; (d.suspicious || []).forEach(function (s) { sus[s.ip] = (sus[s.ip] || 0) + 1; });
    var susIps = Object.keys(sus).filter(function (ip) { return ip !== you && !permSet[ip] && !isBanned(d, ip); });
    if (cm.level === 'extremo' || d.underAttack) { icon = '🚨'; title = 'Provável ataque em andamento'; }
    else if (cm.level === 'suspeito') { icon = '🟠'; title = 'Tráfego muito alto'; }
    else if (cm.level === 'elevado') { icon = '🟡'; title = 'Tráfego acima do normal'; }
    var unique = (d.top || []).length;
    if (cm.level && cm.level !== 'normal') {
      if (share >= 60 && big) { text = 'O IP ' + big.ip + (big.ip === you ? ' (você)' : '') + ' faz ' + share + '% dos pedidos (' + fmt(big.n) + '/min). ' + (big.ip === you ? 'Parece ser o seu uso.' : 'Isso é típico de um robô só — derrubar resolve.'); if (big.ip !== you) acts.push(['Derrubar ' + big.ip + ' por 24 h', function () { ban(big.ip, 1440, 'auto: ' + share + '% do tráfego'); }]); }
      else if (unique >= 5 && share < 30) text = 'O volume está espalhado entre vários IPs (maior: ' + share + '%). Parece ataque distribuído (DDoS): banir um a um ajuda pouco — o ideal é colocar o Cloudflare na frente do site.';
      else text = 'Volume alto (' + fmt(total) + '/min; elevado ≥ ' + fmt(t.elevated) + '). Veja os IPs abaixo.';
    } else if (big && share >= 80 && total >= 200 && big.ip !== you) { icon = '👀'; title = 'Um IP domina o tráfego'; text = big.ip + ' faz ' + share + '% dos pedidos (' + fmt(big.n) + '/min). Pode ser só um jogador ativo — fique de olho.'; }
    else if (big && big.ip === you) text += ' Quase tudo é o seu próprio acesso.';
    if (susIps.length) { acts.push(['Banir ' + susIps.length + ' suspeito(s) por 24 h', function () { ban(susIps, 1440, 'auto: suspeito'); }]); if (title === 'Tudo tranquilo') { icon = '🕵️'; title = susIps.length + ' IP(s) suspeito(s) detectado(s)'; text = 'Scanners/bots tentaram acessar áreas sensíveis. O Shield já bloqueia, mas você pode derrubar de vez.'; } }
    $('d-ic').textContent = icon; $('d-title').textContent = title; $('d-text').textContent = text;
    var box = $('d-act'); box.textContent = ''; acts.forEach(function (a) { var b = el('button', a[0], 'danger'); b.onclick = a[1]; box.appendChild(b); });
  }
  function isBanned(d, ip) { return (d.banned || []).some(function (b) { return b.ip === ip; }); }

  function load() {
    api('/api/admin/shield').then(function (d) {
      if (!d.active) { $('lvl').textContent = 'Shield desligado'; return; }
      DATA = d; you = d.you || ''; var cm = d.currentMinute || {}; permSet = {}; (d.permanent || []).forEach(function (p) { permSet[p.ip] = 1; });
      var l = $('lvl'); l.textContent = '● ' + (cm.level || 'normal').toUpperCase(); l.className = 'pill lv-' + (cm.level || 'normal');
      var hs = (d.history || []).slice(-range), peak = hs.reduce(function (m, p) { return Math.max(m, p.total); }, 0);
      $('k-total').textContent = fmt(cm.total); $('k-blocked').textContent = fmt(cm.blocked); $('k-bans').textContent = fmt(cm.newBans);
      $('k-banned').textContent = fmt((d.banned || []).length); $('k-tracked').textContent = fmt(d.trackedIps); $('k-peak').textContent = fmt(peak); $('k-peak-l').textContent = 'pico (' + (range >= 60 ? range / 60 + ' h' : range + ' min') + ')';
      $('upd').textContent = 'atualizado ' + new Date().toLocaleTimeString('pt-BR');
      chart(); diagnose(d);
      var total = cm.total || 0;
      fill($('top'), 'top-empty', (d.top || []).map(function (r) {
        var tr = el('tr'), a = el('td', r.ip, 'mono'); if (r.ip === you) { a.appendChild(el('span', ' você', 'tag')); } if (permSet[r.ip]) a.appendChild(el('span', ' ♾', 'tag vio'));
        tr.appendChild(a); tr.appendChild(el('td', fmt(r.n), 'n'));
        var pc = total ? Math.round(100 * r.n / total) : 0, td = el('td'), bar = el('div', null, 'bar'), i = el('i', null, pc >= 60 && r.ip !== you ? 'hot' : ''); i.style.width = pc + '%'; bar.appendChild(i); td.appendChild(bar); td.appendChild(el('span', pc + '%', 'mut')); tr.appendChild(td);
        tr.appendChild(banBtns(r.ip, 'monitor: ' + r.n + '/min')); return tr; }));
      fill($('perm'), 'perm-empty', (d.permanent || []).map(function (r) { var tr = el('tr'); tr.appendChild(el('td', r.ip, 'mono')); tr.appendChild(el('td', r.reason || '—')); tr.appendChild(el('td', String(r.created_at || '').slice(0, 16))); var td = el('td'), b = el('button', 'Liberar'); b.onclick = function () { if (confirm('Liberar ' + r.ip + '?')) unban(r.ip); }; td.appendChild(b); tr.appendChild(td); return tr; }));
      fill($('banned'), 'banned-empty', (d.banned || []).filter(function (r) { return !permSet[r.ip]; }).map(function (r) { var tr = el('tr'); tr.appendChild(el('td', r.ip, 'mono')); tr.appendChild(el('td', r.minutesLeft + ' min')); tr.appendChild(el('td', String(r.bans))); var td = el('td'), b = el('button', 'Liberar'); b.onclick = function () { unban(r.ip); }; var p = el('button', '♾ Sempre', 'perm'); p.style.marginLeft = '4px'; p.onclick = function () { ban(r.ip, 'perm', 'era banido temporário'); }; td.appendChild(b); td.appendChild(p); tr.appendChild(td); return tr; }));
      var agg = {}; (d.suspicious || []).forEach(function (s) { var a = agg[s.ip] || (agg[s.ip] = { ip: s.ip, n: 0, reasons: {}, last: s.t }); a.n++; a.reasons[String(s.reason || '?')] = 1; if (s.t > a.last) a.last = s.t; });
      var sl = Object.keys(agg).map(function (k) { return agg[k]; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 30);
      fill($('susp'), 'susp-empty', sl.map(function (r) { var tr = el('tr'); tr.appendChild(el('td', r.ip, 'mono')); tr.appendChild(el('td', String(r.n), 'n')); var td = el('td'); Object.keys(r.reasons).slice(0, 4).forEach(function (k) { td.appendChild(el('span', k, 'tag yel')); td.appendChild(document.createTextNode(' ')); }); tr.appendChild(td); tr.appendChild(el('td', new Date(r.last).toLocaleTimeString('pt-BR'))); tr.appendChild(banBtns(r.ip, 'suspeito')); return tr; }));
    }).catch(function (e) { $('lvl').className = 'pill lv-elevado'; $('lvl').textContent = /403|401|Não|admin/i.test(e.message) ? 'Entre como admin' : e.message; });
    api('/api/admin/shield-remote').then(function (r) {
      var c = $('remote-card'); if (!r || !r.configured) { c.style.display = 'none'; return; }
      c.style.display = 'block'; var box = $('remote'); box.textContent = ''; var list = r.underAttack || [];
      if (!list.length && !(r.alerts || []).length) box.appendChild(el('div', 'Nenhum site com atividade anormal.', 'empty'));
      list.forEach(function (s) { box.appendChild(el('div', '⚠️ ' + s.name + ' — ' + String(s.level).toUpperCase() + ' · ' + fmt(s.total) + ' pedidos/min')); });
      var a = el('a', 'Abrir o monitor completo →'); a.href = (r.base || 'https://protection-bluex.onrender.com') + '/monitor.html'; a.target = '_blank'; a.rel = 'noopener'; box.appendChild(el('p')); box.appendChild(a);
    }).catch(function () {});
  }
  $('go').onclick = function () { var ip = $('ip').value.trim(); if (!ip) return msg('Digite um IP.'); var m = $('mins').value; ban(ip, m === 'perm' ? 'perm' : parseInt(m, 10), $('why').value.trim()); };
  [].forEach.call(document.querySelectorAll('button.range'), function (b) { b.onclick = function () { range = parseInt(b.dataset.r, 10); [].forEach.call(document.querySelectorAll('button.range'), function (x) { x.classList.toggle('on', x === b); }); if (DATA) { chart(); var hs = (DATA.history || []).slice(-range); $('k-peak').textContent = fmt(hs.reduce(function (m, p) { return Math.max(m, p.total); }, 0)); $('k-peak-l').textContent = 'pico (' + (range >= 60 ? range / 60 + ' h' : range + ' min') + ')'; } }; });
  window.addEventListener('resize', function () { if (DATA) chart(); });
  load(); setInterval(load, 5000);
})();
