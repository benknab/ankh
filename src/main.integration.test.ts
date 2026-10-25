import { it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { Commands } from "./process/commands.ts";
import { Actions, BackupError, Job } from "./domain/model.ts";
import { Storage, withLock } from "./storage/storage.ts";
import { infrastructure } from "./testing/infrastructure.ts";
import { assert, fixture } from "./testing/fixtures.ts";
import metadata from "../package.json" with { type: "json" };

it.live("Node runs the TypeScript CLI and rejects unsafe job paths", () =>
  Effect.gen(function* () {
    const commands = yield* Commands;
    const { path } = yield* Storage;
    const entry = path.join(import.meta.dirname, "main.ts");
    const help = yield* commands.run(process.execPath, [entry, "--help"]);
    for (const action of [...Actions, "schedule", "proton-login", "validate"]) {
      yield* assert(help.includes(action), `missing subcommand: ${action}`);
    }
    const version = yield* commands.run(process.execPath, [entry, "--version"]);
    yield* assert(
      version === `backup-runner v${metadata.version}`,
      "CLI must use the package version",
    );
    const invalid = yield* commands
      .run(process.execPath, [entry, "backup", "relative/job.json"])
      .pipe(Effect.result);
    yield* assert(Result.isFailure(invalid), "relative job paths must fail before accessing files");
  }).pipe(Effect.provide(infrastructure)),
);

it.live("Node child processes drain large output and report failed exits", () =>
  Effect.gen(function* () {
    const commands = yield* Commands;
    const output = yield* commands.run(process.execPath, [
      "--eval",
      'process.stdout.write("o".repeat(256 * 1024)); process.stderr.write("e".repeat(256 * 1024));',
    ]);
    yield* assert(
      output === "o".repeat(256 * 1024),
      "stdout and stderr must drain without deadlock",
    );
    const failed = yield* commands
      .run(process.execPath, [
        "--eval",
        'process.stderr.write("probe-failure"); process.exitCode = 7;',
      ])
      .pipe(Effect.result);
    yield* assert(Result.isFailure(failed), "nonzero exit must fail");
    if (Result.isFailure(failed)) {
      yield* assert(
        failed.failure.message.includes("exited 7") &&
          failed.failure.message.includes("probe-failure"),
        "failure must preserve exit code and stderr",
      );
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
    yield* fs.writeFileString(file, JSON.stringify(fixture));
    yield* commands.run(process.execPath, [entry, "validate", file]);
    yield* fs.writeFileString(file, JSON.stringify({ ...fixture, ignored: true }));
    yield* assert(
      Result.isFailure(
        yield* commands.run(process.execPath, [entry, "validate", file]).pipe(Effect.result),
      ),
      "unknown config fields must fail validation",
    );
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
      yield* assert(yield* fs.exists(lock), "lock must exist while held");
      return yield* new BackupError({ message: "probe-failure" });
    }).pipe(Effect.scoped, Effect.result);
    yield* assert(Result.isFailure(failed), "test job must fail");
    yield* assert(!(yield* fs.exists(lock)), "failed job scope must release the lock");
    yield* withLock(job).pipe(Effect.scoped);
    yield* assert(!(yield* fs.exists(lock)), "next job must acquire and release the lock");
  }).pipe(Effect.provide(infrastructure)),
);
