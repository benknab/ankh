import { Context, Effect, FileSystem, Layer, Path, Schedule, Schema } from "effect";
import { type AbsolutePath, BackupError, type Job, JobJson } from "./model.ts";

export class Storage extends Context.Service<
  Storage,
  {
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
  }
>()("backup-runner/Storage") {
  static readonly layer = Layer.effect(
    Storage,
    Effect.gen(function* () {
      return Storage.of({
        fs: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
      });
    }),
  );
}

export const loadJob = Effect.fn("loadJob")(function* (file: AbsolutePath) {
  const { fs } = yield* Storage;
  return yield* Schema.decodeUnknownEffect(JobJson)(yield* fs.readFileString(file));
});

export const checkDrive = Effect.fn("checkDrive")(function* (job: Job) {
  const { fs } = yield* Storage;
  const text = yield* fs.readFileString(job.backupDrive.sentinelFile);
  const fields = Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      serial: Schema.Literal(job.backupDrive.driveSerial),
      uuid: Schema.Literal(job.backupDrive.filesystemUuid),
    }),
  )(fields);
});

export const privateDirectory = Effect.fn("privateDirectory")(function* (directory: string) {
  const { fs } = yield* Storage;
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.chmod(directory, 0o700);
});

export const withLock = Effect.fn("withLock")(function* (job: Job) {
  const { fs, path } = yield* Storage;
  const directory = path.join(path.dirname(job.backupDrive.sentinelFile), ".runner-lock");
  yield* Effect.acquireRelease(
    fs.makeDirectory(directory, { mode: 0o700 }).pipe(
      Effect.retry({
        schedule: Schedule.spaced("10 seconds"),
        times: 2160,
        while: (error) => error.reason._tag === "AlreadyExists",
      }),
      Effect.mapError(
        () =>
          new BackupError({
            message: `Cannot acquire ${directory}; check the drive and any active run or stale lock`,
          }),
      ),
    ),
    () => fs.remove(directory, { recursive: true }).pipe(Effect.orDie),
  );
});
