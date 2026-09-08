// ---------- PROTECTION BLUEX (BLUE SPORTS GAMES) ----------
// Serviço standalone (não faz parte do NEXT GAME) de verificação de idade,
// moderação de conteúdo e análise de texto suspeito — pensado pra ser
// vendido/licenciado como API pra outras empresas integrarem nos próprios
// produtos.
//
// A análise de câmera de segurança comercial (furto/roubo) NÃO mora aqui —
// é o BLUEX SECURITY, um app totalmente separado (outro repositório, outro
// deploy, outro painel admin), porque é outro público-alvo (comércio/
// varejo, não plataformas online).
//
// IMPORTANTE — limitações reais que qualquer empresa cliente precisa saber
// (documentadas também no README): isso usa um modelo de visão de propósito
// geral (Groq) pra dar uma camada de sinalização automática. NÃO é, e não
// deve ser vendido como, um substituto de: (1) serviços especializados de
// detecção de CSAM que comparam contra bancos de hashes conhecidos
// (PhotoDNA/Thorn Safer) — esta API nunca tenta identificar exploração
// infantil especificamente, só quando pedido explicitamente marca
// "revisar_urgente" pra qualquer suspeita envolvendo menor em contexto de
// risco, pra revisão humana; (2) verificação de idade legalmente vinculante
// — é uma estimativa por IA, não documento oficial.
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieSession = require('cookie-session');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 4900;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || 'bluex-dev-secret-troque-em-producao';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
// 28MB — dá espaço pra áudio (até 20MB) ou vários frames de vídeo (até 12)
// em base64 no mesmo request, além de imagem/texto normais.
app.use(express.json({ limit: '28mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  cookieSession({
    name: 'bluex_admin_session',
    keys: [SESSION_SECRET],
    maxAge: 12 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
  })
);

const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use('/v1/', apiLimiter);
// Áudio/vídeo são bem mais caros (transcrição, ou vários frames por
// chamada) — limite mais apertado que o geral, só nesses dois.
const heavyLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const adminLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Compara senha em tempo constante — evita que a diferença de tempo de
// resposta vaze quantos caracteres do início a senha tentada acertou.
function passwordMatches(attempt, expected) {
  const attemptBuf = Buffer.from(String(attempt || ''));
  const expectedBuf = Buffer.from(String(expected || ''));
  if (attemptBuf.length !== expectedBuf.length) {
    crypto.timingSafeEqual(expectedBuf, expectedBuf); // mantém o tempo constante mesmo no caminho "tamanho diferente"
    return false;
  }
  return crypto.timingSafeEqual(attemptBuf, expectedBuf);
}

// ---------- Proteção contra SSRF em audio_url/image_url ----------
// Como /v1/moderate-audio baixa o áudio de audio_url DIRETO no nosso
// servidor (diferente de image_url, que é repassada pra Groq buscar), uma
// empresa cliente mal-intencionada (ou com a chave de API vazada) poderia
// tentar usar isso pra sondar rede interna (ex: metadata endpoint de nuvem,
// serviços internos). Resolve o hostname e bloqueia IPs privados/loopback/
// link-local antes de buscar.
function isPrivateOrReservedIp(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (net.isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('::ffff:')) {
      const v4 = lower.split(':').pop();
      if (net.isIP(v4) === 4) return isPrivateOrReservedIp(v4);
    }
    return false;
  }
  return true; // não reconhecido como IP válido -> trata como inseguro
}

async function isSafeExternalUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.hostname === 'localhost') return false;
  try {
    const { address } = await dns.lookup(parsed.hostname);
    return !isPrivateOrReservedIp(address);
  } catch (_) {
    return false;
  }
}

// ---------- AUTENTICAÇÃO POR CHAVE DE API (empresas clientes) ----------
async function requireApiKey(req, res, next) {
  const key = req.header('X-API-Key') || (req.query && req.query.api_key);
  if (!key) return res.status(401).json({ error: 'Chave de API ausente (header X-API-Key).' });
  const client = await db.get('SELECT * FROM clients WHERE api_key = ?', [key]);
  if (!client || !client.is_active) return res.status(401).json({ error: 'Chave de API inválida ou inativa.' });
  req.client = client;
  next();
}

// ---------- AUTENTICAÇÃO DO PAINEL ADMIN (você, não os clientes) ----------
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.isAdmin) return res.status(401).json({ error: 'Não autenticado.' });
  next();
}

