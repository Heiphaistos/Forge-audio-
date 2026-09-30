import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './util.js';
import { readJson, writeJsonAtomic } from './accounts.js';

/**
 * Forge Audio account <-> Discord account, so HeiphaisBot and Forge Audio share the same liked tracks.
 * The user gets a one-time code in Forge Audio (valid 10 min) and types it in Discord; the bot then
 * calls /api/bot/link with that code and the Discord id. Links are saved in <data>/discord-links.json.
 */
const CODE_TTL = 10 * 60 * 1000;

export class DiscordLinks {
  constructor(dataDir) {
    this.file = dataDir ? path.join(dataDir, 'discord-links.json') : null;
    const saved = (this.file && readJson(this.file, { links: {} })) || { links: {} };
    /** discordId -> { username, discordName, linkedAt } */
    this.links = new Map(Object.entries(saved.links || {}));
    /** code -> { username, expires } */
    this.codes = new Map();
  }

  save() {
    if (this.file) writeJsonAtomic(this.file, { links: Object.fromEntries(this.links) });
  }

  newCode(username) {
    for (const [c, v] of this.codes) if (v.username === username || v.expires < Date.now()) this.codes.delete(c);
    const code = String(crypto.randomInt(100000, 1000000));
    this.codes.set(code, { username, expires: Date.now() + CODE_TTL });
    return { code, expiresAt: Date.now() + CODE_TTL };
  }

  /** Called by the bot: consume the code and link the Discord account (one Forge Audio account per Discord account). */
  redeem(code, discordId, discordName = null) {
    const c = this.codes.get(String(code || '').trim());
    if (!c || c.expires < Date.now()) throw new HttpError('Code invalide ou expiré : demandez-en un nouveau dans Forge Audio (Paramètres)', 400, 'BAD_CODE');
    if (!/^\d{15,22}$/.test(String(discordId))) throw new HttpError('Identifiant Discord invalide', 400);
    this.codes.delete(String(code).trim());
    for (const [id, l] of this.links) if (l.username === c.username) this.links.delete(id);
    this.links.set(String(discordId), { username: c.username, discordName: discordName ? String(discordName).slice(0, 100) : null, linkedAt: Date.now() });
    this.save();
    return c.username;
  }

  usernameOf(discordId) {
    return this.links.get(String(discordId))?.username || null;
  }

  ofUser(username) {
    for (const [id, l] of this.links) if (l.username === username) return { discordId: id, discordName: l.discordName, linkedAt: l.linkedAt };
    return null;
  }

  unlink(username) {
    for (const [id, l] of this.links) if (l.username === username) this.links.delete(id);
    this.save();
  }
}

/** Constant-time check of the bot's bearer token (FORGE_BOT_TOKEN); no token configured = bot API off. */
export function checkBotToken(request, expected) {
  if (!expected || expected.length < 32) throw new HttpError('API du bot désactivée (FORGE_BOT_TOKEN absent)', 503, 'BOT_API_OFF');
  const got = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError('Jeton du bot invalide', 401, 'BAD_TOKEN');
}
