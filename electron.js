const { app, BrowserWindow, Tray, Menu, shell, nativeImage, ipcMain } = require('electron');
const path = require('path');
const http = require('http');

let win = null;
let tray = null;
let serverProcess = null;

// The URL to load — Railway URL in production, localhost in dev
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

    // Launch a new elevated PowerShell that runs the installer script.
    // Start-Process -Verb RunAs triggers the UAC prompt.
    const psArgs = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \\"${scriptPath}\\"'`
    ];

    require('child_process').spawn('powershell.exe', psArgs, {
      detached: true,
      stdio:    'ignore',
      windowsHide: false,
    }).unref();

    resolve({ ok: true });
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

  // Grant mic, camera, screen capture permissions automatically
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'display-capture', 'screen', 'camera', 'microphone', 'audioCapture', 'videoCapture'];
    callback(allowed.includes(permission));
  });

  // Electron 17+: handle getDisplayMedia() picker. Auto-grant the primary screen.
  if (win.webContents.session.setDisplayMediaRequestHandler) {
    win.webContents.session.setDisplayMediaRequestHandler((req, callback) => {
      const { desktopCapturer } = require('electron');
      desktopCapturer.getSources({ types: ['screen', 'window'] }).then(sources => {
        if (!sources.length) { callback({}); return; }
        const screenSrc = sources.find(s => s.id.startsWith('screen:')) || sources[0];
        const wantsAudio = req && req.audioRequested;
        callback(wantsAudio ? { video: screenSrc, audio: 'loopback' } : { video: screenSrc });
      }).catch(err => { console.error('desktopCapturer failed:', err); callback({}); });
    });
  }

  // Open external links in the system browser, not Electron
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
