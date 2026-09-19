import { expect, test } from 'vitest';
import { IdentityResolver, matchRelease, nextTryAt, normalizeTitle, type ReleaseItem } from '../src/identity';
import type { IdentityCacheEntry } from '../src/store';

test('normalizeTitle ignores punctuation, spacing and case', () => {
  expect(normalizeTitle('Some.Show.S02E04-GRP')).toBe(normalizeTitle('some show s02e04 GRP'));
});

test('matchRelease finds the result whose name is the torrent name', () => {
  const items: ReleaseItem[] = [
    { id: 1, name: 'Other.Thing' },
    { id: 42, name: 'Some.Show.S02E04-GRP', imdb: 'tt7' },
  ];
  expect(matchRelease(items, 'Some Show S02E04 GRP')?.id).toBe(42);
  expect(matchRelease(items, 'Nothing.Like.This')).toBe(undefined);
});

test('backoff grows and is capped at a day', () => {
  expect(nextTryAt(0, 0)).toBe(5 * 60_000);
  expect(nextTryAt(1, 0)).toBe(10 * 60_000);
  expect(nextTryAt(20, 0)).toBe(24 * 3600_000);
});

function setup({
  items = [],
  imdbFromCinemeta,
  cache = {},
}: {
  items?: ReleaseItem[];
  imdbFromCinemeta?: string;
  cache?: Record<string, IdentityCacheEntry>;
} = {}) {
  const tagged: { hash: string; tags: string[] }[] = [];
  const resolver = new IdentityResolver({
    hebits: {
      async search() {
        return items;
      },
    },
    qbit: {
      async addTags(hash, tags) {
        tagged.push({ hash, tags });
      },
    },
    cinemetaSearch: async () => imdbFromCinemeta,
    cache,
    save: () => {},
    log: () => {},
    now: () => 1000,
  });
  return { resolver, tagged, cache };
}

test('a fully tagged entry is returned untouched, with no lookup', async () => {
  const { resolver, tagged, cache } = setup({ items: [{ id: 9, name: 'X' }] });
  const e = { hash: 'H', name: 'Some.Show.S02E04-GRP', hebitsId: '1001', imdb: 'tt1' };
  expect((await resolver.resolve(e)).imdb).toBe('tt1');
  expect(tagged).toEqual([]);
  expect(cache).toEqual({});
});

test('a Hebits name match fills in both ids and writes them back as tags', async () => {
  const { resolver, tagged } = setup({ items: [{ id: 42, name: 'Some.Show.S02E04-GRP', imdb: 'tt7' }] });
  const e = await resolver.resolve({ hash: 'H', name: 'Some.Show.S02E04-GRP' });
  expect(e.hebitsId).toBe('42');
  expect(e.imdb).toBe('tt7');
  expect(tagged[0]).toEqual({ hash: 'H', tags: ['hebits:42', 'imdb:tt7'] });
});

// HAZARD (id): HebitsTorrent.id is a number and the store is keyed by strings, so a hit's
// id must be converted on the way out of the client. Without it the resolved entry never
// matches a store key - every lookup misses and the torrent looks unknown forever.
test('a numeric result id becomes the string key the store is keyed by', async () => {
  const { resolver, cache } = setup({ items: [{ id: 42, name: 'Some.Show.S02E04-GRP', imdb: 'tt7' }] });
  const e = await resolver.resolve({ hash: 'H', name: 'Some.Show.S02E04-GRP' });
  expect(typeof e.hebitsId).toBe('string');
  const storeKeys = new Set(Object.keys({ '42': { hash: 'H' } }));
  expect(storeKeys.has(e.hebitsId ?? '')).toBe(true);
  expect(cache.H?.hebitsId).toBe('42');
});

test('Cinemeta recovers the IMDb id when Hebits has nothing', async () => {
  const { resolver, tagged } = setup({ items: [], imdbFromCinemeta: 'tt99' });
  const e = await resolver.resolve({ hash: 'H', name: 'Some.Show.S02E04-GRP' });
  expect(e.imdb).toBe('tt99');
  expect(e.hebitsId).toBe(undefined);
  expect(tagged[0]).toEqual({ hash: 'H', tags: ['imdb:tt99'] });
});

test('a total miss degrades gracefully and schedules a retry', async () => {
  const { resolver, cache } = setup({ items: [], imdbFromCinemeta: undefined });
  const e = await resolver.resolve({ hash: 'H', name: 'Unknown.Thing' });
  expect(e.imdb).toBe(undefined);
  expect(e.name).toBe('Unknown.Thing');
  expect(cache.H?.attempts).toBe(1);
  expect(cache.H?.nextTryAt).toBe(1000 + 5 * 60_000);
});

test('a miss inside the backoff window does not call out again', async () => {
  let searches = 0;
  const cache: Record<string, IdentityCacheEntry> = { H: { attempts: 3, nextTryAt: 10 ** 9 } };
  const resolver = new IdentityResolver({
    hebits: {
      async search() {
        searches++;
        return [];
      },
    },
    qbit: { async addTags() {} },
    cinemetaSearch: async () => undefined,
    cache,
    save: () => {},
    log: () => {},
    now: () => 1000,
  });
  await resolver.resolve({ hash: 'H', name: 'Unknown.Thing' });
  expect(searches).toBe(0);
});