app.post(
  '/admin/login',
  adminLoginLimiter,
  asyncHandler(async (req, res) => {
    if (!ADMIN_PASSWORD) {
      return res.status(500).json({ error: 'ADMIN_PASSWORD não configurada no servidor. Veja o README.' });
    }
    const { password } = req.body || {};
    if (!passwordMatches(password, ADMIN_PASSWORD)) return res.status(401).json({ error: 'Senha incorreta.' });
    req.session.isAdmin = true;
    res.json({ ok: true });
  })
);

app.post('/admin/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/admin/me', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// ---------- GESTÃO DE EMPRESAS CLIENTES (painel admin) ----------
app.get(
  '/admin/clients',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await db.all('SELECT id, company_name, contact_email, plan, is_active, created_at FROM clients ORDER BY created_at DESC'));
  })
);

app.post(
  '/admin/clients',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { company_name, contact_email, plan } = req.body || {};
    if (!company_name || !String(company_name).trim()) {
      return res.status(400).json({ error: 'Nome da empresa é obrigatório.' });
    }
    const id = uuidv4();
    const apiKey = 'bluex_' + crypto.randomBytes(24).toString('hex');
    await db.run(
      'INSERT INTO clients (id, company_name, contact_email, api_key, plan) VALUES (?, ?, ?, ?, ?)',
      [id, String(company_name).trim().slice(0, 120), (contact_email || '').slice(0, 160) || null, apiKey, plan || 'trial']
    );
    res.json({ id, company_name, api_key: apiKey });
  })
);

app.post(
  '/admin/clients/:id/toggle',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const client = await db.get('SELECT is_active FROM clients WHERE id = ?', [req.params.id]);
    if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
    await db.run('UPDATE clients SET is_active = ? WHERE id = ?', [client.is_active ? 0 : 1, req.params.id]);
    res.json({ ok: true });
  })
);

app.post(
  '/admin/clients/:id/regenerate-key',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const apiKey = 'bluex_' + crypto.randomBytes(24).toString('hex');
    await db.run('UPDATE clients SET api_key = ? WHERE id = ?', [apiKey, req.params.id]);
    res.json({ api_key: apiKey });
  })
);

// Lê limit/offset/client_id da query string com valores seguros (limit
// capado em 200 pra não deixar o admin pedir uma página gigante).
function parsePagination(req) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const clientId = req.query.client_id && String(req.query.client_id).trim() ? String(req.query.client_id).trim() : null;
  return { limit, offset, clientId };
}

app.get(
  '/admin/usage',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { limit, offset, clientId } = parsePagination(req);
    const where = clientId ? 'WHERE u.client_id = ?' : '';
    const args = clientId ? [clientId] : [];
    const total = await db.get(`SELECT COUNT(*) as count FROM usage_logs u ${where}`, args);
    const rows = await db.all(
      `SELECT u.id, u.endpoint, u.flagged, u.duration_ms, u.created_at, c.company_name
       FROM usage_logs u JOIN clients c ON c.id = u.client_id
       ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      [...args, limit, offset]
    );
    res.json({ rows, total: total ? total.count : 0, limit, offset });
  })
);

app.get(
  '/admin/flagged',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { limit, offset, clientId } = parsePagination(req);
    const where = clientId ? 'WHERE f.client_id = ?' : '';
    const args = clientId ? [clientId] : [];
    const total = await db.get(`SELECT COUNT(*) as count FROM flagged_cases f ${where}`, args);
    const rows = await db.all(
      `SELECT f.id, f.endpoint, f.categories, f.reason, f.confidence, f.reviewed, f.created_at, c.company_name
       FROM flagged_cases f JOIN clients c ON c.id = f.client_id
       ${where} ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
      [...args, limit, offset]
    );
    res.json({ rows, total: total ? total.count : 0, limit, offset });
  })
);

