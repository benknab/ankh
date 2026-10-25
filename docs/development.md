# Development

Use the Node and pnpm versions in `.node-version` and `package.json`. Install with
`pnpm install --frozen-lockfile`. Read `AGENTS.md` and the installed Effect
documentation before changing application code.

```sh
pnpm check
pnpm test
pnpm test:integration
```

`check` runs formatting, zero-warning lint, and type checking. `test` is the unit
suite. `test:integration` builds `tools/integration/Dockerfile` with the shared production
toolchain, provisions disposable PostgreSQL, runs every integration test, and
cleans up its isolated Compose project. Docker and Compose are required. There
are no environment-based skip flags. The suite uses temporary filesystems and
fake Proton responses; it never needs account credentials.

Target files with `pnpm test:unit src/app/scheduler.unit.test.ts` or
`pnpm test:integration src/sources/postgres.integration.test.ts`. `test:integration:run`
is the inner runner for an already prepared environment. `test:all` runs both
suites. `bash tools/quickstart.sh` tests the documented production-image flow.

Colocate isolated tests in `src/**/*.unit.test.ts` and real process/filesystem tests
in `src/**/*.integration.test.ts`. Use `expect`, `it.effect`, and TestClock for unit tests,
and `it.live` for real tools. Use fresh layers when injecting an alternate
implementation of a service already built in the enclosing test layer.

Format only changed files with `pnpm fmt <paths>`. Dependency updates are separate
from behavior changes. Container versions/digests and checksums are maintained in
the Dockerfiles and Compose files; dependency pins live in the manifests/lockfile.
