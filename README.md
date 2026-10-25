# Ankh

Ankh is an unpublished prototype for backing up personal
self-hosted applications to a hard drive and to remote storage on Proton Drive.
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

| Type        | Staged content                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `sqlite`    | One database, copied with SQLite's online backup command and checked with `PRAGMA quick_check`.                          |
| `postgres`  | One database, exported with `pg_dump --format=custom` and read back with `pg_restore`.                                   |
| `gitea-git` | Mirrors of repositories visible to the configured Gitea token, including Git LFS objects reachable from repository refs. |

The Gitea adapter copies Git data, not issues, attachments, account data, or server
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

```sh
docker volume create backup-proton-state
docker compose -f examples/compose.yaml -f examples/compose.proton.yaml run --rm proton-auth
docker compose -f examples/compose.yaml -f examples/compose.proton.yaml run --rm backup init
docker compose -f examples/compose.yaml -f examples/compose.proton.yaml run --rm backup backup
```

Login prints a sign-in URL and waits up to 10 minutes for it to complete.
Subsequent commands use the credentials stored in the volume. The volume name can
be changed with `PROTON_STATE_VOLUME`.

To require a passphrase for the stored credentials, write it as one line to
`SECRETS_DIR/proton-gpg-passphrase` before logging in, or add it later and log in
again. Every container that uses the volume then needs the same file. See
[Security](#security) for what this protects.

## Security

Proton publishes a Drive SDK, but not its sign-in and session handling, so Ankh
runs the official Proton Drive CLI as an external tool rather than reimplementing
Proton's authentication. The CLI is designed for interactive use. Running it
unattended has these consequences.

**The Proton state volume is an account credential.** To run without a person
present, the CLI stores the session tokens and the key password that unlocks the
account's private keys. Anyone who can read the volume can act as the account and
decrypt its data, not only Drive. Use a Proton account dedicated to backups.
Write access is equivalent to running code in Ankh's containers, because GnuPG,
`pass`, and the CLI read their configuration from the volume. Mount it only in
Ankh containers.

**The passphrase file separates that credential into two parts.** The session is
stored in `pass`, encrypted with a GPG key kept in the same volume. Without
`proton-gpg-passphrase`, the key has no passphrase, and a copy of the volume is
enough to read the session. With it, decryption also needs the read-only secrets
mount. This does not protect a running container or a host that can read both.
The GPG agent, whose socket is in the volume, is configured not to cache the
passphrase. `proton-login` adds the passphrase to an existing key and never
removes one. Proton runs fail if the file is missing for a protected key, or if
the file was added without logging in again. Changing the passphrase requires
removing `/proton/gnupg` and `/proton/pass` and logging in again.

Ankh works around the CLI's limits as follows:

- **One CLI process at a time.** The CLI has no lock between processes and
  rewrites the stored session after each token refresh; a failed refresh signs it
  out. Every `proton-drive`, `gpg`, and `pass` call, including those made by
  `proton-login`, holds an exclusive `flock` on `/proton/lock` across all
  containers that share the volume. A call waits up to six hours for the lock.
- **Credential checks before network access.** Login checks the key, the `pass`
  recipients, including those in the CLI's session folder, and an encrypt and
  decrypt round trip there before the browser sign-in, so a broken store cannot
  strand a new session. Each Proton destination run checks the key, its
  protection, and the recipients.
- **A pinned environment.** Ankh sets the CLI's API host, credential store, cache
  encryption, and `pass` options, so a stray container variable cannot change
  them. This is not a boundary against someone who controls the container
  environment.
- **Fixed failure reasons.** Tool output stays out of logs. Known CLI failures,
  such as a missing or revoked session, are logged as fixed messages that name
  the fix.

Some limits need manual steps:

- Logging in again does not revoke the previous session; the CLI's logout only
  deletes local data. Revoke old sessions in the Proton account's security
  settings.
- Whoever completes the printed sign-in URL first decides which account Ankh
  uses, and the URL also carries the key for the session handoff. The login
  services disable Docker logging; keep the terminal output private as well, and
  check the account's session list after signing in.
- The CLI writes its own warning log to `/proton/cache`. It can send crash
  reports to Proton, and sends metrics when the account has telemetry enabled.
- The containers run as root with only the `DAC_OVERRIDE` capability, which lets
  them read bind mounts owned by other users. A non-root user would require
  changing the ownership of every mount.

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
