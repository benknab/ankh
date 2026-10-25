import { Array, Effect, HashSet, Option, Schema } from "effect";
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

const recover = Effect.fn("Proton.recoverRetention")(function* (
  job: Job,
  destination: Proton,
  journal: string,
) {
  const { fs } = yield* Storage;
  const proton = yield* ProtonDrive;
  // Only an explicit local deletion intent authorizes recovery of an incomplete remote pair.
  if (yield* fs.exists(journal)) {
    const pending = yield* Schema.decodeEffect(Intent, { onExcessProperty: "error" })(
      yield* fs.readFileString(journal),
    );
    if (
      pending.remoteFolder !== destination.remoteFolder ||
      Array.some(pending.names, (name) => Option.isNone(archiveTime(job.name, name)))
    ) {
      return yield* BackupError.make({
        message: "Retention journal belongs to a different job or remote folder",
      });
    }
    yield* proton.trash(destination, HashSet.fromIterable(pending.names));
    yield* fs.remove(journal);
  }
});

const removeExpired = Effect.fn("Proton.removeExpired")(function* (
  destination: Proton,
  journal: string,
  expired: HashSet.HashSet<ArchiveName>,
) {
  const { fs } = yield* Storage;
  const proton = yield* ProtonDrive;
  if (HashSet.size(expired) === 0) {
    return;
  }
  const pending = yield* Schema.encodeEffect(Intent)({
    remoteFolder: destination.remoteFolder,
    names: Array.fromIterable(expired),
  });
  yield* fs.writeFileString(`${journal}.partial`, pending, { mode: 0o600 });
  yield* fs.rename(`${journal}.partial`, journal);
  yield* proton.trash(destination, expired);
  yield* fs.remove(journal);
});

export const retainProton = Effect.fn("Proton.retain")(function* (job: Job, destination: Proton) {
  const { path } = yield* Storage;
  const proton = yield* ProtonDrive;
  yield* privateDirectory(destination.outbox);
  const journal = path.join(destination.outbox, `.retention-${job.name}.json`);
  yield* recover(job, destination, journal);
  const snapshots = yield* parseSnapshotPairs(job.name, yield* proton.list(destination));
  yield* removeExpired(destination, journal, expiredSnapshots(snapshots, job.retention));
});
