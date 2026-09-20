import { DateTime, Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import { BackupError } from "./src/model.ts";
import { scheduledAttempts } from "./src/scheduler.ts";
import { assert } from "./test-support.ts";

for (
  const [season, utcHour] of [["2026-09-20", "03"], [
    "2026-12-20",
    "03",
  ]] as const
) {
  Deno.test(`Effect scheduler runs at 03:30 UTC on ${season} and survives failure`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const before = DateTime.toEpochMillis(
          DateTime.makeUnsafe(`${season}T${utcHour}:29:00Z`),
        );
        yield* TestClock.setTime(before);
        const attempts = yield* Ref.make(0);
        const backup = Ref.updateAndGet(attempts, (n) => n + 1).pipe(
          Effect.flatMap((n) =>
            n === 1
              ? Effect.fail(new BackupError({ message: "offline" }))
              : Effect.void
          ),
        );
        const fiber = yield* Effect.forkChild(scheduledAttempts(backup));
        yield* TestClock.adjust("59 seconds");
        yield* assert(
          (yield* Ref.get(attempts)) === 0,
          "must wait for scheduled time, not run on startup",
        );
        yield* TestClock.adjust("1 second");
        yield* assert(
          (yield* Ref.get(attempts)) === 1,
          "must run at 03:30 local time",
        );
        yield* TestClock.adjust("24 hours");
        yield* assert(
          (yield* Ref.get(attempts)) === 2,
          "a failed job must not stop the next day's schedule",
        );
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    ));
}
