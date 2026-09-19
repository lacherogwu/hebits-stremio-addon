# Hebits Stremio Addon

A [Stremio](https://www.stremio.com/)-protocol addon (works in Stremio itself, and in
compatible clients such as [Nuvio](https://github.com/NuvioMedia)) that brings
[Hebits](https://hebits.net), a private Israeli BitTorrent tracker, to your TV — **with no
debrid service**. Torrents download, seed and stream entirely from your own machine, through
your own [qBittorrent](https://www.qbittorrent.org/).

**No debrid service.** Hebits bans debrid services outright; an account that uses one is
blocked immediately. Nothing here proxies through TorBox, AIOStreams or similar — every
torrent downloads, seeds and stays on the machine this addon runs on.

This is one half of a split: the other half is `hebits-account-builder`, a separate service
that builds up the Hebits account (auto-grab, auto-seed, auto-release) using the same
qBittorrent instance. They don't talk to each other and neither depends on the other running
— they share state only through tags written into qBittorrent (see [Tags](#tags) below).

```
 Stremio / Nuvio ──stream list──►  this addon :7000 ──cookie──► hebits.net
        │                              │
        └────────── plays file ◄───────┴──► qBittorrent :8080 (downloads + seeds forever)
             (home network)
  addon ──login alert──► your notification transport (see Notifications)
```

The addon talks to Hebits directly through the [`hebits-client`](https://www.npmjs.com/package/hebits-client)
library, authenticating with a session cookie read from the file at `cookiePath`. That cookie
is the only credential involved, and it is installed through the addon's own
[`/cookie` page](#the-hebits-login-cookie).

## Catalogs

The addon exposes four catalogs:

- **Hebits at home** / **Hebits movies at home** — built from what's actually sitting in
  qBittorrent right now (`src/home.ts`, `src/library.ts`), not from an external database.
  This is right even for shows whose IMDb/Cinemeta metadata is incomplete or missing. Both
  are searchable.
- **Hebits series** / **Hebits movies** — searches all of Hebits and groups the uploads into
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

**On the machine that runs the addon:** Node.js ≥ 22, and
[qBittorrent](https://www.qbittorrent.org/) with the WebUI enabled. Nothing else — no
indexer, no proxy, no `node_modules`.

**To build and deploy it:** Node.js ≥ 22 and npm, on whatever machine you develop on.

## Install

The addon ships as **one bundled file**, `dist/server.mjs`. The two machines have different
requirements, and it's worth being precise about which is which:

- **Developer machine** — needs `npm install`, and a build step to produce the bundle.
- **Target machine** — needs only `dist/server.mjs` and a Node runtime. There is no
  `node_modules`, no `package.json` and no npm on the target; the four runtime dependencies
  are compiled into the single file. That is the point of the deployment design: nothing to
  install, nothing to keep in sync, and an upgrade is one file copy.

Build it:

```bash
git clone <this repo>
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

The default port, `7000`, collides with the AirPlay Receiver service on macOS. If the addon
exits complaining the port is already in use, set `port` to something else (e.g. `7001`) in
`config.json`.

Add the addon to Stremio/Nuvio with:

```
http://<host>:7000/<token>/manifest.json
```

where `<host>` is this machine's address on your network and `<token>` is the value written
to `config.json`.

## Deploying

```bash
npm run deploy
```

`scripts/deploy.sh` runs the typecheck and the tests, builds the bundle, copies
`dist/server.mjs` to the target over `rsync`, restarts the LaunchAgent with
`launchctl kickstart`, and then waits until the running service answers its manifest as the
version that was just built — matching on both the version string and the PID launchd
started, so a same-version redeploy against a process that never actually restarted still
fails rather than reporting success.

The target is an SSH host name. Set it once in `.deploy-host` (git-ignored), or per-run in
the environment:

```bash
echo my-ssh-host > .deploy-host     # once
DEPLOY_HOST=my-ssh-host npm run deploy   # or per-run; overrides .deploy-host
```

### One-time LaunchAgent setup

The first deploy to a fresh target will report that no LaunchAgent is installed and print
these steps. `deploy/org.user.hebits-addon.plist` is a template containing `__HOME__`
placeholders.

1. Copy the template over, still unsubstituted:

   ```bash
   scp deploy/org.user.hebits-addon.plist "<ssh-host>:/tmp/org.user.hebits-addon.plist"
   ```

2. Substitute and load it **on the target**. The substitution must happen there, not
   locally: the two machines' home directories can differ, and a plist built against the
   wrong `$HOME` points every path at an account that doesn't exist, so the service never
   spawns. The single quotes below keep `$HOME` and `$(id -u)` unexpanded until they reach
   the target:

   ```bash
   ssh "<ssh-host>" 'mkdir -p ~/Library/LaunchAgents \
     && sed "s|__HOME__|$HOME|g" /tmp/org.user.hebits-addon.plist \
        > ~/Library/LaunchAgents/org.user.hebits-addon.plist \
     && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.user.hebits-addon.plist'
   ```

Then re-run `npm run deploy`.

The plist expects Node at `~/Applications/node/bin/node` and the bundle at
`~/Applications/hebits-stremio-addon/dist/server.mjs`, and points launchd's stdout and
stderr at `logFile`. It sets `KeepAlive`, so the service restarts on its own if it exits —
which is why nothing on the startup path is allowed to throw (see
[When config.json is broken](#when-configjson-is-broken)).

## Configuration

Settings live in `~/.config/hebits-stremio-addon/config.json` (mode `600`), overriding the
defaults in `src/config.ts`. Override the directory itself with the `HEBITS_ADDON_DIR`
environment variable. See `deploy/config.example.json` for a starting point.

| Key | Default | Meaning |
|---|---|---|
| `token` | random, generated on first run | Secret path segment every route sits behind |
| `port` | `7000` | Listen port, all interfaces |
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
| `torrentDir` | `<config dir>/torrents` | Where downloaded `.torrent` files are cached; created on startup if missing |
| `logFile` | `<config dir>/addon.log` | Truncated in place (with a `.1` backup) once it passes 20 MB |

`cookiePath` may point at a file shared with another service — `hebits-account-builder` uses
the same cookie — but it defaults inside the config directory so the addon is self-contained.

### When config.json is broken

`config.json` is hand-edited, and launchd restarts the service on exit, so a config error
that threw at startup would become a silent restart loop: the process would die before the
notifier exists, so no alert would ever fire. It would simply be down. Nothing on the load
path is therefore allowed to throw.

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

Every route sits behind the secret token: `http://<host>:7000/<token>/…`

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
http://<host>:7000/<token>/cookie
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
`http://<host>:7000/<token>/notify-test`.

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
these — the tags are the only record. `hebits-account-builder` writes the exact same tags for
torrents it adds, so either program can recognize torrents the other one added and tell what
they are, without depending on each other running.

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

**uTorrent cannot be ported to**: its WebAPI exposes no piece-state endpoint, so there is no
way to know which pieces are actually downloaded, and piece-gated streaming — the thing that
lets an unfinished torrent be watched safely, without ever serving a byte that hasn't arrived
— is not possible on it.

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
| `src/version.ts` | The version string the manifest and the deploy check compare against |

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
only file deployed.

## Tests

```bash
npm test          # vitest, 218 tests
npm run typecheck # tsc
npm run lint      # biome
```

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
