import { Array, Context, Effect, Layer, Record, Redacted } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BackupError, backupError } from "#domain/model.ts";
import { capture, type Argument, type CommandOutput, type Options } from "#process/output.ts";
import { track } from "#telemetry/execution.ts";

export type { Argument, CommandOutput, Options } from "#process/output.ts";

const reveal = (value: Argument): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const run = Effect.fn("Commands.run")(
  function* (binary: string, args: readonly Argument[], options: Options = {}) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const interactive = options.interactive === true;
    const child = yield* spawner.spawn(
      ChildProcess.make(binary, Array.map(args, reveal), {
        cwd: options.cwd,
        env: Record.map(options.env ?? {}, reveal),
        extendEnv: options.extendEnv ?? true,
        stdin: interactive ? "inherit" : "ignore",
        stdout: interactive ? "inherit" : "pipe",
        stderr: interactive ? "inherit" : "pipe",
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        capture(child.stdout, options.output === "tail"),
        capture(child.stderr, true),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* BackupError.make({
        message: `${binary} exited ${exitCode}`,
        operation: binary,
        exitCode,
        cause: Redacted.make({ stdout: stdout.text, stderr: stderr.text }),
      });
    }
    if (stdout.overflow) {
      return yield* BackupError.make({
        message: `${binary} output exceeded the capture limit`,
        operation: binary,
      });
    }
    return {
      stdout: Redacted.make(stdout.text),
      stderr: Redacted.make(stderr.text),
      exitCode: 0,
    } satisfies CommandOutput;
  },
  Effect.scoped,
  Effect.mapError(backupError("Command")),
  (effect) => track("process", effect),
);

export class Commands extends Context.Service<
  Commands,
  {
    readonly run: (
      binary: string,
      args: readonly Argument[],
      options?: Options,
    ) => Effect.Effect<CommandOutput, BackupError>;
  }
>()("ankh/process/commands") {
  public static readonly layer = Layer.effect(
    Commands,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return Commands.of({
        run: (binary, args, options) =>
          run(binary, args, options).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
      });
    }),
  );
}
