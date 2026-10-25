import { type Cron, Effect, Schedule } from "effect";
import type { AbsolutePath, JobSchedule } from "#/domain/model.ts";
import { runJob } from "#/app/runner.ts";
import { loadJob } from "#/storage/storage.ts";
import { describeJob, track, withExecution } from "#/telemetry/execution.ts";

export const scheduledAttempts = <E, R>(
  backup: Effect.Effect<void, E, R>,
  schedule: JobSchedule,
): Effect.Effect<void, Cron.CronParseError, R> =>
  backup.pipe(
    Effect.ignore,
    Effect.schedule(Schedule.cron(schedule.cron, schedule.timeZone)),
    Effect.asVoid,
  );

export const serve = Effect.fn("Scheduler.serve")(function* (file: AbsolutePath) {
  const job = yield* withExecution(
    "schedule",
    track("configuration", loadJob(file)).pipe(Effect.tap(describeJob)),
  );
  const { schedule } = job;
  yield* Effect.logDebug("Backup scheduler ready", {
    job: job.name,
    ...schedule,
  });
  yield* scheduledAttempts(runJob(file, "backup"), schedule);
});
