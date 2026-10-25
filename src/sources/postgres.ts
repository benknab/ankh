import { Effect } from "effect";
import { Commands } from "#process/commands.ts";
import { type AbsolutePath, BackupError, type Postgres } from "#domain/model.ts";
import { Storage } from "#storage/storage.ts";
import { freshStage } from "#sources/stage.ts";

export const stagePostgres = Effect.fn("Postgres.stage")(function* (
  source: typeof Postgres.Type,
  directory: AbsolutePath,
) {
  const { fs, path } = yield* Storage;
  const commands = yield* Commands;
  yield* freshStage(directory);
  const output = path.join(directory, source.output);
  const password = (yield* fs.readFileString(source.passwordFile)).replace(/\r?\n$/, "");
  if (password.length === 0 || password.includes("\0")) {
    return yield* new BackupError({ message: "Invalid PostgreSQL password file" });
  }
  yield* commands.run("pg_dump", ["--no-password", "--format=custom", "--file", output], {
    env: {
      PGHOST: source.hostname,
      PGPORT: String(source.port),
      PGDATABASE: source.database,
      PGUSER: source.username,
      PGPASSWORD: password,
      PGCONNECT_TIMEOUT: "30",
    },
  });
  yield* commands.run("pg_restore", ["--file=/dev/null", output]);
  return directory;
});
