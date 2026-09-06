#!/usr/bin/env bash
# Snapshot Aldine's data + secrets volumes to a single tarball.
# Usage: deploy/backup.sh [output.tar.gz]   (run from anywhere; needs docker)
set -euo pipefail

PROJECT="${ALDINE_PROJECT:-aldine}"
OUT="${1:-aldine-backup-$(date +%Y%m%d-%H%M%S).tar.gz}"
OUT_DIR="$(cd "$(dirname "$OUT")" 2>/dev/null && pwd || pwd)"
OUT_FILE="$(basename "$OUT")"

# Volumes are created as <project>_<name> by docker compose.
DATA_VOL="${PROJECT}_aldine-data"
SECRETS_VOL="${PROJECT}_aldine-secrets"

for v in "$DATA_VOL" "$SECRETS_VOL"; do
  if ! docker volume inspect "$v" >/dev/null 2>&1; then
    echo "error: volume '$v' not found (set ALDINE_PROJECT if your compose project name differs)" >&2
    exit 1
  fi
done

docker run --rm \
  -v "${DATA_VOL}":/data:ro \
  -v "${SECRETS_VOL}":/secrets:ro \
  -v "${OUT_DIR}":/backup \
  alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce tar czf "/backup/${OUT_FILE}" -C / data secrets

echo "Backup written: ${OUT_DIR}/${OUT_FILE}"
echo "Contains: /data (projects + git repos) and /secrets (users, sessions, API keys, comments)."
