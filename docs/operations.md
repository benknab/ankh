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
known, and step summaries. Each step records attempts, failures, interruptions,
and elapsed time. `restic` and `proton-drive` are separate destination steps.

Set `BACKUP_LOG_LEVEL=debug` in the container to add step start/end events.
All events in one run have the same `annotations.runId`. Each scheduled attempt
gets a new ID. Concurrent runs have separate counters. Cleanup finishes before
the completion event. A forced kill or power loss cannot emit a completion event.

Failure fields contain a safe category and an exit code when available. Logs omit
arguments, credentials, tool output, and raw error causes. Interactive Proton login
still displays the official CLI prompts. Command results keep bounded diagnostics
internally: a 64 KiB tail, or up to 16 MiB of text for output that clients parse.

## Verification scope

`check-read-data` reads Restic repository data. For Proton it checks filenames and
local outbox integrity, not remote contents. Periodically download and restore a
Proton archive. Automated tests simulate the Proton service and require no account;
an actual account smoke test is an explicit operator step in [restores](restores.md).
