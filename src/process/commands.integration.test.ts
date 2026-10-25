import { it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { Commands } from "#process/commands.ts";
import { infrastructure } from "#testing/infrastructure.ts";
import { assert } from "#testing/fixtures.ts";

it.live("Commands drains stdout and stderr and rejects nonzero exits", () =>
  Effect.gen(function* () {
    const commands = yield* Commands;
    const result = yield* commands
      .run("sh", ["-c", "printf output; printf failure >&2; exit 7"])
      .pipe(Effect.result);
    yield* assert(Result.isFailure(result), "exit 7 must fail");
    if (Result.isFailure(result)) {
      yield* assert(result.failure.message.includes("failure"), "stderr must be in the error");
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
    yield* assert(
      tail.length <= 64 * 1024 && tail.endsWith("end"),
      "ordinary output must retain only a bounded tail",
    );
    const failed = yield* commands
      .run(
        process.execPath,
        ["--eval", "process.stderr.write(process.env.PGPASSWORD); process.exitCode = 7"],
        { env: { PGPASSWORD: "synthetic-secret" } },
      )
      .pipe(Effect.result);
    yield* assert(Result.isFailure(failed), "command must fail");
    if (Result.isFailure(failed)) {
      yield* assert(
        failed.failure.exitCode === 7 && failed.failure.operation === process.execPath,
        "structured failure details must survive",
      );
      yield* assert(
        !failed.failure.message.includes("synthetic-secret"),
        "diagnostics must redact secrets",
      );
    }
  }).pipe(Effect.provide(infrastructure)),
);
