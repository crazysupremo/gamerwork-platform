/* =========================================================================
   ZELVORA — Backend de integração com WhatsApp (API oficial da Meta)
   =========================================================================
   O que esse servidor faz:
   1. Recebe mensagens do WhatsApp via webhook da Meta (quando um trabalhador
      manda uma FOTO da folha de horas pelo WhatsApp).
   2. Baixa a foto, manda pro Gemini (mesma IA que já lê as fotos no site) e
      extrai as horas trabalhadas de cada dia.
   3. Descobre QUEM mandou comparando o número de telefone com o campo
      "Contato" cadastrado em cada trabalhador no sistema.
   4. Grava as horas direto no Firestore (mesmo banco do site) — assim que
      salvar, já aparece na tela de "Horas" do trabalhador automaticamente.
   5. Responde pro trabalhador confirmando (ou avisando se não deu pra ler).

   Esse servidor PRECISA ficar rodando 24h (diferente do site, que é estático).
   Ele é implantado como um "Web Service" separado no Render — não faz parte
   do site principal.
   ========================================================================= */

const express = require('express');
const app = express();
app.use(express.json());

/* ---------------- Variáveis de ambiente (configuradas no Render) ---------------- */
const {
  WHATSAPP_VERIFY_TOKEN,      // você escolhe essa palavra-senha, usada só na configuração do webhook
  WHATSAPP_ACCESS_TOKEN,      // token permanente gerado no Meta Developers
  WHATSAPP_PHONE_NUMBER_ID,   // ID do número de telefone do WhatsApp Business
  GEMINI_API_KEY,             // mesma chave do Gemini usada no site
  FIREBASE_API_KEY,           // mesma chave do Firebase usada no site
  FIREBASE_PROJECT_ID,        // normalmente "dfneto"
  PORT,
} = process.env;

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID || 'dfneto'}/databases/(default)/documents`;
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash'];

function logErro(contexto, e){
  console.error(`[${new Date().toISOString()}] ERRO em ${contexto}:`, e && e.message ? e.message : e);
}

/* ---------------- Firestore (mesmo formato usado no site: 1 documento por chave, valor em JSON string) ---------------- */
async function fsGet(key){
  const res = await fetch(`${FIRESTORE_BASE}/app_data/${encodeURIComponent(key)}?key=${FIREBASE_API_KEY}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Firestore GET falhou: ' + res.status + ' ' + await res.text().catch(()=>''));
  const data = await res.json();
  const val = data.fields && data.fields.value ? data.fields.value.stringValue : null;
  return val === null ? null : val;
}

async function fsSet(key, value){
  const url = `${FIRESTORE_BASE}/app_data/${encodeURIComponent(key)}?key=${FIREBASE_API_KEY}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { value: { stringValue: value } } }),
  });
  if (!res.ok) throw new Error('Firestore SET falhou: ' + res.status + ' ' + await res.text().catch(()=>''));
}

/* ---------------- Gemini (mesma lógica de leitura de foto de horas do site) ---------------- */
async function tentarChamadaGemini(model, body){
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`[${model}] HTTP ${res.status} — ${(await res.text().catch(()=> '')).slice(0,150)}`);
  return res.json();
}

async function analisarFotoHoras(base64, mimeType){
  const promptSistema = `Você lê fotos de folhas de ponto/registro de horas de trabalhadores (formulários escritos à mão ou impressos, em português ou espanhol, tipo "DFNETO LDA" ou "INTEGASA"). A partir da imagem, extraia CADA linha de dia trabalhado com a data e a quantidade de horas daquele dia (se tiver Entrada e Saída em vez de "Horas" já pronta, calcule a diferença). Responda SOMENTE em JSON válido, nesse formato exato, sem nenhum texto antes ou depois:
{"legivel": true ou false, "entradas": [{"data":"AAAA-MM-DD","horas": numero}], "motivo_ilegivel": "string, só preencha se legivel for false, explicando o que está ruim (foto borrada, cortada, sem números visíveis, etc)"}
Se não conseguir ler a maior parte da folha com confiança, retorne legivel:false e entradas:[]. Datas devem ser convertidas pro formato AAAA-MM-DD (assuma ano atual se não estiver escrito). Não invente valores que não estão visíveis na imagem.`;

  const body = {
    contents: [{ role: 'user', parts: [
      { text: 'Leia essa folha de horas e responda no formato JSON pedido.' },
      { inlineData: { mimeType, data: base64 } },
    ]}],
    systemInstruction: { parts: [{ text: promptSistema }] },
    generationConfig: { maxOutputTokens: 1000, responseMimeType: 'application/json' },
  };

  const erros = [];
  for (const model of GEMINI_MODELS){
    try{
      const data = await tentarChamadaGemini(model, body);
      const texto = data?.candidates?.[0]?.content?.parts?.map(p=>p.text).join('') || '';
      if (texto) return JSON.parse(texto);
      erros.push(`[${model}] resposta vazia`);
    }catch(e){ erros.push(e.message); }
  }
  throw new Error('Não consegui analisar a foto: ' + erros.join(' | '));
}

/* ---------------- WhatsApp Cloud API ---------------- */
function normalizarTelefone(t){
  // mantém só dígitos e compara pelos últimos 9 (suficiente pra não confundir números de
  // países diferentes com mesmo DDI, e tolera o usuário ter cadastrado com/sem +351 etc.)
  return (t || '').replace(/\D/g, '').slice(-9);
}

async function baixarMidiaWhatsapp(mediaId){
  const metaRes = await fetch(`${GRAPH_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
  });
  if (!metaRes.ok) throw new Error('Falha ao obter metadados da mídia: ' + metaRes.status);
  const meta = await metaRes.json();
  const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` } });
  if (!binRes.ok) throw new Error('Falha ao baixar a mídia: ' + binRes.status);
  const buffer = Buffer.from(await binRes.arrayBuffer());
  return { base64: buffer.toString('base64'), mimeType: meta.mime_type || 'image/jpeg' };
}

async function enviarMensagemWhatsapp(paraTelefone, texto){
  try{
    await fetch(`${GRAPH_BASE}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: paraTelefone,
        type: 'text',
        text: { body: texto },
      }),
    });
  }catch(e){ logErro('enviarMensagemWhatsapp', e); }
}

