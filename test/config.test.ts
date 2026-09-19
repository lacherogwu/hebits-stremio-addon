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
  const original =
    '{ "port": 7001, "qbitUsername": "alice", "notify": { "webhookUrl": "https://example.com/hook" }, "token": "original-token-value"';
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
  // A token was visibly in the file and did not survive - say why, or the operator is left
  // with every client URL dead and no explanation anywhere.
  expect(cfg.configIssues.some((m) => m.includes('not the expected 32-character lowercase-hex shape'))).toBe(true);
});

// salvageToken() runs a text search over a file that by definition doesn't parse, so it
// cannot tell nesting depth: `notify.headers` is a supported place for an operator to put
// an auth header literally named "token" (notify.ts reads headers/method/body/command),
// and a non-global regex takes whichever `"token"` comes first in the text. That is the
// whole hole - the shape check was never the weak part, position was. Here the nested one
// comes first and is not token-shaped, so the operator's real token must still be the one
// that survives.
test('a nested notify.headers.token ahead of the real one does not displace it', async () => {
  const realToken = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
  const original = `{ "notify": { "webhookUrl": "https://example.com/hook", "headers": { "token": "Bearer not-hex-at-all" } }, "token": "${realToken}"`;
  writeFileSync(join(dir, 'config.json'), original);
  const { loadConfig, CONFIG_DIR } = await import('../src/config');
  const cfg = loadConfig();

  expect(cfg.token).toBe(realToken);
  // Pin the post-state, not just the return value: this is what every installed client's
  // URL is read from on the next restart.
  const rewritten = JSON.parse(readFileSync(join(CONFIG_DIR, 'config.json'), 'utf8'));
  expect(rewritten.token).toBe(realToken);
  expect(cfg.configIssues.some((m) => m.includes('kept its token'))).toBe(true);
});

// The reported case: the nested header value IS 32 lowercase hex (an ordinary thing for a
// webhook auth header to be), so shape cannot separate it from the real token. Adopting
// either would be a guess, and the wrong guess silently hands the service's URL secret a
// value copied from a header that may be shared with another system while reporting the
// operator's token was kept. Two candidates must fall through to a fresh token.
test('two token-shaped candidates produce a fresh token rather than a guess', async () => {
  const headerToken = 'ffffffffffffffffffffffffffffffff';
  const realToken = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
  const original = `{ "notify": { "headers": { "token": "${headerToken}" } }, "token": "${realToken}"`;
  writeFileSync(join(dir, 'config.json'), original);
  const { loadConfig, CONFIG_DIR } = await import('../src/config');
  const cfg = loadConfig();

  expect(cfg.token).not.toBe(headerToken);
  expect(cfg.token).not.toBe(realToken);
  expect(cfg.token).toMatch(/^[0-9a-f]{32}$/);
  const rewritten = JSON.parse(readFileSync(join(CONFIG_DIR, 'config.json'), 'utf8'));
  expect(rewritten.token).toBe(cfg.token);
  expect(cfg.configIssues.some((m) => m.includes('kept its token'))).toBe(false);
  expect(cfg.configIssues.some((m) => m.includes('none could be trusted'))).toBe(true);

  // The original is still recoverable, so the real token is not lost - just not guessed at.
  const badFile = readdirSync(CONFIG_DIR).find((f) => f.startsWith('config.json.bad-'));
  expect(readFileSync(join(CONFIG_DIR, badFile as string), 'utf8')).toBe(original);
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
  // Glob, not a literal name: `config.json.bad-` with no timestamp is a file no
  // implementation ever writes, so asserting its absence passes unconditionally - including
  // against an implementation that did wrongly move the file aside.
  expect(readdirSync(dir).find((f) => f.startsWith('config.json.bad-'))).toBeUndefined();
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

// loadConfig() runs at module load under a KeepAlive LaunchAgent, before the notifier
// exists, so every one of the three tests below is pinning the same property: an uncaught
// throw here is not a crash the owner hears about, it is a silent 10-second restart loop.
// Each uses a real OS error rather than a mocked fs - EISDIR in particular is not a thing
// a reasonable fs mock produces, and it is exactly what a directory left in config.json's
// place gives.

test('an unreadable config.json (permission denied) does not throw and is left untouched', async () => {
  const original = '{ "dailyLimit": 3, "token": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" }\n';
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, original);
  chmodSync(cfgPath, 0o000); // EACCES: e.g. left behind by a single sudo run
  const { loadConfig } = await import('../src/config');
  let cfg: ReturnType<typeof loadConfig> | undefined;
  try {
    expect(() => {
      cfg = loadConfig();
    }).not.toThrow();
  } finally {
    chmodSync(cfgPath, 0o600); // restore so the bytes can be read back (and cleaned up)
  }

  // Post-state, which is the half that matters: a file we could not read must not be
  // rewritten - that would destroy bytes we never saw - and must not be moved aside.
  expect(readFileSync(cfgPath, 'utf8')).toBe(original);
  expect(readdirSync(dir).find((f) => f.startsWith('config.json.bad-'))).toBeUndefined();

  expect(cfg?.dailyLimit).toBe(10); // nothing was read, so nothing was applied
  expect(cfg?.token).toMatch(/^[0-9a-f]{32}$/); // usable this session, in memory only
  expect(cfg?.configIssues.some((m) => m.includes('could not be read'))).toBe(true);
});

test('a config.json that is a directory (EISDIR) does not throw and is left in place', async () => {
  const cfgPath = join(dir, 'config.json');
  mkdirSync(cfgPath); // existsSync() is true, readFileSync() throws EISDIR
  writeFileSync(join(cfgPath, 'marker'), 'still here');
  const { loadConfig } = await import('../src/config');
  let cfg: ReturnType<typeof loadConfig> | undefined;
  expect(() => {
    cfg = loadConfig();
  }).not.toThrow();

  expect(statSync(cfgPath).isDirectory()).toBe(true);
  expect(readFileSync(join(cfgPath, 'marker'), 'utf8')).toBe('still here');
  expect(cfg?.token).toMatch(/^[0-9a-f]{32}$/);
  expect(cfg?.configIssues.some((m) => m.includes('could not be read'))).toBe(true);
});

// Reachable on a completely ordinary config: no config.json at all, config dir not
// writable. existsSync() is false, so none of the malformed-file paths run - a token is
// generated with canWrite still true and the write itself is what throws.
test('an unwritable config dir with no config.json runs from an in-memory token', async () => {
  chmodSync(dir, 0o500); // read+exec only: creating config.json in it fails with EACCES
  const { loadConfig } = await import('../src/config');
  let cfg: ReturnType<typeof loadConfig> | undefined;
  try {
    expect(() => {
      cfg = loadConfig();
    }).not.toThrow();
  } finally {
    chmodSync(dir, 0o700); // restore so the temp dir can be cleaned up
  }

  expect(cfg?.token).toMatch(/^[0-9a-f]{32}$/);
  expect(existsSync(join(dir, 'config.json'))).toBe(false); // nothing half-landed
  expect(cfg?.configIssues.some((m) => m.includes('could not be written'))).toBe(true);
});

// The negative half of the write condition, which has now been edited in three consecutive
// rounds: a healthy config.json must come out of loadConfig() byte-identical. The fixture
// is deliberately formatted the way loadConfig() would NOT write it (compact, no trailing
// newline), so a rewrite that happened to preserve every value still fails here.
test('a healthy config.json is left byte-identical', async () => {
  const token = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
  const original = `{"dailyLimit":7,"qbitUsername":"alice","token":"${token}"}`;
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, original);
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();

  expect(cfg.token).toBe(token);
  expect(cfg.dailyLimit).toBe(7);
  expect(cfg.configIssues).toEqual([]);
  expect(readFileSync(cfgPath, 'utf8')).toBe(original);
  expect(readdirSync(dir).find((f) => f.startsWith('config.json.bad-'))).toBeUndefined();
});

