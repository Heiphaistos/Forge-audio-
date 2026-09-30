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
  createdAt: number;
  updatedAt: number;
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