app.post(
  '/admin/flagged/:id/review',
  requireAdmin,
  asyncHandler(async (req, res) => {
    await db.run('UPDATE flagged_cases SET reviewed = 1 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  })
);

// ---------- NÚCLEO: chamada de visão/texto via Groq, com CHECAGEM DUPLA ----------
// CORRIGIDO — o README já documentava "checagem dupla opcional" (dois
// modelos em paralelo, lógica OR) e o banco (db.js) já tinha a coluna
// "confidence" pronta pra isso, mas essa lógica nunca tinha sido escrita de
// verdade aqui — o código só usava sempre 1 modelo só, sem confidence
// nenhuma, mesmo com GROQ_VISION_MODEL_2/GROQ_TEXT_MODEL_2 configuradas.
// Essa é a implementação de verdade do que o README promete.
async function callGroqVisionOnce(model, imageDataUrlOrUrl, promptText) {
  const apiKey = process.env.GROQ_API_KEY;
  const apiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({
      model,
      max_tokens: 250,
      messages: [
        { role: 'user', content: [{ type: 'text', text: promptText }, { type: 'image_url', image_url: { url: imageDataUrlOrUrl } }] },
      ],
    }),
  });
  if (!apiRes.ok) {
    const errText = await apiRes.text();
    console.error('Erro na Groq Vision (' + model + '):', apiRes.status, errText);
    return { flagged: false, error: true };
  }
  const data = await apiRes.json();
  const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '{}';
  const match = text.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(match ? match[0] : text);
  } catch (_) {
    return { flagged: false, error: true };
  }
}

async function callGroqTextOnce(model, promptText) {
  const apiKey = process.env.GROQ_API_KEY;
  const apiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ model, max_tokens: 250, messages: [{ role: 'user', content: promptText }] }),
  });
  if (!apiRes.ok) {
    const errText = await apiRes.text();
    console.error('Erro na Groq (texto, ' + model + '):', apiRes.status, errText);
    return { flagged: false, error: true };
  }
  const data = await apiRes.json();
  const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '{}';
  const match = text.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(match ? match[0] : text);
  } catch (_) {
    return { flagged: false, error: true };
  }
}

// Combina dois resultados (lógica OR: qualquer um sinalizando já marca
// flagged=true) — junta categorias sem repetir, e a confidence final é a
// MAIOR das duas (uma sinalização "alta" nunca deve ser rebaixada por causa
// do outro modelo não ter visto o mesmo risco).
//
// CORRIGIDO na revisão: essa função é reaproveitada tanto por
// /v1/moderate-image e /v1/moderate-video (formato "flagged"/"categories")
// quanto por /v1/age-verify (formato DIFERENTE: "flagged_as_minor"/
// "estimated_age") — a versão anterior só sabia lidar com o primeiro
// formato, então ligar a checagem dupla quebrava silenciosamente a
// verificação de idade (sempre voltava estimated_age:null). Agora trata os
// dois formatos.
const CONFIDENCE_RANK = { baixa: 1, média: 2, media: 2, alta: 3 };
function mergeResults(a, b) {
  if (!b) return a;
  const merged = {};
  if ('flagged' in a || 'flagged' in b) merged.flagged = !!a.flagged || !!b.flagged;
  if ('flagged_as_minor' in a || 'flagged_as_minor' in b) merged.flagged_as_minor = !!a.flagged_as_minor || !!b.flagged_as_minor;
  if ('categories' in a || 'categories' in b) {
    merged.categories = [...new Set([...(a.categories || []), ...(b.categories || [])])];
  }
  if ('estimated_age' in a || 'estimated_age' in b) {
    const ageA = a.estimated_age, ageB = b.estimated_age;
    merged.estimated_age = ageA != null && ageB != null ? Math.round((ageA + ageB) / 2) : ageA ?? ageB ?? null;
  }
  const confA = CONFIDENCE_RANK[a.confidence] || 0;
  const confB = CONFIDENCE_RANK[b.confidence] || 0;
  merged.confidence = confB > confA ? b.confidence : a.confidence || b.confidence || 'baixa';
  merged.reason = a.reason && b.reason && a.reason !== b.reason ? `${a.reason} / ${b.reason}` : a.reason || b.reason || null;
  return merged;
}

