import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Keeps a standalone yt-dlp binary in the user data folder: downloaded on first launch,
 * self-updated in the background every few days (sites change often, yt-dlp follows).
 */

const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const UPDATE_EVERY = 3 * 24 * 60 * 60 * 1000;

export function assetName(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'ia32' ? 'yt-dlp_x86.exe' : 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

function run(bin, args, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try { proc = spawn(bin, args, { windowsHide: true }); } catch { resolve(null); return; }
    const timer = setTimeout(() => { proc.kill(); resolve(null); }, timeoutMs);
    proc.stdout?.on('data', (d) => { out += d; });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? out.trim() : null); });
  });
}

async function download(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Téléchargement de yt-dlp impossible (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = `${dest}.part`;
  const file = fs.createWriteStream(tmp);
  let done = 0;
  for await (const chunk of res.body) {
    done += chunk.length;
    file.write(chunk);
    if (total) onProgress?.(done / total);
  }
  await new Promise((resolve, reject) => file.end((err) => (err ? reject(err) : resolve())));
  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o755);
}

/**
 * Return a usable yt-dlp path: $YTDLP_PATH, the managed binary, or one found on PATH (downloading if needed).
 */
export async function ensureYtdlp(dataDir, { onProgress, log = console } = {}) {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  const dir = path.join(dataDir, 'bin');
  const managed = path.join(dir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (fs.existsSync(managed) && await run(managed, ['--version'])) {
    const age = Date.now() - fs.statSync(managed).mtimeMs;
    if (age > UPDATE_EVERY) {
      run(managed, ['-U'], 120_000).then(() => { try { fs.utimesSync(managed, new Date(), new Date()); } catch { /* ignore */ } });
    }
    return managed;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    await download(RELEASE + assetName(), managed, onProgress);
    if (await run(managed, ['--version'])) return managed;
  } catch (err) {
    log.warn?.(`yt-dlp : ${err.message}`);
  }
  // Last resort: a system-wide installation.
  if (await run('yt-dlp', ['--version'])) return 'yt-dlp';
  return managed;
}
