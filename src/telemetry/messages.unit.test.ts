import { expect, it } from "@effect/vitest";
import { Array, Cause, Effect, Fiber, Logger, Record, Redacted, References, Schema } from "effect";
import { track, withExecution } from "#telemetry/execution.ts";

const Event = Schema.Struct({
  operation: Schema.String,
  messages: Schema.Array(
    Schema.Struct({
      text: Schema.String,
      level: Schema.String,
      annotations: Schema.Record(Schema.String, Schema.Unknown),
      failure: Schema.optional(Schema.Struct({ kind: Schema.String })),
    }),
  ),
  data: Schema.Record(Schema.String, Schema.Unknown),
  droppedMessages: Schema.Int,
  droppedFields: Schema.Int,
});

const capture = Effect.fnUntraced(function* <A, E, R>(work: Effect.Effect<A, E, R>) {
  const output: unknown[] = [];
  const logger = Logger.make(({ message }: Logger.Options<unknown>): void => {
    output.push(message);
  });
  yield* work.pipe(Effect.provide(Logger.layer([logger])));
  return yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Tuple([Event])))(output);
});

it.effect("normal log calls accumulate fields, messages, annotations and cleanup", () =>
  Effect.gen(function* () {
    const events = yield* capture(
      withExecution(
        "backup",
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.logInfo("released"));
          yield* Effect.logInfo("staged", {
            count: 1,
            nested: { first: true },
            status: "custom",
          }).pipe(Effect.annotateLogs({ destination: "restic" }));
          yield* Effect.logDebug("filtered", { hidden: true });
          const child = yield* Effect.forkChild(
            Effect.logWarning("retrying", { count: 2, nested: { second: true } }),
          );
          yield* Fiber.join(child);
        }).pipe(Effect.scoped),
      ).pipe(Effect.provideService(References.MinimumLogLevel, "Info")),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.[0].data).toStrictEqual({
      count: 2,
      nested: { second: true },
      status: "custom",
    });
    expect(events[0]?.[0].messages).toMatchObject([
      { text: "staged", level: "Info", annotations: { destination: "restic" } },
      { text: "retrying", level: "Warn" },
      { text: "released" },
    ]);
  }),
);

it.effect("concurrent and nested runs each emit their own data once", () =>
  Effect.gen(function* () {
    const events = yield* capture(
      Effect.all(
        [
          withExecution(
            "backup",
            Effect.gen(function* () {
              yield* Effect.logInfo("outer", { owner: "outer" });
              yield* withExecution("retry", Effect.logInfo("inner", { owner: "inner" }));
            }),
          ),
          withExecution("validate", Effect.logInfo("other", { owner: "other" })),
        ],
        { concurrency: "unbounded" },
      ),
    );
    expect(events).toHaveLength(3);
    expect(
      Array.map(events, ([event]) => [event.operation, event.data.owner, event.messages.length]),
    ).toEqual(
      expect.arrayContaining([
        ["backup", "outer", 1],
        ["retry", "inner", 1],
        ["validate", "other", 1],
      ]),
    );
  }),
);

it.effect("collection bounds growth and masks structured secrets and raw errors", () =>
  Effect.gen(function* () {
    const secret = "must-not-escape";
    const events = yield* capture(
      withExecution(
        "backup",
        Effect.gen(function* () {
          yield* Effect.logInfo({
            password: secret,
            nested: { token: secret },
            safe: Redacted.make(secret),
            error: new Error(secret),
            cause: Cause.fail(secret),
          });
          yield* Effect.logError("failed safely", Cause.fail(secret)).pipe(
            Effect.annotateLogs({ authorization: secret }),
          );
          yield* Effect.forEach(Array.range(0, 119), (index) =>
            Effect.logInfo("x".repeat(3000), { [`field${index}`]: index }),
          );
        }),
      ),
    );
    const event = events[0]?.[0];
    expect(event?.messages).toHaveLength(100);
    expect(Record.keys(event?.data ?? {})).toHaveLength(100);
    expect(event?.droppedMessages).toBe(22);
    expect(event?.droppedFields).toBe(25);
    expect(event?.messages[1]?.text).toBe("Failure recorded");
    expect(event?.messages[1]?.failure?.kind).toBe("failure");
    expect(event?.messages[2]?.text).toHaveLength(2048);
    expect(event?.data).toMatchObject({
      password: "[redacted]",
      nested: { token: "[redacted]" },
      safe: "[redacted]",
      error: "[error]",
    });
    expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(events)).not.toContain(
      secret,
    );
  }),
);

it.effect("debug progress is collected without overwriting custom data", () =>
  Effect.gen(function* () {
    const events = yield* capture(
      withExecution("backup", track("source", Effect.logInfo({ count: 1 }))).pipe(
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.[0].data).toStrictEqual({ count: 1 });
    expect(events[0]?.[0].messages).toHaveLength(2);
    expect(events[0]?.[0].messages[0]?.text).toContain("step.started");
    expect(events[0]?.[0].messages[1]?.text).toContain("step.completed");
  }),
);
