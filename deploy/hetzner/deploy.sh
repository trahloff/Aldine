#!/usr/bin/env bash
# Push the stack files and the env to the box, then pull and (re)start.
# Usage: deploy/hetzner/deploy.sh <host> <path/to/aldine.env> [path/to/offbox.env]
# The env file sets ALDINE_VERSION; changing it and re-running is a deploy,
# re-running unchanged is a no-op apart from the file copy. The app is down
# while its container restarts (about a minute with the 120 s flush budget).
set -euo pipefail
HOST="${1:?usage: deploy.sh <host> <aldine.env> [offbox.env]}"
ENV_FILE="${2:?usage: deploy.sh <host> <aldine.env> [offbox.env]}"
OFFBOX_FILE="${3:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "root@$HOST")

grep -q '^ALDINE_VERSION=' "$ENV_FILE" || { echo "error: ALDINE_VERSION missing in $ENV_FILE" >&2; exit 1; }

"${SSH[@]}" 'cloud-init status --wait >/dev/null; mkdir -p /opt/aldine'
scp -q -o BatchMode=yes "$HERE/compose.yml" "$HERE/offbox-backup.sh" "$HERE/../backup.sh" "$HERE/../restore.sh" "$HERE/../Caddyfile" "root@$HOST:/opt/aldine/"
scp -q -o BatchMode=yes "$ENV_FILE" "root@$HOST:/opt/aldine/.env"
[ -n "$OFFBOX_FILE" ] && scp -q -o BatchMode=yes "$OFFBOX_FILE" "root@$HOST:/opt/aldine/offbox.env"

"${SSH[@]}" 'set -e; cd /opt/aldine; chmod 600 .env; [ -f offbox.env ] && chmod 600 offbox.env
  docker compose pull -q
  docker compose up -d --wait --wait-timeout 600
  docker image prune -f >/dev/null
  docker compose ps --format "table {{.Service}}\t{{.Image}}\t{{.Status}}"'
