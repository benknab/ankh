import { Array, Effect, MutableList, Stream, type Redacted } from "effect";

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

interface CaptureBuffer {
  readonly chunks: MutableList.MutableList<string>;
  length: number;
  overflow: boolean;
}

const append = (state: CaptureBuffer, text: string): void => {
  if (text.length > 0) {
    MutableList.append(state.chunks, text);
    state.length += text.length;
  }
};

const trimTail = (state: CaptureBuffer): void => {
  while (state.length > diagnosticLimit) {
    const first = MutableList.take(state.chunks);
    if (first === MutableList.Empty) {
      break;
    }
    const excess = state.length - diagnosticLimit;
    state.length -= first.length;
    if (first.length > excess) {
      MutableList.prepend(state.chunks, first.slice(excess));
      state.length += first.length - excess;
    }
  }
};

export const capture = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  tail: boolean,
): Effect.Effect<Capture, E, R> =>
  Stream.runFold(
    Stream.decodeText(stream),
    (): CaptureBuffer => ({ chunks: MutableList.make(), length: 0, overflow: false }),
    (state, chunk) => {
      if (tail) {
        append(state, chunk.slice(-diagnosticLimit));
        trimTail(state);
      } else {
        const remaining = captureLimit - state.length;
        state.overflow ||= chunk.length > remaining;
        if (remaining > 0) {
          append(state, chunk.slice(0, remaining));
        }
      }
      return state;
    },
  ).pipe(
    Effect.map((state) => ({
      text: Array.join(MutableList.takeAll(state.chunks), ""),
      overflow: state.overflow,
    })),
  );
