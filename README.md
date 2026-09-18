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
 Stremio / Nuvio ──stream list──►  this addon :7000 ──► Jackett :9117 ──cookie──► hebits.net
        │                              │   │
        └────────── plays file ◄───────┘   └──► qBittorrent :8080 (downloads + seeds forever)
             (home network)
  addon ──login alert──► your notification transport (see Notifications)
```

Jackett already holds a login cookie for Hebits; this addon never talks to hebits.net or
qBittorrent's tracker directly except to read that cookie and to search/download/stream
through Jackett and qBittorrent respectively.

## Catalogs

The addon exposes four catalogs:

- **🏠 Hebits at home** / **🏠 Hebits movies at home** — built from what's actually sitting in
  qBittorrent right now (`lib/home.js`, `lib/library.js`), not from an external database. This
  is right even for shows whose IMDb/Cinemeta metadata is incomplete or missing. Both are
  searchable.
- **🔎 Hebits series** / **🔎 Hebits movies** — searches all of Hebits through Jackett and
  groups the uploads into one card per title (`lib/search.js`). Covers Israeli titles that
  IMDb/Cinemeta don't know about. Titles with a recovered IMDb id still get the usual details
  page.

## How playback works

- The first play of a title downloads its `.torrent` through Jackett (Hebits only serves
  private torrents; the addon refuses anything else) and adds it to qBittorrent.
- The file is served over HTTP with byte-range support. **Bytes are only sent once
  qBittorrent reports the piece that holds them as complete** (`lib/streamer.js`) — this is
  piece-gated streaming, not just "wait for the file to exist."
- The exact byte offset of the requested file inside the torrent's piece layout comes from
  parsing the exported `.torrent` itself (`lib/bencode.js`), pad files included, so this works
  even inside multi-file season packs.
- Whichever file is being watched gets **top download priority** (`lib/focus.js`); for
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

- Node.js ≥ 22
- [Jackett](https://github.com/Jackett/Jackett), with a **HeBits** Torznab indexer configured
  and logged in (a valid Hebits browser cookie set on the indexer)
- [qBittorrent](https://www.qbittorrent.org/), with the WebUI enabled

## Install

```bash
git clone <this repo>
cd hebits-stremio-addon
node server.js
```

No build step, no `npm install` — the repo has zero dependencies. The first run creates
`~/.config/hebits-stremio-addon/config.json` with a random `token` and prints either the
listening banner or an error explaining what to fix (see [Configuration](#configuration)).

The default port, `7000`, collides with the AirPlay Receiver service on macOS. If the addon
exits complaining the port is already in use, set `port` to something else (e.g. `7001`) in
`config.json`.

Add the addon to Stremio/Nuvio with:

```
http://<host>:7000/<token>/manifest.json
```

where `<host>` is this machine's address on your network and `<token>` is the value written
to `config.json`.

## Configuration

Settings live in `~/.config/hebits-stremio-addon/config.json` (mode `600`), overriding the
defaults in `lib/config.js`. Override the directory itself with the `HEBITS_ADDON_DIR`
environment variable. See `config.example.json` for a starting point.

| Key | Default | Meaning |
|---|---|---|
| `token` | random, generated on first run | Secret path segment every route sits behind |
| `port` | `7000` | Listen port, all interfaces |
| `dailyLimit` | `10` | Fallback only; used when Hebits' own profile counter can't be read |
| `dailyLimitByDay` | `{}` | Per-day overrides, e.g. `{"2026-09-17": 5}` for a new account's first day |
| `minFreeGB` | `20` | Refuse a new download that would leave less free space than this |
| `timezone` | `Asia/Jerusalem` | Used for the daily download counter's day boundary |
| `jackettUrl` | `http://127.0.0.1:9117` | Jackett base URL |
| `jackettIndexer` | `hebits` | Jackett Torznab indexer id |
| `jackettConfig` | Jackett's `ServerConfig.json`, auto-located per OS | Where the Jackett API key is read from |
| `jackettIndexerConfig` | Jackett's indexer config, auto-located per OS | Where the Hebits login cookie is read from |
| `jackettApiKey` | read from `jackettConfig` | Set this directly to skip that read |
| `qbitUrl` | `http://127.0.0.1:8080` | qBittorrent WebUI base URL |
| `qbitUsername`, `qbitPassword` | empty | Only needed if qBittorrent's "bypass authentication for clients on localhost" is off |
| `watchCategory` | `watch` | qBittorrent category for torrents this addon grabs |
| `watchPath` | `~/hebits/watch` | Save path for `watchCategory` |
| `notify` | `{"webhookUrl": ""}` | Alert transport; see [Notifications](#notifications) |
| `torrentDir` | `<config dir>/torrents` | Where downloaded `.torrent` files are cached; created on startup if missing |
| `logFile` | `<config dir>/addon.log` | If something redirects this process's stdout there, it's truncated (with a `.1` backup) once it passes 20 MB |

Jackett's API key and the Hebits login cookie are both read from Jackett's own files, never
stored in this repository.

### Jackett's API key

On startup, if `jackettApiKey` isn't set in `config.json`, this addon reads it from Jackett's
`ServerConfig.json`. If that file can't be read (Jackett isn't installed yet, or lives
somewhere non-standard) or has no key set, the addon refuses to start and prints exactly
what's wrong and where — set `jackettApiKey` and `jackettConfig` in `config.json` to work
around either case.

### Fixing an expired Hebits login

This addon deliberately **cannot** write the Hebits login cookie — it only reads it, from
Jackett's own indexer config. When the cookie expires, search and grab both fail (a `⚠️`
stream entry appears, and, if `notify` is configured, an alert fires), and `/status` reports
`health.hebitsLogin: "failing"`.

Fix it in **Jackett's own web UI**, not here: open `http://<jackett-host>:9117`, edit the
HeBits indexer, and paste in a fresh `cookie` value from a logged-in browser session on
hebits.net. This addon picks up the change on its next request — no restart needed.

## Notifications

Set `notify.webhookUrl` to POST a JSON alert to any webhook (Home Assistant, ntfy, Discord,
Telegram, ...), or `notify.command` (an argv array) to run a local command instead — both can
be set at once. See `examples/notify/` for ready-made configs. This addon only ever sends the
Hebits-login-health alert (fires on failure, fires again once it recovers) — test your
transport any time at `http://<host>:7000/<token>/notify-test`.

## Tags

Every torrent this addon adds to qBittorrent gets tagged with what it knew when it grabbed
it: `hebits:<id>` and, when known, `imdb:tt<id>`. A `.torrent` file itself carries neither of
these — the tags are the only record. `hebits-account-builder` writes the exact same tags for
torrents it adds, so either program can recognize torrents the other one added and tell what
they are, without depending on each other running.

## Torrent-client contract

This addon talks to qBittorrent only through `lib/qbit.js`. Porting it to a different torrent
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
  IP address instead.

## Tests

```bash
node --test
```

No dependencies, no network access required — the test suite mocks Jackett, qBittorrent and
Hebits.
