import { expect, it } from "@effect/vitest";
import { Array, DateTime, Effect, HashSet, Layer, Ref, Result, Schema } from "effect";
import { BackupError, Job, Proton } from "#/domain/model.ts";
import { ProtonDrive } from "#/clients/proton/client.ts";
import { retainProton } from "#/destinations/proton-retention.ts";
import { archiveName } from "#/domain/archive.ts";
import { Storage } from "#/storage/storage.ts";
import { infrastructure } from "#/testing/infrastructure.ts";
import { fixture } from "#/testing/fixtures.ts";
import { Commands } from "#/process/commands.ts";
import { output } from "#/testing/commands.ts";

it.live("retention retries only journaled partial deletions and rejects unrelated orphans", () =>
  Effect.gen(function* () {
    const storage = yield* Storage;
    const { fs, path } = storage;
    const root = yield* fs.makeTempDirectoryScoped();
    const job = yield* Schema.decodeUnknownEffect(Job)({
      ...fixture,
      retention: { daily: 1, weekly: 0, monthly: 0, yearly: 0 },
    });
    const destination = yield* Schema.decodeEffect(Proton)({
      type: "proton-drive",
      outbox: path.join(root, "outbox"),
      remoteFolder: "/my-files/a",
    });
    const old = archiveName(job.name, DateTime.makeUnsafe("2025-01-01T00:00:00Z"));
    const latest = archiveName(job.name, DateTime.makeUnsafe("2026-01-01T00:00:00Z"));
    const names = yield* Ref.make(HashSet.make(old, `${old}.sha256`, latest, `${latest}.sha256`));
    const fail = yield* Ref.make(true);
    const commands = Commands.of({
      run: (_binary, args) =>
        Effect.gen(function* () {
          if (args.includes("list")) {
            return output(
              yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
                Array.map(Array.fromIterable(yield* Ref.get(names)), (value) => ({
                  name: { ok: true, value },
                  type: "file",
                })),
              ).pipe(Effect.orDie),
            );
          }
          expect(args).toContain("trash");
          expect(args).not.toContain(`${destination.remoteFolder}/${latest}`);
          expect(args).not.toContain(`${destination.remoteFolder}/${latest}.sha256`);
          expect(args).toContain(`${destination.remoteFolder}/${old}.sha256`);
          yield* Ref.update(names, (set) => HashSet.remove(set, old));
          if (yield* Ref.getAndSet(fail, false)) {
            return yield* BackupError.make({ message: "interrupted remote deletion" });
          }
          yield* Ref.update(names, (set) => HashSet.remove(set, `${old}.sha256`));
          return output("[]");
        }),
    });
    const proton = ProtonDrive.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(Commands, commands), Layer.succeed(Storage, storage)),
      ),
    );
    const run = retainProton(job, destination).pipe(Effect.provide(proton));
    expect(Result.isFailure(yield* run.pipe(Effect.result)), "partial deletion must fail").toBe(
      true,
    );
    expect(
      yield* fs.exists(path.join(destination.outbox, `.retention-${job.name}.json`)),
      "failure must retain deletion intent",
    ).toBe(true);
    yield* run;
    expect(
      yield* fs.readDirectory(destination.outbox),
      "confirmed deletion must retire intent",
    ).toHaveLength(0);
    yield* Ref.update(names, (set) => HashSet.add(set, `${old}.sha256`));
    expect(
      Result.isFailure(yield* run.pipe(Effect.result)),
      "unjournaled orphan must require manual investigation",
    ).toBe(true);
    expect(
      HashSet.has(yield* Ref.get(names), `${old}.sha256`),
      "arbitrary orphan must not be deleted",
    ).toBe(true);
  }).pipe(Effect.provide(infrastructure)),
);
