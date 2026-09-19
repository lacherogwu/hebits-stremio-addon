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

// What JSON.parse handed back, for the "not an object" message below. Mirrors config.ts's
// typeOf(); duplicated rather than shared so store.ts keeps depending on nothing but
// node:fs, node:path and its own types.
function jsonKind(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export class Store {
  file: string;
  timezone: string;
  log: (message: string) => void;
  data: StoreData;
  // The constructor's load failure, if any, kept for /status to render beside
  // configIssues. null when state.json loaded cleanly (or was simply absent).
  //
  // Worth surfacing rather than only logging: grab.ts's daily() falls back to
  // grabsToday() exactly when Hebits' own counter is unreachable, so a wiped ledger means
  // the day's count restarts at zero and the daily limit can be exceeded - which has real
  // consequences on this tracker. The Notifier doesn't exist yet when this runs, so a line
  // in addon.log would otherwise be the only trace.
  loadIssue: string | null;

  // log: this is a cache and event log, not the source of truth (qBittorrent is), so a
  // failed save must never crash the process. It logs loudly instead and returns false.
  // The load side has to honour that same rule: this constructor runs before the Notifier
  // exists (see server.ts), so an uncaught throw here is the identical silent launchd
  // restart loop that config.ts's loadConfig() guards against. A corrupt state.json is
  // moved aside rather than left to be silently overwritten by the next save() - the
  // documented fallback ({ grabs: [], torrents: {} }) is safe to run with (today's
  // fallback download count resets to zero; qBittorrent, the real source of truth, is
  // unaffected).
  constructor(dir: string, timezone: string, log: (message: string) => void = () => {}) {
    this.file = join(dir, 'state.json');
    this.timezone = timezone;
    this.log = log;
    this.data = { grabs: [], torrents: {} };
    this.loadIssue = null;
    if (existsSync(this.file)) {
      try {
        // A parse that succeeds is not a state file: `null` and `42` parse fine, so the
        // catch below never fires, and then server.ts's `store.data.notified ??= {}`
        // throws at module load - before the Notifier exists, which is the one thing this
        // constructor's comment promises cannot happen. An array parses too and quietly
        // loses every property written to it. All of them take the corrupt-file path.
        const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          throw new Error(`it holds a JSON ${jsonKind(parsed)}, not an object`);
        this.data = parsed as StoreData;
      } catch (e) {
        const badPath = `${this.file}.bad-${Date.now()}`;
        try {
          renameSync(this.file, badPath);
          this.note(
            `store: state.json could not be loaded (${(e as Error).message}) - moved aside to ${badPath}; today's grab count starts over`,
          );
        } catch (renameError) {
          this.note(
            `store: state.json could not be loaded (${(e as Error).message}) and could not be moved aside (${(renameError as Error).message}) - running with an empty in-memory store; state.json left untouched`,
          );
        }
      }
    }
  }

  // Log it AND keep it: see loadIssue. Both callers are in the constructor.
  private note(message: string): void {
    this.log(message);
    this.loadIssue = message;
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
