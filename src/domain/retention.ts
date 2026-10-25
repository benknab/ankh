import { Array, DateTime, Effect, HashSet, Option, Order } from "effect";
import { archiveTime } from "#/domain/archive.ts";
import {
  archiveFileName,
  type ArchiveName,
  BackupError,
  type JobName,
  type Retention,
} from "#/domain/model.ts";

export type Snapshot = {
  readonly name: ArchiveName;
  readonly time: DateTime.Utc;
};

const newestFirst = Order.mapInput(
  Order.flip(DateTime.Order),
  (snapshot: Snapshot) => snapshot.time,
);

const parsePair = Effect.fn("parsePair")(function* (
  job: JobName,
  names: HashSet.HashSet<string>,
  entry: string,
) {
  const name = entry.endsWith(".sha256") ? entry.slice(0, -".sha256".length) : entry;
  const time = archiveTime(job, name);
  if (Option.isNone(time)) {
    return Option.none<Snapshot>();
  }
  if (!HashSet.has(names, name) || !HashSet.has(names, `${name}.sha256`)) {
    return yield* BackupError.make({ message: `Incomplete remote archive pair: ${name}` });
  }
  return entry === name
    ? Option.some({ name: archiveFileName(name), time: time.value })
    : Option.none<Snapshot>();
});

export const parseSnapshotPairs = Effect.fn("parseSnapshotPairs")(function* (
  job: JobName,
  names: HashSet.HashSet<string>,
) {
  const pairs = yield* Effect.forEach(names, (name) => parsePair(job, names, name));
  return Array.sort(Array.getSomes(pairs), newestFirst);
});

const keepPeriod = (
  snapshots: readonly Snapshot[],
  period: "day" | "week" | "month" | "year",
  count: number,
): HashSet.HashSet<ArchiveName> => {
  let seen = HashSet.empty<string>();
  let keep = HashSet.empty<ArchiveName>();
  for (const snapshot of snapshots) {
    if (HashSet.size(seen) >= count) {
      break;
    }
    const key = DateTime.formatIso(DateTime.startOf(snapshot.time, period, { weekStartsOn: 1 }));
    if (!HashSet.has(seen, key)) {
      seen = HashSet.add(seen, key);
      keep = HashSet.add(keep, snapshot.name);
    }
  }
  return keep;
};

export const expiredSnapshots = (
  input: readonly Snapshot[],
  retention: Retention,
): HashSet.HashSet<ArchiveName> => {
  const snapshots = Array.sort(input, newestFirst);
  const periods = [
    ["day", retention.daily],
    ["week", retention.weekly],
    ["month", retention.monthly],
    ["year", retention.yearly],
  ] as const;
  const keep = Array.reduce(periods, HashSet.empty<ArchiveName>(), (all, [period, count]) =>
    HashSet.union(all, keepPeriod(snapshots, period, count)),
  );
  return HashSet.difference(HashSet.fromIterable(Array.map(snapshots, (s) => s.name)), keep);
};

export const retentionCandidates = Effect.fn("retentionCandidates")(function* (
  snapshots: readonly Snapshot[],
) {
  const now = yield* DateTime.now;
  const candidates = Array.filter(
    snapshots,
    (snapshot) => !DateTime.isGreaterThan(snapshot.time, now),
  );
  if (candidates.length !== snapshots.length) {
    yield* Effect.logWarning(
      "Future-dated Proton snapshots were excluded from retention; check the clock",
    );
  }
  return candidates;
});
