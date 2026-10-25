import { Effect } from "effect";
import { SqliteClient } from "#clients/sqlite.ts";
import type { SourceAdapter } from "#domain/adapters.ts";
import { type AbsolutePath, backupError, type Sqlite } from "#domain/model.ts";
import { freshStage } from "#sources/stage.ts";
import { Storage } from "#storage/storage.ts";

export const sqliteAdapter: SourceAdapter<typeof Sqlite.Type, SqliteClient | Storage> = {
  stage: Effect.fn("Sqlite.stage")(
    function* (source: typeof Sqlite.Type, directory: AbsolutePath) {
      const { path } = yield* Storage;
      const client = yield* SqliteClient;
      yield* freshStage(directory);
      yield* client.backup(source.path, path.join(directory, source.output));
      return directory;
    },
    Effect.mapError(backupError("SQLite staging")),
  ),
};
