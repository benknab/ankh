import { Array, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { type AbsolutePath, backupError, type BackupError } from "#domain/model.ts";
import { Commands, type Options } from "#process/commands.ts";
import { privateDirectory, Storage } from "#storage/storage.ts";
import { verifyLfs } from "#clients/git-lfs.ts";
import { gitOptions } from "#clients/git-auth.ts";

export interface GitRepository {
  readonly url: string;
  readonly mirror: string;
  readonly tokenFile: AbsolutePath;
}

const syncHead = Effect.fn("GitClient.syncHead")(function* (
  repository: GitRepository,
  options: Options,
) {
  const commands = yield* Commands;
  const result = yield* commands.run(
    "git",
    ["-C", repository.mirror, "ls-remote", "--symref", "origin", "HEAD"],
    options,
  );
  const row = Array.findFirst(Redacted.value(result.stdout).split("\n"), (line) =>
    line.startsWith("ref: "),
  );
  if (Option.isSome(row)) {
    const ref = yield* Schema.decodeUnknownEffect(
      Schema.String.check(Schema.isPattern(/^refs\/heads\/[^\s]+$/u)),
    )(row.value.slice(5).split("\t")[0]);
    yield* commands.run("git", ["-C", repository.mirror, "symbolic-ref", "HEAD", ref], options);
  }
});

export class GitClient extends Context.Service<
  GitClient,
  {
    readonly mirror: (repository: GitRepository) => Effect.Effect<void, BackupError>;
  }
>()("ankh/clients/git/GitClient") {
  public static readonly layer = Layer.effect(
    GitClient,
    Effect.gen(function* () {
      const commands = yield* Commands;
      const storage = yield* Storage;
      const mirror = Effect.fn("GitClient.mirror")(
        function* (repository: GitRepository) {
          const options = gitOptions(repository);
          yield* privateDirectory(storage.path.dirname(repository.mirror)).pipe(
            Effect.provideService(Storage, storage),
          );
          if (yield* storage.fs.exists(repository.mirror)) {
            yield* commands.run(
              "git",
              ["-C", repository.mirror, "remote", "set-url", "origin", repository.url],
              options,
            );
            yield* commands.run(
              "git",
              ["-C", repository.mirror, "remote", "update", "--prune"],
              options,
            );
          } else {
            yield* commands.run(
              "git",
              ["clone", "--mirror", repository.url, repository.mirror],
              options,
            );
          }
          yield* commands.run(
            "git",
            ["-C", repository.mirror, "lfs", "fetch", "--all", "origin"],
            options,
          );
          yield* commands.run("git", ["-C", repository.mirror, "fsck", "--full"], options);
          yield* syncHead(repository, options).pipe(Effect.provideService(Commands, commands));
          yield* verifyLfs(repository.mirror, options).pipe(
            Effect.provideService(Commands, commands),
          );
        },
        Effect.mapError(backupError("Git mirror")),
      );
      return GitClient.of({ mirror });
    }),
  );
}
