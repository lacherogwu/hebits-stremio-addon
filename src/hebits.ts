// The boundary between hebits-client and the rest of the addon: how the client is built,
// and the handful of field conversions that would change behaviour SILENTLY if each call
// site did them by hand. They live here once, with a test each. (Plain renames are not
// here - the compiler catches those, so they need no helper.)
import type { HebitsOptions, HebitsTorrent } from 'hebits-client';
import { Hebits } from 'hebits-client';
import type { RateLimit } from './config';
import { readCookie } from './config';

// The cookie MUST be a provider, never a string. hebits-client resolves a function before
// every request, so a cookie pasted into /cookie while the service runs takes effect on
// the next call. A string binds whatever readCookie() returned at startup: the /cookie
// page then reports success while the running client keeps using the dead cookie — a bug
// that has shipped in a service of this shape before.
// `rateLimit` comes from config, never from a constant here: it is the one setting that can
// cost the account, so it has to be changeable without editing source. See DEFAULTS.rateLimit
// in config.ts for the measurements behind the default.
export function makeHebits(cfg: { cookiePath: string; rateLimit: RateLimit }, options: Omit<HebitsOptions, 'cookie'> = {}): Hebits {
  return new Hebits({ rateLimit: cfg.rateLimit, ...options, cookie: () => readCookie(cfg.cookiePath) ?? '' });
}

// `HebitsTorrent.id` is a number; the store is keyed by strings (`Object.keys()` on
// state.json's `torrents`). Without the conversion nothing ever matches, every torrent
// looks new, and `store.torrent(id)` silently misses.
export function hebitsKey(it: Pick<HebitsTorrent, 'id'>): string {
  return String(it.id);
}

// `uploadedAt` is a Date; Torznab's `pubDate` was epoch milliseconds. Keep the arithmetic
// in MILLISECONDS: qBittorrent's timestamps (added_on, completion_on, seeding_time) are in
// seconds, and this repo handles both, so a unit that drifts here dates every upload to
// 1970 in the episode list.
export function uploadedAtMs(it: Pick<HebitsTorrent, 'uploadedAt'>): number {
  return it.uploadedAt.getTime();
}

// Hebits' own category numbers — 1 Movies, 2 TV. Torznab's `[2000, 5000]` (plus the
// parent-category rounding that went with it) admitted exactly these two against the live
// feed. Category 8 (movie packs) looks like it belongs here and does not: packs are large
// and spend the daily allowance on something nobody asked for.
export const WANTED_CATEGORY_IDS = [1, 2];

export function isWantedCategory(it: Pick<HebitsTorrent, 'categoryId'>): boolean {
  return WANTED_CATEGORY_IDS.includes(it.categoryId);
}

// What "⬇️ N downloading" counts. Torznab's `peers` was seeders + leechers, hence the old
// `peers - seeders`; `leechers` is already the leecher count, so subtracting seeders again
// clamps every healthy torrent to 0.
export function downloadingCount(it: Pick<HebitsTorrent, 'seeders' | 'leechers'>): number {
  return Math.max(0, it.leechers);
}
