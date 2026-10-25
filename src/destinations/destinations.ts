import { Context, Effect, Layer } from "effect";
import type { BackupError, Destination, DestinationRequest, Job } from "#domain/model.ts";
import { Outbox } from "#outbox/outbox.ts";
import { ProtonDrive } from "#clients/proton/client.ts";
import { ResticClient } from "#clients/restic.ts";
import { protonAdapter } from "#destinations/proton.ts";
import { resticAdapter } from "#destinations/restic.ts";
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
>()("ankh/destinations/destinations") {
  public static readonly layer = Layer.effect(
    Destinations,
    Effect.gen(function* () {
      const context = (yield* Effect.context<ResticClient | Storage | Outbox | ProtonDrive>()).pipe(
        Context.pick(ResticClient, Storage, Outbox, ProtonDrive),
      );
      const run = Effect.fn("Destinations.run")(function* (
        job: Job,
        destination: Destination,
        request: DestinationRequest,
      ) {
        switch (destination.type) {
          case "restic":
            return yield* resticAdapter.run(job, destination, request);
          case "proton-drive":
            return yield* protonAdapter.run(job, destination, request);
        }
      }, Effect.provide(context));
      return Destinations.of({ run });
    }),
  ).pipe(Layer.provide(ResticClient.layer));
}
