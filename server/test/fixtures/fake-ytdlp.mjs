#!/usr/bin/env node
// Stand-in for yt-dlp used by the tests: answers from fixtures based on the arguments.
const args = process.argv.slice(2);
const target = args[args.indexOf('--') + 1] || '';
const out = (o) => process.stdout.write(JSON.stringify(o));

if (args.includes('--version')) {
  process.stdout.write('2026.08.19\n');
} else if (target.includes('fail')) {
  process.stderr.write('ERROR: [youtube] abc: Video unavailable\n');
  process.exit(1);
} else if (target.startsWith('ytsearch') || target.startsWith('scsearch')) {
  const sc = target.startsWith('scsearch');
  out({
    _type: 'playlist', extractor: sc ? 'soundcloud:search' : 'youtube:search', entries: [
      { ie_key: sc ? 'Soundcloud' : 'Youtube', id: sc ? '111' : 'dQw4w9WgXcQ', url: sc ? 'https://soundcloud.com/a/b' : 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up', duration: 213, uploader: 'Rick Astley' },
      { ie_key: 'Youtube', id: 'yyyyyyyyyyy', title: '[Deleted video]' },
    ],
  });
} else if (target.includes('list=')) {
  out({
    _type: 'playlist', extractor: 'youtube:tab', title: 'Ma playlist', webpage_url: target, entries: [
      { ie_key: 'Youtube', id: 'aaaaaaaaaaa', title: 'Un', duration: 100 },
      { ie_key: 'Youtube', id: 'bbbbbbbbbbb', title: 'Deux', duration: 200, channel: 'Chaîne' },
    ],
  });
} else if (args.includes('-f')) {
  const hls = target.includes('dailymotion');
  out({
    id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', uploader: 'Rick Astley', duration: 3, webpage_url: target,
    url: process.env.FAKE_MEDIA_URL || 'http://127.0.0.1:1/none', protocol: hls ? 'm3u8_native' : 'http', ext: 'm4a', vcodec: 'none',
    http_headers: { 'User-Agent': 'fake' },
  });
} else {
  out({ id: 'dQw4w9WgXcQ', title: 'Seul', webpage_url: target, extractor: 'youtube', duration: 42 });
}
