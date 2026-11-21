#!/usr/bin/env bash
# Prove the newest off-box backup restores: download it, restore it into a
# separate compose project's volumes, start the deployed app image on them
# with no network, and check health, the account database and the projects.
# Nothing touches the live volumes, and the data never leaves this box.
# Usage (on the box): /opt/aldine/restore-drill.sh [--local]
#   --local   drill the newest local backup in /var/backups/aldine instead
# Prints one summary line; exits non-zero on any failure. Needs roughly the
# backup's size free twice (download plus restored volumes).
set -euo pipefail
cd /opt/aldine
DRILL=aldine-drill
TMP="$(mktemp -d /var/tmp/aldine-drill.XXXXXX)"
APP_NAME="${DRILL}-app"
cleanup() {
  docker rm -f "$APP_NAME" >/dev/null 2>&1 || true
  docker volume rm -f "${DRILL}_aldine-data" "${DRILL}_aldine-secrets" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

if [ "${1:-}" = "--local" ]; then
  SRC="$(ls -1t /var/backups/aldine/aldine-*.tar.gz 2>/dev/null | head -n 1)"
  [ -n "$SRC" ] || { echo "error: no local backup in /var/backups/aldine" >&2; exit 1; }
  NAME="$(basename "$SRC")"
  cp "$SRC" "$TMP/$NAME"
else
  [ -f offbox.env ] || { echo "error: no /opt/aldine/offbox.env, so there is no off-box backup to drill (use --local)" >&2; exit 1; }
  URI="$(sed -n 's/^OFFBOX_S3_URI=//p' offbox.env)"; URI="${URI%/}"
  AWS=(docker run --rm --env-file offbox.env -v "$TMP":/backup amazon/aws-cli:2.31.0)
  NAME="$("${AWS[@]}" s3 ls "$URI/" | awk '{print $4}' | grep '^aldine-.*\.tar\.gz$' | sort | tail -n 1)"
  [ -n "$NAME" ] || { echo "error: no backup under $URI/" >&2; exit 1; }
  "${AWS[@]}" s3 cp --only-show-errors "$URI/$NAME" "/backup/$NAME"
fi

# The backup's age from its name (aldine-YYYYmmdd-HHMMSS.tar.gz, UTC).
STAMP="$(echo "$NAME" | sed -n 's/^aldine-\([0-9]\{8\}\)-\([0-9]\{2\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)\.tar\.gz$/\1 \2:\3:\4/p')"
AGE_H="?"
[ -n "$STAMP" ] && AGE_H="$(( ($(date -u +%s) - $(date -u -d "$STAMP" +%s)) / 3600 ))"
SIZE="$(du -h "$TMP/$NAME" | cut -f1)"

docker volume create "${DRILL}_aldine-data" >/dev/null
docker volume create "${DRILL}_aldine-secrets" >/dev/null
ALDINE_PROJECT="$DRILL" ./restore.sh --yes "$TMP/$NAME" >/dev/null

IMAGE="$(docker inspect --format '{{.Config.Image}}' "$(docker compose ps -q app)")"
# No network: a restored instance must never send email, push to a git host
# or report errors as if it were the live one.
docker run -d --name "$APP_NAME" --network none --init \
  --env-file .env -e NODE_ENV=production \
  -v "${DRILL}_aldine-data":/data -v "${DRILL}_aldine-secrets":/secrets \
  "$IMAGE" >/dev/null

ok=""
for _ in $(seq 1 60); do
  if docker exec "$APP_NAME" node -e "require('http').get('http://localhost:3000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; then ok=1; break; fi
  sleep 2
done
[ -n "$ok" ] || { echo "error: the restored app did not become healthy; last log lines:" >&2; docker logs --tail 20 "$APP_NAME" >&2; exit 1; }

# Counts only, never names: the drill's output lands in CI logs.
COUNTS="$(docker exec "$APP_NAME" node -e "
const fs = require('fs');
const out = { projects: fs.readdirSync('/data/projects').length };
if (fs.existsSync('/secrets/aldine.db')) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/secrets/aldine.db');
  out.integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  out.tables = db.prepare(\"SELECT count(*) AS n FROM sqlite_master WHERE type='table'\").get().n;
}
console.log(JSON.stringify(out));
" 2>/dev/null)"
[ -n "$COUNTS" ] || { echo "error: could not read the restored volumes" >&2; exit 1; }
if echo "$COUNTS" | grep -q '"integrity"' && ! echo "$COUNTS" | grep -q '"integrity":"ok"'; then
  echo "error: the restored account database fails its integrity check: $COUNTS" >&2; exit 1
fi

echo "restore drill OK: $NAME ($SIZE, ${AGE_H} h old), image $IMAGE, $COUNTS"
