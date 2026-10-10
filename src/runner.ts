import { Effect, Result } from "effect";
import { Destinations } from "./destinations.ts";
import {
  type AbsolutePath,
  type Action,
  BackupError,
  type DestinationRequest,
  type Job,
} from "./model.ts";
import { Sources } from "./sources.ts";
import { checkDrive, loadJob, withLock } from "./storage.ts";

export const execute = Effect.fn("Runner.execute")(function* (job: Job, action: Action) {
  const destinations = yield* Destinations;
  const request: DestinationRequest =
    action === "backup" ? { action, stage: yield* (yield* Sources).stage(job) } : { action };
  const outcomes = yield* Effect.forEach(job.destinations, (destination) =>
    destinations.run(job, destination, request).pipe(
      Effect.annotateLogs({ job: job.name, destination: destination.type }),
      Effect.mapError((error) => `${destination.type}: ${error.message}`),
      Effect.result,
    ),
  );
  const failures = outcomes.filter(Result.isFailure).map((result) => result.failure);
  if (failures.length > 0) {
    return yield* new BackupError({ message: failures.join("; ") });
  }
});

export const runJob = Effect.fn("Runner.runJob")(function* (file: AbsolutePath, action: Action) {
  const job = yield* loadJob(file);
  yield* checkDrive(job);
  yield* withLock(job);
  yield* execute(job, action);
}, Effect.scoped);
