import { Effect } from "effect";
import { type AbsolutePath } from "../model.ts";
import { privateDirectory, Storage } from "../storage.ts";

export const freshStage = Effect.fn("Sources.freshStage")(function* (directory: AbsolutePath) {
  const { fs } = yield* Storage;
  yield* fs.remove(directory, { recursive: true, force: true });
  yield* privateDirectory(directory);
});
