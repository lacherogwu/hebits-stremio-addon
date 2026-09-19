import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

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
  // Home Assistant webhook, e.g. http://homeassistant.local:8123/api/webhook/<id>
  notify: { webhookUrl: string };
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

// Bounded on purpose: a single regex over the raw (unparseable) text, never an attempt to
// repair or partially parse the rest of the file. Used only when JSON.parse has already
// failed - see loadConfig(). A malformed config.json is the expected failure mode here (the
// file is hand-edited), and without this, every typo would rotate the token and break every
// already-installed Stremio/Nuvio client's URL until the operator notices and restores the
// file - on a TV client, painful. Salvaging the token turns that into: service keeps
// running, clients keep working, operator fixes the typo at leisure.
function salvageToken(rawText: string): string | undefined {
  const match = rawText.match(/"token"\s*:\s*"([^"]*)"/);
  const candidate = match?.[1];
  return candidate !== undefined && TOKEN_SHAPE.test(candidate) ? candidate : undefined;
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
  fallback: Record<string, unknown>,
  received: unknown,
  issues: string[],
): Record<string, unknown> {
  if (typeof received !== 'object' || received === null || Array.isArray(received)) {
    logIssue(`"${name}" is a ${typeOf(received)}, not an object - using default`, issues);
    return {};
  }
  const out: Record<string, unknown> = { ...(received as Record<string, unknown>) };
  for (const [key, schema] of Object.entries(shape)) {
    if (!(key in out)) continue;
    const result = schema.safeParse(out[key]);
    if (!result.success) {
      logIssue(`"${name}.${key}" is a ${typeOf(out[key])}, not the expected type - using default ${JSON.stringify(fallback[key])}`, issues);
      delete out[key];
    }
  }
  return out;
}

export function loadConfig(): Config {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const configIssues: string[] = [];
  let saved: Record<string, unknown> = {};
  // Whether it's safe to write CONFIG_FILE below. Stays true unless a malformed file
  // below couldn't even be moved aside - writing then would overwrite the operator's
  // original bytes with nothing but a fresh token, which is strictly worse than leaving
  // the broken file in place untouched.
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
    const raw = readFileSync(CONFIG_FILE, 'utf8');
    try {
      saved = JSON.parse(raw);
    } catch (e) {
      const badPath = `${CONFIG_FILE}.bad-${Date.now()}`;
      const salvaged = salvageToken(raw);
      if (salvaged) saved.token = salvaged;
      try {
        renameSync(CONFIG_FILE, badPath);
        justRecovered = true;
        logIssue(
          `config.json could not be parsed (${(e as Error).message}) - the original was moved to ${badPath}; starting from defaults${salvaged ? ', kept its token so existing clients keep working' : ''}`,
          configIssues,
        );
      } catch (renameError) {
        // Couldn't even move it aside (e.g. the config dir isn't writable) - leave the
        // file exactly as it is and run this process from in-memory defaults only. Do
        // NOT fall through to the write below.
        canWrite = false;
        logIssue(
          `config.json could not be parsed (${(e as Error).message}) and could not be moved aside (${(renameError as Error).message}) - running from in-memory defaults only, config.json left untouched`,
          configIssues,
        );
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
    writeFileSync(CONFIG_FILE, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
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
      ...validateOptions('notify', notifyShape, DEFAULTS.notify as Record<string, unknown>, saved.notify, configIssues),
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
      logIssue(`the default torrentDir (${cfg.torrentDir}) could not be created either: ${(e2 as Error).message} - torrent caching will fail until this is fixed`, configIssues);
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
