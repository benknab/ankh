# Backup runner

This is a standalone Node.js 24.21.0 LTS project using pnpm 11.25.0,
Vite+ 1.1.0, and stable Effect 4.0.2. Run project commands here; run formatting from the
deployment root.

## Effect documentation

Run `pnpm install --frozen-lockfile`, then read `node_modules/effect/AGENTS.md` before changing
code. That file is the skill index bundled with the installed Effect release.
Follow its links into `node_modules/effect/ai-docs/src/` for the APIs you need.
Read the installed source under `node_modules/effect/src/` and
`node_modules/@effect/platform-node/src/` when the examples do not cover an API.
Do not use v3 examples or a separate copy of Effect documentation.

## Implementation

- Use only Effect libraries for application infrastructure. This project's
  Effect error channel replaces the repository's default `better-result`
  convention.
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
- Use DateTime for clocks and calendar logic, Queue and Stream for upload work,
  and Scope for subprocesses, locks, and temporary directories.
- The disk outbox is durable. An in-memory Queue must never replace persisted
  archives. Publish complete archive pairs by atomic directory rename. A failed
  upload must leave its pair available for retry.
- Keep source adapters separate from destinations. Stage once, attempt all
  configured destinations, then report any failures.
- Keep binary tool invocations behind the Commands service. SQLite's online
  backup command, Git/LFS, Restic, tar/zstd, GPG/pass, and the official Proton
  CLI remain external tools; do not reimplement their protocols.
- Use test layers to exercise failures without credentials or production mounts.

## Checks

Run `pnpm check` and `pnpm test`. Vite+ runs Oxlint and Vitest;
TypeScript checks source, tests, and tool config. Keep Vite+ settings in
`vite.config.ts`. Run `pnpm fmt backup-runner` or
`pnpm fmt:check backup-runner` from the deployment root using its single Oxfmt
config. Do not add a local formatter dependency, config, or script.

Build the container and its `test` target, then run its integration tests when changing process or filesystem
behavior. Test scheduling with Effect's TestClock, including timezone handling
and failure recovery. Enable scheduled services only after real backups and
restores pass for every opted-in app.
