#!/usr/bin/env bash

set -Eeuo pipefail

readonly DEPLOYMENT_ROOT="${DEPLOYMENT_ROOT:-/home/backup/deployment}"
readonly LOCK_FILE="${XDG_RUNTIME_DIR:-/tmp}/backup-runner.lock"

exec 9>"${LOCK_FILE}"
if ! flock --nonblock 9; then
    printf 'Another backup run holds %s\n' "${LOCK_FILE}" >&2
    exit 1
fi

jobs=(
    "server/example-app"
    "server/example-sqlite"
    "server/gitea"
)

status=0
for job in "${jobs[@]}"; do
    printf '\nRunning backup job from %s\n' "${job}"
    if ! docker compose \
        --project-directory "${DEPLOYMENT_ROOT}/${job}" \
        --profile backup \
        run --rm backup; then
        printf 'Backup job failed: %s\n' "${job}" >&2
        status=1
    fi
done

exit "${status}"
