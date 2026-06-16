const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tradeDesk', {
  platform: process.platform,
  isDesktop: true,
  apiBase: '',
  getVersion: () => ipcRenderer.invoke('app:get-version')
});
