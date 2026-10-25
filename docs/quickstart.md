# Quickstart

Use Docker with Compose and a Linux/amd64 container. Docker Desktop can emulate
amd64 on an Apple Silicon host. The image packages the external tools the runner
needs; Node alone is not a supported native backup installation.

## Try a complete backup and restore

From a checkout, run:

```sh
bash tools/quickstart.sh
```

This builds the production image, creates a disposable SQLite database and Restic
repository, validates the job, takes a backup, reads the repository data, restores
the database, and checks its contents. It prints `SQLite backup and restore
verified.` on success. All data and the example password are temporary and removed
on exit. No account credentials or production mounts are used.

## Configure a persistent SQLite backup

Start with `examples/sqlite-restic.job.json` and `examples/compose.yaml`. Copy the
job outside this checkout before changing it. Job paths are **container paths**;
the Compose variables below are **absolute host paths**.

```sh
export SOURCE_DIR=/path/to/database-directory
export BACKUP_DIR=/path/to/mounted-backup-drive
export SECRETS_DIR=/path/to/private/secrets
export STAGING_DIR=/path/to/private/staging
export JOB_FILE=/path/to/backup.job.json
```

Create the directories yourself. Compose uses `create_host_path: false` to avoid
silently substituting empty host directories. The source directory must contain
the SQLite database and its WAL/SHM files. Mount the whole directory read-only.
Configure the database path/output, host/job names, retention, and disk identity
in the job. Put the Restic password in `SECRETS_DIR/restic-password` (mode 0600).

Once the actual backup drive is mounted, create its `.sentinel` file:

```text
serial=example-drive
uuid=example-filesystem
```

Replace both example values with your chosen identifiers, matching the job. This
is a marker check, not an independent hardware probe. See [operations](operations.md).

```sh
docker compose -f examples/compose.yaml build backup
docker compose -f examples/compose.yaml run --rm backup validate
docker compose -f examples/compose.yaml run --rm backup init
docker compose -f examples/compose.yaml run --rm backup backup
docker compose -f examples/compose.yaml run --rm backup check-read-data
```

Perform an actual [restore](restores.md) before scheduling. To use a released
image, set `BACKUP_RUNNER_IMAGE` to the release's `tag@sha256:digest`, run
`docker compose -f examples/compose.yaml pull backup`, and omit the build command.

## Add Proton Drive

Use `examples/sqlite-proton.job.json` as the template, with a remote folder and
outbox dedicated to this host/job. `examples/compose.proton.yaml` adds the shared
credential volume and authentication helper. It overrides the mounted job with
the bundled example: change that bind source to your private job before use.

```sh
docker volume create backup-proton-state
docker compose -f examples/compose.yaml -f examples/compose.proton.yaml run --rm proton-auth
docker compose -f examples/compose.yaml -f examples/compose.proton.yaml run --rm backup validate
docker compose -f examples/compose.yaml -f examples/compose.proton.yaml run --rm backup init
docker compose -f examples/compose.yaml -f examples/compose.proton.yaml run --rm backup backup
```

The first login is interactive and prints the browser sign-in instructions. Later
backups use the same persistent volume unattended. Restore a downloaded archive
before enabling the scheduler. Restic-only jobs need no Proton login or volume.

## Other sources

- `examples/postgres.job.json`: join the database's Docker network and mount the
  password file. The image uses PostgreSQL client major 15; server major 15 is
  integration-tested. Other server majors are not advertised as tested. Dumps
  contain one database, not cluster roles or server configuration.
- `examples/gitea.job.json`: mount a token file with access to the repositories
  you need. The URL is the instance base URL, optionally with a path prefix.
  Mirrors and Git LFS objects persist in staging between runs. This backs up
  repositories, not the Gitea database, users, issues, settings, or secrets.

For each source, configure enough disk-backed staging capacity and verify the
restore procedure for your application.
