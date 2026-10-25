import { Effect } from "effect";
import type { DestinationAdapter } from "#domain/adapters.ts";
import {
  BackupError,
  backupError,
  type DestinationRequest,
  type Job,
  type Proton,
} from "#domain/model.ts";
import { Outbox } from "#outbox/outbox.ts";
import { ProtonDrive } from "#clients/proton/client.ts";
import { retainProton } from "#destinations/proton-retention.ts";
import { parseSnapshotPairs } from "#domain/retention.ts";
import type { Storage } from "#storage/storage.ts";
import { track } from "#telemetry/execution.ts";

const check = Effect.fn("Proton.check")(function* (job: Job, destination: Proton) {
  const outbox = yield* Outbox;
  const proton = yield* ProtonDrive;
  yield* outbox.check(job, destination);
  const snapshots = yield* parseSnapshotPairs(job.name, yield* proton.list(destination));
  if (snapshots.length === 0) {
    return yield* BackupError.make({ message: "No complete Proton snapshots found" });
  }
});

export const protonAdapter: DestinationAdapter<Proton, Outbox | ProtonDrive | Storage> = {
  run: Effect.fn("Proton.run")(
    function* (job: Job, destination: Proton, request: DestinationRequest) {
      const outbox = yield* Outbox;
      const proton = yield* ProtonDrive;
      if (request.action === "check" || request.action === "check-read-data") {
        return yield* check(job, destination);
      }
      // Persist the archive before any network request.
      if (request.action === "backup") {
        yield* outbox.enqueue(job, destination, request.stage);
      }
      yield* proton.initialize(destination);
      if (request.action !== "init") {
        yield* outbox.drain(job, destination, (archive) => proton.upload(destination, archive));
        yield* track("retention", retainProton(job, destination));
      }
    },
    Effect.mapError(backupError("Proton destination")),
  ),
};
