import { Layer, References } from "effect";
import { OtlpLogger, OtlpTracer } from "effect/observability";
import metadata from "#package" with { type: "json" };
import { Logging } from "#telemetry/logging.ts";
import { Serialization } from "#telemetry/serialization.ts";

const resource = { serviceName: "backup-runner", serviceVersion: metadata.version };

export const Otlp = Layer.mergeAll(
  OtlpLogger.layerFromConfig({ resource }),
  OtlpTracer.layerFromConfig({ resource }),
).pipe(
  Layer.provide(Serialization),
  // Exporter workers inherit Info so their debug diagnostics cannot expose
  // request headers or response bodies. The application's log level is separate.
  Layer.provide(Layer.succeed(References.MinimumLogLevel, "Info")),
);

export const Telemetry = Otlp.pipe(Layer.provideMerge(Logging));
