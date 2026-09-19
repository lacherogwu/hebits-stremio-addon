# Hebits Stremio Addon

A [Stremio](https://www.stremio.com/)-protocol addon (works in Stremio itself, and in
compatible clients such as [Nuvio](https://github.com/NuvioMedia)) that brings
[Hebits](https://hebits.net), a private Israeli BitTorrent tracker, to your TV — **with no
debrid service**. Torrents download, seed and stream entirely from your own machine, through
your own [qBittorrent](https://www.qbittorrent.org/).

**No debrid service.** Hebits bans debrid services outright; an account that uses one is
blocked immediately. Nothing here proxies through TorBox, AIOStreams or similar — every
torrent downloads, seeds and stays on the machine this addon runs on.

```
 Stremio / Nuvio ──stream list──►  this addon :18700 ──cookie──► hebits.net
        │                              │
        └────────── plays file ◄───────┴──► qBittorrent :8080 (downloads + seeds forever)
             (home network)
  addon ──login alert──► your notification transport (see Notifications)
```

The addon talks to Hebits directly through the [`hebits-client`](https://www.npmjs.com/package/hebits-client)
library, authenticating with a session cookie read from the file at `cookiePath`. That cookie
is the only credential involved, and it is installed through the addon's own
[`/cookie` page](#the-hebits-login-cookie).

**How hard it hits the tracker.** Every call the addon makes — searches, the profile counter,
`.torrent` downloads and any retry of those — shares **one** throttle, set by `rateLimit` in
`config.json` and defaulting to **3 requests per second**.

`hebits-client`'s own default is one request every two seconds, which is right for a
background service and wrong for a TV waiting on a stream list: measured against a local stub,
that default gave 6.0 s for an ordinary stream list and 22 s for a nine-season search card,
against 1.0 s and 3.0 s here. Five per second was measured too and not taken — it only helps
the rarest path, and the trade is not symmetric: a slow catalogue is recoverable, a banned
account is not.

That asymmetry is why it is configuration and not a constant. **Lower it freely.** Raise it
and the addon still obeys you, but past 5 requests per second it records a line in
`configIssues` saying so — a private tracker may take a different view of what is reasonable
than you do, and you are the one with an account at stake.

The tracker's own download counter is read fresh before a download is ever spent, and cached
for five minutes for everything that merely displays it (`src/grab.ts`).

## Catalogs

The addon exposes four catalogs. The names below are exactly as they appear on screen,
emoji included:

- **🏠 Hebits at home** / **🏠 Hebits movies at home** — built from what's actually sitting in
  qBittorrent right now (`src/home.ts`, `src/library.ts`), not from an external database.
  This is right even for shows whose IMDb/Cinemeta metadata is incomplete or missing. Both
  are searchable.
- **🔎 Hebits series** / **🔎 Hebits movies** — searches all of Hebits and groups the uploads into
  one card per title (`src/search.ts`). Covers Israeli titles that IMDb/Cinemeta don't know
  about. Titles with a recovered IMDb id still get the usual details page.

## How playback works

- The first play of a title downloads its `.torrent` through `hebits-client` (Hebits only
  serves private torrents; the addon refuses anything else) and adds it to qBittorrent.
- The file is served over HTTP with byte-range support. **Bytes are only sent once
  qBittorrent reports the piece that holds them as complete** (`src/streamer.ts`) — this is
  piece-gated streaming, not just "wait for the file to exist."
- The exact byte offset of the requested file inside the torrent's piece layout comes from
  parsing the exported `.torrent` itself (`src/bencode.ts`, `src/torrentmeta.ts`), pad files
  included, so this works even inside multi-file season packs.
- Whichever file is being watched gets **top download priority** (`src/focus.ts`); for
  single-video torrents (a movie), first/last-piece priority is also raised so playback can
  start near-instantly.
- **This addon never pauses a file itself.** Pausing other files to prioritize one measurably
  stalls libtorrent (see [Lessons learned](#lessons-learned)), so it isn't done.
- **It does un-pause, though — but only for torrents it manages.** Hebits only counts seed
  time once a torrent is 100% downloaded, so a file *you* deselected in a torrent this addon
  added would otherwise leave that torrent perpetually incomplete and earning nothing. For
  torrents in its own watch category, this addon re-enables deselected files so the torrent
  can actually finish. A torrent it didn't add is left alone — whatever selection you made
  there stands.

## Requirements

**To build:** Node.js ≥ 22 and npm.

**To run:** Node.js ≥ 22, and [qBittorrent](https://www.qbittorrent.org/) with the WebUI
enabled. Nothing else: no indexer, no proxy, no `node_modules`, and no npm on the machine
that runs it.

## Install

The addon ships as **one bundled file**, `dist/server.mjs`. Building and running can happen
on one machine or two, and the division is worth being precise about:

- **Where you build** — needs `npm install`, and a build step to produce the bundle.
- **Where it runs** — needs only `dist/server.mjs` and a Node runtime. No `node_modules`,
  no `package.json` and no npm: the four runtime dependencies are compiled into the single
  file. That is the point of the design — nothing to install, nothing to keep in sync, and an
  upgrade is one file copy.

Build it:

```bash
git clone https://github.com/lacherogwu/hebits-stremio-addon.git
cd hebits-stremio-addon
npm install
npm run build        # writes dist/server.mjs
```

Run it:

```bash
node dist/server.mjs
```

The first run creates `~/.config/hebits-stremio-addon/config.json` with a random `token` and
prints the listening banner (see [Configuration](#configuration)).

The default port, `18700`, is chosen rather than round: it sits **below the range the OS hands
out for outbound connections** (49152+ on macOS and Windows, 32768+ on Linux), so it cannot
lose a bind race to a transient client port, and it is not a port a common service claims.
Round, low ports are the ones everything picks — `7000` and `5000` are both taken by AirPlay
Receiver on macOS, and `3000`, `8000` and `8080` by everything else. If it still collides, set
`port` in `config.json`; the addon exits with a message naming the port rather than a stack
trace.

Add the addon to Stremio/Nuvio with:

```
http://<host>:18700/<token>/manifest.json
```

where `<host>` is this machine's address on your network and `<token>` is the value written
to `config.json`.

Then paste a Hebits cookie at `http://<host>:18700/<token>/cookie` — until you do, the addon
runs but every search comes back empty. See
[The Hebits login cookie](#the-hebits-login-cookie).

## Running it as a service

Copy `dist/server.mjs` wherever you keep it and start it under whatever supervisor you
already use — launchd, systemd, pm2, a container. This repo ships no deployment tooling and
has no opinion about any of it: the host, the install path and the service manager are facts
about your machine, not about this addon.

Three things a supervisor has to get right:

- **Send stdout and stderr to `logFile`.** The addon logs with `console.log`, so whatever the
  supervisor does with stdout *is* the log. It rotates by truncating `logFile` **in place**
  once it passes 20 MB — the only method that works when the supervisor holds that
  descriptor open for the life of the process. Point the supervisor somewhere other than
  `logFile` and rotation silently stops applying to the file actually being written, which
  then grows without bound.
- **Set `HEBITS_ADDON_DIR` in the supervisor's own environment**, if you set it at all. A
  supervised service does not inherit your shell, so exporting it from a shell profile has no
  effect on the running addon. It also moves the default `logFile`, so it runs into the point
  above as well.
- **Restart-on-exit is safe, and worth turning on.** Nothing on the startup path is allowed
  to throw: a `config.json` that will not parse, or that parses to the wrong shape, is moved
  aside and the addon starts on defaults (see
  [When config.json is broken](#when-configjson-is-broken)). A restart policy therefore
  cannot turn one typo into a restart loop that never alerts anybody.

After an upgrade, ask the running addon for its version rather than assuming the restart
took — a supervisor that failed to restart leaves the old process answering happily:

```bash
curl -s "http://127.0.0.1:18700/<token>/manifest.json" | grep -o '"version":"[^"]*"'
```

### Reading the token

Both the manifest URL and the `/cookie` page need the `token` the addon generated at first
run. Read it back on the machine it runs on:

```bash
node -p "require(process.env.HOME + '/.config/hebits-stremio-addon/config.json').token"
```

The addon is then at `http://<host>:18700/<token>/manifest.json`, which is the URL to install
in Stremio or Nuvio.

### Last step: install a cookie

A freshly installed addon has no Hebits cookie, so searches return nothing and the catalogs
look empty — it is working, but blind. Open

```
http://<host>:18700/<token>/cookie
```

and paste a cookie, following the instructions on the page. It takes effect immediately.
See [The Hebits login cookie](#the-hebits-login-cookie) for what the page does with it.

## Configuration

Settings live in `~/.config/hebits-stremio-addon/config.json` (mode `600`), overriding the
defaults in `src/config.ts`. See `config.example.json` for a starting point.

The directory itself is overridden with the `HEBITS_ADDON_DIR` environment variable, which a
supervised service has to be handed explicitly — see
[Running it as a service](#running-it-as-a-service).

| Key | Default | Meaning |
|---|---|---|
| `token` | random, generated on first run | Secret path segment every route sits behind |
| `port` | `18700` | Listen port, all interfaces |
| `dailyLimit` | `10` | Fallback only; used when Hebits' own profile counter can't be read |
| `dailyLimitByDay` | `{}` | Per-day overrides, e.g. `{"2026-09-17": 5}` for a new account's first day |
| `minFreeGB` | `20` | Refuse a new download that would leave less free space than this |
| `timezone` | `Asia/Jerusalem` | Used for the daily download counter's day boundary |
| `cookiePath` | `<config dir>/cookie.txt` | File holding the Hebits session cookie; written by the `/cookie` page |
| `qbitUrl` | `http://127.0.0.1:8080` | qBittorrent WebUI base URL |
| `qbitUsername`, `qbitPassword` | empty | Only needed if qBittorrent's "bypass authentication for clients on localhost" is off |
| `watchCategory` | `watch` | qBittorrent category for torrents this addon grabs |
| `watchPath` | `~/hebits/watch` | Save path for `watchCategory` |
| `notify` | `{"webhookUrl": ""}` | Alert transport; see [Notifications](#notifications) |
| `rateLimit` | `{"limit": 3, "interval": 1000}` | At most `limit` requests per `interval` ms, across every tracker call. See [How hard it hits the tracker](#hebits-stremio-addon) above |
| `torrentDir` | `<config dir>/torrents` | Where downloaded `.torrent` files are cached; created on startup if missing |
| `logFile` | `<config dir>/addon.log` | Truncated in place (with a `.1` backup) once it passes 20 MB. **Whatever supervises the addon must send stdout and stderr to this same path** — see [Running it as a service](#running-it-as-a-service) |

**Why the `token` is random rather than empty.** There is no login here: the token *is* the
authentication, and the addon listens on all interfaces. An empty token would not mean "no
protection" — it would mean the guard compares two empty strings and passes, leaving every
route open to anyone who can reach the port, including `/cookie`, where the Hebits session
cookie is pasted and can be read back. Generating one on first run is safe by default with
nothing to set up. It is then preserved across restarts, and across a corrupted `config.json`
wherever it can be identified unambiguously, because rotating it breaks every URL already
installed on a TV.

`cookiePath` defaults inside the config directory, so the addon is self-contained. Point it at
a file another service also reads — anything logging in as the same Hebits account — and one
paste serves both. The parent directory is created on write, so a shared location outside
either service's config directory works.

### When config.json is broken

`config.json` is hand-edited, and a supervisor restarts the service on exit, so a config
error that threw at startup would become a silent restart loop: the process would die before
the notifier exists, so no alert would ever fire. It would simply be down. Nothing on the
load path is therefore allowed to throw.

- **One bad field** — a wrong type, e.g. `"minFreeGB": "20"` — falls back to its default.
  Every other field, *including keys this version of the code doesn't recognize*, is kept
  untouched.
- **A file that won't parse at all**, or that parses into something other than a JSON object
  (`null`, a number, an array), is moved aside to `config.json.bad-<timestamp>` and the
  service starts on defaults. The original bytes are preserved for you to fix; recovery is
  usually correcting one character and moving the file back.
- **The token is preserved where it can be identified unambiguously.** Rotating it would
  break the URL of every already-installed client — painful on a TV. So the raw text of an
  unparseable file is scanned for a value of exactly the shape the addon generates (32
  lowercase hex characters). If exactly one such value is found it is kept; if none or
  several are found, a fresh token is generated rather than guessing. (Several is a real
  case: a `notify.headers` entry named `token` looks identical to a text search.)

Every one of these is logged **and** reported in `configIssues` on `/status`, so a typo
surfaces somewhere you will actually look rather than scrolling past in a log. `state.json`
is guarded the same way and reports through `storeIssue`; it is a cache, not a source of
truth, so losing it costs only today's fallback download count and any remembered identity
lookups.

## Routes

Every route sits behind the secret token: `http://<host>:18700/<token>/…`

| Route | Purpose |
|---|---|
| `manifest.json` | Stremio manifest — this is the URL you install |
| `catalog/…`, `meta/…`, `stream/…` | The Stremio protocol proper |
| `poster/<ref>`, `play/…` | Posters, and the piece-gated byte-range stream |
| `cookie` | The [cookie page](#the-hebits-login-cookie) |
| `status` | Version, account standing, downloads used today, free disk, `configIssues`, `storeIssue` and login health |
| `notify-test` | Sends a test alert through whatever `notify` is configured (see [Notifications](#notifications)) |

## The Hebits login cookie

The addon authenticates to Hebits with a browser session cookie, stored in the file at
`cookiePath` (mode `600`). Install or replace it at:

```
http://<host>:18700/<token>/cookie
```

The page shows the current login status and tells you how to copy the cookie out of your
browser's DevTools. A pasted cookie is **verified before it is saved**: a throwaway client is
built around the candidate and used to check the login, so a bad paste is rejected instead of
silently stored, and never overwrites a cookie that still works.

A saved cookie **takes effect on the very next request — there is no restart.** The cookie is
read from the file at call time rather than captured at startup, so fixing an expired login
is one paste and nothing else.

When the cookie does expire, searches fail, a warning entry appears in the stream list, an
alert fires if `notify` is configured, and `/status` reports `health.hebitsLogin: "failing"`.

The cookie is a credential: it is never logged, never rendered back into a page, and the file
it lives in is git-ignored.

## Notifications

Configure a webhook, a local command, or both. Both fire on each alert; if neither is set,
notifications are simply off. Test whatever you configure at
`http://<host>:18700/<token>/notify-test`.

| `notify` key | Meaning |
|---|---|
| `webhookUrl` | URL to POST the alert to. Setting this enables the webhook transport |
| `method` | HTTP method, default `POST` |
| `headers` | Extra request headers, merged over the default `content-type: application/json` |
| `body` | Request body template (see below); the default sends `{"kind":…,"title":…,"message":…}` |
| `command` | An argv array — `["notify-send", "{{title}}", "{{message}}"]` — run instead of, or as well as, the webhook |

`body` and each element of `command` are templates. `{{title}}`, `{{message}}` and `{{kind}}`
are substituted, and a prefix picks the escaping: `{{json:title}}` for a value inside a JSON
string, `{{url:title}}` for a query parameter, plain `{{title}}` for raw. This is what makes
one mechanism cover Home Assistant, ntfy, Discord, Telegram, Slack, Gotify and Pushover —
they are all "POST to a URL" and differ only in body shape. Ready-made configs for several of
them are in `examples/notify/`.

The addon sends an alert when the Hebits login stops working, and again once it recovers.
Repeats of the same alert kind are suppressed for six hours.

## Tags

Every torrent this addon adds to qBittorrent gets tagged with what it knew when it grabbed
it: `hebits:<id>` and, when known, `imdb:tt<id>`. A `.torrent` file itself carries neither of
these — the tags are the only record. The scheme is deliberately plain so that any other tool
sharing the qBittorrent instance can read it, and so that a torrent added by hand in a browser
can be recognized later. Nothing here requires such a tool to exist.

## Torrent-client contract

This addon talks to qBittorrent only through `src/qbit.ts`. Porting it to a different torrent
client means implementing the same surface:

- List torrents, each with its tracker (or magnet URI, to detect Hebits torrents by
  announce URL) and its tags.
- List a torrent's files (path, size, per-file download progress).
- List a torrent's **piece states** (which pieces are complete) and its **piece size** —
  this is what makes piece-gated streaming possible at all.
- Add a torrent from a `.torrent` buffer with a given category and save path, and set tags on
  an existing torrent.
- Export the original `.torrent` file for an added torrent, byte-for-byte — used to compute
  each file's exact offset into the piece layout (pad files included).
- Report free disk space.

**uTorrent is probably not portable to** — *unverified, and worth checking before trying.*
Its WebAPI is not known to expose a piece-state endpoint, and without one there is no way to
tell which pieces have actually arrived, so piece-gated streaming — the thing that lets an
unfinished torrent be watched safely — would not be possible. This has not been tested
against a current uTorrent build; it is the reason to check that endpoint first, not a
measured result.

## Layout

| File | What it holds |
|---|---|
| `src/server.ts` | HTTP entry point: token guard, routing, log rotation, startup |
| `src/addon.ts` | The Stremio surface: manifest, catalogs, metas, streams, posters |
| `src/config.ts` | Loading, validating and recovering `config.json`; reading and writing the cookie file |
| `src/hebits.ts` | The boundary to `hebits-client` — where the client is built, and the field conversions that would change behaviour silently if done ad hoc |
| `src/search.ts` | "Search all of Hebits", grouped into one card per title |
| `src/home.ts` | The home library, derived from what qBittorrent holds |
| `src/library.ts` | Catalog rows and episode lists for local torrents |
| `src/identity.ts` | Recovering the identity of a torrent nobody tagged |
| `src/streams.ts` | Turning search results and local state into Stremio stream objects |
| `src/play.ts` | Playback: pick the file, raise its priority, serve it over ranges |
| `src/streamer.ts` | The piece-gated HTTP range server |
| `src/focus.ts` | Raising one file's priority while it's being watched, and putting it back |
| `src/grab.ts` | Turning a Hebits id into a running torrent, and the daily allowance |
| `src/qbit.ts` | The qBittorrent WebUI API client |
| `src/torrentmeta.ts` | Byte-exact file layout, read from the exported `.torrent` |
| `src/bencode.ts` | Minimal bencode reader: infohash, name, files with byte offsets |
| `src/parse.ts` | Release-name and file-list parsing |
| `src/tags.ts` | Torrent identity as qBittorrent tags |
| `src/store.ts` | `state.json`: local cache and event log, never a source of truth |
| `src/notify.ts` | Alerts over a webhook, a command, or both |
| `src/health.ts` | Login health, and the alerts on it changing |
| `src/cookie-page.ts` | The `/cookie` page |
| `src/covers.ts` | Poster covers for torrents seen in search results |
| `src/lock.ts` | A per-key async mutex |
| `src/version.ts` | The version string the manifest reports |

Every file here has a matching `test/<name>.test.ts`, except `src/server.ts` — its routing
and token guard are covered by `test/bundle.test.ts`, which spawns the built bundle and
makes real HTTP requests against it. That is deliberate: a unit test importing
`src/server.ts` would never run through the bundler, and so could not catch a guard that
survives in the source but is optimized out of the shipped file.

## Dependencies

Four at runtime — [`hebits-client`](https://www.npmjs.com/package/hebits-client) (the
tracker), [`hono`](https://hono.dev/) and `@hono/node-server` (HTTP), and
[`zod`](https://zod.dev/) (validating `config.json`) — plus TypeScript, Vitest, tsdown and
Biome for development. `npm run build` bundles all four into `dist/server.mjs`, which is the
only file you need in order to run it.

## Tests

```bash
npm run check     # biome: format + lint + import order. The standard gate
npm run typecheck # tsc
npm test          # vitest
```

`npm run check` is the one to run before committing: `npm run lint` checks lint rules only,
so formatting and import-order drift would pass it. `npm run format` writes formatting
fixes.

No network access required: the suite mocks qBittorrent and Hebits, and never touches a real
torrent client or the tracker. `test/bundle.test.ts` additionally exercises the built
`dist/server.mjs`, so that bundler optimizations can't quietly remove a runtime guard the
source clearly has.

## Lessons learned

- **Pre-allocation doubles disk usage on APFS.** With qBittorrent pre-allocation on, every
  file used roughly twice its size until it finished. Turn pre-allocation off.
- **Pausing files to prioritize one stalls the torrent.** On qBittorrent 5.2 / libtorrent
  1.2, pausing other files to prioritize one stalls the whole torrent for 10–60 s — this is
  why this addon never pauses a file itself (see [How playback works](#how-playback-works)).
- **Stremio clients load home rows lazily.** Some clients (Nuvio included) only fetch the
  first few home-catalog rows up front, so move this addon's rows near the top of your
  reordering settings or they may never load.
- **Android TV apps can't resolve `.local` mDNS names.** Point them at this machine's fixed
  LAN IP address instead.

## Seeding, and what this addon never removes

Every torrent this addon adds stays in qBittorrent and keeps seeding until **you** remove it.
The addon adds, tags, raises a file's priority while you watch and puts it back, and reads —
it never removes a torrent, never deletes data, and never stops a seed.

That is deliberate. On a private tracker, deleting a torrent too early costs a hit-and-run
warning, and enough of those cost your download privileges; a full disk costs you a download.
The addon also cannot know which of your torrents matter. So it does the safe thing and
leaves them alone.

The consequence is that disk use only ever grows, and eventually `minFreeGB` starts refusing
new downloads. Three ways to deal with that, in increasing order of effort:

- **qBittorrent's own share limits** — set a ratio or seeding-time limit per category. Simple,
  and it needs nothing else. Set it above what your tracker requires.
- **Delete by hand** when the disk gets tight. Check the torrent has seeded long enough first.
- **Let something release them for you.**
  [`hebits-account-builder`](https://github.com/lacherogwu/hebits-account-builder) has a
  release pass for exactly this. It needs no integration with this addon: it adopts any
  torrent carrying the `hebits:<id>` tag that this addon already writes (see
  [Tags](#tags)), then removes only *finished* ones that have seeded past the tracker's
  requirement with a margin, worst-value-first, and only when free space is actually low.
  Anything in the `watch` category — which is what this addon downloads into — is held
  longer still, so a title you just watched is not the first thing to go.

  It is a separate service with its own account-building policy, so take it as one option
  rather than the answer; read its policy before pointing it at a live account.

## Related

Independent projects, listed only because they may be useful — this addon requires none of
them and does not talk to them:

- [`hebits-client`](https://www.npmjs.com/package/hebits-client) — the Hebits API client this
  addon is built on. Useful on its own.
- [`hebits-account-builder`](https://github.com/lacherogwu/hebits-account-builder) — a
  separate service that builds a ratio on the same tracker (auto-grab, auto-seed,
  auto-release). Useful here if you would rather not seed forever — see
  [Seeding, and what this addon never removes](#seeding-and-what-this-addon-never-removes).
  If you run both against one qBittorrent, they recognize each other's torrents through the
  [tags](#tags) above, but neither needs the other to be installed or running.
