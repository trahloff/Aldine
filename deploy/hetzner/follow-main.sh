#!/bin/sh
# Started every 10 minutes by aldine-follow-main.timer. Does nothing unless
# .env pins ALDINE_VERSION=main: then it pulls the `main` images (pushed by
# .github/workflows/main-images.yml once a main commit has passed CI, the
# smoke test and the upgrade and restore drills) and restarts only the
# services whose image changed. Self-hosters pin a release instead; `main`
# is for the maintainer's own instance and is never a release.
set -eu
cd "${ALDINE_DIR:-/opt/aldine}"
[ "$(sed -n 's/^ALDINE_VERSION=//p' .env)" = main ] || exit 0
exec 9>"${ALDINE_LOCK:-/run/aldine-deploy.lock}"
flock -n 9 || exit 0   # a deploy.sh run is in progress

running() { docker compose ps -q | xargs -r docker inspect -f '{{.Image}}' | sort -u; }
wanted() { docker compose config --images | xargs -r -n1 docker image inspect -f '{{.Id}}' 2>/dev/null | sort -u; }

docker compose pull -q
if [ "$(running)" = "$(wanted)" ]; then exit 0; fi
echo "main moved; restarting on $(docker compose config --images | tr '\n' ' ')"
docker compose up -d --wait --wait-timeout 600
docker image prune -f >/dev/null
docker compose ps --format "table {{.Service}}\t{{.Image}}\t{{.Status}}"
