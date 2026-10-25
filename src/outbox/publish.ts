import { DateTime, Effect } from "effect";
import { ArchiveClient } from "#/clients/archive.ts";
import { type Archive, archiveName } from "#/domain/archive.ts";
import {
  type AbsolutePath,
  absolutePath,
  BackupError,
  type Job,
  type Proton,
} from "#/domain/model.ts";
import { privateDirectory, Storage } from "#/storage/storage.ts";
import { track } from "#/telemetry/execution.ts";

const publish = Effect.fn("Outbox.publish")(function* (
  stage: AbsolutePath,
  archive: Archive,
  ready: string,
) {
  const { fs } = yield* Storage;
  yield* track("archive", (yield* ArchiveClient).create(stage, archive));
  if (yield* fs.exists(ready)) {
    return yield* BackupError.make({ message: `Archive already exists: ${ready}` });
  }
  yield* fs.rename(archive.directory, ready);
});

export const enqueue = Effect.fn("Outbox.enqueue")(function* (
  job: Job,
  destination: Proton,
  stage: AbsolutePath,
) {
  const { fs, path } = yield* Storage;
  yield* privateDirectory(destination.outbox);
  const name = archiveName(job.name, yield* DateTime.now);
  yield* Effect.acquireUseRelease(
    fs.makeTempDirectory({ directory: destination.outbox, prefix: ".partial-" }),
    (temporary) =>
      publish(
        stage,
        {
          name,
          file: absolutePath(path.join(temporary, name)),
          checksum: absolutePath(path.join(temporary, `${name}.sha256`)),
          directory: absolutePath(temporary),
        },
        path.join(destination.outbox, name.slice(0, -".tar.zst".length)),
      ),
    (directory) => fs.remove(directory, { recursive: true, force: true }),
  );
}, Effect.scoped);
