import { expect, it } from "@effect/vitest";
import {
  Array,
  Effect,
  HashSet,
  Layer,
  Logger,
  Option,
  Redacted,
  Ref,
  Result,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { Commands } from "#process/commands.ts";
import { Destinations } from "#destinations/destinations.ts";
import { absolutePath, BackupError, Job } from "#domain/model.ts";
import { Outbox } from "#outbox/outbox.ts";
import { ProtonDrive } from "#clients/proton/client.ts";
import { runJob } from "#app/runner.ts";
import { Sources } from "#sources/sources.ts";
import { Storage } from "#storage/storage.ts";
import { outboxInfrastructure } from "#testing/infrastructure.ts";
import { fixture } from "#testing/fixtures.ts";

it.live("real SQLite and Restic survive Proton failure, then retry and restore both copies", () =>
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
    yield* fs.writeFileString(password, "integration-test-only", { mode: 0o600 });
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
    yield* fs.writeFileString(jobFile, yield* Schema.encodeEffect(Schema.fromJsonString(Job))(job));
    const online = yield* Ref.make(false);
    const proton = Layer.succeed(
      ProtonDrive,
      ProtonDrive.of({
        initialize: () => Effect.void,
        list: () =>
          fs.readDirectory(remote).pipe(
            Effect.map(HashSet.fromIterable),
            Effect.mapError((e) => BackupError.make({ message: String(e) })),
          ),
        upload: (_destination, archive) =>
          Effect.gen(function* () {
            if (!(yield* Ref.get(online))) {
              return yield* BackupError.make({ message: "offline" });
            }
            yield* fs.copyFile(archive.file, path.join(remote, archive.name));
            yield* fs.copyFile(archive.checksum, path.join(remote, `${archive.name}.sha256`));
          }).pipe(Effect.mapError((e) => BackupError.make({ message: String(e) }))),
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
    const messages: unknown[] = [];
    const logger = Logger.layer([
      Logger.make(({ message }: Logger.Options<unknown>): void => {
        messages.push(message);
      }),
    ]);
    const run = Effect.fn("Test.run")((action: "init" | "backup" | "retry") =>
      runJob(jobFile, action).pipe(Effect.provide(Layer.merge(adapters, logger))),
    );
    yield* run("init");
    const failed = yield* run("backup").pipe(Effect.result);
    expect(Result.isFailure(failed), "offline Proton must fail the whole job").toBe(true);
    const env = { RESTIC_REPOSITORY: repository, RESTIC_PASSWORD_FILE: password };
    const snapshots = yield* commands.run("restic", ["snapshots", "--json"], { env });
    expect(
      Redacted.value(snapshots.stdout),
      "Restic snapshot must survive Proton failure",
    ).toContain("test-host");
    yield* Ref.set(online, true);
    // A retry must not depend on the source still being available.
    yield* fs.remove(source);
    yield* run("retry");
    const events = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Tuple([
          Schema.Struct({
            event: Schema.Literal("execution.completed"),
            operation: Schema.String,
            status: Schema.String,
            steps: Schema.Record(
              Schema.String,
              Schema.Struct({ attempts: Schema.Int, failures: Schema.Int }),
            ),
          }),
        ]),
      ),
    )(messages);
    expect(Array.map(events, ([event]) => [event.operation, event.status])).toStrictEqual([
      ["init", "success"],
      ["backup", "failure"],
      ["retry", "success"],
    ]);
    expect(events[1]?.[0].steps).toMatchObject({
      source: { attempts: 1, failures: 0 },
      restic: { failures: 0 },
      "proton-drive": { failures: 1 },
      cleanup: { failures: 0 },
    });
    expect(events[1]?.[0].steps.process?.attempts).toBeGreaterThan(0);
    expect(events[2]?.[0].steps.source).toBeUndefined();
    expect(
      yield* fs.readDirectory(path.join(root, "outbox")),
      "retry should acknowledge the pending pair",
    ).toHaveLength(0);
    const restored = path.join(root, "restored");
    yield* commands.run("restic", ["restore", "latest", "--target", restored], { env });
    const value = yield* commands.run("sqlite3", [
      path.join(restored, "staging/test-job/test.db"),
      "SELECT value FROM records;",
    ]);
    expect(Redacted.value(value.stdout).trim(), "Restic must restore the staged database").toBe(
      "verified",
    );
    const archive = Option.getOrThrow(
      Array.findFirst(yield* fs.readDirectory(remote), (name) => name.endsWith(".tar.zst")),
    );
    yield* commands.run("sha256sum", ["--check", `${archive}.sha256`], { cwd: remote });
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
    expect(
      Redacted.value(offsite.stdout).trim(),
      "Proton archive must restore the same database",
    ).toBe("verified");
    expect(
      yield* fs.exists(path.join(root, ".runner-lock")),
      "scope must release drive lock after failure and success",
    ).toBe(false);
  }).pipe(Effect.provide(outboxInfrastructure)),
);
