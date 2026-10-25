import { Effect, Redacted, Schema } from "effect";
import type { AbsolutePath } from "#/domain/model.ts";
import { Storage } from "#/storage/storage.ts";

export const Secret = Schema.Redacted(Schema.NonEmptyString.check(Schema.isPattern(/^[^\0]+$/u)), {
  disallowJsonEncode: true,
});

export const readSecret = Effect.fn("readSecret")(function* (
  file: AbsolutePath,
  trim: "whitespace" | "line-ending" = "whitespace",
) {
  const { fs } = yield* Storage;
  const secret = yield* fs
    .readFileString(file)
    .pipe(
      Effect.map((text) =>
        Redacted.make(trim === "whitespace" ? text.trim() : text.replace(/\r?\n$/u, "")),
      ),
    );
  return yield* Schema.decodeEffect(Secret)(secret);
});
