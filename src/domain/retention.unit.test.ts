import { expect, it } from "@effect/vitest";
import { Array, DateTime, Effect, HashSet, Result, Schema } from "effect";
import { JobName } from "#/domain/model.ts";
import { archiveName } from "#/domain/archive.ts";
import { TestClock } from "effect/testing";
import { expiredSnapshots, parseSnapshotPairs, retentionCandidates } from "#/domain/retention.ts";

it.effect("retention consumes parsed snapshots and keeps newest per UTC period", () =>
  Effect.gen(function* () {
    const job = yield* Schema.decodeEffect(JobName)("test-job");
    const timestamps = [
      "2026-01-01T20:00:00Z",
      "2026-01-01T10:00:00Z",
      "2025-12-31T20:00:00Z",
      "2025-12-20T20:00:00Z",
    ] as const;
    const names = Array.map(timestamps, (time) => archiveName(job, DateTime.makeUnsafe(time)));
    const files = HashSet.fromIterable(Array.flatMap(names, (name) => [name, `${name}.sha256`]));
    const snapshots = yield* parseSnapshotPairs(job, files);
    const expired = expiredSnapshots(snapshots, { daily: 1, weekly: 2, monthly: 0, yearly: 0 });
    expect(HashSet.size(expired), "same day and same ISO week copies should expire").toBe(2);
    expect(
      HashSet.has(expired, archiveName(job, DateTime.makeUnsafe(timestamps[0]))),
      "newest must survive",
    ).toBe(false);
    const missing = yield* parseSnapshotPairs(job, HashSet.fromIterable(names)).pipe(Effect.result);
    expect(Result.isFailure(missing), "retention must reject incomplete pairs").toBe(true);
  }),
);

it.effect("retention keeps 14 daily, 8 weekly, 12 monthly, and 5 yearly periods", () =>
  Effect.gen(function* () {
    const job = yield* Schema.decodeEffect(JobName)("test-job");
    const start = DateTime.makeUnsafe("2020-01-01T00:00:00Z");
    const cases = [
      { unit: "days", count: 14, policy: "daily", step: 1 },
      { unit: "days", count: 8, policy: "weekly", step: 7 },
      { unit: "months", count: 12, policy: "monthly", step: 1 },
      { unit: "years", count: 5, policy: "yearly", step: 1 },
    ] as const;
    for (const test of cases) {
      const snapshots = Array.makeBy(20, (n) => {
        const time = DateTime.add(start, { [test.unit]: n * test.step });
        return { name: archiveName(job, time), time };
      });
      const policy = { daily: 0, weekly: 0, monthly: 0, yearly: 0, [test.policy]: test.count };
      expect(
        HashSet.size(expiredSnapshots(snapshots, policy)),
        `${test.policy} count is wrong`,
      ).toBe(20 - test.count);
    }
  }),
);

it.effect("future snapshots neither consume retention slots nor become deletion candidates", () =>
  Effect.gen(function* () {
    const job = yield* Schema.decodeEffect(JobName)("test-job");
    const times = ["2024-01-01", "2025-01-01", "2099-01-01"];
    const snapshots = Array.map(times, (value) => {
      const time = DateTime.makeUnsafe(`${value}T00:00:00Z`);
      return { name: archiveName(job, time), time };
    });
    const policy = { daily: 0, weekly: 0, monthly: 0, yearly: 1 };
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-01-01T00:00:00Z")));
    expect(
      Array.fromIterable(expiredSnapshots(yield* retentionCandidates(snapshots), policy)),
    ).toEqual([snapshots[0]?.name]);
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2099-01-01T00:00:00Z")));
    expect(HashSet.size(expiredSnapshots(yield* retentionCandidates(snapshots), policy))).toBe(2);
  }),
);
