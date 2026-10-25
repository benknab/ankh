import { expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { Commands } from "#process/commands.ts";
import { Job } from "#domain/model.ts";
import { Sources } from "#sources/sources.ts";
import { Storage } from "#storage/storage.ts";
import { infrastructure } from "#testing/infrastructure.ts";
import { fixture } from "#testing/fixtures.ts";

it.live("PostgreSQL source dumps and restores data, and rejects bad credentials", () =>
  Effect.gen(function* () {
    const { fs, path } = yield* Storage;
    const commands = yield* Commands;
    const sources = yield* Sources;
    const root = yield* fs.makeTempDirectoryScoped();
    const passwordFile = path.join(root, "password");
    yield* fs.writeFileString(passwordFile, "integration-test-only", { mode: 0o600 });
    const env = {
      PGHOST: "postgres-test",
      PGUSER: "postgres",
      PGPASSWORD: Redacted.make("integration-test-only"),
      PGDATABASE: "postgres",
    };
    for (const database of ["source_test", "restore_test"]) {
      yield* commands.run("createdb", ["--no-password", database], { env });
    }
    yield* commands.run(
      "psql",
      [
        "--no-password",
        "--set=ON_ERROR_STOP=1",
        "--command",
        "CREATE TABLE records(id integer PRIMARY KEY, value text); INSERT INTO records VALUES (1, 'verified');",
      ],
      { env: { ...env, PGDATABASE: "source_test" } },
    );
    const job = yield* Schema.decodeUnknownEffect(Job)({
      ...fixture,
      name: "postgres-test",
      source: {
        type: "postgres",
        hostname: "postgres-test",
        port: 5432,
        database: "source_test",
        username: "postgres",
        passwordFile,
        output: "database.dump",
      },
    });
    const staged = yield* sources.stage(job);
    yield* commands.run(
      "pg_restore",
      [
        "--no-password",
        "--exit-on-error",
        "--no-owner",
        "--no-acl",
        "--dbname=restore_test",
        path.join(staged, "database.dump"),
      ],
      { env },
    );
    const value = yield* commands.run(
      "psql",
      [
        "--no-password",
        "--tuples-only",
        "--no-align",
        "--command=SELECT value FROM records WHERE id = 1;",
      ],
      { env: { ...env, PGDATABASE: "restore_test" } },
    );
    expect(Redacted.value(value.stdout).trim(), "dump must restore original data").toBe("verified");
    yield* fs.writeFileString(passwordFile, "wrong-password");
    const failed = yield* sources.stage(job).pipe(Effect.result);
    expect(Result.isFailure(failed), "bad credentials must fail staging").toBe(true);
    if (Result.isFailure(failed)) {
      expect(failed.failure.message, "errors must not expose passwords").not.toContain(
        "wrong-password",
      );
    }
  }).pipe(
    Effect.provide(
      Sources.layer.pipe(Layer.provideMerge(Layer.mergeAll(infrastructure, FetchHttpClient.layer))),
    ),
  ),
);
