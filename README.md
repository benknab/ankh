# Backup runner

A standalone Node.js project using pnpm, Vite+, and stable Effect.
Use the versions in `.node-version` and `package.json`. Each opted-in app
owns its Compose backup service, source mounts, and job file. The runner stages
and checks the source once, then attempts every configured destination. A failed
destination fails the job while preserving successful copies and pending
uploads.

Keep the Node platform packages compatible with Effect. See `pnpm-workspace.yaml`
for the shared adapter override and its reason.

## Structure

- `src/model.ts`: Schema validation, branded paths/names, and typed requests.
- `src/commands.ts`: scoped Effect child processes and exit-code checks.
- `src/storage.ts`: Effect filesystem services, drive identity checks, and
  locks.
- `src/sources.ts`: online SQLite snapshots, PostgreSQL dumps, and Gitea Git/LFS
  mirrors.
- `src/restic.ts`: local encrypted snapshots and retention.
- `src/outbox.ts`: durable archive publication and Effect Queue/Stream delivery.
- `src/proton.ts`: official Proton Drive CLI adapter.
- `src/retention.ts`: UTC calendar retention over parsed snapshots.
- `src/destinations.ts`, `src/runner.ts`: destination dispatch and job
  execution.
- `src/auth.ts`, `src/scheduler.ts`: login and the in-container Effect
  scheduler.
- `main.ts`: Effect CLI and runtime entry point.

All application infrastructure uses Effect libraries. External tools handle
SQLite online backup, PostgreSQL dump/restore, Git/LFS, Restic, tar/zstd,
GPG/pass, and Proton's protocol. `AGENTS.md` explains how to use the Effect
skill bundled in `node_modules/effect/`.

## Development

Run these commands from `backup-runner/`:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm start --help
docker build -t backup-runner:local .
```

Node runs TypeScript directly, without a build step. `pnpm check` runs Vite+
Oxlint, including the recommended Effect rules, and TypeScript; `pnpm test` runs
Vite+ Vitest. Installation patches Oxlint through `@effect/tsgo`, not TypeScript.
Run `pnpm prepare` if you install with scripts disabled. Tests and configuration use
the same strict type checks as the source. Format only from the deployment root with
`pnpm fmt backup-runner` or `pnpm fmt:check backup-runner`; use its single root
Oxfmt config and installation.

Tests load the Vite+ config with Node's native TypeScript support. The integration
command also disables Vitest's disk cache so it can run in a read-only container.
The TypeScript config includes DOM declarations required by Effect's Web APIs
and Vite+'s bundled test types; tests and the app still run in Node, not a browser.

Unit tests use service layers and do not need credentials. Integration tests
need the external tools in the image. Build the separate test target, which
includes Vite+ and the test files; the production image installs only runtime
dependencies:

```sh
docker build --target test -t backup-runner:test .
docker run --rm --read-only --cap-drop ALL --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:size=128m,mode=1777 --tmpfs /staging:size=64m,mode=0700 \
  --tmpfs /proton:size=32m,mode=0700 \
  -e BACKUP_INTEGRATION=1 \
  backup-runner:test
