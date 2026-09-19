#!/usr/bin/env bash
# Deploy the addon: test, build, copy one bundled file, restart, verify.
#   DEPLOY_HOST=my-ssh-host scripts/deploy.sh   # set it each time, or...
#   echo my-ssh-host > .deploy-host             # ...once, in a git-ignored file
set -euo pipefail

cd "$(dirname "$0")/.."

HOST="${DEPLOY_HOST:-$(cat .deploy-host 2>/dev/null || true)}"
if [[ -z "$HOST" ]]; then
  echo "No deploy host. Set DEPLOY_HOST=<ssh-host>, or write it to .deploy-host (git-ignored):" >&2
  echo "  echo my-ssh-host > .deploy-host" >&2
  exit 1
fi
DEST="Applications/hebits-stremio-addon"

echo "→ typecheck + tests"
npm run typecheck
npm test

echo "→ build"
npm run build

if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  echo "! uncommitted changes are being deployed"
fi

VERSION=$(node -p "require('./package.json').version")
echo "→ copying v$VERSION to $HOST:$DEST/dist/"
ssh "$HOST" "mkdir -p $DEST/dist"
rsync -az dist/server.mjs "$HOST:$DEST/dist/server.mjs"

# Restart and verify in one remote block, so the PID launchd just started and the version
# the manifest reports both come from the same kickstart - a separate poll could otherwise
# hit whatever was already listening before the old process finished exiting.
#
# Exit codes from the remote block are distinguished below: 2 means "no LaunchAgent
# installed yet" (the one case with an actionable fix), anything else nonzero is a normal
# failure. $status is pre-seeded 0 and `|| status=$?` only fires on failure, so a clean run
# never touches this branch - set -e stays in effect for the rest of the script.
status=0
ssh "$HOST" VERSION="$VERSION" 'bash -s' <<'REMOTE' || status=$?
LABEL=org.user.hebits-addon
DOMAIN="gui/$(id -u)/$LABEL"
N=~/Applications/node/bin/node
# Unquoted deliberately: bash only tilde-expands in an assignment like this one when it's
# unquoted. CFG="~/..." would leave a literal "~" and every read below would fail.
CFG=~/.config/hebits-stremio-addon/config.json

if ! PID=$(launchctl kickstart -kp "$DOMAIN" 2>&1); then
  echo "✗ launchctl kickstart failed on this host:" >&2
  echo "$PID" >&2
  exit 2
fi

# port is optional in config.json - a bare `require(...).port` would print the string
# "undefined" and silently poll a dead URL, so fall back explicitly.
PORT=$("$N" -p "require('$CFG').port || 7000" 2>/dev/null || echo 7000)
TOKEN=$("$N" -p "require('$CFG').token" 2>/dev/null || true)
if [[ -z "$TOKEN" || "$TOKEN" == "undefined" ]]; then
  echo "✗ could not read a token from $CFG - is the addon configured on this host?" >&2
  exit 1
fi

echo "→ waiting for it to answer as v$VERSION"
for _ in $(seq 1 20); do
  BODY=$(curl -fsS -m 2 "http://127.0.0.1:$PORT/$TOKEN/manifest.json" 2>/dev/null || true)
  LIVE_VERSION=$(printf '%s' "$BODY" | grep -o '"version":"[^"]*"' | head -n1 | cut -d'"' -f4)
  # Match on version AND that the PID this kickstart started is still alive - a version
  # match alone still passes on a same-version redeploy against a process that never
  # actually restarted. `kill -0` on a freshly-kickstarted PID is EPERM (not just "false")
  # for roughly its first half second, while it's still xpcproxy pre-exec - this is why the
  # check is ANDed after a successful curl inside the retry loop rather than tested first or
  # failed fast: by the time the addon answers a manifest it has long since exec'd node, so
  # the EPERM window is already behind it. Do not hoist this check earlier.
  if [[ -n "$LIVE_VERSION" && "$LIVE_VERSION" == "$VERSION" ]] && kill -0 "$PID" 2>/dev/null; then
    echo "✓ addon v$VERSION is answering (pid $PID)"
    tail -n 3 ~/.config/hebits-stremio-addon/addon.log
    exit 0
  fi
  sleep 1
done
echo "✗ addon did not come up as v$VERSION (pid $PID); last log lines:" >&2
tail -n 20 ~/.config/hebits-stremio-addon/addon.log >&2
exit 1
REMOTE

if [[ "$status" -eq 2 ]]; then
  echo "" >&2
  echo "The LaunchAgent isn't installed on $HOST yet. One-time setup:" >&2
  echo "  1. From this repo, on THIS machine (not $HOST) - copy the template unsubstituted:" >&2
  echo "       scp deploy/org.user.hebits-addon.plist \"$HOST:/tmp/org.user.hebits-addon.plist\"" >&2
  echo "  2. Then substitute and load it ON $HOST - the \$HOME in the sed must be that" >&2
  echo "     machine's, not this one's, or every path in the plist points at the wrong" >&2
  echo "     account and the service never spawns. Single quotes keep it unexpanded here:" >&2
  echo "       ssh \"$HOST\" 'mkdir -p ~/Library/LaunchAgents && sed \"s|__HOME__|\$HOME|g\" /tmp/org.user.hebits-addon.plist > ~/Library/LaunchAgents/org.user.hebits-addon.plist && launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/org.user.hebits-addon.plist'" >&2
  echo "  Then re-run this script." >&2
fi
if [[ "$status" -ne 0 ]]; then
  exit 1
fi
