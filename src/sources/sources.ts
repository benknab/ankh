import { Context, Effect, Layer } from "effect";
import { SqliteClient } from "#clients/sqlite.ts";
import { PostgresClient } from "#clients/postgres.ts";
import { GiteaClient } from "#clients/gitea.ts";
import { GitClient } from "#clients/git.ts";
import {
  type AbsolutePath,
  absolutePath,
  type BackupError,
  backupError,
  type Job,
} from "#domain/model.ts";
import { gitAdapter } from "#sources/gitea.ts";
import { postgresAdapter } from "#sources/postgres.ts";
import { sqliteAdapter } from "#sources/sqlite.ts";
import type { Storage } from "#storage/storage.ts";

const stage = Effect.fn("Sources.stage")(
  function* (job: Job) {
    const directory = absolutePath(`/staging/${job.name}`);
    switch (job.source.type) {
      case "sqlite":
        return yield* sqliteAdapter.stage(job.source, directory);
      case "postgres":
        return yield* postgresAdapter.stage(job.source, directory);
      case "gitea-git":
        return yield* gitAdapter.stage(job.source, directory);
    }
  },
  Effect.mapError(backupError("Source staging")),
);

export class Sources extends Context.Service<
  Sources,
  {
    readonly stage: (job: Job) => Effect.Effect<AbsolutePath, BackupError>;
  }
>()("backup-runner/sources/sources") {
  public static readonly layer = Layer.effect(
    Sources,
    Effect.gen(function* () {
      const context = yield* Effect.context<
        Storage | SqliteClient | PostgresClient | GiteaClient | GitClient
      >();
      return Sources.of({ stage: (job) => stage(job).pipe(Effect.provide(context)) });
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(SqliteClient.layer, PostgresClient.layer, GiteaClient.layer, GitClient.layer),
    ),
  );
}
