// The hebits-client boundary: the three field mappings that change behaviour silently
// (the fourth, `id`, is asserted where it bites, in grab.test.ts and identity.test.ts),
// and the cookie-provider contract every construction of the client must honour.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hebits } from 'hebits-client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { downloadingCount, isWantedCategory, makeHebits, uploadedAtMs } from '../src/hebits';

// HAZARD (uploadedAt): `uploadedAt` is a Date where Torznab's `pubDate` was epoch ms. The
// compiler catches arithmetic on a Date, so the danger is not NaN - it is UNITS: this repo
// also handles qBittorrent timestamps, which are in seconds.
test('uploadedAtMs is milliseconds, the unit every date in this addon is in', () => {
  const it = { uploadedAt: new Date('2026-09-19T09:00:00.000Z') };
  expect(uploadedAtMs(it)).toBe(Date.UTC(2026, 8, 19, 9, 0, 0));
  // An upload three hours old is three hours old against a millisecond clock, not ~57 years.
  expect(Date.UTC(2026, 8, 19, 12, 0, 0) - uploadedAtMs(it)).toBe(3 * 3600_000);
  // The episode list feeds this straight back into a Date (`released`), so it must
  // round-trip to the same instant.
  expect(new Date(uploadedAtMs(it)).toISOString()).toBe('2026-09-19T09:00:00.000Z');
});

// HAZARD (categoryId): one native number, not a Torznab array. The old [2000, 5000] test
// (with its parent-category rounding) admitted exactly native 1 and 2 against the live
// feed. Asserting only that 8 is rejected would also pass against a filter that rejects
// everything, so the wanted ones are asserted PRESENT.
test('only native categories 1 (movies) and 2 (TV) are wanted', () => {
  expect(isWantedCategory({ categoryId: 1 })).toBe(true);
  expect(isWantedCategory({ categoryId: 2 })).toBe(true);
  expect(isWantedCategory({ categoryId: 8 })).toBe(false); // movie packs: tempting, still no
  // The Torznab numbers are gone; nothing on the live feed emits them any more.
  expect(isWantedCategory({ categoryId: 2000 })).toBe(false);
  expect(isWantedCategory({ categoryId: 5000 })).toBe(false);
});

// HAZARD (leechers): `leechers` is already the leecher count; Torznab's `peers` was
// seeders + leechers, hence the old subtraction. Keeping it clamps every healthy torrent
// to zero downloaders.
test('downloadingCount is the leecher count itself, with no seeders subtracted', () => {
  expect(downloadingCount({ seeders: 100, leechers: 5 })).toBe(5);
  expect(downloadingCount({ seeders: 0, leechers: 0 })).toBe(0);
  // Strict ordering, not a difference: under the old subtraction both of these clamp to 0
  // and tie, so a test that only compared them would still pass.
  const busy = { seeders: 100, leechers: 30 };
  const quiet = { seeders: 100, leechers: 2 };
  expect(downloadingCount(busy)).toBeGreaterThan(downloadingCount(quiet));
});

// Proves the fix for the "pasted cookie never reaches the running client" bug: the real
// Hebits client, built the way makeHebits builds it, must send whatever the cookie file
// currently holds on EVERY request - not the value that was current at construction time.
// No network: fetch is stubbed, so hebits-client's transport resolves against a fake front
// page. Nothing here fakes checkLogin() or asserts on plumbing; it asserts on the one thing
// that matters, the Cookie header an actual outgoing request carries.
let sentCookies: string[];

// A page carrying the logout link hebits-client's isLoggedIn() looks for, so checkLogin()
// resolves instead of throwing LoginExpiredError.
const LOGGED_IN_PAGE = '<a href="logout.php?auth=abc123">logout</a>';

beforeEach(() => {
  sentCookies = [];
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    const req = new Request(...args);
    sentCookies.push(req.headers.get('cookie') ?? '');
    return new Response(LOGGED_IN_PAGE, { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('a cookie rotated after construction is carried on the next request, with no reconstruction', async () => {
  const cookiePath = join(mkdtempSync(join(tmpdir(), 'hebits-cookie-')), 'cookie.txt');
  writeFileSync(cookiePath, 'session=old\n');
  // cacheTtlMs: 0 so the second call really goes out; the loose rate limit only keeps the
  // client's default 1-request-per-2s throttle from adding two seconds to the suite.
  const hebits = makeHebits({ cookiePath }, { cacheTtlMs: 0, rateLimit: { limit: 100, interval: 10 } });
  expect(hebits).toBeInstanceOf(Hebits);

  await hebits.checkLogin();
  writeFileSync(cookiePath, 'session=new\n'); // what the /cookie page does while the service runs
  await hebits.checkLogin();

  expect(sentCookies).toEqual(['session=old', 'session=new']);
});
