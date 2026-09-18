import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStreams } from '../lib/streams.js';

const GB = 1024 ** 3;
const item = (hebitsId, title, extra = {}) => ({ hebitsId, title, size: 10 * GB, files: 10, seeders: 5, peers: 5, downloadFactor: 1, uploadFactor: 1, ...extra });
const base = { local: new Map(), grabsLeft: 5, dailyLimit: 10, freeBytes: 400 * GB, minFreeBytes: 20 * GB, playUrl: (id) => `u/${id}` };

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
  assert.deepEqual(out.map((s) => s.url), ['u/1', 'u/3', 'u/5', 'u/6']);
  assert.match(out[3].description, /💀 No seeders/);
});

test('movie: drops series results', () => {
  const out = buildStreams({ ...base, items: [item('1', 'Inception.2010.1080p.BluRay'), item('2', 'Show.S01.1080p')], type: 'movie' });
  assert.deepEqual(out.map((s) => s.url), ['u/1']);
});

test('ordering: ready, downloading, freeleech, resolution', () => {
  const items = [
    item('paid4k', 'M.2160p.WEB-DL'),
    item('free720', 'M.720p.WEB-DL', { downloadFactor: 0 }),
    item('free1080', 'M.1080p.WEB-DL', { downloadFactor: 0 }),
    item('dl', 'M.720p.HDTV'),
    item('ready', 'M.480p.XviD', { seeders: 0 }),
  ];
  const local = new Map([
    ['ready', { progress: 1 }],
    ['dl', { progress: 0.4, dlspeed: 0 }],
  ]);
  const out = buildStreams({ ...base, local, items, type: 'movie' });
  assert.deepEqual(out.map((s) => s.url), ['u/ready', 'u/dl', 'u/free1080', 'u/free720', 'u/paid4k']);
  assert.match(out[0].description, /Ready at home/);
  assert.match(out[1].description, /Downloading 40%/);
  assert.match(out[2].description, /Freeleech/);
  assert.match(out[4].description, /Counts toward ratio/);
  assert.equal(out[2].name, '🏠 Hebits\n1080p');
  assert.match(out[2].description, /5 seeds · ⬇️ 0 downloading/);
});

test('blocked results: daily limit and disk space are labelled and sorted last', () => {
  const items = [item('big', 'M.2160p.WEB-DL', { size: 390 * GB }), item('ok', 'M.1080p.WEB-DL')];
  const out = buildStreams({ ...base, items, type: 'movie' });
  assert.deepEqual(out.map((s) => s.url), ['u/ok', 'u/big']);
  assert.match(out[1].description, /Not enough disk space/);
  const none = buildStreams({ ...base, grabsLeft: 0, items, type: 'movie' });
  assert.ok(none.every((s) => /Daily limit reached/.test(s.description)));
});

test('season pack is labelled as a whole-pack download', () => {
  const [s] = buildStreams({ ...base, items: [item('1', 'Haborer.S02.1080p.WEB-DL', { files: 12 })], type: 'series', season: 2, episode: 1 });
  assert.match(s.description, /Season 2 pack \(12 files\) · whole pack downloads/);
});

test('a pack at home that search no longer lists shows without stale swarm info', () => {
  const items = [{ hebitsId: '9', title: 'Show.S01-S05.720p.HDTV', size: 66 * GB, files: 100, atHomeOnly: true }];
  const local = new Map([['9', { progress: 0.43, dlspeed: 0 }]]);
  const [s] = buildStreams({ ...base, local, items, type: 'series', season: 2, episode: 3 });
  assert.match(s.description, /Downloading 43%/);
  assert.doesNotMatch(s.description, /seeds|ratio|Freeleech/);
  assert.equal(buildStreams({ ...base, items, type: 'series', season: 2, episode: 3 }).length, 0);
});

test('pinned library items skip name-based episode matching', () => {
  const items = [{ hebitsId: '1', title: 'HebDub.Movies.Pack', size: GB, files: 3, atHomeOnly: true, pinned: true }];
  const local = new Map([['1', { progress: 1 }]]);
  const [s] = buildStreams({ ...base, local, items, type: 'series', season: 1, episode: 2 });
  assert.match(s.description, /Ready at home/);
});
