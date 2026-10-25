#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
project="backup-runner-tests-$$-$RANDOM"
compose=(docker compose --project-name "$project" --file "$root/tests/compose.yaml")

docker info >/dev/null

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if ! "${compose[@]}" down --volumes --remove-orphans --rmi local; then
    if [[ "$status" -eq 0 ]]; then
      status=1
    fi
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${compose[@]}" build integration
"${compose[@]}" up --detach --wait --wait-timeout 60 postgres-test
"${compose[@]}" run --rm --no-deps integration "$@"
