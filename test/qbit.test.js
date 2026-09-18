import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QBit } from '../lib/qbit.js';

test('exportTorrent returns the raw bencoded body', async () => {
  const q = new QBit({ qbitUrl: 'http://x' });
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('d4:infoe').buffer };
  };
  const buf = await q.exportTorrent('ABC');
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString(), 'd4:infoe');
  assert.match(seen[0], /torrents\/export\?hash=ABC$/);
});

test('exportTorrent reports a failed export', async () => {
  const q = new QBit({ qbitUrl: 'http://x' });
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  await assert.rejects(() => q.exportTorrent('ABC'), /HTTP 404/);
});

test('addTags sends a comma-joined list and skips an empty one', async () => {
  const q = new QBit({ qbitUrl: 'http://x' });
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(String(init.body));
    return { ok: true, status: 200, text: async () => 'Ok.' };
  };
  await q.addTags('H', ['hebits:1', 'imdb:tt2']);
  assert.match(bodies[0], /tags=hebits%3A1%2Cimdb%3Att2/);
  await q.addTags('H', []);
  assert.equal(bodies.length, 1);
});
