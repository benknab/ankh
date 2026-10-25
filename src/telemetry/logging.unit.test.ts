import { expect, it } from "@effect/vitest";
import { Effect, Layer, Logger, References } from "effect";
import { Info, Debug } from "#/telemetry/logging.ts";

for (const [name, layer, expected] of [
  ["info", Info, "Info"],
  ["debug", Debug, "Debug"],
] as const) {
  it.effect(`${name} logging installs JSON output and its level filter`, () =>
    Effect.gen(function* () {
      const [level, loggers] = yield* Effect.all([
        References.MinimumLogLevel,
        Logger.CurrentLoggers,
      ]).pipe(Effect.provide(Layer.fresh(layer)));
      expect(level).toBe(expected);
      expect(loggers.has(Logger.consoleJson)).toBe(true);
      expect(loggers.size).toBe(1);
    }),
  );
}
