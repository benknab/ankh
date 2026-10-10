import { Cause, Context, DateTime, Effect, Layer, Option, Queue, Schema, Stream } from "effect";
import { Commands } from "./commands.ts";
import {
  type AbsolutePath,
  absolutePath,
  archiveFileName,
  type ArchiveName,
  BackupError,
  type Job,
  type Proton,
} from "./model.ts";
import { archiveName, archiveTime } from "./retention.ts";
import { privateDirectory, Storage } from "./storage.ts";

export type Archive = {
  readonly name: ArchiveName;
  readonly file: AbsolutePath;
  readonly checksum: AbsolutePath;
  readonly directory: AbsolutePath;
  readonly legacy: boolean;
};

const verify = Effect.fn("Outbox.verify")(function* (archive: Archive) {
  const { fs } = yield* Storage;
  const commands = yield* Commands;
  const checksum = yield* fs.readFileString(archive.checksum);
  yield* Schema.decodeUnknownEffect(
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
  const temporary = yield* Effect.acquireRelease(
    fs.makeTempDirectory({
      directory: destination.outbox,
      prefix: ".partial-",
    }),
    (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
  );
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
}, Effect.scoped);

const acknowledge = Effect.fn("Outbox.acknowledge")(function* (archive: Archive) {
  const { fs } = yield* Storage;
  if (archive.legacy) {
    yield* fs.remove(archive.file);
    yield* fs.remove(archive.checksum);
  } else {
    yield* fs.remove(archive.directory, { recursive: true });
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
  yield* Stream.fromQueue(queue).pipe(
    Stream.runForEach(
      Effect.fn("Outbox.deliver")(function* (archive) {
        yield* verify(archive);
        yield* upload(archive);
        yield* acknowledge(archive);
      }),
    ),
  );
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
        effect.pipe(
          Effect.provide(context),
          Effect.mapError((e) => new BackupError({ message: String(e) })),
        );
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
