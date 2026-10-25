import { Effect } from "effect";
import {
  backupError,
  BackupError,
  type DestinationRequest,
  type Job,
  type Proton,
} from "#domain/model.ts";
import { Outbox } from "#outbox/outbox.ts";
import { ProtonDrive } from "#clients/proton/client.ts";
import { retainProton } from "#destinations/proton-retention.ts";
import { parseSnapshotPairs } from "#domain/retention.ts";

export const runProton = Effect.fn("Proton.run")(function* (
  job: Job,
  destination: Proton,
  request: DestinationRequest,
) {
  const { action } = request;
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
    const snapshots = yield* parseSnapshotPairs(job.name, yield* proton.list(destination));
    if (snapshots.length === 0) {
      return yield* new BackupError({ message: "No complete Proton snapshots found" });
    }
    yield* Effect.logInfo(
      `Checked ${snapshots.length} remote pairs; use a downloaded restore to check Proton file contents`,
    );
  }
});

export const protonAdapter = {
  run: Effect.fn("Proton.adapter")((job: Job, destination: Proton, request: DestinationRequest) =>
    runProton(job, destination, request).pipe(Effect.mapError(backupError("Proton destination"))),
  ),
};
