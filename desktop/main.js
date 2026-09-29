import { app, BrowserWindow, shell, Menu, dialog, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureYtdlp } from './ytdlp-manager.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// A fixed port keeps the same web origin between launches, so playlists stored by the UI persist.
const PREFERRED_PORT = 47821;
const PORTABLE_DIR = process.env.PORTABLE_EXECUTABLE_DIR;

// Portable build (Windows): keep all data next to the executable, nothing in the user profile.
if (PORTABLE_DIR) app.setPath('userData', path.join(PORTABLE_DIR, 'ForgeAudio-data'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let server = null;
  let serverPort = null;

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  function ffmpegPath() {
    try {
      const p = require('ffmpeg-static');
      return p ? p.replace('app.asar', 'app.asar.unpacked') : 'ffmpeg';
    } catch {
      return 'ffmpeg';
    }
  }

  async function startServer(ytdlp) {
    const { createApp } = await import(pathToFileURL(path.join(here, 'app/server/app.js')).href);
    const instance = createApp({ ytdlp, ffmpeg: ffmpegPath(), webRoot: path.join(here, 'app/web'), dataDir: path.join(app.getPath('userData'), 'library'), logger: { level: 'warn' } });
    for (let port = PREFERRED_PORT; port < PREFERRED_PORT + 20; port += 1) {
      try {
        await instance.listen({ port, host: '127.0.0.1' });
        return { instance, port };
      } catch (err) {
        if (err.code !== 'EADDRINUSE') throw err;
      }
    }
    throw new Error('Aucun port local disponible');
  }

  // Optional remote server (e.g. the VPS): same account and library as the web version.
  const configFile = () => path.join(app.getPath('userData'), 'config.json');
  const readConfig = () => { try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; } };
  const writeConfig = (c) => { fs.mkdirSync(path.dirname(configFile()), { recursive: true }); fs.writeFileSync(configFile(), JSON.stringify(c, null, 2)); };

  function normalizeServer(url) {
    const u = new URL(String(url).trim());
    if (!/^https?:$/.test(u.protocol)) throw new Error('Adresse http(s) attendue');
    return u.origin;
  }

  async function reachable(origin) {
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(6000) });
      const body = await res.json();
      return !!body?.ok;
    } catch {
      return false;
    }
  }

  ipcMain.handle('forge:get-server', () => readConfig().serverUrl || null);
  ipcMain.handle('forge:set-server', async (event, url) => {
    if (!win || event.sender !== win.webContents) throw new Error('Refusé');
    const config = readConfig();
    if (url) {
      const origin = normalizeServer(url);
      if (!(await reachable(origin))) throw new Error(`Serveur Forge Audio injoignable à ${origin}`);
      config.serverUrl = origin;
    } else {
      delete config.serverUrl;
    }
    writeConfig(config);
    setTimeout(() => openApp().catch(() => {}), 50);
    return config.serverUrl || null;
  });

  const splash = (text) => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#0b0908;color:#f6f3f1;font:600 16px system-ui,sans-serif"><div style="font-size:26px">Forge <span style="color:#ff6a1a">Audio</span></div><div id="t" style="color:#a39b95;font-weight:400">${text}</div></body></html>`)}`;

  async function createWindow() {
    win = new BrowserWindow({
      width: 1320,
      height: 840,
      minWidth: 380,
      minHeight: 560,
      backgroundColor: '#0b0908',
      title: 'Forge Audio',
      icon: path.join(here, 'build/icon.png'),
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    win.loadURL(splash('Préparation du lecteur…'));

    // Links to YouTube, GitHub… open in the default browser, not inside the app.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    win.on('closed', () => { win = null; });
    await openApp();
  }

  /** Load the configured remote server, or start (once) and load the built-in local server. */
  async function openApp() {
    if (!win) return;
    const remote = readConfig().serverUrl;
    if (remote) {
      win.loadURL(splash(`Connexion à ${remote}…`));
      if (await reachable(remote)) {
        await win.loadURL(`${remote}/`);
        return;
      }
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        message: `Le serveur ${remote} est injoignable.`,
        detail: 'Vous pouvez réessayer, ou utiliser le lecteur local (bibliothèque propre à cet ordinateur).',
        buttons: ['Réessayer', 'Mode local'],
        defaultId: 0,
      });
      if (response === 0) return openApp();
    }
    const ytdlp = server ? null : await ensureYtdlp(app.getPath('userData'), {
      onProgress: (p) => win?.webContents.executeJavaScript(`document.getElementById('t').textContent = 'Téléchargement de yt-dlp… ${Math.round(p * 100)} %'`).catch(() => {}),
    });
    try {
      if (!server) {
        const started = await startServer(ytdlp);
        server = started.instance;
        serverPort = started.port;
      }
      await win.loadURL(`http://127.0.0.1:${serverPort}/`);
    } catch (err) {
      dialog.showErrorBox('Forge Audio', `Le serveur local n'a pas pu démarrer : ${err.message}`);
      app.quit();
    }
  }

  app.whenReady().then(() => {
    process.env.FORGE_AUDIO_VERSION = app.getVersion();
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => { if (!win) createWindow(); });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => { server?.close().catch(() => {}); });

  // Keep the managed yt-dlp folder from growing if an update left a partial file behind.
  app.on('will-quit', () => {
    const part = path.join(app.getPath('userData'), 'bin', process.platform === 'win32' ? 'yt-dlp.exe.part' : 'yt-dlp.part');
    try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
  });
}
