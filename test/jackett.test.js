import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Jackett } from '../lib/jackett.js';

function item(id, title) {
  return `<item><title>${title}</title><guid>https://x/details?id=${id}</guid></item>`;
}

function rss(...items) {
  return `<rss><channel>${items.join('')}</channel></rss>`;
}

function newJackett() {
  return new Jackett({ jackettUrl: 'http://x', jackettIndexer: 'hebits', jackettApiKey: 'k' });
}

test('two concurrent identical searches issue exactly one request and share the result', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, status: 200, text: async () => rss(item(1, 'A')) };
  };
  const j = newJackett();
  const [a, b] = await Promise.all([j.search({ t: 'search', q: 'x' }), j.search({ t: 'search', q: 'x' })]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(a[0].hebitsId, '1');
});

test('concurrent searches with different params issue separate requests', async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    return { ok: true, status: 200, text: async () => rss(item(1, String(url))) };
  };
  const j = newJackett();
  await Promise.all([j.search({ t: 'search', q: 'x' }), j.search({ t: 'search', q: 'y' })]);
  assert.equal(calls, 2);
});

test('a rejected request is not cached: retries on the next call, and every waiter sees the rejection', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 500 };
  };
  const j = newJackett();
  const p1 = j.search({ t: 'search', q: 'x' });
  const p2 = j.search({ t: 'search', q: 'x' });
  await assert.rejects(p1, /HTTP 500/);
  await assert.rejects(p2, /HTTP 500/);
  assert.equal(calls, 1);

  globalThis.fetch = async () => {
    calls++;
    return { ok: true, status: 200, text: async () => rss(item(2, 'B')) };
  };
  const items = await j.search({ t: 'search', q: 'x' });
  assert.equal(calls, 2);
  assert.equal(items[0].hebitsId, '2');
});

test('a completed result is served from cache within the 10-minute window', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, status: 200, text: async () => rss(item(1, 'A')) };
  };
  const j = newJackett();
  await j.search({ t: 'search', q: 'x' });
  await j.search({ t: 'search', q: 'x' });
  assert.equal(calls, 1);
});
