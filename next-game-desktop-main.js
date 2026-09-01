// NEXT GAME Desktop — wrapper Electron.
// Não reimplementa nada do NEXT GAME: só abre o site já publicado
// (gamerwork-platform.onrender.com) dentro de uma janela própria, sem barra
// de endereço, com ícone, notificações nativas do sistema operacional e
// atalhos de teclado — pra sensação de "app instalado", não navegador.
const { app, BrowserWindow, Menu, shell, session } = require('electron');
const path = require('path');

// Pode trocar sem reempacotar o instalador, se um dia mudar de domínio —
// só definir a variável de ambiente NEXT_GAME_URL antes de abrir o app.
// BUG CORRIGIDO: estava apontando pra 'bluegames-nextgame.onrender.com', um
// endereço que não existe mais (por isso a tela preta — o app ficava
// tentando carregar um site morto pra sempre). O endereço certo, no ar, é
// este aqui embaixo.
const NEXT_GAME_URL = process.env.NEXT_GAME_URL || 'https://gamerwork-platform.onrender.com';

let mainWindow = null;
let loadRetryCount = 0;
let sawRealSite = false; // vira true assim que o NEXT GAME carrega de verdade pelo menos uma vez

// Troca o texto da tela de carregamento sem precisar de IPC — só executa um
// pedacinho de JS na página local que já está aberta.
function setLoadingStatus(text) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents
    .executeJavaScript(
      `(function(){ var el = document.getElementById('status'); if (el) el.textContent = ${JSON.stringify(text)}; })()`
    )
    .catch(() => {});
}

function loadNextGame() {
  mainWindow.loadURL(NEXT_GAME_URL).catch(() => {});
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'NEXT GAME',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#05070d',
    show: false, // só mostra a janela quando já tiver algo pra mostrar — evita o flash de tela preta
    autoHideMenuBar: true, // some a barra de menu (Arquivo/Editar/...) — só aparece com Alt, fica mais "app" e menos "navegador"
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Necessário pra WebRTC (voz/câmera/compartilhamento de tela) funcionar
      // dentro do Electron do mesmo jeito que funciona no navegador comum.
      enableWebRTCPipeWireCapturer: true,
    },
  });

  // Tela de carregamento local (instantânea, não depende de internet) pra
  // nunca aparecer tela preta/branca — só depois disso é que tenta o site
  // de verdade. Assim que ela pintar a primeira vez, mostra a janela.
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.on('did-finish-load', () => {
    const currentUrl = mainWindow.webContents.getURL();
    if (currentUrl.startsWith('file://') && !sawRealSite) {
      // Acabou de mostrar a tela de carregamento — agora sim tenta o site de verdade.
      loadNextGame();
    } else if (currentUrl.startsWith(NEXT_GAME_URL)) {
      sawRealSite = true;
      loadRetryCount = 0;
    }
  });

  // Se o site ainda não respondeu (ex: primeira visita do dia, o serviço
  // grátis do Render "dormindo" pode levar até um minuto pra acordar), tenta
  // de novo sozinho em vez de deixar a pessoa numa tela preta/travada.
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, _desc, validatedUrl, isMainFrame) => {
    if (!isMainFrame || sawRealSite) return;
    if (errorCode === -3) return; // ERR_ABORTED — comum e inofensivo (ex: redirecionamento normal)
    if (!validatedUrl || !validatedUrl.startsWith(NEXT_GAME_URL)) return;

    loadRetryCount += 1;
    if (loadRetryCount <= 2) {
      setLoadingStatus('Conectando ao NEXT GAME...');
    } else if (loadRetryCount <= 6) {
      setLoadingStatus('Isso pode levar até 1 minuto na primeira vez (o servidor está acordando)...');
    } else {
      setLoadingStatus('Ainda tentando conectar — confira sua internet. Tentando de novo...');
    }
    setTimeout(loadNextGame, Math.min(3000 + loadRetryCount * 1500, 12000));
  });

  // Links que abririam em nova aba (ex: SaferNet, documentação) abrem no
  // navegador padrão do sistema, não dentro do app — janela nova dentro do
  // Electron ficaria sem contexto nenhum (sem login, sem nada).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(NEXT_GAME_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Permite câmera/microfone/tela sem o Electron perguntar de um jeito
// diferente do navegador — o próprio NEXT GAME já pede a permissão certa
// (pra chamada de voz, câmera de verificação de idade etc).
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'notifications', 'clipboard-read', 'display-capture'];
    callback(allowed.includes(permission));
  });

  // Menu mínimo — a barra fica escondida (autoHideMenuBar), mas continua
  // acessível via Alt, com o essencial: recarregar, zoom e sair.
  const template = [
    {
      label: 'NEXT GAME',
      submenu: [
        { label: 'Recarregar', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.reload() },
        { label: 'Tela cheia', accelerator: 'F11', role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Sair', role: 'quit' },
      ],
    },
    {
      label: 'Visualizar',
      submenu: [
        { role: 'zoomIn', label: 'Aumentar zoom' },
        { role: 'zoomOut', label: 'Diminuir zoom' },
        { role: 'resetZoom', label: 'Zoom padrão' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Ferramentas do desenvolvedor' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
