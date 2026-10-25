import { expect, it } from "@effect/vitest";
import { Array, Effect, HashSet, Layer, Ref, Result, Schema } from "effect";
import { Destinations } from "#/destinations/destinations.ts";
import { absolutePath, BackupError, Job } from "#/domain/model.ts";
import { execute } from "#/app/runner.ts";
import { Sources } from "#/sources/sources.ts";

import { fixture } from "#/testing/fixtures.ts";

for (const reverse of [false, true]) {
  for (const failed of ["restic", "proton-drive"] as const) {
    it.effect(
      `runner stages once and attempts both destinations when ${failed} fails (reversed: ${reverse})`,
      () =>
        Effect.gen(function* () {
          const job = yield* Schema.decodeUnknownEffect(Job)({
            ...fixture,
            destinations: reverse ? Array.reverse(fixture.destinations) : fixture.destinations,
          });
          const stages = yield* Ref.make(0);
          const attempts = yield* Ref.make(HashSet.empty<string>());
          const source = Layer.succeed(
            Sources,
            Sources.of({
              stage: () =>
                Ref.update(stages, (n) => n + 1).pipe(Effect.as(absolutePath("/staging/test-job"))),
            }),
          );
          const destinations = Layer.succeed(
            Destinations,
            Destinations.of({
              run: (_job, destination, request) =>
                Effect.gen(function* () {
                  expect(request).toStrictEqual({ action: "backup", stage: "/staging/test-job" });
                  yield* Ref.update(attempts, (set) => HashSet.add(set, destination.type));
                  if (destination.type === failed) {
                    return yield* BackupError.make({ message: "offline" });
                  }
                }),
            }),
          );
          const result = yield* execute(job, "backup").pipe(
            Effect.provide(Layer.merge(source, destinations)),
            Effect.result,
          );
          expect(Result.isFailure(result), "partial failure must fail the job").toBe(true);
          expect(yield* Ref.get(stages), "source must stage once").toBe(1);
          expect(HashSet.size(yield* Ref.get(attempts)), "both destinations must run").toBe(2);
        }),
    );
  }
}
