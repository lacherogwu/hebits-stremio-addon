import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// CONFIG_DIR is captured at module load time from HEBITS_ADDON_DIR, so each test points
// the env var at a fresh mkdtempSync dir and resets the module cache before importing.
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hebits-addon-config-'));
  process.env.HEBITS_ADDON_DIR = dir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HEBITS_ADDON_DIR;
});

test('a token is generated once and is stable across loads', async () => {
  const { loadConfig } = await import('../src/config');
  const first = loadConfig().token;
  const second = loadConfig().token;
  expect(first).toBeTruthy();
  expect(second).toBe(first);
});

test('config.json is written mode 0600', async () => {
  const { loadConfig, CONFIG_DIR } = await import('../src/config');
  loadConfig();
  const mode = statSync(join(CONFIG_DIR, 'config.json')).mode & 0o777;
  expect(mode).toBe(0o600);
});

test('a missing cookie returns undefined rather than throwing', async () => {
  const { readCookie } = await import('../src/config');
  const path = join(dir, 'cookie.txt');
  expect(() => readCookie(path)).not.toThrow();
  expect(readCookie(path)).toBeUndefined();
});

test('an unreadable cookie (path is a directory) returns undefined rather than throwing', async () => {
  const { readCookie } = await import('../src/config');
  const path = join(dir, 'cookie-as-dir');
  mkdirSync(path);
  expect(() => readCookie(path)).not.toThrow();
  expect(readCookie(path)).toBeUndefined();
});

test('an unreadable cookie (permission denied) returns undefined rather than throwing', async () => {
  const { readCookie } = await import('../src/config');
  const path = join(dir, 'cookie.txt');
  writeFileSync(path, 'secret-cookie-value');
  chmodSync(path, 0o000);
  try {
    expect(() => readCookie(path)).not.toThrow();
    expect(readCookie(path)).toBeUndefined();
  } finally {
    chmodSync(path, 0o600); // restore so the temp dir can be cleaned up
  }
});

test('a written cookie round-trips and is mode 0600', async () => {
  const { readCookie, writeCookie } = await import('../src/config');
  const path = join(dir, 'nested', 'cookie.txt');
  writeCookie(path, '  my-session-cookie  ');
  expect(readCookie(path)).toBe('my-session-cookie');
  const mode = statSync(path).mode & 0o777;
  expect(mode).toBe(0o600);
});

test('the cookie never appears in config.json', async () => {
  const { loadConfig, writeCookie, CONFIG_DIR } = await import('../src/config');
  const cfg = loadConfig();
  writeCookie(cfg.cookiePath, 'super-secret-cookie-value');
  const raw = readFileSync(join(CONFIG_DIR, 'config.json'), 'utf8');
  expect(raw).not.toMatch(/super-secret-cookie-value/);
});

test('a bad field falls back to its default while other fields survive', async () => {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ minFreeGB: 'not-a-number', dailyLimit: 42 }));
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  expect(cfg.minFreeGB).toBe(20); // default
  expect(cfg.dailyLimit).toBe(42); // untouched
});

test('unknown keys are preserved, not rejected', async () => {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ someFutureKey: 'kept' }));
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig() as unknown as Record<string, unknown>;
  expect(cfg.someFutureKey).toBe('kept');
});

test('invalid fields are collected in configIssues', async () => {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ minFreeGB: 'not-a-number', qbitUrl: 123 }));
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  expect(cfg.configIssues.length).toBe(2);
  expect(cfg.configIssues.some((m) => m.includes('minFreeGB'))).toBe(true);
  expect(cfg.configIssues.some((m) => m.includes('qbitUrl'))).toBe(true);
});

test('configIssues is empty for a clean config', async () => {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ dailyLimit: 5 }));
  const { loadConfig } = await import('../src/config');
  expect(loadConfig().configIssues).toEqual([]);
});

test('a bad nested notify field falls back while the rest of notify survives', async () => {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ notify: { webhookUrl: 123, extra: 'kept' } }));
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig() as unknown as { notify: Record<string, unknown> };
  expect(cfg.notify.webhookUrl).toBe(''); // default
  expect(cfg.notify.extra).toBe('kept');
});

// A hand-edited config.json that fails to parse must not throw at module load - that runs
// before launchd's KeepAlive would notice a crash, and before the notifier exists, so an
// uncaught throw here becomes a silent restart loop (see the comment in loadConfig()).
// It also must not be silently overwritten: an earlier fix replaced the throw with exactly
// that (the token block ran through and clobbered config.json with just a fresh token,
// losing every other setting AND rotating the token under every installed client), so this
// asserts the file-on-disk property directly rather than just a configIssues substring -
// a message mentioning "config.json" would have passed the old (too weak) version of this
// test even while the bug was live.
test('malformed JSON in config.json is moved aside, not silently destroyed', async () => {
  const original = '{ "port": 7001, "qbitUsername": "alice", "notify": { "webhookUrl": "https://example.com/hook" }, "token": "original-token-value"';
  writeFileSync(join(dir, 'config.json'), original);
  const { loadConfig, CONFIG_DIR } = await import('../src/config');
  let cfg: ReturnType<typeof loadConfig> | undefined;
  expect(() => {
    cfg = loadConfig();
  }).not.toThrow();

  // The operator's original bytes must survive intact under a renamed path.
  const badFile = readdirSync(CONFIG_DIR).find((f) => f.startsWith('config.json.bad-'));
  expect(badFile).toBeTruthy();
  expect(readFileSync(join(CONFIG_DIR, badFile as string), 'utf8')).toBe(original);

  // config.json itself is a fresh, valid file - not the operator's settings minus
  // everything but a token, and not the old (unrecoverable-from-broken-JSON) token either.
  const rewritten = JSON.parse(readFileSync(join(CONFIG_DIR, 'config.json'), 'utf8'));
  expect(rewritten.token).toBeTruthy();
  expect(rewritten.token).not.toBe('original-token-value');
  expect(cfg?.token).toBe(rewritten.token);

  expect(cfg?.configIssues.some((m) => m.includes(badFile as string))).toBe(true);
});

