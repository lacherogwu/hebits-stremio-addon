import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
// Type-only: the notifier's own view of its options is the single source of truth for
// what config.json's "notify" object supports. `import type` keeps this erased, so
// config.ts gains no runtime dependency on notify.ts.
import type { NotifyConfig } from './notify';

const HOME = homedir();
export const CONFIG_DIR = process.env.HEBITS_ADDON_DIR || join(HOME, '.config', 'hebits-stremio-addon');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface Config {
  port: number;
  // Hebits Heb Rookie: 5 on day one, then 10. Raise when the account ranks up.
  dailyLimit: number;
  // Per-day exceptions, e.g. { "2026-09-17": 5 } for the account's first day.
  dailyLimitByDay: Record<string, number>;
  // Keep this much disk free after a download.
  minFreeGB: number;
  timezone: string;
  qbitUrl: string;
  // Only needed when "bypass authentication for localhost" is off.
  qbitUsername: string;
  qbitPassword: string;
  watchCategory: string;
  watchPath: string;
  // Alert transport. `webhookUrl` is the common case (a POST to Home Assistant, ntfy,
  // Discord, ...), but notify.ts also reads `method`, `headers` and `body` to shape that
  // request, and `command` to run a local argv instead - so the type is NotifyConfig
  // rather than just the URL. It was narrowed to { webhookUrl } before, which compiled
  // only because the narrow type is assignable to the notifier's wider one; the other
  // keys always worked at runtime (validateOptions spreads the received object), so this
  // widening documents existing behaviour and changes none of it.
  notify: NotifyConfig & { webhookUrl: string };
  torrentDir: string;
  logFile: string;
  // Where the Hebits login cookie lives. Defaults inside CONFIG_DIR so the repo is
  // self-contained, but an operator may point it at a file shared with another service.
  cookiePath: string;
  token: string;
  // Fields from config.json that failed validation and fell back to their default, one
  // message per field. Always present (empty when the file was clean) - see loadConfig().
  configIssues: string[];
}

const DEFAULTS: Omit<Config, 'token' | 'configIssues'> = {
  port: 7000,
  dailyLimit: 10,
  dailyLimitByDay: {},
  minFreeGB: 20,
  timezone: 'Asia/Jerusalem',
  qbitUrl: 'http://127.0.0.1:8080',
  qbitUsername: '',
  qbitPassword: '',
  watchCategory: 'watch',
  watchPath: join(HOME, 'hebits', 'watch'),
  notify: { webhookUrl: '' },
  torrentDir: join(CONFIG_DIR, 'torrents'),
  logFile: join(CONFIG_DIR, 'addon.log'),
  cookiePath: join(CONFIG_DIR, 'cookie.txt'),
};

// --- config.json validation -------------------------------------------------------------
// config.json is hand-edited. A typo (e.g. "minFreeGB": "20") must not stop the service
// starting: launchd restarts it with KeepAlive, so a throwing loadConfig() becomes a
// restart loop, and because the process dies before the notifier initialises the owner
// gets no alert - it's simply, silently down. That's worse than running with one wrong
// threshold. So every field is validated on its own: a bad one falls back to its default
// and is logged and recorded in configIssues; every other field - including keys this
// version of the code doesn't know about - is honoured untouched.

// Deliberately narrower than Config['notify']. validateOptions() below only *checks* the
// keys listed here; every other key on the received object survives untouched, which is
// how `method`, `headers`, `body` and `command` reach the notifier. Listing them here too
// would be a behaviour change (a wrong-typed `headers` would start falling back to the
// default instead of being passed through), so the shape stays as it is.
const notifyShape: Record<string, z.ZodType> = {
  webhookUrl: z.string(),
};

// Top-level scalar fields (everything in DEFAULTS except the nested notify object, which
// gets its own per-key validation below).
const fieldSchemas: Record<string, z.ZodType> = {
  port: z.number(),
  dailyLimit: z.number(),
  dailyLimitByDay: z.record(z.string(), z.number()),
  minFreeGB: z.number(),
  timezone: z.string(),
  qbitUrl: z.string(),
  qbitUsername: z.string(),
  qbitPassword: z.string(),
  watchCategory: z.string(),
  watchPath: z.string(),
  torrentDir: z.string(),
  logFile: z.string(),
  cookiePath: z.string(),
};

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function logIssue(msg: string, issues: string[]): void {
  console.error(`config: ${msg}`);
  issues.push(msg);
}

