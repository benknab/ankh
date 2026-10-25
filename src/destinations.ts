import { Context, Effect, Layer } from "effect";
import { BackupError, type Destination, type DestinationRequest, type Job } from "./model.ts";
import { Commands } from "./commands.ts";
import { Outbox } from "./outbox.ts";
import { ProtonDrive } from "./proton.ts";
import { snapshotNames } from "./retention.ts";
import { retainProton } from "./proton-retention.ts";
import { runRestic } from "./restic.ts";
import { Storage } from "./storage.ts";

const run = Effect.fn("Destinations.run")(function* (
  job: Job,
  destination: Destination,
  request: DestinationRequest,
) {
  const { action } = request;
  if (destination.type === "restic") {
    return yield* runRestic(job, destination, request);
  }
  const outbox = yield* Outbox;
  const proton = yield* ProtonDrive;
  // Persist before touching the network, including folder discovery.
  if (request.action === "backup") {
    yield* outbox.enqueue(job, destination, request.stage);
  }
  if (action === "init" || action === "backup" || action === "retry") {
    yield* proton.initialize(destination);
  }
  if (action === "backup" || action === "retry") {
    yield* outbox.drain(job, destination, (archive) => proton.upload(destination, archive));
    yield* retainProton(job, destination);
  } else if (action !== "init") {
    yield* outbox.check(job, destination);
    const snapshots = yield* snapshotNames(job.name, yield* proton.list(destination));
    if (snapshots.length === 0) {
      return yield* new BackupError({
        message: "No complete Proton snapshots found",
      });
    }
    yield* Effect.logInfo(
      `Checked ${snapshots.length} remote pairs; use a downloaded restore to check Proton file contents`,
    );
  }
});

export class Destinations extends Context.Service<
  Destinations,
  {
    readonly run: (
      job: Job,
      destination: Destination,
      request: DestinationRequest,
    ) => Effect.Effect<void, BackupError>;
  }
>()("backup-runner/Destinations") {
  static readonly layer = Layer.effect(
    Destinations,
    Effect.gen(function* () {
      const context = yield* Effect.context<Commands | Storage | Outbox | ProtonDrive>();
      return Destinations.of({
        run: (job, destination, request) =>
          run(job, destination, request).pipe(
            Effect.provide(context),
            Effect.mapError((e) => new BackupError({ message: String(e) })),
          ),
      });
    }),
  );
}