// A typo is the expected way config.json breaks (it's hand-edited), so rotating the token
// on every one of them is a real, frequent cost: every installed Stremio/Nuvio client's URL
// dies until the operator notices, finds the .bad- file, fixes the comma, and restores it -
// painful to redo on a TV client. Salvaging a shape-valid token out of the unparseable text
// turns a typo into "service keeps running, clients keep working" instead.
test('malformed config.json with a shape-valid token keeps that token, unchanged, in the fresh file', async () => {
  const validToken = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'; // 32 lowercase hex chars - loadConfig()'s own shape
  const original = `{ "port": 7001, "token": "${validToken}"`; // truncated: still unparseable
  writeFileSync(join(dir, 'config.json'), original);
  const { loadConfig, CONFIG_DIR } = await import('../src/config');
  const cfg = loadConfig();

  expect(cfg.token).toBe(validToken);
  const rewritten = JSON.parse(readFileSync(join(CONFIG_DIR, 'config.json'), 'utf8'));
  expect(rewritten.token).toBe(validToken);

  // Still moved aside, still byte-identical - the salvage doesn't change that half at all.
  const badFile = readdirSync(CONFIG_DIR).find((f) => f.startsWith('config.json.bad-'));
  expect(badFile).toBeTruthy();
  expect(readFileSync(join(CONFIG_DIR, badFile as string), 'utf8')).toBe(original);
  expect(cfg.configIssues.some((m) => m.includes('kept its token'))).toBe(true);
});

test('malformed config.json with no token-shaped value gets a fresh token, original still preserved', async () => {
  const original = '{ "port": 7001, "token": "not-a-hex-token"'; // truncated, and not 32 hex chars
  writeFileSync(join(dir, 'config.json'), original);
  const { loadConfig, CONFIG_DIR } = await import('../src/config');
  const cfg = loadConfig();

  expect(cfg.token).toBeTruthy();
  expect(cfg.token).not.toBe('not-a-hex-token');
  expect(cfg.token).toMatch(/^[0-9a-f]{32}$/);

  const badFile = readdirSync(CONFIG_DIR).find((f) => f.startsWith('config.json.bad-'));
  expect(badFile).toBeTruthy();
  expect(readFileSync(join(CONFIG_DIR, badFile as string), 'utf8')).toBe(original);
  expect(cfg.configIssues.some((m) => m.includes('kept its token'))).toBe(false);
});

test('a config.json that cannot even be moved aside runs from in-memory defaults, file untouched', async () => {
  const original = '{ this is not valid json';
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, original);
  chmodSync(dir, 0o500); // read+exec only: renameSync into/out of it fails with EACCES
  try {
    const { loadConfig } = await import('../src/config');
    let cfg: ReturnType<typeof loadConfig> | undefined;
    expect(() => {
      cfg = loadConfig();
    }).not.toThrow();
    expect(cfg?.token).toBeTruthy(); // still usable this run, just never written to disk
    expect(cfg?.configIssues.some((m) => m.includes('could not be moved aside'))).toBe(true);
  } finally {
    chmodSync(dir, 0o700); // restore so the temp dir can be cleaned up
  }
  expect(readFileSync(cfgPath, 'utf8')).toBe(original); // left exactly as it was
  expect(existsSync(join(dir, 'config.json.bad-'))).toBe(false);
});

// deploy/config.example.json's own torrentDir has crashed the service into a launchd
// restart loop before (an unguarded mkdirSync threw ENOENT for a path macOS can't create) -
// this pins that a bad custom torrentDir falls back to the default instead.
test('an uncreatable torrentDir falls back to the default and is recorded in configIssues', async () => {
  const blocker = join(dir, 'blocker'); // a file, not a directory
  writeFileSync(blocker, 'not a directory');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ torrentDir: join(blocker, 'torrents') }));
  const { loadConfig, CONFIG_DIR } = await import('../src/config');
  let cfg: ReturnType<typeof loadConfig> | undefined;
  expect(() => {
    cfg = loadConfig();
  }).not.toThrow();
  expect(cfg?.torrentDir).toBe(join(CONFIG_DIR, 'torrents'));
  expect(cfg?.configIssues.some((m) => m.includes('torrentDir'))).toBe(true);
  expect(() => statSync(cfg?.torrentDir as string)).not.toThrow();
});