// CORRIGIDO na revisão: usava Promise.all, que descarta TUDO se só uma das
// duas chamadas falhar (ex: instabilidade de rede num dos dois modelos) —
// mesmo que a outra tivesse funcionado normal, o resultado virava
// "flagged:false" geral, na prática desligando a moderação por acaso.
// Promise.allSettled deixa cada lado falhar sem derrubar o outro.
async function callGroqVision(imageDataUrlOrUrl, promptText) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { flagged: false, skipped: true, error: 'GROQ_API_KEY não configurada' };
  const model1 = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';
  const model2 = process.env.GROQ_VISION_MODEL_2 || null;
  if (!model2) {
    try {
      return await callGroqVisionOnce(model1, imageDataUrlOrUrl, promptText);
    } catch (err) {
      console.error('Erro na Groq Vision:', err.message);
      return { flagged: false, error: true };
    }
  }
  const [s1, s2] = await Promise.allSettled([
    callGroqVisionOnce(model1, imageDataUrlOrUrl, promptText),
    callGroqVisionOnce(model2, imageDataUrlOrUrl, promptText),
  ]);
  const r1 = s1.status === 'fulfilled' ? s1.value : { flagged: false, error: true };
  const r2 = s2.status === 'fulfilled' ? s2.value : { flagged: false, error: true };
  if (s1.status === 'rejected') console.error('Erro na Groq Vision (modelo 1):', s1.reason);
  if (s2.status === 'rejected') console.error('Erro na Groq Vision (modelo 2):', s2.reason);
  return mergeResults(r1, r2);
}

async function callGroqText(promptText) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { flagged: false, skipped: true, error: 'GROQ_API_KEY não configurada' };
  const model1 = process.env.GROQ_TEXT_MODEL || 'llama-3.3-70b-versatile';
  const model2 = process.env.GROQ_TEXT_MODEL_2 || null;
  if (!model2) {
    try {
      return await callGroqTextOnce(model1, promptText);
    } catch (err) {
      console.error('Erro na Groq (texto):', err.message);
      return { flagged: false, error: true };
    }
  }
  const [s1, s2] = await Promise.allSettled([callGroqTextOnce(model1, promptText), callGroqTextOnce(model2, promptText)]);
  const r1 = s1.status === 'fulfilled' ? s1.value : { flagged: false, error: true };
  const r2 = s2.status === 'fulfilled' ? s2.value : { flagged: false, error: true };
  if (s1.status === 'rejected') console.error('Erro na Groq (texto, modelo 1):', s1.reason);
  if (s2.status === 'rejected') console.error('Erro na Groq (texto, modelo 2):', s2.reason);
  return mergeResults(r1, r2);
}

// Transcrição de áudio (Whisper via Groq) — usada só por /v1/moderate-audio,
// que roda a MESMA análise de texto de comportamento suspeito em cima do
// texto transcrito. O áudio em si nunca é salvo, só passa pela memória do
// processo (mesma política de privacidade do resto da API).
async function transcribeAudio(audioDataUrlOrUrl) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { text: '', error: 'GROQ_API_KEY não configurada' };
  const model = process.env.GROQ_AUDIO_MODEL || 'whisper-large-v3';
  try {
    let buffer, contentType;
    if (audioDataUrlOrUrl.startsWith('data:')) {
      const match = audioDataUrlOrUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return { text: '', error: 'data URL de áudio inválida' };
      contentType = match[1];
      buffer = Buffer.from(match[2], 'base64');
    } else {
      if (!(await isSafeExternalUrl(audioDataUrlOrUrl))) {
        return { text: '', error: 'URL de áudio inválida ou aponta pra um destino não permitido' };
      }
      const fileRes = await fetch(audioDataUrlOrUrl);
      if (!fileRes.ok) return { text: '', error: 'Não consegui baixar o áudio da URL' };
      contentType = fileRes.headers.get('content-type') || 'audio/ogg';
      buffer = Buffer.from(await fileRes.arrayBuffer());
    }
    const form = new FormData();
    const ext = contentType.includes('mpeg') ? 'mp3' : contentType.includes('wav') ? 'wav' : contentType.includes('ogg') ? 'ogg' : 'webm';
    form.append('file', new Blob([buffer], { type: contentType }), `audio.${ext}`);
    form.append('model', model);
    const apiRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey },
      body: form,
    });
    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('Erro na Groq (transcrição):', apiRes.status, errText);
      return { text: '', error: true };
    }
    const data = await apiRes.json();
    return { text: data.text || '' };
  } catch (err) {
    console.error('Erro ao transcrever áudio:', err.message);
    return { text: '', error: true };
  }
}

async function logUsage(clientId, endpoint, flagged, durationMs) {
  try {
    await db.run('INSERT INTO usage_logs (id, client_id, endpoint, flagged, duration_ms) VALUES (?, ?, ?, ?, ?)', [
      uuidv4(),
      clientId,
      endpoint,
      flagged ? 1 : 0,
      durationMs,
    ]);
  } catch (err) {
    console.error('Erro ao registrar uso:', err);
  }
}

