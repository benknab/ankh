import { Redacted } from "effect";
import type { CommandOutput } from "#process/commands.ts";

export const output = (stdout: string): CommandOutput => ({
  stdout: Redacted.make(stdout),
  stderr: Redacted.make(""),
  exitCode: 0,
});
