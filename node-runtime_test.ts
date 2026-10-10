import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Result, Schema } from "effect";
import { test } from "vite-plus/test";
import { Commands } from "./src/commands.ts";
import { Actions, BackupError, Job } from "./src/model.ts";
import { Storage, withLock } from "./src/storage.ts";
import { assert, fixture } from "./test-support.ts";

const infrastructure = Layer.mergeAll(Commands.layer, Storage.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

test("Node runs the TypeScript CLI and rejects unsafe job paths", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const commands = yield* Commands;
      const { path } = yield* Storage;
      const entry = path.join(import.meta.dirname, "main.ts");
      const help = yield* commands.run(process.execPath, [entry, "--help"]);
      for (const action of [...Actions, "schedule", "proton-login"]) {
        yield* assert(help.includes(action), `missing subcommand: ${action}`);
      }
      const version = yield* commands.run(process.execPath, [entry, "--version"]);
      yield* assert(version === "backup-runner v0.1.0", "CLI version must not change");
      const invalid = yield* commands
        .run(process.execPath, [entry, "backup", "relative/job.json"])
        .pipe(Effect.result);
      yield* assert(
        Result.isFailure(invalid),
        "relative job paths must fail before accessing files",
      );
    }).pipe(Effect.provide(infrastructure)),
  ));

test("Node child processes drain large output and report failed exits", () =>
  Effect.runPromise(
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
  ));

test("Node filesystem scopes release the drive lock after failure", () =>
  Effect.runPromise(
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
    }).pipe(Effect.scoped, Effect.provide(infrastructure)),
  ));
