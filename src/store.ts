// Local cache and event log. NOT a source of truth: qBittorrent is. Deleting this file
// loses only today's fallback download count and any remembered identity lookups.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TorrentFile } from './bencode';

// What ensureTorrent/grab.js persists per Hebits id: identity known at grab time
// (imdb, type, title, size, fileCount, cover) plus the torrent layout once grabbed
// (hash, name, files, pieceLength) — see lib/grab.js and lib/play.js.
export interface TorrentEntry {
  imdb?: string;
  type?: string;
  title?: string;
  size?: number;
  fileCount?: number;
  cover?: string;
  hash?: string;
  name?: string;
  files?: TorrentFile[];
  pieceLength?: number;
}

// lib/play.js's focusOn/restoreFocus: what a torrent's file priority and
// sequential/first-last-piece flags looked like before this addon touched them.
export interface FocusEntry {
  file: number;
  at: number;
  seq: boolean;
  fl: boolean;
}

// lib/identity.js's IdentityResolver: a remembered hebitsId/imdb lookup and the
// backoff schedule for retrying an unresolved torrent.
export interface IdentityCacheEntry {
  hebitsId?: string;
  imdb?: string;
  attempts: number;
  nextTryAt: number;
}

export interface StoreData {
  grabs: { id: string; at: string }[];
  torrents: Record<string, TorrentEntry>;
  // Created on first use via `??=` in the modules that own them, so each is absent
  // from a fresh store.
  focus?: Record<string, FocusEntry>;
  identity?: Record<string, IdentityCacheEntry>;
  notified?: Record<string, number>;
}

// The slice of Config that limitToday() needs. Config itself is defined where it's loaded.
export interface DailyLimitConfig {
  dailyLimit: number;
  dailyLimitByDay?: Record<string, number>;
}

export function dayKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date);
}

export class Store {
  file: string;
  timezone: string;
  log: (message: string) => void;
  data: StoreData;

  // log: this is a cache and event log, not the source of truth (qBittorrent is), so a
  // failed save must never crash the process. It logs loudly instead and returns false.
  constructor(dir: string, timezone: string, log: (message: string) => void = () => {}) {
    this.file = join(dir, 'state.json');
    this.timezone = timezone;
    this.log = log;
    this.data = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as StoreData) : { grabs: [], torrents: {} };
  }

  save(): boolean {
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
      return true;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const reason = err.code === 'ENOSPC' ? 'disk full (ENOSPC)' : err.code || err.message;
      this.log(`store: failed to save ${this.file}: ${reason} - ${err.message}`);
      // The write may have partially landed, or landed but the rename failed; either way
      // this.file is untouched (the rename never happened), so clean up the leftover tmp.
      try {
        unlinkSync(tmp);
      } catch {
        // tmp may not exist (writeFileSync itself failed) - nothing to clean up then.
      }
      return false;
    }
  }

  limitToday(cfg: DailyLimitConfig, now: Date = new Date()): number {
    return cfg.dailyLimitByDay?.[dayKey(now, this.timezone)] ?? cfg.dailyLimit;
  }

  grabsToday(now: Date = new Date()): number {
    const today = dayKey(now, this.timezone);
    return this.data.grabs.filter((g) => dayKey(new Date(g.at), this.timezone) === today).length;
  }

  recordGrab(hebitsId: string, now: Date = new Date()): void {
    this.data.grabs.push({ id: hebitsId, at: now.toISOString() });
    // keep a month of history
    const cutoff = now.getTime() - 31 * 864e5;
    this.data.grabs = this.data.grabs.filter((g) => Date.parse(g.at) >= cutoff);
    this.save();
  }

  torrent(hebitsId: string): TorrentEntry | undefined {
    return this.data.torrents[hebitsId];
  }

  putTorrent(hebitsId: string, entry: Partial<TorrentEntry>): void {
    this.data.torrents[hebitsId] = { ...this.data.torrents[hebitsId], ...entry };
    this.save();
  }
}
