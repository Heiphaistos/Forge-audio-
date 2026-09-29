/** Locate the ffmpeg binary: FFMPEG_PATH, then the optional ffmpeg-static package, then PATH. */
export async function resolveFfmpeg(explicit = process.env.FFMPEG_PATH) {
  if (explicit) return explicit;
  try {
    const mod = await import('ffmpeg-static');
    if (mod.default) return mod.default;
  } catch {
    // optional dependency not installed
  }
  return 'ffmpeg';
}

export function resolveYtdlp(explicit = process.env.YTDLP_PATH) {
  return explicit || 'yt-dlp';
}
