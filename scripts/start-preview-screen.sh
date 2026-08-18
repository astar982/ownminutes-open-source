#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/.data/logs"
PORT="${OWNMINUTES_PREVIEW_PORT:-3003}"
LOG_FILE="$LOG_DIR/screen-preview-$PORT.log"
SESSION_NAME="ownminutes-preview-$PORT"

mkdir -p "$LOG_DIR"
OWNMINUTES_PREVIEW_PORT="$PORT" node "$ROOT_DIR/scripts/stop-preview-screen.mjs"
: > "$LOG_FILE"

SUPPORT_EMAIL="${OWNMINUTES_SUPPORT_EMAIL:-support@example.com}"
export OWNMINUTES_SUPPORT_EMAIL="$SUPPORT_EMAIL"

screen -dmS "$SESSION_NAME" /bin/zsh -lc "cd '$ROOT_DIR' && OWNMINUTES_ALLOW_LOCAL_AUTH_TOKEN_RESPONSE=1 ./node_modules/.bin/next start --hostname 127.0.0.1 --port $PORT >> '$LOG_FILE' 2>&1"

sleep 2

if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Preview failed to start. Log:"
  tail -n 80 "$LOG_FILE" || true
  exit 1
fi

echo "OwnMinutes preview is running at http://127.0.0.1:$PORT/"
echo "screen session: $SESSION_NAME"
echo "log: $LOG_FILE"
