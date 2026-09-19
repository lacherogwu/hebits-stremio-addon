import { afterEach, expect, test, vi } from 'vitest';
import { QBit } from '../src/qbit';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('exportTorrent returns the raw bencoded body', async () => {
  const q = new QBit({ qbitUrl: 'http://x' });
  const seen: string[] = [];
  vi.stubGlobal('fetch', async (url: string | URL) => {
    seen.push(String(url));
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('d4:infoe').buffer };
  });
  const buf = await q.exportTorrent('ABC');
  expect(Buffer.isBuffer(buf)).toBe(true);
  expect(buf.toString()).toBe('d4:infoe');
  expect(seen[0]).toMatch(/torrents\/export\?hash=ABC$/);
});

test('exportTorrent reports a failed export', async () => {
  const q = new QBit({ qbitUrl: 'http://x' });
  vi.stubGlobal('fetch', async () => ({ ok: false, status: 404 }));
  await expect(q.exportTorrent('ABC')).rejects.toThrow(/HTTP 404/);
});

test('a 403 on export logs in and retries, still returning a Buffer', async () => {
  const q = new QBit({ qbitUrl: 'http://x', qbitUsername: 'u', qbitPassword: 'p' });
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string | URL) => {
    calls.push(String(url));
    if (String(url).includes('/auth/login')) {
      return { ok: true, status: 200, headers: { getSetCookie: () => ['SID=abc123; Path=/'] } };
    }
    if (calls.length === 1) return { ok: false, status: 403 };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('d4:infoe').buffer };
  });
  const buf = await q.exportTorrent('ABC');
  expect(Buffer.isBuffer(buf)).toBe(true);
  expect(buf.toString()).toBe('d4:infoe');
  expect(calls.length).toBe(3);
  expect(calls[0]).toMatch(/torrents\/export\?hash=ABC$/);
  expect(calls[1]).toMatch(/auth\/login$/);
  expect(calls[2]).toMatch(/torrents\/export\?hash=ABC$/);
});

test('addTags sends a comma-joined list and skips an empty one', async () => {
  const q = new QBit({ qbitUrl: 'http://x' });
  const bodies: string[] = [];
  vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return { ok: true, status: 200, text: async () => 'Ok.' };
  });
  await q.addTags('H', ['hebits:1', 'imdb:tt2']);
  expect(bodies[0]).toMatch(/tags=hebits%3A1%2Cimdb%3Att2/);
  await q.addTags('H', []);
  expect(bodies.length).toBe(1);
});
