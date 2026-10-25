import { it } from "@effect/vitest";
import { DateTime, Effect, HashSet, Layer, Ref, Result, Schema } from "effect";
import { Destinations } from "#destinations/destinations.ts";
import { absolutePath, BackupError, Job, JobName } from "#domain/model.ts";
import { archiveName } from "#domain/archive.ts";
import { expiredSnapshots, parseSnapshotPairs } from "#domain/retention.ts";
import { execute } from "#app/runner.ts";
import { Sources } from "#sources/sources.ts";

import { assert, fixture } from "#testing/fixtures.ts";

it.effect("schemas reject unsafe paths, names, duplicate destinations, and empty retention", () =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(Job)(fixture);
    for (const input of [
      { ...fixture, name: "../escape" },
      { ...fixture, source: { ...fixture.source, output: "../escape" } },
      {
        ...fixture,
        destinations: [fixture.destinations[0], fixture.destinations[0]],
      },
      {
        ...fixture,
        retention: { daily: 0, weekly: 0, monthly: 0, yearly: 0 },
      },
    ]) {
      const result = yield* Schema.decodeUnknownEffect(Job)(input).pipe(Effect.result);
      yield* assert(Result.isFailure(result), "invalid job must fail at the boundary");
    }
  }),
);

for (const reverse of [false, true]) {
  for (const failed of ["restic", "proton-drive"] as const) {
    it.effect(
      `runner stages once and attempts both destinations when ${failed} fails (reversed: ${reverse})`,
      () =>
        Effect.gen(function* () {
          const job = yield* Schema.decodeUnknownEffect(Job)({
            ...fixture,
            destinations: reverse ? [...fixture.destinations].reverse() : fixture.destinations,
          });
          const stages = yield* Ref.make(0);
          const attempts = yield* Ref.make(HashSet.empty<string>());
          const source = Layer.succeed(
            Sources,
            Sources.of({
              stage: () =>
                Ref.update(stages, (n) => n + 1).pipe(Effect.as(absolutePath("/staging/test-job"))),
            }),
          );
          const destinations = Layer.succeed(
            Destinations,
            Destinations.of({
              run: (_job, destination, request) =>
                Effect.gen(function* () {
                  yield* assert(
                    request.action === "backup" && request.stage === "/staging/test-job",
                    "same stage must reach each destination",
                  );
                  yield* Ref.update(attempts, (set) => HashSet.add(set, destination.type));
                  if (destination.type === failed) {
                    return yield* new BackupError({ message: "offline" });
                  }
                }),
            }),
          );
          const result = yield* execute(job, "backup").pipe(
            Effect.provide(Layer.merge(source, destinations)),
            Effect.result,
          );
          yield* assert(Result.isFailure(result), "partial failure must fail the job");
          yield* assert((yield* Ref.get(stages)) === 1, "source must stage once");
          yield* assert(HashSet.size(yield* Ref.get(attempts)) === 2, "both destinations must run");
        }),
    );
  }
}

it.effect("retention consumes parsed snapshots and keeps newest per UTC period", () =>
  Effect.gen(function* () {
    const job = yield* Schema.decodeEffect(JobName)("test-job");
    const timestamps = [
      "2026-01-01T20:00:00Z",
      "2026-01-01T10:00:00Z",
      "2025-12-31T20:00:00Z",
      "2025-12-20T20:00:00Z",
    ];
    const names = timestamps.map((time) => archiveName(job, DateTime.makeUnsafe(time)));
    const files = HashSet.fromIterable(names.flatMap((name) => [name, `${name}.sha256`]));
    const snapshots = yield* parseSnapshotPairs(job, files);
    const expired = expiredSnapshots(snapshots, {
      daily: 1,
      weekly: 2,
      monthly: 0,
      yearly: 0,
    });
    yield* assert(HashSet.size(expired) === 2, "same day and same ISO week copies should expire");
    yield* assert(
      !HashSet.has(expired, archiveName(job, DateTime.makeUnsafe(timestamps[0]!))),
      "newest must survive",
    );
    const missing = yield* parseSnapshotPairs(job, HashSet.fromIterable(names)).pipe(Effect.result);
    yield* assert(Result.isFailure(missing), "retention must reject incomplete pairs");
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
      const snapshots = Array.from({ length: 20 }, (_, n) => {
        const time = DateTime.add(start, { [test.unit]: n * test.step });
        return { name: archiveName(job, time), time };
      });
      const policy = {
        daily: 0,
        weekly: 0,
        monthly: 0,
        yearly: 0,
        [test.policy]: test.count,
      };
      yield* assert(
        HashSet.size(expiredSnapshots(snapshots, policy)) === 20 - test.count,
        `${test.policy} count is wrong`,
      );
    }
  }),
);
