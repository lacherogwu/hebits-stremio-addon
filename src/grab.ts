// Turning a Hebits id into a running torrent: download the .torrent through hebits-client,
// add it to qBittorrent, and write the identity down as tags.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readTorrent, type Torrent } from './bencode';
import { makeLock } from './lock';
import type { DailyLimitConfig, Store, TorrentEntry } from './store';
import { buildTags } from './tags';

const GB = 1024 ** 3;

export class UserError extends Error {}

// The slice of Config that ensureTorrent/daily need.
export interface GrabConfig extends DailyLimitConfig {
  minFreeGB: number;
  torrentDir: string;
  watchCategory: string;
  watchPath: string;
}

// The slice of hebits-client's Hebits that this module reads. Kept narrow (rather than
// importing the class) so a test fake needs no `as any` to stand in for it. Note
// `downloadTorrent` takes a NUMBER while every id on this side is a store-keyed string.
export interface GrabHebits {
  downloadTorrent(id: number): Promise<Uint8Array>;
  dailyDownloads(): Promise<{ used: number; limit: number }>;
}

// The slice of QBit that ensureTorrent reads. The resolved value of `torrent()` is only
// ever used for its truthiness here, so it stays `unknown`.
export interface GrabQBit {
  torrent(hash: string): Promise<unknown>;
  ensureCategory(name: string, savePath: string): Promise<void>;
  add(buf: Buffer, filename: string, opts: { category: string; savePath: string }): Promise<unknown>;
  addTags(hash: string, tags: string[]): Promise<unknown>;
  freeSpace(): Promise<number | undefined>;
}

export interface GrabDeps {
  cfg: GrabConfig;
  store: Store;
  hebits: GrabHebits;
  qbit: GrabQBit;
  log: (message: string) => void;
}

export interface EnsureTorrentOptions {
  category?: string;
  savePath?: string;
}

export function makeGrabber({ cfg, store, hebits, qbit, log }: GrabDeps) {
  const withLock = makeLock();

  // Downloads used/allowed today: Hebits' own counter when reachable, else local count.
  async function daily(): Promise<{ used: number; limit: number }> {
    try {
      // dailyDownloads() always reads through to the tracker (hebits-client passes
      // bypassCache), so the old `{ fresh: true }` argument is subsumed, not forgotten: a
      // cached count must never be what lets a download overspend the allowance.
      return await hebits.dailyDownloads();
    } catch (e) {
      log(`hebits daily downloads: ${(e as Error).message}`);
      return { used: store.grabsToday(), limit: store.limitToday(cfg) };
    }
  }

  // `hebitsId` is a store key, so it is a string everywhere on this side of the boundary.
  async function ensureTorrent(
    hebitsId: string,
    meta: Partial<TorrentEntry>,
    { category = cfg.watchCategory, savePath = cfg.watchPath }: EnsureTorrentOptions = {},
  ): Promise<TorrentEntry | undefined> {
    return withLock(hebitsId, async () => {
      const entry = store.torrent(hebitsId);
      if (entry?.hash && (await qbit.torrent(entry.hash))) {
        if (meta.imdb && !entry.imdb) {
          store.putTorrent(hebitsId, meta);
          await qbit
            .addTags(entry.hash, buildTags({ hebitsId, imdb: meta.imdb }))
            .catch((e: Error) => log(`tag ${hebitsId}: ${e.message}`));
        }
        return store.torrent(hebitsId);
      }

      const file = join(cfg.torrentDir, `hebits-${hebitsId}.torrent`);
      let buf: Uint8Array;
      if (existsSync(file)) {
        buf = readFileSync(file); // re-adding a torrent we already have doesn't touch Hebits
      } else {
        const d = await daily();
        if (d.used >= d.limit) throw new UserError('daily download limit reached');
        const free = await qbit.freeSpace();
        if (meta.size && free !== undefined && meta.size > free - cfg.minFreeGB * GB) throw new UserError('not enough disk space');
        buf = await hebits.downloadTorrent(Number(hebitsId));
        let parsed: Torrent;
        try {
          parsed = readTorrent(buf);
        } catch {
          throw new UserError(`Hebits refused the download: ${Buffer.from(buf).toString('utf8', 0, 200).replace(/\s+/g, ' ')}`);
        }
        // A hard refusal: a torrent without the private flag announces to the public DHT
        // and PEX, which would put this tracker's content into a public swarm.
        if (!parsed.private) throw new UserError('torrent is not private; refusing');
        writeFileSync(file, buf, { mode: 0o600 });
        store.recordGrab(hebitsId);
        log(`grabbed hebits ${hebitsId} (${meta.title}) into ${category}`);
      }

      const t = readTorrent(buf);
      await qbit.ensureCategory(category, savePath);
      if (!(await qbit.torrent(t.infoHash))) {
        await qbit.add(Buffer.from(buf), `hebits-${hebitsId}.torrent`, { category, savePath });
      }
      store.putTorrent(hebitsId, { ...meta, hash: t.infoHash, name: t.name, files: t.files, pieceLength: t.pieceLength });
      for (let i = 0; i < 40 && !(await qbit.torrent(t.infoHash)); i++) await sleep(250);
      // Identity for anything reading qBittorrent later, including the account builder.
      await qbit.addTags(t.infoHash, buildTags({ hebitsId, imdb: meta.imdb })).catch((e: Error) => log(`tag ${hebitsId}: ${e.message}`));
      return store.torrent(hebitsId);
    });
  }

  return { ensureTorrent, daily };
}
