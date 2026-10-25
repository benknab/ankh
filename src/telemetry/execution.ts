import {
  Clock,
  Context,
  Effect,
  type Exit,
  Logger,
  MutableRef,
  Option,
  Ref,
  References,
} from "effect";
import type { Job } from "#/domain/model.ts";
import {
  type Completion,
  type Details,
  failure,
  type Operation,
  type Step,
  status,
} from "#/telemetry/event.ts";
import { collector, make, type Messages, ProgressLog } from "#/telemetry/messages.ts";
import { fields } from "#/telemetry/values.ts";

export class Execution extends Context.Service<
  Execution,
  {
    readonly operation: Operation;
    readonly started: number;
    readonly details: Ref.Ref<Details>;
    readonly logs: MutableRef.MutableRef<Messages>;
    readonly sinks: ReadonlySet<Logger.Logger<unknown, unknown>>;
  }
>()("ankh/telemetry/execution") {}

const complete = Effect.fnUntraced(function* <A, E>(
  run: Execution["Service"],
  exit: Exit.Exit<A, E>,
) {
  const span = yield* Effect.currentSpan.pipe(Effect.orDie);
  const event: Completion = {
    event: "execution.completed",
    operation: run.operation,
    status: status(exit),
    durationMs: (yield* Clock.currentTimeMillis) - run.started,
    traceId: span.traceId,
    spanId: span.spanId,
    ...(yield* Ref.get(run.details)),
    ...MutableRef.get(run.logs),
    ...failure(exit),
  };
  const annotations = fields(yield* References.CurrentLogAnnotations);
  yield* Effect.logInfo(event).pipe(
    Effect.provideService(Logger.CurrentLoggers, run.sinks),
    Effect.provideService(References.CurrentLogAnnotations, annotations),
  );
});

export const withExecution = <A, E, R>(
  operation: Operation,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Execution>> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const parent = yield* Effect.serviceOption(Execution);
      const run = Execution.of({
        operation,
        started: yield* Clock.currentTimeMillis,
        details: yield* Ref.make<Details>({ steps: {} }),
        logs: make(),
        sinks: Option.isSome(parent) ? parent.value.sinks : yield* Logger.CurrentLoggers,
      });
      return yield* restore(effect).pipe(
        Effect.provideService(Execution, run),
        Effect.provideService(Logger.CurrentLoggers, new Set([collector(run.logs)])),
        Effect.onExit((exit) => complete(run, exit)),
        Effect.annotateLogs({ operation }),
        Effect.withLogSpan("execution"),
        Effect.withSpan("execution", { attributes: { operation } }),
      );
    }),
  );

export const describeJob = Effect.fn("Execution.describeJob")(function* (job: Job) {
  const run = yield* Effect.serviceOption(Execution);
  if (Option.isSome(run)) {
    yield* Ref.update(run.value.details, (details) => ({
      ...details,
      job: job.name,
      source: job.source.type,
    }));
  }
});

const recordStep = Effect.fn("Execution.recordStep")(function* <A, E>(
  step: Step,
  started: number,
  exit: Exit.Exit<A, E>,
) {
  const run = yield* Effect.serviceOption(Execution);
  const elapsed = (yield* Clock.currentTimeMillis) - started;
  if (Option.isSome(run)) {
    yield* Ref.update(run.value.details, (details) => {
      const prior = details.steps[step] ?? {
        attempts: 0,
        failures: 0,
        interruptions: 0,
        durationMs: 0,
      };
      return {
        ...details,
        steps: {
          ...details.steps,
          [step]: {
            attempts: prior.attempts + 1,
            failures: prior.failures + Number(status(exit) === "failure"),
            interruptions: prior.interruptions + Number(status(exit) === "interrupted"),
            durationMs: prior.durationMs + elapsed,
          },
        },
      };
    });
  }
  yield* Effect.logDebug({
    event: "step.completed",
    step,
    status: status(exit),
    durationMs: elapsed,
    ...failure(exit),
  }).pipe(Effect.provideService(ProgressLog, true));
});

export const track = <A, E, R>(
  step: Step,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    yield* Effect.logDebug({ event: "step.started", step }).pipe(
      Effect.provideService(ProgressLog, true),
    );
    return yield* effect.pipe(Effect.onExit((exit) => recordStep(step, started, exit)));
  });
