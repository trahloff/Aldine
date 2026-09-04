#!/usr/bin/env bash
# Restore Aldine's data + secrets volumes from a backup tarball.
# Usage: deploy/restore.sh aldine-backup-YYYYmmdd-HHMMSS.tar.gz
# WARNING: overwrites the current volume contents. Stop the stack first:
#   docker compose down
set -euo pipefail

PROJECT="${ALDINE_PROJECT:-aldine}"
IN="${1:?usage: restore.sh <backup.tar.gz>}"
IN_DIR="$(cd "$(dirname "$IN")" && pwd)"
IN_FILE="$(basename "$IN")"

DATA_VOL="${PROJECT}_aldine-data"
SECRETS_VOL="${PROJECT}_aldine-secrets"

read -r -p "This overwrites ${DATA_VOL} and ${SECRETS_VOL}. Continue? [y/N] " ok
[ "$ok" = "y" ] || { echo "aborted"; exit 1; }

# create volumes if missing
docker volume create "$DATA_VOL" >/dev/null
docker volume create "$SECRETS_VOL" >/dev/null

docker run --rm \
  -v "${DATA_VOL}":/data \
  -v "${SECRETS_VOL}":/secrets \
  -v "${IN_DIR}":/backup:ro \
  alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce sh -c "rm -rf /data/* /secrets/* && tar xzf /backup/${IN_FILE} -C /"

echo "Restored from ${IN_FILE}. Start the stack: docker compose up -d"
