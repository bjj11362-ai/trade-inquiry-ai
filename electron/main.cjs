const path = require('node:path');
const { app, BrowserWindow, Menu, ipcMain, screen } = require('electron');

let win;
let alwaysOnTop = true;
let watchCursor = true;
let cursorTimer = null;

function defaultBounds() {
  const display = screen.getPrimaryDisplay().workArea;
  return {
    width: 340,
    height: 380,
    x: display.x + display.width - 380,
    y: display.y + display.height - 430
  };
}

function createWindow() {
  win = new BrowserWindow({
    ...defaultBounds(),
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setAlwaysOnTop(true, 'floating');
  win.loadURL(process.env.GUGU_PET_URL || `file://${path.join(__dirname, '..', 'dist', 'pet.html')}?desktop=1`);
  startCursorWatch();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  stopCursorWatch();
  app.quit();
});

function startCursorWatch() {
  stopCursorWatch();
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !watchCursor) return;
    const point = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const dx = Math.max(-1, Math.min(1, (point.x - centerX) / 420));
    const dy = Math.max(-1, Math.min(1, (point.y - centerY) / 360));
    win.webContents.send('pet:cursor', { x: dx, y: dy });
  }, 100);
}

function stopCursorWatch() {
  if (!cursorTimer) return;
  clearInterval(cursorTimer);
  cursorTimer = null;
}

ipcMain.on('pet:move-by', (_event, dx, dy) => {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy), false);
});

ipcMain.on('pet:reset-window', () => {
  if (!win) return;
  const bounds = defaultBounds();
  win.setBounds(bounds, true);
});

ipcMain.on('pet:show-menu', () => {
  if (!win) return;
  const menu = Menu.buildFromTemplate([
    {
      label: alwaysOnTop ? '取消置顶' : '保持置顶',
      click: () => {
        alwaysOnTop = !alwaysOnTop;
        win.setAlwaysOnTop(alwaysOnTop, 'floating');
      }
    },
    {
      label: watchCursor ? '停止看鼠标' : '开始看鼠标',
      click: () => {
        watchCursor = !watchCursor;
        if (!watchCursor) win.webContents.send('pet:cursor', { x: 0, y: 0 });
      }
    },
    { label: '回到右下角', click: () => win.setBounds(defaultBounds(), true) },
    { type: 'separator' },
    { label: '刷新桌宠', click: () => win.reload() },
    { label: '退出咕咕夹', click: () => app.quit() }
  ]);
  menu.popup({ window: win });
});
