// Serves a (possibly still downloading) torrent file over HTTP with Range support.
// Bytes are only sent once qBittorrent reports the piece holding them as complete.
import { open, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import { extname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const TYPES = {
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

export function parseRange(header, size) {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start, end;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

export const pieceAt = (fileOffset, pos, pieceLength) => Math.floor((fileOffset + pos) / pieceLength);

// One shared, briefly cached pieceStates poll per torrent.
class Pieces {
  constructor(qbit, hash) {
    this.qbit = qbit;
    this.hash = hash;
    this.states = [];
    this.at = 0;
    this.pending = null;
  }

  async refresh() {
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

  async waitFor(piece, timeoutMs, isClosed, pollMs = POLL_MS) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.refresh();
      if (this.states[piece] === 2) return true;
      if (isClosed() || Date.now() > deadline) return false;
      await sleep(pollMs);
    }
  }
}

const watchers = new Map();
function piecesFor(qbit, hash) {
  if (!watchers.has(hash)) watchers.set(hash, new Pieces(qbit, hash));
  return watchers.get(hash);
}

async function waitForFile(path, isClosed, timeoutMs, pollMs = POLL_MS) {
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

export async function serveFile(req, res, f, log) {
  const { qbit, hash, path, size, offset, pieceLength, complete, waits } = f;
  const { firstBytes = FIRST_BYTES_WAIT_MS, piece: pieceWaitMs = PIECE_WAIT_MS, poll = POLL_MS } = waits || {};
  let closed = false;
  const onClose = once(res, 'close').then(() => (closed = true));
  const isClosed = () => closed;

  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream',
    'Content-Length': end - start + 1,
    ...(range && { 'Content-Range': `bytes ${start}-${end}/${size}` }),
  };
  const status = range ? 206 : 200;

  if (req.method === 'HEAD') {
    res.writeHead(status, headers);
    return res.end();
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
    log(`play: ${e.message}`);
  } finally {
    await fh.close();
    res.end();
  }
}
