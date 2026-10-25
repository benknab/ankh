import { Duration, Effect } from "effect";
import { BackupError } from "#domain/model.ts";
import { type Argument, Commands } from "#process/commands.ts";
import { ProtonState, protonEnvironment } from "#clients/proton/state.ts";

const lockConflict = 75;

const describe = (binary: string, error: BackupError, lock: string): BackupError => {
  if (error.operation !== "flock" || error.exitCode === undefined) {
    return error;
  }
  if (error.exitCode === lockConflict) {
    return BackupError.make({
      message: `Timed out waiting for the Proton state lock ${lock}`,
      operation: "Proton lock",
    });
  }
  return BackupError.make({
    message: `${binary} exited ${error.exitCode}`,
    operation: binary,
    exitCode: error.exitCode,
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  });
};

// The CLI has no cross-process session lock and rewrites the whole session after every token
// refresh, so every tool that reads or writes Proton state runs under one exclusive file lock.
export const runProton = Effect.fn("Proton.command")(function* (
  binary: "gpg" | "gpg-connect-agent" | "pass" | "proton-drive",
  args: readonly Argument[],
  options: { readonly interactive?: boolean } = {},
) {
  const commands = yield* Commands;
  const paths = yield* ProtonState;
  return yield* commands
    .run(
      "flock",
      [
        "--exclusive",
        // Daemons started by the tool, such as gpg-agent, must not inherit the lock.
        "--close",
        "--timeout",
        String(Math.ceil(Duration.toSeconds(paths.lockTimeout))),
        "--conflict-exit-code",
        String(lockConflict),
        paths.lock,
        binary,
        ...args,
      ],
      { env: protonEnvironment(paths), interactive: options.interactive === true },
    )
    .pipe(Effect.mapError((error) => describe(binary, error, paths.lock)));
});
