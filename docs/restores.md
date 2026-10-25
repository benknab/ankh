# Restore checks

Restore into a new directory or database and inspect the result before replacing
live data. Do not restore over a running application.

## Restic

With the quickstart's host variables and Compose service:

```sh
mkdir -m 700 /path/to/restore
docker compose -f examples/compose.yaml run --rm \
  -e RESTIC_REPOSITORY=/backups/restic \
  -e RESTIC_PASSWORD_FILE=/secrets/restic-password \
  -e RESTIC_CACHE_DIR=/tmp/restic-cache \
  --entrypoint restic backup snapshots --host example-host --tag job:example-job
docker compose -f examples/compose.yaml run --rm \
  -v /path/to/restore:/restore \
  --cap-add CHOWN --cap-add FOWNER \
  -e RESTIC_REPOSITORY=/backups/restic \
  -e RESTIC_PASSWORD_FILE=/secrets/restic-password \
  -e RESTIC_CACHE_DIR=/tmp/restic-cache \
  --entrypoint restic backup restore latest --host example-host --tag job:example-job --target /restore
```

Restic restores the staged path below `/restore/staging/<job>/`. Choose an explicit
snapshot ID instead of `latest` when verifying a particular backup. Keep the
password independently recoverable; the repository alone is insufficient.

## Proton download and archive verification

Use a dedicated test job/folder for account smoke tests. Log in with the shared
credential volume, run `init`, `backup`, `retry`, and `check`, then download a
specific archive and its checksum. The official CLI runs with these environment
settings when invoked directly:

```sh
mkdir -m 700 /path/to/download
docker run --rm --platform linux/amd64 \
  -v backup-proton-state:/proton -v /path/to/download:/download \
  -e GNUPGHOME=/proton/gnupg -e HOME=/tmp \
  -e PASSWORD_STORE_DIR=/proton/pass -e PROTON_DRIVE_CACHE_DIR=/proton/cache \
  -e PROTON_DRIVE_CREDENTIALS_STORE=pass -e PROTON_DRIVE_LOG_LEVEL=WARNING \
  --entrypoint proton-drive backup-runner:local filesystem download \
  '/my-files/Backups/example-host/example-job/ARCHIVE.tar.zst' \
  '/my-files/Backups/example-host/example-job/ARCHIVE.tar.zst.sha256' /download
```

Replace `ARCHIVE` with the actual job/timestamp name from `filesystem list` or the
Drive UI. Download to an empty directory to avoid interactive conflict handling.
Use the same locally built image as the backup job.

```sh
docker run --rm --platform linux/amd64 -v /path/to/download:/restore \
  --entrypoint sh backup-runner:local -ec \
  'cd /restore; sha256sum --check ARCHIVE.tar.zst.sha256; zstd --test ARCHIVE.tar.zst; mkdir extracted; tar --use-compress-program=zstd --extract --file ARCHIVE.tar.zst --directory extracted'
```

Archives contain `<job>/...`. Treat downloaded archives as trusted only after
checking their origin and checksum; extract into an empty recovery directory.

## Verify source contents

- **SQLite:** run `sqlite3 restored.db 'PRAGMA integrity_check;'`, then check
  application-specific rows. For the disposable quickstart, `SELECT value FROM
  records;` must return `verified`.
- **PostgreSQL:** create an empty disposable database, then run
  `pg_restore --exit-on-error --no-owner --no-acl --dbname=restore_test database.dump`
  using the matching client and test-server connection environment. Check tables,
  counts, and representative rows. Restore roles/configuration separately if your
  application needs them.
- **Gitea:** from the restored stage, run `git clone
  repositories/owner/repository.git restored-repository`, then `git -C
  restored-repository lfs pull` and `git -C restored-repository fsck --full`.
  Check the expected commit and the bytes of an LFS-managed file. The original
  server is not needed when LFS objects exist in the restored mirror. The Git
  mirror does not restore the Gitea application database or account settings.

Record the source revision/snapshot, image digest, restore date, and outcome in
your private operations records. Test unattended credentials by taking another
backup from a fresh container with the same state volume.
