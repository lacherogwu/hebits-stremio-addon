import type { HebitsTorrent } from 'hebits-client';
import { expect, test } from 'vitest';
import { CoverCache } from '../src/covers';
import { hebitsKey } from '../src/hebits';
import type { Episode, FileEntry } from '../src/parse';
import { episodesFor, findId, findMeta, groupResults, itemsFor, kindOfItem, parseFindId } from '../src/search';

// Every upload in this fixture set shares one uploadedAt so plain "did an episode get an
// id" assertions don't accidentally also pin a date. The dedicated date test below gives
// items their own uploadedAt to check the conversion itself.
const DEFAULT_UPLOADED_AT = new Date('2026-01-05T00:00:00.000Z');

// Fills in the HebitsTorrent fields these tests don't care about, so each fixture only
// states what differs. categoryId defaults to 2 (TV), matching the Torznab fixture's old
// default category [5000] (a TV subcategory).
const item = (id: number, name: string, extra: Partial<HebitsTorrent> = {}): HebitsTorrent => ({
  id,
  groupId: id,
  name,
  groupName: name,
  categoryId: 2,
  tags: [],
  size: 1,
  fileCount: 1,
  seeders: 1,
  leechers: 0,
  snatches: 0,
  uploadedAt: DEFAULT_UPLOADED_AT,
  downloadFactor: 1,
  uploadFactor: 1,
  canUseToken: false,
  hasSnatched: false,
  ...extra,
});

// Named (not indexed) so no fixture lookup needs a non-null assertion.
const hasifa07 = item(2001, 'Hasifa.S06E07.720p.WEBRip.x264-HebTV', { cover: 'https://img/h.jpg' });
const hasifa06 = item(2002, 'Hasifa.S06E06.720p.WEBRip.x264-HebTV', { seeders: 7 });
const hasifa01 = item(2003, 'Hasifa.S02E01.720p.WEBRip.x264-HebTV');
const northernExposure = item(2004, 'Northern.Exposure.S06.1080p.BluRay.x264-REWARD', { imdb: 'tt0098878', fileCount: 46, seeders: 16 });
const inception = item(2008, 'Inception.2010.1080p.BluRay.x264', { categoryId: 1, imdb: 'tt1375666' });
const someMovie = item(2005, 'Some.Movie.2020.1080p.WEB-DL.x264', { categoryId: 1 });
const someAlbum = item(2006, 'Some.Album.2020.FLAC', { categoryId: 3 });
const bigMovie = item(2007, 'Big.Movie.2019.COMPLETE.BLURAY.AVC-X', { categoryId: 1 });
const results = [hasifa07, hasifa06, hasifa01, northernExposure, inception, someMovie, someAlbum, bigMovie];
const posterUrl = (id: number) => `p/${id}`;

test('find ids round-trip, including Hebrew names', () => {
  for (const name of ['Hasifa', 'חשיפה לצפון', 'A: B / C']) {
    expect(parseFindId(findId(name))).toEqual({ name, season: undefined, episode: undefined });
    expect(parseFindId(encodeURIComponent(findId(name, 6, 7)))).toEqual({ name, season: 6, episode: 7 });
  }
  expect(parseFindId('hebits:1001')).toBeNull();
  expect(parseFindId('tt123')).toBeNull();
});

test('parseFindId returns null (not a throw) on a malformed % escape', () => {
  expect(parseFindId('hebits:find:%zz')).toBeNull();
  expect(parseFindId('%')).toBeNull();
});

test('kindOfItem uses the release name, then the category', () => {
  expect(kindOfItem(hasifa07)).toBe('series');
  expect(kindOfItem(inception)).toBe('movie');
  expect(kindOfItem(item(1, 'Documentary.Special.720p', { categoryId: 2 }))).toBe('series');
});

test('groupResults: one card per title; movies use their IMDb id, series never do', () => {
  const series = groupResults(results, 'series', { posterUrl });
  expect(series.map((m) => [m.id, m.name, m.poster])).toEqual([
    [findId('Northern Exposure'), 'Northern Exposure', undefined],
    [findId('Hasifa'), 'Hasifa', 'p/2001'],
  ]);
  expect(series[1]?.description).toMatch(/3 uploads/);
  // music and full-disc images are left out
  expect(groupResults(results, 'movie', { posterUrl }).map((m) => [m.id, m.poster])).toEqual([
    ['tt1375666', 'https://images.metahub.space/poster/medium/tt1375666/img'],
    [findId('Some Movie'), undefined],
  ]);
});

test('itemsFor matches the card name loosely', () => {
  expect(itemsFor(results, 'hasifa', 'series').map((it) => it.id)).toEqual([2001, 2002, 2003]);
  expect(itemsFor(results, 'Hasifa', 'movie')).toEqual([]);
});

test('episodesFor: episode uploads, known packs, estimated packs', () => {
  const eps = (list: HebitsTorrent[], filesOf?: (id: number) => FileEntry[] | undefined, listed?: Episode[]) =>
    episodesFor(list, filesOf, listed).map((e) => `${e.season}x${e.episode}`);
  expect(eps([hasifa07, hasifa06, hasifa01])).toEqual(['2x1', '6x6', '6x7']);
  const pack = item(3001, 'Show.S01.720p.WEB', { fileCount: 3 });
  expect(eps([pack])).toEqual(['1x1', '1x2', '1x3']);
  const files: FileEntry[] = [
    { path: 'Show.S01/Show.S01E04.mkv', length: 1 },
    { path: 'Show.S01/Show.S01E05.mkv', length: 1 },
  ];
  expect(eps([pack], (id) => (id === 3001 ? files : undefined))).toEqual(['1x4', '1x5']);
  const listed: Episode[] = [
    { season: 1, episode: 1 },
    { season: 1, episode: 2 },
    { season: 2, episode: 1 },
  ];
  expect(eps([pack], undefined, listed)).toEqual(['1x1', '1x2']);
});

