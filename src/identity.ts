// Recovering the identity of a torrent nobody tagged: added by hand, added before
// tagging existed, or added by a tool that does not write tags.
//
// Order: the tags (free) -> a remembered lookup (free) -> Hebits by release name ->
// Cinemeta by show name -> give up for now and try again later. A success is written
// back to qBittorrent as tags, so a given torrent is looked up at most once, ever.
import type { HebitsTorrent } from 'hebits-client';
import { hebitsKey } from './hebits';
import { showName } from './parse';
import type { IdentityCacheEntry } from './store';
import { buildTags } from './tags';

const BASE_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 24 * 3600_000;

export const normalizeTitle = (s: unknown): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

// The slice of HebitsTorrent this module reads. `name` is hebits-client's field for what
// Torznab called `title`.
export type ReleaseItem = Pick<HebitsTorrent, 'id' | 'name'> & { imdb?: string };

export function matchRelease<T extends ReleaseItem>(items: T[], name: string): T | undefined {
  const want = normalizeTitle(name);
  return items.find((it) => normalizeTitle(it.name) === want);
}

export function nextTryAt(attempts: number, now: number): number {
  return now + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempts);
}

// A qBittorrent torrent as this module sees it: its hash, its release name, and whatever
// identity is already known.
export interface IdentityEntry {
  hash: string;
  name: string;
  hebitsId?: string;
  imdb?: string;
}

// The slice of hebits-client's Hebits this resolver uses. Kept narrow so a test fake needs
// no `as any` to stand in for it.
export interface IdentityHebits {
  search(options: { query: string }): Promise<ReleaseItem[]>;
}

// The slice of QBit this resolver uses.
export interface IdentityQBit {
  addTags(hash: string, tags: string[]): Promise<unknown>;
}

export interface IdentityDeps {
  hebits: IdentityHebits;
  qbit: IdentityQBit;
  cinemetaSearch: (name: string) => Promise<string | undefined>;
  cache: Record<string, IdentityCacheEntry>;
  save: () => void;
  log?: (message: string) => void;
  now?: () => number;
}

export class IdentityResolver {
  hebits: IdentityHebits;
  qbit: IdentityQBit;
  cinemetaSearch: (name: string) => Promise<string | undefined>;
  cache: Record<string, IdentityCacheEntry>;
  save: () => void;
  log: (message: string) => void;
  now: () => number;

  constructor({ hebits, qbit, cinemetaSearch, cache, save, log = () => {}, now = () => Date.now() }: IdentityDeps) {
    this.hebits = hebits;
    this.qbit = qbit;
    this.cinemetaSearch = cinemetaSearch;
    this.cache = cache;
    this.save = save;
    this.log = log;
    this.now = now;
  }

  // Generic so a caller's richer entry (a home-library entry carries progress, size, files
  // ...) comes back with its own type intact; the body works through `entry`, the plain
  // IdentityEntry view of the very same object.
  async resolve<T extends IdentityEntry>(item: T): Promise<T & IdentityEntry> {
    const entry: IdentityEntry = item;
    const remembered = this.cache[entry.hash];
    if (remembered) {
      entry.hebitsId ??= remembered.hebitsId;
      entry.imdb ??= remembered.imdb;
    }
    if (entry.hebitsId && entry.imdb) return item;

    const now = this.now();
    if (remembered && now < remembered.nextTryAt) return item;

    const found: { hebitsId?: string; imdb?: string } = {};
    try {
      const items = await this.hebits.search({ query: showName(entry.name) });
      const hit = matchRelease(items, entry.name);
      if (hit) {
        // Every Hebits result carries an id, so unlike the Torznab item (whose id was
        // scraped out of a comments/guid URL and could be missing) this needs no guard —
        // only the number->string conversion the store's keys require.
        found.hebitsId = hebitsKey(hit);
        if (hit.imdb) found.imdb = hit.imdb;
      }
    } catch (e) {
      this.log(`identity hebits ${entry.hash}: ${(e as Error).message}`);
    }

    if (!found.imdb && !entry.imdb) {
      try {
        const imdb = await this.cinemetaSearch(showName(entry.name));
        if (imdb) found.imdb = imdb;
      } catch (e) {
        this.log(`identity cinemeta ${entry.hash}: ${(e as Error).message}`);
      }
    }

    entry.hebitsId ??= found.hebitsId;
    entry.imdb ??= found.imdb;

    // Back off only stays cleared once the entry is FULLY resolved: a torrent that
    // yields one id but never the other (e.g. a Hebits hit with no imdb field, and no
    // Cinemeta match) must still retry on a schedule, or it re-queries Hebits on every
    // catalogue load forever.
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
    if (tags.length) await this.qbit.addTags(entry.hash, tags).catch((e: Error) => this.log(`tag ${entry.hash}: ${e.message}`));

    return item;
  }
}
