import { expect, it } from "@effect/vitest";
import {
  Array,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Ref,
  Result,
  Schema,
} from "effect";
import { Commands } from "#process/commands.ts";
import { absolutePath, BackupError, Job, Proton } from "#domain/model.ts";
import { Outbox } from "#outbox/outbox.ts";
import { Storage } from "#storage/storage.ts";
import { outboxInfrastructure } from "#testing/infrastructure.ts";
import { fixture } from "#testing/fixtures.ts";

it.live("durable outbox survives failure, retries through Queue, and restores SQLite", () =>
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
    const destination = yield* Schema.decodeEffect(Proton)({
      type: "proton-drive",
      outbox: queuePath,
      remoteFolder: "/my-files/Test Backups",
    });
    const job = yield* Schema.decodeUnknownEffect(Job)(fixture);
    yield* outbox.enqueue(job, destination, stage);
    const initial = yield* fs.readDirectory(queuePath);
    expect(
      initial.length === 1 && initial[0]?.startsWith(".partial") === false,
      "only a complete pair may be visible",
    ).toBe(true);
    expect((yield* fs.stat(queuePath)).mode & 0o777, "outbox must be private").toBe(0o700);
    const failure = yield* outbox
      .drain(job, destination, () => Effect.fail(BackupError.make({ message: "offline" })))
      .pipe(Effect.result);
    expect(Result.isFailure(failure), "upload failure must be reported").toBe(true);
    expect(yield* fs.readDirectory(queuePath), "failure must keep the pair").toHaveLength(1);
    const uploads = yield* Ref.make(0);
    yield* outbox.drain(job, destination, (archive) =>
      Effect.gen(function* () {
        yield* fs.copyFile(archive.file, path.join(remote, archive.name));
        yield* fs.copyFile(archive.checksum, path.join(remote, `${archive.name}.sha256`));
        yield* Ref.update(uploads, (n) => n + 1);
      }).pipe(Effect.mapError((e) => BackupError.make({ message: String(e) }))),
    );
    expect(yield* Ref.get(uploads), "Queue should deliver the pending archive once").toBe(1);
    expect(
      yield* fs.readDirectory(queuePath),
      "acknowledged pair must leave the outbox",
    ).toHaveLength(0);
    const archive = Option.getOrThrow(
      Array.findFirst(yield* fs.readDirectory(remote), (file) => file.endsWith(".tar.zst")),
    );
    yield* commands.run("sha256sum", ["--check", `${archive}.sha256`], { cwd: remote });
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
    expect(Redacted.value(value.stdout).trim(), "archive must restore the original database").toBe(
      "verified",
    );
    yield* Effect.logInfo("Restore verified", DateTime.formatIso(yield* DateTime.now));
  }).pipe(Effect.provide(outboxInfrastructure)),
);

for (const legacy of [false, true]) {
  it.live(
    `outbox resumes interrupted ${legacy ? "legacy" : "directory"} acknowledgement without uploading again`,
    () =>
      Effect.gen(function* () {
        const storage = yield* Storage;
        const { fs, path } = storage;
        const commands = yield* Commands;
        const root = yield* fs.makeTempDirectoryScoped();
        const stage = absolutePath(path.join(root, "test-job"));
        yield* fs.makeDirectory(stage);
        yield* fs.writeFileString(path.join(stage, "data"), "verified");
        const destination = yield* Schema.decodeEffect(Proton)({
          type: "proton-drive",
          outbox: path.join(root, "outbox"),
          remoteFolder: "/my-files/a",
        });
        const job = yield* Schema.decodeUnknownEffect(Job)(fixture);
        const outbox = yield* Outbox;
        yield* outbox.enqueue(job, destination, stage);
        if (legacy) {
          const entry = Option.getOrThrow(Array.head(yield* fs.readDirectory(destination.outbox)));
          const ready = path.join(destination.outbox, entry);
          for (const file of yield* fs.readDirectory(ready)) {
            yield* fs.rename(path.join(ready, file), path.join(destination.outbox, file));
          }
          yield* fs.remove(ready, { recursive: true });
        }
        const uploads = yield* Ref.make(0);
        const interruptedStorage = Storage.of({
          ...storage,
          fs: {
            ...fs,
            remove: (file, options) =>
              (legacy ? file.endsWith(".sha256") : path.basename(file).startsWith(".retired-"))
                ? Effect.interrupt
                : fs.remove(file, options),
          },
        });
        const interrupted = Layer.fresh(Outbox.layer).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Storage, interruptedStorage),
              Layer.succeed(Commands, commands),
            ),
          ),
        );
        const exit = yield* Effect.gen(function* () {
          const pending = yield* Outbox;
          yield* pending.drain(job, destination, () => Ref.update(uploads, (n) => n + 1));
        }).pipe(Effect.provide(interrupted), Effect.exit);
        expect(Exit.isFailure(exit), "injected interruption must occur").toBe(true);
        expect(yield* Ref.get(uploads), "upload must have completed before interruption").toBe(1);
        yield* outbox.drain(job, destination, () => Ref.update(uploads, (n) => n + 1));
        expect(yield* Ref.get(uploads), "retired archives must not upload twice").toBe(1);
        expect(
          yield* fs.readDirectory(destination.outbox),
          "retry must complete local retirement",
        ).toHaveLength(0);
      }).pipe(Effect.provide(outboxInfrastructure)),
  );
}