async function logFlagged(clientId, endpoint, categories, reason, confidence) {
  try {
    await db.run('INSERT INTO flagged_cases (id, client_id, endpoint, categories, reason, confidence) VALUES (?, ?, ?, ?, ?, ?)', [
      uuidv4(),
      clientId,
      endpoint,
      JSON.stringify(categories || []),
      reason || null,
      confidence || null,
    ]);
  } catch (err) {
    console.error('Erro ao registrar caso sinalizado:', err);
  }
}

// Aceita só data URL de imagem ou URL http(s) — evita mandar lixo pra Groq
// (desperdiçando a chamada) e barra esquemas como file:// de cara.
function isValidImageValue(value) {
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value) || /^https?:\/\//i.test(value);
}

function extractImage(body) {
  if (!body) return null;
  const value = typeof body.image === 'string' ? body.image : typeof body.image_url === 'string' ? body.image_url : null;
  if (!value || !isValidImageValue(value)) return null;
  return value;
}

// ---------- V1: VERIFICAÇÃO DE IDADE ----------
const AGE_VERIFY_PROMPT =
  'Esta é uma foto de rosto enviada pra estimar a idade aproximada da pessoa (verificação de idade, não identificação — ' +
  'não tente reconhecer quem é a pessoa). Responda APENAS um JSON, sem texto extra, no formato ' +
  '{"estimated_age": número, "confidence": "baixa"|"média"|"alta", "flagged_as_minor": true ou false, "reason": "..."}. ' +
  'Marque flagged_as_minor=true se a pessoa aparentar ter menos de 18 anos. Se não conseguir identificar um rosto claro na ' +
  'imagem, responda {"estimated_age": null, "confidence": "baixa", "flagged_as_minor": false, "reason": "rosto não identificado"}.';

app.post(
  '/v1/age-verify',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const start = Date.now();
    const image = extractImage(req.body);
    if (!image) return res.status(400).json({ error: 'Envie "image" (data URL) ou "image_url".' });
    const result = await callGroqVision(image, AGE_VERIFY_PROMPT);
    const flagged = !!result.flagged_as_minor;
    await logUsage(req.client.id, 'age-verify', flagged, Date.now() - start);
    if (flagged) await logFlagged(req.client.id, 'age-verify', ['possivel_menor'], result.reason, result.confidence);
    res.json({
      estimated_age: result.estimated_age ?? null,
      confidence: result.confidence || 'baixa',
      flagged_as_minor: flagged,
      reason: result.reason || null,
    });
  })
);

// ---------- V1: MODERAÇÃO DE CONTEÚDO (IMAGEM) ----------
// CORRIGIDO ("verificação de armas não funciona"): a categoria de arma só
// pegava "arma de fogo real anunciada pra venda" — uma foto de arma de
// verdade em qualquer OUTRO contexto (ameaça, ostentação) passava direto.
// Ampliado pra cobrir arma em contexto de ameaça (não só venda), e
// adicionadas as categorias que o README já prometia mas o prompt não
// cobria: drogas ilícitas, ódio, automutilação/incentivo a suicídio.
// Também passou a pedir "confidence" e a sinalizar indícios AMBÍGUOS com
// confidence baixa em vez de simplesmente descartar (joga mais coisa pra
// fila de revisão humana, reduz o que passa despercebido).
const MODERATE_IMAGE_PROMPT =
  'Esta imagem foi enviada por um usuário de uma plataforma. Responda APENAS um JSON, sem texto extra, no formato ' +
  '{"flagged": true ou false, "categories": [...], "confidence": "baixa"|"média"|"alta", "reason": "..."}. ' +
  'Marque flagged=true se a imagem mostrar: nudez ou conteúdo sexual explícito real (não desenho/arte), violência física ' +
  'grave/sangue real, maus-tratos ou crueldade real contra animais (agressão, ferimentos, negligência grave — não ' +
  'caça/pesca/pecuária legais retratadas de forma normal), drogas ilícitas sendo usadas/vendidas, arma de fogo ou faca ' +
  'real usada de forma ameaçadora/intimidadora ou anunciada pra venda fora de canal legal (não conta sozinho uma arma ' +
  'legal guardada, numa vitrine de loja de verdade, ou em contexto normal de caça/tiro esportivo/coleção), símbolos ou ' +
  'discurso visual de ódio (extremismo, supremacismo), automutilação ou incentivo/instrução de suicídio, ou qualquer ' +
  'imagem envolvendo uma criança/adolescente em contexto sexualizado ou de risco (categoria "revisar_urgente"). Se o ' +
  'caso for claro, use confidence "alta". Se tiver indício real mas não 100% claro, marque flagged=true mesmo assim, ' +
  'com confidence "baixa" — não descarte só porque não tem certeza total, isso vai pra revisão humana, não pra punição ' +
  'automática. Não marque memes, prints de jogos, fotos comuns do dia a dia, cenas de caça/pesca/criação de animais ' +
  'dentro da normalidade, ou arte/desenho fictício — nesses casos flagged=false, confidence "alta".';

