# Operations and recovery

## Scheduling and disk readiness

After manual backup and restore tests pass, use the same service/mounts with
`command: ["schedule"]` and a suitable restart policy. Change only backup services
when deploying a new runner. Keep a previous image digest and matching job file
for rollback; never run old and new schedulers for the same job concurrently.

The sentinel must live on the mounted backup drive. Its contents must match the
job's exact `serial=...` and `uuid=...` lines. Use mode 0600, and keep its parent
writable for `.runner-lock`. This checks a marker, not a disk's physical serial.
Arrange mount ordering on the host; never create the marker on an unmounted
fallback directory. If a drive mounts late, failed scheduled runs are logged and
the next scheduled run tries again. Use a manual `backup` or `retry` after fixing
the mount rather than waiting.

Jobs sharing a sentinel parent serialize through one directory lock. A waiting
contender retries every ten seconds for up to six hours and can be interrupted.
Before removing a stale `.runner-lock`, stop all backup schedulers and confirm no
backup or lock waiter is running. Remove only that lock directory, then run one
manual backup/check. A process crash can leave a stale lock; it is not
automatically considered safe to break based on age.

## State and capacity

Keep staging, Restic repositories, outboxes, job files, and credentials on
appropriate persistent host storage. Staging and the local outbox contain
**plaintext** backups; Restic encrypts its repository and Proton encrypts remote
storage. Restrict host directory access and include these locations in capacity
monitoring. Leave room for the staged source, compressed archives, Git/LFS cache,
and Restic temporary work. The examples use disk-backed staging; adjust `/tmp`
capacity for your repository size.

The outbox grows during prolonged outages. Never free space by deleting
unuploaded ready archives. Restore connectivity or add storage, then run `retry`;
retry does not need the original source to exist.

## Outbox transitions

1. **Building:** a private `.partial-*` directory contains an incomplete pair.
2. **Ready:** after tar, checksum, and zstd checks pass, a directory rename exposes
   `<job>-<timestamp>/` containing `.tar.zst` and `.tar.zst.sha256` files.
3. **Remotely confirmed:** the upload command succeeds and a fresh listing
   contains both names. This verifies presence, not downloaded content.
4. **Retired:** the directory is renamed `.retired-*` before recursive deletion.
   Retry finishes interrupted retirement without uploading it again.

Legacy flat archive/checksum pairs are still read. Their acknowledgement creates
an `.ack-*` marker before deleting either file; retry finishes only those marked
deletions. Upload success followed by lost local acknowledgement can cause another
upload as a new remote revision. Unacknowledged ready data remains available.

Corrupt ready archives stay on disk and make the command fail, while later valid
archives still get an upload attempt. Inspect and recover corrupt data separately.
`.partial-*` leftovers are ignored; after stopping all jobs, inspect them before
removing failed builds. Atomic rename protects publication against ordinary process
interruption. The runner does not claim power-loss durability: files/directories
are not explicitly fsynced.

## Proton retention recovery

Before remote deletion, `.retention-<job>.json` records the selected archive names
and exact remote folder. Retry uses that intent to finish an interrupted pair
deletion, then removes the journal after confirming both names are absent.
Keep the journal with the outbox, including during upgrades. Do not change a job's
remote folder while a deletion intent is pending.

An incomplete remote pair without a matching journal is an error, not permission
to delete the other member. Investigate the archive and checksum, restore the
missing member from a verified local copy when possible, or explicitly resolve
the orphan yourself. `check` also reports pending incomplete remote pairs; use
`retry` to resume journaled retention.

## Proton credentials

`proton-login` creates a GPG encryption key and initializes `pass` under `/proton`.
The key has no passphrase so unattended jobs can decrypt the session. Treat the
entire volume as credentials: restrict access, preserve it across replacement
containers, and never publish or distribute a logged-in volume.

The root `compose.yaml` is an optional login helper using the external
`backup-proton-state` volume. Use the same volume for backups. After session
expiry or revocation, rerun login with that volume, then run `retry` and a restore
check. Authentication or network errors during discovery do not create folders.

## Logs

The default info layer writes one JSON completion line for each command or
scheduled backup. The event is in `message`, with `event: execution.completed`.
It contains `runId`, `operation`, `status`, `durationMs`, job/source details when
known, `traceId`, `spanId`, custom `messages` and `data`, and step summaries.
Each step records attempts, failures, interruptions,
and elapsed time. `restic` and `proton-drive` are separate destination steps.

Set `BACKUP_LOG_LEVEL=debug` to collect debug messages and step start/end details
in that same event. It still writes one line. Each scheduled attempt gets a new
ID. Concurrent runs have separate state. Cleanup finishes before
the completion event. A forced kill or power loss cannot emit a completion event.

Failure fields contain a safe category and an exit code when available. Logs omit
arguments, credentials, tool output, and raw error causes. Interactive Proton login
still displays the official CLI prompts. Command results keep bounded diagnostics
internally: a 64 KiB tail, or up to 16 MiB of text for output that clients parse.

### Custom messages and fields

Use normal Effect logging inside `withExecution(operation, effect)`:

```ts
yield * Effect.logInfo("Source staged", { files: 12 });
yield * Effect.logInfo({ uploaded: 8 });
yield * Effect.logInfo("Upload finished", { uploaded: 12 });
```

The completion event contains two messages and `data: { files: 12, uploaded: 12 }`.
Object fields merge at the top level; the last value wins. Custom data cannot
overwrite the run's status or IDs. Message entries keep their level and log
annotations. A logged Cause adds a safe failure category, without error text.
Outside an execution, Effect logs go straight to the configured loggers.

Each run keeps up to 100 messages and 100 data fields. Drop counters report excess
messages and top-level fields. Each object accepts 40 fields, arrays keep 20 items,
strings keep 2048 characters, keys keep 128 characters, and nested containers stop
at depth three. Secret field names and Effect `Redacted` values are masked. Raw
errors are replaced. Use safe message text; text cannot identify secrets on its own.

### OpenTelemetry

Enable Effect's OTLP logs and traces with container environment variables:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
OTEL_LOGS_EXPORTER=otlp
OTEL_TRACES_EXPORTER=otlp
```

The runner sends HTTP/JSON to `/v1/logs` and `/v1/traces`. Export is off by default;
`OTEL_SDK_DISABLED=true` also disables it. Console JSON output stays enabled.
Effect supports signal-specific endpoints, headers, timeouts, batch settings,
and `OTEL_RESOURCE_ATTRIBUTES`. The service name is `backup-runner`.

The completed log and execution span share trace/span IDs. Child spans show
individual operations. The standard Effect exporters batch data and flush on
normal shutdown. Export failures do not fail a backup. Telemetry is best effort;
failed exports and forced process exits can lose data.

The trace serializer removes generated exception details and status messages.
Exporter debug diagnostics are suppressed because they can contain request data.
Keep custom span names, attributes, and events free of credentials and tool output.

## Verification scope

`check-read-data` reads Restic repository data. For Proton it checks filenames and
local outbox integrity, not remote contents. Periodically download and restore a
Proton archive. Automated tests simulate the Proton service and require no account;
an actual account smoke test is an explicit operator step in [restores](restores.md).
