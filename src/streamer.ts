// Serves a (possibly still downloading) torrent file over HTTP with Range support.
// Bytes are only sent once qBittorrent reports the piece holding them as complete.

import { once } from 'node:events';
import type { Stats } from 'node:fs';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const TYPES: Record<string, string> = {
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.wmv': 'video/x-ms-wmv',
};

const FIRST_BYTES_WAIT_MS = 25_000;
const PIECE_WAIT_MS = 120_000;
const POLL_MS = 700;
const CHUNK = 1 << 20;

export type Range = { start: number; end: number };

export function parseRange(header: string | undefined, size: number): Range | 'invalid' | null {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return 'invalid';
  const rawStart = m[1] ?? '';
  const rawEnd = m[2] ?? '';
  if (rawStart === '' && rawEnd === '') return 'invalid';
  let start: number;
  let end: number;
  if (rawStart === '') {
    start = Math.max(0, size - Number(rawEnd));
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

export const pieceAt = (fileOffset: number, pos: number, pieceLength: number): number => Math.floor((fileOffset + pos) / pieceLength);

// The slice of QBit that piece-gating reads.
export interface PieceStateSource {
  pieceStates(hash: string): Promise<number[]>;
}

// One shared, briefly cached pieceStates poll per torrent.
class Pieces {
  qbit: PieceStateSource;
  hash: string;
  states: number[];
  at: number;
  pending: Promise<void> | null;

  constructor(qbit: PieceStateSource, hash: string) {
    this.qbit = qbit;
    this.hash = hash;
    this.states = [];
    this.at = 0;
    this.pending = null;
  }

  async refresh(): Promise<void> {
    if (Date.now() - this.at < 1000) return;
    this.pending ??= this.qbit
      .pieceStates(this.hash)
      .then((s) => {
        this.states = s;
        this.at = Date.now();
      })
      .finally(() => {
        this.pending = null;
      });
    await this.pending;
  }

  async waitFor(piece: number, timeoutMs: number, isClosed: () => boolean, pollMs: number = POLL_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.refresh();
      } catch {
        // A transient qBittorrent hiccup mid-stream must not end the response early;
        // keep polling on the last known states and retry until the deadline instead.
      }
      if (this.states[piece] === 2) return true;
      if (isClosed() || Date.now() > deadline) return false;
      await sleep(pollMs);
    }
  }
}

const watchers = new Map<string, Pieces>();
function piecesFor(qbit: PieceStateSource, hash: string): Pieces {
  let p = watchers.get(hash);
  if (!p) {
    p = new Pieces(qbit, hash);
    watchers.set(hash, p);
  }
  return p;
}

async function waitForFile(path: string, isClosed: () => boolean, timeoutMs: number, pollMs: number = POLL_MS): Promise<Stats | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await stat(path);
    } catch {
      if (isClosed() || Date.now() > deadline) return null;
      await sleep(pollMs);
    }
  }
}

export interface Waits {
  firstBytes?: number;
  piece?: number;
  poll?: number;
}

export interface ServeFileTarget {
  qbit: PieceStateSource;
  hash: string;
  path: string;
  size: number;
  offset: number;
  pieceLength: number;
  complete: boolean;
  waits?: Waits;
}

export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  f: ServeFileTarget,
  log: (message: string) => void,
): Promise<void> {
  const { qbit, hash, path, size, offset, pieceLength, complete, waits } = f;
  const { firstBytes = FIRST_BYTES_WAIT_MS, piece: pieceWaitMs = PIECE_WAIT_MS, poll = POLL_MS } = waits ?? {};
  let closed = false;
  const onClose = once(res, 'close').then(() => {
    closed = true;
  });
  const isClosed = () => closed;

  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const headers: OutgoingHttpHeaders = {
    'Accept-Ranges': 'bytes',
    'Content-Type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': end - start + 1,
    ...(range && { 'Content-Range': `bytes ${start}-${end}/${size}` }),
  };
  const status = range ? 206 : 200;

  if (req.method === 'HEAD') {
    res.writeHead(status, headers);
    res.end();
    return;
  }

  if (complete) {
    if (!(await stat(path).catch(() => null))) throw new Error(`file missing on disk: ${path}`);
    res.writeHead(status, headers);
    const rs = createReadStream(path, { start, end });
    rs.pipe(res);
    rs.on('error', (e) => {
      log(`play: ${e.message}`);
      res.destroy();
    });
    return;
  }

  const pieces = piecesFor(qbit, hash);
  const ready =
    (await waitForFile(path, isClosed, firstBytes, poll)) &&
    (await pieces.waitFor(pieceAt(offset, start, pieceLength), firstBytes, isClosed, poll));
  if (!ready) {
    if (!closed) {
      log(`play: first bytes not ready for ${path} @${start}`);
      res.writeHead(503, { 'Retry-After': '30', 'Content-Type': 'text/plain' });
      res.end('Still downloading - try again in a minute.');
    }
    return;
  }

  res.writeHead(status, headers);
  const fh = await open(path, 'r');
  try {
    let pos = start;
    while (pos <= end && !closed) {
      const piece = pieceAt(offset, pos, pieceLength);
      if (!(await pieces.waitFor(piece, pieceWaitMs, isClosed, poll))) break;
      const pieceEnd = (piece + 1) * pieceLength - offset - 1;
      const stop = Math.min(end, pieceEnd);
      // pieceEnd is the last file byte the piece just waited for covers, so it can only be
      // below `pos` if the piece index and the byte range disagree - which the arithmetic
      // above cannot produce, and only a regression in pieceAt() could. Guarding it is
      // still worth three lines: `pos` would never advance, and the loop would spin on an
      // await that resolves immediately, starving the event loop - a pegged core in
      // production, and in the test suite a hang that no test timeout can interrupt
      // (timers are macrotasks; nothing here yields to one). Breaking turns that into the
      // stall this loop already knows how to report.
      if (stop < pos) {
        log(`play: piece ${piece} does not cover byte ${pos} of ${path} (offset ${offset}, piece length ${pieceLength})`);
        break;
      }
      while (pos <= stop && !closed) {
        const len = Math.min(CHUNK, stop - pos + 1);
        const { bytesRead, buffer } = await fh.read(Buffer.allocUnsafe(len), 0, len, pos);
        if (!bytesRead) throw new Error('short read');
        pos += bytesRead;
        if (!res.write(bytesRead === len ? buffer : buffer.subarray(0, bytesRead))) {
          await Promise.race([once(res, 'drain'), onClose]);
        }
      }
    }
    if (pos <= end && !closed) log(`play: stalled at ${pos}/${size} in ${path}`);
  } catch (e) {
    const err = e as Error;
    log(`play: ${err.message}`);
  } finally {
    await fh.close();
    res.end();
  }
}
