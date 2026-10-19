#!/usr/bin/env bash
# Nightly backup: snapshot the volumes with deploy/backup.sh, keep 14 locally,
# and copy the newest one to an S3-compatible bucket when offbox.env exists.
# Retention off the box is the bucket's lifecycle rule, not this script.
#
# /opt/aldine/offbox.env:
#   OFFBOX_S3_URI=s3://bucket/prefix
#   AWS_ACCESS_KEY_ID=...  AWS_SECRET_ACCESS_KEY=...  AWS_DEFAULT_REGION=eu-west-1
#   AWS_ENDPOINT_URL=...   # only for a non-AWS provider (R2, B2, Wasabi, ...)
set -euo pipefail
DIR=/var/backups/aldine
ENV_FILE="${OFFBOX_ENV:-/opt/aldine/offbox.env}"
mkdir -p "$DIR"
OUT="$DIR/aldine-$(date -u +%Y%m%d-%H%M%S).tar.gz"
/opt/aldine/backup.sh "$OUT"
ls -1t "$DIR"/aldine-*.tar.gz | tail -n +15 | xargs -r rm -f

[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE: local backup only"; exit 0; }
URI="$(sed -n 's/^OFFBOX_S3_URI=//p' "$ENV_FILE")"
[ -n "$URI" ] || { echo "error: OFFBOX_S3_URI missing in $ENV_FILE" >&2; exit 1; }
docker run --rm --env-file "$ENV_FILE" -v "$DIR":/backup:ro \
  amazon/aws-cli:2.31.0 s3 cp --only-show-errors "/backup/$(basename "$OUT")" "${URI%/}/$(basename "$OUT")"
echo "uploaded: ${URI%/}/$(basename "$OUT")"
