import { Array, Duration, Effect, Option, Predicate, Redacted } from "effect";
import { BackupError } from "#domain/model.ts";
import { type Argument, Commands } from "#process/commands.ts";
import { keyProtection, ProtonState, protonEnvironment } from "#clients/proton/state.ts";

const lockConflict = 75;

// The CLI prints these fixed messages for the pinned release; anything else stays generic.
const diagnoses = [
  {
    marker: "You need to login first",
    message: "Proton is not logged in or the session was revoked; run proton-login",
  },
  {
    marker: "Failed to load session",
    message:
      "Cannot decrypt the stored Proton session; check the GPG passphrase file and run proton-login",
  },
  {
    marker: "Failed to save session",
    message: "Cannot store the Proton session; check the GPG passphrase file and run proton-login",
  },
] as const;

const stderrOf = (error: BackupError): string => {
  if (error.cause === undefined) {
    return "";
  }
  const cause = Redacted.value(error.cause);
  return Predicate.hasProperty(cause, "stderr") && Predicate.isString(cause.stderr)
    ? cause.stderr
    : "";
};

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
  const stderr = stderrOf(error);
  const diagnosis = Array.findFirst(diagnoses, (entry) => stderr.includes(entry.marker));
  return BackupError.make({
    message: Option.match(diagnosis, {
      onNone: () => `${binary} exited ${error.exitCode}`,
      onSome: (entry) => entry.message,
    }),
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
  const env = protonEnvironment(paths, yield* keyProtection());
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
      { env, interactive: options.interactive === true },
    )
    .pipe(Effect.mapError((error) => describe(binary, error, paths.lock)));
});
