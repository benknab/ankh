import { Context, Effect, Layer } from "effect";
import { HttpClient } from "effect/http";
import { Commands } from "#process/commands.ts";
import {
  type AbsolutePath,
  absolutePath,
  type BackupError,
  backupError,
  type Job,
} from "#domain/model.ts";
import { stageGitea } from "#sources/gitea.ts";
import { stagePostgres } from "#sources/postgres.ts";
import { stageSqlite } from "#sources/sqlite.ts";
import { Storage } from "#storage/storage.ts";

const stage = Effect.fn("Sources.stage")(
  function* (job: Job) {
    const directory = absolutePath(`/staging/${job.name}`);
    switch (job.source.type) {
      case "sqlite":
        return yield* stageSqlite(job.source, directory);
      case "postgres":
        return yield* stagePostgres(job.source, directory);
      case "gitea-git":
        return yield* stageGitea(job.source, directory);
    }
  },
  Effect.mapError(backupError("Source staging")),
);

export class Sources extends Context.Service<
  Sources,
  {
    readonly stage: (job: Job) => Effect.Effect<AbsolutePath, BackupError>;
  }
>()("backup-runner/Sources") {
  static readonly layer = Layer.effect(
    Sources,
    Effect.gen(function* () {
      const context = yield* Effect.context<Commands | Storage | HttpClient.HttpClient>();
      return Sources.of({ stage: (job) => stage(job).pipe(Effect.provide(context)) });
    }),
  );
}
