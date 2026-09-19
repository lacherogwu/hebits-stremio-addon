import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Store } from '../src/store';

test('save persists to disk and returns true on success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const store = new Store(dir, 'UTC');
  store.data.grabs.push({ id: 'x', at: '2026-01-01T00:00:00.000Z' });
  expect(store.save()).toBe(true);
  expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).toEqual(store.data);
});

test('a failed save returns false, does not throw, and logs the file and error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  chmodSync(dir, 0o500); // read+exec only: writing into it fails with EACCES
  const logs: string[] = [];
  const store = new Store(dir, 'UTC', (m) => logs.push(m));
  try {
    expect(() => {
      expect(store.save()).toBe(false);
    }).not.toThrow();
  } finally {
    chmodSync(dir, 0o700); // restore so the temp dir can be cleaned up
  }
  expect(logs.length).toBe(1);
  expect(logs[0]).toMatch(/state\.json/);
});

test('a failed save leaves the previous state.json intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const store = new Store(dir, 'UTC');
  store.data.grabs.push({ id: 'first', at: '2026-01-01T00:00:00.000Z' });
  expect(store.save()).toBe(true);
  const before = readFileSync(join(dir, 'state.json'), 'utf8');

  chmodSync(dir, 0o500);
  store.data.grabs.push({ id: 'second', at: '2026-01-02T00:00:00.000Z' });
  try {
    expect(store.save()).toBe(false);
  } finally {
    chmodSync(dir, 0o700);
  }
  expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe(before);
});

test('save never throws even without a logger, and a disk-full-shaped error is recognisable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  chmodSync(dir, 0o500);
  const store = new Store(dir, 'UTC');
  try {
    expect(() => store.save()).not.toThrow();
  } finally {
    chmodSync(dir, 0o700);
  }
});

test('unknown keys in an existing state.json survive a load-then-save cycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify({ grabs: [], torrents: {}, futureFeature: { untouched: true } }));
  const store = new Store(dir, 'UTC');
  store.putTorrent('h1', { hash: 'abc' });
  expect(JSON.parse(readFileSync(file, 'utf8')).futureFeature).toEqual({ untouched: true });
});

test('putTorrent merges into an existing entry rather than replacing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const store = new Store(dir, 'UTC');
  store.putTorrent('h1', { imdb: 'tt1', title: 'A' });
  store.putTorrent('h1', { hash: 'abc' });
  expect(store.torrent('h1')).toEqual({ imdb: 'tt1', title: 'A', hash: 'abc' });
});

// A corrupt state.json must not throw at construction (see the constructor's own comment
// for why), and it must not be silently clobbered the way a malformed config.json used to
// be - the operator's cached identity lookups are moved aside, recoverable, not destroyed.
test('malformed state.json is moved aside and construction falls back to an empty store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const file = join(dir, 'state.json');
  const original = '{ "grabs": [{"id":"hebits:123","at":"2026-01-01T00:00:00.000Z"}], "torrents": {';
  writeFileSync(file, original);
  const logs: string[] = [];

  let store: Store | undefined;
  expect(() => {
    store = new Store(dir, 'UTC', (m) => logs.push(m));
  }).not.toThrow();

  expect(store?.data).toEqual({ grabs: [], torrents: {} });

  // The broken original must survive under a renamed path, not be gone.
  const badFile = readdirSync(dir).find((f) => f.startsWith('state.json.bad-'));
  expect(badFile).toBeTruthy();
  expect(readFileSync(join(dir, badFile as string), 'utf8')).toBe(original);
  expect(existsSync(file)).toBe(false); // moved, not copied - nothing writes a fresh one until save()

  expect(logs.length).toBe(1);
  expect(logs[0]).toMatch(/moved aside/);
  expect(logs[0]).toContain(badFile);
  // Kept, not just logged: /status renders this beside configIssues, because a reset
  // ledger is what grab.ts's daily() falls back to when Hebits' own counter is
  // unreachable - one line in addon.log is not enough trace for a limit that can be
  // exceeded silently.
  expect(store?.loadIssue).toBe(logs[0]);
});

test('a state.json that cannot even be moved aside runs from an empty in-memory store without touching the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const file = join(dir, 'state.json');
  const original = '{ this is not valid json';
  writeFileSync(file, original);
  chmodSync(dir, 0o500); // read+exec only: renameSync into/out of it fails with EACCES
  const logs: string[] = [];

  let store: Store | undefined;
  try {
    expect(() => {
      store = new Store(dir, 'UTC', (m) => logs.push(m));
    }).not.toThrow();
    expect(store?.data).toEqual({ grabs: [], torrents: {} });
  } finally {
    chmodSync(dir, 0o700); // restore so the temp dir can be cleaned up
  }

  expect(readFileSync(file, 'utf8')).toBe(original); // left exactly as it was
  expect(logs.length).toBe(1);
  expect(logs[0]).toMatch(/could not be moved aside/);
  expect(store?.loadIssue).toBe(logs[0]);
});

// The negative: /status must not show a stale or invented store problem on a healthy run,
// or the field is noise the operator learns to ignore.
test('loadIssue is null when state.json is absent, and when it loads cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  expect(new Store(dir, 'UTC').loadIssue).toBeNull();
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ grabs: [], torrents: {} }));
  expect(new Store(dir, 'UTC').loadIssue).toBeNull();
});

