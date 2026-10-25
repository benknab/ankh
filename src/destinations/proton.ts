import { Effect } from "effect";
import type { DestinationAdapter } from "#/domain/adapters.ts";
import {
  BackupError,
  backupError,
  type DestinationRequest,
  type Job,
  type Proton,
} from "#/domain/model.ts";
import { Outbox } from "#/outbox/outbox.ts";
import { ProtonDrive } from "#/clients/proton/client.ts";
import { retainProton } from "#/destinations/proton-retention.ts";
import { parseSnapshotPairs } from "#/domain/retention.ts";
import type { Storage } from "#/storage/storage.ts";
import { track } from "#/telemetry/execution.ts";

const check = Effect.fn("Proton.check")(function* (job: Job, destination: Proton) {
  const outbox = yield* Outbox;
  const proton = yield* ProtonDrive;
  yield* outbox.check(job, destination);
  const snapshots = yield* parseSnapshotPairs(job.name, yield* proton.list(destination));
  if (snapshots.length === 0) {
    return yield* BackupError.make({ message: "No complete Proton snapshots found" });
  }
});

const prepare = Effect.fn("Proton.prepare")(function* (
  job: Job,
  destination: Proton,
  request: DestinationRequest,
) {
  // Persist the archive before any credential or network check can fail.
  if (request.action === "backup") {
    yield* (yield* Outbox).enqueue(job, destination, request.stage);
  }
  yield* track("credentials", (yield* ProtonDrive).verify);
});

export const protonAdapter: DestinationAdapter<Proton, Outbox | ProtonDrive | Storage> = {
  run: Effect.fn("Proton.run")(
    function* (job: Job, destination: Proton, request: DestinationRequest) {
      const outbox = yield* Outbox;
      const proton = yield* ProtonDrive;
      yield* prepare(job, destination, request);
      if (request.action === "check" || request.action === "check-read-data") {
        return yield* check(job, destination);
      }
      yield* proton.initialize(destination);
      if (request.action !== "init") {
        yield* outbox.drain(job, destination, (archive) => proton.upload(destination, archive));
        yield* track("retention", retainProton(job, destination));
      }
    },
    Effect.mapError(backupError("Proton destination")),
    // Messages are written by Ankh and never include tool output, so they can name the fix.
    Effect.tapError((error) => Effect.logWarning(error.message)),
  ),
};
