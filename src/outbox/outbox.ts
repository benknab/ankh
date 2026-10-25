import { Array, type Cause, Context, Effect, Layer, Queue, Result, Stream } from "effect";
import { ArchiveClient } from "#clients/archive.ts";
import type { Archive } from "#domain/archive.ts";
import {
  type AbsolutePath,
  BackupError,
  backupError,
  type Job,
  type Proton,
} from "#domain/model.ts";
import { acknowledge, list } from "#outbox/files.ts";
import { enqueue } from "#outbox/publish.ts";
import type { Storage } from "#storage/storage.ts";

const deliver = Effect.fn("Outbox.deliver")(function* (
  archive: Archive,
  upload: (archive: Archive) => Effect.Effect<void, BackupError>,
) {
  yield* (yield* ArchiveClient).verify(archive);
  yield* upload(archive);
  yield* acknowledge(archive);
});

const drain = Effect.fn("Outbox.drain")(function* (
  job: Job,
  destination: Proton,
  upload: (archive: Archive) => Effect.Effect<void, BackupError>,
) {
  const queue = yield* Queue.make<Archive, Cause.Done>();
  yield* Effect.addFinalizer(() => Queue.shutdown(queue));
  yield* Queue.offerAll(queue, yield* list(job, destination));
  yield* Queue.end(queue);
  const failures: string[] = [];
  yield* Stream.fromQueue(queue).pipe(
    Stream.runForEach(
      Effect.fn("Outbox.attempt")(function* (archive) {
        const result = yield* deliver(archive, upload).pipe(Effect.result);
        if (Result.isFailure(result)) {
          failures.push(`${archive.name}: ${String(result.failure)}`);
        }
      }),
    ),
  );
  if (failures.length > 0) {
    return yield* BackupError.make({ message: Array.join(failures, "; ") });
  }
}, Effect.scoped);

const check = Effect.fn("Outbox.check")(function* (job: Job, destination: Proton) {
  const client = yield* ArchiveClient;
  yield* Effect.forEach(yield* list(job, destination), client.verify, { discard: true });
});

export class Outbox extends Context.Service<
  Outbox,
  {
    readonly enqueue: (
      job: Job,
      destination: Proton,
      stage: AbsolutePath,
    ) => Effect.Effect<void, BackupError>;
    readonly drain: (
      job: Job,
      destination: Proton,
      upload: (archive: Archive) => Effect.Effect<void, BackupError>,
    ) => Effect.Effect<void, BackupError>;
    readonly check: (job: Job, destination: Proton) => Effect.Effect<void, BackupError>;
  }
>()("backup-runner/outbox/outbox") {
  public static readonly layer = Layer.effect(
    Outbox,
    Effect.gen(function* () {
      const context = yield* Effect.context<ArchiveClient | Storage>();
      const provide = <A, E>(
        effect: Effect.Effect<A, E, ArchiveClient | Storage>,
      ): Effect.Effect<A, BackupError> =>
        effect.pipe(Effect.provide(context), Effect.mapError(backupError("Outbox")));
      return Outbox.of({
        enqueue: (job, destination, stage) => provide(enqueue(job, destination, stage)),
        drain: (job, destination, upload) => provide(drain(job, destination, upload)),
        check: (job, destination) => provide(check(job, destination)),
      });
    }),
  ).pipe(Layer.provide(ArchiveClient.layer));
}
