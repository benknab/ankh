import type { CommandOutput } from "#process/commands.ts";

export const output = (stdout: string): CommandOutput => ({ stdout, stderr: "", exitCode: 0 });
