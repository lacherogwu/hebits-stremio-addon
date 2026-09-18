import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, matchRelease, nextTryAt, IdentityResolver } from '../lib/identity.js';

test('normalizeTitle ignores punctuation, spacing and case', () => {
  assert.equal(normalizeTitle('Some.Show.S02E04-GRP'), normalizeTitle('some show s02e04 GRP'));
});

test('matchRelease finds the result whose title is the torrent name', () => {
  const items = [{ title: 'Other.Thing', hebitsId: '1' }, { title: 'Some.Show.S02E04-GRP', hebitsId: '42', imdb: 'tt7' }];
  assert.equal(matchRelease(items, 'Some Show S02E04 GRP').hebitsId, '42');
  assert.equal(matchRelease(items, 'Nothing.Like.This'), undefined);
});

test('backoff grows and is capped at a day', () => {
  assert.equal(nextTryAt(0, 0), 5 * 60_000);
  assert.equal(nextTryAt(1, 0), 10 * 60_000);
  assert.equal(nextTryAt(20, 0), 24 * 3600_000);
});

function setup({ items = [], imdbFromCinemeta, cache = {} } = {}) {
  const tagged = [];
  const resolver = new IdentityResolver({
    jackett: { async search() { return items; } },
    qbit: { async addTags(hash, tags) { tagged.push({ hash, tags }); } },
    cinemetaSearch: async () => imdbFromCinemeta,
    cache,
    save: () => {},
    log: () => {},
    now: () => 1000,
  });
  return { resolver, tagged, cache };
}

test('a fully tagged entry is returned untouched, with no lookup', async () => {
  const { resolver, tagged, cache } = setup({ items: [{ title: 'X', hebitsId: '9' }] });
  const e = { hash: 'H', name: 'Some.Show.S02E04-GRP', hebitsId: '1001', imdb: 'tt1' };
  assert.equal((await resolver.resolve(e)).imdb, 'tt1');
  assert.deepEqual(tagged, []);
  assert.deepEqual(cache, {});
});

test('a Jackett title match fills in both ids and writes them back as tags', async () => {
  const { resolver, tagged } = setup({ items: [{ title: 'Some.Show.S02E04-GRP', hebitsId: '42', imdb: 'tt7' }] });
  const e = await resolver.resolve({ hash: 'H', name: 'Some.Show.S02E04-GRP' });
  assert.equal(e.hebitsId, '42');
  assert.equal(e.imdb, 'tt7');
  assert.deepEqual(tagged[0], { hash: 'H', tags: ['hebits:42', 'imdb:tt7'] });
});

test('Cinemeta recovers the IMDb id when Jackett has nothing', async () => {
  const { resolver, tagged } = setup({ items: [], imdbFromCinemeta: 'tt99' });
  const e = await resolver.resolve({ hash: 'H', name: 'Some.Show.S02E04-GRP' });
  assert.equal(e.imdb, 'tt99');
  assert.equal(e.hebitsId, undefined);
  assert.deepEqual(tagged[0], { hash: 'H', tags: ['imdb:tt99'] });
});

test('a total miss degrades gracefully and schedules a retry', async () => {
  const { resolver, cache } = setup({ items: [], imdbFromCinemeta: undefined });
  const e = await resolver.resolve({ hash: 'H', name: 'Unknown.Thing' });
  assert.equal(e.imdb, undefined);
  assert.equal(e.name, 'Unknown.Thing');
  assert.equal(cache.H.attempts, 1);
  assert.equal(cache.H.nextTryAt, 1000 + 5 * 60_000);
});

test('a miss inside the backoff window does not call out again', async () => {
  let searches = 0;
  const cache = { H: { attempts: 3, nextTryAt: 10 ** 9 } };
  const resolver = new IdentityResolver({
    jackett: { async search() { searches++; return []; } },
    qbit: { async addTags() {} },
    cinemetaSearch: async () => undefined,
    cache, save: () => {}, log: () => {}, now: () => 1000,
  });
  await resolver.resolve({ hash: 'H', name: 'Unknown.Thing' });
  assert.equal(searches, 0);
});

