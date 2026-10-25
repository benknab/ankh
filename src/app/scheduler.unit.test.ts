import { expect, it } from "@effect/vitest";
import {
  DateTime,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Path,
  Ref,
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { absolutePath, BackupError } from "#/domain/model.ts";
import { scheduledAttempts, serve } from "#/app/scheduler.ts";
import { Storage } from "#/storage/storage.ts";
import { Sources } from "#/sources/sources.ts";
import { Destinations } from "#/destinations/destinations.ts";

for (const [season, utcHour] of [
  ["2026-09-20", "04"],
  ["2026-12-20", "04"],
] as const) {
  it.effect(
    `Effect scheduler runs at the configured 04:15 UTC on ${season} and survives failure`,
    () =>
      Effect.gen(function* () {
        const before = DateTime.toEpochMillis(DateTime.makeUnsafe(`${season}T${utcHour}:14:00Z`));
        yield* TestClock.setTime(before);
        const attempts = yield* Ref.make(0);
        const backup = Ref.updateAndGet(attempts, (n) => n + 1).pipe(
          Effect.flatMap((n) =>
            n === 1 ? Effect.fail(BackupError.make({ message: "offline" })) : Effect.void,
          ),
        );
        const fiber = yield* Effect.forkChild(
          scheduledAttempts(backup, { cron: "15 4 * * *", timeZone: "UTC" }),
        );
        yield* TestClock.adjust("59 seconds");
        expect(yield* Ref.get(attempts), "must wait for scheduled time, not run on startup").toBe(
          0,
        );
        yield* TestClock.adjust("1 second");
        expect(yield* Ref.get(attempts), "must run at the configured time").toBe(1);
        yield* TestClock.adjust("24 hours");
        expect(yield* Ref.get(attempts), "a failed job must not stop the next day's schedule").toBe(
          2,
        );
        yield* Fiber.interrupt(fiber);
      }),
  );
}

for (const missing of [true, false]) {
  it.effect(
    `scheduler emits a safe startup failure for ${missing ? "missing" : "invalid"} config`,
    () =>
      Effect.gen(function* () {
        const messages: unknown[] = [];
        const storage = Storage.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Path.layer,
              FileSystem.layerNoop(
                missing
                  ? {}
                  : {
                      readFileString: (): Effect.Effect<string> =>
                        Effect.succeed('{"secret":"must-not-escape"}'),
                    },
              ),
            ),
          ),
        );
        const result = yield* serve(absolutePath("/missing-must-not-escape.json")).pipe(
          Effect.provideService(Sources, Sources.of({ stage: () => Effect.die("must not stage") })),
          Effect.provideService(
            Destinations,
            Destinations.of({ run: () => Effect.die("must not back up") }),
          ),
          Effect.provide(
            Layer.merge(
              storage,
              Logger.layer([
                Logger.make(({ message }): void => {
                  messages.push(message);
                }),
              ]),
            ),
          ),
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(messages).toMatchObject([
          [{ operation: "schedule", status: "failure", steps: { configuration: { failures: 1 } } }],
        ]);
        expect(messages).toHaveLength(1);
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(messages),
        ).not.toContain("must-not-escape");
      }),
  );
}

for (const [before, nextDayHours] of [
  ["2026-03-28T02:29:00Z", 23],
  ["2026-10-24T01:29:00Z", 25],
] as const) {
  it.effect(`configured scheduler follows DST after ${before}`, () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(before)));
      const attempts = yield* Ref.make(0);
      const fiber = yield* Effect.forkChild(
        scheduledAttempts(
          Ref.update(attempts, (n) => n + 1),
          { cron: "30 3 * * *", timeZone: "Europe/Paris" },
        ),
      );
      yield* TestClock.adjust("1 minute");
      expect(yield* Ref.get(attempts), "first local run must occur").toBe(1);
      yield* TestClock.adjust(nextDayHours * 60 * 60 * 1000 - 1);
      expect(yield* Ref.get(attempts), "must wait for the next local run").toBe(1);
      yield* TestClock.adjust(1);
      expect(yield* Ref.get(attempts), "DST must preserve local scheduled time").toBe(2);
      yield* Fiber.interrupt(fiber);
    }),
  );
}