test('a cached hit is reused without a lookup', async () => {
  let searches = 0;
  const cache: Record<string, IdentityCacheEntry> = { H: { hebitsId: '5', imdb: 'tt5', attempts: 0, nextTryAt: 0 } };
  const resolver = new IdentityResolver({
    hebits: {
      async search() {
        searches++;
        return [];
      },
    },
    qbit: { async addTags() {} },
    cinemetaSearch: async () => undefined,
    cache,
    save: () => {},
    log: () => {},
    now: () => 1000,
  });
  const e = await resolver.resolve({ hash: 'H', name: 'X' });
  expect(e.imdb).toBe('tt5');
  expect(searches).toBe(0);
});

test('a lookup failure is swallowed, never thrown at the catalog', async () => {
  const resolver = new IdentityResolver({
    hebits: {
      async search() {
        throw new Error('Hebits HTTP 500');
      },
    },
    qbit: { async addTags() {} },
    cinemetaSearch: async () => {
      throw new Error('offline');
    },
    cache: {},
    save: () => {},
    log: () => {},
    now: () => 1000,
  });
  const e = await resolver.resolve({ hash: 'H', name: 'X' });
  expect(e.imdb).toBe(undefined);
});

// A partial hit (Hebits has the release but its item carries no imdb field; Cinemeta
// cannot match either) must keep backing off, not settle at attempts:0 forever --
// otherwise it re-queries Hebits on every catalogue load.
test('a partially-resolvable entry backs off, keeping the id it did find', async () => {
  let hebitsCalls = 0;
  let cinemetaCalls = 0;
  const cache: Record<string, IdentityCacheEntry> = {};
  const resolver = new IdentityResolver({
    hebits: {
      async search() {
        hebitsCalls++;
        return [{ id: 42, name: 'Some.Show.S02E04-GRP' }]; // no imdb field
      },
    },
    qbit: { async addTags() {} },
    cinemetaSearch: async () => {
      cinemetaCalls++;
      return undefined;
    },
    cache,
    save: () => {},
    log: () => {},
    now: () => 1000,
  });

  const e1 = await resolver.resolve({ hash: 'H', name: 'Some.Show.S02E04-GRP' });
  expect(e1.hebitsId).toBe('42');
  expect(e1.imdb).toBe(undefined);
  expect(hebitsCalls).toBe(1);
  expect(cinemetaCalls).toBe(1);
  expect(cache.H?.hebitsId).toBe('42'); // what was found is not lost
  expect(cache.H?.attempts).toBe(1); // not pinned at 0 -- still backing off
  expect(cache.H?.nextTryAt).toBe(1000 + 5 * 60_000);

  // A second resolve inside the backoff window must not call out again.
  const e2 = await resolver.resolve({ hash: 'H', name: 'Some.Show.S02E04-GRP' });
  expect(e2.hebitsId).toBe('42');
  expect(hebitsCalls).toBe(1);
  expect(cinemetaCalls).toBe(1);
  expect(cache.H?.attempts).toBe(1);
});

test('once the backoff window passes, a partially-resolved entry retries and backs off further', async () => {
  let hebitsCalls = 0;
  let time = 1000;
  const cache: Record<string, IdentityCacheEntry> = {};
  const resolver = new IdentityResolver({
    hebits: {
      async search() {
        hebitsCalls++;
        return [{ id: 42, name: 'Some.Show.S02E04-GRP' }];
      },
    },
    qbit: { async addTags() {} },
    cinemetaSearch: async () => undefined,
    cache,
    save: () => {},
    log: () => {},
    now: () => time,
  });

  await resolver.resolve({ hash: 'H', name: 'Some.Show.S02E04-GRP' });
  expect(hebitsCalls).toBe(1);
  expect(cache.H?.attempts).toBe(1);

  time = cache.H?.nextTryAt ?? 0; // exactly when the retry becomes due
  await resolver.resolve({ hash: 'H', name: 'Some.Show.S02E04-GRP' });
  expect(hebitsCalls).toBe(2);
  expect(cache.H?.attempts).toBe(2); // backs off further, not reset
  expect(cache.H?.nextTryAt).toBe(time + 10 * 60_000);
});

test('the query sent to Hebits is the show name, not the whole release name', async () => {
  const queries: { query: string }[] = [];
  const resolver = new IdentityResolver({
    hebits: {
      async search(options) {
        queries.push(options);
        return [];
      },
    },
    qbit: { async addTags() {} },
    cinemetaSearch: async () => undefined,
    cache: {},
    save: () => {},
    log: () => {},
    now: () => 1000,
  });
  await resolver.resolve({ hash: 'H', name: 'Some.Show.S02E04.1080p.WEB-DL-GRP' });
  expect(queries).toEqual([{ query: 'Some Show' }]);
});
