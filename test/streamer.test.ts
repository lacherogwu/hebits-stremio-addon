import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { type PieceStateSource, parseRange, pieceAt, type ServeFileTarget, serveFile } from '../src/streamer';

test('parseRange', () => {
  expect(parseRange(undefined, 100)).toBe(null);
  expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
  expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
  expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
  expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
  expect(parseRange('bytes=100-', 100)).toBe('invalid');
  expect(parseRange('items=0-1', 100)).toBe('invalid');
});

test('pieceAt accounts for the file offset inside the torrent', () => {
  expect(pieceAt(0, 0, 16)).toBe(0);
  expect(pieceAt(100, 0, 16)).toBe(6);
  expect(pieceAt(100, 12, 16)).toBe(7);
});

// File of 64 bytes at torrent offset 32, piece length 16 -> file spans pieces 2..5.
function setup(states: number[]) {
  const dir = mkdtempSync(join(tmpdir(), 'hb-'));
  const path = join(dir, 'f.mkv');
  const data = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
  writeFileSync(path, data);
  const qbit: PieceStateSource = {
    async pieceStates() {
      return states;
    },
  };
  const f: Omit<ServeFileTarget, 'hash'> = { qbit, path, size: 64, offset: 32, pieceLength: 16, complete: false };
  return { data, f };
}

async function request(f: Omit<ServeFileTarget, 'hash'>, headers: Record<string, string>, hash: string) {
  const server = createServer((req, res) => {
    serveFile(req, res, { ...f, hash }, () => {});
  });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers });
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  } finally {
    server.close();
  }
}

test('serves a completed range from a downloading torrent', async () => {
  const { data, f } = setup([2, 2, 2, 2, 2, 2]);
  const r = await request(f, { range: 'bytes=4-35' }, 'h1');
  expect(r.status).toBe(206);
  expect(r.headers.get('content-range')).toBe('bytes 4-35/64');
  expect(r.headers.get('content-type')).toBe('video/x-matroska');
  expect(r.body).toEqual(data.subarray(4, 36));
});

test('holds back bytes until their piece completes, then continues', async () => {
  // pieces 2 and 3 done (file bytes 0..31), piece 4 missing until later
  const states = [0, 0, 2, 2, 0, 2];
  const { data, f } = setup(states);
  const server = createServer((req, res) => {
    serveFile(req, res, { ...f, hash: 'h2' }, () => {});
  });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { range: 'bytes=0-' } });
    expect(res.status).toBe(206);
    if (!res.body) throw new Error('no response body');
    const reader = res.body.getReader();
    const got: Buffer[] = [];
    let pending: ReturnType<typeof reader.read> | null = null; // a read that outlives a timeout must not be dropped
    const readSome = async (ms: number): Promise<boolean> => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        pending ??= reader.read();
        const r = await Promise.race([pending, new Promise<null>((ok) => setTimeout(() => ok(null), until - Date.now()))]);
        if (!r) return false;
        pending = null;
        if (r.done) return true;
        got.push(Buffer.from(r.value));
      }
      return false;
    };
    await readSome(1500);
    expect(Buffer.concat(got)).toEqual(data.subarray(0, 32));
    states[4] = 2;
    const done = await readSome(3000);
    expect(done).toBe(true);
    expect(Buffer.concat(got)).toEqual(data);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('a transient pieceStates failure does not truncate the response mid-stream', async () => {
  // pieces 2 and 3 (file bytes 0..31) are already done; piece 4 arrives only after a
  // pieceStates() call fails once - the failure must not end the response early.
  const states = [0, 0, 2, 2, 0, 2];
  const dir = mkdtempSync(join(tmpdir(), 'hb-'));
  const path = join(dir, 'f.mkv');
  const data = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
  writeFileSync(path, data);
  let calls = 0;
  const qbit: PieceStateSource = {
    async pieceStates() {
      calls++;
      if (calls === 2) throw new Error('qBittorrent hiccup'); // one transient failure
      if (calls >= 3) states[4] = 2; // then it recovers
      return states;
    },
  };
  const f: ServeFileTarget = {
    qbit,
    hash: 'h5',
    path,
    size: 64,
    offset: 32,
    pieceLength: 16,
    complete: false,
    waits: { firstBytes: 3000, piece: 3000, poll: 50 },
  };
  const server = createServer((req, res) => {
    serveFile(req, res, f, () => {});
  });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { range: 'bytes=0-' } });
    expect(res.status).toBe(206);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(data);
    expect(calls).toBeGreaterThanOrEqual(3);
  } finally {
    server.close();
  }
});

test('503 when the first bytes never arrive', async () => {
  const { f } = setup([0, 0, 0, 0, 0, 0]);
  const short: Omit<ServeFileTarget, 'hash'> = { ...f, waits: { firstBytes: 200, piece: 200, poll: 20 } };
  const r = await request(short, { range: 'bytes=0-' }, 'h3');
  expect(r.status).toBe(503);
});

test('complete file is served directly', async () => {
  const { data, f } = setup([]);
  const r = await request({ ...f, complete: true }, {}, 'h4');
  expect(r.status).toBe(200);
  expect(r.body).toEqual(data);
});
