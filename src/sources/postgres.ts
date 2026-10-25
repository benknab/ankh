import { Effect } from "effect";
import { PostgresClient } from "#/clients/postgres.ts";
import type { SourceAdapter } from "#/domain/adapters.ts";
import { type AbsolutePath, backupError, type Postgres } from "#/domain/model.ts";
import { Storage } from "#/storage/storage.ts";
import { freshStage } from "#/sources/stage.ts";

export const postgresAdapter: SourceAdapter<typeof Postgres.Type, PostgresClient | Storage> = {
  stage: Effect.fn("Postgres.stage")(
    function* (source: typeof Postgres.Type, directory: AbsolutePath) {
      const { path } = yield* Storage;
      const client = yield* PostgresClient;
      yield* freshStage(directory);
      yield* client.dump(source, path.join(directory, source.output));
      return directory;
    },
    Effect.mapError(backupError("PostgreSQL staging")),
  ),
};
