#!/bin/sh
set -eu

usage() {
  echo "Usage: bootstrap-codex-sync.sh VAULT [DEVICE] [folder|git] [--daemon]" >&2
  exit 2
}

[ "$#" -ge 1 ] || usage
VAULT=$(cd "$1" && pwd)
DEVICE=${2:-"$(hostname)"}
TRANSPORT=${3:-folder}
DAEMON=${4:-}
CODEX_HOME=${CODEX_HOME:-"$HOME/.codex"}
SOURCE="$VAULT/skills/codex/codex-sync"
DESTINATION="$CODEX_HOME/skills/codex-sync"

[ -f "$SOURCE/SKILL.md" ] || { echo "Codex Sync skill was not found in vault: $SOURCE" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js 22 or newer is required." >&2; exit 1; }
MAJOR=$(node --version | sed 's/^v//' | cut -d. -f1)
[ "$MAJOR" -ge 22 ] || { echo "Codex Sync requires Node.js 22 or newer." >&2; exit 1; }

mkdir -p "$DESTINATION"
cp -R "$SOURCE/." "$DESTINATION/"
CLI="$DESTINATION/scripts/codexsync.mjs"
CONFIG=${CODEX_SYNC_CONFIG:-"$HOME/.codex-sync/config.json"}

if [ ! -f "$CONFIG" ]; then
  node --no-warnings "$CLI" init --vault "$VAULT" --transport "$TRANSPORT" --device "$DEVICE" --codex-home "$CODEX_HOME" --config "$CONFIG"
else
  node --no-warnings "$CLI" vault use --vault "$VAULT" --transport "$TRANSPORT" --config "$CONFIG" --no-sync
fi
if [ -f "$VAULT/.codex-sync/maintenance.json" ]; then
  echo "Codex Sync maintenance mode detected; performing controlled pull and head refresh without enabling the scheduler."
  node --no-warnings "$CLI" pull --force --config "$CONFIG"
  node --no-warnings "$CLI" sync --force --config "$CONFIG"
  if [ "$DAEMON" = "--daemon" ]; then echo "Scheduler installation deferred until fleet maintenance is disabled." >&2; fi
else
  node --no-warnings "$CLI" sync --config "$CONFIG"
  if [ "$DAEMON" = "--daemon" ]; then node --no-warnings "$CLI" daemon install --minutes 5 --config "$CONFIG"; fi
fi
node --no-warnings "$CLI" device report --config "$CONFIG"
node --no-warnings "$CLI" doctor --config "$CONFIG"
