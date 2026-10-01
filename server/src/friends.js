import path from 'node:path';
import { HttpError } from './util.js';
import { readJson, writeJsonAtomic, normalizeUsername, isValidUsername, LoginLimiter } from './accounts.js';

/**
 * Friends (nothing automatic): a request by username, accepted or declined by the other person;
 * either side can remove the friendship; anyone can block anyone (a blocked account can no longer
 * send requests or messages and no longer sees you). Saved in <data>/friends.json.
 *
 * No account enumeration: sending a request or blocking answers the same whether the username
 * exists or not, and a request to an unknown or blocking account is kept but never shown to them.
 */
const MAX_OUTGOING = 100;
const pair = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export class Friends {
  constructor(dataDir) {
    this.file = dataDir ? path.join(dataDir, 'friends.json') : null;
    const saved = (this.file && readJson(this.file, null)) || {};
    /** "a|b" (sorted) -> since */
    this.pairs = new Map(Object.entries(saved.pairs || {}));
    /** "from>to" -> at */
    this.requests = new Map(Object.entries(saved.requests || {}));
    /** "by>who" -> at */
    this.blocks = new Map(Object.entries(saved.blocks || {}));
  }

  save() {
    if (this.file) writeJsonAtomic(this.file, { pairs: Object.fromEntries(this.pairs), requests: Object.fromEntries(this.requests), blocks: Object.fromEntries(this.blocks) });
  }

  are(a, b) {
    return a !== b && this.pairs.has(pair(a, b));
  }

  blocked(by, who) {
    return this.blocks.has(`${by}>${who}`);
  }

  /** Either one blocked the other. */
  separated(a, b) {
    return this.blocked(a, b) || this.blocked(b, a);
  }

  of(username) {
    const out = [];
    for (const [k, since] of this.pairs) {
      const [a, b] = k.split('|');
      if (a === username) out.push({ username: b, since });
      else if (b === username) out.push({ username: a, since });
    }
    return out;
  }

  incoming(username) {
    const out = [];
    for (const [k, at] of this.requests) {
      const [from, to] = k.split('>');
      if (to === username && !this.blocked(username, from)) out.push({ username: from, at });
    }
    return out.sort((x, y) => y.at - x.at);
  }

  outgoing(username) {
    const out = [];
    for (const [k, at] of this.requests) {
      const [from, to] = k.split('>');
      if (from === username) out.push({ username: to, at });
    }
    return out.sort((x, y) => y.at - x.at);
  }

  blockedBy(username) {
    const out = [];
    for (const [k, at] of this.blocks) {
      const [by, who] = k.split('>');
      if (by === username) out.push({ username: who, at });
    }
    return out.sort((x, y) => y.at - x.at);
  }

  /** Returns 'friends' when the other person had already asked (both want it), else 'sent'. */
  request(from, to) {
    if (this.blocked(from, to)) throw new HttpError('Vous avez bloqué ce compte : débloquez-le d’abord', 409, 'BLOCKED');
    if (this.are(from, to)) throw new HttpError('Vous êtes déjà amis', 409, 'ALREADY_FRIENDS');
    if (this.requests.has(`${to}>${from}`) && !this.blocked(to, from)) return this.accept(to, from) && 'friends';
    if (!this.requests.has(`${from}>${to}`)) {
      if (this.outgoing(from).length >= MAX_OUTGOING) throw new HttpError(`${MAX_OUTGOING} demandes en attente au maximum : annulez-en`, 400, 'TOO_MANY');
      this.requests.set(`${from}>${to}`, Date.now());
      this.save();
    }
    return 'sent';
  }

  /** `to` accepts the request of `from`. */
  accept(from, to) {
    if (!this.requests.has(`${from}>${to}`) || this.blocked(to, from)) throw new HttpError('Demande introuvable', 404, 'NOT_FOUND');
    this.requests.delete(`${from}>${to}`);
    this.requests.delete(`${to}>${from}`);
    this.pairs.set(pair(from, to), Date.now());
    this.save();
    return true;
  }

  /** Decline (received) or cancel (sent): the same request, seen from one side or the other. */
  dropRequest(from, to) {
    if (!this.requests.delete(`${from}>${to}`)) throw new HttpError('Demande introuvable', 404, 'NOT_FOUND');
    this.save();
  }

  remove(a, b) {
    if (!this.pairs.delete(pair(a, b))) throw new HttpError('Ce compte n’est pas dans vos amis', 404, 'NOT_FOUND');
    this.save();
  }

  block(by, who) {
    this.pairs.delete(pair(by, who));
    this.requests.delete(`${by}>${who}`);
    this.requests.delete(`${who}>${by}`);
    if (!this.blocks.has(`${by}>${who}`)) this.blocks.set(`${by}>${who}`, Date.now());
    this.save();
  }

  unblock(by, who) {
    if (!this.blocks.delete(`${by}>${who}`)) throw new HttpError('Ce compte n’est pas bloqué', 404, 'NOT_FOUND');
    this.save();
  }
}

