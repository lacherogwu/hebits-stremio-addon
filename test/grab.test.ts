import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { type GrabConfig, type GrabHebits, type GrabQBit, makeGrabber } from '../src/grab';
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
