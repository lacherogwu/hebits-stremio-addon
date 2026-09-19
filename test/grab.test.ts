import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotATorrentError, RateLimitedError } from 'hebits-client';
import { expect, test } from 'vitest';
import { type GrabConfig, type GrabHebits, type GrabQBit, makeGrabber, UserError } from '../src/grab';
import { Store } from '../src/store';

// A one-file private torrent, bencoded by hand. Built in code on purpose: a .torrent from
// this tracker carries the account's passkey in its announce URL, so *.torrent is
// gitignored and no fixture file may be committed. Building it here also guarantees the
// infohash readTorrent computes matches what the fake qBittorrent reports, so ensureTorrent
// never burns its 40 x 250 ms settle poll.
function torrentBuf(name = 'Some.Movie.2020.1080p-GRP', { isPrivate = true } = {}) {
  const info = `d6:lengthi1024e4:name${name.length}:${name}12:piece lengthi16384e6:pieces0:${isPrivate ? '7:privatei1e' : ''}e`;
  return Buffer.from(`d4:info${info}e`);
}

function harness({ hebits = {} }: { hebits?: Partial<GrabHebits> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'grab-'));
  const added: { filename: string; category: string; savePath: string }[] = [];
  const tagged: { hash: string; tags: string[] }[] = [];
  const downloaded: unknown[] = [];
  const qbit: GrabQBit = {
    // Falsy before the add, truthy after: `hash` here is always the real infohash
    // ensureTorrent computed, not the placeholder `add()` below records.
    async torrent(hash) {
      return added.length ? { hash, progress: 0 } : undefined;
    },
    async ensureCategory() {},
    async add(_buf, filename, opts) {
      added.push({ filename, ...opts });
    },
    async addTags(hash, tags) {
      tagged.push({ hash, tags });
    },
    async freeSpace() {
      return 500 * 1024 ** 3;
    },
  };
  const cfg: GrabConfig = {
    torrentDir: dir,
    watchCategory: 'watch',
    watchPath: '/tmp/watch',
    minFreeGB: 20,
    dailyLimit: 10,
  };
  const store = new Store(dir, 'UTC');
  const grabber = makeGrabber({
    cfg,
    store,
    qbit,
    hebits: {
      async downloadTorrent(id) {
        downloaded.push(id);
        return torrentBuf();
      },
      async dailyDownloads() {
        return { used: 0, limit: 10 };
      },
      ...hebits,
    },
    log: () => {},
  });
  return { grabber, added, tagged, downloaded, dir, store };
}

test('a new grab is tagged with its Hebits id and IMDb id', async () => {
  const { grabber, tagged } = harness();
  await grabber.ensureTorrent('12345', { imdb: 'tt1234567', title: 'Some Movie' });
  expect(tagged.length).toBe(1);
  expect(tagged[0]?.tags).toEqual(['hebits:12345', 'imdb:tt1234567']);
});

test('a grab with no IMDb id is still tagged with the Hebits id', async () => {
  const { grabber, tagged } = harness();
  await grabber.ensureTorrent('777', { title: 'Unknown' });
  expect(tagged[0]?.tags).toEqual(['hebits:777']);
});

test('the torrent is added to the requested category', async () => {
  const { grabber, added } = harness();
  await grabber.ensureTorrent('12345', { imdb: 'tt1' }, { category: 'seed-auto', savePath: '/tmp/seed' });
  expect(added[0]?.category).toBe('seed-auto');
  expect(added[0]?.savePath).toBe('/tmp/seed');
});

test('the daily limit is refused before a download is spent', async () => {
  const { grabber, downloaded, added } = harness({
    hebits: {
      async dailyDownloads() {
        return { used: 10, limit: 10 };
      },
    },
  });
  await expect(grabber.ensureTorrent('1', {})).rejects.toThrow(/daily download limit/);
  // The order is the whole point: the allowance is checked BEFORE the tracker is asked
  // for the .torrent, so a refused grab costs nothing.
  expect(downloaded).toEqual([]);
  expect(added).toEqual([]);
});

// HAZARD (id): HebitsTorrent.id is a number, the store is keyed by strings. The id must be
// converted at each boundary - String() going into the store, Number() going out to
// hebits-client - or the store misses every lookup and/or the tracker gets a string id.
test('the Hebits id reaches downloadTorrent as a number and the store as a string key', async () => {
  const { grabber, downloaded, store } = harness();
  await grabber.ensureTorrent('12345', { imdb: 'tt1' });
  expect(downloaded).toEqual([12345]);
  expect(typeof downloaded[0]).toBe('number');
  // Object.keys() is how the rest of the addon reads the store, so the key must be a string.
  expect(Object.keys(store.data.torrents)).toEqual(['12345']);
  expect(store.torrent('12345')?.name).toBe('Some.Movie.2020.1080p-GRP');
});

test('a torrent already on disk is re-added without touching Hebits', async () => {
  const { grabber, dir, added, store } = harness({
    hebits: {
      async downloadTorrent() {
        throw new Error('the tracker must not be touched for a torrent we already hold');
      },
    },
  });
  writeFileSync(join(dir, 'hebits-999.torrent'), torrentBuf());
  await grabber.ensureTorrent('999', { imdb: 'tt9' });
  expect(added.length).toBe(1);
  expect(store.data.grabs).toEqual([]); // re-adding does not spend a daily download
});

