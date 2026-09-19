// Exercises the BUILT artifact (dist/server.mjs), not the source. server.ts's routing is
// re-derived from the raw request URL specifically so rolldown can't tree-shake it away -
// see isDecodable() there - and a unit test that imports src/server.ts would never run
// through the bundler at all, so it could not have caught that. This test rebuilds first
// and never runs against a stale dist/.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('could not determine a free port')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

interface RawResponse {
  status: number;
  body: string;
}

// A raw GET over node:http, with the path written to the request line exactly as given -
// unlike fetch()/undici, which re-encodes a bare `%` not followed by two hex digits (into
// `%25`) while building the request, so it can't be used to send an actually-malformed
// percent-encoding. That re-encoding would otherwise "fix" the very input this test needs
// to send broken - see the malformed-% test below.
function rawGet(port: number, path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ hostname: '127.0.0.1', port, path, timeout: 5_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

async function waitForPort(port: number, deadline: number): Promise<void> {
  for (;;) {
    try {
      await rawGet(port, '/');
      return;
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`server on :${port} did not become ready in time: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

interface ConfigFile {
  token?: string;
}

let child: ChildProcess | undefined;
let tmpDir: string | undefined;
let port: number;
let token: string;

describe('the built bundle (dist/server.mjs)', () => {
  beforeAll(async () => {
    // Never let this test pass against a stale dist/ - rebuild every run.
    execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'pipe' });

    port = await getFreePort();
    tmpDir = mkdtempSync(join(tmpdir(), 'hebits-addon-bundle-test-'));
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ port }));

    child = spawn('node', [join(REPO_ROOT, 'dist', 'server.mjs')], {
      cwd: REPO_ROOT,
      env: { ...process.env, HEBITS_ADDON_DIR: tmpDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const deadline = Date.now() + 15_000;
    await waitForPort(port, deadline);
    // loadConfig() writes the generated token to config.json synchronously, before the
    // server starts accepting connections - so by the time waitForPort resolves it's there.
    const saved = JSON.parse(readFileSync(join(tmpDir, 'config.json'), 'utf8')) as ConfigFile;
    if (!saved.token) throw new Error('config.json has no token after startup');
    token = saved.token;
  }, 60_000);

  afterAll(() => {
    child?.kill();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a wrong token gets the same plain 404 as an unknown route', async () => {
    const wrong = await rawGet(port, '/not-the-token/status');
    const unknown = await rawGet(port, `/${token}/does-not-exist`);
    expect(wrong.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(wrong.body).toBe('{"error":"not found"}');
    expect(wrong.body).toBe(unknown.body);
  });

  // Regression pin for the malformed-`%` guard: source-level `decodeURIComponent(rawId);`
  // as a bare, unconsumed expression statement is dead code to rolldown, which drops the
  // whole try/catch from the shipped bundle - a bug invisible to every test that imports
  // source directly. server.ts's isDecodable() makes the result load-bearing instead.
  test('a malformed % in a stream id 404s, not a 200 with no streams', async () => {
    const res = await rawGet(port, `/${token}/stream/movie/tt%zz.json`);
    expect(res.status).toBe(404);
  });

  test('the right token reaches the manifest route', async () => {
    const res = await rawGet(port, `/${token}/manifest.json`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { id?: string };
    expect(body.id).toBe('net.hebits.home');
  });
});
