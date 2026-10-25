import { Config, Effect, Layer, Logger, References } from "effect";

const json = Logger.layer([Logger.consoleJson]);
export const Info = json.pipe(
  Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Info")),
);
export const Debug = json.pipe(
  Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Debug")),
);
export const Logging = Layer.unwrap(
  Effect.gen(function* () {
    const level = yield* Config.Literals(["info", "debug"], "BACKUP_LOG_LEVEL").pipe(
      Config.withDefault("info"),
    );
    return level === "debug" ? Debug : Info;
  }),
);