test('a torrent that is not private is refused before anything is added', async () => {
  const { grabber, dir, added, store } = harness({
    hebits: {
      async downloadTorrent() {
        return torrentBuf('Public.Swarm.Bait', { isPrivate: false });
      },
    },
  });
  await expect(grabber.ensureTorrent('555', {})).rejects.toThrow(/not private/);
  expect(added).toEqual([]);
  // Nothing is kept and nothing is recorded: the refusal is total.
  expect(existsSync(join(dir, 'hebits-555.torrent'))).toBe(false);
  expect(store.data.grabs).toEqual([]);
});

// hebits-client validates the bencode itself and throws NotATorrentError for the HTML
// page Hebits serves when it refuses a download, so the readTorrent catch below it never
// sees that case any more. Without the mapping it would reach the server as a 500
// instead of the readable 409 the UserError path produces.
test('a tracker refusal is a UserError (409), not an unhandled failure', async () => {
  const { grabber, added, store } = harness({
    hebits: {
      async downloadTorrent() {
        throw new NotATorrentError('response is not bencode: <!DOCTYPE html><title>Hebits</title>');
      },
    },
  });
  const err = await grabber.ensureTorrent('556', {}).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(String(err)).toContain('Hebits refused the download');
  expect(added).toEqual([]);
  expect(store.data.grabs).toEqual([]);
});

// The positive control for the test above: only that one error class becomes a 409. A
// catch-all would turn every transport failure into "Hebits refused the download" and
// report a broken tracker, a dead cookie or a bug as the user's problem.
test('any other download failure keeps its own class, so it is still a 500', async () => {
  const { grabber } = harness({
    hebits: {
      async downloadTorrent() {
        throw new RateLimitedError('slow down');
      },
    },
  });
  const err = await grabber.ensureTorrent('557', {}).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RateLimitedError);
  expect(err).not.toBeInstanceOf(UserError);
});

// HAZARD (daily): lib/grab.js had two modes on purpose - a 5-minute cached count for
// DISPLAY (every stream list, /status) and a fresh one only when about to spend a
// download. hebits-client's dailyDownloads() always reads through to the tracker, so the
// port kept the fresh variant and dropped the cheap one: a user.php round-trip (plus the
// stats call that resolves the user id) on every single stream list, forever.
test('a displayed download count is served from cache, not a tracker call each time', async () => {
  let calls = 0;
  const { grabber } = harness({
    hebits: {
      async dailyDownloads() {
        calls++;
        return { used: 1, limit: 10 };
      },
    },
  });

  expect(await grabber.daily()).toEqual({ used: 1, limit: 10 });
  expect(await grabber.daily()).toEqual({ used: 1, limit: 10 });
  expect(await grabber.daily()).toEqual({ used: 1, limit: 10 });
  expect(calls).toBe(1);
});

// The other half, and the one with teeth: the cache must never be what a download is
// spent against. Here the tracker's count moves to the limit after the display read, so a
// grab that trusted the cached figure would go ahead and overspend the allowance.
test('a grab reads the allowance fresh, even with a cached count in hand', async () => {
  let used = 0;
  const { grabber, downloaded } = harness({
    hebits: {
      async dailyDownloads() {
        return { used, limit: 10 };
      },
    },
  });

  expect(await grabber.daily()).toEqual({ used: 0, limit: 10 }); // fills the display cache
  used = 10; // the allowance is spent elsewhere (another client, or the account's own use)

  await expect(grabber.ensureTorrent('1', {})).rejects.toThrow(/daily download limit/);
  expect(downloaded).toEqual([]); // nothing was fetched from the tracker
});

// ...and the mirror image: a grab moves the tracker's count, so the next displayed figure
// must not be the one from before it.
test('a successful grab invalidates the displayed count', async () => {
  let used = 0;
  const { grabber } = harness({
    hebits: {
      async dailyDownloads() {
        return { used, limit: 10 };
      },
    },
  });

  expect(await grabber.daily()).toEqual({ used: 0, limit: 10 });
  await grabber.ensureTorrent('12345', { imdb: 'tt1' });
  used = 1; // what Hebits' own counter now says
  expect(await grabber.daily()).toEqual({ used: 1, limit: 10 });
});

// The fallback is for one answer, not a fact about the tracker: caching it would keep the
// local count in place for five minutes after the tracker came back.
test('the local fallback count is not cached over a tracker that recovers', async () => {
  let fail = true;
  const { grabber, store } = harness({
    hebits: {
      async dailyDownloads() {
        if (fail) throw new Error('hebits unreachable');
        return { used: 4, limit: 10 };
      },
    },
  });
  store.data.grabs = [{ id: 'x', at: new Date().toISOString() }];

  expect(await grabber.daily()).toEqual({ used: 1, limit: 10 }); // the ledger's own count
  fail = false;
  expect(await grabber.daily()).toEqual({ used: 4, limit: 10 });
});
