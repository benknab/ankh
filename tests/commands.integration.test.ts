import { it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { Commands } from "../src/commands.ts";
import { infrastructure } from "./integration-support.ts";
import { assert } from "./support.ts";

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
