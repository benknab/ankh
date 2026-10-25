import { expect, it } from "@effect/vitest";
import { Effect, Redacted, Result, Schema } from "effect";
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
      expect(result.failure.message).toBe("sh exited 7");
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result.failure),
      ).not.toContain("failure");
    }
  }).pipe(Effect.provide(infrastructure)),
);

it.live("command diagnostics are bounded and wrapped", () =>
  Effect.gen(function* () {
    const commands = yield* Commands;
    const tail = yield* commands.run(
      process.execPath,
      ["--eval", 'process.stdout.write("x".repeat(1024 * 1024) + "end")'],
      { output: "tail" },
    );
    expect(Redacted.value(tail.stdout).length).toBeLessThanOrEqual(64 * 1024);
    expect(Redacted.value(tail.stdout).endsWith("end")).toBe(true);
    expect(tail.exitCode).toBe(0);
    const failed = yield* commands
      .run(
        process.execPath,
        ["--eval", "process.stderr.write(process.env.PGPASSWORD); process.exitCode = 7"],
        { env: { PGPASSWORD: Redacted.make("synthetic-secret") } },
      )
      .pipe(Effect.result);
    expect(Result.isFailure(failed), "command must fail").toBe(true);
    if (Result.isFailure(failed)) {
      expect(failed.failure.exitCode).toBe(7);
      expect(failed.failure.operation).toBe(process.execPath);
      expect(failed.failure.message, "diagnostics must redact secrets").not.toContain(
        "synthetic-secret",
      );
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(failed.failure),
      ).not.toContain("synthetic-secret");
    }
  }).pipe(Effect.provide(infrastructure)),
);

it.live("command output stays exact and hidden even for unknown secrets and spawn failures", () =>
  Effect.gen(function* () {
    const commands = yield* Commands;
    const secret = "synthetic-unknown-secret";
    const result = yield* commands.run(process.execPath, [
      "--eval",
      "process.stdout.write('  ' + process.argv[1] + '\\n'); process.stderr.write(process.argv[1])",
      Redacted.make(secret),
    ]);
    expect(Redacted.value(result.stdout)).toBe(`  ${secret}\n`);
    expect(Redacted.value(result.stderr)).toBe(secret);
    expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result)).not.toContain(
      secret,
    );
    const failed = yield* commands
      .run("missing-ankh-command", [Redacted.make(secret)])
      .pipe(Effect.result);
    expect(Result.isFailure(failed)).toBe(true);
    if (Result.isFailure(failed)) {
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(failed.failure),
      ).not.toContain(secret);
      expect(String(failed.failure)).not.toContain(secret);
    }
  }).pipe(Effect.provide(infrastructure)),
);
