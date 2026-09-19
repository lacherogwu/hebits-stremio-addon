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

test('a 403 triggers exactly one re-login, and a persistent 403 afterward is not retried again', async () => {
  const q = new QBit({ qbitUrl: 'http://x', qbitUsername: 'u', qbitPassword: 'p' });
  const calls: string[] = [];
  const cookiesSeen: (string | undefined)[] = [];
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/auth/login')) {
      return { ok: true, status: 200, headers: { getSetCookie: () => ['SID=abc123; Path=/'] } };
    }
    cookiesSeen.push((init?.headers as Record<string, string> | undefined)?.cookie);
    // Every real request 403s, even the retry — which genuinely carries the session
    // cookie login() just issued (asserted below via cookiesSeen). This models an
    // invalid/expired-account case a re-login can't fix. Gating success on the mere
    // *count* of prior calls (as the export-based test above does) can't tell a
    // correctly-bounded client from an unbounded one: with that mock both only ever
    // need one retry to succeed, so a client that dropped the `retry: false` bound and
    // kept retrying forever would still pass. Persisting the 403 regardless of the
    // (valid) cookie is what forces a bounded client to give up and an unbounded one to
    // recurse forever.
    return { ok: false, status: 403 };
  });
  await expect(q.torrent('abc')).rejects.toThrow('HTTP 403');
  // The retry did carry the session the re-login obtained ...
  expect(cookiesSeen).toEqual([undefined, 'SID=abc123']);
  // ... but the client gave up after exactly one re-login, not more.
  expect(calls.filter((c) => c.includes('auth/login')).length).toBe(1);
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
