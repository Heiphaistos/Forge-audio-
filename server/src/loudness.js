import { spawn } from 'node:child_process';
import { HttpError, TtlCache, isPublicUrl } from './util.js';
import { playableUrl } from './streaming.js';

/**
 * « Volume harmonisé »: integrated loudness (EBU R128, LUFS) of a track, measured once by ffmpeg on
 * its first 90 s (low-bitrate stream: the loudness does not depend on the bitrate). The client turns
 * loud tracks down to the target (-14 LUFS, like YouTube); nothing is re-encoded, playback stays direct.
 */
const cache = new TtlCache({ ttlMs: 30 * 86400000, max: 20000 });
let chain = Promise.resolve();

export function parseIntegrated(stderr) {
  // Summary block: « Integrated loudness: / I: -9.7 LUFS »
  const m = String(stderr).match(/Integrated loudness:\s*\n\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  const v = m ? Number(m[1]) : NaN;
  // 0.0 = the empty summary printed when the filter failed; real music sits between -70 and 0.
  return Number.isFinite(v) && v > -70 && v < 0 ? v : null;
}

/**
 * yt-dlp downloads (it splits the file into the small requests googlevideo accepts) and pipes the audio
 * into ffmpeg, which measures the first 90 s; yt-dlp is stopped as soon as ffmpeg is done.
 */
function measure(ytdlp, ffmpeg, url) {
  return new Promise((resolve) => {
    const yt = spawn(ytdlp, ['-q', '--no-warnings', '--no-part', '--no-playlist', '-f', 'bestaudio[abr<=72]/worstaudio/bestaudio', '-o', '-', '--', url], { stdio: ['ignore', 'pipe', 'ignore'] });
    const ff = spawn(ffmpeg, ['-hide_banner', '-nostats', '-t', '90', '-i', 'pipe:0', '-vn', '-af', 'ebur128=framelog=verbose', '-f', 'null', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
    yt.stdout.pipe(ff.stdin).on('error', () => {});
    yt.on('error', () => ff.kill('SIGKILL'));
    let err = '';
    ff.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-50000); });
    const timer = setTimeout(() => { ff.kill('SIGKILL'); yt.kill('SIGKILL'); }, 90_000);
    ff.on('close', (code) => { clearTimeout(timer); yt.kill('SIGKILL'); resolve(code === 0 ? parseIntegrated(err) : null); });
    ff.on('error', () => { clearTimeout(timer); yt.kill('SIGKILL'); resolve(null); });
  });
}

export function registerLoudness(app, { media, ffmpeg, ytdlp }) {
  app.get('/api/loudness', async (request) => {
    const raw = String(request.query.url || '').trim();
    if (!isPublicUrl(raw)) throw new HttpError('Adresse non autorisée', 400);
    const hit = cache.get(raw);
    if (hit !== undefined) return { lufs: hit };
    // One measurement at a time: ffmpeg decoding is the costly part on a small server.
    const job = chain.then(async () => {
      if (cache.get(raw) !== undefined) return cache.get(raw);
      let lufs = null;
      try {
        const url = await playableUrl(ytdlp, raw);
        const m = await media.resolve(url, 'audio', 'webm', 'high');
        if (!m.isLive) lufs = await measure(ytdlp, ffmpeg, url);
      } catch { /* unavailable: played as is */ }
      cache.set(raw, lufs);
      return lufs;
    });
    chain = job.catch(() => null);
    return { lufs: await job };
  });
}
