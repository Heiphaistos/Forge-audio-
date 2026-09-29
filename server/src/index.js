#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { resolveFfmpeg, resolveYtdlp } from './binaries.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const app = createApp({
  ytdlp: resolveYtdlp(),
  ffmpeg: await resolveFfmpeg(),
  webRoot: process.env.WEB_ROOT || path.resolve(here, '../../web/dist'),
  accessToken: process.env.ACCESS_TOKEN || null,
  logger: { level: process.env.LOG_LEVEL || 'info' },
});

const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '127.0.0.1';

try {
  await app.listen({ port, host });
  app.log.info(`Forge Audio prêt sur http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
