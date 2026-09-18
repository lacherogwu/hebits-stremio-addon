import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRange, pieceAt, serveFile } from '../lib/streamer.js';

test('parseRange', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'invalid');
  assert.equal(parseRange('items=0-1', 100), 'invalid');
});

test('pieceAt accounts for the file offset inside the torrent', () => {
  assert.equal(pieceAt(0, 0, 16), 0);
  assert.equal(pieceAt(100, 0, 16), 6);
  assert.equal(pieceAt(100, 12, 16), 7);
});

// File of 64 bytes at torrent offset 32, piece length 16 -> file spans pieces 2..5.
function setup(states) {
  const dir = mkdtempSync(join(tmpdir(), 'hb-'));
  const path = join(dir, 'f.mkv');
  const data = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
  writeFileSync(path, data);
  const qbit = { pieceStates: async () => states };
  const f = { qbit, path, size: 64, offset: 32, pieceLength: 16, complete: false };
  return { data, f };
}

async function request(f, headers, hash) {
  const server = createServer((req, res) => serveFile(req, res, { ...f, hash }, () => {}));
  await new Promise((r) => server.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers });
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  } finally {
    server.close();
  }
}

test('serves a completed range from a downloading torrent', async () => {
  const { data, f } = setup([2, 2, 2, 2, 2, 2]);
  const r = await request(f, { range: 'bytes=4-35' }, 'h1');
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 4-35/64');
  assert.equal(r.headers.get('content-type'), 'video/x-matroska');
  assert.deepEqual(r.body, data.subarray(4, 36));
});

test('holds back bytes until their piece completes, then continues', async () => {
  // pieces 2 and 3 done (file bytes 0..31), piece 4 missing until later
  const states = [0, 0, 2, 2, 0, 2];
  const { data, f } = setup(states);
  const server = createServer((req, res) => serveFile(req, res, { ...f, hash: 'h2' }, () => {}));
  await new Promise((r) => server.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { range: 'bytes=0-' } });
    assert.equal(res.status, 206);
    const reader = res.body.getReader();
    const got = [];
    let pending = null; // a read that outlives a timeout must not be dropped
    const readSome = async (ms) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        pending ??= reader.read();
        const r = await Promise.race([pending, new Promise((ok) => setTimeout(() => ok(null), until - Date.now()))]);
        if (!r) return false;
        pending = null;
        if (r.done) return true;
        got.push(Buffer.from(r.value));
      }
    };
    await readSome(1500);
    assert.deepEqual(Buffer.concat(got), data.subarray(0, 32), 'only bytes from finished pieces');
    states[4] = 2;
    const done = await readSome(3000);
    assert.ok(done);
    assert.deepEqual(Buffer.concat(got), data);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('503 when the first bytes never arrive', async () => {
  const { f } = setup([0, 0, 0, 0, 0, 0]);
  const short = { ...f, waits: { firstBytes: 200, piece: 200, poll: 20 } };
  const r = await request(short, { range: 'bytes=0-' }, 'h3');
  assert.equal(r.status, 503);
});

test('complete file is served directly', async () => {
  const { data, f } = setup([]);
  const r = await request({ ...f, complete: true }, {}, 'h4');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, data);
});