```

Tests exercise real SQLite, Restic, tar/zstd, and filesystem operations; a test
Proton service simulates upload failure and recovery. A real Proton upload and
download still require login.

The PostgreSQL integration test also needs `BACKUP_POSTGRES_INTEGRATION=1` and a
fresh PostgreSQL 15 server reachable as `postgres-test` on the test container's
Docker network, with user `postgres` and password `integration-test-only`. Use a
disposable server with a tmpfs data directory. The test creates `source_test`
and `restore_test`, stages a real dump, restores and queries it, then checks
that wrong credentials fail without exposing the password.

## PostgreSQL sources

Use source type `postgres` with `hostname`, `port`, `database`, `username`,
`passwordFile`, and `output` (see `../server/example-postgres/backup.job.json`). The
password file contains the password with an optional trailing newline. The
runner passes connection details through the dump process environment, never
command arguments. It creates a consistent custom-format dump while the app runs
and checks every archive entry with `pg_restore --file=/dev/null`. This checks
readability, not whether a database restore succeeds; test restores separately.

The image installs PostgreSQL 15 clients from the signed PostgreSQL apt
repository to match Example PostgreSQL's server. Revisit the client major version before
upgrading that server. Dumps include database objects and data, not cluster
roles or app secrets. Keep recovery copies of those separately.

## Setup

The backup disk mounts at `/mnt/backup-drive`. The sentinel's serial and
filesystem UUID must match each job. The runner takes a disk-wide `.runner-lock`
directory before staging or writing. If a crash leaves a stale lock, confirm no
runner is active before removing it.

Create the Restic password once and save a recovery copy in Proton Pass:

```sh
sudo install -d -o root -g root -m 700 /etc/backup-runner
openssl rand -base64 48 | sudo tee /etc/backup-runner/restic-password >/dev/null
sudo chmod 600 /etc/backup-runner/restic-password
```

The Gitea job also needs `/etc/backup-runner/gitea-token`, mode `600`,
containing a read-only repository token with access to the repositories you want
to protect.

From `backup-runner/`, sign in to Proton:

```sh
docker volume create backup-proton-state
docker compose run --rm proton-auth
```

Open the printed URL on any device and keep the command running until it
finishes. The image pins official Proton Drive CLI 0.8.0 and verifies its
published SHA-512 checksum. The external `backup-proton-state` volume holds the
session, cache, and GPG/pass store. The local GPG key has no passphrase for
unattended operation; access to this volume gives access to the stored session.
App stack teardown does not delete this external volume.

## Operations

Run these from an opted-in app directory, such as `server/example-app/`:

```sh
docker compose run --no-deps --rm backup init
docker compose run --no-deps --rm backup backup
docker compose run --no-deps --rm backup retry
docker compose run --no-deps --rm backup check
docker compose run --no-deps --rm backup check-read-data
```

`retry` drains the durable Proton outbox without reading the source or creating
a new snapshot. `check` validates Restic metadata, queued archives, and complete
remote archive pairs. `check-read-data` also reads every Restic pack. Neither
check downloads Proton archive contents; test those through a downloaded
restore.

## Outbox and retention

The runner creates a portable `tar.zst` and SHA-256 file inside an owner-only
temporary directory on the backup disk. After checking both, it atomically
renames the directory into the ready outbox. Archives stay plaintext locally
while queued. Only complete published pairs enter the Effect Queue. Each retry
rechecks the checksum and compressed stream before upload. Acknowledgement
removes a pair only after Proton confirms both remote filenames. Legacy flat
outbox pairs are also retried. Interrupted `.partial-*` directories are ignored
and can be removed when no run is active.

Both destinations use 14 daily, 8 weekly, 12 monthly, and 5 yearly retention.
Proton keeps the newest snapshot in each retained UTC period, with Monday-start
weeks, and moves expired pairs for this job to trash. It never empties account
trash; trashed data may still consume quota. Restic applies its native retention
and prunes unused data.

To restore a Proton archive, download its `.tar.zst` and `.sha256` files through
the official CLI or web app into an empty directory, then run:

```sh
sha256sum --check NAME.tar.zst.sha256
zstd --test NAME.tar.zst
tar --use-compress-program=zstd --extract --file NAME.tar.zst
```

Check SQLite with `PRAGMA quick_check` and a known query; check Git mirrors with
`git fsck --full`. Restore into a separate directory before replacing live data.

## Scope and schedule

The runner never scans general host files, mounts the Docker socket, stops apps,
or backs up unrelated application data. Gitea protects Git history and fetched LFS
objects, not Gitea users, issues, settings, or its database. Existing cached
mirrors remain available when a repository disappears from the API.

Each enabled app's `backup` service runs `backup-runner schedule` continuously.
Effect's `Schedule.cron` triggers the job daily at **03:30 UTC**,
without a daylight-saving offset. A normal `docker compose up -d`
starts the scheduler alongside the app, except for opt-in profiles such as
Example PostgreSQL's `backup` profile. Follow that app's restore checks before enabling it.
To start only the backup service after setup:

```sh
docker compose up -d --no-deps backup
docker compose logs backup
```

All jobs share the disk lock, so they run one at a time even when their
schedules fire together. A waiting job retries lock acquisition every ten
seconds for up to six hours. Failure logs an error and preserves pending
archives; the scheduler continues to the next night. Use `retry` for an
immediate outbox retry.

The scheduler waits until the next scheduled time on startup. It does not replay
missed runs after downtime; use the manual `backup` command if needed. Docker's
`restart: unless-stopped` brings the scheduler back after a reboot. No host
timer, cron daemon, or Docker socket is needed.
