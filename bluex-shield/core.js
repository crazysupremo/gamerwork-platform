// ---------- BLUEX SHIELD (BLUE SPORTS GAMES) — núcleo ----------
// Não precisa mexer neste ficheiro. Quem liga tudo é o index.js
// (require('./bluex-shield') no topo do jogo). Os valores abaixo são os
// padrões; só altera se souberes o que estás a fazer.

const DEFAULTS = {
  windowMs: 10_000, // janela de contagem
  maxPerWindow: 120, // pedidos por IP por janela (120/10s = 12 por segundo)
  strikesToBan: 3, // quantas vezes passa do limite até ser banido
  banMs: 10 * 60_000, // 1º ban: 10 minutos (dobra a cada reincidência)
  maxBanMs: 24 * 60 * 60_000, // ban máximo: 24h
  // 'auto' = liga o "modo sob ataque" quando os pedidos/s ficam 5x acima do
  // normal do próprio jogo (e acima de 300/s). Número fixo também serve.
  globalMaxPerSecond: 'auto',
  trustedAfterMs: 60_000, // no modo sob ataque, só passa IP visto há mais de 60s
  maxConnectionsPerIp: 30, // conexões TCP abertas ao mesmo tempo por IP (só com trustProxy 'none')
  maxSocketsPerIp: 5, // WebSockets abertos por IP
  maxMessagesPerSecond: 30, // mensagens por segundo por WebSocket
  // 'auto' descobre sozinho (Render/Heroku/nginx/Cloudflare). Também aceita
  // 'none' | 'cloudflare' | número de proxies.
  trustProxy: 'auto',
  allowlist: [], // IPs que nunca são bloqueados (ex: o teu)
  skipPaths: [], // caminhos que não contam (ex: ['/health'])
  // --- v2: mais eficaz ---
  // Rotas sensíveis (login, cadastro, senha, cupom...): limite BEM menor por IP.
  sensitivePaths: ['/api/login', '/api/register', '/api/signup', '/api/redeem-code', '/api/forgot', '/api/reset', '/api/verify', '/api/auth'],
  sensitiveMaxPerMinute: 60, // POSTs nessas rotas por IP por minuto (acima disso = strike)
  // Scanners/bots procurando brecha: tocar nisso já conta forte (e 3 vezes = ban).
  trapPaths: ['/.env', '/.git', '/wp-login', '/wp-admin', '/xmlrpc.php', '/phpmyadmin', '/phpinfo', '/vendor/phpunit', '/cgi-bin', '/boaform', '/actuator', '/.aws', '/config.json', '/server-status'],
  trapWeight: 400, // peso de cada toque em armadilha (limite é 600 por janela)
  notFoundWeight: 4, // cada resposta 404 custa mais (varredura de URLs)
  // Proteção por sobrecarga: se o servidor está "engasgado" (event loop lento),
  // recusa IPs novos/pesados em vez de cair tudo.
  lagShedMs: 400, // atraso do event loop que liga o modo proteção
  maxRequestsPerSocket: 1000, // conexão keep-alive reciclada depois disso
  log: true,
  logIntervalMs: 60_000,
  maxTrackedIps: 200_000, // limite de memória
};

const net = require('net');

// IPs da Cloudflare (lista pública: cloudflare.com/ips).
const cloudflare = new net.BlockList();
[
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
].forEach((c) => { const [a, p] = c.split('/'); cloudflare.addSubnet(a, Number(p), 'ipv4'); });
[
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
].forEach((c) => { const [a, p] = c.split('/'); cloudflare.addSubnet(a, Number(p), 'ipv6'); });

