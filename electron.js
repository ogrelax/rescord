const { app, BrowserWindow, Tray, Menu, shell, nativeImage, ipcMain } = require('electron');
const path = require('path');
const http = require('http');

let win = null;
let tray = null;
let serverProcess = null;

const CLOUD_URL   = 'https://content-balance-production-cd65.up.railway.app';
const RESCORD_URL = process.env.RESCORD_URL || (app.isPackaged ? CLOUD_URL : null);
const LOCAL_PORT  = process.env.PORT || 3000;
const LOCAL_URL   = `http://localhost:${LOCAL_PORT}`;

// ─── IPC: Native Noise Suppression Installer ─────────────────────────────────
ipcMain.handle('install-native-suppression', () => {
  return new Promise((resolve) => {
    const scriptPath = app.isPackaged
      ? path.join(process.resourcesPath, 'scripts', 'install-native-suppression.ps1')
      : path.join(__dirname, 'scripts', 'install-native-suppression.ps1');

    if (!require('fs').existsSync(scriptPath)) {
      return resolve({ ok: false, error: 'Script not found: ' + scriptPath });
    }

    // Array-style ArgumentList avoids quoting issues with paths containing spaces.
    // -Wait means exec won't return until the elevated PS window closes.
    const ps1 = scriptPath.replace(/'/g, "''");
    const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1}')"`;

    require('child_process').exec(command, { windowsHide: false }, (err) => {
      if (err && err.code !== 0) {
        resolve({ ok: false, error: err.message });
      } else {
        resolve({ ok: true });
      }
    });
  });
});

function createWindow(url) {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Rescord',
    icon: path.join(__dirname, 'public', 'icon.ico'),
    backgroundColor: '#313338',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    autoHideMenuBar: true,
  });

  win.loadURL(url);

  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'display-capture', 'screen', 'camera', 'microphone', 'audioCapture', 'videoCapture'];
    callback(allowed.includes(permission));
  });

  if (win.webContents.session.setDisplayMediaRequestHandler) {
    win.webContents.session.setDisplayMediaRequestHandler((req, callback) => {
      const { desktopCapturer } = require('electron');
      desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 }
      }).then(async sources => {
        if (!sources.length) { callback({}); return; }
        const wantsAudio = req && req.audioRequested;
        // Ask the renderer to show a picker so the user can choose a screen OR a window.
        const list = sources.map(s => ({
          id: s.id,
          name: s.name,
          isScreen: s.id.startsWith('screen:'),
          thumbnail: s.thumbnail.toDataURL()
        }));
        let chosenId;
        try {
          chosenId = await new Promise((resolve) => {
            ipcMain.once('pick-source-result', (_e, id) => resolve(id));
            win.webContents.send('pick-source', list);
            setTimeout(() => resolve('__cancel__'), 120000); // safety: never hang
          });
        } catch (e) { chosenId = '__cancel__'; }
        if (chosenId === '__cancel__' || chosenId == null) { callback({}); return; } // cancelled
        const chosen = sources.find(s => s.id === chosenId)
          || sources.find(s => s.id.startsWith('screen:')) || sources[0];
        callback(wantsAudio ? { video: chosen, audio: 'loopback' } : { video: chosen });
      }).catch(err => { console.error('desktopCapturer failed:', err); callback({}); });
    });
  }

  win.webContents.setWindowOpenHandler(({ url: u }) => {
    shell.openExternal(u);
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    e.preventDefault();
    win.hide();
  });

  win.on('closed', () => { win = null; });
}

function createTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, 'public', 'icon.ico'));
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Rescord');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Rescord', click: () => { if (win) win.show(); else createWindow(appUrl()); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { win?.destroy(); app.quit(); } },
  ]));
  tray.on('double-click', () => { if (win) win.show(); });
}

function appUrl() {
  return RESCORD_URL || LOCAL_URL;
}

function waitForServer(url, retries, cb) {
  http.get(url + '/health', (res) => {
    if (res.statusCode === 200) cb();
    else retry();
  }).on('error', retry);

  function retry() {
    if (retries <= 0) { cb(); return; }
    setTimeout(() => waitForServer(url, retries - 1, cb), 500);
  }
}

app.whenReady().then(() => {
  createTray();

  if (RESCORD_URL) {
    createWindow(RESCORD_URL);
  } else {
    try {
      serverProcess = require('child_process').fork(
        path.join(__dirname, 'server.js'),
        [],
        { env: { ...process.env, PORT: LOCAL_PORT }, silent: true }
      );
      serverProcess.stdout?.on('data', d => console.log('[server]', d.toString()));
      serverProcess.stderr?.on('data', d => console.error('[server]', d.toString()));
    } catch (e) {
      console.error('Could not start server:', e);
    }
    waitForServer(LOCAL_URL, 10, () => createWindow(LOCAL_URL));
  }
});

app.on('activate', () => {
  if (!win) createWindow(appUrl());
  else win.show();
});

app.on('before-quit', () => {
  if (serverProcess) serverProcess.kill();
});

app.on('window-all-closed', () => {
  // Stay in tray
});