/** Username from a request (body or URL): only the format is checked, never whether it exists. */
export function targetName(raw, me) {
  const name = normalizeUsername(raw);
  if (!isValidUsername(name)) throw new HttpError('Identifiant invalide', 400, 'BAD_USERNAME');
  if (name === me) throw new HttpError('C’est votre propre identifiant', 400, 'SELF');
  return name;
}

/**
 * /api/friends routes. `onChange(users)` tells both sides to refresh (SSE `friends`); `onBlock(by, who)`
 * lets the caller cut what else they shared (shared playlists).
 */
export function registerFriends(app, { accounts, friends, hub, onBlock = () => {} }) {
  const me = (request) => request.user.username;
  const nameOf = (u) => accounts.get(u)?.displayName || u;
  const exists = (u) => !!accounts.get(u);
  // 20 requests per hour and per account (sending only: accept/decline are free).
  const limiter = new LoginLimiter({ max: 20, windowMs: 60 * 60 * 1000 });
  const changed = (...users) => hub.emit(users.filter(exists), { type: 'friends' });

  app.get('/api/friends', async (request) => {
    const u = me(request);
    return {
      // Accounts removed since keep their entries on disk but are not listed.
      friends: friends.of(u).filter((f) => exists(f.username)).map((f) => ({ ...f, displayName: nameOf(f.username) })).sort((a, b) => a.displayName.localeCompare(b.displayName, 'fr')),
      incoming: friends.incoming(u).filter((r) => exists(r.username)).map((r) => ({ ...r, displayName: nameOf(r.username) })),
      // The display name of someone who is not a friend yet is not revealed.
      outgoing: friends.outgoing(u),
      blocked: friends.blockedBy(u),
    };
  });

  app.post('/api/friends/requests', async (request, reply) => {
    const u = me(request);
    const to = targetName(request.body?.username, u);
    const wait = limiter.blocked(u);
    if (wait) throw new HttpError(`Trop de demandes, réessayez dans ${wait} min`, 429, 'RATE_LIMITED');
    limiter.fail(u);
    const status = friends.request(u, to);
    // Unknown account, or one that blocked me: stored like any other request, nobody is told.
    if (exists(to) && !friends.blocked(to, u)) changed(u, to);
    reply.code(status === 'friends' ? 200 : 202);
    return { status };
  });
  app.post('/api/friends/requests/:username/accept', async (request) => {
    const u = me(request);
    const from = targetName(request.params.username, u);
    if (!exists(from)) throw new HttpError('Demande introuvable', 404, 'NOT_FOUND');
    friends.accept(from, u);
    changed(u, from);
    return { ok: true };
  });
  app.post('/api/friends/requests/:username/decline', async (request) => {
    const u = me(request);
    const from = targetName(request.params.username, u);
    if (friends.blocked(u, from)) throw new HttpError('Demande introuvable', 404, 'NOT_FOUND');
    friends.dropRequest(from, u);
    changed(u);
    return { ok: true };
  });
  app.delete('/api/friends/requests/:username', async (request) => {
    const u = me(request);
    const to = targetName(request.params.username, u);
    friends.dropRequest(u, to);
    changed(u, ...(friends.blocked(to, u) ? [] : [to]));
    return { ok: true };
  });
  app.delete('/api/friends/:username', async (request) => {
    const u = me(request);
    const other = targetName(request.params.username, u);
    friends.remove(u, other);
    changed(u, other);
    return { ok: true };
  });
  app.post('/api/friends/blocks', async (request) => {
    const u = me(request);
    const who = targetName(request.body?.username, u);
    const wereFriends = friends.are(u, who);
    friends.block(u, who);
    if (exists(who)) onBlock(u, who);
    // The blocked person only notices that the friendship is gone (if there was one).
    changed(u, ...(wereFriends ? [who] : []));
    return { ok: true };
  });
  app.delete('/api/friends/blocks/:username', async (request) => {
    const u = me(request);
    friends.unblock(u, targetName(request.params.username, u));
    changed(u);
    return { ok: true };
  });
}
