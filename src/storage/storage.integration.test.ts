import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref, Schema } from "effect";
import { Job } from "#domain/model.ts";
import { Storage, withLock } from "#storage/storage.ts";
import { infrastructure } from "#testing/infrastructure.ts";
import { fixture } from "#testing/fixtures.ts";

it.live("concurrent scheduled jobs wait for the shared drive lock", () =>
  Effect.gen(function* () {
    const { fs, path } = yield* Storage;
    const root = yield* fs.makeTempDirectoryScoped();
    const job = yield* Schema.decodeUnknownEffect(Job)({
      ...fixture,
      backupDrive: {
        ...fixture.backupDrive,
        sentinelFile: path.join(root, ".sentinel"),
      },
    });
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const acquired = yield* Ref.make(false);
    const first = yield* Effect.forkChild(
      Effect.gen(function* () {
        yield* withLock(job);
        yield* Deferred.succeed(held, undefined);
        yield* Deferred.await(release);
      }).pipe(Effect.scoped),
    );
    yield* Deferred.await(held);
    const second = yield* Effect.forkChild(
      Effect.gen(function* () {
        yield* withLock(job);
        yield* Ref.set(acquired, true);
      }).pipe(Effect.scoped),
    );
    yield* Effect.sleep("100 millis");
    expect(!(yield* Ref.get(acquired)), "another job must not enter while lock is held").toBe(true);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect(yield* Ref.get(acquired), "waiting job must acquire released lock").toBe(true);
    expect(
      !(yield* fs.exists(path.join(root, ".runner-lock"))),
      "both scopes must release the lock",
    ).toBe(true);
  }).pipe(Effect.provide(infrastructure)),
);

it.live("interrupting a lock waiter leaves the holder's lock intact", () =>
  Effect.gen(function* () {
    const { fs, path } = yield* Storage;
    const root = yield* fs.makeTempDirectoryScoped();
    const job = yield* Schema.decodeUnknownEffect(Job)({
      ...fixture,
      backupDrive: { ...fixture.backupDrive, sentinelFile: path.join(root, ".sentinel") },
    });
    yield* withLock(job);
    const waiter = yield* Effect.forkChild(withLock(job).pipe(Effect.scoped));
    yield* Effect.sleep("100 millis");
    yield* Fiber.interrupt(waiter).pipe(Effect.timeout("1 second"));
    expect(
      yield* fs.exists(path.join(root, ".runner-lock")),
      "interrupted contender must not remove the holder's lock",
    ).toBe(true);
  }).pipe(Effect.provide(infrastructure)),
);
