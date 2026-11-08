// ---------- BLUEX SHIELD (BLUE SPORTS GAMES) — núcleo ----------
// Não precisa mexer neste ficheiro. Quem liga tudo é o index.js
// (require('./bluex-shield') no topo do jogo). Os valores abaixo são os
// padrões; só altera se souberes o que estás a fazer.

// Máquina própria (sem painel tipo Render)? Basta um arquivo bluex-shield/config.json:
// { "key": "bxs_...", "url": "https://seu-protection-bluex", "site": "Nome do jogo" }
// Variáveis de ambiente, se existirem, têm prioridade.
let FILE_CFG = {};
try { FILE_CFG = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'config.json'), 'utf8')) || {}; } catch (_) {}

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
  // --- v3: monitoramento e relatório remoto ---
  suspectPerMinute: 5_000, // provável DDoS: liga a DEFESA AUTOMÁTICA (limites 4x mais apertados)
  alertPerMinute: 10_000, // EXTREMO: defesa máxima (limites 8x mais apertados) + alerta
  elevatedPerMinute: 1_000, // "pedidos demais": sinaliza no painel (amarelo)
  siteName: process.env.BLUEX_SHIELD_SITE || FILE_CFG.site || '', // nome do site no painel (ex.: "Jogo do João")
  reportKey: process.env.BLUEX_SHIELD_KEY || FILE_CFG.key || '', // chave do site no Protection BLUEX (pedir ao dono)
  reportUrl: process.env.BLUEX_SHIELD_URL || FILE_CFG.url || 'https://protection-bluex.onrender.com',
  minAbusiveToReport: 200, // só manda IP pro painel se ele fez >= isto no minuto (IP normal NUNCA é enviado)
  suspiciousKeep: 300, // quantos pedidos suspeitos guardar na memória
  // --- v4: anti-zumbi (botnet) ---
  zombieMinNewIps: 120, // IPs NOVOS por minuto que, sozinhos, ligam o modo anti-zumbi (ou 6x o normal do site, o que for maior)
  zombieHoldMs: 10 * 60_000, // quanto tempo o modo anti-zumbi fica ligado depois do último disparo
  toolUaWeight: 30, // peso de pedido com User-Agent de ferramenta/robô (curl, python-requests...)
  noBrowserSensitiveWeight: 15, // POST em rota sensível sem cabeçalhos de navegador (Accept-Language)
  log: true,
  logIntervalMs: 60_000,
  maxTrackedIps: 200_000, // limite de memória
};

