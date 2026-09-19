// Exercises the BUILT artifact (dist/server.mjs), not the source. server.ts's routing is
// re-derived from the raw request URL specifically so rolldown can't tree-shake it away -
// see decodeOrNull() there - and a unit test that imports src/server.ts would never run
// through the bundler at all, so it could not have caught that. This test rebuilds first
// and never runs against a stale dist/.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
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

// Two requests on ONE socket, the second written only after the first has been fully
// answered - a player's HEAD probe followed by its ranged GET, on the keep-alive
// connection it already has open. node:http's own Agent would quietly open a second
// connection when the server drops the first, which is exactly the failure being tested,
// so this drives the socket by hand. Resolves with one entry per HTTP response that
// arrived, so "the second request got nothing" is visible as a missing entry rather than
// as a hang.
// One entry per response seen so far. The `^` anchor counts a status line only at the
// start of a line, which holds for the two routes below because both answer chunked, so
// the second response's status line follows a `\r\n`. A route that answered with a
// Content-Length body could leave the next status line mid-line and be counted as 0 - i.e.
// adding a route here can make this report ONE response when two arrived. That direction
// is safe (it fails a passing implementation, it can never pass a broken one), so it is
// left alone rather than made cleverer: if a newly added route fails these tests, check
// the raw bytes before believing the server dropped the connection.
function statusLines(raw: string): string[] {
  return raw.match(/^HTTP\/1\.1 \d+/gm) ?? [];
}

function twoOnOneConnection(port: number, first: string, second: string, waitMs = 4_000): Promise<string[]> {
  return new Promise((resolve) => {
    const sock = netConnect(port, '127.0.0.1');
    let raw = '';
    let sentSecond = false;
    const finish = (): void => {
      clearTimeout(timer);
      sock.destroy();
      resolve(statusLines(raw));
    };
    const timer = setTimeout(finish, waitMs);
    sock.on('connect', () => sock.write(first));
    sock.on('data', (chunk: Buffer) => {
      raw += chunk.toString('latin1');
      // The first response is complete once its head has arrived (both routes here answer
      // with a short body in one segment); only then does the second request go out, so
      // this is a probe-then-fetch sequence and not HTTP pipelining.
      if (!sentSecond && statusLines(raw).length === 1 && raw.includes('\r\n\r\n')) {
        sentSecond = true;
        setTimeout(() => sock.write(second), 50);
      }
      if (statusLines(raw).length === 2) setTimeout(finish, 50);
    });
    sock.on('error', finish); // a destroyed connection resolves with what did arrive
    sock.on('close', finish);
  });
}

const rawRequest = (method: string, path: string, extra = ''): string =>
  `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n${extra}\r\n`;

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

    // Run the bundle from tmpDir, NOT from the repo, and copy it there as a lone file.
    // This is the deployment condition: the target holds exactly one file, with no
    // package.json and no node_modules anywhere above it. Spawning out of REPO_ROOT would
    // let anything the bundle failed to inline resolve against the repo and pass here
    // while dying on the target - src/version.ts imports ../package.json, which resolves
    // to the real one from dist/, so a build that stopped inlining it would go unnoticed
    // exactly where it matters. Node resolves a bare specifier from the FILE's location,
    // so the copy is what makes this test the real thing rather than a proxy for it.
    const deployedBundle = join(tmpDir, 'server.mjs');
    copyFileSync(join(REPO_ROOT, 'dist', 'server.mjs'), deployedBundle);

    child = spawn('node', [deployedBundle], {
      cwd: tmpDir,
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

  // Players probe with HEAD and then fetch ranges on the SAME keep-alive connection -
  // src/play.ts has a branch for exactly that probe. Hono answers a HEAD by re-dispatching
  // it as a GET and wrapping the result in `new Response(null, res)`, which turned the raw
  // routes' RESPONSE_ALREADY_SENT into @hono/node-server's optimised Response and sent it
  // down the path that writes the head a second time: ERR_HTTP_HEADERS_SENT, and the socket
  // destroyed under a response the handler had already written and ended. The HEAD's own
  // answer looked perfect; what died was the next request on that connection. So this
  // asserts on the SECOND response, and drives one socket by hand - node:http's Agent would
  // transparently open a fresh connection after the server dropped the first, which is the
  // very failure under test.
  //
  // qBittorrent is unreachable here by construction (qbitUrl above), so both routes take
  // their raw-written error path - 409 for play, 404 for poster. That is what makes this
  // test network-free while still going through the raw-response boundary.
  const playPath = (): string => `/${token}/play/h/${'b'.repeat(40)}/1/1`;

  test('a HEAD probe on /play leaves the connection usable for the ranged GET that follows', async () => {
    const seen = await twoOnOneConnection(port, rawRequest('HEAD', playPath()), rawRequest('GET', playPath(), 'Range: bytes=0-1023\r\n'));
    expect(seen).toEqual(['HTTP/1.1 409', 'HTTP/1.1 409']);
  });

  // Tells "the HEAD killed the connection" apart from "this server never reuses one".
  test('control: two GETs on one connection are both answered', async () => {
    const seen = await twoOnOneConnection(port, rawRequest('GET', playPath()), rawRequest('GET', playPath(), 'Range: bytes=0-1023\r\n'));
    expect(seen).toEqual(['HTTP/1.1 409', 'HTTP/1.1 409']);
  });

  // The poster route writes the node response directly too, and Stremio fetches posters
  // over the same connections as everything else.
  test('a HEAD probe on /poster leaves the connection usable for the GET that follows', async () => {
    const path = `/${token}/poster/${'b'.repeat(40)}`;
    const seen = await twoOnOneConnection(port, rawRequest('HEAD', path), rawRequest('GET', path));
    expect(seen).toEqual(['HTTP/1.1 404', 'HTTP/1.1 404']);
  });

  test('the right token reaches the manifest route', async () => {
    const res = await rawGet(port, `/${token}/manifest.json`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { id?: string };
    expect(body.id).toBe('net.hebits.home');
  });

  // src/version.ts derives VERSION from package.json, which tsdown inlines at build time.
  // Because the bundle above runs as a lone file outside the repo, a build that stopped
  // inlining would not merely report a wrong version here - it would fail to start at all
  // (ERR_MODULE_NOT_FOUND on a package.json that isn't there), which is precisely what the
  // target would do under KeepAlive. This asserts what deploy.sh depends on: the SHIPPED
  // artifact reports package.json's version, compared by exact string match, otherwise
  // every deploy fails after a 20-second wait against a healthy service.
  test('the built bundle reports package.json version through the manifest', async () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
    const res = await rawGet(port, `/${token}/manifest.json`);
    const body = JSON.parse(res.body) as { version?: string };
    expect(body.version).toBe(pkg.version);
  });
});
