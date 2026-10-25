import { expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { Commands } from "#process/commands.ts";
import { Actions, BackupError, Job } from "#domain/model.ts";
import { Storage, withLock } from "#storage/storage.ts";
import { infrastructure } from "#testing/infrastructure.ts";
import { fixture } from "#testing/fixtures.ts";
import metadata from "#package" with { type: "json" };

it.live("Node runs the TypeScript CLI and rejects unsafe job paths", () =>
  Effect.gen(function* () {
    const commands = yield* Commands;
    const { path } = yield* Storage;
    const entry = path.join(import.meta.dirname, "main.ts");
    const help = yield* commands.run(process.execPath, [entry, "--help"]);
    for (const action of [...Actions, "schedule", "proton-login", "validate"]) {
      expect(help.stdout).toContain(action);
    }
    const version = yield* commands.run(process.execPath, [entry, "--version"]);
    expect(version.stdout, "CLI must use the package version").toBe(
      `backup-runner v${metadata.version}`,
    );
    const invalid = yield* commands
      .run(process.execPath, [entry, "backup", "relative/job.json"])
      .pipe(Effect.result);
    expect(Result.isFailure(invalid), "relative job paths must fail before accessing files").toBe(
      true,
    );
  }).pipe(Effect.provide(infrastructure)),
);

it.live("Node child processes drain large output and report failed exits", () =>
  Effect.gen(function* () {
    const commands = yield* Commands;
    const output = yield* commands.run(process.execPath, [
      "--eval",
      'process.stdout.write("o".repeat(256 * 1024)); process.stderr.write("e".repeat(256 * 1024));',
    ]);
    expect(output.stdout, "stdout and stderr must drain without deadlock").toBe(
      "o".repeat(256 * 1024),
    );
    const failed = yield* commands
      .run(process.execPath, [
        "--eval",
        'process.stderr.write("probe-failure"); process.exitCode = 7;',
      ])
      .pipe(Effect.result);
    expect(Result.isFailure(failed), "nonzero exit must fail").toBe(true);
    if (Result.isFailure(failed)) {
      expect(failed.failure.exitCode).toBe(7);
      expect(failed.failure.message).toContain("probe-failure");
    }
  }).pipe(Effect.provide(infrastructure)),
);

it.live("validate only reads the job file and rejects unknown fields", () =>
  Effect.gen(function* () {
    const { fs, path } = yield* Storage;
    const commands = yield* Commands;
    const root = yield* fs.makeTempDirectoryScoped();
    const file = path.join(root, "job.json");
    const entry = path.join(import.meta.dirname, "main.ts");
    yield* fs.writeFileString(
      file,
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(fixture),
    );
    const validation = yield* commands.run(process.execPath, [entry, "validate", file]);
    const line = yield* Schema.decodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          message: Schema.Struct({
            event: Schema.Literal("execution.completed"),
            status: Schema.Literal("success"),
            operation: Schema.Literal("validate"),
            traceId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
            spanId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/u)),
          }),
          annotations: Schema.Struct({ operation: Schema.Literal("validate") }),
        }),
      ),
    )(validation.stdout);
    expect(line.message.operation).toBe(line.annotations.operation);
    expect(validation.stdout).not.toContain('"runId"');
    yield* fs.writeFileString(
      file,
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        ...fixture,
        ignored: true,
      }),
    );
    expect(
      Result.isFailure(
        yield* commands.run(process.execPath, [entry, "validate", file]).pipe(Effect.result),
      ),
      "unknown config fields must fail validation",
    ).toBe(true);
  }).pipe(Effect.provide(infrastructure)),
);

it.live("Node filesystem scopes release the drive lock after failure", () =>
  Effect.gen(function* () {
    const { fs, path } = yield* Storage;
    const root = yield* fs.makeTempDirectoryScoped();
    const job = yield* Schema.decodeUnknownEffect(Job)({
      ...fixture,
      backupDrive: { ...fixture.backupDrive, sentinelFile: path.join(root, ".sentinel") },
    });
    const lock = path.join(root, ".runner-lock");
    const failed = yield* Effect.gen(function* () {
      yield* withLock(job);
      expect(yield* fs.exists(lock), "lock must exist while held").toBe(true);
      return yield* BackupError.make({ message: "probe-failure" });
    }).pipe(Effect.scoped, Effect.result);
    expect(Result.isFailure(failed), "test job must fail").toBe(true);
    expect(yield* fs.exists(lock), "failed job scope must release the lock").toBe(false);
    yield* withLock(job).pipe(Effect.scoped);
    expect(yield* fs.exists(lock), "next job must acquire and release the lock").toBe(false);
  }).pipe(Effect.provide(infrastructure)),
);
