const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('guguPet', {
  isDesktop: true,
  moveBy: (dx, dy) => ipcRenderer.send('pet:move-by', dx, dy),
  resetWindow: () => ipcRenderer.send('pet:reset-window'),
  showMenu: () => ipcRenderer.send('pet:show-menu'),
  onCursor: (callback) => {
    const handler = (_event, point) => callback(point);
    ipcRenderer.on('pet:cursor', handler);
    return () => ipcRenderer.off('pet:cursor', handler);
  }
});