const privateNets = new net.BlockList();
[['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['169.254.0.0', 16], ['100.64.0.0', 10]].forEach(([a, p]) =>
  privateNets.addSubnet(a, p, 'ipv4')
);
[['fc00::', 7], ['fe80::', 10], ['::1', 128]].forEach(([a, p]) => privateNets.addSubnet(a, p, 'ipv6'));

function ipType(ip) {
  const v = net.isIP(ip);
  return v === 4 ? 'ipv4' : v === 6 ? 'ipv6' : null;
}
function isCloudflareIp(ip) {
  const t = ipType(ip);
  return !!t && cloudflare.check(ip, t);
}
function isPrivateIp(ip) {
  const t = ipType(ip);
  return !!t && privateNets.check(ip, t);
}

function createShield(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const allow = new Set((cfg.allowlist || []).map(normalizeIp));
  const ips = new Map(); // ip -> estado
  const conns = new Map(); // ip -> conexões TCP abertas
  const sockets = new Map(); // ip -> websockets abertos

  let secondStart = Date.now();
  let secondCount = 0;
  let underAttack = false;
  let normalPerSecond = 0;
  const minute = { total: 0, blocked: 0, newBans: 0, perIp: new Map() };
  const recent = []; // últimos bans (pro painel admin)
  const sensitive = new Map(); // ip -> { n, start }
  let loadShed = false; // servidor engasgado
  let lastTick = Date.now();
  const lagTimer = setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - 250;
    lastTick = now;
    const was = loadShed;
    loadShed = lag > cfg.lagShedMs;
    if (cfg.log && loadShed !== was) console.warn(loadShed ? `[BLUEX SHIELD] ⚠️ servidor sobrecarregado (atraso ${lag}ms) — protegendo` : '[BLUEX SHIELD] servidor normalizado');
  }, 250);
  lagTimer.unref();

  function normalizeIp(ip) {
    if (!ip) return 'desconhecido';
    ip = String(ip).trim();
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return ip;
  }

  function getIp(req) {
    const remote = normalizeIp(req.socket && req.socket.remoteAddress);
    const headers = req.headers || {};
    if (cfg.trustProxy === 'cloudflare') {
      return normalizeIp(headers['cf-connecting-ip'] || remote);
    }
    if (cfg.trustProxy === 'auto') {
      // Cloudflare de verdade: a conexão vem de um IP da Cloudflare.
      if (headers['cf-connecting-ip'] && isCloudflareIp(remote)) return normalizeIp(headers['cf-connecting-ip']);
      // Proxy interno (Render, Heroku, nginx na mesma máquina): a conexão
      // vem de IP privado. Um atacante na internet nunca tem IP privado,
      // então não dá pra falsificar isto de fora.
      if (isPrivateIp(remote) && headers['x-forwarded-for']) {
        const xff = String(headers['x-forwarded-for']).split(',').map((s) => s.trim()).filter(Boolean);
        // Pula proxies internos no fim da lista (ex: Render tem mais de um).
        for (let i = xff.length - 1; i >= 0; i--) {
          const ip = normalizeIp(xff[i]);
          if (!isPrivateIp(ip) && !isCloudflareIp(ip)) return ip;
        }
        return normalizeIp(xff[0] || remote);
      }
      return remote;
    }
    if (typeof cfg.trustProxy === 'number' && cfg.trustProxy > 0) {
      const xff = String(headers['x-forwarded-for'] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      // O proxy mais próximo adiciona o IP de quem falou com ele no FIM da
      // lista — por isso conta da direita (o início pode ser falsificado).
      const ip = xff[xff.length - cfg.trustProxy];
      return normalizeIp(ip || remote);
    }
    return remote;
  }

  function state(ip, now) {
    let s = ips.get(ip);
    if (!s) {
      if (ips.size >= cfg.maxTrackedIps) cleanup(true);
      s = { count: 0, windowStart: now, strikes: 0, bannedUntil: 0, bans: 0, firstSeen: now, lastSeen: now };
      ips.set(ip, s);
    }
    return s;
  }

  // Núcleo: decide se um pedido do IP passa. weight = quanto "custa".
  function check(ip, weight = 1) {
    const now = Date.now();
    minute.total++;
    minute.perIp.set(ip, (minute.perIp.get(ip) || 0) + 1);
    if (allow.has(ip)) return { ok: true };

    // Contador global (modo sob ataque).
    if (now - secondStart >= 1000) {
      const wasUnder = underAttack;
      if (cfg.globalMaxPerSecond === 'auto') {
        // Só considera ataque quando o jogo está MUITO acima do normal dele.
        const limit = Math.max(300, normalPerSecond * 5);
        underAttack = secondCount > limit;
        // A média "normal" só aprende com segundos que não são ataque.
        if (!underAttack) normalPerSecond = normalPerSecond * 0.98 + secondCount * 0.02;
      } else {
        underAttack = cfg.globalMaxPerSecond > 0 && secondCount > cfg.globalMaxPerSecond;
      }
      if (cfg.log && underAttack !== wasUnder) {
        console.warn(underAttack ? `[BLUEX SHIELD] ⚠️ MODO SOB ATAQUE ligado (${secondCount} pedidos/s)` : '[BLUEX SHIELD] modo sob ataque desligado');
      }
      secondStart = now;
      secondCount = 0;
    }
    secondCount++;

    const s = state(ip, now);
    s.lastSeen = now;

    if (s.bannedUntil > now) return block(s, 'banido');

    if ((underAttack || loadShed) && now - s.firstSeen < cfg.trustedAfterMs) {
      return block(s, 'sob_ataque', 5);
    }

    if (now - s.windowStart >= cfg.windowMs) {
      s.windowStart = now;
      s.count = 0;
    }
    s.count += weight;
    if (s.count > cfg.maxPerWindow) {
      // Conta 1 "strike" por janela estourada, não por pedido.
      if (!s.struckThisWindow || s.struckThisWindow !== s.windowStart) {
        s.struckThisWindow = s.windowStart;
        s.strikes++;
      }
      // Flood muito forte (3x o limite numa janela só) = ban na hora.
      if (s.count > cfg.maxPerWindow * 3 && s.strikes < cfg.strikesToBan) s.strikes = cfg.strikesToBan;
      if (s.strikes >= cfg.strikesToBan) {
        s.bans++;
        s.strikes = 0;
        const dur = Math.min(cfg.banMs * 2 ** (s.bans - 1), cfg.maxBanMs);
        s.bannedUntil = now + dur;
        minute.newBans++;
        recent.unshift({ ip, at: new Date(now).toISOString(), minutes: Math.round(dur / 60000), n: s.bans });
        if (recent.length > 50) recent.pop();
        if (cfg.log) console.warn(`[BLUEX SHIELD] 🚫 IP ${ip} banido por ${Math.round(dur / 60000)} min (ban nº ${s.bans})`);
        return block(s, 'banido');
      }
      return block(s, 'limite');
    }
    return { ok: true };

    function block(st, reason, defaultRetry) {
      minute.blocked++;
      const retryAfter = st.bannedUntil > now ? Math.ceil((st.bannedUntil - now) / 1000) : defaultRetry || Math.ceil((st.windowStart + cfg.windowMs - now) / 1000);
      return { ok: false, reason, retryAfter: Math.max(1, retryAfter) };
    }
  }

  function isBanned(ip) {
    const s = ips.get(ip);
    return !!(s && s.bannedUntil > Date.now()) && !allow.has(ip);
  }

  function reject(res, result) {
    if (res.headersSent) return;
    res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': String(result.retryAfter), Connection: 'close' });
    res.end('Muitas requisições. Tente de novo mais tarde.');
  }

  // ---------- Express / Connect / http puro ----------
  // Usar ANTES de tudo (antes do express.json, rotas, banco...).
  function middleware(req, res, next) {
    const url = req.url || '';
    if (cfg.skipPaths.some((p) => url === p || url.startsWith(p + '?'))) return next();
    const ip = getIp(req);
    const r = check(ip);
    if (!r.ok) return reject(res, r);
    next();
  }

  // ---------- Servidor http (timeouts + conexões por IP) ----------
  // Conexão TCP nova. Devolve false se cortou. Só age quando o IP da
  // conexão É o IP real (sem proxy na frente) — atrás de proxy, todo mundo
  // chega pelo IP do proxy e cortar aqui derrubaria todos os jogadores.
  function onConnection(socket) {
    const ip = normalizeIp(socket.remoteAddress);
    const direct = cfg.trustProxy === 'none' || (cfg.trustProxy === 'auto' && !isPrivateIp(ip) && !isCloudflareIp(ip));
    if (!direct || allow.has(ip)) return true;
    if (isBanned(ip)) {
      socket.destroy();
      return false;
    }
    const n = (conns.get(ip) || 0) + 1;
    if (n > cfg.maxConnectionsPerIp) {
      socket.destroy();
      return false;
    }
    conns.set(ip, n);
    socket.once('close', () => {
      const left = (conns.get(ip) || 1) - 1;
      if (left <= 0) conns.delete(ip);
      else conns.set(ip, left);
    });
    return true;
  }

  function setTimeouts(server) {
    if (!server.headersTimeout || server.headersTimeout > 10_000) server.headersTimeout = 10_000; // cabeçalhos em 10s
    if (!server.requestTimeout || server.requestTimeout > 30_000) server.requestTimeout = 30_000; // pedido inteiro em 30s
    try { server.maxRequestsPerSocket = cfg.maxRequestsPerSocket; } catch (_) {}
    try { if (!server.keepAliveTimeout || server.keepAliveTimeout > 65_000) server.keepAliveTimeout = 65_000; } catch (_) {}
  }

  function protectServer(server) {
    setTimeouts(server);
    server.on('connection', onConnection);
    return server;
  }

  // ---------- Upgrade de WebSocket (genérico, serve pra ws e Socket.IO) ----------
  // Devolve false se recusou (e já respondeu 429 no socket).
  function onUpgrade(req, socket) {
    const ip = getIp(req);
    const r = check(ip, 5);
    const tooMany = (sockets.get(ip) || 0) >= cfg.maxSocketsPerIp && !allow.has(ip);
    if (!r.ok || tooMany) {
      try {
        socket.end(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${r.retryAfter || 10}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      } catch (_) {}
      socket.destroy();
      return false;
    }
    sockets.set(ip, (sockets.get(ip) || 0) + 1);
    socket.once('close', () => {
      const left = (sockets.get(ip) || 1) - 1;
      if (left <= 0) sockets.delete(ip);
      else sockets.set(ip, left);
    });
    return true;
  }

  function checkRequest(req, res) {
    const url = req.url || '';
    if (cfg.skipPaths.some((p) => url === p || url.startsWith(p + '?'))) return { ok: true };
    const ip = getIp(req);
    const path = url.split('?')[0].toLowerCase();
    let weight = 1;
    if (!allow.has(ip)) {
      // Armadilhas: scanner procurando .env, wp-login, phpmyadmin...
      if (cfg.trapPaths.some((p) => path.startsWith(p))) weight = cfg.trapWeight;
      // Sem User-Agent = quase sempre script de ataque (navegador sempre manda).
      else if (!req.headers || !req.headers['user-agent']) weight = 3;
      // Rotas sensíveis: limite próprio por minuto.
      if (req.method === 'POST' && cfg.sensitivePaths.some((p) => path.startsWith(p))) {
        const now = Date.now();
        let q = sensitive.get(ip);
        if (!q || now - q.start > 60_000) { q = { n: 0, start: now }; sensitive.set(ip, q); }
        if (++q.n > cfg.sensitiveMaxPerMinute) weight = Math.max(weight, 150);
        if (sensitive.size > cfg.maxTrackedIps) sensitive.clear();
      }
      // Muitos 404 seguidos = varredura de URLs: cobra a mais na resposta.
      if (res && typeof res.once === 'function') {
        res.once('finish', () => {
          if (res.statusCode === 404) check(ip, cfg.notFoundWeight - 1);
        });
      }
    }
    return check(ip, weight);
  }

  // ---------- WebSocket (biblioteca "ws") ----------
  // new WebSocketServer({ server, verifyClient: shield.wsVerifyClient })
  function wsVerifyClient(info, cb) {
    const ip = getIp(info.req);
    const r = check(ip, 5); // abrir conexão "custa" mais que um pedido normal
    if (!r.ok) return cb(false, 429, 'Too Many Requests');
    if ((sockets.get(ip) || 0) >= cfg.maxSocketsPerIp && !allow.has(ip)) return cb(false, 429, 'Too Many Connections');
    cb(true);
  }

  // wss.on('connection', (ws, req) => { shield.trackWebSocket(ws, req); ... })
  function trackWebSocket(ws, req) {
    const ip = getIp(req);
    sockets.set(ip, (sockets.get(ip) || 0) + 1);
    let msgSecond = Date.now();
    let msgCount = 0;
    ws.on('message', () => {
      const now = Date.now();
      if (now - msgSecond >= 1000) {
        msgSecond = now;
        msgCount = 0;
      }
      if (++msgCount > cfg.maxMessagesPerSecond && !allow.has(ip)) {
        check(ip, cfg.maxPerWindow); // conta como abuso (gera strike)
        ws.close(1008, 'flood');
      }
    });
    ws.once('close', () => {
      const left = (sockets.get(ip) || 1) - 1;
      if (left <= 0) sockets.delete(ip);
      else sockets.set(ip, left);
    });
  }

  // ---------- Socket.IO ----------
  // shield.attachSocketIO(io)  — logo depois de criar o io.
  function attachSocketIO(io) {
    io.use((socket, next) => {
      const req = socket.request;
      const ip = getIp(req);
      const r = check(ip, 5);
      if (!r.ok) return next(new Error('Muitas requisições'));
      if ((sockets.get(ip) || 0) >= cfg.maxSocketsPerIp && !allow.has(ip)) return next(new Error('Muitas conexões'));
      sockets.set(ip, (sockets.get(ip) || 0) + 1);
      socket.once('disconnect', () => {
        const left = (sockets.get(ip) || 1) - 1;
        if (left <= 0) sockets.delete(ip);
        else sockets.set(ip, left);
      });
      let msgSecond = Date.now();
      let msgCount = 0;
      socket.use((packet, nextPacket) => {
        const now = Date.now();
        if (now - msgSecond >= 1000) {
          msgSecond = now;
          msgCount = 0;
        }
        if (++msgCount > cfg.maxMessagesPerSecond && !allow.has(ip)) {
          check(ip, cfg.maxPerWindow);
          return socket.disconnect(true);
        }
        nextPacket();
      });
      next();
    });
  }

  // ---------- Limpeza e relatório ----------
  function cleanup(force) {
    const now = Date.now();
    const idle = force ? 60_000 : 10 * 60_000;
    for (const [ip, s] of ips) {
      if (s.bannedUntil < now && now - s.lastSeen > idle) ips.delete(ip);
    }
  }

  function stats() {
    const now = Date.now();
    const banned = [];
    for (const [ip, s] of ips) if (s.bannedUntil > now) banned.push({ ip, minutesLeft: Math.ceil((s.bannedUntil - now) / 60000), bans: s.bans });
    return { underAttack, loadShed, trackedIps: ips.size, banned, recentBans: recent.slice(0, 20) };
  }

  function unban(ip) {
    const s = ips.get(normalizeIp(ip));
    if (s) {
      s.bannedUntil = 0;
      s.strikes = 0;
      s.count = 0;
    }
  }

  const timer = setInterval(() => {
    cleanup(false);
    if (cfg.log && minute.total > 0) {
      const top = [...minute.perIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ip, n]) => `${ip}=${n}`).join(', ');
      console.log(
        `[BLUEX SHIELD] último minuto: ${minute.total} pedidos, ${minute.blocked} bloqueados, ${minute.newBans} bans novos, ` +
          `${stats().banned.length} IPs banidos agora. Top: ${top}`
      );
    }
    minute.total = 0;
    minute.blocked = 0;
    minute.newBans = 0;
    minute.perIp.clear();
  }, cfg.logIntervalMs);
  timer.unref();

  return {
    middleware,
    protectServer,
    wsVerifyClient,
    trackWebSocket,
    attachSocketIO,
    check,
    checkRequest,
    reject,
    onConnection,
    onUpgrade,
    setTimeouts,
    getIp,
    stats,
    unban,
    config: cfg,
  };
}

module.exports = { createShield, DEFAULTS, isCloudflareIp, isPrivateIp };
