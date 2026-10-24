#!/usr/bin/env bash
# Restore Aldine's data + secrets volumes from a backup tarball, and the
# Postgres database when deploy/backup.sh dumped one into it.
# Usage: deploy/restore.sh [--yes] aldine-backup-YYYYmmdd-HHMMSS.tar.gz
# WARNING: overwrites the current volume contents (and database). Stop the
# stack first; for a backup with a database, start the database alone
# (deploy/README.md, "Restore"):
#   docker compose down
#   docker compose --profile postgres up -d db     # Postgres datastore only
# --yes skips the confirmation.
set -euo pipefail

YES=""
if [ "${1:-}" = "--yes" ]; then YES=1; shift; fi
PROJECT="${ALDINE_PROJECT:-aldine}"
IN="${1:?usage: restore.sh [--yes] <backup.tar.gz>}"
IN_DIR="$(cd "$(dirname "$IN")" && pwd)"
IN_FILE="$(basename "$IN")"
ALPINE=alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

DATA_VOL="${PROJECT}_aldine-data"
SECRETS_VOL="${PROJECT}_aldine-secrets"

container() {
  docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=$1" | head -n 1
}

# A running app would keep writing into the volumes while they are replaced.
if [ -n "$(container app)" ]; then
  echo "error: the app of project '${PROJECT}' is running. Stop the stack first (docker compose down)." >&2
  exit 1
fi

DB=""
# Not grep -q: an early exit would SIGPIPE tar, and pipefail would read
# that as "no dump" and skip the database.
if tar -tzf "$IN" | grep -x 'postgres/aldine.sql' >/dev/null; then
  DB="$(container db)"
  if [ -z "$DB" ]; then
    echo "error: this backup holds a Postgres database, and the db container of project '${PROJECT}' is not running. Start it alone first: docker compose --profile postgres up -d db (with the same -f files as the stack)." >&2
    exit 1
  fi
  # A fresh volume is initialised first by a temporary server that listens on
  # the socket only, then restarted; TCP on 127.0.0.1 answers only the final one.
  tries=0
  until docker exec "$DB" sh -c 'pg_isready -q -h 127.0.0.1 -U "$POSTGRES_USER"'; do
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then echo "error: the database of project '${PROJECT}' did not become ready within a minute." >&2; exit 1; fi
    sleep 1
  done
fi

if [ -z "$YES" ]; then
  read -r -p "This overwrites ${DATA_VOL} and ${SECRETS_VOL}$([ -n "$DB" ] && echo ' and the Postgres database'). Continue? [y/N] " ok
  [ "$ok" = "y" ] || { echo "aborted"; exit 1; }
fi

# Labelled the way compose labels its own volumes, so `docker compose up`
# adopts them instead of warning that they were created outside compose.
for v in aldine-data aldine-secrets; do
  docker volume create --label "com.docker.compose.project=${PROJECT}" --label "com.docker.compose.volume=${v}" "${PROJECT}_${v}" >/dev/null
done

docker run --rm \
  -v "${DATA_VOL}":/data \
  -v "${SECRETS_VOL}":/secrets \
  -v "${IN_DIR}":/backup:ro \
  "$ALPINE" sh -c 'find /data /secrets -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar xzf "/backup/$0" -C / data secrets' "${IN_FILE}"

if [ -n "$DB" ]; then
  tar -xzOf "$IN" postgres/aldine.sql \
    | docker exec -i "$DB" sh -c 'exec psql -X -q -v ON_ERROR_STOP=1 --single-transaction -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null
  echo "Restored the Postgres database."
fi

echo "Restored from ${IN_FILE}. Start the stack: docker compose up -d"
