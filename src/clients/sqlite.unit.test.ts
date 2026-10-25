import { expect, it } from "@effect/vitest";
import { Effect, Layer, Ref, Result } from "effect";
import { SqliteClient } from "#/clients/sqlite.ts";
import { absolutePath } from "#/domain/model.ts";
import { Commands } from "#/process/commands.ts";
import { output } from "#/testing/commands.ts";

it.effect("SQLite rejects a successful process with a failed integrity check", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const commands = Commands.of({
      run: () => Ref.update(calls, (n) => n + 1).pipe(Effect.as(output("database corruption"))),
    });
    const layer = SqliteClient.layer.pipe(Layer.provide(Layer.succeed(Commands, commands)));
    const result = yield* Effect.gen(function* () {
      yield* (yield* SqliteClient).backup(absolutePath("/source/test.db"), "/stage/test.db");
    }).pipe(Effect.provide(layer), Effect.result);
    expect(yield* Ref.get(calls)).toBe(2);
    expect(Result.isFailure(result)).toBe(true);
  }),
);
