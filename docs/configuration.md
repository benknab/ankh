# Job configuration

`src/model.ts` defines the runtime schema. The version-1 JSON examples in
`examples/` are validated with the same decoder as the CLI. Unknown keys are
errors, including nested keys.

```sh
node main.ts validate /absolute/path/to/job.json
```

Validation reads only that file. It needs no source, backup drive, credentials,
or network. `check` and `check-read-data` instead inspect real backup state.

## Fields

- `version`: `1`.
- `name`: lowercase letters, digits, and hyphens, starting with a letter or digit.
  Keep it stable: archive names, staging paths, and Restic tags use it.
- `host`: stable, nonempty host label. Restic selection includes host and job tag.
- `source`: one of the source objects below.
- `backupDrive`: `sentinelFile`, `driveSerial`, and `filesystemUuid`. Required
  even for Proton-only jobs. The sentinel's parent holds `.runner-lock`.
- `destinations`: one or both destination types, with no duplicates.
- `retention`: nonnegative integer `daily`, `weekly`, `monthly`, and `yearly`
  counts. At least one must be positive. Proton keeps the newest snapshot in each
  selected UTC period; weeks start Monday. The union of all periods is retained.
- `schedule`: optional `{ "cron": "30 3 * * *", "timeZone": "UTC" }`. Omission
  uses those defaults. Supply both fields when present. Cron accepts five fields
  (minute through weekday) or six (seconds first), as supported by Effect Cron.
  Use a valid named time zone or fixed offset. Local schedules follow DST.

`schedule` waits for the next occurrence; it does not back up immediately. Failed
runs are logged and the next occurrence is still attempted. A run that lasts past
another occurrence does not overlap itself. Restart the scheduler after changing
its cron or time zone. Each run reloads other job settings.

## Sources

- SQLite: `{ "type": "sqlite", "path": "/source/example.db", "output": "example.db" }`.
  Uses SQLite's online backup command and checks the staged database.
- PostgreSQL: `type: "postgres"`, `hostname`, `port`, `database`, `username`,
  `passwordFile`, and `output`. Database/user names start with a letter or
  underscore and contain letters, digits, underscores, or hyphens. Hostnames
  accept DNS names and IPv4; IPv6 literals and libpq connection strings are not
  accepted. Passwords come from a file, with one trailing newline removed.
  `pg_dump` writes a custom-format archive and `pg_restore` reads it for validation.
  The runner sets connection parameters and a 30-second connection timeout;
  libpq TLS options such as `PGSSLMODE` and `PGSSLROOTCERT` can be set on the
  container and are inherited. No connection URI or password belongs in the job.
- Gitea: `type: "gitea-git"`, `apiUrl`, and `tokenFile`. Only HTTP(S) base URLs
  without embedded credentials, queries, or fragments are accepted. The API
  enumerates repositories visible to the token; Git and LFS use the same token
  through askpass. Deleted or newly inaccessible repositories may remain in the
  persistent mirror cache; `manifest.json` records the currently enumerated set.

## Destinations and paths

- Restic: `{ "type": "restic", "repository": "/backups/restic", "passwordFile": "/secrets/restic-password" }`.
  Repositories are local filesystem paths, not Restic URLs.
- Proton: `{ "type": "proton-drive", "remoteFolder": "/my-files/Backups/host/job", "outbox": "/backups/outbox/host/job" }`.
  Only personal `/my-files` folders are supported. Give every host/job its own
  remote folder and outbox. The lock is local, not distributed coordination.

Paths must be absolute, non-root paths without dot segments, repeated separators,
trailing separators, or NUL bytes. Output names are plain filenames. Source,
secret, sentinel, repository, and outbox paths cannot overlap `/staging` or
`/proton`. Output roots cannot overlap one another or input paths.

These checks are lexical. Do not use symlinks or bind-mount aliases that make
different configured paths refer to the same data. Protect the job file too:
mount it read-only outside all writable directories.

`/staging/<job>` is disposable for databases and persistent for Git mirrors.
`/proton` contains shared credentials/cache. `/app/gitea-askpass.sh` is the Git
credential helper. These are container conventions, not configurable native-host
paths. External tool and runtime versions are pinned in `Dockerfile`,
`.node-version`, and `package.json`.
