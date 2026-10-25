import { it } from "@effect/vitest";
import { DateTime, Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import { BackupError } from "../domain/model.ts";
import { scheduledAttempts } from "./scheduler.ts";
import { assert } from "../testing/fixtures.ts";

for (const [season, utcHour] of [
  ["2026-09-20", "03"],
  ["2026-12-20", "03"],
] as const) {
  it.effect(`Effect scheduler runs at 03:30 UTC on ${season} and survives failure`, () =>
    Effect.gen(function* () {
      const before = DateTime.toEpochMillis(DateTime.makeUnsafe(`${season}T${utcHour}:29:00Z`));
      yield* TestClock.setTime(before);
      const attempts = yield* Ref.make(0);
      const backup = Ref.updateAndGet(attempts, (n) => n + 1).pipe(
        Effect.flatMap((n) =>
          n === 1 ? Effect.fail(new BackupError({ message: "offline" })) : Effect.void,
        ),
      );
      const fiber = yield* Effect.forkChild(scheduledAttempts(backup));
      yield* TestClock.adjust("59 seconds");
      yield* assert(
        (yield* Ref.get(attempts)) === 0,
        "must wait for scheduled time, not run on startup",
      );
      yield* TestClock.adjust("1 second");
      yield* assert((yield* Ref.get(attempts)) === 1, "must run at 03:30 local time");
      yield* TestClock.adjust("24 hours");
      yield* assert(
        (yield* Ref.get(attempts)) === 2,
        "a failed job must not stop the next day's schedule",
      );
      yield* Fiber.interrupt(fiber);
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
      yield* assert((yield* Ref.get(attempts)) === 1, "first local run must occur");
      yield* TestClock.adjust(nextDayHours * 60 * 60 * 1000 - 1);
      yield* assert((yield* Ref.get(attempts)) === 1, "must wait for the next local run");
      yield* TestClock.adjust(1);
      yield* assert((yield* Ref.get(attempts)) === 2, "DST must preserve local scheduled time");
      yield* Fiber.interrupt(fiber);
    }),
  );
}
