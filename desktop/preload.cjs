// Small bridge so the web app knows it runs inside the desktop app and can pick its server.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('forgeDesktop', {
  platform: process.platform,
  getServer: () => ipcRenderer.invoke('forge:get-server'),
  setServer: (url) => ipcRenderer.invoke('forge:set-server', url || null),
});
