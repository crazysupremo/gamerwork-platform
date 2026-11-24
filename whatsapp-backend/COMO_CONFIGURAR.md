# Como ligar o WhatsApp ao sistema Zelvora

Isso roda **separado** do site. O site continua estático no Render; este aqui é um
segundo serviço ("Web Service"), que fica o tempo todo ligado esperando mensagens
do WhatsApp chegarem.

## Passo 1 — Conta no Meta for Developers

1. Entre em https://developers.facebook.com/ com uma conta do Facebook (de
   preferência uma vinculada à sua empresa).
2. Clique em "Meus Apps" → "Criar app" → tipo **"Negócios"**.
3. Dentro do app, adicione o produto **WhatsApp**.
4. O Meta já cria um número de teste gratuito automaticamente — dá pra testar
   com ele antes de verificar a empresa de verdade (o número de teste manda
   mensagem só pra até 5 números que você cadastrar na própria tela do Meta).
5. Para usar com qualquer trabalhador (não só os 5 de teste), depois você
   precisa verificar seu negócio no Meta Business Suite e comprar/registrar
   um número de telefone de verdade — isso o Meta pede documentos da empresa,
   é um processo deles, não depende de mim.

## Passo 2 — Pegar as 3 informações que o backend precisa

Na página do produto WhatsApp dentro do seu app Meta:

- **Token de acesso temporário** (válido 24h, bom pra testar) ou, melhor,
  um **token permanente**: Configurações do App → Usuários do sistema → criar
  um "usuário de sistema" → gerar token com permissão `whatsapp_business_messaging`.
- **Phone number ID**: aparece na mesma tela, é o ID do número (não é o número
  de telefone em si).
- **Verify token**: essa você inventa — qualquer palavra-senha, ex:
  `zelvora-verify-2026`. Vai usar ela duas vezes: aqui e na configuração do
  webhook (passo 4).

## Passo 3 — Subir este backend no Render

1. Suba esta pasta (`whatsapp-backend`) pro mesmo repositório do GitHub (pode
   ser uma subpasta, ex: `whatsapp-backend/`) ou um repositório novo — tanto
   faz, desde que o Render enxergue o `package.json` e `index.js`.
2. No Render: **New +** → **Web Service** (NÃO é "Static Site" como o site
   principal).
3. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
4. Em **Environment Variables**, adicione:
   - `WHATSAPP_VERIFY_TOKEN` = a palavra-senha que você inventou no passo 2
   - `WHATSAPP_ACCESS_TOKEN` = o token do passo 2
   - `WHATSAPP_PHONE_NUMBER_ID` = o ID do passo 2
   - `GEMINI_API_KEY` = a mesma chave do Gemini que já está no site
   - `FIREBASE_API_KEY` = `AIzaSyAmfPvrMRdel0rQTRMKJvxhbprlFLHTv0M`
   - `FIREBASE_PROJECT_ID` = `dfneto`
5. Deploy. O Render vai te dar uma URL tipo
   `https://zelvora-whatsapp.onrender.com`.

## Passo 4 — Conectar o webhook no Meta

1. Na página do produto WhatsApp no Meta, vá em **Configuração do Webhook**.
2. URL de callback: `https://SEU-SERVICO.onrender.com/webhook`
3. Verify token: a mesma palavra-senha do passo 2/4.
4. Clique em verificar e salvar.
5. Em "Campos do Webhook", marque **messages** (é o que avisa quando chega
   mensagem nova).

## Passo 5 — Testar

1. No celular, manda uma mensagem de texto qualquer pro número de teste do
   WhatsApp Business — se seu telefone não estiver cadastrado em nenhum
   trabalhador, ele vai responder avisando isso.
2. Cadastre seu próprio número no campo "Contato" de um trabalhador de teste
   no sistema (com o DDI, ex: `+351912345678`).
3. Manda esse mesmo número uma mensagem de texto — o bot deve responder
   pedindo a foto.
4. Manda uma FOTO de uma folha de horas — em alguns segundos ele deve
   responder confirmando as horas lidas, e elas já aparecem na aba "Horas"
   desse trabalhador no site.

## O que esse backend NÃO faz (por enquanto)

- Não lida com mensagens de voz, vídeo ou PDF — só foto (imagem).
- Não envia mensagem automática de cobrança/lembrete pro trabalhador (dá pra
  adicionar depois, se quiser).
- Response inicial pro usuário escolher a empresa quando ele trabalha em mais
  de uma — hoje ele sempre grava com a empresa atual cadastrada no perfil do
  trabalhador. Se isso for um problema real no seu dia a dia, me avisa que eu
  ajusto pra perguntar a empresa antes de salvar.
