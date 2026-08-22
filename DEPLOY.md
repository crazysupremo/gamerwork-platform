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

## Depois de publicar

- Acesse a URL, registre-se — **o primeiro usuário que se cria vira admin**
  automaticamente, então esse deve ser você.
- O painel de moderação fica em `SUA-URL/admin.html`.

## Sobre o compartilhamento de tela em produção

O WebRTC deste protótipo usa apenas um servidor STUN público (Google), sem
servidor TURN. Isso funciona bem na maioria das redes domésticas, mas pode
falhar para usuários atrás de firewalls corporativos ou redes muito
restritivas. Se isso virar um problema real, dá para adicionar um TURN
(ex.: serviço gratuito do Metered.ca ou Twilio) depois.