const net = require('net');
// User-Agents de ferramentas/robôs/scanners (nunca navegador de gente de verdade).
const TOOL_UA = /(curl|wget|python-requests|python-urllib|aiohttp|httpx|go-http-client|libwww|scrapy|java\/|apache-httpclient|node-fetch|undici|masscan|zgrab|nikto|sqlmap|nmap|hydra|dirbuster|gobuster|ffuf|wpscan|headlesschrome|phantomjs|selenium|puppeteer|playwright)/i;

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
  const minute = { total: 0, blocked: 0, newBans: 0, newIps: 0, perIp: new Map() };
  if (cfg.reportKey && cfg.log) console.log('[BLUEX SHIELD] 🔗 vinculado ao Protection BLUEX' + (cfg.siteName ? ' como "' + cfg.siteName + '"' : '') + '.');
  const recent = []; // últimos bans (pro painel admin)
  const suspicious = []; // pedidos suspeitos/bloqueados (coleta completa: ip, rota, user-agent...)
  const history = []; // 1 ponto por minuto (últimas 2h)
  let minuteAlerted = false;
  let minuteStart = Date.now();
  let defense = 0; // 0 normal | 1 provável DDoS | 2 extremo
  let defenseUntil = 0;
  let manualUntil = 0; // modo ataque ligado à mão (botão do monitor)
  let zombieUntil = 0; // modo anti-zumbi (muitos IPs novos de uma vez)
  let baseNewIps = 0; // média de IPs novos por minuto (normal do site)
  let lastAlertAt = 0;
  let lastReportErr = '';
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
      // Túnel local (Cloudflare Tunnel / ngrok rodando na MESMA máquina): a conexão vem de 127.0.0.1.
      if (isPrivateIp(remote) && !headers['x-forwarded-for'] && headers['cf-connecting-ip']) return normalizeIp(headers['cf-connecting-ip']);
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
      minute.newIps++;
      // Botnet/zumbis: de repente chegam MUITOS IPs que nunca vieram (bem acima do normal do site).
      const zLimit = Math.max(cfg.zombieMinNewIps, baseNewIps * 6);
      if (minute.newIps >= zLimit) {
        if (zombieUntil < now && cfg.log) console.warn(`[BLUEX SHIELD] 🧟 MODO ANTI-ZUMBI ligado (${minute.newIps} IPs novos no minuto; normal ~${Math.round(baseNewIps)})`);
        zombieUntil = now + cfg.zombieHoldMs;
      }
    }
    return s;
  }

  function manualActive() { return manualUntil > Date.now(); }
  function zombieActive() { return zombieUntil > Date.now(); }
  // true quando o site está em alerta (automático ou manual): IPs novos ficam em espera e login/cadastro pedem prova anti-robô.
  function attackActive() { return underAttack || loadShed || defense > 0 || manualActive() || zombieActive(); }
  function setAttackMode(minutes) {
    manualUntil = minutes > 0 ? Date.now() + Math.min(minutes, 24 * 60) * 60_000 : 0;
    if (cfg.log) console.warn(manualUntil ? `[BLUEX SHIELD] 🛑 MODO ATAQUE ligado manualmente por ${minutes} min` : '[BLUEX SHIELD] modo ataque manual desligado');
  }

  // Núcleo: decide se um pedido do IP passa. weight = quanto "custa".
  function check(ip, weight = 1, meta) {
    const now = Date.now();
    minute.total++;
    minute.perIp.set(ip, (minute.perIp.get(ip) || 0) + 1);
    if (minute.total >= cfg.alertPerMinute && !minuteAlerted) {
      minuteAlerted = true;
      lastAlertAt = Date.now();
      if (cfg.log) console.warn(`[BLUEX SHIELD] 🚨 CASO EXTREMO: ${minute.total} pedidos neste minuto (limite ${cfg.alertPerMinute})`);
      sendReport(true);
    }
    // Defesa automática: estima pedidos/minuto e, se for DDoS provável, aperta os limites.
    {
      const el = Math.max(10_000, Date.now() - minuteStart);
      const rate = (minute.total / el) * 60_000;
      const lvl = rate >= cfg.alertPerMinute ? 2 : rate >= cfg.suspectPerMinute ? 1 : 0;
      if (lvl > defense) {
        defense = lvl;
        if (cfg.log) console.warn(`[BLUEX SHIELD] ${lvl === 2 ? '🚨 DEFESA MÁXIMA' : '⚠️ DEFESA AUTOMÁTICA'} ligada (~${Math.round(rate)} pedidos/min)`);
      }
      if (lvl > 0) defenseUntil = Date.now() + 2 * 60_000;
      else if (defense > 0 && Date.now() > defenseUntil) {
        defense = 0;
        if (cfg.log) console.warn('[BLUEX SHIELD] defesa automática desligada (tráfego normalizou)');
      }
    }
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

    if (attackActive() && now - s.firstSeen < cfg.trustedAfterMs) {
      return block(s, 'sob_ataque', 5);
    }

    if (now - s.windowStart >= cfg.windowMs) {
      s.windowStart = now;
      s.count = 0;
    }
    s.count += weight;
    const lvlNow = Math.max(defense, manualActive() || zombieActive() ? 1 : 0);
    const limitNow = lvlNow === 2 ? Math.max(60, cfg.maxPerWindow / 8) : lvlNow === 1 ? Math.max(120, cfg.maxPerWindow / 4) : cfg.maxPerWindow;
    if (s.count > limitNow) {
      // Conta 1 "strike" por janela estourada, não por pedido.
      if (!s.struckThisWindow || s.struckThisWindow !== s.windowStart) {
        s.struckThisWindow = s.windowStart;
        s.strikes++;
      }
      // Flood muito forte (3x o limite numa janela só) = ban na hora.
      if (s.count > limitNow * 3 && s.strikes < cfg.strikesToBan) s.strikes = cfg.strikesToBan;
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
    if (weight > 1 && meta && meta.tag) record(ip, meta.tag, weight);
    return { ok: true };

    function block(st, reason, defaultRetry) {
      minute.blocked++;
      record(ip, reason, weight);
      const retryAfter = st.bannedUntil > now ? Math.ceil((st.bannedUntil - now) / 1000) : defaultRetry || Math.ceil((st.windowStart + cfg.windowMs - now) / 1000);
      return { ok: false, reason, retryAfter: Math.max(1, retryAfter) };
    }
  }

  // PRIVACIDADE: só guarda IP abusivo + categoria do motivo. NUNCA rota, user-agent,
  // host, referer, cookies, corpo do pedido ou qualquer dado de jogador.
  function record(ip, reason, weight) {
    suspicious.push({ t: new Date().toISOString(), ip, reason, weight });
    if (suspicious.length > cfg.suspiciousKeep) suspicious.shift();
  }

  function levelOf(total) {
    return total >= cfg.alertPerMinute ? 'extremo' : total >= cfg.suspectPerMinute ? 'suspeito' : total >= cfg.elevatedPerMinute ? 'elevado' : 'normal';
  }

  // Manda o resumo do minuto pro Protection BLUEX (se houver chave). Nunca derruba o jogo.
  function sendReport(urgent) {
    if (!cfg.reportKey || !cfg.reportUrl || typeof fetch !== 'function') return;
    try {
      // Só IPs claramente abusivos (>= minAbusiveToReport no minuto) — IP de jogador normal nunca sai daqui.
      const top = [...minute.perIp.entries()].filter(([, n]) => n >= cfg.minAbusiveToReport).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([ip, n]) => ({ ip, n }));
      const body = {
        key: cfg.reportKey,
        site: cfg.siteName || undefined,
        urgent: !!urgent,
        at: new Date().toISOString(),
        total: minute.total,
        blocked: minute.blocked,
        newBans: minute.newBans,
        level: levelOf(minute.total),
        defense,
        underAttack,
        loadShed,
        top,
        banned: stats().banned.slice(0, 30),
        suspicious: suspicious.slice(-40),
      };
      fetch(cfg.reportUrl.replace(/\/+$/, '') + '/shield/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
      })
        .then(async (r) => {
          lastReportErr = r.ok ? '' : 'HTTP ' + r.status;
          if (!r.ok) return;
          const j = await r.json().catch(() => null);
          // Comandos do painel (dono ou usuário do site): derrubar / liberar IP.
          for (const c of (j && j.commands) || []) {
            if (!c || net.isIP(String(c.ip || '')) === 0) continue;
            if (c.type === 'ban') ban(c.ip, Math.min(Math.max(parseInt(c.minutes, 10) || 60, 1), 1440));
            else if (c.type === 'unban') unban(c.ip);
          }
        })
        .catch((e) => { lastReportErr = String((e && e.message) || e); });
    } catch (_) {}
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
      // Robô com User-Agent de ferramenta (curl, python-requests, scrapy...): navegador de verdade nunca usa.
      else if (TOOL_UA.test(String(req.headers['user-agent']))) weight = cfg.toolUaWeight;
      // Rotas sensíveis: limite próprio por minuto.
      if (req.method === 'POST' && cfg.sensitivePaths.some((p) => path.startsWith(p))) {
        const now = Date.now();
        let q = sensitive.get(ip);
        if (!q || now - q.start > 60_000) { q = { n: 0, start: now }; sensitive.set(ip, q); }
        if (++q.n > cfg.sensitiveMaxPerMinute) weight = Math.max(weight, 150);
        // Navegador sempre manda Accept-Language; robô que finge ser navegador quase nunca.
        else if (req.headers && !req.headers['accept-language']) weight = Math.max(weight, cfg.noBrowserSensitiveWeight);
        if (sensitive.size > cfg.maxTrackedIps) sensitive.clear();
      }
      // Muitos 404 seguidos = varredura de URLs: cobra a mais na resposta.
      if (res && typeof res.once === 'function') {
        res.once('finish', () => {
          if (res.statusCode === 404) check(ip, cfg.notFoundWeight - 1, { tag: 'varredura_404' });
        });
      }
    }
    const h = req.headers || {};
    return check(ip, weight, {
      tag: weight >= cfg.trapWeight ? 'armadilha_scanner' : weight >= 150 ? 'rota_sensivel_abuso' : !h['user-agent'] ? 'sem_user_agent' : weight === cfg.toolUaWeight ? 'bot_ferramenta' : weight === cfg.noBrowserSensitiveWeight ? 'bot_sem_navegador' : weight > 1 ? 'peso_extra' : '',
    });
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
    const total = minute.total;
    return {
      defense, underAttack, loadShed, trackedIps: ips.size,
      attackMode: { active: attackActive(), manual: manualActive(), manualMinutesLeft: manualActive() ? Math.ceil((manualUntil - Date.now()) / 60000) : 0, zombie: zombieActive(), auto: defense > 0 || underAttack || loadShed, newIpsMinute: minute.newIps, newIpsNormal: Math.round(baseNewIps) }, banned, recentBans: recent.slice(0, 20),
      thresholds: { elevated: cfg.elevatedPerMinute, suspect: cfg.suspectPerMinute, extreme: cfg.alertPerMinute },
      currentMinute: { total, blocked: minute.blocked, newBans: minute.newBans, level: levelOf(total) },
      alertActive: Date.now() - lastAlertAt < 10 * 60_000,
      lastAlertAt: lastAlertAt ? new Date(lastAlertAt).toISOString() : null,
      history: history.slice(-120),
      suspicious: suspicious.slice(-100).reverse(),
      top: [...minute.perIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([ip, n]) => ({ ip, n })),
      reporting: { enabled: !!cfg.reportKey, url: cfg.reportKey ? cfg.reportUrl : null, lastError: lastReportErr || null },
    };
  }

  function ban(ip, minutes) {
    ip = normalizeIp(ip);
    if (allow.has(ip)) return;
    const now = Date.now();
    const s = state(ip, now);
    s.bans++;
    s.bannedUntil = now + minutes * 60_000;
    minute.newBans++;
    recent.unshift({ ip, at: new Date(now).toISOString(), minutes, n: s.bans, manual: true });
    if (recent.length > 50) recent.pop();
    if (cfg.log) console.warn(`[BLUEX SHIELD] 🚫 IP ${ip} derrubado manualmente por ${minutes} min (painel)`);
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
    history.push({ t: new Date().toISOString(), total: minute.total, blocked: minute.blocked, newBans: minute.newBans, level: levelOf(minute.total), underAttack });
    if (history.length > 120) history.shift();
    if (minute.total >= cfg.alertPerMinute) lastAlertAt = Date.now();
    if (minute.total > 0 || Date.now() % 300000 < cfg.logIntervalMs) sendReport(false);
    minuteAlerted = false;
    minuteStart = Date.now();
    minute.total = 0;
    minute.blocked = 0;
    if (!zombieActive()) baseNewIps = baseNewIps * 0.9 + minute.newIps * 0.1; // só aprende o normal quando não é ataque
    minute.newBans = 0;
    minute.newIps = 0;
    minute.perIp.clear();
  }, cfg.logIntervalMs);
  timer.unref();
  if (cfg.reportKey) { const first = setTimeout(() => sendReport(false), 3000); first.unref(); }

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
    ban,
    setAttackMode,
    attackActive,
    config: cfg,
  };
}

module.exports = { createShield, DEFAULTS, isCloudflareIp, isPrivateIp };
