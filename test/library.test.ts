import { expect, test } from 'vitest';
import { catalogMetas, episodes, kindOf, type LibraryEntry, libraryId, matchesSearch, metaFor, parseHebitsId } from '../src/library';
import { pickFile } from '../src/parse';

const galis: LibraryEntry = {
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
const movie: LibraryEntry = {
  hash: '2222222222222222222222222222222222222222',
  progress: 0.43,
  name: 'Inception.2010.1080p.BluRay.DD+5.1.x264-playHD',
  files: [
    { path: 'Inception.2010.1080p/Inception.2010.1080p.mkv', length: 9e9 },
    { path: 'Inception.2010.1080p/Sample/sample.mkv', length: 5e7 },
  ],
};
const opts = { posterUrl: (e: LibraryEntry) => `p/${e.hash}` };

test('libraryId keys on the infohash', () => {
  expect(libraryId(galis)).toBe('hebits:h:1111111111111111111111111111111111111111');
});

test('parseHebitsId reads a v1 infohash, with and without an episode', () => {
  const h = '1111111111111111111111111111111111111111';
  expect(parseHebitsId(`hebits:h:${h}`)).toEqual({ hash: h, season: undefined, episode: undefined });
  expect(parseHebitsId(`hebits:h:${h}:2:5`)).toEqual({ hash: h, season: 2, episode: 5 });
});

test('parseHebitsId reads a v2 infohash', () => {
  const h = 'a'.repeat(64);
  expect(parseHebitsId(`hebits:h:${h}`)?.hash).toBe(h);
});

test('parseHebitsId is case-insensitive and rejects other id shapes', () => {
  expect(parseHebitsId(`hebits:h:${'A'.repeat(40)}`)?.hash).toBe('a'.repeat(40));
  expect(parseHebitsId('hebits:1001')).toBeNull();
  expect(parseHebitsId('hebits:find:Z2FsaXM')).toBeNull();
  expect(parseHebitsId('tt3208182')).toBeNull();
  expect(parseHebitsId('hebits:h:nothex')).toBeNull();
});

test('parseHebitsId returns null (not a throw) on a malformed % escape', () => {
  expect(parseHebitsId('hebits:h:%zz')).toBeNull();
  expect(parseHebitsId('%')).toBeNull();
});

test('kind and de-duplicated, ordered episode list', () => {
  expect(kindOf(galis)).toBe('series');
  expect(kindOf(movie)).toBe('movie');
  expect(episodes(galis)).toEqual([
    { season: 1, episode: 1 },
    { season: 1, episode: 2 },
    { season: 3, episode: 13 },
  ]);
});

test('every listed episode resolves to a playable file', () => {
  for (const ep of episodes(galis)) expect(pickFile(galis.files, ep), `S${ep.season}E${ep.episode}`).toBeTruthy();
});

test('catalog metas and episode ids use the infohash', () => {
  const [meta] = catalogMetas([galis], 'series', { posterUrl: () => 'P' });
  expect(meta?.id).toBe('hebits:h:1111111111111111111111111111111111111111');
  const full = metaFor(galis, { posterUrl: () => 'P' });
  expect(full.videos?.[0]?.id).toMatch(/^hebits:h:1{40}:\d+:\d+$/);
});

test('progress is read off the entry', () => {
  const [meta] = catalogMetas([movie], 'movie', { posterUrl: () => 'P' });
  expect(meta?.description).toMatch(/Downloading 43%/);
  const [seeding] = catalogMetas([galis], 'series', { posterUrl: () => 'P' });
  expect(seeding?.description).toMatch(/Ready at home/);
});

test('progress 0 is not swallowed as falsy', () => {
  const [meta] = catalogMetas([{ ...movie, progress: 0 }], 'movie', { posterUrl: () => 'P' });
  expect(meta?.description).toMatch(/Downloading 0%/);
});

test('progress undefined (file list fetch failed) shows no status line', () => {
  const [meta] = catalogMetas([{ ...movie, progress: undefined }], 'movie', { posterUrl: () => 'P' });
  expect(meta?.description).toBe(movie.name);
});

test('series meta has one video per episode with hebits ids', () => {
  const meta = metaFor(galis, { posterUrl: opts.posterUrl, extra: { description: 'Teen drama', background: 'bg' } });
  expect(meta.type).toBe('series');
  expect(meta.imdb_id).toBe('tt3208182');
  expect(meta.background).toBe('bg');
  expect(meta.description).toMatch(/Ready at home[\s\S]*Teen drama/);
  expect(meta.videos?.map((v) => [v.id, v.season, v.episode])).toEqual([
    ['hebits:h:1111111111111111111111111111111111111111:1:1', 1, 1],
    ['hebits:h:1111111111111111111111111111111111111111:1:2', 1, 2],
    ['hebits:h:1111111111111111111111111111111111111111:3:13', 3, 13],
  ]);
  expect(meta.videos?.every((v) => Date.parse(v.released) < Date.now())).toBe(true);
  expect(metaFor(movie, { posterUrl: opts.posterUrl }).videos).toBeUndefined();
});

test('search matches display and release names loosely', () => {
  const [m] = catalogMetas([galis], 'series', opts);
  expect(m && matchesSearch(m, 'galis')).toBe(true);
  expect(m && matchesSearch(m, 'GALIS complete')).toBe(true);
  expect(m && matchesSearch(m, 'thrones')).toBe(false);
  expect(m && matchesSearch(m, '  ')).toBe(false);
});
