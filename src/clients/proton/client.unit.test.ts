import { expect, it } from "@effect/vitest";
import { DateTime, Effect, HashSet, Layer, Ref, Result, Schema } from "effect";
import { Commands } from "#process/commands.ts";
import { absolutePath, BackupError, JobName, Proton } from "#domain/model.ts";
import { ProtonDrive } from "#clients/proton/client.ts";
import { archiveName } from "#domain/archive.ts";

const destination = Schema.decodeSync(Proton)({
  type: "proton-drive",
  remoteFolder: "/my-files/a",
  outbox: "/outbox",
});
const name = archiveName(
  Schema.decodeSync(JobName)("test-job"),
  DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
);
const listing = (names: Iterable<string>, type = "file") =>
  JSON.stringify(Array.from(names, (value) => ({ name: { ok: true, value }, type })));

it.effect("folder initialization only creates names missing from a successful listing", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<readonly string[][]>([]);
    const commands = Commands.of({
      run: (_binary, args) => Ref.update(calls, (all) => [...all, [...args]]).pipe(Effect.as("[]")),
    });
    yield* Effect.gen(function* () {
      yield* (yield* ProtonDrive).initialize(destination);
    }).pipe(
      Effect.provide(ProtonDrive.layer.pipe(Layer.provide(Layer.succeed(Commands, commands)))),
    );
    expect((yield* Ref.get(calls)).length === 2, "missing folder must be created").toBe(true);
    const failure = new BackupError({ message: "authentication failed" });
    const broken = Commands.of({
      run: (_binary, args) =>
        args.includes("create-folder")
          ? Effect.die("must not create on listing failure")
          : Effect.fail(failure),
    });
    const result = yield* Effect.gen(function* () {
      yield* (yield* ProtonDrive).initialize(destination);
    }).pipe(
      Effect.provide(ProtonDrive.layer.pipe(Layer.provide(Layer.succeed(Commands, broken)))),
      Effect.result,
    );
    expect(
      Result.isFailure(result) && result.failure === failure,
      "authentication error must be preserved",
    ).toBe(true);
  }),
);

it.effect("Proton rejects malformed listings and unconfirmed uploads", () =>
  Effect.gen(function* () {
    const commands = Commands.of({ run: () => Effect.succeed("[]") });
    const result = yield* Effect.gen(function* () {
      yield* (yield* ProtonDrive).upload(destination, {
        name,
        file: absolutePath(`/outbox/${name}`),
        checksum: absolutePath(`/outbox/${name}.sha256`),
        directory: absolutePath("/outbox"),
        legacy: true,
      });
    }).pipe(
      Effect.provide(ProtonDrive.layer.pipe(Layer.provide(Layer.succeed(Commands, commands)))),
      Effect.result,
    );
    expect(Result.isFailure(result), "missing remote pair must fail upload confirmation").toBe(
      true,
    );
    for (const invalid of ["not json", '[{"name":{"ok":false},"type":"file"}]']) {
      const result = yield* Effect.gen(function* () {
        return yield* (yield* ProtonDrive).list(destination);
      }).pipe(
        Effect.provide(
          ProtonDrive.layer.pipe(
            Layer.provide(
              Layer.succeed(Commands, Commands.of({ run: () => Effect.succeed(invalid) })),
            ),
          ),
        ),
        Effect.result,
      );
      expect(Result.isFailure(result), "invalid listing must fail closed").toBe(true);
    }
  }),
);

it.effect("Proton trash can resume a known partial deletion", () =>
  Effect.gen(function* () {
    const remaining = yield* Ref.make(HashSet.make(`${name}.sha256`));
    const commands = Commands.of({
      run: (_binary, args) =>
        Effect.gen(function* () {
          if (args.includes("trash")) {
            expect(
              !args.includes(`${destination.remoteFolder}/${name}`),
              "must only trash files that still exist",
            ).toBe(true);
            yield* Ref.set(remaining, HashSet.empty());
            return "[]";
          }
          return listing(yield* Ref.get(remaining));
        }),
    });
    yield* Effect.gen(function* () {
      yield* (yield* ProtonDrive).trash(destination, HashSet.make(name));
    }).pipe(
      Effect.provide(ProtonDrive.layer.pipe(Layer.provide(Layer.succeed(Commands, commands)))),
    );
    expect(
      HashSet.size(yield* Ref.get(remaining)) === 0,
      "remaining checksum must be removed",
    ).toBe(true);
  }),
);
