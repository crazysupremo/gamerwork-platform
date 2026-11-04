# Integração de temas NEXT GAME (parceiros e jogos)

Aplique qualquer tema oficial do NEXT GAME no seu site com duas linhas:

```html
<script src="https://nextgameblue.stream/sdk/nextgame-themes.js"></script>
<script>NextGameThemes.apply('natal')</script>
```

O SDK define variáveis CSS no `<html>` — use-as no seu CSS:

```css
body { background: var(--ng-bg); color: var(--ng-text); }
.botao { background: var(--ng-primary); }
.card  { background: var(--ng-panel); border: 1px solid rgba(var(--ng-primary-rgb), .3); }
```

Variáveis: `--ng-primary`, `--ng-secondary`, `--ng-highlight`, `--ng-text`, `--ng-button`, `--ng-bg`, `--ng-panel` (cada uma com `-rgb`), `--ng-font`, e a classe `ng-theme-<chave>` no `<html>`.

## Efeitos completos

```js
NextGameThemes.apply('natal', { effects: true })
```

Carrega fundo animado, decoração e mascote da data (precisa de `<body>`). Para só as cores, omita `effects`.

## Funções

- `NextGameThemes.list()` → lista de temas publicados e já liberados.
- `NextGameThemes.get(chave)` → um tema.
- `NextGameThemes.apply(chave | tema, { effects, font })`
- `NextGameThemes.remove()` → desfaz tudo.

## API REST (somente leitura, CORS aberto, sem login)

- `GET /api/plus2/public/themes`
- `GET /api/plus2/public/themes/:chave`

Retorna `key, name, tagline, category, colors{primary,secondary,highlight,text,button}, font, scene, decor, premium, releaseAt`. Rascunhos e temas ainda não liberados não aparecem. Cache de 60 s.

## Gerenciando temas

Somente administradores com 2FA, em `/temas.html` (Estúdio de Temas): criar, editar com preview ao vivo (desktop/tablet/celular), checar contraste, rascunho/publicado, agendar lançamento, importar/exportar JSON.
