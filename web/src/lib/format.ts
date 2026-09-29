export function formatTime(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '--:--';
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatTotal(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

export function formatViews(n: number | null | undefined): string {
  if (!n) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace('.0', '')} Md vues`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.0', '')} M vues`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} k vues`;
  return `${n} vues`;
}

export function timeAgo(ts: number): string {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return "à l'instant";
  if (d < 3600) return `il y a ${Math.floor(d / 60)} min`;
  if (d < 86400) return `il y a ${Math.floor(d / 3600)} h`;
  if (d < 86400 * 7) return `il y a ${Math.floor(d / 86400)} j`;
  return new Date(ts).toLocaleDateString('fr-FR');
}

export const SOURCE_LABELS: Record<string, string> = {
  all: 'Tout',
  youtube: 'YouTube',
  ytmusic: 'YouTube Music',
  soundcloud: 'SoundCloud',
  dailymotion: 'Dailymotion',
  bandcamp: 'Bandcamp',
  vimeo: 'Vimeo',
  twitch: 'Twitch',
  spotify: 'Spotify',
  deezer: 'Deezer',
  apple: 'Apple Music',
  local: 'Fichier local',
};

export const SOURCE_COLORS: Record<string, string> = {
  youtube: '#ff3b30',
  ytmusic: '#ff0033',
  soundcloud: '#ff7700',
  dailymotion: '#3d7bff',
  bandcamp: '#1da0c3',
  vimeo: '#1ab7ea',
  twitch: '#9146ff',
  spotify: '#1ed760',
  deezer: '#a238ff',
  apple: '#fa2d48',
  local: '#a3a3a3',
};

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Higher resolution cover for known CDNs (YouTube hqdefault → maxres is not always there, so use sddefault). */
export function coverUrl(thumb: string | null | undefined, large = false): string | null {
  if (!thumb) return null;
  if (large) return thumb.replace(/\/(hq|mq|default)default\.jpg/, '/sddefault.jpg').replace('-large.jpg', '-t500x500.jpg');
  return thumb;
}
