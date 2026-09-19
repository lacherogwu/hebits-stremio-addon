import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { type FocusQBit, focusOn, makePlayer, type PlayHome, type PlayQBit, type PlayStore, type PlayTorrentMeta } from '../src/play';

function fakeStore(data: PlayStore['data'] = {}): PlayStore {
  return {
    data,
    save() {},
    // Never exercised by these tests directly (only handlePlayLocal is), but the type
    // checker sees the whole of makePlayer's body, including handlePlay's use of it.
    torrent() {
      return undefined;
    },
  };
}

// A real (but never-connected) req/res pair, for exercising a rejection path that never
// touches either beyond `.method`/`.headers` - avoids `as any`/`!` while still using the
// exact types play.ts's public API declares.
function fakeReqRes(method = 'GET'): { req: IncomingMessage; res: ServerResponse } {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = '/';
  req.headers = {};
  const res = new ServerResponse(req);
  return { req, res };
}

// --- focusOn: concurrent calls must not double-toggle sequential download (item 2) ---

test('two concurrent focusOn calls on one hash leave sequential download ON, not toggled back off', async () => {
  const hash = 'deadbeef';
  // The torrent's actual state on the "server": both toggles start off, like a fresh add.
  let seqOn = false;
  let flOn = false;
  const qfiles = [{ index: 0, name: 'Movie.2020.1080p.mkv', size: 100, progress: 0.2, priority: 1 }];
  const qbit: FocusQBit = {
    async files() {
      return qfiles;
    },
    async torrent() {
      // A real network round trip: without per-hash serialization, two concurrent
      // focusOn calls would both read this before either had applied its toggle.
      await new Promise((r) => setTimeout(r, 15));
      return {
        hash,
        name: 'Movie',
        tags: '',
        size: 100,
        progress: 0.2,
        state: 'downloading',
        category: '',
        piece_size: 16384,
        seq_dl: seqOn,
        f_l_piece_prio: flOn,
      };
    },
    async setFilePriority() {},
    // Mirrors the real QBit client/server contract: the API only *toggles* whatever the
    // torrent's actual state is right now, regardless of what the caller intended.
    async setSequential(_h, on, current) {
      if (Boolean(current) !== on) seqOn = !seqOn;
    },
    async setFirstLastPiecePrio(_h, on, current) {
      if (Boolean(current) !== on) flOn = !flOn;
    },
  };
  const store = fakeStore();

  await Promise.all([focusOn(qbit, store, hash, 0), focusOn(qbit, store, hash, 0)]);

  expect(seqOn).toBe(true);
  expect(flOn).toBe(true);
});

// --- streamTarget file matching (item 4) --------------------------------------------

function playerHarness({
  qfiles,
  target,
  size = 64,
}: {
  qfiles: { index: number; name: string; size: number; progress: number; priority: number }[];
  target: { path: string; length: number; offset: number };
  size?: number;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'hb-play-'));
  const data = Buffer.from(Array.from({ length: size }, (_, i) => i));
  for (const f of qfiles) {
    const path = join(dir, f.name);
    mkdirSync(join(dir, ...f.name.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(path, data);
  }
  const qbit: PlayQBit = {
    async files() {
      return qfiles;
    },
    async properties() {
      return { save_path: dir, piece_size: 16384 };
    },
    async torrent() {
      return {
        hash: 'h',
        name: 'Movie',
        tags: '',
        size,
        progress: 1,
        state: 'uploading',
        category: '',
        piece_size: 16384,
        seq_dl: false,
        f_l_piece_prio: false,
        content_path: undefined,
      };
    },
    async setFilePriority() {},
    async setSequential() {},
    async setFirstLastPiecePrio() {},
    async pieceStates() {
      return [];
    },
  };
  const store = fakeStore();
  const home: PlayHome = {
    async byHash(hash) {
      return { hash, name: 'Movie', files: [] };
    },
  };
  const torrentMeta: PlayTorrentMeta = {
    async get() {
      return { files: [target], pieceLength: 16384 };
    },
  };
  const player = makePlayer({
    cfg: { watchCategory: 'watch' },
    store,
    qbit,
    home,
    torrentMeta,
    ensureTorrent: async () => undefined,
    cachedItem: () => undefined,
    log: () => {},
  });
  return { player, data };
}

async function fetchLocal(player: ReturnType<typeof makePlayer>, hash: string) {
  const server = createServer((req, res) => {
    player.handlePlayLocal(req, res, hash, undefined, undefined).catch(() => res.destroy());
  });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
  } finally {
    server.close();
  }
}

test('exact-name match also requires the size to agree', async () => {
  const target = { path: 'Movie.2020.1080p.mkv', length: 64, offset: 0 };
  const qfiles = [{ index: 0, name: 'Movie.2020.1080p.mkv', size: 999, progress: 1, priority: 1 }];
  const { player } = playerHarness({ qfiles, target });
  const { req, res } = fakeReqRes();
  await expect(player.handlePlayLocal(req, res, 'h1', undefined, undefined)).rejects.toThrow(/file not found/);
});

test('the basename+size fallback refuses an ambiguous match', async () => {
  const target = { path: 'Show/Show.S01E01.mkv', length: 64, offset: 0 };
  const qfiles = [
    { index: 0, name: 'Other/Show.S01E01.mkv', size: 64, progress: 1, priority: 1 },
    { index: 1, name: 'Another/Show.S01E01.mkv', size: 64, progress: 1, priority: 1 },
  ];
  const { player } = playerHarness({ qfiles, target });
  const { req, res } = fakeReqRes();
  await expect(player.handlePlayLocal(req, res, 'h2', undefined, undefined)).rejects.toThrow(/file not found/);
});

test('the basename+size fallback matches when exactly one candidate qualifies', async () => {
  const target = { path: 'Show/Show.S01E01.mkv', length: 64, offset: 0 };
  const qfiles = [{ index: 0, name: 'Renamed/Show.S01E01.mkv', size: 64, progress: 1, priority: 1 }];
  const { player, data } = playerHarness({ qfiles, target });
  const r = await fetchLocal(player, 'h3');
  expect(r.status).toBe(200);
  expect(r.body).toEqual(data);
});
