import { Effect, Schedule } from "effect";
import { type AbsolutePath } from "./model.ts";
import { runJob } from "./runner.ts";
import { loadJob } from "./storage.ts";

export const dailySchedule = Schedule.cron("30 3 * * *", "UTC");

export const scheduledAttempts = <E, R>(backup: Effect.Effect<void, E, R>) =>
  backup.pipe(
    Effect.tap(() => Effect.logInfo("Scheduled backup completed")),
    Effect.catch((error) =>
      Effect.logError(
        "Scheduled backup failed; pending uploads remain queued",
        error,
      )
    ),
    Effect.schedule(dailySchedule),
  );

export const serve = Effect.fn("Scheduler.serve")(
  function* (file: AbsolutePath) {
    const job = yield* loadJob(file);
    yield* Effect.logInfo("Backup scheduler ready", {
      job: job.name,
      cron: "30 3 * * *",
      timeZone: "UTC",
    });
    yield* scheduledAttempts(runJob(file, "backup"));
  },
);
