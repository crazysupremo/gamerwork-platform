# Como colocar o GamerWork no ar (grátis, no Render.com)

Estas contas você precisa criar você mesmo (GitHub e Render pedem seu próprio
e-mail/senha — não posso fazer isso por você). O resto é só clicar seguindo o
passo a passo.

## Passo 1 — Criar conta no GitHub (grátis, sem cartão)

1. Acesse **github.com/signup**
2. Crie a conta com seu e-mail
3. Depois de logado, clique no **+** no canto superior direito → **New repository**
4. Dê um nome, por exemplo `gamerwork-platform`
5. Deixe como **Public** (necessário para o plano grátis do Render ler o repositório)
6. Clique em **Create repository**

## Passo 2 — Subir o código para o GitHub (sem usar terminal)

1. Extraia o arquivo `gamerwork-platform.zip` que te enviei no seu computador
2. Na página do repositório recém-criado no GitHub, clique em
   **"uploading an existing file"** (ou "Add file" → "Upload files")
3. Arraste **todos os arquivos e pastas de dentro** de `gamerwork-platform`
   (não a pasta em si, o conteúdo dela: `server.js`, `db.js`, `moderation.js`,
   `package.json`, `render.yaml`, `.gitignore`, a pasta `public/`, etc.)
4. Role para baixo e clique em **Commit changes**

## Passo 3 — Criar conta no Render.com (grátis)

1. Acesse **render.com** e clique em **Get Started**
2. Escolha **"Sign up with GitHub"** — isso já conecta as duas contas
3. Autorize o Render a acessar seus repositórios

## Passo 4 — Publicar o site

1. No painel do Render, clique em **New +** → **Blueprint**
2. Selecione o repositório `gamerwork-platform`
3. O Render vai detectar o arquivo `render.yaml` sozinho e mostrar a
   configuração (nome do serviço, plano Free, etc.) — clique em **Apply**
4. Aguarde alguns minutos enquanto ele instala as dependências e sobe o site
5. Quando terminar, o Render mostra uma URL tipo
   `https://gamerwork-platform.onrender.com` — esse é o link do seu site no ar

## Passo 5 — Banco de dados persistente (Turso, grátis pra sempre)

Sem isso, as contas/mensagens são apagadas toda vez que o Render reinicia o
serviço. O app já vem pronto pra usar o **Turso** (turso.tech) — compatível
com o banco que o site usa, gratuito sem prazo de validade e sem cartão.

1. Acesse **turso.tech** e crie uma conta grátis (dá pra entrar com GitHub)
2. No painel, clique em **Create Database**, dê um nome (ex: `next-game`) e
   escolha a região mais próxima de você
3. Depois de criado, clique no banco → copie a **Database URL**
   (algo como `libsql://next-game-seunome.turso.io`)
4. Ainda no painel do banco, clique em **Create Token** (ou "Generate Token")
   e copie o **Auth Token** gerado
5. No Render, abra seu serviço → aba **Environment** → **Add Environment Variable**,
   e adicione as duas:
   - Key: `TURSO_DATABASE_URL` → Value: a URL que você copiou
   - Key: `TURSO_AUTH_TOKEN` → Value: o token que você copiou
6. Clique em **Save Changes** — o Render redeploya sozinho

Pronto: a partir daí, contas e mensagens continuam salvas mesmo quando o
Render reinicia o serviço. Sem essas duas variáveis, o site continua
funcionando normalmente, só volta a usar um arquivo local que se perde a
cada redeploy (bom só pra testar).

## Passo 6 — Assistente de IA (opcional, gratuito)

O NEXT GAME tem um contato fixo chamado **"NEXT GAME IA"** que qualquer
usuário pode chamar direto (sem precisar virar amigo) pra conversar com uma
IA de verdade. Sem configurar nada, ele responde educadamente explicando que
ainda não foi ligado — o resto do site funciona normalmente sem isso.

