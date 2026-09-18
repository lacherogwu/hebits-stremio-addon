import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHebitsId, kindOf, episodes, catalogMetas, metaFor, matchesSearch } from '../lib/library.js';
import { pickFile } from '../lib/parse.js';

const galis = {
  hebitsId: '1001',
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
  name: 'Inception.2010.1080p.BluRay.DD+5.1.x264-playHD',
  files: [
    { path: 'Inception.2010.1080p/Inception.2010.1080p.mkv', length: 9e9 },
    { path: 'Inception.2010.1080p/Sample/sample.mkv', length: 5e7 },
  ],
};
const opts = { progress: new Map([['1001', 0.37]]), posterUrl: (e) => `p/${e.hebitsId}` };

test('parseHebitsId', () => {
  assert.deepEqual(parseHebitsId('hebits:1001'), { hebitsId: '1001', season: undefined, episode: undefined });
  assert.deepEqual(parseHebitsId('hebits%3A1001%3A3%3A13'), { hebitsId: '1001', season: 3, episode: 13 });
  assert.equal(parseHebitsId('tt3208182:3:13'), null);
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

test('catalog rows per type', () => {
  const series = catalogMetas([movie, galis], 'series', opts);
  assert.deepEqual(series.map((m) => [m.id, m.name]), [['hebits:1001', 'Galis (SD)']]);
  assert.match(series[0].description, /Downloading 37%/);
  const movies = catalogMetas([movie, galis], 'movie', { ...opts, progress: new Map([['1002', 1]]) });
  assert.deepEqual(movies.map((m) => [m.id, m.name, m.poster]), [['hebits:1002', 'Inception (1080p)', 'p/1002']]);
  assert.match(movies[0].description, /Ready at home/);
});

test('series meta has one video per episode with hebits ids', () => {
  const meta = metaFor(galis, { progress: 0.37, posterUrl: opts.posterUrl, extra: { description: 'Teen drama', background: 'bg' } });
  assert.equal(meta.type, 'series');
  assert.equal(meta.imdb_id, 'tt3208182');
  assert.equal(meta.background, 'bg');
  assert.match(meta.description, /Downloading 37%[\s\S]*Teen drama/);
  assert.deepEqual(meta.videos.map((v) => [v.id, v.season, v.episode]), [
    ['hebits:1001:1:1', 1, 1],
    ['hebits:1001:1:2', 1, 2],
    ['hebits:1001:3:13', 3, 13],
  ]);
  assert.ok(meta.videos.every((v) => Date.parse(v.released) < Date.now()));
  assert.equal(metaFor(movie, { progress: 1, posterUrl: opts.posterUrl }).videos, undefined);
});

test('search matches display and release names loosely', () => {
  const [m] = catalogMetas([galis], 'series', opts);
  assert.ok(matchesSearch(m, 'galis'));
  assert.ok(matchesSearch(m, 'GALIS complete'));
  assert.ok(!matchesSearch(m, 'thrones'));
  assert.ok(!matchesSearch(m, '  '));
});
