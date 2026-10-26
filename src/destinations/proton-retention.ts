import { Array, Effect, HashSet, Option, Schema } from "effect";
import {
  ArchiveName,
  BackupError,
  type Job,
  type Proton,
  ProtonFolderIdentity,
  RemoteFolder,
} from "#/domain/model.ts";
import { ProtonDrive, type OpenProtonFolder } from "#/clients/proton/client.ts";
import { archiveTime } from "#/domain/archive.ts";
import { expiredSnapshots, parseSnapshotPairs, retentionCandidates } from "#/domain/retention.ts";
import { privateDirectory, Storage } from "#/storage/storage.ts";

const Intent = Schema.fromJsonString(
  Schema.Struct({
    remoteFolder: RemoteFolder,
    identity: Schema.optionalKey(ProtonFolderIdentity),
    names: Schema.Array(ArchiveName).check(Schema.isMinLength(1)),
  }),
);

interface RetentionContext {
  readonly job: Job;
  readonly destination: Proton;
  readonly journal: string;
  readonly remote: OpenProtonFolder;
}

const recover = Effect.fn("Proton.recoverRetention")(function* ({
  job,
  destination,
  journal,
  remote,
}: RetentionContext) {
  const { fs } = yield* Storage;
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
    if (
      (pending.identity !== undefined && pending.identity !== remote.identity) ||
      (pending.identity === undefined && destination.remoteFolder.startsWith("/shared-with-me/"))
    ) {
      return yield* BackupError.make({
        message:
          "Retention journal folder identity is missing or changed; reconcile the pending deletion before retrying",
      });
    }
    yield* remote.trash(HashSet.fromIterable(pending.names));
    yield* fs.remove(journal);
  }
});

const removeExpired = Effect.fn("Proton.removeExpired")(function* (
  { destination, journal, remote }: RetentionContext,
  expired: HashSet.HashSet<ArchiveName>,
) {
  const { fs } = yield* Storage;
  if (HashSet.size(expired) === 0) {
    return;
  }
  const pending = yield* Schema.encodeEffect(Intent)({
    remoteFolder: destination.remoteFolder,
    identity: remote.identity,
    names: Array.fromIterable(expired),
  });
  yield* fs.writeFileString(`${journal}.partial`, pending, { mode: 0o600 });
  yield* fs.rename(`${journal}.partial`, journal);
  yield* remote.trash(expired);
  yield* fs.remove(journal);
});

export const retainProton = Effect.fn("Proton.retain")(function* (job: Job, destination: Proton) {
  const { path } = yield* Storage;
  const proton = yield* ProtonDrive;
  yield* privateDirectory(destination.outbox);
  const journal = path.join(destination.outbox, `.retention-${job.name}.json`);
  const remote = yield* proton.open(destination);
  const context = { job, destination, journal, remote };
  yield* recover(context);
  const snapshots = yield* parseSnapshotPairs(job.name, yield* remote.list).pipe(
    Effect.flatMap(retentionCandidates),
  );
  yield* removeExpired(context, expiredSnapshots(snapshots, job.retention));
});
