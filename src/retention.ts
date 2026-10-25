import { DateTime, Effect, HashSet, Option, Schema } from "effect";
import {
  archiveFileName,
  ArchiveName,
  BackupError,
  type JobName,
  type Retention,
} from "./model.ts";

export const archiveName = (job: JobName, time: DateTime.Utc): ArchiveName =>
  archiveFileName(`${job}-${DateTime.formatIso(time).replace(/[-:.]/g, "")}.tar.zst`);

export const archiveTime = (job: JobName, name: string): Option.Option<DateTime.Utc> => {
  if (Option.isNone(Schema.decodeOption(ArchiveName)(name))) {
    return Option.none();
  }
  const match = name.match(
    new RegExp(`^${job}-(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})(\\d{2})(\\d{3})Z\\.tar\\.zst$`),
  );
  if (!match) {
    return Option.none();
  }
  return DateTime.make(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`,
  ).pipe(Option.filter((time) => archiveName(job, time) === name));
};

export type Snapshot = {
  readonly name: ArchiveName;
  readonly time: DateTime.Utc;
};

export const snapshotNames = Effect.fn("snapshotNames")(function* (
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
  const periods = ["day", "week", "month", "year"] as const;
  const counts = [retention.daily, retention.weekly, retention.monthly, retention.yearly];
  for (const [index, period] of periods.entries()) {
    let seen = HashSet.empty<string>();
    for (const snapshot of snapshots) {
      const key = DateTime.formatIso(DateTime.startOf(snapshot.time, period, { weekStartsOn: 1 }));
      if (HashSet.has(seen, key)) {
        continue;
      }
      if (HashSet.size(seen) >= (counts[index] ?? 0)) {
        break;
      }
      seen = HashSet.add(seen, key);
      keep = HashSet.add(keep, snapshot.name);
    }
  }
  return HashSet.difference(HashSet.fromIterable(snapshots.map((s) => s.name)), keep);
};

export const RemoteNodes = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      name: Schema.Struct({
        ok: Schema.Literal(true),
        value: Schema.NonEmptyString,
      }),
      type: Schema.Literal("file"),
    }),
  ),
);
