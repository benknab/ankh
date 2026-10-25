import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Logger, Path, Schema } from "effect";
import { ProtonDrive } from "#clients/proton/client.ts";
import { protonAdapter } from "#destinations/proton.ts";
import { BackupError, Job, Proton } from "#domain/model.ts";
import { Outbox } from "#outbox/outbox.ts";
import { Storage } from "#storage/storage.ts";
import { withExecution } from "#telemetry/execution.ts";
import { fixture } from "#testing/fixtures.ts";

it.effect("Proton destination failures report a fixed reason in the run log", () =>
  Effect.gen(function* () {
    const job = yield* Schema.decodeUnknownEffect(Job)(fixture);
    const destination = yield* Schema.decodeUnknownEffect(Proton)(fixture.destinations[1]);
    const reason = "Proton is not logged in or the session was revoked; run proton-login";
    const messages: unknown[] = [];
    const logger = Logger.make(({ message }: Logger.Options<unknown>): void => {
      messages.push(message);
    });
    const services = Layer.mergeAll(
      Layer.succeed(
        Outbox,
        Outbox.of({
          enqueue: () => Effect.die("init must not enqueue"),
          drain: () => Effect.die("init must not drain"),
          check: () => Effect.die("init must not check"),
        }),
      ),
      Layer.succeed(
        ProtonDrive,
        ProtonDrive.of({
          initialize: () => BackupError.make({ message: reason }),
          list: () => Effect.die("must not list after a failure"),
          upload: () => Effect.die("must not upload after a failure"),
          trash: () => Effect.die("must not trash after a failure"),
        }),
      ),
      Storage.layer.pipe(Layer.provide(Layer.merge(Path.layer, FileSystem.layerNoop({})))),
      Logger.layer([logger]),
    );
    const result = yield* withExecution(
      "init",
      protonAdapter.run(job, destination, { action: "init" }),
    ).pipe(Effect.provide(services), Effect.flip);
    expect(result.message).toBe(reason);
    expect(messages).toMatchObject([
      [{ event: "execution.completed", messages: [{ text: reason }] }],
    ]);
  }),
);