app.post(
  '/v1/moderate-image',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const start = Date.now();
    const image = extractImage(req.body);
    if (!image) return res.status(400).json({ error: 'Envie "image" (data URL) ou "image_url".' });
    const result = await callGroqVision(image, MODERATE_IMAGE_PROMPT);
    const flagged = !!result.flagged;
    await logUsage(req.client.id, 'moderate-image', flagged, Date.now() - start);
    if (flagged) await logFlagged(req.client.id, 'moderate-image', result.categories, result.reason, result.confidence);
    res.json({ flagged, categories: result.categories || [], confidence: result.confidence || 'baixa', reason: result.reason || null });
  })
);

// ---------- V1: ANÁLISE DE TEXTO (comportamento suspeito) ----------
// Ampliado com as categorias que o README já prometia: doxxing (expor dados
// pessoais de alguém sem consentimento) e golpe/fraude, além de ódio e
// drogas/armas em texto. Mesma lógica de confidence do lado de imagem.
const ANALYZE_TEXT_PROMPT_PREFIX =
  'Você é um classificador de segurança pra uma plataforma que recebe mensagens de texto entre usuários. Responda APENAS ' +
  'um JSON, sem texto extra, no formato {"flagged": true ou false, "categories": [...], "confidence": "baixa"|"média"|"alta", "reason": "..."}. ' +
  'Marque flagged=true se o texto mostrar sinais de: um adulto tentando esconder a própria idade ou se passar por menor ' +
  'pra se aproximar de uma criança/adolescente, tentativa de aliciamento (grooming) — insistência pra sair do app ' +
  'público, pedido de fotos/vídeos, pedido de dados pessoais (endereço, escola, telefone) de quem parece ser menor, ' +
  'ameaças/coerção envolvendo menor, doxxing (expor dado pessoal de alguém sem consentimento, com intenção de expor/ ' +
  'assediar), discurso de ódio, golpe/fraude (phishing, pedido de dinheiro adiantado, esquema), ou venda de ' +
  'drogas/armas ilegais. NÃO marque conversas comuns entre adultos, flerte comum entre adultos, ou linguagem de jogo ' +
  '(ex: "te mato" num contexto de partida). Se o caso for claro, confidence "alta". Se tiver indício real mas ambíguo, ' +
  'marque flagged=true com confidence "baixa" em vez de descartar — vai pra revisão humana, não gera punição sozinho. ' +
  'Na dúvida sobre risco a menor especificamente, sempre marque flagged=true com categoria "revisar_urgente", mesmo ' +
  'com pouca certeza. ' +
  'Texto a analisar (delimitado por ---): ---';

app.post(
  '/v1/analyze-text',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const start = Date.now();
    const { text } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Envie "text".' });
    }
    const prompt = ANALYZE_TEXT_PROMPT_PREFIX + text.slice(0, 3000) + '---';
    const result = await callGroqText(prompt);
    const flagged = !!result.flagged;
    await logUsage(req.client.id, 'analyze-text', flagged, Date.now() - start);
    if (flagged) await logFlagged(req.client.id, 'analyze-text', result.categories, result.reason, result.confidence);
    res.json({ flagged, categories: result.categories || [], confidence: result.confidence || 'baixa', reason: result.reason || null });
  })
);

