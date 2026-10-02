import type { Track } from './types';

/**
 * Spotify « Titres likés » from a file, no Spotify API key needed:
 * - Exportify CSV (exportify.app, Liked Songs, instant);
 * - YourLibrary.json from Spotify's own data export (Compte > Confidentialité, a few days).
 * Returns null when the file is neither, so the Forge Audio JSON import can take it.
 */
export function parseSpotifyLiked(text: string): Track[] | null {
  const body = text.replace(/^﻿/, '');
  if (body.trimStart().startsWith('{')) {
    let data: { tracks?: { artist?: string; album?: string; track?: string; uri?: string }[] };
    try { data = JSON.parse(body); } catch { return null; }
    if (!Array.isArray(data?.tracks)) return null;
    return data.tracks.flatMap((t) => toTrack(t.uri, t.track, t.artist, t.album, null, null));
  }
  // Exportify translates its headers (« URI du titre »…) but keeps the column order: read by position.
  const rows = parseCsv(body).slice(1);
  if (!rows.some((r) => /^spotify:track:/.test(r[0]))) return null;
  const added = rows[0].findIndex((c, i) => i > 16 && /^\d{4}-\d\d-\d\dT/.test(c)); // « Added At », after the 17 base columns
  if (added > 0) rows.sort((a, b) => (b[added] || '').localeCompare(a[added] || ''));
  const cell = (r: string[], i: number) => r[i]?.trim().replace(/\\,/g, ',') || null;
  return rows.flatMap((r) => toTrack(cell(r, 0), cell(r, 1), cell(r, 3), cell(r, 5), Number(cell(r, 12)) || null, cell(r, 9)));
}

function toTrack(uri: string | null | undefined, title: string | null | undefined, artist: string | null | undefined, album: string | null | undefined, ms: number | null, image: string | null): Track[] {
  const id = (uri || '').match(/^spotify:track:([A-Za-z0-9]{22})$/)?.[1];
  if (!id || !title) return [];
  const url = `https://open.spotify.com/track/${id}`;
  return [{
    id: url, url, title: title.slice(0, 300), author: artist || null, album: album || null, source: 'spotify',
    duration: ms ? Math.round(ms / 1000) : null, thumbnail: image && /^https:\/\//.test(image) ? image : null,
  }];
}

/** RFC 4180: quoted fields may hold commas, line breaks and doubled quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
