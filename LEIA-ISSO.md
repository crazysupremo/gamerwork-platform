# O que mudou nesse `server.js` (Protection BLUEX)

## O bug real que deixou a imagem de teste passar

O `MODERATE_IMAGE_PROMPT` só marcava arma como suspeita se fosse **"arma de
fogo real anunciada pra venda"** — qualquer outra situação com arma real
(ameaça, ostentação, ferimento) passava direto. Corrigido pra cobrir arma
real em contexto de ameaça também, não só venda.

## A "checagem dupla" que o README prometia, mas nunca existiu de verdade

O README já falava de `GROQ_VISION_MODEL_2` / `GROQ_TEXT_MODEL_2` ligando
dois modelos em paralelo (se qualquer um sinalizar, já conta como
sinalizado), e o banco (`db.js`) já tinha até a coluna `confidence` pronta
pra isso. Mas o `server.js` de antes nunca lia essas variáveis — sempre
rodava com 1 modelo só, mesmo que você configurasse as duas. Agora está
implementado de verdade: `callGroqVision`/`callGroqText` rodam os dois
modelos em paralelo quando a variável `_2` existir, e combinam o resultado.

## Categorias ampliadas (o README já prometia isso também)

- Imagem: agora também sinaliza drogas ilícitas, ódio (símbolos/discurso
  visual), automutilação/incentivo a suicídio — além de nudez, violência
  real, maus-tratos a animais, arma real em ameaça, risco a menor.
- Texto: agora também sinaliza doxxing e golpe/fraude, além de aliciamento,
  adulto se passando por menor, ódio, drogas/armas.
- Os dois agora pedem um campo `"confidence"` — indício ambíguo (não 100%
  claro) já marca `flagged=true` com confidence baixa, em vez de descartar.
  Isso joga mais coisa pra fila de revisão humana (mais falso positivo,
  menos coisa escapando) — igual o README já dizia que devia funcionar.

## Endpoints que faltavam

`/v1/moderate-audio` e `/v1/moderate-video` estavam documentados no README
mas não existiam no código. Adicionei os dois.

## O que você precisa fazer

1. Sobe esse `server.js` no lugar do atual no repositório
   `crazysupremo/protection-bluex` (substitui o arquivo).
2. Se quiser a checagem dupla ATIVA de verdade (recomendado, já que é o
   "modo bem rigoroso"), adiciona no Render (Environment) duas variáveis
   novas: `GROQ_VISION_MODEL_2` e `GROQ_TEXT_MODEL_2` — um modelo Groq
   diferente do principal em cada uma (ex: `llama-4-scout` ou outro modelo
   de visão disponível na sua conta Groq, pra vision; qualquer modelo de
   texto Groq diferente do `llama-3.3-70b-versatile` pra texto). Sem essas
   duas, continua funcionando com 1 modelo só — só que já com o prompt
   corrigido, que sozinho já deve resolver a maior parte do problema.
3. Depois de subir e o Render fazer o redeploy, testa de novo a mesma
   imagem que passou antes.

## Segunda rodada de melhorias (segurança, robustez e painel admin)

### Senha do admin comparada em tempo constante
A senha do admin era comparada com `password !== ADMIN_PASSWORD` — uma
comparação de string comum em JS para no primeiro byte diferente, o que em
teoria vaza (por tempo de resposta) quantos caracteres do início a
tentativa acertou. Trocado por `crypto.timingSafeEqual` (função
`passwordMatches`). O import do `bcryptjs` foi removido — estava no
`package.json` e no `server.js` mas nunca era usado em lugar nenhum.

### Proteção contra SSRF em `audio_url`
`/v1/moderate-audio` baixa o áudio de `audio_url` DIRETO no seu servidor
(diferente de `image_url`, que é só repassada pra Groq buscar). Isso
significa que uma empresa cliente mal-intencionada — ou com a chave de API
vazada — podia mandar uma `audio_url` apontando pra rede interna (ex.
`http://169.254.169.254/...`, o endereço clássico de metadata de nuvem, ou
`http://localhost:...`) e usar seu servidor como proxy pra sondar essa
rede. Agora `isSafeExternalUrl` resolve o hostname e bloqueia IP privado/
loopback/link-local antes de baixar qualquer coisa.

### Validação do formato de imagem
`/v1/age-verify`, `/v1/moderate-image` e `/v1/moderate-video` aceitavam
qualquer string em `image`/`image_url`/`frames`, inclusive coisas como
`javascript:alert(1)`. Agora só aceita data URL de imagem
(`data:image/...;base64,...`) ou URL `http(s)://` — erro 400 claro antes de
gastar uma chamada da Groq com lixo.

### Paginação e filtro por empresa no painel admin
`/admin/usage` e `/admin/flagged` sempre devolviam só os últimos 200
registros, sem jeito de navegar pro resto nem filtrar por empresa. Agora
aceitam `?limit=&offset=&client_id=` (limit capado em 200) e devolvem
`{ rows, total, limit, offset }`. O painel (`admin.js`/`index.html`) ganhou
um filtro por empresa e botões de "Anterior"/"Próxima" nas abas de Uso e
Casos sinalizados.
