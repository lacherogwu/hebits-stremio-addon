// Recovering the identity of a torrent nobody tagged: added by hand, added before
// tagging existed, or added by a tool that does not write tags.
//
// Order: the tags (free) -> a remembered lookup (free) -> Jackett by release name ->
// Cinemeta by show name -> give up for now and try again later. A success is written
// back to qBittorrent as tags, so a given torrent is looked up at most once, ever.
import { buildTags } from './tags.js';
import { showName } from './parse.js';

const BASE_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 24 * 3600_000;

export const normalizeTitle = (s) =>
  String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function matchRelease(items, name) {
  const want = normalizeTitle(name);
  return items.find((it) => normalizeTitle(it.title) === want);
}

export function nextTryAt(attempts, now) {
  return now + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempts);
}

export class IdentityResolver {
  constructor({ jackett, qbit, cinemetaSearch, cache, save, log = () => {}, now = () => Date.now() }) {
    this.jackett = jackett;
    this.qbit = qbit;
    this.cinemetaSearch = cinemetaSearch;
    this.cache = cache;
    this.save = save;
    this.log = log;
    this.now = now;
  }

  async resolve(entry) {
    const remembered = this.cache[entry.hash];
    if (remembered) {
      entry.hebitsId ??= remembered.hebitsId;
      entry.imdb ??= remembered.imdb;
    }
    if (entry.hebitsId && entry.imdb) return entry;

    const now = this.now();
    if (remembered && now < remembered.nextTryAt) return entry;

    const found = {};
    try {
      const items = await this.jackett.search({ t: 'search', q: showName(entry.name) });
      const hit = matchRelease(items, entry.name);
      if (hit) {
        if (hit.hebitsId) found.hebitsId = hit.hebitsId;
        if (hit.imdb) found.imdb = hit.imdb;
      }
    } catch (e) {
      this.log(`identity jackett ${entry.hash}: ${e.message}`);
    }

    if (!found.imdb && !entry.imdb) {
      try {
        const imdb = await this.cinemetaSearch(showName(entry.name));
        if (imdb) found.imdb = imdb;
      } catch (e) {
        this.log(`identity cinemeta ${entry.hash}: ${e.message}`);
      }
    }

    entry.hebitsId ??= found.hebitsId;
    entry.imdb ??= found.imdb;

    // Back off only stays cleared once the entry is FULLY resolved: a torrent that
    // yields one id but never the other (e.g. a Jackett hit with no imdbid
    // attribute, and no Cinemeta match) must still retry on a schedule, or it
    // re-queries Hebits on every catalogue load forever.
    const attempts = entry.hebitsId && entry.imdb ? 0 : (remembered?.attempts ?? 0) + 1;
    this.cache[entry.hash] = {
      ...(entry.hebitsId && { hebitsId: entry.hebitsId }),
      ...(entry.imdb && { imdb: entry.imdb }),
      attempts,
      nextTryAt: attempts ? nextTryAt(attempts - 1, now) : 0,
    };
    this.save();

    // Write it back so nothing has to look this torrent up again.
    const tags = buildTags(found);
    if (tags.length) await this.qbit.addTags(entry.hash, tags).catch((e) => this.log(`tag ${entry.hash}: ${e.message}`));

    return entry;
  }
}
