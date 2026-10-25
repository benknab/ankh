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
import { describeJob, track, withExecution } from "#telemetry/execution.ts";

export const execute = Effect.fn("Runner.execute")(function* (job: Job, action: Action) {
  const destinations = yield* Destinations;
  const request: DestinationRequest =
    action === "backup"
      ? { action, stage: yield* track("source", (yield* Sources).stage(job)) }
      : { action };
  const outcomes = yield* Effect.forEach(job.destinations, (destination) =>
    track(
      destination.type === "restic" ? "restic" : "proton-drive",
      destinations.run(job, destination, request),
    ).pipe(
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

export const runJob = Effect.fn("Runner.runJob")(
  function* (file: AbsolutePath, action: Action) {
    const job = yield* track("configuration", loadJob(file));
    yield* describeJob(job);
    yield* track("drive", checkDrive(job));
    const { release } = yield* track("lock", withLock(job));
    yield* execute(job, action).pipe(Effect.onExit(() => track("cleanup", release)));
  },
  Effect.scoped,
  (effect, _file, action) => withExecution(action, effect),
);

export const validate = Effect.fn("Runner.validate")((file: AbsolutePath) =>
  withExecution("validate", track("configuration", loadJob(file)).pipe(Effect.tap(describeJob))),
);
