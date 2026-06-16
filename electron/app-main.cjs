const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const START_PORT = Number(process.env.PORT || 8787);
let apiPort = START_PORT;
let appUrl = `http://127.0.0.1:${apiPort}`;
let mainWindow;
let serverProcess;
let ownsServer = false;
let lastServerError = '';

function setApiPort(port) {
  apiPort = port;
  appUrl = `http://127.0.0.1:${apiPort}`;
}

function requestHealth(port = apiPort, timeout = 800) {
  return new Promise((resolve) => {
    let body = '';
    const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(false);
          return;
        }
        try {
          const parsed = JSON.parse(body);
          resolve(parsed && parsed.ok === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeout, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });
}

async function chooseApiPort() {
  for (let port = START_PORT; port < START_PORT + 40; port += 1) {
    if (await requestHealth(port, 450)) return port;
    if (await canListen(port)) return port;
  }
  throw new Error(`No available local API port found from ${START_PORT} to ${START_PORT + 39}.`);
}

function resolveAppRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app.asar') : path.resolve(__dirname, '..');
}

function resolveServerEntry() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'server', 'index.js')
    : path.join(resolveAppRoot(), 'server', 'index.js');
}

async function waitForHealth(retries = 160) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (await requestHealth(apiPort, 1000)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function ensureServer() {
  setApiPort(await chooseApiPort());
  if (await requestHealth(apiPort)) return;

  const appRoot = resolveAppRoot();
  const serverEntry = resolveServerEntry();
  const dataDir = path.join(app.getPath('userData'), '.data');

  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: app.isPackaged ? path.dirname(serverEntry) : appRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(apiPort),
      TRADE_AI_DATA_DIR: dataDir
    },
    stdio: app.isPackaged ? ['ignore', 'ignore', 'pipe'] : 'inherit',
    windowsHide: true
  });
  ownsServer = true;

  if (serverProcess.stderr) {
    serverProcess.stderr.on('data', (chunk) => {
      lastServerError = String(chunk).slice(-1200);
    });
  }

  serverProcess.on('exit', (code) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:server-exit', code);
    }
  });

  if (!(await waitForHealth())) {
    throw new Error(`Local API service did not start in time on port ${apiPort}.${lastServerError ? `\n\n${lastServerError}` : ''}`);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#08111f',
    title: 'Trade Inquiry AI',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'app-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(appUrl)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(appUrl);
}

function installMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.reload() },
        { type: 'separator' },
        { label: 'Exit', role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', role: 'zoomIn' },
        { label: 'Zoom Out', role: 'zoomOut' },
        { label: 'Reset Zoom', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'Full Screen', role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open Data Folder',
          click: () => shell.openPath(app.getPath('userData'))
        },
        {
          label: 'About',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Trade Inquiry AI',
            message: `Trade Inquiry AI ${app.getVersion()}`,
            detail: 'Local desktop workspace for mailbox automation, risk scoring, customer leads, and quotation generation.'
          })
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('app:get-version', () => app.getVersion());

app.whenReady()
  .then(async () => {
    installMenu();
    await ensureServer();
    createWindow();
  })
  .catch((error) => {
    dialog.showErrorBox(
      'Startup failed',
      `${error.message}\n\nPlease close other Trade Inquiry AI windows and try again. If the problem continues, restart Windows once.`
    );
    app.quit();
  });

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (ownsServer && serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
});
