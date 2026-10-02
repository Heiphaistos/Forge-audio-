// Copy the server sources and the built web app into desktop/app so electron-builder can package them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.resolve(here, '../app');

const web = path.join(root, 'web/dist');
if (!fs.existsSync(path.join(web, 'index.html'))) {
  console.error('web/dist introuvable : lancez d\'abord `npm run build` à la racine du dépôt.');
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, 'server/src'), path.join(out, 'server'), { recursive: true });
fs.cpSync(web, path.join(out, 'web'), { recursive: true });
fs.writeFileSync(path.join(out, 'server/package.json'), JSON.stringify({ type: 'module' }));
console.log('app/ prêt : serveur + interface web copiés.');

// The packaged app only ships desktop/package.json dependencies: a server dependency missing there crashes local mode.
const need = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8')).dependencies || {});
const have = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8')).dependencies || {};
const missing = need.filter((d) => !have[d]);
if (missing.length) {
  console.error(`Dépendances du serveur absentes de desktop/package.json : ${missing.join(', ')}`);
  process.exit(1);
}
