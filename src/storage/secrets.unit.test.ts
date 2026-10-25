import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Redacted, Result, Schema } from "effect";
import { absolutePath, backupError } from "#domain/model.ts";
import { readSecret, Secret } from "#storage/secrets.ts";
import { Storage } from "#storage/storage.ts";

it.effect("secret reads preserve password whitespace and hide invalid input", () =>
  Effect.gen(function* () {
    const storage = Storage.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({ readFileString: () => Effect.succeed("  password  \r\n") }),
          Path.layer,
        ),
      ),
    );
    const secret = yield* readSecret(absolutePath("/secret"), "line-ending").pipe(
      Effect.provide(storage),
    );
    expect(Redacted.value(secret)).toBe("  password  ");
    expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(secret)).not.toContain(
      "password",
    );
    const invalid = yield* Schema.decodeEffect(Secret, { reportInput: true })(
      Redacted.make("password\0"),
    ).pipe(Effect.result);
    expect(Result.isFailure(invalid)).toBe(true);
    if (Result.isFailure(invalid)) {
      expect(String(invalid.failure)).not.toContain("password");
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          backupError("Secret")(invalid.failure),
        ),
      ).not.toContain("password");
    }
    const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(Secret))(secret).pipe(
      Effect.result,
    );
    expect(Result.isFailure(encoded)).toBe(true);
  }),
);
