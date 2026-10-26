# Ankh

Ankh is an unpublished, experimental prototype for backing up personal
self-hosted applications to a hard drive and to remote storage on Proton Drive.
The Proton integration works around the CLI's interactive authentication by
storing a regular account's session for unattended use. Proper service accounts
or SDK-managed authentication would be preferable; see [Security](#security).
It has no published release and is neither tested nor optimized for large data
sets. The source is available under the MIT license as a starting point for forks.

> [!NOTE]
> Ankh creates backups. Restoring application data follows each application's
> recovery procedure and is outside Ankh's scope.

## Architecture

A **job** is a JSON file that defines one source, one or both destinations,
retention counts, and a required schedule. A **source adapter** prepares a local
copy in `/staging/<job-name>`. A **destination adapter** stores that copy.

The source is staged once per backup. Each configured destination is then
attempted, even if another destination fails. A source failure prevents both
destination attempts. The command fails if staging or any destination fails.

### Source adapters

| Type        | Staged content                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `sqlite`    | One database, copied with SQLite's online backup command and checked with `PRAGMA quick_check`. |
| `postgres`  | One database, exported with `pg_dump --format=custom` and read back with `pg_restore`.          |
| `gitea-git` | Git mirrors of repositories visible to the configured Gitea token.                              |

Git LFS is not supported. The Gitea adapter does not fetch or verify LFS objects;
LFS pointer files remain ordinary Git blobs in the mirror and do not contain the
referenced file data. Ankh is intended for small repositories, not large-file storage.
The adapter also excludes issues, attachments, account data, and server
configuration. The PostgreSQL adapter does not export cluster roles or other
databases. There is no general file-directory source adapter.

### Destination adapters

| Type           | Stored content                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `restic`       | Encrypted, deduplicated snapshots in a local Restic repository.                                      |
| `proton-drive` | Full `.tar.zst` archives and SHA-256 checksum files, uploaded through the official Proton Drive CLI. |

The **outbox** is a persistent local directory for pending Proton archive pairs.
Each pair is published locally by atomic directory rename. Failed uploads leave
the pair available for retry without another source read. Ankh does not encrypt
the staged copy or local outbox; remote encryption is handled by Proton Drive.

Retention uses daily, weekly, monthly, and yearly counts. Restic removes snapshots
and prunes its repository; the Proton destination moves expired archive pairs to
trash.

## Basic usage

The supplied container targets `linux/amd64`. Docker Engine with Docker Compose
and a local image build are required for the examples. Commands run from the
repository root.

### Backup and restore demonstration

```sh
git clone https://github.com/benknab/ankh.git
cd ankh
bash tools/quickstart.sh
```

The script builds the production image, creates a temporary SQLite database,
backs it up to Restic, restores it, and checks its contents. It removes the
temporary data and image on exit. It does not access Proton Drive.

### A persistent job

The [example jobs](examples/) cover SQLite, PostgreSQL, and Gitea. The
[job schema](src/domain/model.ts) defines the configuration fields and rejects
unknown fields. Paths in a job refer to the container filesystem.

The following environment selects the SQLite-to-Restic example. The host paths
are placeholders for existing directories; `SOURCE_DIR` contains `example.db`.

```sh
export SOURCE_DIR=/absolute/path/to/application-data
export BACKUP_DIR=/absolute/path/to/mounted-backup-drive
export SECRETS_DIR=/absolute/path/to/private-secrets
export STAGING_DIR=/absolute/path/to/private-staging
cp examples/sqlite-restic.job.json backup.job.json
export JOB_FILE="$PWD/backup.job.json"
```

Before initialization, the job needs its actual name, host, source, drive
identifiers, and retention counts. `SECRETS_DIR/restic-password` contains the
Restic repository password. `BACKUP_DIR/.sentinel` contains two lines whose values
match `backupDrive.driveSerial` and `backupDrive.filesystemUuid`:

```text
serial=<drive serial>
uuid=<filesystem UUID>
```

Ankh checks this file, not the hardware identity or mount table. The backup drive
must already be mounted. The sentinel is required for both destination types,
including Proton-only jobs.

```sh
docker compose -f examples/compose.yaml build backup
docker compose -f examples/compose.yaml run --rm backup validate
docker compose -f examples/compose.yaml run --rm backup init
docker compose -f examples/compose.yaml run --rm backup backup
docker compose -f examples/compose.yaml run --rm backup check-read-data
```

`validate` checks the job without opening credentials or backup storage. `init`
initializes destinations. `backup` stages the source, stores it, and applies
retention. `check-read-data` reads Restic data; for Proton it checks local archive
pairs and remote pair names, not remote file contents.

The `retry` command uploads pending Proton pairs without staging the source. The
`schedule` command stays running and starts backups at the job's cron times in
its configured time zone. Every job must specify `schedule.cron`;
`schedule.timeZone` is optional and defaults to `UTC`. Schedule changes require a
restart. Each command accepts an optional absolute job-file path;
the default is `/job/backup.job.json`.

### Proton Drive

The [Proton Compose override](examples/compose.proton.yaml) selects
[`sqlite-proton.job.json`](examples/sqlite-proton.job.json), replacing `JOB_FILE`.
That job includes both destinations and needs the same configuration changes,
plus a remote folder and a persistent outbox path. Authentication uses an external
Docker volume shared by the login and backup containers.

#### Dedicated free account and a shared folder

1. Create a separate **Proton Free account**, not an alias of your main account.
2. From your main account, share a uniquely named folder such as `Ankh Backups`
   with **Can edit** permission and **Access** disabled. Accept the invitation
   as the backup account.
3. Set your job's Proton destination:

   ```json
   {
     "type": "proton-drive",
     "remoteFolder": "/shared-with-me/Ankh Backups/example-host/example-job",
     "outbox": "/backups/outbox/example-host/example-job"
   }
   ```

Ankh creates the subfolders. Shared uploads use the **owner's storage**, so no
second paid plan is needed. Follow the login steps below as the **backup account**,
then verify a backup and restore before enabling the scheduler.

#### Login and first backup

```sh
docker volume create backup-proton-state
docker compose -f examples/compose.yaml -f examples/compose.proton.yaml run --rm proton-auth
docker compose -f examples/compose.yaml -f examples/compose.proton.yaml run --rm backup init
docker compose -f examples/compose.yaml -f examples/compose.proton.yaml run --rm backup backup
```

Login prints a sign-in URL and waits up to 10 minutes for it to complete.
Subsequent commands use the credentials stored in the volume. The volume name can
be changed with `PROTON_STATE_VOLUME`.

If you previously signed in with your main account, revoke that CLI session in
the main account's security settings. Set `PROTON_STATE_VOLUME` to a new volume
name and create that volume before signing in with the backup account; do not
reuse the main account's credential volume.

To require a passphrase for the stored credentials, write it as one line to
`SECRETS_DIR/proton-gpg-passphrase` before logging in, or add it later and log in
again. Every container that uses the volume then needs the same file. See
[Security](#security) for what this protects.

Set `PROTON_SECRETS_DIR` to give the login container a directory containing only
`proton-gpg-passphrase`; it defaults to `SECRETS_DIR`. Backup containers still
read that same passphrase from `SECRETS_DIR/proton-gpg-passphrase`.

## Security

**Treat the Proton Drive integration as an experimental prototype.** The measures
below are imperfect workarounds for running the current Proton Drive CLI
unattended. Proper service accounts or an SDK that handles authentication would
be preferable; for now, this setup relies on a regular account's stored session.

**Use a separate Proton Free account for the backup runner.** Share only your
backup folder from your main account with **Can edit** permission and **Access**
disabled. This isolates your other files, Mail, and Pass. The backup account can
still read, modify, and delete shared backups, so keep an independent copy. See
[the shared-folder setup](#dedicated-free-account-and-a-shared-folder).

- **Protect credentials and local data.** Treat the Proton state volume as an
  account credential and mount it only in Ankh containers. Restrict access to
  secret files, staging directories, and the outbox; staged data and pending
  archives are plaintext locally.
- **Use a credential passphrase.** Set `proton-gpg-passphrase` before login, or
  log in again after adding it. A stolen state volume then also needs the separate
  passphrase file. This does not protect a compromised host or running container.
- **Keep login URLs private and revoke old sessions.** Logging in again or
  deleting local credentials does not revoke a session. Use Proton's security
  settings, especially when switching away from your main account. If credentials
  leak, revoke the sessions, change the account password, and recreate the
  credential volume before logging in again.
- **Verify recovery.** Test a real restore from every destination before enabling
  scheduled backups, and keep recovery credentials somewhere separate from the
  runner.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:integration
```

Unit tests run locally. Integration tests require Docker and Compose and run in
a disposable Linux container with PostgreSQL and the external tools. They do not
require production mounts or Proton credentials.

## License

[MIT](LICENSE). Bundled tools retain their own licenses; their notices are listed
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
