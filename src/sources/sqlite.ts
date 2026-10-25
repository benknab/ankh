import { Effect } from "effect";
import { Commands } from "#process/commands.ts";
import { type AbsolutePath, BackupError, type Sqlite } from "#domain/model.ts";
import { freshStage } from "#sources/stage.ts";
import { Storage } from "#storage/storage.ts";

export const stageSqlite = Effect.fn("Sqlite.stage")(function* (
  source: typeof Sqlite.Type,
  directory: AbsolutePath,
) {
  const { path } = yield* Storage;
  const commands = yield* Commands;
  yield* freshStage(directory);
  const output = path.join(directory, source.output);
  yield* commands.run("sqlite3", [
    `file:${source.path.split("/").map(encodeURIComponent).join("/")}?mode=ro`,
    ".timeout 60000",
    `.backup ${output}`,
  ]);
  const checked = yield* commands.run("sqlite3", [output, "PRAGMA quick_check;"]);
  if (checked !== "ok") {
    return yield* new BackupError({ message: `SQLite quick_check failed: ${checked}` });
  }
  return directory;
});
