const { app, BrowserWindow, shell, session, Menu } = require('electron');

// >>> TROQUE AQUI se o endereço do site mudar <<<
let cfg = {};
try { cfg = require('./config.json'); } catch (e) {}
const SITE = process.env.NEXTGAME_URL || cfg.url || 'https://nextgameblue.stream';
const HOST = new URL(SITE).hostname;

if (!app.requestSingleInstanceLock()) app.quit();

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    backgroundColor: '#14151a',
    title: 'NEXT GAME',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });

  // Libera microfone/câmera/notificações só para o site do NEXT GAME
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    const ok = new URL(wc.getURL()).hostname.endsWith(HOST);
    cb(ok && ['media', 'notifications', 'fullscreen', 'clipboard-read'].includes(permission));
  });

  // Links externos abrem no navegador
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).hostname.endsWith(HOST)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!new URL(url).hostname.endsWith(HOST)) { e.preventDefault(); shell.openExternal(url); }
  });

  win.loadURL(SITE);
  win.webContents.on('did-fail-load', () => {
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<body style="background:#14151a;color:#e6e6e6;font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0">' +
      '<div style="text-align:center"><h2>Sem conexão</h2><p>Tentando de novo em 5 segundos...</p></div>' +
      '<script>setTimeout(()=>location.href="' + SITE + '",5000)</script></body>'));
  });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'NEXT GAME', submenu: [{ role: 'reload', label: 'Recarregar' }, { role: 'togglefullscreen', label: 'Tela cheia' }, { role: 'quit', label: 'Sair' }] },
    { label: 'Editar', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }
  ]));
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
