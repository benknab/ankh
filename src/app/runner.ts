import { Array, Effect, Result } from "effect";
import { Destinations } from "#destinations/destinations.ts";
import {
  type AbsolutePath,
  type Action,
  BackupError,
  type DestinationRequest,
  type Job,
} from "#domain/model.ts";
import { Sources } from "#sources/sources.ts";
import { checkDrive, loadJob, withLock } from "#storage/storage.ts";

export const execute = Effect.fn("Runner.execute")(function* (job: Job, action: Action) {
  const destinations = yield* Destinations;
  const request: DestinationRequest =
    action === "backup" ? { action, stage: yield* (yield* Sources).stage(job) } : { action };
  const outcomes = yield* Effect.forEach(job.destinations, (destination) =>
    destinations.run(job, destination, request).pipe(
      Effect.annotateLogs({ job: job.name, destination: destination.type }),
      Effect.mapError((error) => ({ destination: destination.type, error })),
      Effect.result,
    ),
  );
  const failures = Array.map(Array.filter(outcomes, Result.isFailure), (result) => result.failure);
  if (failures.length > 0) {
    return yield* BackupError.make({
      message: Array.join(
        Array.map(failures, ({ destination, error }) => `${destination}: ${error.message}`),
        "; ",
      ),
      operation: "Destinations",
      cause: failures,
    });
  }
});

export const runJob = Effect.fn("Runner.runJob")(function* (file: AbsolutePath, action: Action) {
  const job = yield* loadJob(file);
  yield* checkDrive(job);
  const { release } = yield* withLock(job);
  yield* execute(job, action).pipe(Effect.onExit(() => release));
}, Effect.scoped);
