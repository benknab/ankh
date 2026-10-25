import { expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { GitClient } from "#clients/git.ts";
import { absolutePath } from "#domain/model.ts";
import { Commands } from "#process/commands.ts";
import { Storage } from "#storage/storage.ts";
import { infrastructure } from "#testing/infrastructure.ts";

it.live("an existing mirror switches to the requested origin", () =>
  Effect.gen(function* () {
    const { fs, path } = yield* Storage;
    const commands = yield* Commands;
    const client = yield* GitClient;
    const root = yield* fs.makeTempDirectoryScoped();
    const mirror = path.join(root, "mirror.git");
    for (const name of ["first", "second"]) {
      const origin = path.join(root, name);
      yield* commands.run("git", ["init", "--initial-branch=main", origin]);
      yield* fs.writeFileString(path.join(origin, "value"), name);
      yield* commands.run("git", ["-C", origin, "add", "."]);
      yield* commands.run("git", [
        "-C",
        origin,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        name,
      ]);
      yield* client.mirror({
        url: origin,
        mirror,
        tokenFile: absolutePath(path.join(root, "token")),
      });
      const result = yield* commands.run("git", ["-C", mirror, "show", "refs/heads/main:value"]);
      expect(Redacted.value(result.stdout)).toBe(name);
    }
  }).pipe(Effect.provide(GitClient.layer.pipe(Layer.provideMerge(infrastructure)))),
);
