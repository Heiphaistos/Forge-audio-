import { create } from 'zustand';
import { api, type Device, type DeviceCommand } from '../lib/api';
import { engine } from '../audio/engine';
import { usePlayer } from './player';
import { useUi } from './ui';
import { useJam } from './social';

/**
 * Remote control between the devices of this account (Spotify Connect style). This page is a device
 * while its live-event stream is open (store/social.ts adds `deviceQuery()` to /api/events): it
 * reports its playback state and obeys the commands sent to it. During an écoute partagée the
 * device reports `jam` and the server refuses remote commands (the shared session drives playback).
 */

const NAME_KEY = 'forge.deviceName';
const rand = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))).replace(/\+/g, '-').replace(/\//g, '_');
/** One id per page load: two tabs are two devices, a closed tab is gone with its stream. */
export const DEVICE_ID = rand();

const kind = (): Device['kind'] => (window.forgeDesktop ? 'desktop' : /ForgeAudioApp/.test(navigator.userAgent) ? 'android' : 'web');

export function defaultDeviceName() {
  const ua = navigator.userAgent;
  if (window.forgeDesktop) return 'Forge Audio (ordinateur)';
  if (/ForgeAudioApp/.test(ua)) return 'Forge Audio (téléphone)';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navigateur';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} sur ${os}` : browser;
}

const storedName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } };

/** `offset` = server clock - this device's clock (ms), to show the live position of the others. */
export const useDevices = create<{ list: Device[]; offset: number; name: string }>(() => ({ list: [], offset: 0, name: storedName() || defaultDeviceName() }));

export const deviceQuery = () => new URLSearchParams({ device: DEVICE_ID, name: useDevices.getState().name, kind: kind() }).toString();

export function livePosition(d: Device) {
  const s = d.state;
  if (!s) return 0;
  return s.playing ? s.position + (Date.now() + useDevices.getState().offset - s.positionAt) / 1000 : s.position;
}

const toast = (text: string, kind?: 'info' | 'error' | 'success') => useUi.getState().toast(text, kind);
const nameOf = (id: string | null) => useDevices.getState().list.find((d) => d.id === id)?.name || 'un autre appareil';

// ---------------------------------------------------------------- report this device's state
let timer: ReturnType<typeof setTimeout> | undefined;
function sendState() {
  const p = usePlayer.getState();
  const t = p.queue[p.index];
  api.deviceState(DEVICE_ID, {
    name: useDevices.getState().name,
    state: {
      track: t && t.source !== 'local' ? t : null,
      playing: p.playing, position: engine.currentTrack ? engine.currentTime : p.position,
      volume: p.muted ? 0 : p.volume, jam: !!useJam.getState().jam, hasNext: p.index < p.queue.length - 1,
    },
  }).catch(() => {});
}
export function reportState() {
  clearTimeout(timer);
  timer = setTimeout(sendState, 250);
}

export function renameDevice(name: string) {
  const clean = name.trim().slice(0, 60);
  try { if (clean) localStorage.setItem(NAME_KEY, clean); else localStorage.removeItem(NAME_KEY); } catch { /* private mode */ }
  useDevices.setState({ name: clean || defaultDeviceName() });
  reportState();
}

// ---------------------------------------------------------------- transfer and commands
/** Send what plays here (queue, track, position) to another device and stop here. */
export async function transferTo(target: string) {
  const p = usePlayer.getState();
  const cur = p.queue[p.index];
  if (!cur || cur.source === 'local') { toast('Rien à transférer : les fichiers locaux restent sur cet appareil', 'info'); return; }
  const tracks = p.queue.filter((t) => t.source !== 'local');
  await api.deviceCommand(target, DEVICE_ID, { action: 'load', tracks, index: tracks.indexOf(cur), position: engine.currentTrack ? engine.currentTime : p.position, playing: true });
  if (usePlayer.getState().playing) usePlayer.getState().togglePlay();
  toast(`Lecture transférée vers ${nameOf(target)}`, 'success');
}

export const remote = (id: string, cmd: DeviceCommand) => api.deviceCommand(id, DEVICE_ID, cmd).catch((err: Error) => toast(err.message, 'error'));

async function obey(c: DeviceCommand & { from: string | null }) {
  if (useJam.getState().jam) return;
  const p = usePlayer.getState();
  switch (c.action) {
    case 'play': if (!p.playing) p.togglePlay(); break;
    case 'pause': if (p.playing) p.togglePlay(); break;
    case 'next': await p.next(false); break;
    case 'prev': p.prev(); break;
    case 'seek': p.seek(c.position); break;
    case 'volume': p.setVolume(c.volume); break;
    case 'load':
      usePlayer.setState({ queue: c.tracks, unshuffled: null, shuffle: false });
      // Loaded paused, then started: a refused autoplay must not skip the queue (player.ts).
      await p.jamLoad(c.index, c.position, false);
      if (c.playing) engine.play().catch(() => toast('Lecture transférée : touchez ▶ pour l’entendre ici (lecture automatique bloquée par le navigateur)', 'info'));
      toast(`Lecture reprise depuis ${nameOf(c.from)}`, 'success');
      break;
    case 'handoff': await transferTo(c.target).catch((err: Error) => toast(err.message, 'error')); break;
  }
  reportState();
}

/** Live events about devices (called by store/social.ts). */
export function onDeviceEvent(e: { type: string; [k: string]: unknown }) {
  if (e.type === 'hello') reportState();
  else if (e.type === 'devices') useDevices.setState({ list: e.devices as Device[], offset: Number(e.serverNow) - Date.now() });
  else if (e.type === 'device-command' && e.to === DEVICE_ID) obey(e as unknown as DeviceCommand & { from: string | null });
}

let started = false;
/** Report on every change that matters to a remote (track, play/pause, volume, jump in position). */
export function startDevices() {
  if (started) return;
  started = true;
  usePlayer.subscribe((s, prev) => {
    if (s.playing !== prev.playing || s.queue[s.index]?.url !== prev.queue[prev.index]?.url || s.volume !== prev.volume
      || s.muted !== prev.muted || Math.abs(s.position - prev.position) > 3) reportState();
  });
  useJam.subscribe((s, prev) => { if (!!s.jam !== !!prev.jam) reportState(); });
  // Drift of the position seen by the remotes.
  setInterval(() => { if (usePlayer.getState().playing) reportState(); }, 20_000);
}
