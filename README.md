# NEXT GAME — protótipo de plataforma para gamers e trabalho

Protótipo funcional de uma plataforma web (estilo Discord) com chat em tempo real,
salas de voz com compartilhamento de tela (WebRTC) e um sistema básico de
moderação de conteúdo. Testado e funcionando neste ambiente.

## Como rodar

Requisitos: Node.js 22.5 ou superior (usa o módulo nativo `node:sqlite`, sem
dependências de compilação).

```bash
cd gamerwork-platform
npm install
npm start
```

Acesse `http://localhost:3000`. O **primeiro usuário que se registrar vira
administrador automaticamente** e ganha acesso a `/admin.html`.

Se a pasta do projeto estiver dentro de uma unidade sincronizada na nuvem
(OneDrive, Dropbox, iCloud Drive), o SQLite pode falhar com "erro de I/O".
Nesse caso rode com o banco em disco local:

```bash
DB_PATH=/caminho/local/data.sqlite npm start
```

## O que já funciona

- Cadastro/login com senha (hash bcrypt) e sessão em cookie.
- **Qualquer usuário pode criar salas novas** clicando no `+` do menu lateral —
  ao digitar o nome de um "servidor"/categoria que ainda não existe (ex.:
  "Valorant", "Minecraft", "Time de Design"), ele é criado na hora. É assim que
  a comunidade se organiza por jogo/assunto, igual servidores do Discord.
- Canais de texto e voz, agrupados dinamicamente por categoria/servidor.
- Chat em tempo real (Socket.io), com histórico salvo em SQLite.
- **Voz de verdade nas salas**: ao clicar numa sala de voz, o microfone conecta
  automaticamente (igual chamada de voz do Discord).
- **Fica conectado enquanto você navega**: sair da tela da sala de voz pra ler
  uma mensagem em outro canal não te desconecta — só desconecta quando você
  clica no botão vermelho de desligar. Uma **barra fixa no rodapé do menu**
  mostra a sala conectada com botões de mutar, ensurdecer e desconectar,
  visível o tempo todo.
- **Quem está em cada sala de voz** aparece embaixo do nome dela no menu
  lateral (com avatar/inicial), pra qualquer pessoa ver antes mesmo de entrar.
- **Compartilhamento de tela** via WebRTC (mesh entre participantes, usando
  STUN público do Google — sem servidor TURN, então pode falhar em redes
  restritas/corporativas).
- **Configurações de voz** (ícone ⚙️ na sala): escolher qual microfone usar
  (entrada) e qual caixa de som/fone usar (saída — depende do navegador
  suportar `setSinkId`, funciona no Chrome/Edge, não no Safari/Firefox), com
  teste de microfone (medidor de nível ao vivo) e teste de saída (toca um bipe
  na caixa escolhida). Preferências ficam salvas no navegador.
- Filtro automático de texto (`moderation.js`): **todas** as categorias de risco
  (venda de armas, instruções de explosivos, ameaças graves de violência,
  exploração infantil, conteúdo sexual explícito) são **bloqueadas antes de
  serem salvas ou enviadas** a outros usuários — nenhuma categoria fica só
  "sinalizada" sem ação.
- Toda mensagem bloqueada é registrada em um log de auditoria
  (`blocked_messages`), visível apenas para admins em `/admin.html`, com botão
  para banir o autor direto dali. Nada é descartado em silêncio.
- Botão "Denunciar" em cada mensagem, que cria uma denúncia manual.
- Painel de administração (`/admin.html`): revisar denúncias, ver mensagens
  bloqueadas pelo filtro, banir/desbanir usuários.
- **Segurança reforçada**: cabeçalhos de proteção (helmet — contra XSS,
  clickjacking, sniffing de tipo de arquivo), limite de tentativas de
  login/registro por IP (proteção contra força bruta), limite geral de
  requisições por IP nas rotas de API, limite de mensagens por usuário no chat
  (anti-flood), cookies de sessão `httpOnly` + `secure` em produção, e
  validação de tamanho/formato em todos os campos de entrada.

## Limitações importantes — leia antes de lançar isso ao público

Você pediu proteção contra pornografia, conteúdo infantil (CSAM) e violência.
É importante entender o que este protótipo cobre e o que **não** cobre:

**O que o filtro de texto faz:** compara mensagens contra uma lista de
palavras/expressões de risco e bloqueia ou sinaliza. É útil contra spam óbvio
e menções diretas, mas é trivialmente contornável (erros de digitação
propositais, code words, imagens, áudio) e não analisa imagens, vídeo ou o
compartilhamento de tela.

**O que este protótipo NÃO faz — e por quê:**

- **Detecção real de CSAM** exige comparação de hash contra bancos mantidos
  por organizações como o NCMEC (EUA) via serviços como Microsoft PhotoDNA ou
  Thorn Safer. Esses serviços exigem que a empresa se registre formalmente
  como provedor e assine termos de uso — não é algo que se integre livremente
  por conta própria. Sem isso, a única defesa real é moderação humana e
  denúncias de usuários.
- **Moderação de imagem/vídeo em tempo real** (nudez, violência gráfica) exigiria
  integrar uma API de moderação visual (ex.: AWS Rekognition, OpenAI
  Moderation, Google Vision SafeSearch) nos uploads e, para o compartilhamento
  de tela, isso é tecnicamente muito mais difícil (teria que analisar frames
  de vídeo continuamente, com custo e latência relevantes).
- **Obrigações legais no Brasil**: se a plataforma for ao ar para o público,
  ela se torna provedora de aplicação de internet sujeita ao Marco Civil da
  Internet, ao ECA (Estatuto da Criança e do Adolescente — inclusive dever de
  notificar autoridades sobre indícios de exploração infantil) e à LGPD
  (dados pessoais dos usuários). Vale conversar com um advogado antes de
  lançar publicamente.
- **Infraestrutura de produção**: hospedagem, banco de dados robusto, servidor
  TURN para WebRTC funcionar atrás de NAT/firewalls, backups, HTTPS/domínio,
  e capacidade de escala não estão configurados aqui — isso é um protótipo
  local.
- **"Segurança total" não existe** — nenhum site é 100% invulnerável. O que foi
  feito aqui fecha as brechas mais comuns (força bruta, XSS, flood, cookies
  mal configurados), mas não substitui um pentest profissional se a plataforma
  crescer com dados sensíveis de muitos usuários.

## Próximos passos sugeridos

Em prosa: comece testando o protótipo localmente com amigos para validar a
ideia; defina regras de comunidade claras e um time de moderadores humanos
(o filtro automático reduz volume, não substitui pessoas); se decidir lançar
publicamente, avalie contratar um serviço de moderação de imagem/vídeo antes
de abrir uploads ou compartilhamento de tela sem restrição, e não deixe de
verificar as obrigações legais mencionadas acima.
