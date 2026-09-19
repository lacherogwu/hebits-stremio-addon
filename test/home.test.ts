import { expect, test } from 'vitest';
import { entryFrom, HomeLibrary, type HomeQBit, type HomeQFile, type HomeTorrent, isHebitsTorrent } from '../src/home';

const hebits: HomeTorrent = {
  hash: 'aaaa',
  name: 'Galis.Complete.WS.PDTV-TVNETIL',
  size: 900,
  progress: 1,
  state: 'seeding',
  category: 'seed-auto',
  piece_size: 16384,
  tags: 'hebits:1001, imdb:tt3208182',
  tracker: 'https://tracker.hebits.net/KEY/announce',
  magnet_uri: 'magnet:?xt=urn:btih:aaaa',
};
const foreign: HomeTorrent = {
  ...hebits,
  hash: 'bbbb',
  tracker: 'https://other.example/announce',
  magnet_uri: 'magnet:?xt=urn:btih:bbbb',
  tags: '',
};

test('a Hebits torrent is recognised by its working tracker', () => {
  expect(isHebitsTorrent(hebits)).toBe(true);
  expect(isHebitsTorrent(foreign)).toBe(false);
});

// `tracker` is the currently-working tracker and goes empty when none responds.
test('an errored Hebits torrent is still recognised, via its magnet announce list', () => {
  const stalled = { ...hebits, tracker: '', magnet_uri: 'magnet:?xt=urn:btih:aaaa&tr=https%3A%2F%2Ftracker.hebits.net%2FKEY%2Fannounce' };
  expect(isHebitsTorrent(stalled)).toBe(true);
});

test('entryFrom lifts identity out of the tags', () => {
  const e = entryFrom(hebits, [{ path: 'a/b.mkv', length: 900 }]);
  expect(e.hash).toBe('aaaa');
  expect(e.hebitsId).toBe('1001');
  expect(e.imdb).toBe('tt3208182');
  expect(e.pieceLength).toBe(16384);
  expect(e.progress).toBe(1);
  expect(e.files).toEqual([{ path: 'a/b.mkv', length: 900 }]);
});

test('an untagged torrent still produces a usable entry', () => {
  const e = entryFrom({ ...hebits, tags: '' }, []);
  expect(e.hebitsId).toBeUndefined();
  expect(e.imdb).toBeUndefined();
  expect(e.name).toBe('Galis.Complete.WS.PDTV-TVNETIL');
});

// decodeURIComponent throws on a malformed percent-sequence; a Hebits tracker is still
// findable in the raw, still-encoded magnet string, so isHebitsTorrent must not decode.
const malformed: HomeTorrent = {
  ...hebits,
  hash: 'cccc',
  magnet_uri: 'magnet:?xt=urn:btih:cccc&dn=100%&tr=https%3A%2F%2Ftracker.hebits.net%2FKEY%2Fannounce',
};

test('a malformed magnet does not crash isHebitsTorrent', () => {
  expect(() => isHebitsTorrent(malformed)).not.toThrow();
  expect(isHebitsTorrent(malformed)).toBe(true);
});

test('one malformed torrent does not take down the whole catalogue', async () => {
  const lib = new HomeLibrary(fakeQbit([malformed, hebits]));
  const entries = await lib.entries();
  expect(entries.length).toBe(2);
  expect(entries.some((e) => e.hash === 'aaaa')).toBe(true);
});

function fakeQbit(torrents: HomeTorrent[]): HomeQBit & { calls: () => number } {
  let fileCalls = 0;
  return {
    calls: () => fileCalls,
    async all() {
      return torrents;
    },
    async files(hash: string): Promise<HomeQFile[]> {
      fileCalls++;
      return [{ name: `${hash}/video.mkv`, size: 900 }];
    },
  };
}

test('entries lists only Hebits torrents, whoever added them', async () => {
  const lib = new HomeLibrary(fakeQbit([hebits, foreign]));
  const entries = await lib.entries();
  expect(entries.length).toBe(1);
  expect(entries[0]?.hash).toBe('aaaa');
  expect(entries[0]?.files).toEqual([{ path: 'aaaa/video.mkv', length: 900 }]);
});

test('the file list is fetched once per torrent and then cached', async () => {
  const q = fakeQbit([hebits]);
  const lib = new HomeLibrary(q);
  await lib.entries();
  await lib.entries();
  expect(q.calls()).toBe(1);
});

test('forget drops the cached file list', async () => {
  const q = fakeQbit([hebits]);
  const lib = new HomeLibrary(q);
  await lib.entries();
  lib.forget('aaaa');
  await lib.entries();
  expect(q.calls()).toBe(2);
});

test('an unreachable qBittorrent yields an empty library rather than an error', async () => {
  const lib = new HomeLibrary({
    all: () => Promise.reject(new Error('ECONNREFUSED')),
    files: () => Promise.resolve([]),
  });
  expect(await lib.entries()).toEqual([]);
});

test('byHash finds one entry', async () => {
  const lib = new HomeLibrary(fakeQbit([hebits]));
  expect((await lib.byHash('aaaa'))?.hebitsId).toBe('1001');
  expect(await lib.byHash('zzzz')).toBeUndefined();
});

test('byHash fetches file lists for one torrent, not the whole library', async () => {
  const q = fakeQbit([hebits, { ...hebits, hash: 'dddd' }, { ...hebits, hash: 'eeee' }]);
  const lib = new HomeLibrary(q);
  const e = await lib.byHash('aaaa');
  expect(e?.hash).toBe('aaaa');
  expect(q.calls()).toBe(1);
});
