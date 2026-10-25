import { Array, Clock, Context, Effect, type Exit, Option, Random, Ref } from "effect";
import type { Job } from "#domain/model.ts";
import {
  type Completion,
  type Details,
  failure,
  type Operation,
  type Step,
  status,
} from "#telemetry/event.ts";

export class Execution extends Context.Service<
  Execution,
  {
    readonly runId: string;
    readonly operation: Operation;
    readonly started: number;
    readonly details: Ref.Ref<Details>;
  }
>()("backup-runner/telemetry/execution") {}

const runId = Effect.gen(function* () {
  const parts = yield* Effect.forEach([0, 1, 2, 3], () => Random.nextIntBetween(0, 0xffff_ffff));
  return Array.join(
    Array.map(parts, (part) => part.toString(16).padStart(8, "0")),
    "",
  );
});

const complete = Effect.fn("Execution.complete")(function* <A, E>(
  run: Execution["Service"],
  exit: Exit.Exit<A, E>,
) {
  const event: Completion = {
    event: "execution.completed",
    runId: run.runId,
    operation: run.operation,
    status: status(exit),
    durationMs: (yield* Clock.currentTimeMillis) - run.started,
    ...(yield* Ref.get(run.details)),
    ...failure(exit),
  };
  yield* Effect.logInfo(event);
});

export const withExecution = <A, E, R>(
  operation: Operation,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Execution>> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const run = Execution.of({
        runId: yield* runId,
        operation,
        started: yield* Clock.currentTimeMillis,
        details: yield* Ref.make<Details>({ steps: {} }),
      });
      return yield* restore(effect).pipe(
        Effect.provideService(Execution, run),
        Effect.onExit((exit) => complete(run, exit)),
        Effect.annotateLogs({ runId: run.runId, operation }),
        Effect.withLogSpan("execution"),
        Effect.withSpan("execution", { attributes: { runId: run.runId, operation } }),
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
  });
});

export const track = <A, E, R>(
  step: Step,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    yield* Effect.logDebug({ event: "step.started", step });
    return yield* effect.pipe(Effect.onExit((exit) => recordStep(step, started, exit)));
  });