test('findMeta lists episodes with find ids', () => {
  const meta = findMeta('Hasifa', 'series', [hasifa07, hasifa06, hasifa01], { posterUrl, filesOf: () => undefined });
  expect(meta.id).toBe(findId('Hasifa'));
  expect(meta.poster).toBe('p/2001');
  expect(meta.videos?.map((v) => v.id)).toEqual([findId('Hasifa', 2, 1), findId('Hasifa', 6, 6), findId('Hasifa', 6, 7)]);
  expect(meta.description).toMatch(/^Seasons 2, 6 · 3 episodes · 3 uploads on Hebits/);
  // Every fixture above shares DEFAULT_UPLOADED_AT, so each episode's "released" is that
  // real 2026 date - not the Date.UTC(2000, 0, 1) fallback (HebitsTorrent.uploadedAt is
  // mandatory, unlike Torznab's optional pubDate, so the fallback path is unreachable
  // from real data; see the dated/dead sub-tests below for the fallback itself).
  expect(meta.videos?.[0]?.released).toBe(DEFAULT_UPLOADED_AT.toISOString());
  const dated = findMeta(
    'Hasifa',
    'series',
    [
      { ...hasifa07, uploadedAt: new Date(Date.UTC(2026, 8, 17)) },
      { ...hasifa07, id: 9, uploadedAt: new Date(Date.UTC(2026, 8, 10)) },
    ],
    { posterUrl },
  );
  expect(dated.videos?.length).toBe(1);
  // The EARLIER of the two uploads wins - proves this is a min over real millisecond
  // values, not just "whichever upload happened to be seen last".
  expect(dated.videos?.[0]?.released).toBe('2026-09-10T00:00:00.000Z');
  expect(dated.videos?.[0]?.overview).toBe('🌱 1 seeds · On Hebits: Hasifa.S06E07.720p.WEBRip.x264-HebTV');
  const dead = findMeta('Hasifa', 'series', [{ ...hasifa07, seeders: 0 }], { posterUrl });
  expect(dead.videos?.[0]?.title).toBe('Episode 7 💀');
  expect(dead.videos?.[0]?.overview).toMatch(/^💀 No seeders/);
  const ne = findMeta('Northern Exposure', 'series', [northernExposure], {
    posterUrl,
    extra: { name: 'Northern Exposure', description: 'Alaska.', poster: 'cm.jpg', background: 'bg.jpg' },
  });
  expect(ne.imdb_id).toBe('tt0098878');
  expect(ne.poster).toBe('cm.jpg');
  expect(ne.background).toBe('bg.jpg');
  expect(ne.description).toMatch(/^Season 6 · 40 episodes · 1 upload on Hebits\n\nAlaska\./);
  expect(findMeta('Some Movie', 'movie', [inception], { posterUrl }).videos).toBeUndefined();
});

// Unit hazard (see src/hebits.ts's uploadedAtMs): a Date compared or subtracted with the
// wrong unit doesn't throw, it just lands in the wrong era. Pin a 2026 upload landing in
// 2026, not 1970 (ms treated as seconds) and not centuries out (seconds treated as ms).
test('an episode released date reflects its real upload year, not a unit-conversion accident', () => {
  const upload = item(4001, 'Some.Show.S01E01.720p.WEB', { uploadedAt: new Date('2026-03-02T10:00:00.000Z') });
  const meta = findMeta('Some Show', 'series', [upload], { posterUrl });
  const releasedYear = new Date(meta.videos?.[0]?.released ?? '').getUTCFullYear();
  expect(releasedYear).toBe(2026);
});

// Cover cache: groupResults and itemsFor are the two functions that see raw tracker
// results directly (per lib/addon.js's wiring: groupResults(results, ...) for "search
// all", itemsFor(list, name, type) collecting the per-show item map) - each is a place a
// poster route lookup later needs a hit.
test('groupResults remembers every seen item cover, matched or not', () => {
  const covers = new CoverCache();
  groupResults(results, 'series', { posterUrl, covers });
  // Positive control: the one item with a cover really is remembered under its id.
  expect(covers.get(hebitsKey(hasifa07))).toBe('https://img/h.jpg');
  // Also remembered for an item excluded from the series catalogue entirely (movie
  // category) - proves this runs over every raw result, not just the returned cards.
  expect(covers.get(hebitsKey(someAlbum))).toBeUndefined(); // no cover on this one, and that's expected
  expect(covers.get(hebitsKey(hasifa01))).toBeUndefined(); // no cover on this one either - real miss, not a bug
  const withCover = item(9001, 'Some.Show.S01E01.720p.WEB', { cover: 'https://img/9001.jpg', categoryId: 3 });
  groupResults([withCover], 'series', { posterUrl, covers }); // wrong type, excluded from the card list
  expect(covers.get(hebitsKey(withCover))).toBe('https://img/9001.jpg');
});

test('itemsFor remembers covers for the raw list it is given', () => {
  const covers = new CoverCache();
  itemsFor(results, 'hasifa', 'series', covers);
  expect(covers.get(hebitsKey(hasifa07))).toBe('https://img/h.jpg');
});
