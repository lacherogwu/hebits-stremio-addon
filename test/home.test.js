import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHebitsTorrent, entryFrom, HomeLibrary } from '../lib/home.js';

const hebits = {
  hash: 'aaaa', name: 'Galis.Complete.WS.PDTV-TVNETIL', size: 900, progress: 1, state: 'seeding',
  category: 'seed-auto', piece_size: 16384, tags: 'hebits:1001, imdb:tt3208182',
  tracker: 'https://tracker.hebits.net/KEY/announce', magnet_uri: 'magnet:?xt=urn:btih:aaaa',
};
const foreign = { ...hebits, hash: 'bbbb', tracker: 'https://other.example/announce', magnet_uri: 'magnet:?xt=urn:btih:bbbb', tags: '' };

test('a Hebits torrent is recognised by its working tracker', () => {
  assert.equal(isHebitsTorrent(hebits), true);
  assert.equal(isHebitsTorrent(foreign), false);
});

// `tracker` is the currently-working tracker and goes empty when none responds.
test('an errored Hebits torrent is still recognised, via its magnet announce list', () => {
  const stalled = { ...hebits, tracker: '', magnet_uri: 'magnet:?xt=urn:btih:aaaa&tr=https%3A%2F%2Ftracker.hebits.net%2FKEY%2Fannounce' };
  assert.equal(isHebitsTorrent(stalled), true);
});

test('entryFrom lifts identity out of the tags', () => {
  const e = entryFrom(hebits, [{ path: 'a/b.mkv', length: 900 }]);
  assert.equal(e.hash, 'aaaa');
  assert.equal(e.hebitsId, '1001');
  assert.equal(e.imdb, 'tt3208182');
  assert.equal(e.pieceLength, 16384);
  assert.equal(e.progress, 1);
  assert.deepEqual(e.files, [{ path: 'a/b.mkv', length: 900 }]);
});

test('an untagged torrent still produces a usable entry', () => {
  const e = entryFrom({ ...hebits, tags: '' }, []);
  assert.equal(e.hebitsId, undefined);
  assert.equal(e.imdb, undefined);
  assert.equal(e.name, 'Galis.Complete.WS.PDTV-TVNETIL');
});

function fakeQbit(torrents) {
  let fileCalls = 0;
  return {
    calls: () => fileCalls,
    async all() { return torrents; },
    async files(hash) {
      fileCalls++;
      return [{ index: 0, name: `${hash}/video.mkv`, size: 900, progress: 1 }];
    },
  };
}

test('entries lists only Hebits torrents, whoever added them', async () => {
  const lib = new HomeLibrary(fakeQbit([hebits, foreign]));
  const entries = await lib.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].hash, 'aaaa');
  assert.deepEqual(entries[0].files, [{ path: 'aaaa/video.mkv', length: 900 }]);
});

test('the file list is fetched once per torrent and then cached', async () => {
  const q = fakeQbit([hebits]);
  const lib = new HomeLibrary(q);
  await lib.entries();
  await lib.entries();
  assert.equal(q.calls(), 1);
});

test('forget drops the cached file list', async () => {
  const q = fakeQbit([hebits]);
  const lib = new HomeLibrary(q);
  await lib.entries();
  lib.forget('aaaa');
  await lib.entries();
  assert.equal(q.calls(), 2);
});

test('an unreachable qBittorrent yields an empty library rather than an error', async () => {
  const lib = new HomeLibrary({ async all() { throw new Error('ECONNREFUSED'); } });
  assert.deepEqual(await lib.entries(), []);
});

test('byHash finds one entry', async () => {
  const lib = new HomeLibrary(fakeQbit([hebits]));
  assert.equal((await lib.byHash('aaaa')).hebitsId, '1001');
  assert.equal(await lib.byHash('zzzz'), undefined);
});
