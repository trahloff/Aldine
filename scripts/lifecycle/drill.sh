#!/usr/bin/env bash
# The two things a self-hoster does with their data, run end to end against
# real images with accounts on (scripts/lifecycle/data.mjs seeds and checks):
#
#   drill.sh upgrade   start the previous release on fresh volumes, seed it,
#                      stop it, start the candidate on the same volumes, verify
#   drill.sh restore   start the candidate, seed it, deploy/backup.sh while it
#                      runs, delete the stack and its volumes, then restore on
#                      an empty Docker the way deploy/README.md ("Restore")
#                      says, and verify
#
# Environment (all optional):
#   CANDIDATE_APP_IMAGE, CANDIDATE_COMPILER_IMAGE
#                     images under test (default: the release docker-compose.yml pins)
#   PREVIOUS_VERSION  release the upgrade starts from (default: the pinned one)
#   DATASTORE         json (default) or postgres (the bundled `db` service)
#   ALDINE_PROJECT    compose project name (default aldine-lifecycle; never aldine)
#   ALDINE_PORT       host port of the app (default 8191, beside a stack on 8080)
#   ALDINE_REGISTRY   where released images come from (default ghcr.io/trahloff)
#   KEEP_STACK=1      leave the stack and its volumes up afterwards
#
# It removes only its own compose project's containers and volumes.
set -euo pipefail

DRILL="${1:-}"
case "$DRILL" in upgrade|restore) ;; *) echo "usage: $0 upgrade|restore" >&2; exit 2 ;; esac
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

DATASTORE="${DATASTORE:-json}"
PROJECT="${ALDINE_PROJECT:-aldine-lifecycle}"
PORT="${ALDINE_PORT:-8191}"
REGISTRY="${ALDINE_REGISTRY:-ghcr.io/trahloff}"
PINNED="$(sed -n 's/.*aldine-app:\${ALDINE_VERSION:-\([^}]*\)}.*/\1/p' docker-compose.yml)"
PREVIOUS="${PREVIOUS_VERSION:-$PINNED}"
CANDIDATE_APP="${CANDIDATE_APP_IMAGE:-$REGISTRY/aldine-app:$PINNED}"
CANDIDATE_COMPILER="${CANDIDATE_COMPILER_IMAGE:-$REGISTRY/aldine-compiler:$PINNED}"
case "$DATASTORE" in json|postgres) ;; *) echo "DATASTORE must be json or postgres, got '$DATASTORE'" >&2; exit 2 ;; esac
# down -v below deletes this project's volumes: never let that be a real install.
if [ "$PROJECT" = aldine ]; then echo "refusing ALDINE_PROJECT=aldine: the drill deletes its project's volumes" >&2; exit 2; fi

WORK="$(mktemp -d)"
STATE="$WORK/state.json"
BACKUP="$WORK/aldine-backup.tar.gz"
# A .env next to the compose files is the operator's own configuration; the
# drill's stack reads only this one.
{
  echo "AUTH_ENABLED=1"
  echo "ALDINE_PORT=$PORT"
  echo "ALDINE_APP_BIND=127.0.0.1"
  if [ "$DATASTORE" = postgres ]; then
    echo "DATABASE_URL=postgres://aldine:aldine@db:5432/aldine"
  fi
} > "$WORK/drill.env"
PROFILE=()
[ "$DATASTORE" = postgres ] && PROFILE=(--profile postgres)
export ALDINE_URL="http://127.0.0.1:$PORT"

APP_IMAGE="" COMPILER_IMAGE=""
dc() {
  ALDINE_APP_IMAGE="${APP_IMAGE:-unset}" ALDINE_COMPILER_IMAGE="${COMPILER_IMAGE:-unset}" \
    docker compose -p "$PROJECT" --env-file "$WORK/drill.env" \
      -f docker-compose.full.yml -f deploy/docker-compose.prod.yml -f scripts/lifecycle/compose.yml \
      ${PROFILE[@]+"${PROFILE[@]}"} "$@"
}
step() { echo; echo "== $*"; }
passed() {
  step "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$1" >> "$GITHUB_STEP_SUMMARY"; fi
}
start() {
  APP_IMAGE="$1" COMPILER_IMAGE="$2"
  step "start $APP_IMAGE + $COMPILER_IMAGE ($DATASTORE datastore, project $PROJECT, port $PORT)"
  dc up -d --wait --wait-timeout 600 --quiet-pull
}
volumes() { docker volume ls -q | grep "^${PROJECT}_" || true; }

finish() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo; echo "== drill failed (exit $code); last container logs:"
    dc logs --no-color 2>/dev/null | tail -200 || true
  fi
  if [ "${KEEP_STACK:-}" = 1 ]; then
    echo "KEEP_STACK=1: stack $PROJECT left up, state in $STATE"
  else
    dc down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
  exit "$code"
}
trap finish EXIT

step "clean slate for project $PROJECT"
dc down -v --remove-orphans

if [ "$DRILL" = upgrade ]; then
  start "$REGISTRY/aldine-app:$PREVIOUS" "$REGISTRY/aldine-compiler:$PREVIOUS"
  node scripts/lifecycle/data.mjs seed --state "$STATE"
  step "stop the previous release; the volumes stay"
  dc down
  start "$CANDIDATE_APP" "$CANDIDATE_COMPILER"
  node scripts/lifecycle/data.mjs verify --state "$STATE"
  passed "Upgrade from $PREVIOUS to $CANDIDATE_APP kept every seeded account, file, commit, branch, comment, share and token, and typesets ($DATASTORE datastore)."
  exit 0
fi

start "$CANDIDATE_APP" "$CANDIDATE_COMPILER"
node scripts/lifecycle/data.mjs seed --state "$STATE"
step "back up the running stack"
ALDINE_PROJECT="$PROJECT" deploy/backup.sh "$BACKUP"
ls -l "$BACKUP"
tar -tzf "$BACKUP" | awk -F/ '{print $1}' | sort | uniq -c
step "delete the stack and every volume it had"
dc down -v
left="$(volumes)"
if [ -n "$left" ]; then echo "volumes survived down -v: $left" >&2; exit 1; fi

step "restore onto an empty Docker (deploy/README.md, Restore)"
if [ "$DATASTORE" = postgres ]; then
  dc up -d --wait db
fi
ALDINE_PROJECT="$PROJECT" deploy/restore.sh --yes "$BACKUP"
dc up -d --wait --wait-timeout 600
node scripts/lifecycle/data.mjs verify --state "$STATE"
passed "Backup of $CANDIDATE_APP, restored onto empty volumes, kept every seeded account, file, commit, branch, comment, share and token, and typesets ($DATASTORE datastore)."
