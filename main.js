// FadeAway - processus principal Electron
// Charge l'interface (public/) et gère les mises à jour automatiques,
// téléchargées depuis TON serveur (route /updates), pas depuis GitHub.
const { app, BrowserWindow, session, desktopCapturer, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let updater = null;
let feed = null;
let timer = null;

// ---------- mémoire du dernier serveur utilisé ----------
const cfgFile = () => path.join(app.getPath('userData'), 'server.json');
const readServer = () => { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')).url; } catch { return null; } };
const saveServer = url => { try { fs.writeFileSync(cfgFile(), JSON.stringify({ url })); } catch {} };

// ---------- mises à jour ----------
function initUpdater() {
  if (updater) return;
  updater = require('electron-updater').autoUpdater;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-downloaded', info => {
    dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Redémarrer maintenant', 'Plus tard'],
      defaultId: 0,
      cancelId: 1,
      title: 'Mise à jour prête',
      message: `FadeAway ${info.version} est prête.`,
      detail: "Redémarre l'application pour l'installer. Sinon elle s'installera à la fermeture.",
    }).then(r => { if (r.response === 0) updater.quitAndInstall(); });
  });
  updater.on('error', e => console.error('Erreur mise à jour :', e && e.message));
}

function useFeed(serverUrl) {
  if (!app.isPackaged) return; // pas de mise à jour en mode développement
  const url = serverUrl.replace(/\/+$/, '') + '/updates';
  if (url === feed) return;
  feed = url;
  initUpdater();
  updater.setFeedURL({ provider: 'generic', url });
  const check = () => updater.checkForUpdates().catch(() => {});
  check();
  clearInterval(timer);
  timer = setInterval(check, 30 * 60 * 1000); // puis toutes les 30 minutes
}

ipcMain.on('server-url', (event, url) => {
  if (!win || event.sender !== win.webContents) return;
  if (typeof url !== 'string' || url.length > 300 || !/^https?:\/\//i.test(url)) return;
  saveServer(url);
  useFeed(url);
});

// ---------- fenêtre ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#14091f',
    autoHideMenuBar: true,
    title: 'FadeAway',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'public', 'index.html'));
  // les liens externes s'ouvrent dans le navigateur, pas dans l'app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  const ses = session.defaultSession;

  // micro / caméra / partage d'écran autorisés, le reste refusé
  ses.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(['media', 'display-capture', 'fullscreen'].includes(permission)));

  // partage d'écran : on partage le premier écran (+ son système sous Windows)
  ses.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then(sources => {
        if (!sources[0]) return cb({});
        cb(process.platform === 'win32'
          ? { video: sources[0], audio: 'loopback' }
          : { video: sources[0] });
      })
      .catch(() => cb({}));
  });

  createWindow();
  const saved = readServer();   // vérifie les mises à jour dès l'ouverture, sans attendre la connexion
  if (saved) useFeed(saved);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
app.on('window-all-closed', () => app.quit());
