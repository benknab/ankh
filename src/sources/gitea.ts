import { Array, DateTime, Effect, Schema, String } from "effect";
import { GiteaClient, type Repository } from "#/clients/gitea.ts";
import { GitClient } from "#/clients/git.ts";
import type { SourceAdapter } from "#/domain/adapters.ts";
import { type AbsolutePath, backupError, type Gitea } from "#/domain/model.ts";
import { privateDirectory, Storage } from "#/storage/storage.ts";

const Manifest = Schema.fromJsonString(
  Schema.Struct({ createdAt: Schema.String, repositories: Schema.Array(Schema.String) }),
);

const writeManifest = Effect.fn("Git.writeManifest")(function* (
  directory: AbsolutePath,
  repositories: readonly Repository[],
) {
  const { fs, path } = yield* Storage;
  const manifest = yield* Schema.encodeEffect(Manifest)({
    createdAt: DateTime.formatIso(yield* DateTime.now),
    repositories: Array.sort(
      Array.map(repositories, (repository) => repository.full_name),
      String.Order,
    ),
  });
  yield* fs.writeFileString(path.join(directory, "manifest.json"), manifest);
});

const mirrorRepositories = Effect.fn("Git.mirrorRepositories")(function* (
  source: typeof Gitea.Type,
  directory: AbsolutePath,
  repositories: readonly Repository[],
) {
  const { path } = yield* Storage;
  const git = yield* GitClient;
  const base = source.apiUrl.href.replace(/\/$/u, "");
  yield* privateDirectory(directory);
  yield* Effect.forEach(
    repositories,
    (repository) =>
      git.mirror({
        url: `${base}/${repository.full_name}.git`,
        mirror: path.join(directory, "repositories", `${repository.full_name}.git`),
        tokenFile: source.tokenFile,
      }),
    // Overlap network waits without launching a Git process for every repository at once.
    { discard: true, concurrency: 4 },
  );
});

export const gitAdapter: SourceAdapter<typeof Gitea.Type, GiteaClient | GitClient | Storage> = {
  stage: Effect.fn("Git.stage")(
    function* (source: typeof Gitea.Type, directory: AbsolutePath) {
      const client = yield* GiteaClient;
      const repositories = yield* client.repositories(source);
      yield* mirrorRepositories(source, directory, repositories);
      yield* writeManifest(directory, repositories);
      return directory;
    },
    Effect.mapError(backupError("Git staging")),
  ),
};