Usa a **Groq** (groq.com) — sem cartão de crédito, chave na hora. O plano
grátis tem limite de mensagens por minuto/dia (não é ilimitado de verdade,
mas dá pra uso normal); se bater o limite, o bot avisa educadamente pra
tentar de novo daqui a pouco.

Pra ativar:

1. Crie uma conta em **console.groq.com** (só precisa de e-mail, sem cartão)
2. No painel, vá em **API Keys** → **Create API Key**, dê um nome e copie a
   chave gerada (ela só aparece uma vez)
3. No Render, abra seu serviço → aba **Environment** → **Add Environment Variable**:
   - Key: `GROQ_API_KEY` → Value: a chave que você copiou
4. (Opcional) Pra trocar o modelo usado, adicione também `GROQ_MODEL` com o
   nome do modelo desejado (o padrão é `openai/gpt-oss-20b`) — a Groq às vezes
   descontinua modelos antigos; se o assistente voltar a dar erro depois de
   configurado, veja a lista atual em **console.groq.com/docs/models** e
   atualize essa variável com um modelo ativo.
5. Salve — o Render redeploya sozinho e o assistente passa a responder de verdade.

## Passo 6.5 — Integração com o PROTECTION BLUEX (opcional)

O NEXT GAME pode usar o **PROTECTION BLUEX** (o produto da BLUE SPORTS GAMES,
publicado separado) pra fazer a moderação de imagem (anexos de chat, tela e
câmera compartilhadas) e, como camada nova, análise de texto pra sinalizar
comportamento suspeito/aliciamento nas mensagens do chat. Isso é totalmente
opcional: sem configurar, o NEXT GAME continua usando a Groq direto como
sempre (nada quebra).

**Importante:** a verificação de idade por câmera do cadastro NÃO passa por
essa integração — continua 100% no navegador da pessoa, a foto nunca sai do
dispositivo dela, por decisão de privacidade já tomada.

Pra ativar:

1. Publique o PROTECTION BLUEX primeiro (é outro serviço, outro repositório —
   veja o README dele) e anote a URL pública (ex:
   `https://protection-bluex-api.onrender.com`).
2. No painel admin do PROTECTION BLUEX, crie um cliente chamado "NEXT GAME"
   e copie a chave de API gerada (começa com `bluex_`).
3. No Render do NEXT GAME, abra seu serviço → aba **Environment** → adicione:
   - Key: `BLUEX_API_URL` → Value: a URL do PROTECTION BLUEX (sem barra no final)
   - Key: `BLUEX_API_KEY` → Value: a chave `bluex_...` que você copiou
4. Salve — o Render redeploya sozinho. A partir daí, moderação de imagem e
   análise de texto passam pelo BLUEX; se o BLUEX cair, o NEXT GAME volta
   sozinho pra Groq direto como respaldo, sem parar de funcionar.

## Depois de publicar

- Acesse a URL, registre-se — **o primeiro usuário que se cria vira admin**
  automaticamente, então esse deve ser você.
- O painel de moderação fica em `SUA-URL/admin.html`.

## Sobre chamadas de voz/vídeo e compartilhamento de tela em produção

O app já vem com um servidor TURN de fallback configurado automaticamente
(relay público gratuito do Open Relay Project) — isso resolve a maioria dos
casos de "call não conecta" entre pessoas em redes mais fechadas (dado
móvel, wifi de empresa/escola). Só que esse relay é compartilhado com
qualquer pessoa no mundo que usa as mesmas credenciais de teste, então pode
ficar lento se muita gente usar ao mesmo tempo.

Pra ter um TURN só seu (recomendado antes de divulgar o site pra muita
gente), o Open Relay Project mesmo (metered.ca) dá 20GB grátis por mês sem
cartão:

1. Crie uma conta grátis em **metered.ca** (ou outro provedor de TURN de sua preferência)
2. Copie a URL do servidor TURN e as credenciais (usuário/senha) geradas
3. No Render, adicione as variáveis de ambiente:
   - Key: `TURN_URL` → Value: a URL (pode colar várias separadas por vírgula, ex: `turn:seu-relay.com:80,turn:seu-relay.com:80?transport=tcp`)
   - Key: `TURN_USERNAME` → Value: o usuário
   - Key: `TURN_CREDENTIAL` → Value: a senha/credencial
