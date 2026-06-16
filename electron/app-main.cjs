const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8787);
const APP_URL = `http://127.0.0.1:${PORT}`;
let mainWindow;
let serverProcess;
let ownsServer = false;

function requestHealth(timeout = 800) {
  return new Promise((resolve) => {
    const req = http.get(`${APP_URL}/api/health`, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeout, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function resolveAppRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app.asar') : path.resolve(__dirname, '..');
}

function resolveServerEntry() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'server', 'index.js')
    : path.join(resolveAppRoot(), 'server', 'index.js');
}

async function waitForHealth(retries = 80) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (await requestHealth()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function ensureServer() {
  if (await requestHealth()) return;

  const appRoot = resolveAppRoot();
  const serverEntry = resolveServerEntry();
  const dataDir = path.join(app.getPath('userData'), '.data');

  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: app.isPackaged ? path.dirname(serverEntry) : appRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(PORT),
      TRADE_AI_DATA_DIR: dataDir
    },
    stdio: app.isPackaged ? 'ignore' : 'inherit',
    windowsHide: true
  });
  ownsServer = true;

  serverProcess.on('exit', (code) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:server-exit', code);
    }
  });

  if (!(await waitForHealth())) {
    throw new Error('Local API service did not start in time.');
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#08111f',
    title: '外贸 AI 询盘工作台',
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
    if (url.startsWith(APP_URL)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(APP_URL);
}

function installMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.reload() },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '重置缩放', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开项目目录',
          click: () => shell.openPath(app.getPath('userData'))
        },
        {
          label: '关于',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '外贸 AI 询盘工作台',
            message: `外贸 AI 询盘工作台 ${app.getVersion()}`,
            detail: '本地运行，支持邮箱自动化、风控评分、客户线索库和报价单生成。'
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
    dialog.showErrorBox('启动失败', `${error.message}\n\n请确认端口 ${PORT} 未被异常占用，然后重新打开应用。`);
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
