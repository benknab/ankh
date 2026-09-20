import { NodeServices } from "@effect/platform-node";
import {
  DateTime,
  Deferred,
  Effect,
  Fiber,
  HashSet,
  Layer,
  Ref,
  Result,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Commands } from "./src/commands.ts";
import { absolutePath, BackupError, Job, Proton } from "./src/model.ts";
import { Outbox } from "./src/outbox.ts";
import { Storage, withLock } from "./src/storage.ts";
import { assert, fixture } from "./test-support.ts";
import { Destinations } from "./src/destinations.ts";
import { ProtonDrive } from "./src/proton.ts";
import { runJob } from "./src/runner.ts";
import { Sources } from "./src/sources.ts";
import { login } from "./src/auth.ts";
import { protonEnvironment } from "./src/proton.ts";

const infrastructure = Layer.mergeAll(Commands.layer, Storage.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const live = Outbox.layer.pipe(Layer.provideMerge(infrastructure));

Deno.test({
  name: "concurrent scheduled jobs wait for the shared drive lock",
  ignore: Deno.env.get("BACKUP_INTEGRATION") !== "1",
  fn: () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { fs, path } = yield* Storage;
        const root = yield* fs.makeTempDirectoryScoped();
        const job = yield* Schema.decodeUnknownEffect(Job)({
          ...fixture,
          backupDrive: {
            ...fixture.backupDrive,
            sentinelFile: path.join(root, ".sentinel"),
          },
        });
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const acquired = yield* Ref.make(false);
        const first = yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* withLock(job);
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
          }).pipe(Effect.scoped),
        );
        yield* Deferred.await(held);
        const second = yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* withLock(job);
            yield* Ref.set(acquired, true);
          }).pipe(Effect.scoped),
        );
        yield* Effect.sleep("100 millis");
        yield* assert(
          !(yield* Ref.get(acquired)),
          "another job must not enter while lock is held",
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        yield* assert(
          yield* Ref.get(acquired),
          "waiting job must acquire released lock",
        );
        yield* assert(
          !(yield* fs.exists(path.join(root, ".runner-lock"))),
          "both scopes must release the lock",
        );
      }).pipe(Effect.scoped, Effect.provide(infrastructure)),
    ),
});

Deno.test({
  name: "Proton credential setup creates a usable encryption key",
  ignore: Deno.env.get("BACKUP_INTEGRATION") !== "1",
  fn: () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* Commands;
        const { fs } = yield* Storage;
        const testCommands = Commands.of({
          run: (binary, args, options) =>
            binary === "proton-drive"
              ? Effect.succeed("login skipped in test")
              : commands.run(binary, args, options),
        });
        yield* login().pipe(Effect.provideService(Commands, testCommands));
        yield* fs.writeFileString("/proton/probe", "credential-round-trip", {
          mode: 0o600,
        });
        yield* commands.run("gpg", [
          "--batch",
          "--yes",
          "--recipient",
          "backup-runner@localhost",
          "--output",
          "/proton/probe.gpg",
          "--encrypt",
          "/proton/probe",
        ], { env: protonEnvironment });
        const decrypted = yield* commands.run("gpg", [
          "--batch",
          "--decrypt",
          "/proton/probe.gpg",
        ], { env: protonEnvironment });
        yield* assert(
          decrypted === "credential-round-trip",
          "session encryption key must support decryption",
        );
        // A second login setup must reuse the existing key and store.
        yield* login().pipe(Effect.provideService(Commands, testCommands));
      }).pipe(Effect.provide(infrastructure)),
    ),
});

