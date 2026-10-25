import { Context, Effect, Layer, Schema } from "effect";
import { backupError, type BackupError, type Postgres } from "#domain/model.ts";
import { Commands } from "#process/commands.ts";
import { Storage } from "#storage/storage.ts";

const Password = Schema.NonEmptyString.check(Schema.isPattern(/^[^\0]+$/u));

export class PostgresClient extends Context.Service<
  PostgresClient,
  {
    readonly dump: (
      source: typeof Postgres.Type,
      target: string,
    ) => Effect.Effect<void, BackupError>;
  }
>()("backup-runner/clients/postgres/PostgresClient") {
  public static readonly layer = Layer.effect(
    PostgresClient,
    Effect.gen(function* () {
      const commands = yield* Commands;
      const { fs } = yield* Storage;
      const dump = Effect.fn("PostgresClient.dump")(
        function* (source: typeof Postgres.Type, target: string) {
          const content = yield* fs.readFileString(source.passwordFile);
          const password = yield* Schema.decodeEffect(Password)(content.replace(/\r?\n$/u, ""));
          yield* commands.run("pg_dump", ["--no-password", "--format=custom", "--file", target], {
            env: {
              PGHOST: source.hostname,
              PGPORT: String(source.port),
              PGDATABASE: source.database,
              PGUSER: source.username,
              PGPASSWORD: password,
              PGCONNECT_TIMEOUT: "30",
            },
          });
          yield* commands.run("pg_restore", ["--file=/dev/null", target]);
        },
        Effect.mapError(backupError("PostgreSQL dump")),
      );
      return PostgresClient.of({ dump });
    }),
  );
}
