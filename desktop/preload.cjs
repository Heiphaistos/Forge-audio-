// Exposes a tiny, read-only bridge so the web app can tell it runs inside the desktop app.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('forgeDesktop', {
  platform: process.platform,
  version: process.env.FORGE_AUDIO_VERSION || '',
});
