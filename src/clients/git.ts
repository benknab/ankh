import { Context, Effect, Layer } from "effect";
import { type AbsolutePath, backupError, type BackupError } from "#domain/model.ts";
import { Commands, type Options } from "#process/commands.ts";
import { privateDirectory, Storage } from "#storage/storage.ts";

export interface GitRepository {
  readonly url: string;
  readonly mirror: string;
  readonly tokenFile: AbsolutePath;
}

export class GitClient extends Context.Service<
  GitClient,
  {
    readonly mirror: (repository: GitRepository) => Effect.Effect<void, BackupError>;
  }
>()("backup-runner/clients/git/GitClient") {
  public static readonly layer = Layer.effect(
    GitClient,
    Effect.gen(function* () {
      const commands = yield* Commands;
      const storage = yield* Storage;
      const mirror = Effect.fn("GitClient.mirror")(
        function* (repository: GitRepository) {
          const options: Options = {
            output: "tail",
            env: {
              GIT_ASKPASS: "/app/gitea-askpass.sh",
              GIT_TERMINAL_PROMPT: "0",
              GITEA_TOKEN_FILE: repository.tokenFile,
            },
          };
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
        },
        Effect.mapError(backupError("Git mirror")),
      );
      return GitClient.of({ mirror });
    }),
  );
}
