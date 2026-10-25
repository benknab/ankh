#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
state=$(mktemp -d "${TMPDIR:-/tmp}/backup-runner-example.XXXXXX")
export SOURCE_DIR="$state/source" BACKUP_DIR="$state/backups"
export SECRETS_DIR="$state/secrets" STAGING_DIR="$state/staging"
export JOB_FILE="$root/examples/sqlite-restic.job.json"
export BACKUP_RUNNER_IMAGE="backup-runner-example-$$:$RANDOM"
compose=(docker compose --project-name "backup-runner-example-$$" --file "$root/examples/compose.yaml")

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  "${compose[@]}" down --volumes --remove-orphans || status=1
  if docker image inspect "$BACKUP_RUNNER_IMAGE" >/dev/null 2>&1; then
    docker run --rm --platform linux/amd64 --volume "$state:/cleanup" --entrypoint sh "$BACKUP_RUNNER_IMAGE" \
      -c 'rm -rf /cleanup/source /cleanup/backups /cleanup/secrets /cleanup/staging /cleanup/restore' || status=1
    docker image rm "$BACKUP_RUNNER_IMAGE" >/dev/null 2>&1 || status=1
  fi
  rm -rf -- "$state"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

umask 077
mkdir -p "$SOURCE_DIR" "$BACKUP_DIR" "$SECRETS_DIR" "$STAGING_DIR" "$state/restore"
printf 'example-only-password\n' > "$SECRETS_DIR/restic-password"
printf 'serial=example-drive\nuuid=example-filesystem\n' > "$BACKUP_DIR/.sentinel"
"${compose[@]}" build backup
"${compose[@]}" run --rm --volume "$SOURCE_DIR:/source" --entrypoint sqlite3 backup \
  /source/example.db "CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('verified');"
for action in validate init backup check-read-data; do
  "${compose[@]}" run --rm backup "$action"
done
"${compose[@]}" run --rm --volume "$state/restore:/restore" \
  --env RESTIC_REPOSITORY=/backups/restic --env RESTIC_PASSWORD_FILE=/secrets/restic-password \
  --env RESTIC_CACHE_DIR=/tmp/restic-cache \
  --entrypoint restic backup restore latest --target /restore
value=$("${compose[@]}" run --rm --volume "$state/restore:/restore:ro" --entrypoint sqlite3 backup \
  /restore/staging/example-job/example.db 'SELECT value FROM records;')
test "$value" = verified
echo "SQLite backup and restore verified."
