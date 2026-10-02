import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const API = 'https://api.github.com/repos/Heiphaistos/Forge-audio-/releases/tags/';

/**
 * macOS self-update without an Apple signing certificate (electron-updater/Squirrel.Mac refuses unsigned apps):
 * download the zip of this Mac's architecture, check its SHA-256 against the digest GitHub computed, unpack it
 * with ditto, check its version, then swap the .app once the app has quit. Node's fetch sets no quarantine flag,
 * so Gatekeeper does not block the new copy. Throws when the app cannot replace itself (read-only folder,
 * app run from the disk image or translocated): the caller then shows the download notice.
 */
export function appBundle(execPath = process.execPath) {
  const bundle = path.resolve(execPath, '../../..');
  if (!bundle.endsWith('.app')) throw new Error('pas dans un paquet .app');
  if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) throw new Error('lancée depuis l\'image disque : glissez-la dans Applications');
  fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
  return bundle;
}

export async function stageMacUpdate(version, workDir, { arch = process.arch, bundle = appBundle() } = {}) {
  const name = `ForgeAudio-${version}-mac-${arch}.zip`;
  const release = await (await fetch(API + encodeURIComponent(`v${version}`), { headers: { accept: 'application/vnd.github+json' } })).json();
  const asset = release.assets?.find((a) => a.name === name);
  const expected = /^sha256:([0-9a-f]{64})$/.exec(asset?.digest || '')?.[1];
  if (!asset || !expected) throw new Error(`${name} introuvable dans la release`);

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  const zip = path.join(workDir, name);
  const res = await fetch(asset.browser_download_url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`téléchargement impossible (${res.status})`);
  const hash = crypto.createHash('sha256');
  const file = fs.createWriteStream(zip);
  for await (const chunk of res.body) {
    hash.update(chunk);
    if (!file.write(chunk)) await new Promise((r) => file.once('drain', r));
  }
  await new Promise((resolve, reject) => file.end((err) => (err ? reject(err) : resolve())));
  if (hash.digest('hex') !== expected) throw new Error('empreinte SHA-256 différente : fichier corrompu');

  const out = path.join(workDir, 'app');
  await run('/usr/bin/ditto', ['-x', '-k', zip, out]);
  fs.rmSync(zip);
  const staged = path.join(out, path.basename(bundle));
  const plist = path.join(staged, 'Contents/Info.plist');
  const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]);
  if (stdout.trim() !== version) throw new Error(`version inattendue dans l'archive (${stdout.trim()})`);
  return staged;
}

/** Swap the bundles after this process exits (detached shell), keeping the old one if the move fails, then reopen. */
export function installOnExit(staged, { bundle = appBundle(), relaunch = false, pid = process.pid } = {}) {
  const script = [
    'while kill -0 "$1" 2>/dev/null; do sleep 0.5; done',
    'rm -rf "$2.old"',
    'if mv "$2" "$2.old" && mv "$3" "$2"; then rm -rf "$2.old"; else [ -d "$2" ] || mv "$2.old" "$2"; fi',
    'xattr -dr com.apple.quarantine "$2" 2>/dev/null',
    '[ "$4" = 1 ] && open "$2"',
    'exit 0',
  ].join('\n');
  return spawn('/bin/sh', ['-c', script, 'sh', String(pid), bundle, staged, relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' });
}
