import { Loader2, Play, Save, Shuffle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, type BlendResult } from '../lib/api';
import type { Track } from '../lib/types';
import { useLibrary } from '../store/library';
import { usePlayer } from '../store/player';
import { useUi } from '../store/ui';
import { TrackList } from '../components/TrackList';
import { Cover } from '../components/Cover';

const PERIODS = { month: ['4 dernières semaines', 28], half: ['6 derniers mois', 182], all: ['Tout l’historique', Infinity] } as const;
type Period = keyof typeof PERIODS;
const artistOf = (t: Track) => (t.author || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();

/** Stats computed from the synced listening history (last 1000 plays) — Spotify « Wrapped » style, at any time. */
export function computeStats(history: { track: Track; at: number }[], days: number, now = Date.now()) {
  const since = now - days * 86400000;
  const plays = history.filter((h) => h.at >= since);
  const tracks = new Map<string, { track: Track; n: number }>();
  const artists = new Map<string, { name: string; n: number; thumb: string | null }>();
  let seconds = 0;
  for (const { track } of plays) {
    seconds += track.duration || 0;
    const t = tracks.get(track.url) || { track, n: 0 };
    t.n += 1;
    tracks.set(track.url, t);
    const name = artistOf(track);
    if (name) {
      const a = artists.get(name.toLowerCase()) || { name, n: 0, thumb: track.thumbnail };
      a.n += 1;
      artists.set(name.toLowerCase(), a);
    }
  }
  const hours = new Array(24).fill(0);
  for (const h of plays) hours[new Date(h.at).getHours()] += 1;
  return {
    plays: plays.length,
    minutes: Math.round(seconds / 60),
    topTracks: [...tracks.values()].sort((a, b) => b.n - a.n).slice(0, 10),
    topArtists: [...artists.values()].sort((a, b) => b.n - a.n).slice(0, 10),
    artistCount: artists.size,
    peakHour: plays.length ? hours.indexOf(Math.max(...hours)) : null,
    oldest: history.length ? history[history.length - 1].at : null,
  };
}

export function StatsView() {
  const history = useLibrary((s) => s.history);
  const navigate = useUi((s) => s.navigate);
  const playList = usePlayer((s) => s.playList);
  const [period, setPeriod] = useState<Period>('month');
  const st = useMemo(() => computeStats(history, PERIODS[period][1]), [history, period]);
  const top = st.topTracks.map((t) => t.track);
  return (
    <div className="page">
      <div className="hero-info"><div className="muted small">VOS STATS</div><h1 className="hero-title">Votre écoute</h1></div>
      <div className="chips">
        {(Object.keys(PERIODS) as Period[]).map((p) => <button key={p} className={`chip ${period === p ? 'active' : ''}`} onClick={() => setPeriod(p)}>{PERIODS[p][0]}</button>)}
      </div>
      {!st.plays ? <div className="empty">Pas encore d’écoute sur cette période.</div> : (
        <>
          <div className="stat-grid">
            <div className="stat"><b>{st.minutes.toLocaleString('fr-FR')}</b><span>minutes écoutées (env.)</span></div>
            <div className="stat"><b>{st.plays.toLocaleString('fr-FR')}</b><span>écoutes</span></div>
            <div className="stat"><b>{st.artistCount}</b><span>artistes différents</span></div>
            {st.peakHour != null && <div className="stat"><b>{st.peakHour} h</b><span>votre heure préférée</span></div>}
          </div>
          <section className="shelf">
            <div className="shelf-head"><h2>Artistes les plus écoutés</h2></div>
            <ol className="rank">
              {st.topArtists.map((a, i) => (
                <li key={a.name}><span className="rank-n">{i + 1}</span><Cover src={a.thumb} size={40} radius={999} />
                  <button className="link grow ellipsis" onClick={() => navigate({ name: 'artist', q: a.name })}>{a.name}</button><span className="muted small">{a.n} écoute{a.n > 1 ? 's' : ''}</span></li>
              ))}
            </ol>
          </section>
          <section className="shelf">
            <div className="shelf-head"><h2>Titres les plus écoutés</h2><button className="btn btn-ghost btn-sm" onClick={() => playList(top)}><Play size={14} fill="currentColor" /> Lire</button></div>
            <TrackList tracks={top} listKey={`stats:${period}`} />
          </section>
          {st.oldest && period !== 'month' && <p className="muted small">D’après vos 1000 dernières écoutes, depuis le {new Date(st.oldest).toLocaleDateString('fr-FR')}.</p>}
        </>
      )}
    </div>
  );
}

/** Blend: a playlist mixing the tastes of two accounts (shared tracks first). */
export function BlendView() {
  const user = useUi((s) => s.view.id) || '';
  const toast = useUi((s) => s.toast);
  const { playList } = usePlayer.getState();
  const [state, setState] = useState<{ data: BlendResult | null; error: string | null }>({ data: null, error: null });
  useEffect(() => { setState({ data: null, error: null }); api.blend(user).then((data) => setState({ data, error: null })).catch((e) => setState({ data: null, error: e.message })); }, [user]);
  if (state.error) return <div className="page"><div className="empty error">{state.error}</div></div>;
  if (!state.data) return <div className="page"><div className="empty"><Loader2 className="spin" size={28} /> Préparation du Blend…</div></div>;
  const { tracks, match, common } = state.data;
  const name = state.data.with.displayName;
  return (
    <div className="page">
      <div className="hero">
        <Cover src={tracks[0]?.thumbnail ?? null} size={200} radius={10} />
        <div className="hero-info">
          <div className="muted small">BLEND</div>
          <h1 className="hero-title">Vous + {name}</h1>
          <div className="muted small">{match} % de goûts en commun · {common} titre{common > 1 ? 's' : ''} que vous aimez tous les deux · {tracks.length} titres</div>
        </div>
      </div>
      {!tracks.length ? <div className="empty">Pas encore assez d’écoutes ou de titres likés pour mélanger vos goûts.</div> : (
        <>
          <div className="actions">
            <button className="play-btn big" onClick={() => playList(tracks)} aria-label="Lire"><Play size={26} fill="currentColor" className="nudge" /></button>
            <button className="icon-btn big" onClick={() => playList(tracks, 0, { shuffle: true })} aria-label="Lecture aléatoire"><Shuffle size={24} /></button>
            <button className="btn btn-ghost" onClick={() => { const pl = useLibrary.getState().createPlaylist(`Blend · ${name}`, tracks); toast(`Enregistré dans « ${pl.name} »`, 'success'); }}><Save size={16} /> Enregistrer comme playlist</button>
          </div>
          <TrackList tracks={tracks} listKey={`blend:${user}`} />
        </>
      )}
    </div>
  );
}
