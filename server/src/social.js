import { registerActivity } from './activity.js';
import { HttpError } from './util.js';
import { EventHub, streamEvents } from './events.js';
import { SharedPlaylists } from './shared.js';
import { JamHub } from './jam.js';
import { DiscordLinks, checkBotToken } from './links.js';
import { cleanTracks } from './userdata.js';

/**
 * Everything between accounts: live events, shared playlists, Jam, and the link with the Discord
 * bot (HeiphaisBot) so a ❤ in Discord and a ❤ in Forge Audio are the same liked track.
 */
export function registerSocial(app, { accounts, userData, dataDir, botToken = process.env.FORGE_BOT_TOKEN }) {
  const hub = new EventHub();
  const shared = new SharedPlaylists(dataDir);
  const jams = new JamHub(hub);
  const links = new DiscordLinks(dataDir);
  const isAccount = (u) => !!accounts.get(u);
  const me = (request) => request.user.username;
  const activity = registerActivity(app, { accounts, userData, hub });
  const sharedEvent = (users, playlist, extra = {}) => hub.emit(users, { type: 'shared', id: playlist?.id ?? extra.id, playlist: playlist ?? null, ...extra });

  // ---------- Live events ----------
  app.get('/api/events', async (request, reply) => streamEvents(hub, request, reply, me(request)));

  // Accounts one can share with / invite (names only).
  app.get('/api/users', async (request) => ({ users: accounts.list().filter((u) => u.username !== me(request)) }));

  // ---------- Shared playlists ----------
  app.get('/api/shared', async (request) => ({ playlists: shared.forUser(me(request)) }));
  app.get('/api/shared/:id', async (request) => ({ playlist: shared.get(request.params.id, me(request)) }));
  app.post('/api/shared', async (request) => {
    const p = shared.create(me(request), request.body || {}, isAccount);
    sharedEvent(shared.audience(p), p, { by: me(request) });
    return { playlist: p };
  });
  app.patch('/api/shared/:id', async (request) => {
    const { playlist, notify } = shared.update(request.params.id, me(request), request.body || {}, isAccount);
    sharedEvent(notify, playlist, { by: me(request) });
    // Removed members lose it.
    const gone = notify.filter((u) => !shared.audience(playlist).includes(u));
    if (gone.length) sharedEvent(gone, null, { id: playlist.id, removed: true });
    return { playlist };
  });
  app.post('/api/shared/:id/tracks', async (request) => {
    const { playlist, added } = shared.addTracks(request.params.id, me(request), request.body?.tracks);
    if (added) sharedEvent(shared.audience(playlist), playlist, { by: me(request), added });
    return { playlist, added };
  });
  app.delete('/api/shared/:id/tracks', async (request) => {
    const url = String(request.query.url || '');
    const playlist = shared.removeTrack(request.params.id, me(request), url);
    sharedEvent(shared.audience(playlist), playlist, { by: me(request) });
    return { playlist };
  });
  app.post('/api/shared/:id/move', async (request) => {
    const playlist = shared.moveTrack(request.params.id, me(request), request.body?.from, request.body?.to);
    sharedEvent(shared.audience(playlist), playlist, { by: me(request) });
    return { playlist };
  });
  app.delete('/api/shared/:id', async (request) => {
    const id = request.params.id;
    const { deleted, notify } = shared.leaveOrDelete(id, me(request));
    if (deleted) sharedEvent(notify, null, { id, removed: true, by: me(request) });
    else {
      sharedEvent(me(request), null, { id, removed: true });
      const p = shared.lists.get(id);
      if (p) sharedEvent(shared.audience(p), p, { by: me(request), left: me(request) });
    }
    return { ok: true, deleted };
  });

  // ---------- Jam ----------
  app.get('/api/jam', async (request) => { const j = jams.mine(me(request)); return { jam: j ? jams.view(j) : null }; });
  app.post('/api/jam', async (request) => ({ jam: jams.create(request.user, request.body || {}) }));
  app.post('/api/jam/join', async (request) => ({ jam: jams.join(request.user, request.body?.code) }));
  app.post('/api/jam/:id/leave', async (request) => ({ jam: jams.leave(request.params.id, me(request)) }));
  app.post('/api/jam/:id/invite', async (request) => jams.invite(request.params.id, request.user, request.body?.username, isAccount));
  app.post('/api/jam/:id/add', async (request) => ({ jam: jams.add(request.params.id, me(request), request.body?.tracks, !!request.body?.next) }));
  app.post('/api/jam/:id/remove', async (request) => ({ jam: jams.remove(request.params.id, me(request), request.body?.index) }));
  app.post('/api/jam/:id/control', async (request) => ({ jam: jams.control(request.params.id, me(request), request.body || {}) }));
  app.patch('/api/jam/:id', async (request) => ({ jam: jams.settings(request.params.id, me(request), request.body || {}) }));

  // ---------- Discord (HeiphaisBot) ----------
  app.get('/api/me/discord', async (request) => ({ link: links.ofUser(me(request)), botEnabled: !!botToken }));
  app.post('/api/me/discord/code', async (request) => {
    if (!botToken) throw new HttpError('La liaison avec le bot Discord n\'est pas activée sur ce serveur', 503, 'BOT_API_OFF');
    return links.newCode(me(request));
  });
  app.delete('/api/me/discord', async (request) => { links.unlink(me(request)); return { ok: true }; });

  const likedOf = (username) => (userData?.get(username).data?.library?.liked) || [];
  const linked = (request) => {
    checkBotToken(request, botToken);
    const username = links.usernameOf(request.params.discordId);
    if (!username || !isAccount(username)) throw new HttpError('Compte Discord non lié à Forge Audio', 404, 'NOT_LINKED');
    if (!userData) throw new HttpError('Sauvegarde serveur désactivée', 501, 'NO_STORAGE');
    return username;
  };

  app.post('/api/bot/link', async (request) => {
    checkBotToken(request, botToken);
    const username = links.redeem(request.body?.code, request.body?.discordId, request.body?.discordName);
    const u = accounts.get(username);
    hub.emit(username, { type: 'discord', link: links.ofUser(username) });
    return { username, displayName: u?.displayName || username };
  });
  app.get('/api/bot/users/:discordId', async (request) => {
    const username = linked(request);
    const lists = shared.forUser(username).map((p) => ({ id: p.id, name: p.name, owner: p.owner, members: p.members, tracks: p.tracks, updatedAt: p.updatedAt }));
    return { username, displayName: accounts.get(username)?.displayName || username, liked: likedOf(username), shared: lists };
  });
  app.get('/api/bot/users/:discordId/activity', async (request) => ({ friends: activity.friendsOf(linked(request)) }));
  app.get('/api/bot/users/:discordId/stats', async (request) => activity.statsOf(linked(request), Math.min(3650, Math.max(1, Number(request.query.days) || 28))));
  /** Blend with another linked Discord member. */
  app.get('/api/bot/users/:discordId/blend/:otherId', async (request) => {
    const username = linked(request);
    const other = links.usernameOf(request.params.otherId);
    if (!other || !isAccount(other)) throw new HttpError('Ce membre n’a pas lié son compte Forge Audio', 404, 'OTHER_NOT_LINKED');
    return activity.blendOf(username, other);
  });
  /** « Ajouter à une playlist » from Discord into a Forge Audio shared playlist. */
  app.post('/api/bot/users/:discordId/shared/:id/tracks', async (request) => {
    const username = linked(request);
    const { playlist, added } = shared.addTracks(request.params.id, username, request.body?.tracks);
    if (added) sharedEvent(shared.audience(playlist), playlist, { by: username, added });
    return { added, name: playlist.name };
  });
  /** ❤ from Discord: toggles the track in the linked account's liked tracks (same rules as the app: tombstone on unlike). */
  app.post('/api/bot/users/:discordId/like', async (request) => {
    const username = linked(request);
    const [track] = cleanTracks([request.body?.track]);
    if (!track) throw new HttpError('Titre invalide', 400);
    const want = request.body?.liked;
    const result = userData.update(username, (data) => {
      const lib = data.library;
      lib.liked = Array.isArray(lib.liked) ? lib.liked : [];
      lib.unliked = lib.unliked && typeof lib.unliked === 'object' ? lib.unliked : {};
      const has = lib.liked.some((t) => t.url === track.url);
      const like = want === undefined ? !has : !!want;
      if (like && !has) {
        lib.liked.unshift({ ...track, id: track.id || track.url, addedAt: Date.now() });
        delete lib.unliked[track.url];
      } else if (!like && has) {
        lib.liked = lib.liked.filter((t) => t.url !== track.url);
        lib.unliked[track.url] = Date.now();
      }
      return { liked: like, count: lib.liked.length };
    });
    hub.emit(username, { type: 'library', source: 'discord' });
    return result;
  });

  return { hub, shared, jams, links };
}