/* ---------------- Webhook: verificação (GET) ---------------- */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN){
    console.log('Webhook verificado com sucesso pela Meta.');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/* ---------------- Webhook: mensagens recebidas (POST) ---------------- */
app.post('/webhook', async (req, res) => {
  // responde rápido pra Meta não reenviar o evento; processamento continua depois
  res.sendStatus(200);

  try{
    const entry = req.body.entry && req.body.entry[0];
    const change = entry && entry.changes && entry.changes[0];
    const value = change && change.value;
    const mensagens = value && value.messages;
    if (!mensagens || !mensagens.length) return; // status de entrega, não é mensagem nova

    for (const msg of mensagens){
      const de = msg.from; // telefone de quem mandou, formato internacional sem "+"
      await processarMensagem(de, msg);
    }
  }catch(e){
    logErro('webhook POST', e);
  }
});

async function processarMensagem(de, msg){
  // carrega a lista de trabalhadores do banco a cada mensagem (garante dado sempre atual)
  let trabalhadores = [];
  try{
    const raw = await fsGet('trabalhadores');
    trabalhadores = raw ? JSON.parse(raw) : [];
  }catch(e){ logErro('fsGet trabalhadores', e); }

  const telDe = normalizarTelefone(de);
  const trab = trabalhadores.find(t => normalizarTelefone(t.contato) === telDe && telDe.length >= 8);

  if (msg.type !== 'image'){
    if (!trab){
      await enviarMensagemWhatsapp(de, 'Olá! Não encontrei seu número cadastrado no sistema da Zelvora. Peça ao responsável de RH para confirmar seu telefone no seu cadastro, e depois me envie uma FOTO da sua folha de horas.');
    } else {
      await enviarMensagemWhatsapp(de, `Olá, ${trab.nome.split(' ')[0]}! Para registrar suas horas, me envie uma FOTO da sua folha de ponto/registro de horas.`);
    }
    return;
  }

  if (!trab){
    await enviarMensagemWhatsapp(de, 'Recebi sua foto, mas não encontrei esse número cadastrado no sistema. Peça ao responsável de RH para confirmar seu telefone no seu cadastro e me envie a foto de novo.');
    return;
  }

  try{
    const { base64, mimeType } = await baixarMidiaWhatsapp(msg.image.id);
    const resultado = await analisarFotoHoras(base64, mimeType);

    if (!resultado.legivel || !resultado.entradas || resultado.entradas.length === 0){
      await enviarMensagemWhatsapp(de, '⚠️ ' + (resultado.motivo_ilegivel || 'Não consegui ler essa foto com clareza. Tenta tirar de novo com mais luz, sem cortar a folha e sem reflexo.'));
      return;
    }

    // relê a lista mais recente pra não sobrescrever uma mudança feita no site enquanto a IA lia a foto
    const rawAtual = await fsGet('trabalhadores');
    const trabalhadoresAtual = rawAtual ? JSON.parse(rawAtual) : trabalhadores;
    const trabAtual = trabalhadoresAtual.find(t => t.id === trab.id);
    if (!trabAtual) throw new Error('Trabalhador não encontrado mais no banco.');
    if (!trabAtual.horas) trabAtual.horas = [];

    const empresaId = trabAtual.empresaId || null;
    const valorHora = trabAtual.valorHora || 0;
    const datasEnviadas = new Set(resultado.entradas.map(e => e.data));
    // remove lançamentos antigos da mesma empresa nas mesmas datas, pra não duplicar se reenviar a foto
    trabAtual.horas = trabAtual.horas.filter(h => !(datasEnviadas.has(h.data) && (h.empresaId || null) === empresaId));

    let totalHoras = 0;
    resultado.entradas.forEach(e => {
      const qtd = Number(e.horas);
      if (e.data && qtd > 0){
        trabAtual.horas.push({ id: 'wa_' + Date.now() + '_' + Math.random().toString(36).slice(2,8), data: e.data, quantidade: qtd, empresaId, valorHora, origem: 'whatsapp' });
        totalHoras += qtd;
      }
    });

    await fsSet('trabalhadores', JSON.stringify(trabalhadoresAtual));

    const resumo = resultado.entradas.map(e => `${e.data.split('-').reverse().join('/')}: ${e.horas}h`).join('\n');
    await enviarMensagemWhatsapp(de, `✅ Horas registradas, ${trabAtual.nome.split(' ')[0]}!\n\n${resumo}\n\nTotal: ${totalHoras}h. Já está salvo no sistema.`);
  }catch(e){
    logErro('processarMensagem (imagem)', e);
    await enviarMensagemWhatsapp(de, '⚠️ Deu um erro ao processar sua foto agora. Tenta de novo em alguns minutos, ou avisa o responsável de RH.');
  }
}

/* ---------------- Healthcheck ---------------- */
app.get('/', (req, res) => {
  res.send('Zelvora WhatsApp backend está rodando. ✅');
});

const porta = PORT || 3000;
app.listen(porta, () => console.log(`Servidor WhatsApp rodando na porta ${porta}`));
