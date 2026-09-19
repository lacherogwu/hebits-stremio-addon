import type { BrowseOptions, HebitsTorrent } from 'hebits-client';
import { expect, test } from 'vitest';
import { type AddonDeps, type AddonHome, type AddonQBit, type AddonStore, makeAddon, type PosterResponse } from '../src/addon';
import { CoverCache } from '../src/covers';
import type { HomeEntry } from '../src/home';
import { parseHebitsId } from '../src/library';
import { parseFindId } from '../src/search';
import type { TorrentEntry } from '../src/store';

const BASE = 'http://tv.local/tok';
const GB = 1024 ** 3;

// --- fixtures ------------------------------------------------------------------------

// Fills in the HebitsTorrent fields a given test doesn't care about, so each fixture only
// states what differs. categoryId 2 is the tracker's own TV category (see hebits.ts).
const torrent = (id: number, name: string, extra: Partial<HebitsTorrent> = {}): HebitsTorrent => ({
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
  uploadedAt: new Date('2026-02-03T00:00:00.000Z'),
  downloadFactor: 1,
  uploadFactor: 1,
  canUseToken: false,
  hasSnatched: false,
  ...extra,
});

const entry = (hash: string, name: string, extra: Partial<HomeEntry> = {}): HomeEntry => ({
  hash,
  name,
  size: 1,
  progress: 1,
  state: 'seeding',
  category: 'watch',
  pieceLength: 16384,
  files: [],
  ...extra,
});

// The tracker's answer for "Show Name", season 1 episode 2.
const s01e02_1080 = torrent(101, 'Show.Name.S01E02.1080p.WEB-DL.x264-GRP', {
  size: 2 * GB,
  seeders: 5,
  leechers: 3,
  imdb: 'tt123',
  cover: 'https://img.hebits.net/101.png',
});
const s01e02_720 = torrent(102, 'Show.Name.S01E02.720p.WEB-DL.x264-GRP', { size: GB, seeders: 0, leechers: 0 });
const s01pack = torrent(103, 'Show.Name.S01.1080p.WEB-DL.x264-GRP', { size: 9 * GB, seeders: 9, leechers: 1, fileCount: 10 });
const otherEpisode = torrent(104, 'Show.Name.S02E01.1080p.WEB-DL.x264-GRP', { seeders: 4 });
const otherTitle = torrent(105, 'Show.Name.S01E02.1080p.WEB-DL.x264-OTHER', { seeders: 8, imdb: 'tt999' });
const TRACKER = [s01e02_1080, s01e02_720, s01pack, otherEpisode, otherTitle];

// The home library. `unknownTorrent` is one the addon did not add: no tags, so neither a
// Hebits id nor an IMDb id, and nothing else can supply them.
const packAtHome = entry('a'.repeat(40), 'Show.Name.S01.1080p.WEB-DL.x264-GRP', {
  hebitsId: '103',
  imdb: 'tt123',
  size: 9 * GB,
  progress: 1,
  files: [
    { path: 'Show.Name.S01E01.1080p.mkv', length: 1 },
    { path: 'Show.Name.S01E02.1080p.mkv', length: 1 },
  ],
});
const oldUpload = entry('b'.repeat(40), 'Show.Name.S01E02.2160p.WEB-DL-OLD', {
  hebitsId: '999',
  imdb: 'tt123',
  size: 3 * GB,
  progress: 0.5,
  state: 'downloading',
  files: [{ path: 'Show.Name.S01E02.2160p.mkv', length: 1 }],
});
const movieAtHome = entry('c'.repeat(40), 'Some.Movie.2020.1080p.WEB-DL.x264', {
  hebitsId: '777',
  imdb: 'tt777',
  progress: 0.25,
  state: 'downloading',
  files: [{ path: 'Some.Movie.2020.1080p.mkv', length: 1 }],
});
const unknownTorrent = entry('d'.repeat(40), 'Unknown.Israeli.Show.S02E03.WEBRip', {
  files: [{ path: 'Unknown.Israeli.Show.S02E03.mkv', length: 1 }],
});

// --- harness -------------------------------------------------------------------------

// Records what was written to the poster route. PosterResponse is the slice of node's
// ServerResponse that route uses, so this needs no `as any` to stand in for one.
class RecordingResponse implements PosterResponse {
  status = 0;
  headers: Record<string, string> = {};
  body: Buffer | undefined;
  ended = false;
  writeHead(status: number, headers: Record<string, string> = {}): void {
    this.status = status;
    this.headers = headers;
  }
  end(chunk?: Buffer): void {
    this.ended = true;
    this.body = chunk;
  }
}

