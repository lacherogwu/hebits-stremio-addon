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
  const hebits = makeHebits({ cookiePath, rateLimit: { limit: 100, interval: 10 } }, { cacheTtlMs: 0 });
  expect(hebits).toBeInstanceOf(Hebits);

  await hebits.checkLogin();
  writeFileSync(cookiePath, 'session=new\n'); // what the /cookie page does while the service runs
  await hebits.checkLogin();

  expect(sentCookies).toEqual(['session=old', 'session=new']);
});

// The rate limit is production behaviour, not a detail of the client. hebits-client defaults
// to one request every two seconds, which is right for a background service and wrong for a
// TV waiting on a stream list; leaving it there measured 6.0 s for an ordinary stream list
// and 22-62 s for a find card.
//
// This is the wiring half of that property: what config says the rate is, is what the
// throttle actually does. The value itself is pinned separately, against DEFAULTS, in
// test/config.test.ts - it moved out of this file when it became a config key, because a
// constant nobody could change without rebuilding was the wrong shape for the one setting
// that can cost the account.
//
// Do NOT loosen this to "is it bounded at all". That is the shape that let the client's
// default ship unnoticed in the first place. The lower bound fails if the throttle is
// dropped, or if cfg.rateLimit is ignored in favour of a hardcoded value again; the upper
// bound is wall-clock headroom for a loaded machine, so a failure just over 2 s is a slow
// runner and a failure at ~6 s is the client's default coming back.
//
// checkLogin() is used because it bypasses the response cache, so each call really goes out.
test('makeHebits throttles at the rate config gives it, not one of its own', async () => {
  const cookiePath = join(mkdtempSync(join(tmpdir(), 'hebits-cookie-')), 'cookie.txt');
  writeFileSync(cookiePath, 'session=x\n');
  const hebits = makeHebits({ cookiePath, rateLimit: { limit: 3, interval: 1000 } });

  // Sequentially: hebits-client collapses identical requests that overlap in flight (its
  // own single-flight property), so four concurrent checkLogin() calls would be one
  // request and time nothing.
  const started = Date.now();
  for (let i = 0; i < 4; i++) await hebits.checkLogin();
  const elapsed = Date.now() - started;

  expect(sentCookies.length).toBe(4); // four real requests, not one collapsed call
  expect(elapsed).toBeGreaterThanOrEqual(900); // the fourth waited out a full interval: 3 per second, not more
  expect(elapsed).toBeLessThan(2_000); // ...and not the client's 1-per-2s default, which would be ~6 s
});

// The other half: a DIFFERENT configured rate produces a different throttle. Without this,
// the test above passes just as well against a makeHebits that ignores cfg and hardcodes
// 3/1000 - which is exactly the code this change replaced.
test('a slower configured rate really is slower', async () => {
  const cookiePath = join(mkdtempSync(join(tmpdir(), 'hebits-cookie-')), 'cookie.txt');
  writeFileSync(cookiePath, 'session=x\n');
  const hebits = makeHebits({ cookiePath, rateLimit: { limit: 1, interval: 600 } });

  const started = Date.now();
  for (let i = 0; i < 3; i++) await hebits.checkLogin();
  const elapsed = Date.now() - started;

  expect(sentCookies.length).toBe(3);
  // Three calls at 1-per-600ms wait out two intervals: ~1.2 s. At the 3/1000 the other test
  // uses they would take ~0.7 s, so this bound fails if cfg.rateLimit is not being read.
  expect(elapsed).toBeGreaterThanOrEqual(1_100);
});
