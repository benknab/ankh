import { expect, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Ref, Result } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { transport } from "#/telemetry/transport.ts";

for (const body of [false, true]) {
  it.effect(
    `OTLP deadlines interrupt stalled ${body ? "response bodies" : "requests"} before shutdown`,
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<boolean>();
        const stopped = yield* Ref.make(false);
        const stalled = Deferred.succeed(started, true).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Ref.set(stopped, true)),
        );
        const client = HttpClient.make((request) =>
          body
            ? Effect.succeed({
                ...HttpClientResponse.fromWeb(request, new Response("")),
                arrayBuffer: stalled,
              })
            : stalled,
        );
        const layer = transport("LOGS").pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                OTEL_EXPORTER_OTLP_TIMEOUT: "1000",
                OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: "5",
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const bounded = yield* HttpClient.HttpClient;
          const fiber = yield* Effect.forkChild(
            bounded.get("http://collector/v1/logs").pipe(Effect.result),
          );
          yield* Deferred.await(started);
          yield* TestClock.adjust(4);
          expect(yield* Ref.get(stopped)).toBe(false);
          yield* TestClock.adjust(1);
          expect(Result.isFailure(yield* Fiber.join(fiber))).toBe(true);
          expect(yield* Ref.get(stopped)).toBe(true);
        }).pipe(Effect.provide(layer));
      }),
  );
}
