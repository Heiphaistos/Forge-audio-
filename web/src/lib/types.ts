export type Source = 'youtube' | 'ytmusic' | 'soundcloud' | 'dailymotion' | 'bandcamp' | 'vimeo' | 'twitch' | 'local' | string;

export interface Track {
  id: string;
  title: string;
  url: string;
  /** seconds */
  duration: number | null;
  thumbnail: string | null;
  author: string | null;
  album?: string | null;
  source: Source;
  isLive?: boolean;
  views?: number | null;
  /** When it was liked or added to the playlist (ms). */
  addedAt?: number;
}

export interface Artist {
  name: string;
  thumbnail: string | null;
  /** When it was followed (ms). */
  at: number;
}

export interface Playlist {
  id: string;
  name: string;
  description: string;
  tracks: Track[];
  cover: string | null;
  sourceUrl?: string | null;
  /** Folder name in the sidebar and the library (null = none). */
  folder?: string | null;
  /** Pinned at the top of the sidebar and the library. */
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** « Masquer » / « Ne plus recommander »: `at` > 0 hidden at that time, < 0 shown again at -at. */
export interface HiddenEntry {
  at: number;
  label: string;
}

export interface HistoryEntry {
  track: Track;
  at: number;
}

export interface Playback {
  src: string;
  seekable: boolean;
  duration: number | null;
  isLive: boolean;
  mime: string;
  /** YouTube blocked the server: the same title plays from another site. */
  fallback?: { url: string; source: 'soundcloud' | 'dailymotion' };
}

export interface LyricsResult {
  found: boolean;
  artist?: string;
  title?: string;
  instrumental?: boolean;
  synced?: { time: number; text: string }[] | null;
  plain?: string | null;
}

export type RepeatMode = 'off' | 'all' | 'one';
