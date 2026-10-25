# Development

Use the versions in `.node-version` and `package.json`. Run
`pnpm install --frozen-lockfile`, then read `AGENTS.md` and the installed Effect docs.

See [architecture](architecture.md) for module boundaries. Use `#` imports for local
modules. Lint enables all Effect presets and strict non-style categories. Comments
explain exceptions. Size and complexity limits use defaults, with test length overrides.

```sh
pnpm check
pnpm test
pnpm test:integration
```

`check` runs formatting, lint, and type checks. Warnings fail the check. `test` runs
unit tests. Integration tests need Docker and Compose. They use the production
toolchain, temporary PostgreSQL and filesystems, and simulated Proton responses.
Each run removes its containers and data. No account credentials are needed.

Target files with `pnpm test:unit src/app/scheduler.unit.test.ts` or
`pnpm test:integration src/sources/postgres.integration.test.ts`. `test:integration:run`
is the inner runner for an already prepared environment. `test:all` runs both
suites. `bash tools/quickstart.sh` tests the documented production-image flow.

Put tests beside the code: `*.unit.test.ts` or `*.integration.test.ts`. Use `expect`
with `it.effect` and TestClock for unit tests. Use `it.live` for real tools.
Use `Layer.fresh` when replacing a service that the test layer has already built.

Format only changed files with `pnpm fmt <paths>`. Keep dependency updates separate
from behavior changes. Keep version pins in manifests, Dockerfiles, and Compose files.