Deno.test({
  name:
    "durable outbox survives failure, retries through Queue, and restores SQLite",
  ignore: Deno.env.get("BACKUP_INTEGRATION") !== "1",
  fn: () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { fs, path } = yield* Storage;
        const commands = yield* Commands;
        const outbox = yield* Outbox;
        const root = yield* fs.makeTempDirectoryScoped();
        const stage = absolutePath(path.join(root, "test-job"));
        const queuePath = path.join(root, "outbox");
        const remote = path.join(root, "remote");
        yield* fs.makeDirectory(stage);
        yield* fs.makeDirectory(remote);
        yield* commands.run("sqlite3", [
          path.join(stage, "test.db"),
          "CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('verified');",
        ]);
        const destination = yield* Schema.decodeUnknownEffect(Proton)({
          type: "proton-drive",
          outbox: queuePath,
          remoteFolder: "/my-files/Test Backups",
        });
        const job = yield* Schema.decodeUnknownEffect(Job)(fixture);
        yield* outbox.enqueue(job, destination, stage);
        const initial = yield* fs.readDirectory(queuePath);
        yield* assert(
          initial.length === 1 && !initial[0]?.startsWith(".partial"),
          "only a complete pair may be visible",
        );
        yield* assert(
          ((yield* fs.stat(queuePath)).mode & 0o777) === 0o700,
          "outbox must be private",
        );
        const failure = yield* outbox.drain(
          job,
          destination,
          () => Effect.fail(new BackupError({ message: "offline" })),
        ).pipe(Effect.result);
        yield* assert(
          Result.isFailure(failure),
          "upload failure must be reported",
        );
        yield* assert(
          (yield* fs.readDirectory(queuePath)).length === 1,
          "failure must keep the pair",
        );
        const uploads = yield* Ref.make(0);
        yield* outbox.drain(job, destination, (archive) =>
          Effect.gen(function* () {
            yield* fs.copyFile(archive.file, path.join(remote, archive.name));
            yield* fs.copyFile(
              archive.checksum,
              path.join(remote, `${archive.name}.sha256`),
            );
            yield* Ref.update(uploads, (n) =>
              n + 1);
          }).pipe(
            Effect.mapError((e) =>
              new BackupError({ message: String(e) })
            ),
          ));
        yield* assert(
          (yield* Ref.get(uploads)) === 1,
          "Queue should deliver the pending archive once",
        );
        yield* assert(
          (yield* fs.readDirectory(queuePath)).length === 0,
          "acknowledged pair must leave the outbox",
        );
        const archive = (yield* fs.readDirectory(remote)).find((file) =>
          file.endsWith(".tar.zst")
        );
        if (!archive) {
          return yield* Effect.die("missing uploaded archive");
        }
        yield* commands.run("sha256sum", ["--check", `${archive}.sha256`], {
          cwd: remote,
        });
        const restore = path.join(root, "restore");
        yield* fs.makeDirectory(restore);
        yield* commands.run("tar", [
          "--use-compress-program=zstd",
          "--extract",
          "--file",
          path.join(remote, archive),
          "--directory",
          restore,
        ]);
        const value = yield* commands.run("sqlite3", [
          path.join(restore, "test-job/test.db"),
          "SELECT value FROM records;",
        ]);
        yield* assert(
          value === "verified",
          "archive must restore the original database",
        );
        yield* Effect.logInfo(
          "Restore verified",
          DateTime.formatIso(yield* DateTime.now),
        );
      }).pipe(Effect.scoped, Effect.provide(live)),
    ),
});

Deno.test({
  name: "Commands drains stdout and stderr and rejects nonzero exits",
  ignore: Deno.env.get("BACKUP_INTEGRATION") !== "1",
  fn: () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* Commands;
        const result = yield* commands.run("sh", [
          "-c",
          "printf output; printf failure >&2; exit 7",
        ]).pipe(Effect.result);
        yield* assert(Result.isFailure(result), "exit 7 must fail");
        if (Result.isFailure(result)) {
          yield* assert(
            result.failure.message.includes("failure"),
            "stderr must be in the error",
          );
        }
      }).pipe(Effect.provide(infrastructure)),
    ),
});

