import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHebitsId, libraryId, kindOf, episodes, catalogMetas, metaFor, matchesSearch } from '../lib/library.js';
import { pickFile } from '../lib/parse.js';

const galis = {
  hebitsId: '1001',
  hash: '1111111111111111111111111111111111111111',
  progress: 1,
  name: 'Galis.Complete.WS.PDTV-TVNETIL',
  imdb: 'tt3208182',
  files: [
    { path: 'Galis.Complete.WS.PDTV-TVNETIL/Galis.S01.PDTV/Galis.S01E02.PDTV.avi', length: 3e8 },
    { path: 'Galis.Complete.WS.PDTV-TVNETIL/Galis.S01.PDTV/Galis.S01E01.PDTV.avi', length: 3e8 },
    { path: 'Galis.Complete.WS.PDTV-TVNETIL/Galis.S03.WS.PDTV/Galis.S03E13.WS.PDTV.avi', length: 3e8 },
    { path: 'Galis.Complete.WS.PDTV-TVNETIL/Galis.S03.WS.PDTV/Galis.S03E13.WS.PDTV.srt', length: 3e4 },
    { path: 'Galis.Complete.WS.PDTV-TVNETIL/Galis.S01.PDTV/Galis.S01E01.PDTV.REPACK.avi', length: 3e8 },
  ],
};
const movie = {
  hebitsId: '1002',
  hash: '2222222222222222222222222222222222222222',
  progress: 0.43,
  name: 'Inception.2010.1080p.BluRay.DD+5.1.x264-playHD',
  files: [
    { path: 'Inception.2010.1080p/Inception.2010.1080p.mkv', length: 9e9 },
    { path: 'Inception.2010.1080p/Sample/sample.mkv', length: 5e7 },
  ],
};
const opts = { posterUrl: (e) => `p/${e.hebitsId}` };

test('libraryId keys on the infohash', () => {
  assert.equal(libraryId(galis), 'hebits:h:1111111111111111111111111111111111111111');
});

test('parseHebitsId reads a v1 infohash, with and without an episode', () => {
  const h = '1111111111111111111111111111111111111111';
  assert.deepEqual(parseHebitsId(`hebits:h:${h}`), { hash: h, season: undefined, episode: undefined });
  assert.deepEqual(parseHebitsId(`hebits:h:${h}:2:5`), { hash: h, season: 2, episode: 5 });
});

test('parseHebitsId reads a v2 infohash', () => {
  const h = 'a'.repeat(64);
  assert.equal(parseHebitsId(`hebits:h:${h}`).hash, h);
});

test('parseHebitsId is case-insensitive and rejects other id shapes', () => {
  assert.equal(parseHebitsId('hebits:h:' + 'A'.repeat(40)).hash, 'a'.repeat(40));
  assert.equal(parseHebitsId('hebits:1001'), null);
  assert.equal(parseHebitsId('hebits:find:Z2FsaXM'), null);
  assert.equal(parseHebitsId('tt3208182'), null);
  assert.equal(parseHebitsId('hebits:h:nothex'), null);
});

test('kind and de-duplicated, ordered episode list', () => {
  assert.equal(kindOf(galis), 'series');
  assert.equal(kindOf(movie), 'movie');
  assert.deepEqual(episodes(galis), [
    { season: 1, episode: 1 },
    { season: 1, episode: 2 },
    { season: 3, episode: 13 },
  ]);
});

test('every listed episode resolves to a playable file', () => {
  for (const ep of episodes(galis)) assert.ok(pickFile(galis.files, ep), `S${ep.season}E${ep.episode}`);
});

test('catalog metas and episode ids use the infohash', () => {
  const [meta] = catalogMetas([galis], 'series', { posterUrl: () => 'P' });
  assert.equal(meta.id, 'hebits:h:1111111111111111111111111111111111111111');
  const full = metaFor(galis, { posterUrl: () => 'P', extra: undefined });
  assert.match(full.videos[0].id, /^hebits:h:1{40}:\d+:\d+$/);
});

test('progress is read off the entry', () => {
  const [meta] = catalogMetas([movie], 'movie', { posterUrl: () => 'P' });
  assert.match(meta.description, /Downloading 43%/);
  const [seeding] = catalogMetas([galis], 'series', { posterUrl: () => 'P' });
  assert.match(seeding.description, /Ready at home/);
});

test('series meta has one video per episode with hebits ids', () => {
  const meta = metaFor(galis, { posterUrl: opts.posterUrl, extra: { description: 'Teen drama', background: 'bg' } });
  assert.equal(meta.type, 'series');
  assert.equal(meta.imdb_id, 'tt3208182');
  assert.equal(meta.background, 'bg');
  assert.match(meta.description, /Ready at home[\s\S]*Teen drama/);
  assert.deepEqual(meta.videos.map((v) => [v.id, v.season, v.episode]), [
    ['hebits:h:1111111111111111111111111111111111111111:1:1', 1, 1],
    ['hebits:h:1111111111111111111111111111111111111111:1:2', 1, 2],
    ['hebits:h:1111111111111111111111111111111111111111:3:13', 3, 13],
  ]);
  assert.ok(meta.videos.every((v) => Date.parse(v.released) < Date.now()));
  assert.equal(metaFor(movie, { posterUrl: opts.posterUrl }).videos, undefined);
});

test('search matches display and release names loosely', () => {
  const [m] = catalogMetas([galis], 'series', opts);
  assert.ok(matchesSearch(m, 'galis'));
  assert.ok(matchesSearch(m, 'GALIS complete'));
  assert.ok(!matchesSearch(m, 'thrones'));
  assert.ok(!matchesSearch(m, '  '));
});
