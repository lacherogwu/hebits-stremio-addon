// qBittorrent WebUI API. Authentication is optional: leave the credentials empty if
// "bypass authentication for clients on localhost" is enabled.

export interface QBitConfig {
  qbitUrl: string;
  qbitUsername?: string;
  qbitPassword?: string;
}

// The torrents/info entry shape, as read across this addon (home.js, play.js, grab.js).
export interface Torrent {
  hash: string;
  name: string;
  tags: string;
  size: number;
  progress: number;
  state: string;
  category: string;
  tracker?: string;
  magnet_uri?: string;
  piece_size: number;
  seq_dl: boolean;
  f_l_piece_prio: boolean;
  content_path?: string;
}

export interface QFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
}

export interface Properties {
  save_path: string;
  piece_size: number;
}

interface MainData {
  server_state?: { free_space_on_disk?: number };
}

interface AddOptions {
  category: string;
  savePath: string;
}

interface CallOptions {
  params?: Record<string, string>;
  form?: FormData | Record<string, string>;
  raw?: boolean;
  retry?: boolean;
}

export class QBit {
  base: string;
  username: string | undefined;
  password: string | undefined;
  sid: string | null;

  constructor({ qbitUrl, qbitUsername, qbitPassword }: QBitConfig) {
    this.base = `${qbitUrl}/api/v2`;
    this.username = qbitUsername;
    this.password = qbitPassword;
    this.sid = null;
  }

  // Only needed when "bypass authentication for localhost" is off.
  async login(): Promise<void> {
    if (!this.username) return;
    const res = await fetch(`${this.base}/auth/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: this.username, password: this.password || '' }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`qBittorrent login: HTTP ${res.status}`);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('SID='));
    if (!cookie) throw new Error('qBittorrent login: no session cookie returned');
    this.sid = cookie.split(';')[0] ?? null;
  }

  // `raw: true` returns the response body as a Buffer instead of parsing it as
  // text/JSON, for binary endpoints like torrents/export. It still goes through
  // this one request path, so it picks up session-cookie auth and 403 retry
  // rather than needing its own copy of that logic.
  async call<T = unknown>(path: string, { params, form, raw, retry = true }: CallOptions = {}): Promise<T> {
    const url = `${this.base}/${path}${params ? `?${new URLSearchParams(params)}` : ''}`;
    const init: RequestInit & { headers: Record<string, string> } = {
      signal: AbortSignal.timeout(raw ? 30_000 : 20_000),
      headers: {},
    };
    if (this.sid) init.headers.cookie = this.sid;
    if (form) {
      init.method = 'POST';
      init.body = form instanceof FormData ? form : new URLSearchParams(form);
    }
    const res = await fetch(url, init);
    if (res.status === 403 && this.username && retry) {
      await this.login();
      return this.call<T>(path, { params, form, raw, retry: false });
    }
    if (!res.ok) throw new Error(`qBittorrent ${path}: HTTP ${res.status}`);
    if (raw) return Buffer.from(await res.arrayBuffer()) as T;
    const text = await res.text();
    return (text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text) as T;
  }

  async torrent(hash: string): Promise<Torrent | undefined> {
    const [t] = await this.call<Torrent[]>('torrents/info', { params: { hashes: hash } });
    return t;
  }

  torrents(hashes: string[]): Promise<Torrent[]> {
    if (!hashes.length) return Promise.resolve([]);
    return this.call<Torrent[]>('torrents/info', { params: { hashes: hashes.join('|') } });
  }

  files(hash: string): Promise<QFile[]> {
    return this.call<QFile[]>('torrents/files', { params: { hash } });
  }

  pieceStates(hash: string): Promise<number[]> {
    return this.call<number[]>('torrents/pieceStates', { params: { hash } });
  }

  properties(hash: string): Promise<Properties> {
    return this.call<Properties>('torrents/properties', { params: { hash } });
  }

  async ensureCategory(name: string, savePath: string): Promise<void> {
    const cats = await this.call<Record<string, unknown>>('torrents/categories');
    if (!cats[name]) await this.call('torrents/createCategory', { form: { category: name, savePath } });
  }

  add(torrentBuf: Buffer, filename: string, { category, savePath }: AddOptions): Promise<unknown> {
    const form = new FormData();
    // Uint8Array.from copies into a plain ArrayBuffer-backed array: Buffer's own backing
    // store is typed as ArrayBufferLike (it may be a SharedArrayBuffer), which BlobPart
    // does not accept directly.
    form.append('torrents', new Blob([Uint8Array.from(torrentBuf)], { type: 'application/x-bittorrent' }), filename);
    form.append('category', category);
    form.append('savepath', savePath);
    return this.call('torrents/add', { form });
  }

  // Identity tags, so any tool reading qBittorrent later knows what this torrent is.
  addTags(hash: string, tags: string[]): Promise<unknown> {
    if (!tags?.length) return Promise.resolve(undefined);
    return this.call('torrents/addTags', { form: { hashes: hash, tags: tags.join(',') } });
  }

  // The original .torrent, for byte-exact file offsets. Routed through `call`
  // (not a bare fetch) so it carries the same auth as every other request.
  exportTorrent(hash: string): Promise<Buffer> {
    return this.call<Buffer>('torrents/export', { params: { hash }, raw: true });
  }

  setFilePriority(hash: string, ids: number[], priority: number): Promise<unknown> {
    if (!ids.length) return Promise.resolve(undefined);
    return this.call('torrents/filePrio', { form: { hash, id: ids.join('|'), priority: String(priority) } });
  }

  // The API only toggles; `current` is the torrent's seq_dl / f_l_piece_prio.
  async setSequential(hash: string, on: boolean, current: unknown): Promise<void> {
    if (Boolean(current) !== on) await this.call('torrents/toggleSequentialDownload', { form: { hashes: hash } });
  }

  async setFirstLastPiecePrio(hash: string, on: boolean, current: unknown): Promise<void> {
    if (Boolean(current) !== on) await this.call('torrents/toggleFirstLastPiecePrio', { form: { hashes: hash } });
  }

  all(): Promise<Torrent[]> {
    return this.call<Torrent[]>('torrents/info');
  }

  remove(hash: string): Promise<unknown> {
    return this.call('torrents/delete', { form: { hashes: hash, deleteFiles: 'true' } });
  }

  freeSpace(): Promise<number> {
    return this.call<MainData>('sync/maindata').then((d) => Number(d.server_state?.free_space_on_disk));
  }
}
