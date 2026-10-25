import { DateTime, Effect, HashSet, Option } from "effect";
import { archiveTime } from "#domain/archive.ts";
import {
  archiveFileName,
  type ArchiveName,
  BackupError,
  type JobName,
  type Retention,
} from "#domain/model.ts";

export type Snapshot = {
  readonly name: ArchiveName;
  readonly time: DateTime.Utc;
};

export const parseSnapshotPairs = Effect.fn("parseSnapshotPairs")(function* (
  job: JobName,
  names: HashSet.HashSet<string>,
) {
  const snapshots: Snapshot[] = [];
  for (const name of names) {
    if (name.endsWith(".sha256")) {
      const archive = name.slice(0, -".sha256".length);
      if (Option.isSome(archiveTime(job, archive)) && !HashSet.has(names, archive)) {
        return yield* new BackupError({
          message: `Missing remote archive: ${archive}`,
        });
      }
    }
    const time = archiveTime(job, name);
    if (Option.isSome(time)) {
      if (!HashSet.has(names, `${name}.sha256`)) {
        return yield* new BackupError({
          message: `Missing remote checksum: ${name}`,
        });
      }
      snapshots.push({ name: archiveFileName(name), time: time.value });
    }
  }
  return snapshots.sort((a, b) => DateTime.toEpochMillis(b.time) - DateTime.toEpochMillis(a.time));
});

export const expiredSnapshots = (
  input: readonly Snapshot[],
  retention: Retention,
): HashSet.HashSet<ArchiveName> => {
  const snapshots = [...input].sort(
    (a, b) => DateTime.toEpochMillis(b.time) - DateTime.toEpochMillis(a.time),
  );
  let keep = HashSet.empty<ArchiveName>();
  const periods = [
    ["day", retention.daily],
    ["week", retention.weekly],
    ["month", retention.monthly],
    ["year", retention.yearly],
  ] as const;
  for (const [period, count] of periods) {
    let seen = HashSet.empty<string>();
    for (const snapshot of snapshots) {
      const key = DateTime.formatIso(DateTime.startOf(snapshot.time, period, { weekStartsOn: 1 }));
      if (HashSet.has(seen, key)) {
        continue;
      }
      if (HashSet.size(seen) >= count) {
        break;
      }
      seen = HashSet.add(seen, key);
      keep = HashSet.add(keep, snapshot.name);
    }
  }
  return HashSet.difference(HashSet.fromIterable(snapshots.map((s) => s.name)), keep);
};
