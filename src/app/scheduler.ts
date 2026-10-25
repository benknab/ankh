import { type Cron, Effect, Schedule } from "effect";
import { type AbsolutePath, defaultSchedule, type JobSchedule } from "#domain/model.ts";
import { runJob } from "#app/runner.ts";
import { loadJob } from "#storage/storage.ts";

export const scheduledAttempts = <E, R>(
  backup: Effect.Effect<void, E, R>,
  schedule: JobSchedule = defaultSchedule,
): Effect.Effect<void, Cron.CronParseError, R> =>
  backup.pipe(
    Effect.ignore,
    Effect.schedule(Schedule.cron(schedule.cron, schedule.timeZone)),
    Effect.asVoid,
  );

export const serve = Effect.fn("Scheduler.serve")(function* (file: AbsolutePath) {
  const job = yield* loadJob(file);
  const schedule = job.schedule ?? defaultSchedule;
  yield* Effect.logDebug("Backup scheduler ready", {
    job: job.name,
    ...schedule,
  });
  yield* scheduledAttempts(runJob(file, "backup"), schedule);
});
