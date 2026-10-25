# Backup runner

This is a standalone Node.js project using pnpm, Vite+, and stable Effect.
Use the versions in `.node-version` and `package.json`. Run project commands from
this repository's root.

## Effect documentation

Run `pnpm install --frozen-lockfile`, then read `node_modules/effect/AGENTS.md` before changing
code. That file is the skill index bundled with the installed Effect release.
Follow its links into `node_modules/effect/ai-docs/src/` for the APIs you need.
Read the installed source under `node_modules/effect/src/` and
`node_modules/@effect/platform-node/src/` when the examples do not cover an API.
Do not use v3 examples or a separate copy of Effect documentation.

## Implementation

- Use only Effect libraries for application infrastructure and the Effect error
  channel for failures.
- Use Schema for configuration and external data, Context.Service and Layer for
  dependencies, Effect.fn for operations, and tagged errors for failures.
- Carry strong input types past the boundary: branded names and paths, HashSet
  for unique collections, and parsed snapshot records for retention. Use
  discriminated unions to make invalid combinations impossible; a backup request
  must include a staged path. Do not accept raw strings and arrays where a
  domain type fits.
- Use FileSystem, Path, HttpClient, ChildProcessSpawner, and Effect CLI with
  the native Effect Node platform. Node runs the TypeScript entry point directly;
  keep type-only imports explicit and use only erasable TypeScript syntax.
- Read time through Effect Clock or the Clock-backed `DateTime.now` effect. Use
  DateTime for parsing and calendar logic, and Effect sleep/schedules for delays.
  Never use native Date, timers, performance clocks, or unsafe current-time helpers.
- Use Queue and Stream for upload work, and Scope for subprocesses, locks, and
  temporary directories.
- The disk outbox is durable. An in-memory Queue must never replace persisted
  archives. Publish complete archive pairs by atomic directory rename. A failed
  upload must leave its pair available for retry.
- Keep source adapters separate from destinations. Stage once, attempt all
  configured destinations, then report any failures.
- Keep binary tool invocations behind the Commands service. SQLite's online
  backup command, Git/LFS, Restic, tar/zstd, GPG/pass, and the official Proton
  CLI remain external tools; do not reimplement their protocols.
- Use test layers to exercise failures without credentials or production mounts.
- Write Effect tests with `it.effect` from `@effect/vitest`; use `it.live` for
  real subprocess and integration tests. Both manage the test scope. Use the
  provided `TestClock` in `it.effect` rather than starting a separate runtime.
- Use `Layer.fresh` when injecting a replacement for a service already built in
  the enclosing test layer. Assert that the injected failure actually occurred.

## Checks

Run `pnpm check` and `pnpm test`. Vite+ runs Oxfmt, Oxlint, and Vitest;
lint rejects all warnings. TypeScript checks source, tests, and tool config. The official `@effect/tsgo`
recommended preset runs Effect rules through Oxlint. `prepare` patches only
Oxlint and its type-aware runner; keep TypeScript unpatched. Keep Vite+ settings in
`vite.config.ts`, including the `fmt` settings for its bundled Oxfmt formatter.
Run `pnpm fmt <paths>` to format changed files or `pnpm fmt:check <paths>` to check
them. `pnpm check` includes the formatting check. Keep formatting scoped to the
files being changed; the generated lockfile is excluded.

## Tests

- Put isolated tests in `tests/**/*.unit.test.ts`. `pnpm test` and `pnpm test:unit`
  run only the unit project; additional file filters are accepted.
- Put tests using real processes, filesystems, databases, or external tools in
  `tests/**/*.integration.test.ts`. Do not gate tests with environment variables.
- `pnpm test:integration` requires a running Docker daemon and Compose. It builds
  `tests/Dockerfile` using the root Dockerfile's shared `base` toolchain, starts a
  disposable PostgreSQL service, waits for readiness, and runs every integration
  test in the Linux/amd64 container. Data and credentials live in temporary
  filesystems; each run has its own Compose
  project. Cleanup runs on success, failure, or interruption.
- Pass file filters or Vitest options to that script to target tests, for example
  `pnpm test:integration tests/postgres.integration.test.ts`.
- `pnpm test:integration:run` is the inner runner for an already prepared
  environment. It runs tests directly and does not provision dependencies.
- `pnpm test:all` runs both suites. Full integration tests use real local tools
  and PostgreSQL, with a simulated Proton service and no account credentials.

Run integration tests when changing process or filesystem behavior. Test scheduling
with Effect's TestClock, including timezone handling and failure recovery. Enable
scheduled services only after real backups and restores pass for every opted-in app.

## Release checks

Keep the production image in the root Dockerfile and the integration image in
`tests/Dockerfile`. Run `bash tools/quickstart.sh` after changing container setup or
examples; it verifies a real backup and restore using the production image.
Keep the build-context allowlist free of credentials and deployment settings.
Read `docs/releases.md` before publishing. Tags and released image versions are
immutable; release notes must identify the source commit and anonymously verified
image digest. Real Proton account tests remain separate from credential-free CI.
