import { Context, Effect, Layer } from "effect";
import {
  backupError,
  type BackupError,
  type Destination,
  type DestinationRequest,
  type Job,
} from "#domain/model.ts";
import { Commands } from "#process/commands.ts";
import { Outbox } from "#outbox/outbox.ts";
import { ProtonDrive } from "#clients/proton/client.ts";
import { runProton } from "#destinations/proton.ts";
import { runRestic } from "#destinations/restic.ts";
import { Storage } from "#storage/storage.ts";

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
      const run = Effect.fn("Destinations.run")(
        function* (job: Job, destination: Destination, request: DestinationRequest) {
          return yield* destination.type === "restic"
            ? runRestic(job, destination, request)
            : runProton(job, destination, request);
        },
        Effect.provide(context),
        Effect.mapError(backupError("Destination")),
      );
      return Destinations.of({ run });
    }),
  );
}
