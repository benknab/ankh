import { expect, it } from "@effect/vitest";
import {
  Array,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Redacted,
  References,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { BackupError, Job } from "#domain/model.ts";
import { describeJob, track, withExecution } from "#telemetry/execution.ts";
import { fixture } from "#testing/fixtures.ts";

const Event = Schema.Struct({
  event: Schema.String,
  traceId: Schema.NonEmptyString,
  spanId: Schema.NonEmptyString,
  operation: Schema.String,
  status: Schema.String,
  durationMs: Schema.Finite,
  steps: Schema.Record(
    Schema.String,
    Schema.Struct({
      attempts: Schema.Int,
      failures: Schema.Int,
      interruptions: Schema.Int,
      durationMs: Schema.Finite,
    }),
  ),
});

it.effect("concurrent executions isolate counters and share IDs through child work", () =>
  Effect.gen(function* () {
    const messages: unknown[] = [];
    const annotations: unknown[] = [];
    const logger = Logger.make((options: Logger.Options<unknown>): void => {
      messages.push(options.message);
      annotations.push(options.fiber.getRef(References.CurrentLogAnnotations).operation);
    });
    const job = yield* Schema.decodeUnknownEffect(Job)(fixture);
    const work = Effect.gen(function* () {
      const span = yield* Effect.currentSpan;
      yield* describeJob(job);
      const child = yield* Effect.forkChild(
        track("process", Effect.sleep("1 second").pipe(Effect.andThen(Effect.currentSpan))),
      );
      const childSpan = yield* Fiber.join(child);
      expect(childSpan.traceId).toBe(span.traceId);
      expect(childSpan.spanId).toBe(span.spanId);
      return { traceId: span.traceId, spanId: span.spanId };
    });
    const fiber = yield* Effect.forkChild(
      Effect.all(
        [
          withExecution("backup", track("restic", work)),
          withExecution("retry", track("proton-drive", work)),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.provide(Logger.layer([logger]))),
    );
    yield* TestClock.adjust("1 second");
    const ids = yield* Fiber.join(fiber);
    const events = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Tuple([Event])))(messages);
    expect(events).toHaveLength(2);
    expect(ids[0]?.spanId).not.toBe(ids[1]?.spanId);
    expect(annotations).toStrictEqual(Array.map(events, ([event]) => event.operation));
    for (const [event] of events) {
      expect(ids).toContainEqual({ traceId: event.traceId, spanId: event.spanId });
      expect(event.durationMs).toBe(1000);
      expect(event.status).toBe("success");
      expect(event.steps.process?.attempts).toBe(1);
      expect(event.steps.process?.durationMs).toBe(1000);
      expect(
        Number(event.steps.restic !== undefined) +
          Number(event.steps["proton-drive"] !== undefined),
      ).toBe(1);
    }
  }),
);

for (const mode of ["failure", "defect", "interrupted", "cleanup"] as const) {
  it.effect(`completion records ${mode} once after scope cleanup and excludes error text`, () =>
    Effect.gen(function* () {
      const messages: unknown[] = [];
      let released = false;
      const secret = "password-must-not-appear";
      const logger = Logger.make(({ message }: Logger.Options<unknown>): void => {
        expect(released).toBe(true);
        messages.push(message);
      });
      const work = Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            released = true;
          }),
        );
        if (mode === "failure") {
          return yield* BackupError.make({
            message: secret,
            exitCode: 7,
            operation: secret,
            cause: Redacted.make(secret),
          });
        }
        if (mode === "defect") {
          return yield* Effect.die(secret);
        }
        if (mode === "interrupted") {
          return yield* Effect.interrupt;
        }
        yield* Effect.addFinalizer(() => Effect.die(secret));
      }).pipe(Effect.scoped);
      const exit = yield* withExecution("backup", track("cleanup", work)).pipe(
        Effect.provide(Logger.layer([logger])),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const events = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Tuple([Event])))(
        messages,
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.[0].status).toBe(mode === "interrupted" ? "interrupted" : "failure");
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(messages);
      expect(encoded).not.toContain(secret);
    }),
  );
}

it.effect("debug progress still emits only one canonical event", () =>
  Effect.gen(function* () {
    const messages: unknown[] = [];
    const logger = Logger.make(({ message }: Logger.Options<unknown>): void => {
      messages.push(message);
    });
    const context = yield* Effect.context();
    const span = yield* withExecution(
      "backup",
      Effect.gen(function* () {
        yield* track("process", Effect.void).pipe(Effect.provide(context));
        return yield* Effect.currentSpan;
      }),
    ).pipe(
      Effect.provide(
        Layer.merge(Logger.layer([logger]), Layer.succeed(References.MinimumLogLevel, "Debug")),
      ),
    );
    expect(messages).toHaveLength(1);
    expect(messages).toMatchObject([[{ traceId: span.traceId, spanId: span.spanId }]]);
  }),
);

it.effect("interrupting a running fiber emits completion after releasing resources", () =>
  Effect.gen(function* () {
    const messages: unknown[] = [];
    const ready = yield* Deferred.make<undefined>();
    let released = false;
    const logger = Logger.make(({ message }: Logger.Options<unknown>): void => {
      expect(released).toBe(true);
      messages.push(message);
    });
    const work = Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          released = true;
        }),
      );
      yield* Deferred.succeed(ready, undefined);
      return yield* Effect.never;
    }).pipe(Effect.scoped);
    const fiber = yield* Effect.forkChild(
      withExecution("backup", track("upload", work)).pipe(Effect.provide(Logger.layer([logger]))),
    );
    yield* Deferred.await(ready);
    yield* TestClock.adjust("2 seconds");
    yield* Fiber.interrupt(fiber);
    const events = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Tuple([Event])))(messages);
    expect(events).toHaveLength(1);
    expect(events[0]?.[0]).toMatchObject({
      status: "interrupted",
      durationMs: 2000,
      steps: { upload: { interruptions: 1 } },
    });
  }),
);
