import { expect, it } from "@effect/vitest";
import { DateTime, Effect, HashSet, Ref, Result, Schema } from "effect";
import { BackupError, Job, Proton } from "#/domain/model.ts";
import { ProtonDrive } from "#/clients/proton/client.ts";
import { retainProton } from "#/destinations/proton-retention.ts";
import { archiveName } from "#/domain/archive.ts";
import { Storage } from "#/storage/storage.ts";
import { infrastructure } from "#/testing/infrastructure.ts";
import { fixture } from "#/testing/fixtures.ts";

it.live("retention retries only journaled partial deletions and rejects unrelated orphans", () =>
  Effect.gen(function* () {
    const { fs, path } = yield* Storage;
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
    const proton = ProtonDrive.of({
      verify: Effect.void,
      initialize: () => Effect.void,
      upload: () => Effect.void,
      list: () => Ref.get(names),
      trash: (_destination, expired) =>
        Effect.gen(function* () {
          expect(
            HashSet.size(expired) === 1 && HashSet.has(expired, old),
            "only the expired archive may be deleted",
          ).toBe(true);
          yield* Ref.update(names, (set) => HashSet.remove(set, old));
          if (yield* Ref.getAndSet(fail, false)) {
            return yield* BackupError.make({ message: "interrupted remote deletion" });
          }
          yield* Ref.update(names, (set) => HashSet.remove(set, `${old}.sha256`));
        }),
    });
    const run = retainProton(job, destination).pipe(Effect.provideService(ProtonDrive, proton));
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
