import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Logger, Path, Ref, Schema } from "effect";
import { ProtonDrive } from "#/clients/proton/client.ts";
import { protonAdapter } from "#/destinations/proton.ts";
import { absolutePath, BackupError, Job, Proton } from "#/domain/model.ts";
import { Outbox } from "#/outbox/outbox.ts";
import { Storage } from "#/storage/storage.ts";
import { withExecution } from "#/telemetry/execution.ts";
import { fixture } from "#/testing/fixtures.ts";

it.effect("Proton credential failures keep the archive and report a fixed reason", () =>
  Effect.gen(function* () {
    const job = yield* Schema.decodeUnknownEffect(Job)(fixture);
    const destination = yield* Schema.decodeUnknownEffect(Proton)(fixture.destinations[1]);
    const calls = yield* Ref.make<readonly string[]>([]);
    const record = (name: string): Effect.Effect<void> =>
      Ref.update(calls, (all) => [...all, name]);
    const reason = "Proton is not logged in or the session was revoked; run proton-login";
    const messages: unknown[] = [];
    const logger = Logger.make(({ message }: Logger.Options<unknown>): void => {
      messages.push(message);
    });
    const services = Layer.mergeAll(
      Layer.succeed(
        Outbox,
        Outbox.of({
          enqueue: () => record("enqueue"),
          drain: () => Effect.die("must not drain without credentials"),
          check: () => Effect.die("must not check without credentials"),
        }),
      ),
      Layer.succeed(
        ProtonDrive,
        ProtonDrive.of({
          verify: record("verify").pipe(Effect.andThen(BackupError.make({ message: reason }))),
          initialize: () => Effect.die("must not reach Proton without credentials"),
          list: () => Effect.die("must not list without credentials"),
          upload: () => Effect.die("must not upload without credentials"),
          trash: () => Effect.die("must not trash without credentials"),
        }),
      ),
      Storage.layer.pipe(Layer.provide(Layer.merge(Path.layer, FileSystem.layerNoop({})))),
      Logger.layer([logger]),
    );
    const result = yield* withExecution(
      "backup",
      protonAdapter.run(job, destination, {
        action: "backup",
        stage: absolutePath("/staging/test-job"),
      }),
    ).pipe(Effect.provide(services), Effect.flip);
    expect(result.message).toBe(reason);
    expect(yield* Ref.get(calls), "the archive must be persisted before the check").toEqual([
      "enqueue",
      "verify",
    ]);
    expect(messages).toMatchObject([
      [
        {
          event: "execution.completed",
          steps: { credentials: { failures: 1 } },
          messages: [{ text: reason }],
        },
      ],
    ]);
  }),
);