it.live("a corrupt ready archive stays on disk while later valid archives upload", () =>
  Effect.gen(function* () {
    const { fs, path } = yield* Storage;
    const outbox = yield* Outbox;
    const root = yield* fs.makeTempDirectoryScoped();
    const stage = absolutePath(path.join(root, "test-job"));
    yield* fs.makeDirectory(stage);
    yield* fs.writeFileString(path.join(stage, "data"), "verified");
    const destination = yield* Schema.decodeEffect(Proton)({
      type: "proton-drive",
      outbox: path.join(root, "outbox"),
      remoteFolder: "/my-files/a",
    });
    const job = yield* Schema.decodeUnknownEffect(Job)(fixture);
    yield* outbox.enqueue(job, destination, stage);
    const entry = Option.getOrThrow(Array.head(yield* fs.readDirectory(destination.outbox)));
    yield* fs.writeFileString(
      path.join(destination.outbox, entry, `${entry}.tar.zst`),
      "corrupted",
    );
    yield* outbox.enqueue(job, destination, stage);
    const uploads = yield* Ref.make(0);
    const result = yield* outbox
      .drain(job, destination, () => Ref.update(uploads, (n) => n + 1))
      .pipe(Effect.result);
    expect(Result.isFailure(result), "corruption must be reported").toBe(true);
    expect(yield* Ref.get(uploads), "valid archive must still upload").toBe(1);
    expect(
      yield* fs.readDirectory(destination.outbox),
      "corrupt archive must stay available for diagnosis",
    ).toHaveLength(1);
  }).pipe(Effect.provide(outboxInfrastructure)),
);

for (const failure of ["tar", "checksum", "verify", "zstd", "publish", "cleanup"] as const) {
  it.live(`outbox ${failure} failure never exposes an incomplete archive pair`, () =>
    Effect.gen(function* () {
      const storage = yield* Storage;
      const { fs, path } = storage;
      const commands = yield* Commands;
      const root = yield* fs.makeTempDirectoryScoped();
      const stage = absolutePath(path.join(root, "test-job"));
      yield* fs.makeDirectory(stage);
      yield* fs.writeFileString(path.join(stage, "data"), "verified");
      const destination = yield* Schema.decodeEffect(Proton)({
        type: "proton-drive",
        outbox: path.join(root, "outbox"),
        remoteFolder: "/my-files/a",
      });
      const job = yield* Schema.decodeUnknownEffect(Job)(fixture);
      const failedCommands = Commands.of({
        run: (binary, args, options) =>
          (binary === "tar" && (failure === "tar" || failure === "cleanup")) ||
          (binary === "zstd" && failure === "zstd") ||
          (binary === "sha256sum" &&
            (args[0] === "--check" ? failure === "verify" : failure === "checksum"))
            ? Effect.fail(BackupError.make({ message: "injected failure" }))
            : commands.run(binary, args, options),
      });
      const failedStorage = Storage.of({
        ...storage,
        fs: {
          ...fs,
          rename: (from, to) =>
            failure === "publish" ? fs.rename("/missing-test-source", to) : fs.rename(from, to),
          remove: (file, options) =>
            failure === "cleanup" && path.basename(file).startsWith(".partial-")
              ? fs.remove("/missing-test-source")
              : fs.remove(file, options),
        },
      });
      const layer = Layer.fresh(Outbox.layer).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Storage, failedStorage),
            Layer.succeed(Commands, failedCommands),
          ),
        ),
      );
      const result = yield* Effect.gen(function* () {
        yield* (yield* Outbox).enqueue(job, destination, stage);
      }).pipe(Effect.provide(layer), Effect.result);
      expect(Result.isFailure(result), "failure must stay in the Effect error channel").toBe(true);
      expect(
        Array.every(yield* fs.readDirectory(destination.outbox), (entry) =>
          entry.startsWith(".partial-"),
        ),
        "failed publication must not expose ready data",
      ).toBe(true);
    }).pipe(Effect.provide(outboxInfrastructure)),
  );
}
