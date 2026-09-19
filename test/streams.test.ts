import { expect, test } from 'vitest';
import { type BuildStreamsInput, buildStreams, type LocalStatus, type StreamItem } from '../src/streams';

const GB = 1024 ** 3;
const item = (hebitsId: string, title: string, extra: Partial<StreamItem> = {}): StreamItem => ({
  hebitsId,
  title,
  size: 10 * GB,
  files: 10,
  seeders: 5,
  peers: 5,
  downloadFactor: 1,
  uploadFactor: 1,
  ...extra,
});
const base: Omit<BuildStreamsInput, 'items' | 'type' | 'season' | 'episode'> = {
  local: new Map(),
  grabsLeft: 5,
  dailyLimit: 10,
  freeBytes: 400 * GB,
  minFreeBytes: 20 * GB,
  playUrl: (id) => `u/${id}`,
};

test('series: keeps only torrents covering the episode, drops remux, labels dead ones', () => {
  const items = [
    item('1', 'Haborer.S02.1080p.WEB-DL'),
    item('2', 'Haborer.S01.1080p.WEB-DL'),
    item('3', 'Haborer.S02E05.720p.HDTV'),
    item('4', 'Haborer.S02E06.720p.HDTV'),
    item('5', 'Haborer.S01-S04.XviD-iLM'),
    item('6', 'Haborer.S02.720p.HDTV', { seeders: 0 }),
    item('7', 'Haborer.S02.2160p.BluRay.REMUX'),
  ];
  const out = buildStreams({ ...base, items, type: 'series', season: 2, episode: 5 });
  expect(out.map((s) => s.url)).toEqual(['u/1', 'u/3', 'u/5', 'u/6']);
  expect(out[3]?.description).toMatch(/💀 No seeders/);
});

test('movie: drops series results', () => {
  const out = buildStreams({ ...base, items: [item('1', 'Inception.2010.1080p.BluRay'), item('2', 'Show.S01.1080p')], type: 'movie' });
  expect(out.map((s) => s.url)).toEqual(['u/1']);
});

test('ordering: ready, downloading, freeleech, resolution', () => {
  const items = [
    item('paid4k', 'M.2160p.WEB-DL'),
    item('free720', 'M.720p.WEB-DL', { downloadFactor: 0 }),
    item('free1080', 'M.1080p.WEB-DL', { downloadFactor: 0 }),
    item('dl', 'M.720p.HDTV'),
    item('ready', 'M.480p.XviD', { seeders: 0 }),
  ];
  const local = new Map<string, LocalStatus>([
    ['ready', { progress: 1 }],
    ['dl', { progress: 0.4, dlspeed: 0 }],
  ]);
  const out = buildStreams({ ...base, local, items, type: 'movie' });
  expect(out.map((s) => s.url)).toEqual(['u/ready', 'u/dl', 'u/free1080', 'u/free720', 'u/paid4k']);
  expect(out[0]?.description).toMatch(/Ready at home/);
  expect(out[1]?.description).toMatch(/Downloading 40%/);
  expect(out[2]?.description).toMatch(/Freeleech/);
  expect(out[4]?.description).toMatch(/Counts toward ratio/);
  expect(out[2]?.name).toBe('🏠 Hebits\n1080p');
  expect(out[2]?.description).toMatch(/5 seeds · ⬇️ 0 downloading/);
});

test('blocked results: daily limit and disk space are labelled and sorted last', () => {
  const items = [item('big', 'M.2160p.WEB-DL', { size: 390 * GB }), item('ok', 'M.1080p.WEB-DL')];
  const out = buildStreams({ ...base, items, type: 'movie' });
  expect(out.map((s) => s.url)).toEqual(['u/ok', 'u/big']);
  expect(out[1]?.description).toMatch(/Not enough disk space/);
  const none = buildStreams({ ...base, grabsLeft: 0, items, type: 'movie' });
  expect(none.every((s) => /Daily limit reached/.test(s.description))).toBe(true);
});

test('season pack is labelled as a whole-pack download', () => {
  const [s] = buildStreams({
    ...base,
    items: [item('1', 'Haborer.S02.1080p.WEB-DL', { files: 12 })],
    type: 'series',
    season: 2,
    episode: 1,
  });
  expect(s?.description).toMatch(/Season 2 pack \(12 files\) · whole pack downloads/);
});

test('a pack at home that search no longer lists shows without stale swarm info', () => {
  const items: StreamItem[] = [{ hebitsId: '9', title: 'Show.S01-S05.720p.HDTV', size: 66 * GB, files: 100, atHomeOnly: true }];
  const local = new Map<string, LocalStatus>([['9', { progress: 0.43, dlspeed: 0 }]]);
  const [s] = buildStreams({ ...base, local, items, type: 'series', season: 2, episode: 3 });
  expect(s?.description).toMatch(/Downloading 43%/);
  expect(s?.description).not.toMatch(/seeds|ratio|Freeleech/);
  expect(buildStreams({ ...base, items, type: 'series', season: 2, episode: 3 }).length).toBe(0);
});

test('pinned library items skip name-based episode matching', () => {
  const items: StreamItem[] = [{ hebitsId: '1', title: 'HebDub.Movies.Pack', size: GB, files: 3, atHomeOnly: true, pinned: true }];
  const local = new Map<string, LocalStatus>([['1', { progress: 1 }]]);
  const [s] = buildStreams({ ...base, local, items, type: 'series', season: 1, episode: 2 });
  expect(s?.description).toMatch(/Ready at home/);
});
