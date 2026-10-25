# Architecture

`src/main.ts` defines the CLI. `src/app/layers.ts` connects Effect services to the
Node platform. Local modules use Node `#` imports. Tests sit beside their modules.

## Data flow

1. Decode the job with Schema. Check the drive marker and acquire its lock.
2. Stage the source once. A backup request must contain the staged path.
3. Attempt each destination, even if a previous destination failed.
4. Release the lock. Emit one completion event with the result of the run.

`src/domain/` holds job schemas, branded names and paths, archive records, and
retention rules. `SourceAdapter<Config, Services>` stages data.
`DestinationAdapter<Config, Services>` consumes a staged backup or runs a
maintenance action. Their implementations live in `src/sources/` and
`src/destinations/`.

## Clients and state

`src/clients/` wraps SQLite, PostgreSQL, Git/LFS, Gitea HTTP, Restic, archive tools,
and Proton Drive. Clients decode external output and return typed Effect values.
`src/process/commands.ts` is the only process boundary. It returns `stdout`, `stderr`,
and a zero exit code on success. Failures use the Effect error channel.
Proton login and credential setup stay with the Proton client.

`src/storage/` owns file access and drive locks. `src/outbox/` owns pending archives.
It publishes a complete archive/checksum pair by directory rename. A Queue feeds
the upload Stream from these files. Failed uploads keep their files for retry.
See [operations](operations.md#outbox-transitions) for state and recovery rules.

## Execution telemetry

`src/telemetry/` gives each command or scheduled backup a run ID and an Effect
service with run-local counters and a bounded log collector. Child fibers share
that service. Concurrent runs
have separate state. Clock supplies durations; log annotations and spans carry
the ID through each step.

After cleanup, one `execution.completed` event reports success, failure, or
interruption. Step summaries include both destination results and process counts.
Normal Effect log calls append messages or merge custom fields into that event.
Debug mode collects more detail but still emits once. Service layers capture only
their dependencies so they preserve the caller's logger and trace context.
Effect's OTLP logger and tracer export the event and correlated spans. A small
serialization layer removes generated exception text before JSON encoding.
See [logging](operations.md#logs) for fields and configuration.

Tests replace services with Layers. Unit tests use TestClock; integration tests
use real local tools and a simulated Proton service. See [development](development.md).
