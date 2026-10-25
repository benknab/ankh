import { Context, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BackupError, backupError } from "./model.ts";

export type Options = {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly interactive?: boolean;
  readonly output?: "capture" | "tail";
  readonly redact?: readonly string[];
};

const captureLimit = 16 * 1024 * 1024;
const diagnosticLimit = 64 * 1024;

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
              Stream.runFold(
                Stream.decodeText(child.stdout),
                () => ({ text: "", overflow: false }),
                (state, chunk) => {
                  const text = state.text + chunk;
                  return options.output === "tail"
                    ? { text: text.slice(-diagnosticLimit), overflow: false }
                    : {
                        text: text.slice(0, captureLimit),
                        overflow: state.overflow || text.length > captureLimit,
                      };
                },
              ),
              Stream.runFold(
                Stream.decodeText(child.stderr),
                () => "",
                (text, chunk) => (text + chunk).slice(-diagnosticLimit),
              ),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          const secrets = [
            ...(options.redact ?? []),
            ...Object.entries(options.env ?? {})
              .filter(([key]) => /PASSWORD|TOKEN|SECRET/.test(key) && !key.endsWith("_FILE"))
              .map(([, value]) => value),
          ].filter((value) => value.length > 0);
          const redact = (text: string) =>
            secrets.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);
          if (code !== 0) {
            return yield* new BackupError({
              message: `${binary} exited ${code}: ${redact(stderr.trim())}`,
              operation: binary,
              exitCode: code,
            });
          }
          if (stdout.overflow) {
            return yield* new BackupError({
              message: `${binary} output exceeded the capture limit`,
              operation: binary,
            });
          }
          return redact(stdout.text.trim());
        },
        Effect.scoped,
        Effect.mapError(backupError("Command")),
      );
      return Commands.of({ run });
    }),
  );
}
