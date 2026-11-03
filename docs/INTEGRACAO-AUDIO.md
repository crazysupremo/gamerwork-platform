# API de Áudio do NEXT GAME — integração externa

Esse documento explica como integrar a chamada de voz do NEXT GAME (a mesma
que roda dentro do app, em "Salas de voz") dentro de **outro jogo**, pra ter
voz de verdade (geral, lobby, ou sala de uma partida específica) sem precisar
reconstruir WebRTC/sinalização do zero.

## Como funciona, em resumo

O NEXT GAME expõe um **widget embutível** (`voice-widget.html`) que roda
dentro de um `<iframe>` do seu jogo. Ele cuida de tudo sozinho: pedir
permissão de microfone, conectar na call, mostrar quem está falando, mutar.
Seu jogo só precisa:

1. Garantir que o jogador tem conta no NEXT GAME e está logado (o widget
   mostra um botão de login sozinho se não estiver).
2. Dizer **qual sala** ele deve entrar (geral / lobby do seu jogo / partida
   específica).
3. Escutar alguns eventos (`conectou`, `alguém entrou`, `alguém saiu`) se
   quiser reagir a isso na sua própria interface.

Pra site/jogo em navegador (incluindo Unity WebGL), use o **SDK JavaScript**.
Pra Unity especificamente, tem também um **wrapper C#** por cima do SDK JS,
pra não precisar escrever JavaScript na mão.

