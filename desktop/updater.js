import { app, dialog, shell, Notification } from 'electron';
import path from 'node:path';
import updaterPkg from 'electron-updater';
import { appBundle, installOnExit, stageMacUpdate } from './mac-updater.js';

const { autoUpdater } = updaterPkg;
const RELEASES = 'https://github.com/Heiphaistos/Forge-audio-/releases/latest';
const EVERY_MS = 6 * 3600 * 1000;

/**
 * Automatic updates from the GitHub releases (latest*.yml, SHA-512 checked by electron-updater):
 * Windows installer, AppImage, .deb and .rpm download in the background and install at the next quit
 * (or right away on « Redémarrer »). macOS (no signing certificate, so Squirrel.Mac refuses) goes through
 * mac-updater.js. The builds that cannot replace themselves (Windows portable, .tar.gz, a Mac app run from the
 * disk image) only get a notice pointing to the download page.
 */
export function startUpdates(getWindow) {
  if (!app.isPackaged) return;
  const selfUpdating = !process.env.PORTABLE_EXECUTABLE_DIR && process.platform !== 'darwin';
  let offered = null;
  let macStaging = null;

  const notice = (version) => {
    if (offered === version) return;
    offered = version;
    const win = getWindow();
    dialog.showMessageBox(win, {
      type: 'info',
      message: `Forge Audio ${version} est disponible`,
      detail: `Vous avez la ${app.getVersion()}. Cette version de l'application ne se met pas à jour seule : téléchargez la nouvelle et installez-la par-dessus (vos réglages sont conservés).`,
      buttons: ['Télécharger', 'Plus tard'],
      defaultId: 0,
    }).then(({ response }) => { if (response === 0) shell.openExternal(RELEASES); }).catch(() => {});
  };

  autoUpdater.autoDownload = selfUpdating;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => {
    if (process.platform === 'darwin' && !process.mas) macUpdate(info.version);
    else if (!selfUpdating) notice(info.version);
  });
  const ready = (version, install) => {
    const win = getWindow();
    if (!win || win.isDestroyed() || !win.isVisible()) {
      if (Notification.isSupported()) new Notification({ title: 'Mise à jour prête', body: `Forge Audio ${version} s'installera à la fermeture de l'application.` }).show();
      return;
    }
    dialog.showMessageBox(win, {
      type: 'info',
      message: `Forge Audio ${version} est prête`,
      detail: "La mise à jour est téléchargée. Redémarrez maintenant (installation silencieuse, l'application se rouvre), ou elle s'installera à la prochaine fermeture de l'application.",
      buttons: ['Redémarrer', 'Plus tard'],
      defaultId: 0,
    }).then(({ response }) => { if (response === 0) install(); }).catch(() => {});
  };

  // macOS: download, check and unpack now; the .app is swapped when the app quits (or right away on « Redémarrer »).
  let macReady = null; // { staged, relaunch }
  app.on('will-quit', () => { if (macReady) installOnExit(macReady.staged, { relaunch: macReady.relaunch }).unref(); });
  const macUpdate = (version) => {
    if (offered === version || macStaging) return;
    try { appBundle(); } catch { notice(version); return; }
    macStaging = stageMacUpdate(version, path.join(app.getPath('temp'), 'forge-audio-update'))
      .then((staged) => {
        offered = version;
        macReady = { staged, relaunch: false };
        ready(version, () => { macReady.relaunch = true; app.quit(); });
      })
      // Release still being published (this Mac's zip not uploaded yet): try again at the next check.
      .catch((err) => { if (!/introuvable/.test(err.message)) notice(version); })
      .finally(() => { macStaging = null; });
  };

  autoUpdater.on('update-downloaded', (info) => {
    if (offered === info.version) return;
    offered = info.version;
    ready(info.version, () => autoUpdater.quitAndInstall(true, true));
  });
  // Unsupported package (.tar.gz), no network…: fall back to the notice once a newer version is known.
  autoUpdater.on('error', () => {});

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 15_000);
  setInterval(check, EVERY_MS);
}
