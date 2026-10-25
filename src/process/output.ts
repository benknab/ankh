import { Stream, type Effect, type Redacted } from "effect";

export type Argument = string | Redacted.Redacted;

export interface CommandOutput {
  readonly stdout: Redacted.Redacted;
  readonly stderr: Redacted.Redacted;
  readonly exitCode: 0;
}

export interface Options {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, Argument>>;
  readonly extendEnv?: boolean;
  readonly interactive?: boolean;
  readonly output?: "capture" | "tail";
}

interface Capture {
  readonly text: string;
  readonly overflow: boolean;
}

const captureLimit = 16 * 1024 * 1024;
const diagnosticLimit = 64 * 1024;

export const capture = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  tail: boolean,
): Effect.Effect<Capture, E, R> =>
  Stream.runFold(
    Stream.decodeText(stream),
    (): Capture => ({ text: "", overflow: false }),
    (state, chunk) => {
      const text = state.text + chunk;
      return tail
        ? { text: text.slice(-diagnosticLimit), overflow: false }
        : {
            text: text.slice(0, captureLimit),
            overflow: state.overflow || text.length > captureLimit,
          };
    },
  );