> **Importante:** chamada de voz de verdade (microfone, WebRTC) só existe
> dentro de um navegador. Isso cobre jogos web e builds **Unity WebGL**. Pra
> jogo nativo (desktop/mobile, build standalone) a call em si não roda sem um
> navegador por trás — veja a seção [Jogo nativo (sem navegador)](#jogo-nativo-sem-navegador)
> no fim desse documento pras opções nesse caso.

## Autenticação

O jogador precisa ter conta no NEXT GAME. O widget verifica isso sozinho
(usando a sessão/cookie do NEXT GAME no navegador) — se não estiver logado,
mostra um botão "Entrar com NEXT GAME" que abre o site numa aba nova; ao
voltar o foco pra aba/iframe do widget, ele confere de novo automaticamente,
sem precisar recarregar nada.

Seu jogo **nunca** vê a senha nem o cookie de sessão do NEXT GAME — só o
resultado (nome de usuário, avatar) depois que a pessoa já fez login de
verdade, através do evento `connected`/`peer-joined`.

## Convenção de salas

| Modo (`mode`) | Parâmetros | Sala resultante | Uso |
|---|---|---|---|
| `geral` | — | `ext-geral` | Uma sala só, compartilhada por todo mundo que usa sua integração (tipo um "chat de voz geral" do seu jogo). |
| `lobby` | `game` | `ext-lobby-<game>` | Lobby do seu jogo — todo mundo que entra nesse modo com o mesmo `game` cai junto. |
| `match` | `game`, `match` | `ext-match-<game>-<match>` | Sala de uma partida/sessão específica — gere um `match` único por partida no seu próprio backend e passe o mesmo valor pra todo jogador dela. |

`game` é um identificador curto do seu jogo (ex: `"jogodoamigo"`) — existe
pra separar lobbies/partidas de jogos diferentes que eventualmente usem essa
mesma integração, sem colidir.

Também dá pra usar uma sala com **id totalmente livre** (`room`) se nenhum
desses três modos servir — nesse caso o id é só uma string qualquer que você
escolhe, igual pros outros modos.

Até 8 pessoas por sala (mesmo limite técnico da chamada de voz do app
principal — acima disso a call em malha P2P começa a engasgar).

## SDK JavaScript (site, jogo web, Unity WebGL)

```html
<script src="https://nextgameblue.stream/sdk/nextgame-voice.js"></script>
<script>
  const voice = NextGameVoice.init({
    container: document.getElementById('voice-slot'), // onde encaixar o widget (padrão: document.body)
    mode: 'match',
    game: 'jogodoamigo',
    match: 'partida-123',        // gerado pelo seu backend, igual pra todo mundo da partida
    theme: 'dark',                // ou 'light'
    muted: false,                 // entra com microfone ligado
    width: 220, height: 280,      // tamanho do widget em px
  });

  voice.on('connected', (msg) => console.log('Entrou na sala', msg.room, 'com', msg.peers.length, 'pessoas já lá'));
  voice.on('peer-joined', (msg) => console.log(msg.peer.username, 'entrou na call'));
  voice.on('peer-left', (msg) => console.log(msg.peer.username, 'saiu da call'));
  voice.on('need-login', () => console.log('jogador ainda não logou no NEXT GAME'));
  voice.on('error', (msg) => console.error('erro na call:', msg.message));

  // Controles:
  voice.setMuted(true);   // muta o microfone
  voice.leave();          // sai da call (widget continua na tela)
  voice.destroy();        // remove o widget da página de vez
</script>
```

Pros modos `geral` e `lobby` é só trocar `mode`/`game` e tirar `match`:

```js
NextGameVoice.init({ mode: 'geral' });
NextGameVoice.init({ mode: 'lobby', game: 'jogodoamigo' });
```

### Eventos

| Evento | Quando dispara | Dados |
|---|---|---|
| `ready` | Widget carregou | — |
| `need-login` | Jogador não está logado no NEXT GAME | — |
| `connected` | Entrou na sala com sucesso | `{ room, peers: [{socketId, userId, username, avatar}] }` |
| `peer-joined` | Alguém mais entrou na mesma sala | `{ peer: { userId, username } }` |
| `peer-left` | Alguém saiu | `{ peer: { username } }` |
| `muted-changed` | Mic mutado/desmutado (seu ou via `setMuted`) | `{ muted: true/false }` |
| `left` | Você saiu da call (`leave()`) | — |
| `error` | Algo deu errado (sala cheia, sem permissão de mic, etc) | `{ message }` |

## Unity (C#, via WebGL)

1. Copie `sdk/unity/NextGameVoice.jslib` pra `Assets/Plugins/WebGL/` do seu
   projeto Unity (a pasta/extensão é o que faz o Unity reconhecer como
   plugin de WebGL automaticamente).
2. Copie `sdk/unity/NextGameVoice.cs` pra qualquer pasta de scripts.
3. Adicione o componente `NextGameVoice` em qualquer GameObject da cena (só
   uma vez — ele usa `DontDestroyOnLoad`).

```csharp
// Entrar na call de uma partida
NextGameVoice.Instance.JoinMatch("jogodoamigo", partidaId);

// Escutar eventos
NextGameVoice.Instance.OnConnected += (room) => Debug.Log("Conectado em " + room);
NextGameVoice.Instance.OnPeerJoined += (peer) => Debug.Log(peer.username + " entrou");
NextGameVoice.Instance.OnPeerLeft += (peer) => Debug.Log(peer.username + " saiu");
NextGameVoice.Instance.OnNeedLogin += () => Debug.Log("Jogador precisa logar no NEXT GAME");
NextGameVoice.Instance.OnError += (msg) => Debug.LogError(msg);

// Controles
NextGameVoice.Instance.SetMuted(true);
NextGameVoice.Instance.Leave();
```

Métodos disponíveis: `JoinGeral()`, `JoinLobby(gameKey)`, `JoinMatch(gameKey, matchId)`,
e `JoinCustomRoom(roomId, label)` pra um id de sala livre.

**Isso só funciona em build WebGL** — em Editor ou outra plataforma o
componente só imprime um aviso no console e não faz nada (não tem navegador
nem WebRTC disponível nesses casos).

## Limitação conhecida: cookies de terceiro (Safari principalmente)

O widget roda num `<iframe>` de outra origem (o domínio do seu jogo, não o
do NEXT GAME) — por padrão isso é chamado de "contexto de terceiro". Alguns
navegadores (Safari com ITP ligado é o mais rígido; Chrome vem seguindo o
mesmo caminho) restringem cookies nesse contexto por privacidade, o que pode
fazer o widget achar que o jogador não está logado mesmo depois de ele
logar na aba que abriu. Isso **não é um bug que dá pra resolver só no nosso
lado** — é como o navegador trata iframe de terceiro de propósito.

Na prática, pedir pro jogador logar numa aba nova (como o botão do widget já
faz) resolve a maioria dos casos, porque isso conta como visita "de verdade"
ao NEXT GAME pra esses navegadores. Se mesmo assim continuar pedindo login
toda hora no Safari especificamente, a solução "oficial" do navegador é o
widget pedir acesso explícito ao armazenamento via
[Storage Access API](https://developer.mozilla.org/en-US/docs/Web/API/Storage_Access_API)
(`document.requestStorageAccess()`) — ainda não implementado nessa primeira
versão; avisa a gente se isso virar um problema de verdade na prática que a
gente prioriza.

## Jogo nativo (sem navegador)

Se o jogo do seu amigo for um build nativo de verdade (standalone
Windows/Mac/Linux, ou mobile nativo, sem WebGL), o widget/iframe não serve —
ele depende de rodar dentro de um navegador. Duas opções, da mais simples
pra mais trabalhosa:

1. **WebView embutido**: várias engines (Unity incluído, via plugins como
   `vuplex/webview`) permitem abrir uma WebView dentro do jogo nativo — nesse
   caso o widget funciona exatamente igual ao WebGL, só que dentro dessa
   WebView em vez de um `<iframe>` de navegador.
2. **Sinalização direta** (mais avançado): o protocolo de sinalização que o
   widget usa por baixo dos panos (Socket.IO, eventos `rtc:join`/`rtc:signal`)
   não é segredo — dá pra implementar um cliente WebRTC nativo em C# (ex: lib
   `Unity.WebRTC` ou `Microsoft.MixedReality.WebRTC`) que fala esse mesmo
   protocolo direto com o servidor do NEXT GAME, sem passar pelo widget. Isso
   exige handshake próprio e não tem suporte pronto nesse pacote — fala com a
   gente (pelo "Fale com o suporte" no site) se for esse o caminho, que a
   gente documenta os eventos com mais detalhe.

## Endpoints relevantes

| Rota | O que faz |
|---|---|
| `GET /api/integration/voice/me` | Retorna `{ userId, username, avatar, avatar_frame }` do jogador logado (401 se não estiver logado) — é o que o widget usa pra saber quem é quem. |
| `GET /api/ice-servers` | Lista de servidores STUN/TURN usados pra conectar a call mesmo em redes com NAT restritivo (dado móvel, Wi-Fi de empresa/escola). |
| `/voice-widget.html` | O widget em si — normalmente você não chama direto, usa o SDK JS ou o wrapper Unity, que já montam a URL certa. |

## Dúvidas

Qualquer problema na integração, usa o "Fale com o suporte" dentro do NEXT
GAME (categoria "Dúvida" ou "Outro") — cai direto no painel da equipe.
