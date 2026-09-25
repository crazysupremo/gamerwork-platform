# Atualizações — 30 de agosto de 2026

Resumo de tudo que foi alterado hoje, nos dois projetos: **NEXT GAME** (o site) e **PROTECTION BLUEX** (a API de proteção).

---

## NEXT GAME (site) — agora na versão 0.5.0

### Correções de bugs
- **Tela travada ao sair de uma chamada de voz**: o botão "Sair da sala" e o botão de desconectar da barra inferior zeravam a tela pra um estado sem nenhum painel visível, preso em "Selecione um canal". Agora voltam pra tela de Início corretamente.
- **Coluna "NEXT GAME" vazia**: ao ir do modo Chat pra Início, uma coluna do meio ficava aberta mostrando "NEXT GAME" sem nenhum canal — um resquício visual do estado anterior. Agora fecha direito.
- **Barra de digitar empurrada pra fora da tela no celular**: o contêiner principal usava `100vh`, que no navegador mobile não desconta a barra de endereço/teclado. Trocado por `100dvh`.
- **Logo quebrada**: o arquivo `logo.png` era referenciado em três lugares (tela de carregamento, login, barra lateral) mas não existia no projeto.

### Privacidade e segurança
- **Painel de membros (coluna da direita)**: antes, pra quem é admin, mostrava todos os usuários da plataforma mesmo fora de um servidor. Agora mostra só seus amigos fora de servidor, e os membros reais dentro de um servidor.
- **Pedido de mensagem**: mandar DM pra quem não é seu amigo e não está no mesmo servidor não é mais bloqueado — vira um pedido (estilo Instagram). A pessoa vê "Aceitar/Recusar" antes de a conversa virar normal.
- **2FA obrigatório no painel admin**: uma conta de admin sem verificação em duas etapas fica bloqueada do painel até ativar.
- **Rate limit dedicado no `/api/admin/*`**: limite de requisições mais apertado só nas rotas do painel admin.
- **Alerta de login em dispositivo novo**: login de admin vindo de um IP/navegador nunca visto antes fica registrado no Audit Log.

### Recursos novos
- **Selo de verificado (✔️)**: separado do 👑 de admin. Sua conta e a da IA já vêm verificadas automaticamente; dá pra verificar qualquer outra conta pelo painel admin → aba Usuários.
- **Botão de mensagem no perfil**: agora todo perfil de usuário tem um botão "💬 Mandar mensagem" visível.
- **Painel admin reorganizado**: de uma página só com 15+ seções empilhadas pra 7 abas (Segurança/BLUEX, Visão Geral, Moderação, Usuários, Conteúdo/Loja, Suporte, Audit Log), com contadores de pendências.
- **Logo nova**: aplicada na tela de carregamento, login e barra lateral.
- **Tag "BETA"**: adicionada ao lado da logo, já que o site ainda está em fase de testes.
- **Tela de login remodelada**: nova arte de fundo (personagem + cidade), cards de recursos, estatísticas reais da plataforma, selo "Protection BlueX Ativo", campo de senha com mostrar/esconder, e "Esqueceu a senha?" (abre o suporte).
- **Sino de novidades**: ícone novo na barra superior que mostra o changelog da atualização mais recente a qualquer momento, com bolinha indicando novidade não vista.
- **Popup de atualização com rolagem própria**: lista de mudanças não estoura mais a tela quando é grande.

### Removido
- **Balão de chat flutuante**: tirado do canto inferior direito — já existe o "Chat" fixo no menu lateral.

---

## PROTECTION BLUEX (API de moderação)

### Modo "bem rigoroso"
- **Checagem dupla de modelo**: quando configurado (`GROQ_VISION_MODEL_2` / `GROQ_TEXT_MODEL_2`), toda imagem/texto passa por dois modelos de IA — se qualquer um sinalizar, o resultado final é "sinalizado" (prioriza não deixar passar despercebido).
- **Confidence em vez de descarte silencioso**: indícios ambíguos agora ficam marcados com confiança "baixa" pra revisão humana, em vez de simplesmente descartados.
- **Categorias novas**: drogas ilícitas, armas em contexto de ameaça, discurso/símbolos de ódio, automutilação/incentivo a suicídio, doxxing e golpe/fraude — além do que já existia (nudez, violência grave, maus-tratos a animais, risco a menor).

### Novos tipos de conteúdo
- **`/v1/moderate-audio`**: transcreve o áudio e analisa o texto falado.
- **`/v1/moderate-video`**: analisa frames que o cliente extrai do vídeo (até 12 por chamada).

### Outras mudanças
- Rate limit mais apertado nos endpoints de áudio/vídeo (custam mais).
- Painel admin do BLUEX atualizado: mostra se a checagem dupla está ativa e a coluna de confiança na fila de revisão.
- README e variáveis de ambiente documentadas.

---

## Observações importantes

- **2FA obrigatório**: se sua própria conta de admin do NEXT GAME ainda não tem 2FA ativado, o painel `/admin.html` vai ficar bloqueado até você ativar em Configurações → Segurança.
- **Checagem dupla do BLUEX**: só funciona de verdade se você configurar `GROQ_VISION_MODEL_2`/`GROQ_TEXT_MODEL_2` no Render com nomes de modelo reais da sua conta Groq.
- **Facebook login e recuperação de senha automática**: não foram implementados (não existiam antes) — o link "Esqueceu a senha?" abre o formulário de suporte por enquanto.
