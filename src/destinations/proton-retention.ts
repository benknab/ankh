import { Effect, HashSet, Option, Schema } from "effect";
import { ArchiveName, BackupError, type Job, type Proton, RemoteFolder } from "#domain/model.ts";
import { ProtonDrive } from "#clients/proton/client.ts";
import { archiveTime } from "#domain/archive.ts";
import { expiredSnapshots, parseSnapshotPairs } from "#domain/retention.ts";
import { privateDirectory, Storage } from "#storage/storage.ts";

const Intent = Schema.fromJsonString(
  Schema.Struct({
    remoteFolder: RemoteFolder,
    names: Schema.Array(ArchiveName).check(Schema.isMinLength(1)),
  }),
);

export const retainProton = Effect.fn("Proton.retain")(function* (job: Job, destination: Proton) {
  const { fs, path } = yield* Storage;
  const proton = yield* ProtonDrive;
  yield* privateDirectory(destination.outbox);
  const journal = path.join(destination.outbox, `.retention-${job.name}.json`);
  // Only an explicit local deletion intent authorizes recovery of an incomplete remote pair.
  if (yield* fs.exists(journal)) {
    const pending = yield* Schema.decodeEffect(Intent, { onExcessProperty: "error" })(
      yield* fs.readFileString(journal),
    );
    if (
      pending.remoteFolder !== destination.remoteFolder ||
      pending.names.some((name) => Option.isNone(archiveTime(job.name, name)))
    ) {
      return yield* new BackupError({
        message: "Retention journal belongs to a different job or remote folder",
      });
    }
    yield* proton.trash(destination, HashSet.fromIterable(pending.names));
    yield* fs.remove(journal);
  }
  const snapshots = yield* parseSnapshotPairs(job.name, yield* proton.list(destination));
  const expired = expiredSnapshots(snapshots, job.retention);
  if (HashSet.size(expired) === 0) {
    return;
  }
  const pending = yield* Schema.encodeEffect(Intent)({
    remoteFolder: destination.remoteFolder,
    names: Array.from(expired),
  });
  yield* fs.writeFileString(`${journal}.partial`, pending, { mode: 0o600 });
  yield* fs.rename(`${journal}.partial`, journal);
  yield* proton.trash(destination, expired);
  yield* fs.remove(journal);
});
