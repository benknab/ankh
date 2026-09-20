import { Effect, Result } from "effect";
import { Commands } from "./commands.ts";
import { type AbsolutePath, BackupError } from "./model.ts";
import { Storage } from "./storage.ts";

const stacks = ["example-app", "example-sqlite", "gitea"] as const;

export const runAll = Effect.fn("Host.runAll")(function* (root: AbsolutePath) {
  const commands = yield* Commands;
  const { fs, path } = yield* Storage;
  const lock = path.join(root, "backup-runner", ".run-lock");
  yield* Effect.acquireRelease(
    fs.makeDirectory(lock, { mode: 0o700 }),
    () => fs.remove(lock, { recursive: true }).pipe(Effect.orDie),
  );
  const results = yield* Effect.forEach(
    stacks,
    (stack) =>
      commands.run("docker", [
        "compose",
        "--project-directory",
        path.join(root, "server", stack),
        "--profile",
        "backup",
        "run",
        "--no-deps",
        "--rm",
        "backup",
        "backup",
      ], { interactive: true }).pipe(Effect.result),
  );
  if (results.some(Result.isFailure)) {
    return yield* new BackupError({
      message: "One or more opted-in backup jobs failed",
    });
  }
}, Effect.scoped);
