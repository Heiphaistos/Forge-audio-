// macOS CI check of mac-updater.js against the latest published release: download, SHA-256, ditto, version,
// then the bundle swap once a (fake) app process exits. Run with plain node on a macOS runner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appBundle, installOnExit, stageMacUpdate } from '../mac-updater.js';

const latest = await (await fetch('https://api.github.com/repos/Heiphaistos/Forge-audio-/releases/latest')).json();
const version = latest.tag_name.replace(/^v/, '');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mac-update-'));
const bundle = path.join(root, 'Applications', 'Forge Audio.app');
fs.mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true });
fs.writeFileSync(path.join(bundle, 'Contents/old-version'), 'ancienne');

assert.equal(appBundle(path.join(bundle, 'Contents/MacOS/Forge Audio')), bundle);
assert.throws(() => appBundle('/Volumes/Forge Audio/Forge Audio.app/Contents/MacOS/Forge Audio'), /image disque/);

const staged = await stageMacUpdate(version, path.join(root, 'work'), { bundle });
console.log('prêt :', staged);

const fakeApp = spawn('/bin/sleep', ['2']);
const swap = installOnExit(staged, { bundle, pid: fakeApp.pid });
await new Promise((r) => swap.on('exit', r));
assert.ok(!fs.existsSync(path.join(bundle, 'Contents/old-version')), 'ancienne app remplacée');
assert.ok(!fs.existsSync(`${bundle}.old`), 'copie de secours retirée');
assert.ok(fs.existsSync(path.join(bundle, 'Contents/MacOS/Forge Audio')), 'nouvel exécutable en place');
console.log(`mac-updater OK (${version}, ${process.arch})`);
const { spawnSync } = await import('node:child_process');
const sig = spawnSync('/usr/bin/codesign', ['--verify', '--deep', bundle], { encoding: 'utf8' });
assert.equal(sig.status, 0, `signature de l'app remplacée invalide : ${sig.stderr}`);
console.log('signature (ad hoc) valide après remplacement');
