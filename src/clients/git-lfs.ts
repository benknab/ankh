import { Effect, Redacted, Schema } from "effect";
import { Commands, type Options } from "#/process/commands.ts";

const Revisions = Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/u)));

export const verifyLfs = Effect.fn("GitClient.verifyLfs")(function* (
  mirror: string,
  options: Options,
) {
  const commands = yield* Commands;
  const result = yield* commands.run("git", ["-C", mirror, "rev-list", "--all"], {
    ...options,
    output: "capture",
  });
  const text = Redacted.value(result.stdout).trim();
  const revisions = yield* Schema.decodeEffect(Revisions)(text === "" ? [] : text.split("\n"));
  // LFS fsck checks one revision or range, not all refs. Include historical objects.
  yield* Effect.forEach(
    revisions,
    (revision) =>
      commands.run(
        "git",
        ["-C", mirror, "-c", "lfs.fetchexclude=", "lfs", "fsck", "--objects", revision],
        options,
      ),
    { discard: true },
  );
});
