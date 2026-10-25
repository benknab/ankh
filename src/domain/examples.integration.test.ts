import { it } from "@effect/vitest";
import { Effect } from "effect";
import { absolutePath } from "#/domain/model.ts";
import { loadJob, Storage } from "#/storage/storage.ts";
import { infrastructure } from "#/testing/infrastructure.ts";

it.live("all public job examples pass the runtime decoder", () =>
  Effect.gen(function* () {
    const { fs, path } = yield* Storage;
    const root = path.join(import.meta.dirname, "..", "..", "examples");
    for (const file of yield* fs.readDirectory(root)) {
      if (file.endsWith(".job.json")) {
        yield* loadJob(absolutePath(path.join(root, file)));
      }
    }
  }).pipe(Effect.provide(infrastructure)),
);
