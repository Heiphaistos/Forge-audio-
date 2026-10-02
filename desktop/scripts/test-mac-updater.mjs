// macOS CI check of mac-updater.js against the latest published release: download, SHA-256, ditto, version,
// then the bundle swap once a (fake) app process exits. Run with plain node on a macOS runner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { appBundle, installOnExit, stageMacUpdate } from '../mac-updater.js';

const auth = process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {};
// Newest release that already has this Mac's zip (on a tag build, the release being made may not have it yet).
const releases = await (await fetch('https://api.github.com/repos/Heiphaistos/Forge-audio-/releases?per_page=10', { headers: auth })).json();
const latest = releases.find((r) => !r.draft && r.assets.some((x) => x.name === `ForgeAudio-${r.tag_name.slice(1)}-mac-${process.arch}.zip`));
assert.ok(latest, `aucune release avec le zip ${process.arch}`);
const version = latest.tag_name.replace(/^v/, '');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mac-update-'));
const bundle = path.join(root, 'Applications', 'Forge Audio.app');
fs.mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true });
fs.writeFileSync(path.join(bundle, 'Contents/old-version'), 'ancienne');

assert.equal(appBundle(path.join(bundle, 'Contents/MacOS/Forge Audio')), bundle);
assert.throws(() => appBundle('/Volumes/Forge Audio/Forge Audio.app/Contents/MacOS/Forge Audio'), /image disque/);

const staged = await stageMacUpdate(version, path.join(root, 'work'), { bundle });
console.log('prêt :', staged);
// Builds are not signed as bundles (only Electron's own Mach-O signatures): the swap must leave that state untouched.
const codesign = (p) => spawnSync('/usr/bin/codesign', ['--verify', '--deep', p], { encoding: 'utf8' }).status;
const before = codesign(staged);

const fakeApp = spawn('/bin/sleep', ['2']);
const swap = installOnExit(staged, { bundle, pid: fakeApp.pid });
await new Promise((r) => swap.on('exit', r));
assert.ok(!fs.existsSync(path.join(bundle, 'Contents/old-version')), 'ancienne app remplacée');
assert.ok(!fs.existsSync(`${bundle}.old`), 'copie de secours retirée');
assert.ok(fs.existsSync(path.join(bundle, 'Contents/MacOS/Forge Audio')), 'nouvel exécutable en place');
console.log(`mac-updater OK (${version}, ${process.arch})`);
assert.equal(codesign(bundle), before, 'signature modifiée par le remplacement');
console.log(`signature inchangée après remplacement (codesign ${before})`);

// The real proof: the swapped app starts and stays up (macOS kills a binary with a broken signature at once).
const exe = path.join(bundle, 'Contents/MacOS/Forge Audio');
const started = spawn(exe, [], { stdio: 'ignore', env: { ...process.env, HOME: root } });
let exit = null;
started.on('exit', (code, signal) => { exit = signal || code; });
await new Promise((r) => setTimeout(r, 8000));
assert.equal(exit, null, `l'app remplacée s'est arrêtée au lancement (${exit})`);
started.kill();
console.log('app remplacée lancée et toujours active après 8 s');
