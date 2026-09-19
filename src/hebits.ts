// The boundary between hebits-client and the rest of the addon: how the client is built,
// and the four fields whose shape changed when Jackett's Torznab items became
// `HebitsTorrent`. Each of those four changes behaviour SILENTLY if ported naively, so the
// conversion lives here once, with a test each, rather than being retyped at every call
// site (`title` → `name` and `files` → `fileCount` are plain renames the compiler catches,
// so they need no helper).
import type { HebitsOptions, HebitsTorrent } from 'hebits-client';
import { Hebits } from 'hebits-client';
import { readCookie } from './config';

// hebits-client's default throttle is one request every two seconds, and its doc comment
// says why: "Nothing here is latency-sensitive." That is true of a background service and
// false here - a TV is sitting in front of someone, waiting.
// Measured through the shipped bundle against a local stub, on that default: 6.0 s for an
// ordinary stream list, 22.0 s for a nine-season find card, 62.0 s at the 30-query
// allSeasons fan-out cap. The Jackett setup this replaces issued those same queries with no
// throttle at all, all at once, for as long as it ran on this account.
//
// So: three per second, shared across every call the process makes (browse, ajax.php,
// user.php, the .torrent download and each retry of any of them - it is one throttle inside
// the client's transport). The same three paths then measure 1.0 s, 3.0 s and 11.0 s.
// 5 per second was measured too (0.0 / 2.0 / 7.0 s) and not taken: the only path it
// materially improves is the rarest one, and the trade is not symmetric - a slow catalogue
// is recoverable, a banned account is not. Either way this stays well short of anything a
// tracker would read as hammering, and gentler than the unthrottled fan-out it replaces.
const RATE_LIMIT = { limit: 3, interval: 1000 };

// The cookie MUST be a provider, never a string. hebits-client resolves a function before
// every request, so a cookie pasted into /cookie while the service runs takes effect on
// the next call. A string binds whatever readCookie() returned at startup: the /cookie
// page then reports success while the running client keeps using the dead cookie — a bug
// that has shipped in a service of this shape before.
export function makeHebits(cfg: { cookiePath: string }, options: Omit<HebitsOptions, 'cookie'> = {}): Hebits {
  return new Hebits({ rateLimit: RATE_LIMIT, ...options, cookie: () => readCookie(cfg.cookiePath) ?? '' });
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
