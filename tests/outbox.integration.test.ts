import { it } from "@effect/vitest";
import { DateTime, Effect, Ref, Result, Schema } from "effect";
import { Commands } from "../src/commands.ts";
import { absolutePath, BackupError, Job, Proton } from "../src/model.ts";
import { Outbox } from "../src/outbox.ts";
import { Storage } from "../src/storage.ts";
import { outboxInfrastructure } from "./integration-support.ts";
import { assert, fixture } from "./support.ts";

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
    yield* assert(
      initial.length === 1 && !initial[0]?.startsWith(".partial"),
      "only a complete pair may be visible",
    );
    yield* assert(((yield* fs.stat(queuePath)).mode & 0o777) === 0o700, "outbox must be private");
    const failure = yield* outbox
      .drain(job, destination, () => Effect.fail(new BackupError({ message: "offline" })))
      .pipe(Effect.result);
    yield* assert(Result.isFailure(failure), "upload failure must be reported");
    yield* assert((yield* fs.readDirectory(queuePath)).length === 1, "failure must keep the pair");
    const uploads = yield* Ref.make(0);
    yield* outbox.drain(job, destination, (archive) =>
      Effect.gen(function* () {
        yield* fs.copyFile(archive.file, path.join(remote, archive.name));
        yield* fs.copyFile(archive.checksum, path.join(remote, `${archive.name}.sha256`));
        yield* Ref.update(uploads, (n) => n + 1);
      }).pipe(Effect.mapError((e) => new BackupError({ message: String(e) }))),
    );
    yield* assert((yield* Ref.get(uploads)) === 1, "Queue should deliver the pending archive once");
    yield* assert(
      (yield* fs.readDirectory(queuePath)).length === 0,
      "acknowledged pair must leave the outbox",
    );
    const archive = (yield* fs.readDirectory(remote)).find((file) => file.endsWith(".tar.zst"));
    if (!archive) {
      return yield* Effect.die("missing uploaded archive");
    }
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
    yield* assert(value === "verified", "archive must restore the original database");
    yield* Effect.logInfo("Restore verified", DateTime.formatIso(yield* DateTime.now));
  }).pipe(Effect.provide(outboxInfrastructure)),
);
