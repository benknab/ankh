import { Context, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { BackupError } from "./model.ts";

export type Options = {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly interactive?: boolean;
};

export class Commands extends Context.Service<
  Commands,
  {
    readonly run: (
      binary: string,
      args: readonly string[],
      options?: Options,
    ) => Effect.Effect<string, BackupError>;
  }
>()("backup-runner/Commands") {
  static readonly layer = Layer.effect(
    Commands,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const run = Effect.fn("Commands.run")(
        function* (binary: string, args: readonly string[], options: Options = {}) {
          const child = yield* spawner.spawn(
            ChildProcess.make(binary, args, {
              ...options,
              extendEnv: true,
              stdin: options.interactive ? "inherit" : "ignore",
              stdout: options.interactive ? "inherit" : "pipe",
              stderr: options.interactive ? "inherit" : "pipe",
            }),
          );
          const [stdout, stderr, code] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(child.stdout)),
              Stream.mkString(Stream.decodeText(child.stderr)),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (code !== 0) {
            return yield* new BackupError({
              message: `${binary} exited ${code}: ${stderr.trim()}`,
            });
          }
          return stdout.trim();
        },
        Effect.scoped,
        Effect.mapError((e) => new BackupError({ message: String(e) })),
      );
      return Commands.of({ run });
    }),
  );
}
