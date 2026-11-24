# O que tem nesse pacote

Tudo junto num zip só, pra você subir tudo de uma vez no GitHub. Mas atenção:
são **dois sites diferentes no Render**, porque um é estático e o outro
precisa ficar sempre ligado.

```
index.html, manifest.json, icon-*.png, apple-touch-icon.png   → SITE PRINCIPAL
whatsapp-backend/                                               → BOT DO WHATSAPP
```

## Passo 1 — Suba tudo pro GitHub de uma vez

Arrasta o conteúdo desse zip (os 5 arquivos do site + a pasta
`whatsapp-backend` inteira) pro mesmo repositório que você já tem no GitHub,
substituindo os arquivos antigos. Um commit só resolve as duas coisas.

## Passo 2 — Atualize o site principal (como sempre)

No Render, no serviço do site (Static Site), clique em **Manual Deploy** →
"Deploy latest commit". Pronto, o site já pega as correções mais recentes
(busca em trabalhadores/empresas/imóveis, bug do trabalhador que
desaparecia, IA com modelo atualizado, tela de entrevista corrigida).

## Passo 3 — O bot do WhatsApp é um serviço A PARTE (só precisa criar 1 vez)

Esse é novo, então ainda não existe no Render. Diferente do site, ele:
- é um **Web Service** (não "Static Site")
- Root Directory: `whatsapp-backend`
- Build command: `npm install`
- Start command: `npm start`
- precisa das variáveis de ambiente (token do WhatsApp, chave do Gemini etc.)

O passo a passo completo de como criar a conta no Meta, pegar essas
informações e configurar esse serviço está em
`whatsapp-backend/COMO_CONFIGURAR.md`, dentro desse mesmo zip. Isso é a
única parte que precisa de você (login e verificação são de conta pessoal/da
empresa, não dá pra eu fazer por você) — me chama quando chegar nessa etapa
que eu guio tela por tela.

Depois que esse serviço novo existir uma vez, as próximas atualizações dele
também vêm automaticamente desse mesmo repositório do GitHub — não precisa
recriar, só clicar em "Manual Deploy" nele também quando eu mandar uma
atualização que toque nesse bot.
