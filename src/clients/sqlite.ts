import { Array, Context, Effect, Layer, Redacted, Schema } from "effect";
import { type AbsolutePath, backupError, type BackupError } from "#domain/model.ts";
import { Commands } from "#process/commands.ts";

const Integrity = Schema.Literal("ok");

export class SqliteClient extends Context.Service<
  SqliteClient,
  {
    readonly backup: (source: AbsolutePath, target: string) => Effect.Effect<void, BackupError>;
  }
>()("backup-runner/clients/sqlite/SqliteClient") {
  public static readonly layer = Layer.effect(
    SqliteClient,
    Effect.gen(function* () {
      const commands = yield* Commands;
      const backup = Effect.fn("SqliteClient.backup")(
        function* (source: AbsolutePath, target: string) {
          const uri = Array.join(
            Array.map(source.split("/"), (part) => encodeURIComponent(part)),
            "/",
          );
          yield* commands.run("sqlite3", [
            `file:${uri}?mode=ro`,
            ".timeout 60000",
            `.backup ${target}`,
          ]);
          const result = yield* commands.run("sqlite3", [target, "PRAGMA quick_check;"]);
          yield* Schema.decodeUnknownEffect(Integrity)(Redacted.value(result.stdout).trim());
        },
        Effect.mapError(backupError("SQLite backup verification")),
      );
      return SqliteClient.of({ backup });
    }),
  );
}
