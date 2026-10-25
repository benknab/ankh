import {
  Cause,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Queue,
  Result,
  Schema,
  Stream,
} from "effect";
import { Commands } from "../process/commands.ts";
import {
  type AbsolutePath,
  absolutePath,
  archiveFileName,
  BackupError,
  backupError,
  type Job,
  type Proton,
} from "../domain/model.ts";
import { type Archive, archiveName, archiveTime } from "../domain/archive.ts";
import { privateDirectory, Storage } from "../storage/storage.ts";

const verify = Effect.fn("Outbox.verify")(function* (archive: Archive) {
  const { fs } = yield* Storage;
  const commands = yield* Commands;
  const checksum = yield* fs.readFileString(archive.checksum);
  yield* Schema.decodeEffect(
    Schema.String.check(
      Schema.isPattern(new RegExp(`^[a-f0-9]{64}  ${archive.name.replace(/[.]/g, "\\.")}\n?$`)),
    ),
  )(checksum);
  yield* commands.run("sha256sum", ["--check", archive.checksum], {
    cwd: archive.directory,
  });
  yield* commands.run("zstd", ["--quiet", "--test", archive.file]);
});

const list = Effect.fn("Outbox.list")(function* (job: Job, destination: Proton) {
  const { fs, path } = yield* Storage;
  yield* privateDirectory(destination.outbox);
  const entries = yield* fs.readDirectory(destination.outbox);
  const archives: Archive[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".retired-") || entry.startsWith(".ack-")) {
      const legacy = entry.startsWith(".ack-");
      const name = legacy ? entry.slice(5) : `${entry.slice(9)}.tar.zst`;
      if (Option.isSome(archiveTime(job.name, name))) {
        if (legacy) {
          yield* fs.remove(path.join(destination.outbox, name), { force: true });
          yield* fs.remove(path.join(destination.outbox, `${name}.sha256`), { force: true });
        }
        yield* fs.remove(path.join(destination.outbox, entry), { recursive: true, force: true });
      }
      continue;
    }
    const legacy = entry.endsWith(".tar.zst");
    const name = legacy ? entry : `${entry}.tar.zst`;
    if (Option.isNone(archiveTime(job.name, name))) {
      continue;
    }
    const directory = absolutePath(
      legacy ? destination.outbox : path.join(destination.outbox, entry),
    );
    const file = absolutePath(path.join(directory, name));
    archives.push({
      name: archiveFileName(name),
      directory,
      file,
      checksum: absolutePath(`${file}.sha256`),
      legacy,
    });
  }
  return archives;
});

const enqueue = Effect.fn("Outbox.enqueue")(function* (
  job: Job,
  destination: Proton,
  stage: AbsolutePath,
) {
  const { fs, path } = yield* Storage;
  const commands = yield* Commands;
  yield* privateDirectory(destination.outbox);
  const name = archiveName(job.name, yield* DateTime.now);
  yield* Effect.acquireUseRelease(
    fs.makeTempDirectory({
      directory: destination.outbox,
      prefix: ".partial-",
    }),
    (temporary) =>
      Effect.gen(function* () {
        const file = absolutePath(path.join(temporary, name));
        // GNU tar streams to zstd; the outbox never needs an uncompressed tar copy.
        yield* commands.run("tar", [
          "--use-compress-program=zstd",
          "--create",
          "--file",
          file,
          "--directory",
          path.dirname(stage),
          path.basename(stage),
        ]);
        yield* fs.chmod(file, 0o600);
        const output = yield* commands.run("sha256sum", [name], { cwd: temporary });
        yield* fs.writeFileString(`${file}.sha256`, `${output}\n`, { mode: 0o600 });
        yield* verify({
          name,
          file,
          checksum: absolutePath(`${file}.sha256`),
          directory: absolutePath(temporary),
          legacy: false,
        });
        const ready = path.join(destination.outbox, name.slice(0, -".tar.zst".length));
        if (yield* fs.exists(ready)) {
          return yield* new BackupError({
            message: `Archive already exists: ${ready}`,
          });
        }
        yield* fs.rename(temporary, ready);
      }),
    (directory) => fs.remove(directory, { recursive: true, force: true }),
  );
}, Effect.scoped);

const acknowledge = Effect.fn("Outbox.acknowledge")(function* (archive: Archive) {
  const { fs, path } = yield* Storage;
  if (archive.legacy) {
    const marker = path.join(archive.directory, `.ack-${archive.name}`);
    yield* fs.makeDirectory(marker, { recursive: true, mode: 0o700 });
    yield* fs.remove(archive.file, { force: true });
    yield* fs.remove(archive.checksum, { force: true });
    yield* fs.remove(marker, { recursive: true, force: true });
  } else {
    const retired = path.join(
      path.dirname(archive.directory),
      `.retired-${path.basename(archive.directory)}`,
    );
    yield* fs.rename(archive.directory, retired);
    yield* fs.remove(retired, { recursive: true, force: true });
  }
});

const drain = Effect.fn("Outbox.drain")(function* (
  job: Job,
  destination: Proton,
  upload: (archive: Archive) => Effect.Effect<void, BackupError>,
) {
  const queue = yield* Queue.make<Archive, Cause.Done>();
  yield* Effect.addFinalizer(() => Queue.shutdown(queue));
  yield* Queue.offerAll(queue, yield* list(job, destination));
  yield* Queue.end(queue);
  const failures: string[] = [];
  yield* Stream.fromQueue(queue).pipe(
    Stream.runForEach(
      Effect.fn("Outbox.deliver")(function* (archive) {
        const result = yield* Effect.gen(function* () {
          yield* verify(archive);
          yield* upload(archive);
          yield* acknowledge(archive);
        }).pipe(Effect.result);
        if (Result.isFailure(result)) {
          failures.push(`${archive.name}: ${String(result.failure)}`);
        }
      }),
    ),
  );
  if (failures.length > 0) {
    return yield* new BackupError({ message: failures.join("; ") });
  }
}, Effect.scoped);

export class Outbox extends Context.Service<
  Outbox,
  {
    readonly enqueue: (
      job: Job,
      destination: Proton,
      stage: AbsolutePath,
    ) => Effect.Effect<void, BackupError>;
    readonly drain: (
      job: Job,
      destination: Proton,
      upload: (archive: Archive) => Effect.Effect<void, BackupError>,
    ) => Effect.Effect<void, BackupError>;
    readonly check: (job: Job, destination: Proton) => Effect.Effect<void, BackupError>;
  }
>()("backup-runner/Outbox") {
  static readonly layer = Layer.effect(
    Outbox,
    Effect.gen(function* () {
      const context = yield* Effect.context<Commands | Storage>();
      const provide = <A, E>(effect: Effect.Effect<A, E, Commands | Storage>) =>
        effect.pipe(Effect.provide(context), Effect.mapError(backupError("Outbox")));
      return Outbox.of({
        enqueue: (job, destination, stage) => provide(enqueue(job, destination, stage)),
        drain: (job, destination, upload) => provide(drain(job, destination, upload)),
        check: (job, destination) =>
          provide(
            list(job, destination).pipe(
              Effect.flatMap((archives) => Effect.forEach(archives, verify, { discard: true })),
            ),
          ),
      });
    }),
  );
}
