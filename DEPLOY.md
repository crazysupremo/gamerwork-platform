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

## Depois de publicar

- Acesse a URL, registre-se — **o primeiro usuário que se cria vira admin**
  automaticamente, então esse deve ser você.
- O painel de moderação fica em `SUA-URL/admin.html`.

## ⚠️ Limitação importante do plano gratuito

O plano free do Render usa **disco efêmero**: toda vez que o serviço reinicia
(o que acontece sozinho após períodos de inatividade, ou a cada novo deploy),
o banco de dados SQLite (`data.sqlite`) é **apagado** e todos os usuários,
mensagens e denúncias somem. Isso é aceitável para testar a ideia com amigos,
mas **não serve para lançar de verdade com usuários reais**.

Quando quiser resolver isso, as opções são:
1. Assinar um plano pago do Render com **disco persistente** (a partir de
   uns poucos dólares por mês), ou
2. Migrar o banco de dados para um serviço de banco gerenciado (ex.: Render
   Postgres, que tem um plano free próprio) — isso exigiria adaptar o código
   de `db.js`, posso fazer isso quando você quiser seguir esse caminho.

## Sobre o compartilhamento de tela em produção

O WebRTC deste protótipo usa apenas um servidor STUN público (Google), sem
servidor TURN. Isso funciona bem na maioria das redes domésticas, mas pode
falhar para usuários atrás de firewalls corporativos ou redes muito
restritivas. Se isso virar um problema real, dá para adicionar um TURN
(ex.: serviço gratuito do Metered.ca ou Twilio) depois.