interface HarnessOptions {
  tracker?: HebitsTorrent[] | (() => never);
  entries?: HomeEntry[];
  torrents?: Record<string, TorrentEntry>;
  daily?: { used: number; limit: number };
  responses?: Record<string, () => Response>;
  now?: () => number;
}

function harness({
  tracker = TRACKER,
  entries = [],
  torrents = {},
  daily = { used: 2, limit: 10 },
  responses = {},
  now,
}: HarnessOptions = {}) {
  const browsed: BrowseOptions[] = [];
  const fetched: string[] = [];
  const logins: { ok: boolean; error?: string }[] = [];
  const covers = new CoverCache();

  const store: AddonStore = {
    data: { grabs: [], torrents },
    torrent: (id) => torrents[id],
    save() {},
    limitToday: () => 10,
  };
  const qbit: AddonQBit = {
    async torrent() {
      return undefined;
    },
    // Warm-up looks a torrent's files up here; an empty list means it finds nothing to
    // focus on, so no test depends on a fire-and-forget call having finished.
    async files() {
      return [];
    },
    async setFilePriority() {},
    async setSequential() {},
    async setFirstLastPiecePrio() {},
    async addTags() {},
    async freeSpace() {
      return 500 * GB;
    },
  };
  const home: AddonHome = {
    async entries() {
      return entries;
    },
    async byHash(hash) {
      return entries.find((e) => e.hash === hash);
    },
  };
  const deps: AddonDeps = {
    cfg: { minFreeGB: 20, dailyLimit: 10 },
    store,
    hebits: {
      async browse(options = {}) {
        browsed.push(options);
        if (typeof tracker === 'function') return tracker();
        return tracker;
      },
    },
    qbit,
    home,
    covers,
    daily: async () => daily,
    version: '2.0.0',
    log() {},
    noteLogin(ok, error) {
      logins.push({ ok, error });
    },
    ...(now && { now }),
    async fetchImpl(input) {
      const url = String(input);
      fetched.push(url);
      const make = responses[url];
      return make ? make() : new Response('nope', { status: 404 });
    },
  };
  return { addon: makeAddon(deps), browsed, fetched, logins, covers };
}