4. Salve — assim que essas variáveis existirem, o site para de usar o relay
   público compartilhado e passa a usar o seu automaticamente (sem precisar
   mexer em nenhum código).

Também vale a pena acompanhar o painel **Monitoramento** em `SUA-URL/admin.html`
— ele avisa na tela se o TURN ainda está no modo compartilhado, se a memória
do processo está passando do limite do plano gratuito do Render, etc.

## NEXTGAME PLUS — assinatura via PayPal

Sem essas variáveis, o site funciona 100% no plano FREE — o botão de assinar
só mostra "ainda não está disponível".

1. Crie/entre numa conta em **developer.paypal.com** (pode ser a mesma conta
   PayPal normal — é só ativar o modo desenvolvedor).
2. Em **Apps & Credentials**, crie um app (ou use o "Default Application") e
   copie o **Client ID** e o **Secret**. Comece no ambiente **Sandbox** pra
   testar sem cobrar ninguém de verdade; troque pra **Live** só quando tiver
   certeza que está tudo funcionando.
3. Em **Billing Plans** (dentro do mesmo app, ou via PayPal Business), crie
   um **Product** (ex: "NEXTGAME PLUS") e um **Plan** de assinatura mensal
   recorrente com o preço que você quiser cobrar. Copie o **Plan ID**
   (formato `P-XXXXXXXXXXXXXXX`).
4. Em **Webhooks**, cadastre a URL `https://SUA-URL/api/paypal/webhook` e
   marque pelo menos os eventos `BILLING.SUBSCRIPTION.ACTIVATED`,
   `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.EXPIRED` e
   `BILLING.SUBSCRIPTION.SUSPENDED`. Copie o **Webhook ID** gerado.
5. No Render, adicione as variáveis de ambiente:
   - `PAYPAL_CLIENT_ID`
   - `PAYPAL_CLIENT_SECRET`
   - `PAYPAL_PLAN_ID`
   - `PAYPAL_WEBHOOK_ID`
   - `PAYPAL_MODE` → `sandbox` (testes) ou `live` (cobrança real)
6. Salve — o botão "Assinar" (menu do rodapé → NEXTGAME PLUS) passa a
   funcionar automaticamente.

Pra dar/tirar o Plus manualmente (cortesia, suporte, teste), qualquer admin
pode chamar `POST /api/admin/users/:id/plan` com `{"plan": "plus"}` ou
`{"plan": "free"}` no corpo.

## NEXTGAME PLUS — arquivos grandes via Cloudflare R2

Sem essas variáveis, os anexos de mensagem ficam com um limite pequeno
(5MB no FREE, 25MB no Plus) guardados direto no banco de dados. Com R2
configurado, o limite sobe pro valor de verdade do plano (500MB no FREE,
5GB no Plus) e os arquivos vão direto pro storage, sem passar pelo servidor.

1. Crie uma conta grátis em **dash.cloudflare.com** (não precisa cartão pro
   plano grátis de R2 — 10GB de armazenamento/mês, sem taxa de saída).
2. No menu **R2 Object Storage**, crie um bucket (ex: `nextgame-files`).
3. Nas configurações do bucket, ative o **acesso público** (R2.dev domain,
   ou conecte um domínio/subdomínio seu) e copie essa URL pública.
4. Em **Manage API Tokens**, crie um token de API com permissão de leitura e
   escrita nesse bucket. Copie o **Access Key ID** e o **Secret Access Key**
   (o secret só aparece uma vez).
5. O **Account ID** aparece no canto direito do dashboard da Cloudflare.
6. No Render, adicione as variáveis de ambiente:
   - `R2_ACCOUNT_ID`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_BUCKET_NAME`
   - `R2_PUBLIC_URL` (a URL pública do passo 3, sem barra no final)
7. Salve — os limites de arquivo do plano passam a valer de verdade
   automaticamente, sem precisar mexer em nenhum código.