// The read guard has two halves, and this pins the second one on its own: a file we could
// not read must also stop the write below. A write-only config.json separates them - the
// read fails, the write would succeed - so without `canWrite = false` the operator's file
// is replaced by nothing but a fresh token, which is the same destruction the move-aside
// path exists to prevent, reached by a different route.
test('a config.json that can be written but not read is not rewritten', async () => {
  const original = '{ "dailyLimit": 3, "token": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" }\n';
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, original);
  chmodSync(cfgPath, 0o200); // write-only: readFileSync EACCES, writeFileSync would work
  const { loadConfig } = await import('../src/config');
  let cfg: ReturnType<typeof loadConfig> | undefined;
  try {
    expect(() => {
      cfg = loadConfig();
    }).not.toThrow();
  } finally {
    chmodSync(cfgPath, 0o600);
  }

  expect(readFileSync(cfgPath, 'utf8')).toBe(original);
  expect(cfg?.configIssues.some((m) => m.includes('could not be read'))).toBe(true);
  expect(cfg?.configIssues.some((m) => m.includes('could not be written'))).toBe(false);
});

// JSON.parse succeeding is not the same as getting a config back. Each of these parses
// cleanly, so none of the guards above ever fires; `null`, a number, a string and `true`
// then throw a TypeError at `saved.token` (and would throw again at the two `in` checks
// further down), which is the silent KeepAlive restart loop again. They must all land in
// the corrupt-file path that already exists.
for (const [label, body] of [
  ['null', 'null'],
  ['a number', '42'],
  ['a string', '"hello"'],
  ['a boolean', 'true'],
  ['an array', '[1,2]'],
] as const) {
  test(`config.json holding ${label} is moved aside, not left to throw at module load`, async () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, body);
    const { loadConfig, CONFIG_DIR } = await import('../src/config');
    let cfg: ReturnType<typeof loadConfig> | undefined;
    expect(() => {
      cfg = loadConfig();
    }).not.toThrow();

    // Same post-state as any other unusable config.json: original preserved byte-identically
    // under a timestamped name, a fresh usable file in its place, and a named issue.
    const badFile = readdirSync(CONFIG_DIR).find((f) => f.startsWith('config.json.bad-'));
    expect(badFile).toBeTruthy();
    expect(readFileSync(join(CONFIG_DIR, badFile as string), 'utf8')).toBe(body);

    const rewritten = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(Array.isArray(rewritten)).toBe(false);
    expect(typeof rewritten).toBe('object');
    expect(rewritten.token).toBe(cfg?.token);
    expect(cfg?.token).toMatch(/^[0-9a-f]{32}$/);
    expect(cfg?.configIssues.some((m) => m.includes(badFile as string))).toBe(true);
    expect(cfg?.configIssues.some((m) => m.includes('not an object of settings'))).toBe(true);
  });
}

// The array case deserves its own pin, because it is the one that does NOT throw:
// JSON.stringify drops a `token` property set on an array, so an unguarded run rewrites
// config.json as the same array and mints a token that is lost again on the next restart -
// which presents as clients intermittently failing to authenticate, i.e. as a network
// fault. Two loads in a row is what tells a stable token from a rotating one.
test('a config.json holding an array does not rotate the token on every load', async () => {
  writeFileSync(join(dir, 'config.json'), '[1,2]');
  const { loadConfig } = await import('../src/config');
  const first = loadConfig().token;
  const second = loadConfig().token;
  expect(first).toMatch(/^[0-9a-f]{32}$/);
  expect(second).toBe(first);
});
