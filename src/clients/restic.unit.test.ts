import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Logger, Path, Schema } from "effect";
import { ResticClient } from "#clients/restic.ts";
import { Restic } from "#domain/model.ts";
import { Commands } from "#process/commands.ts";
import { Storage } from "#storage/storage.ts";
import { withExecution } from "#telemetry/execution.ts";
import { output } from "#testing/commands.ts";
import { fixture } from "#testing/fixtures.ts";

it.effect("clients built before a run preserve its dynamic logging context", () =>
  Effect.gen(function* () {
    const messages: unknown[] = [];
    const logger = Logger.make(({ message }: Logger.Options<unknown>): void => {
      messages.push(message);
    });
    const commands = Layer.succeed(
      Commands,
      Commands.of({
        run: () => Effect.logInfo("checked", { verified: true }).pipe(Effect.as(output(""))),
      }),
    );
    const storage = Storage.layer.pipe(
      Layer.provide(
        Layer.merge(
          Path.layer,
          FileSystem.layerNoop({ readFileString: () => Effect.succeed("test-password") }),
        ),
      ),
    );
    const layer = ResticClient.layer.pipe(
      Layer.provide(Layer.merge(commands, storage)),
      Layer.provideMerge(Logger.layer([logger])),
    );
    yield* Effect.gen(function* () {
      const client = yield* ResticClient;
      const destination = yield* Schema.decodeUnknownEffect(Restic)(fixture.destinations[0]);
      yield* withExecution("check", client.check(destination, false));
    }).pipe(Effect.provide(layer));
    expect(messages).toHaveLength(1);
    expect(messages).toMatchObject([
      [{ event: "execution.completed", data: { verified: true }, messages: [{ text: "checked" }] }],
    ]);
  }),
);
