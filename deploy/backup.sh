#!/usr/bin/env bash
# Snapshot Aldine's data + secrets volumes to a single tarball, plus a dump of
# the bundled Postgres database when the app runs on it (DATABASE_URL pointing
# at the `db` service): there, accounts, sessions, project metadata and
# comments live in Postgres, not in the secrets volume.
# Usage: deploy/backup.sh [output.tar.gz]   (run from anywhere; needs docker)
# With Postgres, run it while the stack is up: the dump comes from the running
# db container. An external database (DATABASE_URL elsewhere) is not reachable
# from here: back it up with its own tools and set ALDINE_BACKUP_DB=skip.
set -euo pipefail

PROJECT="${ALDINE_PROJECT:-aldine}"
OUT="${1:-aldine-backup-$(date +%Y%m%d-%H%M%S).tar.gz}"
mkdir -p "$(dirname "$OUT")"
OUT_DIR="$(cd "$(dirname "$OUT")" && pwd)"
OUT_FILE="$(basename "$OUT")"
ALPINE=alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

# Volumes are created as <project>_<name> by docker compose.
DATA_VOL="${PROJECT}_aldine-data"
SECRETS_VOL="${PROJECT}_aldine-secrets"

for v in "$DATA_VOL" "$SECRETS_VOL"; do
  if ! docker volume inspect "$v" >/dev/null 2>&1; then
    echo "error: volume '$v' not found (set ALDINE_PROJECT if your compose project name differs)" >&2
    exit 1
  fi
done

# The newest container of a compose service; extra args go to `docker ps` (-a).
container() {
  local service="$1"; shift
  docker ps "$@" -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=${service}" | head -n 1
}

# Which datastore the app uses is in its container's environment.
DB_URL=""
APP="$(container app -a)"
if [ -n "$APP" ]; then
  DB_URL="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$APP" | sed -n 's/^DATABASE_URL=//p')"
elif docker volume inspect "${PROJECT}_aldine-pg" >/dev/null 2>&1; then
  echo "error: project '${PROJECT}' has no app container, so whether the app keeps its data in Postgres (volume ${PROJECT}_aldine-pg exists) cannot be told. Start the stack and run this again." >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PARTS=(data secrets)
if [ -n "$DB_URL" ] && [ "${ALDINE_BACKUP_DB:-}" != skip ]; then
  DB_HOST="$(printf '%s' "$DB_URL" | sed -E 's#^[a-z]+://([^@/]*@)?(\[[^]]*\]|[^]:/?[]*).*#\2#')"
  if [ "$DB_HOST" != db ]; then
    echo "error: the app's database is at '${DB_HOST}', outside this compose project, so it cannot go into this backup. Back it up with its own tools, then run this with ALDINE_BACKUP_DB=skip." >&2
    exit 1
  fi
  DB="$(container db)"
  if [ -z "$DB" ]; then
    echo "error: the app keeps its data in Postgres, but the db container of project '${PROJECT}' is not running. Start the stack and run this again." >&2
    exit 1
  fi
  # --clean replaces whatever the restore target already holds (the app
  # creates its tables on first boot); --no-owner loads it as any role.
  docker exec "$DB" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges' > "$STAGE/aldine.sql"
  PARTS+=(postgres)
fi

docker run --rm \
  -v "${DATA_VOL}":/data:ro \
  -v "${SECRETS_VOL}":/secrets:ro \
  -v "${STAGE}":/postgres:ro \
  -v "${OUT_DIR}":/backup \
  "$ALPINE" tar czf "/backup/${OUT_FILE}" -C / "${PARTS[@]}"

echo "Backup written: ${OUT_DIR}/${OUT_FILE}"
if [ -s "$STAGE/aldine.sql" ]; then
  echo "Contains: /data (projects + git repos), /secrets (API keys, collaboration state) and a dump of the Postgres database (users, sessions, project metadata, comments)."
elif [ -n "$DB_URL" ]; then
  echo "Contains: /data (projects + git repos) and /secrets (API keys, collaboration state). Not the database (ALDINE_BACKUP_DB=skip): users, sessions, project metadata and comments are only in your own backup of it."
else
  echo "Contains: /data (projects + git repos) and /secrets (users, sessions, API keys, comments)."
fi
