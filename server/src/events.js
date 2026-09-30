/**
 * Live events per user over Server-Sent Events (/api/events): shared playlists changed, Jam state,
 * Jam invitations, library changed by the Discord bot. Each open tab/app of a user is a subscriber.
 */
export class EventHub {
  constructor() {
    /** @type {Map<string, Set<(event: object) => void>>} */
    this.subs = new Map();
  }

  subscribe(username, send) {
    if (!this.subs.has(username)) this.subs.set(username, new Set());
    this.subs.get(username).add(send);
    return () => {
      const set = this.subs.get(username);
      set?.delete(send);
      if (set && !set.size) this.subs.delete(username);
    };
  }

  emit(usernames, event) {
    for (const u of new Set([].concat(usernames))) for (const send of this.subs.get(u) || []) send(event);
  }

  online(username) {
    return this.subs.has(username);
  }
}

/** Stream a user's events on a hijacked Fastify reply (text/event-stream, ping every 25 s). */
export function streamEvents(hub, request, reply, username) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (event) => { res.write(`data: ${JSON.stringify(event)}\n\n`); };
  send({ type: 'hello', now: Date.now() });
  const off = hub.subscribe(username, send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  request.raw.on('close', () => { clearInterval(ping); off(); });
}