// Every token this module has ever generated is randomBytes(16).toString('hex') - 32
// lowercase hex characters. Accepting only that exact shape out of unparseable text is
// deliberate: this value flows straight into the URL guard (tokenOk() in server.ts), so a
// loosely-shaped "close enough" match would leave the service running with a token the
// operator can't know and can't discover from config.json (it's gone, moved aside). Better
// to fall through to a normal fresh token than to trust a garbled one.
const TOKEN_SHAPE = /^[0-9a-f]{32}$/;

// What salvageToken() decided, and the clause explaining it that loadConfig() appends to
// the parse-failure message. `note` is never empty except when the file contained no
// "token" key at all: a token that was visibly in the file but did not survive must say
// why, or the operator is left with a rotated token and no explanation.
interface Salvage {
  token?: string;
  note: string;
}

// Bounded on purpose: a single regex over the raw (unparseable) text, never an attempt to
// repair or partially parse the rest of the file. Used only when JSON.parse has already
// failed - see loadConfig(). A malformed config.json is the expected failure mode here (the
// file is hand-edited), and without this, every typo would rotate the token and break every
// already-installed Stremio/Nuvio client's URL until the operator notices and restores the
// file - on a TV client, painful. Salvaging the token turns that into: service keeps
// running, clients keep working, operator fixes the typo at leisure.
//
// Treat this as a trust boundary, not a parser. Its input is by definition a malformed
// file, and its output becomes the URL secret that tokenOk() in server.ts is the only
// thing standing between an internet-facing route and an unauthenticated caller. Two
// independent checks have to hold before a value is trusted:
//
//  - SHAPE. TOKEN_SHAPE above: exactly what randomBytes(16).toString('hex') produces.
//  - POSITION. The regex cannot tell nesting depth, so `"token"` at ANY depth matches -
//    and `notify.headers` is a supported place for an operator to put an auth header
//    literally named "token" (notify.ts reads headers/method/body/command). A non-global
//    match would take whichever came first in the text, which is how a webhook header's
//    value once became the service's URL secret while the code reported the operator's
//    token had been kept - every client URL dead, and the secret copied from a header
//    that may be shared with another system. So: collect every candidate, and salvage
//    only when exactly ONE is shape-valid. Zero or several fall through to a fresh
//    token, which is the already-correct default. Guessing between candidates is not an
//    option here - "first" and "last" are both wrong on some real file, silently.
function salvageToken(rawText: string): Salvage {
  const found: string[] = [];
  const valid: string[] = [];
  for (const match of rawText.matchAll(/"token"\s*:\s*"([^"]*)"/g)) {
    const candidate = match[1] ?? '';
    found.push(candidate);
    if (TOKEN_SHAPE.test(candidate)) valid.push(candidate);
  }
  const only = valid[0];
  if (valid.length === 1 && only !== undefined) return { token: only, note: ', kept its token so existing clients keep working' };
  if (valid.length > 1)
    return {
      note: `, and ${valid.length} token-shaped values were found in it so none could be trusted (a nested "token", e.g. a notify header, looks the same to a text search) - a fresh token was generated`,
    };
  if (found.length > 0)
    return { note: ', and the "token" in it is not the expected 32-character lowercase-hex shape - a fresh token was generated' };
  return { note: '' };
}

// One scalar top-level field. Returns the validated value, or undefined to fall back to
// DEFAULTS (the caller deletes the key so the DEFAULTS spread supplies it).
function validateScalar(key: string, schema: z.ZodType, fallback: unknown, received: unknown, issues: string[]): unknown {
  const result = schema.safeParse(received);
  if (result.success) return result.data;
  logIssue(`"${key}" is a ${typeOf(received)}, not the expected type - using default ${JSON.stringify(fallback)}`, issues);
  return undefined;
}