Deno.test({
  name:
    "real SQLite and Restic survive Proton failure, then retry and restore both copies",
  ignore: Deno.env.get("BACKUP_INTEGRATION") !== "1",
  fn: () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { fs, path } = yield* Storage;
        const commands = yield* Commands;
        const outbox = yield* Outbox;
        const root = yield* fs.makeTempDirectoryScoped();
        const source = path.join(root, "source.db");
        const password = path.join(root, "password");
        const repository = path.join(root, "restic");
        const remote = path.join(root, "remote");
        const sentinel = path.join(root, ".sentinel");
        yield* fs.makeDirectory(remote);
        yield* fs.writeFileString(password, "integration-test-only", {
          mode: 0o600,
        });
        yield* fs.writeFileString(sentinel, "serial=test\nuuid=test\n");
        yield* commands.run("sqlite3", [
          source,
          "CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('verified');",
        ]);
        const job = yield* Schema.decodeUnknownEffect(Job)({
          ...fixture,
          source: { ...fixture.source, path: source },
          backupDrive: { ...fixture.backupDrive, sentinelFile: sentinel },
          destinations: [
            { type: "restic", repository, passwordFile: password },
            {
              type: "proton-drive",
              remoteFolder: "/my-files/Integration Test",
              outbox: path.join(root, "outbox"),
            },
          ],
        });
        const jobFile = absolutePath(path.join(root, "job.json"));
        yield* fs.writeFileString(
          jobFile,
          yield* Schema.encodeEffect(Schema.fromJsonString(Job))(job),
        );
        const online = yield* Ref.make(false);
        const proton = Layer.succeed(
          ProtonDrive,
          ProtonDrive.of({
            initialize: () => Effect.void,
            list: () =>
              fs.readDirectory(remote).pipe(
                Effect.map(HashSet.fromIterable),
                Effect.mapError((e) => new BackupError({ message: String(e) })),
              ),
            upload: (_destination, archive) =>
              Effect.gen(function* () {
                if (!(yield* Ref.get(online))) {
                  return yield* new BackupError({ message: "offline" });
                }
                yield* fs.copyFile(
                  archive.file,
                  path.join(remote, archive.name),
                );
                yield* fs.copyFile(
                  archive.checksum,
                  path.join(remote, `${archive.name}.sha256`),
                );
              }).pipe(
                Effect.mapError((e) => new BackupError({ message: String(e) })),
              ),
            trash: () => Effect.void,
          }),
        );
        const context = yield* Effect.context<Commands | Storage>();
        const dependencies = Layer.mergeAll(
          Layer.succeedContext(context),
          Layer.succeed(Outbox, outbox),
          proton,
          FetchHttpClient.layer,
        );
        const adapters = Layer.mergeAll(Sources.layer, Destinations.layer).pipe(
          Layer.provideMerge(dependencies),
        );
        const run = (action: "init" | "backup" | "retry") =>
          runJob(jobFile, action).pipe(Effect.provide(adapters));
        yield* run("init");
        const failed = yield* run("backup").pipe(Effect.result);
        yield* assert(
          Result.isFailure(failed),
          "offline Proton must fail the whole job",
        );
        const env = {
          RESTIC_REPOSITORY: repository,
          RESTIC_PASSWORD_FILE: password,
        };
        const snapshots = yield* commands.run(
          "restic",
          ["snapshots", "--json"],
          { env },
        );
        yield* assert(
          snapshots.includes("test-host"),
          "Restic snapshot must survive Proton failure",
        );
        yield* Ref.set(online, true);
        // A retry must not depend on the source still being available.
        yield* fs.remove(source);
        yield* run("retry");
        yield* assert(
          (yield* fs.readDirectory(path.join(root, "outbox"))).length === 0,
          "retry should acknowledge the pending pair",
        );
        const restored = path.join(root, "restored");
        yield* commands.run("restic", [
          "restore",
          "latest",
          "--target",
          restored,
        ], { env });
        const value = yield* commands.run("sqlite3", [
          path.join(restored, "staging/test-job/test.db"),
          "SELECT value FROM records;",
        ]);
        yield* assert(
          value === "verified",
          "Restic must restore the staged database",
        );
        const archive = (yield* fs.readDirectory(remote)).find((name) =>
          name.endsWith(".tar.zst")
        );
        if (!archive) {
          return yield* Effect.die("No uploaded archive");
        }
        yield* commands.run("sha256sum", ["--check", `${archive}.sha256`], {
          cwd: remote,
        });
        yield* commands.run("tar", [
          "--use-compress-program=zstd",
          "--extract",
          "--file",
          path.join(remote, archive),
          "--directory",
          remote,
        ]);
        const offsite = yield* commands.run("sqlite3", [
          path.join(remote, "test-job/test.db"),
          "SELECT value FROM records;",
        ]);
        yield* assert(
          offsite === "verified",
          "Proton archive must restore the same database",
        );
        yield* assert(
          !(yield* fs.exists(path.join(root, ".runner-lock"))),
          "scope must release drive lock after failure and success",
        );
      }).pipe(Effect.scoped, Effect.provide(live)),
    ),
});
