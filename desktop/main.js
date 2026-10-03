import { app, BrowserWindow, shell, Menu, dialog, ipcMain, Tray, nativeImage, Notification, powerSaveBlocker } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureYtdlp } from './ytdlp-manager.js';
import { startUpdates } from './updater.js';

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
  let tray = null;
  let quitting = false;
  let trayHintShown = false;
  let server = null;
  let serverPort = null;

  app.on('second-instance', () => showWindow());

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
  // Same login page and library as the website and the mobile app by default; « local mode » (a library kept on this
  // computer, no account) only when chosen, saved as an empty serverUrl.
  const DEFAULT_SERVER = 'https://connect.forgeaudio.heiphaistos.org';
  const serverOf = (c) => (c.serverUrl === undefined ? DEFAULT_SERVER : c.serverUrl || null);

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

  ipcMain.handle('forge:get-server', () => serverOf(readConfig()));
  ipcMain.handle('forge:set-server', async (event, url) => {
    if (!win || event.sender !== win.webContents) throw new Error('Refusé');
    const config = readConfig();
    if (url) {
      const origin = normalizeServer(url);
      if (!(await reachable(origin))) throw new Error(`Serveur Forge Audio injoignable à ${origin}`);
      config.serverUrl = origin;
    } else {
      config.serverUrl = '';
    }
    writeConfig(config);
    setTimeout(() => openApp().catch(() => {}), 50);
    return serverOf(config);
  });

  const remote = (action) => win?.webContents.executeJavaScript(`window.__forgeRemote && window.__forgeRemote(${JSON.stringify(action)})`).catch(() => {});

  function showWindow() {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  async function refreshTray() {
    if (!tray) return;
    const np = await win?.webContents.executeJavaScript('window.__forgeNowPlaying ? window.__forgeNowPlaying() : null').catch(() => null);
    tray.setToolTip(np ? `Forge Audio — ${np.title}${np.author ? ` · ${np.author}` : ''}` : 'Forge Audio');
    tray.setContextMenu(Menu.buildFromTemplate([
      ...(np ? [{ label: np.title.slice(0, 60), enabled: false }, { type: 'separator' }] : []),
      { label: 'Afficher Forge Audio', click: showWindow },
      { label: np?.playing ? 'Pause' : 'Lecture', click: () => remote('toggle') },
      { label: 'Titre suivant', click: () => remote('next') },
      { label: 'Titre précédent', click: () => remote('prev') },
      { type: 'separator' },
      {
        label: 'Continuer la lecture quand la fenêtre est fermée',
        type: 'checkbox',
        checked: readConfig().closeToTray === true,
        click: (item) => writeConfig({ ...readConfig(), closeToTray: item.checked }),
      },
      { label: 'Quitter', click: () => { quitting = true; app.quit(); } },
    ]));
  }

  function createTray() {
    if (tray) return;
    const icon = nativeImage.createFromPath(path.join(here, 'build/icon.png')).resize({ width: process.platform === 'darwin' ? 18 : 24 });
    tray = new Tray(icon);
    tray.on('click', showWindow);
    tray.on('right-click', () => refreshTray());
    refreshTray();
    // Keep the tooltip / menu in sync with what is playing.
    setInterval(refreshTray, 5000).unref?.();
  }

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

    // Keep the computer awake while music plays (locked screen, idle): without it macOS goes to sleep and the stream
    // stops. Closing a laptop lid still sleeps: no app can prevent that.
    let awake = null;
    const release = () => { if (awake !== null) powerSaveBlocker.stop(awake); awake = null; };
    win.webContents.on('media-started-playing', () => { if (awake === null) awake = powerSaveBlocker.start('prevent-app-suspension'); });
    // Fired per media element: the crossfade pauses the old track while the new one plays, so ask the player.
    // Wait 30 s first: a failed track pauses ~1 s before the next one, and a locked Mac idle for long fell asleep in that gap.
    win.webContents.on('media-paused', () => setTimeout(() => {
      if (!win || win.isDestroyed()) return release();
      win.webContents.executeJavaScript('window.__forgeNowPlaying?.()?.playing === true')
        .then((playing) => { if (!playing) release(); }, release);
    }, 30_000));
    win.on('closed', release);

    // Links to YouTube, GitHub… open in the default browser, not inside the app.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    // Closing the window quits the app. Keeping the music playing in the system tray is opt-in (tray menu): many
    // Linux desktops (GNOME) show no tray icon, and a hidden app with no icon could not be quit at all.
    win.on('close', (e) => {
      if (quitting || readConfig().closeToTray !== true) return;
      e.preventDefault();
      win.hide();
      if (!trayHintShown && Notification.isSupported()) {
        trayHintShown = true;
        new Notification({ title: 'Forge Audio continue en arrière-plan', body: "La musique continue. Clic droit sur l'icône Forge Audio pour la contrôler ou quitter." }).show();
      }
    });
    win.on('closed', () => { win = null; });
    createTray();
    await openApp();
  }

  /** Load the configured remote server, or start (once) and load the built-in local server. */
  async function openApp() {
    if (!win) return;
    const remote = serverOf(readConfig());
    if (remote) {
      win.loadURL(splash(`Connexion à ${remote}…`));
      // Just after waking from sleep the network takes a few seconds to come back: try for ~30 s before asking.
      let ok = await reachable(remote);
      for (let i = 0; !ok && i < 4; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        ok = await reachable(remote);
      }
      if (ok) {
        await win.loadURL(`${remote}/`);
        return;
      }
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        message: `Le serveur ${remote} est injoignable.`,
        detail: 'Vous pouvez réessayer, écouter les titres téléchargés sur cet ordinateur (Hors ligne), ou utiliser le lecteur local (bibliothèque propre à cet ordinateur).',
        buttons: ['Réessayer', 'Hors ligne', 'Mode local'],
        defaultId: 0,
      });
      if (response === 0) return openApp();
      // The server's page is kept by its service worker: it opens on the downloaded titles.
      if (response === 1) {
        try { await win.loadURL(`${remote}/`); return; } catch { return openApp(); }
      }
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
    startUpdates(() => win);
    app.on('activate', () => showWindow());
  });

  app.on('window-all-closed', () => {
    // A window hidden in the tray is not closed: reaching this means the user closed it for good.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => { quitting = true; server?.close().catch(() => {}); });

  // Keep the managed yt-dlp folder from growing if an update left a partial file behind.
  app.on('will-quit', () => {
    const part = path.join(app.getPath('userData'), 'bin', process.platform === 'win32' ? 'yt-dlp.exe.part' : 'yt-dlp.part');
    try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
  });
}
