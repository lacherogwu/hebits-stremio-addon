import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findId, parseFindId, kindOfItem, itemsFor, groupResults, episodesFor, findMeta } from '../lib/search.js';

const item = (hebitsId, title, extra = {}) => ({ hebitsId, title, categories: [5000], seeders: 1, files: 1, ...extra });
const results = [
  item('2001', 'Hasifa.S06E07.720p.WEBRip.x264-HebTV', { cover: 'https://img/h.jpg' }),
  item('2002', 'Hasifa.S06E06.720p.WEBRip.x264-HebTV', { seeders: 7 }),
  item('2003', 'Hasifa.S02E01.720p.WEBRip.x264-HebTV'),
  item('2004', 'Northern.Exposure.S06.1080p.BluRay.x264-REWARD', { imdb: 'tt0098878', files: 46, seeders: 16 }),
  item('2008', 'Inception.2010.1080p.BluRay.x264', { categories: [2000], imdb: 'tt1375666' }),
  item('2005', 'Some.Movie.2020.1080p.WEB-DL.x264', { categories: [2000] }),
  item('2006', 'Some.Album.2020.FLAC', { categories: [3000] }),
  item('2007', 'Big.Movie.2019.COMPLETE.BLURAY.AVC-X', { categories: [2000] }),
];
const posterUrl = (id) => `p/${id}`;

test('find ids round-trip, including Hebrew names', () => {
  for (const name of ['Hasifa', 'חשיפה לצפון', 'A: B / C']) {
    assert.deepEqual(parseFindId(findId(name)), { name, season: undefined, episode: undefined });
    assert.deepEqual(parseFindId(encodeURIComponent(findId(name, 6, 7))), { name, season: 6, episode: 7 });
  }
  assert.equal(parseFindId('hebits:1001'), null);
  assert.equal(parseFindId('tt123'), null);
});

test('kindOfItem uses the release name, then the category', () => {
  assert.equal(kindOfItem(results[0]), 'series');
  assert.equal(kindOfItem(results[4]), 'movie');
  assert.equal(kindOfItem(item('1', 'Documentary.Special.720p', { categories: [5040] })), 'series');
});

test('groupResults: one card per title; movies use their IMDb id, series never do', () => {
  const series = groupResults(results, 'series', { posterUrl });
  assert.deepEqual(
    series.map((m) => [m.id, m.name, m.poster]),
    [
      [findId('Northern Exposure'), 'Northern Exposure', undefined],
      [findId('Hasifa'), 'Hasifa', 'p/2001'],
    ],
  );
  assert.match(series[1].description, /3 uploads/);
  // music and full-disc images are left out
  assert.deepEqual(
    groupResults(results, 'movie', { posterUrl }).map((m) => [m.id, m.poster]),
    [
      ['tt1375666', 'https://images.metahub.space/poster/medium/tt1375666/img'],
      [findId('Some Movie'), undefined],
    ],
  );
});

test('itemsFor matches the card name loosely', () => {
  assert.deepEqual(itemsFor(results, 'hasifa', 'series').map((it) => it.hebitsId), ['2001', '2002', '2003']);
  assert.deepEqual(itemsFor(results, 'Hasifa', 'movie'), []);
});

test('episodesFor: episode uploads, known packs, estimated packs', () => {
  const eps = (list, filesOf, listed) => episodesFor(list, filesOf, listed).map((e) => `${e.season}x${e.episode}`);
  assert.deepEqual(eps(results.slice(0, 3)), ['2x1', '6x6', '6x7']);
  const pack = item('3001', 'Show.S01.720p.WEB', { files: 3 });
  assert.deepEqual(eps([pack]), ['1x1', '1x2', '1x3']);
  const files = [{ path: 'Show.S01/Show.S01E04.mkv', length: 1 }, { path: 'Show.S01/Show.S01E05.mkv', length: 1 }];
  assert.deepEqual(eps([pack], (id) => (id === '3001' ? files : undefined)), ['1x4', '1x5']);
  const listed = [{ season: 1, episode: 1 }, { season: 1, episode: 2 }, { season: 2, episode: 1 }];
  assert.deepEqual(eps([pack], undefined, listed), ['1x1', '1x2']);
});

test('findMeta lists episodes with find ids', () => {
  const meta = findMeta('Hasifa', 'series', results.slice(0, 3), { posterUrl, filesOf: () => undefined });
  assert.equal(meta.id, findId('Hasifa'));
  assert.equal(meta.poster, 'p/2001');
  assert.deepEqual(meta.videos.map((v) => v.id), [findId('Hasifa', 2, 1), findId('Hasifa', 6, 6), findId('Hasifa', 6, 7)]);
  assert.match(meta.description, /^Seasons 2, 6 · 3 episodes · 3 uploads on Hebits/);
  assert.equal(meta.videos[0].released, '2000-01-01T00:00:00.000Z');
  const dated = findMeta('Hasifa', 'series', [{ ...results[0], pubDate: Date.UTC(2026, 8, 17) }, { ...results[0], hebitsId: '9', pubDate: Date.UTC(2026, 8, 10) }], { posterUrl });
  assert.equal(dated.videos.length, 1);
  assert.equal(dated.videos[0].released, '2026-09-10T00:00:00.000Z');
  assert.equal(dated.videos[0].overview, '🌱 1 seeds · On Hebits: Hasifa.S06E07.720p.WEBRip.x264-HebTV');
  const dead = findMeta('Hasifa', 'series', [{ ...results[0], seeders: 0 }], { posterUrl });
  assert.equal(dead.videos[0].title, 'Episode 7 💀');
  assert.match(dead.videos[0].overview, /^💀 No seeders/);
  const ne = findMeta('Northern Exposure', 'series', [results[3]], {
    posterUrl,
    extra: { name: 'Northern Exposure', description: 'Alaska.', poster: 'cm.jpg', background: 'bg.jpg' },
  });
  assert.equal(ne.imdb_id, 'tt0098878');
  assert.equal(ne.poster, 'cm.jpg');
  assert.equal(ne.background, 'bg.jpg');
  assert.match(ne.description, /^Season 6 · 40 episodes · 1 upload on Hebits\n\nAlaska\./);
  assert.equal(findMeta('Some Movie', 'movie', [results[4]], { posterUrl }).videos, undefined);
});