// One nested options object (notify), validated key by key against `shape`.
// - Not an object at all: the whole field falls back to its default.
// - A key in `shape` with the wrong type: that key falls back, the rest of the object -
//   including keys `shape` doesn't enumerate - survives untouched.
function validateOptions(
  name: string,
  shape: Record<string, z.ZodType>,
  // Any options object; only ever read as fallback[key] to name the default in a message.
  // Not Record<string, unknown>, so a caller can pass a precisely-typed default (such as
  // DEFAULTS.notify, whose NotifyConfig type has no index signature) without a cast.
  fallback: object,
  received: unknown,
  issues: string[],
): Record<string, unknown> {
  if (typeof received !== 'object' || received === null || Array.isArray(received)) {
    logIssue(`"${name}" is a ${typeOf(received)}, not an object - using default`, issues);
    return {};
  }
  const out: Record<string, unknown> = { ...(received as Record<string, unknown>) };
  const defaults = fallback as Record<string, unknown>;
  for (const [key, schema] of Object.entries(shape)) {
    if (!(key in out)) continue;
    const result = schema.safeParse(out[key]);
    if (!result.success) {
      logIssue(`"${name}.${key}" is a ${typeOf(out[key])}, not the expected type - using default ${JSON.stringify(defaults[key])}`, issues);
      delete out[key];
    }
  }
  return out;
}

