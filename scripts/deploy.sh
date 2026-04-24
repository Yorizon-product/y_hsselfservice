#!/usr/bin/env bash
# Deploy the hsselfservice app on yorizoncasey.
#
# Assumes:
#   - /srv/hsselfservice is a git checkout of this repo.
#   - /srv/hsselfservice/.env exists (0600, owner hsselfservice:hsselfservice).
#   - Docker Engine + compose plugin present.
#
# Flow:
#   1. git fetch + fast-forward master (or a --ref)
#   2. docker compose pull         (new image from GHCR)
#   3. docker compose up -d --wait (recreates container, blocks on healthcheck)
#   4. print status + last 10 log lines
#
# Usage (on host):
#   sudo /srv/hsselfservice/scripts/deploy.sh [--ref <git-ref>]
#
# Remote:
#   ssh caseyromkes@5.182.232.20 'sudo /srv/hsselfservice/scripts/deploy.sh'

set -euo pipefail

REPO_ROOT="/srv/hsselfservice"
REF=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { printf '[deploy] %s\n' "$*"; }

[[ -d "${REPO_ROOT}/.git" ]] || {
  echo "error: ${REPO_ROOT} is not a git checkout." >&2
  exit 1
}
[[ -f "${REPO_ROOT}/.env" ]] || {
  echo "error: ${REPO_ROOT}/.env missing. Copy from .env.example and fill in secrets." >&2
  exit 1
}

# Repo is owned by `hsselfservice`; register safe.directory for root under
# sudo (HOME follows invoker, so `--global` needs HOME=/root to land in the
# right .gitconfig).
HOME=/root git config --global --add safe.directory "${REPO_ROOT}" >/dev/null 2>&1 || true

log "fetching origin"
sudo -u hsselfservice git -C "${REPO_ROOT}" fetch --prune origin

if [[ -n "${REF}" ]]; then
  log "checking out ref: ${REF}"
  sudo -u hsselfservice git -C "${REPO_ROOT}" checkout --detach "${REF}"
else
  log "fast-forwarding master"
  sudo -u hsselfservice git -C "${REPO_ROOT}" checkout master
  sudo -u hsselfservice git -C "${REPO_ROOT}" pull --ff-only origin master
fi

COMMIT="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"
log "checked out: ${COMMIT}"

cd "${REPO_ROOT}"

# If rolling back by ref, map the git SHA to the corresponding GHCR tag.
if [[ -n "${REF}" ]]; then
  SHA_TAG="sha-$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"
  log "using image tag: ${SHA_TAG}"
  export IMAGE_TAG="${SHA_TAG}"
fi

log "docker compose pull"
docker compose pull

log "docker compose up -d --wait"
if ! docker compose up -d --wait --wait-timeout 60; then
  log "compose up FAILED — recent logs:"
  docker compose logs --tail 80 hsselfservice || true
  exit 1
fi

log "deployed commit ${COMMIT}:"
docker compose ps
log "last 10 log lines:"
docker compose logs --tail 10 hsselfservice
