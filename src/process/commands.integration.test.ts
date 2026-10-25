import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { Commands } from "#process/commands.ts";
import { infrastructure } from "#testing/infrastructure.ts";

it.live("Commands drains stdout and stderr and rejects nonzero exits", () =>
  Effect.gen(function* () {
    const commands = yield* Commands;
    const result = yield* commands
      .run("sh", ["-c", "printf output; printf failure >&2; exit 7"])
      .pipe(Effect.result);
    expect(Result.isFailure(result), "exit 7 must fail").toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message, "stderr must be in the error").toContain("failure");
    }
  }).pipe(Effect.provide(infrastructure)),
);

it.live("command diagnostics are bounded and redact supplied secrets", () =>
  Effect.gen(function* () {
    const commands = yield* Commands;
    const tail = yield* commands.run(
      process.execPath,
      ["--eval", 'process.stdout.write("x".repeat(1024 * 1024) + "end")'],
      { output: "tail" },
    );
    expect(tail.stdout.length).toBeLessThanOrEqual(64 * 1024);
    expect(tail.stdout.endsWith("end")).toBe(true);
    expect(tail.exitCode).toBe(0);
    const failed = yield* commands
      .run(
        process.execPath,
        ["--eval", "process.stderr.write(process.env.PGPASSWORD); process.exitCode = 7"],
        { env: { PGPASSWORD: "synthetic-secret" } },
      )
      .pipe(Effect.result);
    expect(Result.isFailure(failed), "command must fail").toBe(true);
    if (Result.isFailure(failed)) {
      expect(failed.failure.exitCode).toBe(7);
      expect(failed.failure.operation).toBe(process.execPath);
      expect(failed.failure.message, "diagnostics must redact secrets").not.toContain(
        "synthetic-secret",
      );
    }
  }).pipe(Effect.provide(infrastructure)),
);
