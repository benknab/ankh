import { Context, Effect, Layer } from "effect";
import {
  backupError,
  type BackupError,
  type Destination,
  type DestinationRequest,
  type Job,
} from "./model.ts";
import { Commands } from "./commands.ts";
import { Outbox } from "./outbox.ts";
import { ProtonDrive } from "./proton.ts";
import { runProton } from "./proton-destination.ts";
import { runRestic } from "./restic.ts";
import { Storage } from "./storage.ts";

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
