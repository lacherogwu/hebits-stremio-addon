import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { focusOn, makePlayer } from '../lib/play.js';

function fakeStore(data = {}) {
  return { data, save() {} };
}

// --- focusOn: concurrent calls must not double-toggle sequential download (item 2) ---

test('two concurrent focusOn calls on one hash leave sequential download ON, not toggled back off', async () => {
  const hash = 'deadbeef';
  // The torrent's actual state on the "server": both toggles start off, like a fresh add.
  let seqOn = false;
  let flOn = false;
  const qfiles = [{ index: 0, name: 'Movie.2020.1080p.mkv', size: 100, progress: 0.2, priority: 1 }];
  const qbit = {
    async files() {
      return qfiles;
    },
    async torrent() {
      // A real network round trip: without per-hash serialization, two concurrent
      // focusOn calls would both read this before either had applied its toggle.
      await new Promise((r) => setTimeout(r, 15));
      return { seq_dl: seqOn, f_l_piece_prio: flOn };
    },
    async setFilePriority() {},
    // Mirrors the real QBit client/server contract: the API only *toggles* whatever the
    // torrent's actual state is right now, regardless of what the caller intended.
    async setSequential(h, on, current) {
      if (Boolean(current) !== on) seqOn = !seqOn;
    },
    async setFirstLastPiecePrio(h, on, current) {
      if (Boolean(current) !== on) flOn = !flOn;
    },
  };
  const store = fakeStore();

  await Promise.all([focusOn(qbit, store, hash, 0), focusOn(qbit, store, hash, 0)]);

  assert.equal(seqOn, true, 'sequential download must end up ON after two racing focusOn calls');
  assert.equal(flOn, true, 'single-video torrent: first/last-piece priority also ends up ON, not toggled back off');
});

// --- streamTarget file matching (item 4) --------------------------------------------

function playerHarness({ qfiles, target, size = 64 }) {
  const dir = mkdtempSync(join(tmpdir(), 'hb-play-'));
  const data = Buffer.from(Array.from({ length: size }, (_, i) => i));
  for (const f of qfiles) {
    const path = join(dir, f.name);
    mkdirSync(join(dir, ...f.name.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(path, data);
  }
  const qbit = {
    async files() {
      return qfiles;
    },
    async properties() {
      return { save_path: dir, piece_size: 16384 };
    },
    async torrent() {
      return { seq_dl: false, f_l_piece_prio: false, content_path: undefined };
    },
    async setFilePriority() {},
    async setSequential() {},
    async setFirstLastPiecePrio() {},
  };
  const store = fakeStore();
  const home = {
    async byHash(hash) {
      return { hash, name: 'Movie', files: [] };
    },
  };
  const torrentMeta = { async get() { return { files: [target], pieceLength: 16384 }; } };
  const player = makePlayer({
    cfg: { watchCategory: 'watch' },
    store,
    qbit,
    home,
    torrentMeta,
    ensureTorrent: async () => {},
    cachedItem: () => undefined,
    log: () => {},
  });
  return { player, data };
}

async function fetchLocal(player, hash) {
  const server = createServer((req, res) => player.handlePlayLocal(req, res, hash, undefined, undefined).catch(() => res.destroy()));
  await new Promise((r) => server.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
  } finally {
    server.close();
  }
}

test('exact-name match also requires the size to agree', async () => {
  const target = { path: 'Movie.2020.1080p.mkv', length: 64, offset: 0 };
  const qfiles = [{ index: 0, name: 'Movie.2020.1080p.mkv', size: 999, progress: 1, priority: 1 }];
  const { player } = playerHarness({ qfiles, target });
  await assert.rejects(() => player.handlePlayLocal({ method: 'GET', headers: {} }, {}, 'h1', undefined, undefined), /file not found/);
});

test('the basename+size fallback refuses an ambiguous match', async () => {
  const target = { path: 'Show/Show.S01E01.mkv', length: 64, offset: 0 };
  const qfiles = [
    { index: 0, name: 'Other/Show.S01E01.mkv', size: 64, progress: 1, priority: 1 },
    { index: 1, name: 'Another/Show.S01E01.mkv', size: 64, progress: 1, priority: 1 },
  ];
  const { player } = playerHarness({ qfiles, target });
  await assert.rejects(() => player.handlePlayLocal({ method: 'GET', headers: {} }, {}, 'h2', undefined, undefined), /file not found/);
});

test('the basename+size fallback matches when exactly one candidate qualifies', async () => {
  const target = { path: 'Show/Show.S01E01.mkv', length: 64, offset: 0 };
  const qfiles = [{ index: 0, name: 'Renamed/Show.S01E01.mkv', size: 64, progress: 1, priority: 1 }];
  const { player, data } = playerHarness({ qfiles, target });
  const r = await fetchLocal(player, 'h3');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, data);
});
