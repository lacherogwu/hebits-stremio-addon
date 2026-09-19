// Exercises the BUILT artifact (dist/server.mjs), not the source. server.ts's routing is
// re-derived from the raw request URL specifically so rolldown can't tree-shake it away -
// see decodeOrNull() there - and a unit test that imports src/server.ts would never run
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
// to send broken - see the malformed-% tests below.
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

async function waitForPort(port: number, deadline: number, diagnostics: () => string): Promise<void> {
  for (;;) {
    try {
      await rawGet(port, '/');
      return;
    } catch (e) {
      if (Date.now() > deadline) {
        // This is the one test meant to catch subtle build breakage - when it fails to
        // even start, it should say why, not just that a connection was refused.
        throw new Error(`server on :${port} did not become ready in time: ${(e as Error).message}\n${diagnostics()}`);
      }
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
let stdout = '';
let stderr = '';
let spawnError: Error | undefined;
let exitInfo: string | undefined;

describe('the built bundle (dist/server.mjs)', () => {
  beforeAll(async () => {
    // Never let this test pass against a stale dist/ - rebuild every run.
    execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'pipe' });

    port = await getFreePort();
    tmpDir = mkdtempSync(join(tmpdir(), 'hebits-addon-bundle-test-'));
    writeFileSync(
      join(tmpDir, 'config.json'),
      JSON.stringify({
        port,
        // This test must never reach a real service, by construction rather than by which
        // routes it happens to exercise. The machine this addon deploys to runs a live
        // qBittorrent on the qbitUrl default (127.0.0.1:8080); point at a port nothing
        // listens on instead of inheriting that default. Same reasoning for notify's
        // webhook (already '' by default, spelled out here so it doesn't depend on that
        // staying true) and the cookie path (already inside CONFIG_DIR by default, likewise
        // pinned explicitly into this temp dir).
        qbitUrl: 'http://127.0.0.1:1',
        notify: { webhookUrl: '' },
        cookiePath: join(tmpDir, 'cookie.txt'),
      }),
    );

    child = spawn('node', [join(REPO_ROOT, 'dist', 'server.mjs')], {
      cwd: REPO_ROOT,
      env: { ...process.env, HEBITS_ADDON_DIR: tmpDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      spawnError = e;
    });
    child.on('exit', (code, signal) => {
      exitInfo = `code=${code} signal=${signal}`;
    });
    const diagnostics = (): string =>
      `spawnError: ${spawnError?.message ?? '-'}\nexit: ${exitInfo ?? '-'}\nstdout:\n${stdout}\nstderr:\n${stderr}`;

    const deadline = Date.now() + 15_000;
    await waitForPort(port, deadline, diagnostics);
    // loadConfig() writes the generated token to config.json synchronously, before the
    // server starts accepting connections - so by the time waitForPort resolves it's there.
    const saved = JSON.parse(readFileSync(join(tmpDir, 'config.json'), 'utf8')) as ConfigFile;
    if (!saved.token) throw new Error(`config.json has no token after startup\n${diagnostics()}`);
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
  // source directly. server.ts's decodeOrNull() makes the result load-bearing instead.
  //
  // On its own this assertion cannot tell "the guard fired" from "the route regex broke
  // and every request here falls through to the catch-all 404" - both produce the same
  // 404. The control assertion right after it is what tells those apart: it uses an id
  // that is well-formed (no `%`) but not a valid IMDb id, so it reaches addon.handleStream
  // and gets a 200 with no streams *without* the route needing a home-library entry or any
  // network call - handleStream's own `/^tt\d+$/` check returns `[]` before ever calling
  // browse(). If the route regex is broken, this 200 becomes a 404 too.
  test('a malformed % in a stream id 404s, not a 200 with no streams', async () => {
    const res = await rawGet(port, `/${token}/stream/movie/tt%zz.json`);
    expect(res.status).toBe(404);
  });

  test('control: a well-formed (non-%) stream id still reaches the route handler (200)', async () => {
    const res = await rawGet(port, `/${token}/stream/movie/not-a-real-imdb-id.json`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ streams: [] });
  });

  // Same guard, same class of bug, on the meta route - pinned separately so a revert here
  // doesn't ship silently just because the stream route's guard is covered. Unlike the
  // stream route, a "well-formed but not found" meta id is a legitimate 404
  // (addon.handleMeta returns null with no home-library entry to match), so there's no
  // network-free way to add a 200 control here the way there is for stream; this test
  // stays a same-shape pin, not a full guard-vs-route-loss distinction.
  test('a malformed % in a meta id 404s, not a 500 or a wrong meta', async () => {
    const res = await rawGet(port, `/${token}/meta/movie/tt%zz.json`);
    expect(res.status).toBe(404);
  });

  test('the right token reaches the manifest route', async () => {
    const res = await rawGet(port, `/${token}/manifest.json`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { id?: string };
    expect(body.id).toBe('net.hebits.home');
  });

  // src/version.ts derives VERSION from package.json, which tsdown inlines at build time.
  // The target machine has no package.json - only this one file - so a bundler that
  // stopped inlining (leaving a runtime read of a file that isn't there) would break the
  // deploy, not the unit tests. This asserts the property deploy.sh actually depends on:
  // the SHIPPED artifact reports package.json's version, since deploy.sh compares the two
  // by exact string match and otherwise fails after a 20-second wait on a healthy service.
  test('the built bundle reports package.json version through the manifest', async () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
    const res = await rawGet(port, `/${token}/manifest.json`);
    const body = JSON.parse(res.body) as { version?: string };
    expect(body.version).toBe(pkg.version);
  });
});
