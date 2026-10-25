import { Array, Record, Stream, type Effect } from "effect";

export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: 0;
}

export interface Options {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly interactive?: boolean;
  readonly output?: "capture" | "tail";
  readonly redact?: readonly string[];
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

export const redact = (text: string, options: Options): string => {
  const environment = Record.toEntries(options.env ?? {});
  const sensitive = Array.filter(
    environment,
    ([key]) => /PASSWORD|TOKEN|SECRET/u.test(key) && !key.endsWith("_FILE"),
  );
  const secrets = Array.filter(
    [...(options.redact ?? []), ...Array.map(sensitive, ([, value]) => value)],
    (value) => value.length > 0,
  );
  return Array.reduce(secrets, text, (value, secret) => value.replaceAll(secret, "[redacted]"));
};
