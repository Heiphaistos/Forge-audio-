// Starts the API and the Vite dev server together (works on Windows, macOS and Linux).
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const procs = ['server', 'web'].map((ws) => spawn(npm, ['run', 'dev', '--workspace', ws], { stdio: 'inherit', shell: process.platform === 'win32' }));

const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { stop(); process.exitCode = code ?? 0; }));