// Named element access, so no fixture lookup needs a non-null assertion.
function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an item at ${index}, got ${items.length}`);
  return item;
}

// --- manifest ------------------------------------------------------------------------

// The manifest is a contract with the TV: an addon whose manifest drifts can stop being
// loadable, so this is a whole-object comparison against a literal, not a spot check.
test('the manifest is byte-for-byte what the TV already installed', () => {
  const { addon } = harness();
  expect(addon.manifest).toEqual({
    id: 'net.hebits.home',
    version: '2.0.0',
    name: 'Hebits (Home)',
    description: 'Hebits, no debrid: downloads with qBittorrent, seeds forever, streams over the home network.',
    logo: 'https://hebits.net/favicon.ico',
    resources: [
      'catalog',
      { name: 'meta', types: ['movie', 'series'], idPrefixes: ['hebits:'] },
      { name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt', 'hebits:'] },
    ],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'hebits:'],
    catalogs: [
      { type: 'series', id: 'hebits-home', name: '🏠 Hebits at home', showInHome: true, extra: [{ name: 'search' }] },
      { type: 'movie', id: 'hebits-home-movies', name: '🏠 Hebits movies at home', showInHome: true, extra: [{ name: 'search' }] },
      { type: 'series', id: 'hebits-search', name: '🔎 Hebits series', extra: [{ name: 'search', isRequired: true }] },
      { type: 'movie', id: 'hebits-search-movies', name: '🔎 Hebits movies', extra: [{ name: 'search', isRequired: true }] },
    ],
    behaviorHints: { configurable: false },
  });
});

// --- the stream list -----------------------------------------------------------------

test('a series stream list has the expected ids, order, status labels and play urls', async () => {
  const { addon, browsed } = harness({ entries: [packAtHome, oldUpload] });

  const streams = await addon.handleStream('series', 'tt123:1:2', BASE);

  // The pack is at home and complete, then the half-downloaded old upload, then the
  // grabbable 1080p, then the seederless one. Nothing for S02E01, nothing for tt999.
  expect(streams.map((s) => s.url)).toEqual([
    `${BASE}/play/103/1/2?imdb=tt123&type=series`,
    `${BASE}/play/999/1/2?imdb=tt123&type=series`,
    `${BASE}/play/101/1/2?imdb=tt123&type=series`,
    `${BASE}/play/102/1/2?imdb=tt123&type=series`,
  ]);
  expect(streams.map((s) => s.name)).toEqual(['🏠 Hebits\n1080p', '🏠 Hebits\n4K', '🏠 Hebits\n1080p', '🏠 Hebits\n720p']);

  // The grabbable one in full: the leecher count is the tracker's `leechers`, not
  // `peers - seeders` (which reads 0 for every healthy torrent), and the allowance line
  // counts what is left today, not the limit.
  expect(at(streams, 2).description).toBe(
    [
      '🎬 Show.Name.S01E02.1080p.WEB-DL.x264-GRP',
      '💾 2.0 GB · 🌱 5 seeds · ⬇️ 3 downloading',
      '⚠️ Counts toward ratio',
      '🎟️ Uses 1 of 8 downloads left today',
    ].join('\n'),
  );
  expect(at(streams, 0).description).toContain('▶️ Ready at home');
  expect(at(streams, 0).description).toContain('📦 Season 1 pack (10 files) · whole pack downloads');
  expect(at(streams, 1).description).toContain('⏬ Downloading 50%');
  expect(at(streams, 3).description).toContain("💀 No seeders on Hebits right now, can't download");

  // The tracker was asked by IMDb id, once for the title and once scoped to the season.
  // That it went through `browse` rather than the `search` alias is not asserted here
  // because it cannot be otherwise: AddonHebits declares no `search`, so the alias is
  // unreachable from this module and from everything it wires up.
  expect(browsed).toEqual([{ imdb: 'tt123' }, { imdb: 'tt123', season: 1 }]);
});

test('a title already at home survives a failed search, with a readable notice row', async () => {
  const { addon, logins } = harness({
    entries: [oldUpload],
    tracker: () => {
      throw new Error('login expired');
    },
  });

  const streams = await addon.handleStream('series', 'tt123:1:2', BASE);

  expect(streams.map((s) => s.url)).toEqual([`${BASE}/play/999/1/2?imdb=tt123&type=series`, `${BASE}/play/error/0/0`]);
  expect(at(streams, 1).description).toContain('login expired');
  expect(logins).toEqual([{ ok: false, error: 'Hebits search: login expired' }]);
});

test('a malformed or non-IMDb stream id is an empty list, not a throw or a search', async () => {
  const { addon, browsed } = harness({ entries: [packAtHome] });
  expect(await addon.handleStream('series', '%', BASE)).toEqual([]);
  expect(await addon.handleStream('series', 'tt123', BASE)).toEqual([]); // series needs season+episode
  expect(await addon.handleStream('movie', 'hebits:h:abc', BASE)).toEqual([]);
  expect(browsed).toEqual([]);
});

// --- the catalogue rows --------------------------------------------------------------

test('the catalogue rows build from qBittorrent, including a torrent the addon did not add', async () => {
  const { addon } = harness({ entries: [packAtHome, movieAtHome, unknownTorrent] });

  const series = await addon.handleCatalog('series', undefined, BASE);
  const movies = await addon.handleCatalog('movie', undefined, BASE);

  expect(series.map((m) => m.id)).toEqual([`hebits:h:${'a'.repeat(40)}`, `hebits:h:${'d'.repeat(40)}`]);
  expect(series.map((m) => m.name)).toEqual(['Show Name (1080p)', 'Unknown Israeli Show']);
  expect(at(series, 0).poster).toBe(`${BASE}/poster/${'a'.repeat(40)}`);
  // The untagged torrent is listed with its own id and status, but gets NO poster url:
  // the poster route has neither a Hebits id nor an IMDb id to answer with, and a url
  // that is certain to 404 is worse than no url at all.
  expect(at(series, 1).poster).toBeUndefined();
  expect(at(series, 1).description).toBe('Unknown.Israeli.Show.S02E03.WEBRip\n▶️ Ready at home');

  expect(movies.map((m) => m.id)).toEqual([`hebits:h:${'c'.repeat(40)}`]);
  expect(at(movies, 0).description).toContain('⏬ Downloading 25%');
});

test('a catalogue search matches on the display name and the release name', async () => {
  const { addon } = harness({ entries: [packAtHome, unknownTorrent] });
  const hit = await addon.handleCatalog('series', 'search=israeli', BASE);
  expect(hit.map((m) => m.id)).toEqual([`hebits:h:${'d'.repeat(40)}`]);
  expect(await addon.handleCatalog('series', 'search=nothinglikethis', BASE)).toEqual([]);
});

test('the home library stream plays the local torrent by infohash, never a tracker id', async () => {
  const { addon, browsed } = harness({ entries: [packAtHome] });
  const streams = await addon.handleLibraryStream('series', `hebits:h:${'a'.repeat(40)}:1:2`, BASE);
  expect(streams.map((s) => s.url)).toEqual([`${BASE}/play/h/${'a'.repeat(40)}/1/2`]);
  expect(browsed).toEqual([]);
  expect(await addon.handleLibraryStream('series', 'hebits:h:nope', BASE)).toEqual([]);
});

// --- ids ------------------------------------------------------------------------------

test('every id this module emits parses back to the same parts', async () => {
  const { addon } = harness({
    entries: [packAtHome],
    // A season pack's episode list comes from the store's file list for that Hebits id.
    // The store is keyed by STRINGS and HebitsTorrent.id is a number, so this also pins
    // the conversion: without it the lookup misses and the episodes are guessed from
    // fileCount (ten of them) instead of read from the two files below.
    torrents: {
      '103': {
        files: [
          { path: 'Show.Name.S01E01.1080p.mkv', length: 1, offset: 0 },
          { path: 'Show.Name.S01E02.1080p.mkv', length: 1, offset: 1 },
        ],
      },
    },
  });

  const rows = await addon.handleCatalog('series', undefined, BASE);
  const rowId = at(rows, 0).id;
  expect(parseHebitsId(rowId)).toEqual({ hash: 'a'.repeat(40), season: undefined, episode: undefined });

  const meta = await addon.handleMeta(rowId, BASE);
  const videos = meta?.videos ?? [];
  expect(videos.map((v) => v.id)).toEqual([`${rowId}:1:1`, `${rowId}:1:2`]);
  for (const v of videos) expect(parseHebitsId(v.id)).toEqual({ hash: 'a'.repeat(40), season: v.season, episode: v.episode });

  const found = await addon.handleFindMeta('series', { name: 'Show Name' }, BASE);
  expect(parseFindId(found?.id ?? '')).toEqual({ name: 'Show Name', season: undefined, episode: undefined });
  const foundVideos = found?.videos ?? [];
  // S01E01/S01E02 from the pack's two files (NOT ten guessed from its fileCount), plus
  // the S02E01 upload, which belongs to the same card even though nothing has it at home.
  expect(foundVideos.map((v) => `${v.season}:${v.episode}`)).toEqual(['1:1', '1:2', '2:1']);
  for (const v of foundVideos) expect(parseFindId(v.id)).toEqual({ name: 'Show Name', season: v.season, episode: v.episode });

  // ...and the ids survive a round trip through a URL, the way the TV sends them back.
  for (const id of [rowId, at(videos, 1).id, at(foundVideos, 1).id]) {
    const encoded = encodeURIComponent(id);
    expect(parseHebitsId(encoded) ?? parseFindId(encoded)).toEqual(parseHebitsId(id) ?? parseFindId(id));
  }
});

// --- the poster route -----------------------------------------------------------------

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('a remembered cover is served as the poster for its Hebits id', async () => {
  const { addon, fetched } = harness({
    responses: { 'https://img.hebits.net/101.png': () => new Response(PNG, { headers: { 'content-type': 'image/png' } }) },
  });

  // Seeing the title in a search is what remembers its cover.
  await addon.handleSearchCatalog('series', 'search=show+name', BASE);
  const res = new RecordingResponse();
  await addon.handlePoster(res, '101');

  expect(res.status).toBe(200);
  expect(res.headers).toEqual({ 'Content-Type': 'image/png', 'Cache-Control': 'max-age=604800' });
  expect(res.body).toEqual(PNG);
  expect(fetched).toEqual(['https://img.hebits.net/101.png']);
});

test('a cover cache miss is a 404 with no poster, not a throw and not another title cover', async () => {
  const { addon, fetched } = harness({ responses: { 'https://img.hebits.net/101.png': () => new Response(PNG) } });

  // 101's cover is remembered; 102 was in the same result set and has none.
  await addon.handleSearchCatalog('series', 'search=show+name', BASE);
  const res = new RecordingResponse();
  await addon.handlePoster(res, '102');

  expect(res.status).toBe(404);
  expect(res.body).toBeUndefined();
  expect(res.ended).toBe(true);
  // Nothing is fetched to fill a miss, and no other title's cover stands in.
  expect(fetched).toEqual([]);
});

test('a cover cache miss for a home torrent falls back to that torrents own IMDb poster', async () => {
  const { addon, fetched } = harness({ entries: [movieAtHome] });
  const res = new RecordingResponse();
  await addon.handlePoster(res, 'C'.repeat(40)); // the TV may send the hash upper-cased
  expect(res.status).toBe(302);
  expect(res.headers).toEqual({ Location: 'https://images.metahub.space/poster/medium/tt777/img' });
  expect(fetched).toEqual([]);

  // ...and a home torrent with no identity at all gets no poster rather than a stranger's.
  const missing = new RecordingResponse();
  await addon.handlePoster(missing, 'd'.repeat(40));
  expect(missing.status).toBe(404);
});

test('a cover that no longer loads is a 404, not a half-written response', async () => {
  const { addon } = harness({
    responses: { 'https://img.hebits.net/101.png': () => new Response('gone', { status: 410 }) },
  });
  await addon.handleSearchCatalog('series', 'search=show+name', BASE);
  const res = new RecordingResponse();
  await addon.handlePoster(res, '101');
  expect(res.status).toBe(404);
  expect(res.body).toBeUndefined();
});

// A torrent nobody tagged, whose only route to a poster is the release-name lookup
// IdentityResolver runs: no IMDb id anywhere, so the metahub redirect cannot mask a
// missing cover.
const untagged = entry('e'.repeat(40), 'Nobody.Tagged.This.S01E01.1080p.WEBRip', {
  files: [{ path: 'Nobody.Tagged.This.S01E01.mkv', length: 1 }],
});
const identified = torrent(707, 'Nobody.Tagged.This.S01E01.1080p.WEBRip', { cover: 'https://img.hebits.net/707.png' });

test('a torrent identified by release-name search serves that search results cover', async () => {
  const { addon, fetched } = harness({
    entries: [untagged],
    tracker: [identified],
    responses: { 'https://img.hebits.net/707.png': () => new Response(PNG, { headers: { 'content-type': 'image/png' } }) },
  });

  // Loading the catalogue is what runs the lookup; it writes the Hebits id back as a tag,
  // which is how the poster route finds it again (the fake shares the entry object, the
  // way qBittorrent would hand the tags back on the next read).
  const rows = await addon.handleCatalog('series', undefined, BASE);
  expect(at(rows, 0).poster).toBe(`${BASE}/poster/${'e'.repeat(40)}`);

  const res = new RecordingResponse();
  await addon.handlePoster(res, 'e'.repeat(40));

  // 200 can only have come from the remembered cover: this entry has no IMDb id, so there
  // is no metahub redirect to fall back on.
  expect(res.status).toBe(200);
  expect(res.headers['Content-Type']).toBe('image/png');
  expect(res.body).toEqual(PNG);
  expect(fetched).toContain('https://img.hebits.net/707.png');
});

// --- search all of Hebits --------------------------------------------------------------

test('the search catalogue groups uploads into one card per title, with its own poster url', async () => {
  const { addon, browsed } = harness();
  const metas = await addon.handleSearchCatalog('series', 'search=show+name', BASE);

  expect(browsed).toEqual([{ query: 'show name' }]);
  expect(metas.map((m) => m.name)).toEqual(['Show Name']);
  expect(at(metas, 0).poster).toBe(`${BASE}/poster/101`);
  expect(at(metas, 0).description).toContain('On Hebits: 5 uploads');
  expect(await addon.handleSearchCatalog('series', '', BASE)).toEqual([]);
});

// --- what the tracker last said -------------------------------------------------------

test('what the tracker said about a torrent expires, so a stale "no seeders" cannot refuse a grab forever', async () => {
  let clock = 1_700_000_000_000;
  const { addon } = harness({ now: () => clock });
  await addon.handleSearchCatalog('series', 'search=show+name', BASE);

  // play.ts's no-seeders guard reads this: 102 has none, so it refuses to spend a grab.
  expect(addon.cachedItem('102')?.seeders).toBe(0);
  expect(addon.cachedItem('101')?.size).toBe(2 * GB);

  // One millisecond short of ten minutes it is still the answer...
  clock += 10 * 60 * 1000 - 1;
  expect(addon.cachedItem('102')?.seeders).toBe(0);

  // ...and at ten minutes it is gone, so the guard stops biting and the grab may proceed.
  clock += 1;
  expect(addon.cachedItem('102')).toBeUndefined();
  expect(addon.cachedItem('101')).toBeUndefined();
});
