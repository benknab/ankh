import { Config, Effect, Layer } from "effect";
import { HttpClient, HttpClientError } from "effect/http";

// Effect 4.0.2 applies OTLP timeouts only to shutdown. Bound each HTTP attempt too.
export const transport = (
  signal: "LOGS" | "TRACES",
): Layer.Layer<HttpClient.HttpClient, never, HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const duration = yield* Config.Int(`OTEL_EXPORTER_OTLP_${signal}_TIMEOUT`).pipe(
        Config.orElse(() => Config.Int("OTEL_EXPORTER_OTLP_TIMEOUT")),
        Config.orElse(() =>
          Config.Int(signal === "LOGS" ? "OTEL_BLRP_EXPORT_TIMEOUT" : "OTEL_BSP_EXPORT_TIMEOUT"),
        ),
        Config.withDefault(10_000),
        Effect.orDie,
      );
      return client.pipe(
        HttpClient.transform((response, request) =>
          response.pipe(
            Effect.tap((value) => Effect.ignore(value.arrayBuffer)),
            Effect.timeoutOrElse({
              duration,
              orElse: () =>
                Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      description: "Telemetry export timed out",
                    }),
                  }),
                ),
            }),
          ),
        ),
      );
    }),
  );