test('a cached hit is reused without a lookup', async () => {
  let searches = 0;
  const cache = { H: { hebitsId: '5', imdb: 'tt5', attempts: 0, nextTryAt: 0 } };
  const resolver = new IdentityResolver({
    jackett: { async search() { searches++; return []; } },
    qbit: { async addTags() {} },
    cinemetaSearch: async () => undefined,
    cache, save: () => {}, log: () => {}, now: () => 1000,
  });
  const e = await resolver.resolve({ hash: 'H', name: 'X' });
  assert.equal(e.imdb, 'tt5');
  assert.equal(searches, 0);
});

test('a lookup failure is swallowed, never thrown at the catalog', async () => {
  const resolver = new IdentityResolver({
    jackett: { async search() { throw new Error('Jackett HTTP 500'); } },
    qbit: { async addTags() {} },
    cinemetaSearch: async () => { throw new Error('offline'); },
    cache: {}, save: () => {}, log: () => {}, now: () => 1000,
  });
  const e = await resolver.resolve({ hash: 'H', name: 'X' });
  assert.equal(e.imdb, undefined);
});

// A partial hit (Jackett has the release but its item carries no imdbid
// attribute; Cinemeta cannot match either) must keep backing off, not settle at
// attempts:0 forever -- otherwise it re-queries Hebits on every catalogue load.
test('a partially-resolvable entry backs off, keeping the id it did find', async () => {
  let jackettCalls = 0;
  let cinemetaCalls = 0;
  const cache = {};
  const resolver = new IdentityResolver({
    jackett: {
      async search() {
        jackettCalls++;
        return [{ title: 'Some.Show.S02E04-GRP', hebitsId: '42' }]; // no imdb field
      },
    },
    qbit: { async addTags() {} },
    cinemetaSearch: async () => { cinemetaCalls++; return undefined; },
    cache,
    save: () => {},
    log: () => {},
    now: () => 1000,
  });

  const e1 = await resolver.resolve({ hash: 'H', name: 'Some.Show.S02E04-GRP' });
  assert.equal(e1.hebitsId, '42');
  assert.equal(e1.imdb, undefined);
  assert.equal(jackettCalls, 1);
  assert.equal(cinemetaCalls, 1);
  assert.equal(cache.H.hebitsId, '42'); // what was found is not lost
  assert.equal(cache.H.attempts, 1); // not pinned at 0 -- still backing off
  assert.equal(cache.H.nextTryAt, 1000 + 5 * 60_000);

  // A second resolve inside the backoff window must not call out again.
  const e2 = await resolver.resolve({ hash: 'H', name: 'Some.Show.S02E04-GRP' });
  assert.equal(e2.hebitsId, '42');
  assert.equal(jackettCalls, 1);
  assert.equal(cinemetaCalls, 1);
  assert.equal(cache.H.attempts, 1);
});

test('once the backoff window passes, a partially-resolved entry retries and backs off further', async () => {
  let jackettCalls = 0;
  let time = 1000;
  const cache = {};
  const resolver = new IdentityResolver({
    jackett: {
      async search() {
        jackettCalls++;
        return [{ title: 'Some.Show.S02E04-GRP', hebitsId: '42' }];
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
  assert.equal(jackettCalls, 1);
  assert.equal(cache.H.attempts, 1);

  time = cache.H.nextTryAt; // exactly when the retry becomes due
  await resolver.resolve({ hash: 'H', name: 'Some.Show.S02E04-GRP' });
  assert.equal(jackettCalls, 2);
  assert.equal(cache.H.attempts, 2); // backs off further, not reset
  assert.equal(cache.H.nextTryAt, time + 10 * 60_000);
});
