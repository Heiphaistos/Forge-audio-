import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpotifyLiked } from './spotifyLiked.ts';

const A = '4uLU6hMCjMI75M1A2tKUQC', B = '0VjIjW4GlUZAMYd2vXMi3b';

// Exportify order (src/components/data/TracksBaseData.ts): 17 base columns, then Added By / Added At; headers translated.
const row = (uri: string, name: string, artists: string, album: string, image: string, ms: string, at: string) =>
  [uri, name, '', artists, '', album, '', '', '2010', image, '1', '1', ms, '', 'false', '50', 'X', '', at].map((c) => `"${c}"`).join(',');

test('Exportify CSV (French headers): quoted commas, newest like first, cover and duration kept', () => {
  const csv = '﻿"URI du titre","Nom du titre","URI(s) de l\'artiste","Nom(s) de l\'artiste","URI de l\'album","Nom de l\'album","a","b","c","URL de l\'image de l\'album","d","e","Durée du titre (ms)","f","g","h","ISRC","Ajouté par","Ajouté le"\r\n'
    + row(`spotify:track:${A}`, 'Never Gonna Give You Up', 'Rick Astley, Earth\\, Wind & Fire', 'Whenever, You Need', 'https://i.scdn.co/image/ab67616d00001e02aa', '213573', '2024-01-01T10:00:00Z') + '\r\n'
    + row(`spotify:track:${B}`, 'Blinding Lights', 'The Weeknd', 'After Hours', '', '200040', '2025-06-01T10:00:00Z') + '\r\n'
    + row('spotify:local:x:y:z:1', 'Fichier local', '', '', '', '1000', '2025-07-01T00:00:00Z') + '\r\n';
  const t = parseSpotifyLiked(csv)!;
  assert.deepEqual(t.map((x) => x.title), ['Blinding Lights', 'Never Gonna Give You Up']);
  assert.equal(t[1].author, 'Rick Astley, Earth, Wind & Fire');
  assert.equal(t[1].album, 'Whenever, You Need');
  assert.equal(t[1].url, `https://open.spotify.com/track/${A}`);
  assert.equal(t[1].duration, 214);
  assert.equal(t[1].thumbnail, 'https://i.scdn.co/image/ab67616d00001e02aa');
  assert.equal(t[0].thumbnail, null);
});

test('Spotify data export YourLibrary.json', () => {
  const json = JSON.stringify({ tracks: [{ artist: 'Daft Punk', album: 'Discovery', track: 'One More Time', uri: `spotify:track:${A}` }, { track: 'sans uri' }], albums: [] });
  const t = parseSpotifyLiked(json)!;
  assert.equal(t.length, 1);
  assert.equal(t[0].author, 'Daft Punk');
  assert.equal(t[0].source, 'spotify');
});

test('other files are left to the Forge Audio import', () => {
  assert.equal(parseSpotifyLiked('{"app":"forge-audio","playlists":[],"liked":[]}'), null);
  assert.equal(parseSpotifyLiked('a,b\n1,2'), null);
});