// The same hole as config.ts's, one line further on: `null` and `42` parse cleanly, so the
// constructor's catch never fires, and then server.ts's `store.data.notified ??= {}` throws
// at module load - before the Notifier exists. An array parses too and silently loses every
// property written to it.
for (const [label, body] of [
  ['null', 'null'],
  ['a number', '42'],
  ['an array', '[1,2]'],
] as const) {
  test(`a state.json holding ${label} is moved aside and falls back to an empty store`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'));
    const file = join(dir, 'state.json');
    writeFileSync(file, body);
    const logs: string[] = [];

    let store: Store | undefined;
    expect(() => {
      store = new Store(dir, 'UTC', (m) => logs.push(m));
    }).not.toThrow();

    expect(store?.data).toEqual({ grabs: [], torrents: {} });
    // The statement that actually threw: server.ts:33, run here against the recovered store.
    expect(() => {
      (store as Store).data.notified ??= {};
    }).not.toThrow();

    const badFile = readdirSync(dir).find((f) => f.startsWith('state.json.bad-'));
    expect(badFile).toBeTruthy();
    expect(readFileSync(join(dir, badFile as string), 'utf8')).toBe(body);
    expect(existsSync(file)).toBe(false);

    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/not an object/);
    expect(store?.loadIssue).toBe(logs[0]);
  });
}

// The same class of hole one level in: these all parse, and all are objects, so every
// guard above passes them through - and then the missing key throws from wherever it is
// first touched. `grabs` throws out of grabsToday(), which is only reached once Hebits'
// own counter is unreachable (so: every stream list and /status 500 at the exact moment
// the addon is already degraded); `torrents` throws out of store.torrent() on every
// /play, with the tracker healthy.
for (const [label, body, expected] of [
  ['no "grabs" key', '{"torrents":{}}', /no "grabs" array/],
  ['no "torrents" key', '{"grabs":[]}', /no "torrents" object/],
  ['a "grabs" object instead of an array', '{"grabs":{},"torrents":{}}', /"grabs" is a JSON object/],
  ['a "torrents" array instead of an object', '{"grabs":[],"torrents":[]}', /"torrents" is a JSON array/],
] as const) {
  test(`a state.json with ${label} is moved aside and falls back to an empty store`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'));
    const file = join(dir, 'state.json');
    writeFileSync(file, body);
    const logs: string[] = [];

    let store: Store | undefined;
    expect(() => {
      store = new Store(dir, 'UTC', (m) => logs.push(m));
    }).not.toThrow();

    // The post-state, not just that a guard fired: both statements below are the ones
    // that threw, run here against the recovered store.
    expect(store?.data).toEqual({ grabs: [], torrents: {} });
    expect(() => (store as Store).grabsToday()).not.toThrow();
    expect((store as Store).grabsToday()).toBe(0);
    expect(() => (store as Store).torrent('12345')).not.toThrow();
    expect((store as Store).torrent('12345')).toBeUndefined();

    const badFile = readdirSync(dir).find((f) => f.startsWith('state.json.bad-'));
    expect(badFile).toBeTruthy();
    expect(readFileSync(join(dir, badFile as string), 'utf8')).toBe(body); // recoverable, not destroyed
    expect(existsSync(file)).toBe(false);

    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(expected);
    expect(store?.loadIssue).toBe(logs[0]);
  });
}

// The negative control for the four above: a state file that carries both keys with the
// right shapes is loaded as-is, not "recovered". Without this, a guard that rejected every
// state.json would pass the whole file.
test('a well-shaped state.json is loaded untouched, with no move-aside', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const file = join(dir, 'state.json');
  const data = { grabs: [{ id: '12345', at: '2026-09-19T00:00:00.000Z' }], torrents: { '12345': { hash: 'abc' } } };
  writeFileSync(file, JSON.stringify(data));
  const store = new Store(dir, 'UTC');
  expect(store.data).toEqual(data);
  expect(store.loadIssue).toBeNull();
  expect(readdirSync(dir).find((f) => f.startsWith('state.json.bad-'))).toBeUndefined();
});

// HAZARD (day scoping): grabsToday() is the fallback download counter - it is what daily()
// reports when Hebits' own counter is unreachable. Counting every grab in the ledger (it
// keeps a month) instead of today's would hold `used >= limit` permanently and refuse every
// download with "daily limit reached", precisely when nobody can see the real number.
test('grabsToday counts only today, not the whole month-long ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const store = new Store(dir, 'UTC');
  const now = new Date('2026-09-19T12:00:00.000Z');
  store.data.grabs = [
    { id: 'a', at: '2026-08-25T12:00:00.000Z' }, // weeks ago, still in the ledger
    { id: 'b', at: '2026-09-18T23:59:59.000Z' }, // yesterday, one second before midnight
    { id: 'c', at: '2026-09-19T00:00:00.000Z' }, // today, the first second
    { id: 'd', at: '2026-09-19T12:00:00.000Z' }, // today
  ];
  expect(store.grabsToday(now)).toBe(2);
  // A day with nothing grabbed in it reads as zero rather than as "everything so far".
  expect(store.grabsToday(new Date('2026-09-20T12:00:00.000Z'))).toBe(0);
});

// The day boundary is the configured timezone's, not UTC's: the same instant belongs to a
// different day in Asia/Jerusalem (UTC+3 in September), and the limit this feeds is the
// tracker's, which rolls over on the tracker's clock.
test('grabsToday scopes the day in the configured timezone, not UTC', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const grabs = [{ id: 'a', at: '2026-09-18T22:00:00.000Z' }]; // 01:00 on the 19th in Jerusalem
  const utc = new Store(dir, 'UTC');
  utc.data.grabs = grabs;
  const jerusalem = new Store(dir, 'Asia/Jerusalem');
  jerusalem.data.grabs = grabs;
  const now = new Date('2026-09-19T12:00:00.000Z');
  expect(utc.grabsToday(now)).toBe(0);
  expect(jerusalem.grabsToday(now)).toBe(1);
});