export function loadConfig(): Config {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const configIssues: string[] = [];
  let saved: Record<string, unknown> = {};
  // Whether it's safe to write CONFIG_FILE below. Cleared when the existing file could not
  // be read at all, and when a malformed one couldn't even be moved aside - writing in
  // either case would overwrite operator bytes we never saw with nothing but a fresh
  // token, which is strictly worse than leaving the file in place untouched.
  let canWrite = true;
  // A hand-edited config.json that fails to parse (trailing comma, truncated write, ...)
  // must not throw here: this runs at module load, before the notifier exists, so an
  // uncaught throw becomes a silent launchd restart loop - see loadConfig()'s own comment
  // above validateScalar() for why every other field gets the same treatment. But treating
  // the parse failure as plain "no saved config" is worse than the throw it replaces: the
  // token block just below would then overwrite config.json with nothing but a fresh
  // token, destroying every other setting AND rotating the token under every
  // already-installed Stremio/Nuvio client - a typo silently costing the operator their
  // whole config and every client's URL. So move the broken file aside first; the
  // operator recovers by fixing the one bad character and restoring it.
  // Set once the broken file has been moved aside, so a salvaged token doesn't skip the
  // write below - config.json needs to exist again either way, and "token was already
  // truthy from salvage" is not the same signal as "nothing needs writing".
  let justRecovered = false;
  if (existsSync(CONFIG_FILE)) {
    // The read is inside the try for the same reason the parse is: a file that exists but
    // cannot be read throws just as fatally here (mode 000 after one sudo run, a directory
    // left in its place, a half-restored backup) and this runs at module load. It also has
    // to set canWrite = false - there is no text to salvage a token from, and rewriting a
    // file whose bytes we never saw is the same destruction the move-aside below exists to
    // prevent. Without that, guarding the read would only relocate the throw into the
    // writeFileSync further down.
    let raw: string | undefined;
    try {
      raw = readFileSync(CONFIG_FILE, 'utf8');
    } catch (e) {
      canWrite = false;
      logIssue(
        `config.json exists but could not be read (${(e as Error).message}) - running from in-memory defaults only, config.json left untouched`,
        configIssues,
      );
    }
    if (raw !== undefined) {
      try {
        // JSON.parse succeeding is not the same as getting a config back, and every guard
        // in this function until now caught only a parse FAILURE. `null`, a number, a
        // string and `true` all parse cleanly and then throw a TypeError on the very next
        // statement (`saved.token`), and would throw again at `key in saved` and
        // `'notify' in saved` - the `in` operator rejects primitives. That is the same
        // silent KeepAlive restart loop as an unguarded parse, through a different door.
        //
        // An array is worse precisely because it does NOT throw: JSON.stringify drops a
        // `token` property set on an array, so the file gets rewritten as the same array,
        // a fresh token is generated, and it is lost again on every single restart. To the
        // owner that looks like clients intermittently failing to authenticate - a
        // networking fault, not a config one.
        //
        // None of these is a config, so they all take the corrupt-file path below rather
        // than getting a recovery mechanism of their own.
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          throw new Error(`it holds a JSON ${typeOf(parsed)}, not an object of settings`);
        saved = parsed as Record<string, unknown>;
      } catch (e) {
        const badPath = `${CONFIG_FILE}.bad-${Date.now()}`;
        const salvaged = salvageToken(raw);
        if (salvaged.token) saved.token = salvaged.token;
        try {
          renameSync(CONFIG_FILE, badPath);
          justRecovered = true;
          logIssue(
            `config.json could not be loaded (${(e as Error).message}) - the original was moved to ${badPath}; starting from defaults${salvaged.note}`,
            configIssues,
          );
        } catch (renameError) {
          // Couldn't even move it aside (e.g. the config dir isn't writable) - leave the
          // file exactly as it is and run this process from in-memory defaults only. Do
          // NOT fall through to the write below.
          canWrite = false;
          logIssue(
            `config.json could not be loaded (${(e as Error).message}) and could not be moved aside (${(renameError as Error).message}) - running from in-memory defaults only, config.json left untouched`,
            configIssues,
          );
        }
      }
    }
  }
  let token = saved.token as string | undefined;
  let tokenWasGenerated = false;
  if (!token) {
    token = randomBytes(16).toString('hex');
    saved.token = token;
    tokenWasGenerated = true;
  }
  // Write whenever a fresh token was generated (original behaviour), or whenever the file
  // on disk was just moved aside and needs replacing - even when the token itself was
  // salvaged rather than generated, config.json still doesn't exist on disk any more.
  if (canWrite && (tokenWasGenerated || justRecovered)) {
    // Unguarded, this throws uncaught for a config dir that exists but isn't writable -
    // the same silent restart loop again, and reachable on a completely ordinary config
    // (no config.json at all, dir mode 500: token generated, canWrite still true, EACCES).
    // Running this session from an in-memory token is strictly better than not running:
    // it is exactly what the "couldn't move it aside" path above already does.
    try {
      writeFileSync(CONFIG_FILE, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    } catch (e) {
      logIssue(
        `config.json could not be written (${(e as Error).message}) - the addon is running with a token that exists only in memory, so it will change on the next restart; fix the permissions on ${CONFIG_DIR}`,
        configIssues,
      );
    }
  }

  // Unknown keys (not in DEFAULTS) start here and are never touched below, so they survive
  // into the merged config untouched, per the "preserve, don't reject" requirement.
  const validated: Record<string, unknown> = { ...saved };

  for (const [key, schema] of Object.entries(fieldSchemas)) {
    if (!(key in saved)) continue;
    const value = validateScalar(key, schema, (DEFAULTS as Record<string, unknown>)[key], saved[key], configIssues);
    if (value === undefined) delete validated[key];
    else validated[key] = value;
  }

  if ('notify' in saved)
    validated.notify = {
      ...DEFAULTS.notify,
      ...validateOptions('notify', notifyShape, DEFAULTS.notify, saved.notify, configIssues),
    };

  const cfg: Config = { ...DEFAULTS, ...validated, token, configIssues } as Config;
  // A bad custom torrentDir (unwritable parent, a path through a file, ...) must not throw
  // here either, for the same reason as the JSON.parse above - fall back to the default,
  // which lives inside CONFIG_DIR and is normally creatable since that mkdirSync already
  // succeeded above. "Normally" is doing real work in that sentence: a plain file named
  // "torrents" sitting inside CONFIG_DIR would make the fallback fail too, so that retry
  // is guarded as well - the module-load path must not throw no matter what's on disk.
  try {
    mkdirSync(cfg.torrentDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    logIssue(`"torrentDir" (${cfg.torrentDir}) could not be created: ${(e as Error).message} - using default`, configIssues);
    cfg.torrentDir = DEFAULTS.torrentDir;
    try {
      mkdirSync(cfg.torrentDir, { recursive: true, mode: 0o700 });
    } catch (e2) {
      logIssue(
        `the default torrentDir (${cfg.torrentDir}) could not be created either: ${(e2 as Error).message} - torrent caching will fail until this is fixed`,
        configIssues,
      );
    }
  }
  return cfg;
}

// Missing or unreadable (absent, a directory, permission-denied, ...): undefined, never a
// throw. The /cookie page is the only way to install one, so a server that refuses to
// start without a readable cookie file can never be recovered.
export function readCookie(path: string): string | undefined {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

export function writeCookie(path: string, cookie: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${cookie.trim()}\n`, { mode: 0o600 });
}