// ---------- V1: MODERAÇÃO DE ÁUDIO ----------
// Transcreve a fala e roda a MESMA análise de texto de cima em cima da
// transcrição. O áudio em si nunca é guardado, só passa pela memória do
// processo enquanto a requisição está sendo processada.
app.post(
  '/v1/moderate-audio',
  requireApiKey,
  heavyLimiter,
  asyncHandler(async (req, res) => {
    const start = Date.now();
    const { audio, audio_url } = req.body || {};
    const source = audio || audio_url;
    if (!source || typeof source !== 'string') {
      return res.status(400).json({ error: 'Envie "audio" (data URL base64) ou "audio_url".' });
    }
    const { text, error: transcribeError } = await transcribeAudio(source);
    if (transcribeError || !text.trim()) {
      await logUsage(req.client.id, 'moderate-audio', false, Date.now() - start);
      return res.json({ flagged: false, categories: [], confidence: 'baixa', reason: 'Não foi possível transcrever o áudio.' });
    }
    const prompt = ANALYZE_TEXT_PROMPT_PREFIX + text.slice(0, 3000) + '---';
    const result = await callGroqText(prompt);
    const flagged = !!result.flagged;
    await logUsage(req.client.id, 'moderate-audio', flagged, Date.now() - start);
    if (flagged) await logFlagged(req.client.id, 'moderate-audio', result.categories, result.reason, result.confidence);
    res.json({ flagged, categories: result.categories || [], confidence: result.confidence || 'baixa', reason: result.reason || null });
  })
);

// ---------- V1: MODERAÇÃO DE VÍDEO ----------
// O vídeo em si NÃO é processado aqui (pediria ffmpeg) — o cliente extrai os
// frames (ex: 1 por segundo, até 12 por request) e manda como imagens. Roda
// moderação de imagem em cada frame; flagged=true se qualquer um sinalizar.
const MAX_VIDEO_FRAMES = 12;

app.post(
  '/v1/moderate-video',
  requireApiKey,
  heavyLimiter,
  asyncHandler(async (req, res) => {
    const start = Date.now();
    const { frames } = req.body || {};
    if (!Array.isArray(frames) || frames.length === 0) {
      return res.status(400).json({ error: 'Envie "frames": lista de imagens (data URL ou URL) extraídas do vídeo.' });
    }
    if (frames.length > MAX_VIDEO_FRAMES) {
      return res.status(400).json({ error: `Máximo de ${MAX_VIDEO_FRAMES} frames por requisição.` });
    }
    if (frames.some((f) => typeof f !== 'string' || !isValidImageValue(f))) {
      return res.status(400).json({ error: 'Cada item de "frames" precisa ser uma data URL de imagem ou uma URL http(s).' });
    }
    const results = await Promise.all(
      frames.map(async (frame, index) => {
        const result = await callGroqVision(frame, MODERATE_IMAGE_PROMPT);
        return { index, flagged: !!result.flagged, categories: result.categories || [], confidence: result.confidence || 'baixa', reason: result.reason || null };
      })
    );
    const flaggedFrame = results.find((r) => r.flagged);
    const flagged = !!flaggedFrame;
    const categories = [...new Set(results.flatMap((r) => r.categories))];
    const confidence = flaggedFrame ? flaggedFrame.confidence : 'baixa';
    const reason = flaggedFrame ? `frame ${flaggedFrame.index}: ${flaggedFrame.reason || ''}` : null;
    await logUsage(req.client.id, 'moderate-video', flagged, Date.now() - start);
    if (flagged) await logFlagged(req.client.id, 'moderate-video', categories, reason, confidence);
    res.json({ flagged, categories, confidence, reason, frames: results });
  })
);

// A análise de câmera de segurança (furto/roubo) NÃO mora mais aqui — virou
// um app próprio e separado: BLUEX SECURITY (outra pasta, outro
// repositório, outro deploy, outro painel admin, próprio sistema de chave de
// API). Público-alvo diferente do PROTECTION BLUEX (comércio/varejo com
// câmera de loja, não plataformas online), por isso é vendido como produto
// à parte, não como mais um endpoint aqui dentro.

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    groq_configured: !!process.env.GROQ_API_KEY,
    dual_model_vision: !!process.env.GROQ_VISION_MODEL_2,
    dual_model_text: !!process.env.GROQ_TEXT_MODEL_2,
    turso_configured: !!process.env.TURSO_DATABASE_URL,
    admin_configured: !!ADMIN_PASSWORD,
  });
});

app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

db.initDb()
  .then(() => {
    app.listen(PORT, () => console.log('PROTECTION BLUEX rodando em http://localhost:' + PORT));
  })
  .catch((err) => {
    console.error('Falha ao iniciar o banco de dados:', err);
    process.exit(1);
  });
