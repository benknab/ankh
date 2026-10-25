import { expect, it } from "@effect/vitest";
import {
  Array,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  References,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { withExecution } from "#telemetry/execution.ts";
import { Otlp } from "#telemetry/otlp.ts";

const settings = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_TRACES_EXPORTER: "otlp",
};

const capture = Effect.fnUntraced(function* <A, E, R>(
  work: Effect.Effect<A, E, R>,
  config: Readonly<Record<string, string>> = settings,
  status = 200,
) {
  const requests: { readonly url: string; readonly body: string }[] = [];
  const messages: unknown[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body._tag === "Uint8Array") {
        requests.push({ url: request.url, body: new TextDecoder().decode(request.body.body) });
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response("export-response-secret", { status }),
      );
    }),
  );
  const logger = Logger.make(({ message }: Logger.Options<unknown>): void => {
    messages.push(message);
  });
  const layer = Layer.fresh(Otlp).pipe(
    Layer.provideMerge(Logger.layer([logger])),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
  );
  const exit = yield* work.pipe(
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.provide(layer),
    Effect.exit,
  );
  return { requests, messages, exit };
});

const LogBatch = Schema.Struct({
  resourceLogs: Schema.Array(
    Schema.Struct({
      scopeLogs: Schema.Array(
        Schema.Struct({
          logRecords: Schema.Array(
            Schema.Struct({ traceId: Schema.String, spanId: Schema.String, body: Schema.Unknown }),
          ),
        }),
      ),
    }),
  ),
});
const TraceBatch = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      scopeSpans: Schema.Array(
        Schema.Struct({
          spans: Schema.Array(
            Schema.Struct({
              name: Schema.String,
              traceId: Schema.String,
              spanId: Schema.String,
              parentSpanId: Schema.optional(Schema.String),
              status: Schema.Struct({ code: Schema.Int }),
            }),
          ),
        }),
      ),
    }),
  ),
});

it.effect("OTLP flushes one canonical log and correlated spans on shutdown", () =>
  Effect.gen(function* () {
    const { requests, messages, exit } = yield* capture(
      withExecution(
        "backup",
        Effect.gen(function* () {
          yield* Effect.logInfo("staged", { count: 1 });
          yield* Effect.logDebug("checked", { count: 2 }).pipe(Effect.withSpan("child"));
          return yield* Effect.fail("failure-secret");
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(messages).toHaveLength(1);
    expect(requests).toHaveLength(2);
    const logs = yield* Schema.decodeEffect(Schema.fromJsonString(LogBatch))(
      Option.getOrThrow(Array.findFirst(requests, (request) => request.url.endsWith("/v1/logs")))
        .body,
    );
    const traces = yield* Schema.decodeEffect(Schema.fromJsonString(TraceBatch))(
      Option.getOrThrow(Array.findFirst(requests, (request) => request.url.endsWith("/v1/traces")))
        .body,
    );
    const records = Array.flatMap(logs.resourceLogs, (resource) =>
      Array.flatMap(resource.scopeLogs, (scope) => scope.logRecords),
    );
    const spans = Array.flatMap(traces.resourceSpans, (resource) =>
      Array.flatMap(resource.scopeSpans, (scope) => scope.spans),
    );
    const execution = Option.getOrThrow(
      Array.findFirst(spans, (span) => span.name === "execution"),
    );
    expect(records).toHaveLength(1);
    expect(execution?.status.code).toBe(2);
    expect(records[0]).toMatchObject({ traceId: execution?.traceId, spanId: execution?.spanId });
    expect(
      Option.getOrThrow(Array.findFirst(spans, (span) => span.name === "child")),
    ).toMatchObject({
      traceId: execution?.traceId,
      parentSpanId: execution?.spanId,
    });
    expect(messages).toMatchObject([
      [
        {
          traceId: execution?.traceId,
          spanId: execution?.spanId,
          data: { count: 2 },
          messages: [{ text: "staged" }, { text: "checked" }],
        },
      ],
    ]);
    expect(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(records[0]?.body),
    ).toContain("execution.completed");
    for (const request of requests) {
      expect(request.body).not.toContain("failure-secret");
    }
  }),
);

for (const config of [{}, { ...settings, OTEL_SDK_DISABLED: "true" }]) {
  it.effect("disabled export retains the canonical console sink", () =>
    Effect.gen(function* () {
      const result = yield* capture(withExecution("validate", Effect.logInfo("valid")), config);
      expect(result.requests).toHaveLength(0);
      expect(result.messages).toHaveLength(1);
      expect(Exit.isSuccess(result.exit)).toBe(true);
    }),
  );
}

it.effect("export failures do not fail the run or leak response diagnostics in debug mode", () =>
  Effect.gen(function* () {
    const result = yield* capture(
      withExecution("validate", Effect.logInfo("valid")),
      settings,
      400,
    );
    expect(result.requests).toHaveLength(2);
    expect(result.messages).toHaveLength(1);
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result.messages),
    ).not.toContain("export-response-secret");
  }),
);
