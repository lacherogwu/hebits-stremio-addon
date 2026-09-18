import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
export const CONFIG_DIR = process.env.HEBITS_ADDON_DIR || join(HOME, '.config', 'hebits-stremio-addon');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  port: 7000,
  // Hebits Heb Rookie: 5 on day one, then 10. Raise when the account ranks up.
  dailyLimit: 10,
  // Per-day exceptions, e.g. { "2026-09-17": 5 } for the account's first day.
  dailyLimitByDay: {},
  // Keep this much disk free after a download.
  minFreeGB: 20,
  timezone: 'Asia/Jerusalem',
  jackettUrl: 'http://127.0.0.1:9117',
  jackettIndexer: 'hebits',
  jackettConfig: join(HOME, 'Library', 'Application Support', 'Jackett', 'ServerConfig.json'),
  jackettIndexerConfig: join(HOME, 'Library', 'Application Support', 'Jackett', 'Indexers', 'hebits.json'),
  qbitUrl: 'http://127.0.0.1:8080',
  watchCategory: 'watch',
  watchPath: join(HOME, 'Media', 'Hebits'),
  // Home Assistant webhook, e.g. http://homeassistant.local:8123/api/webhook/<id>
  notify: { webhookUrl: '' },
  torrentDir: join(HOME, 'Media', '.torrents'),
  logFile: join(CONFIG_DIR, 'addon.log'),
};

export function loadConfig() {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  let saved = {};
  if (existsSync(CONFIG_FILE)) saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  if (!saved.token) {
    saved.token = randomBytes(16).toString('hex');
    writeFileSync(CONFIG_FILE, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });
  }
  const cfg = { ...DEFAULTS, ...saved };
  if (!cfg.jackettApiKey) {
    cfg.jackettApiKey = JSON.parse(readFileSync(cfg.jackettConfig, 'utf8')).APIKey;
  }
  return cfg;
}
