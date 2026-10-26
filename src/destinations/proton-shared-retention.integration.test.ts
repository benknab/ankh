import { expect, it } from "@effect/vitest";
import { Array, DateTime, Effect, HashSet, Layer, Schema } from "effect";
import { ProtonDrive } from "#/clients/proton/client.ts";
import { retainProton } from "#/destinations/proton-retention.ts";
import { archiveName } from "#/domain/archive.ts";
import {
  ArchiveName,
  BackupError,
  backupError,
  Job,
  Proton,
  ProtonFolderIdentity,
  RemoteFolder,
} from "#/domain/model.ts";
import { Commands } from "#/process/commands.ts";
import { Storage } from "#/storage/storage.ts";
import { output } from "#/testing/commands.ts";
import { fixture } from "#/testing/fixtures.ts";
import { infrastructure } from "#/testing/infrastructure.ts";

it.live(
  "shared retention pins one folder and refuses to replay its journal into a replacement",
  () =>
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
        remoteFolder: "/shared-with-me/Backups",
        outbox: path.join(root, "outbox"),
      });
      const original = `${"v".repeat(22)}~${"a".repeat(22)}`;
      const replacement = `${"v".repeat(22)}~${"b".repeat(22)}`;
      const archiveUid = `${"v".repeat(22)}~${"o".repeat(22)}`;
      const checksumUid = `${"v".repeat(22)}~${"c".repeat(22)}`;
      const latestUid = `${"v".repeat(22)}~${"l".repeat(22)}`;
      const latestChecksumUid = `${"v".repeat(22)}~${"s".repeat(22)}`;
      const target = `${destination.remoteFolder}/${original}`;
      const old = archiveName(job.name, DateTime.makeUnsafe("2000-01-01T00:00:00Z"));
      const latest = archiveName(job.name, DateTime.makeUnsafe("2026-01-01T00:00:00Z"));
      let remaining = HashSet.make(old, `${old}.sha256`, latest, `${latest}.sha256`);
      let advertised = original;
      let interrupted = false;
      let deletions = 0;
      let resolutions = 0;
      const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
      const commands = Commands.of({
        run: Effect.fn("Test.sharedRetention")(
          function* (_binary, args) {
            if (args.at(-1) === "/shared-with-me") {
              resolutions += 1;
              return output(
                yield* encode([
                  { uid: advertised, name: { ok: true, value: "Backups" }, type: "folder" },
                ]),
              );
            }
            if (args.includes("list")) {
              expect(args.at(-1), "no listing may switch to the replacement folder").toBe(target);
              // Simulate another folder acquiring the configured name after resolution.
              advertised = replacement;
              return output(
                yield* encode(
                  Array.map(Array.fromIterable(remaining), (value) => ({
                    uid:
                      value === old
                        ? archiveUid
                        : value === `${old}.sha256`
                          ? checksumUid
                          : value === latest
                            ? latestUid
                            : latestChecksumUid,
                    name: { ok: true, value },
                    type: "file",
                  })),
                ),
              );
            }
            expect(args).toContain("trash");
            const files = args.slice(args.indexOf("--json") + 1);
            expect(files).toContain(`${target}/${checksumUid}`);
            expect(files).not.toContain(`${target}/${latest}`);
            expect(files).not.toContain(`${target}/${latest}.sha256`);
            expect(files).not.toContain(`${target}/${latestUid}`);
            expect(files).not.toContain(`${target}/${latestChecksumUid}`);
            deletions += 1;
            if (!interrupted) {
              interrupted = true;
              remaining = HashSet.remove(remaining, old);
              return yield* BackupError.make({ message: "injected partial deletion" });
            }
            expect(files).toEqual([`${target}/${checksumUid}`]);
            remaining = HashSet.remove(remaining, `${old}.sha256`);
            return output("[]");
          },
          Effect.mapError(backupError("Shared retention simulation")),
        ),
      });
      const layer = ProtonDrive.layer.pipe(
        Layer.provide(
          Layer.merge(Layer.succeed(Commands, commands), Layer.succeed(Storage, storage)),
        ),
      );
      const run = retainProton(job, destination).pipe(Effect.provide(layer));
      const failure = yield* run.pipe(Effect.flip);
      expect(failure.message).toBe("injected partial deletion");
      expect(interrupted).toBe(true);
      expect(resolutions, "a retention attempt resolves the name only once").toBe(1);
      const journal = path.join(destination.outbox, `.retention-${job.name}.json`);
      const saved = yield* fs.readFileString(journal);
      const pending = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            remoteFolder: RemoteFolder,
            identity: ProtonFolderIdentity,
            names: Schema.Array(ArchiveName),
          }),
        ),
      )(saved);
      expect(pending.identity).toBe(target);
      const changed = yield* run.pipe(Effect.flip);
      expect(changed.message).toContain("folder identity is missing or changed");
      expect(deletions, "identity mismatch must not delete anything").toBe(1);
      expect(yield* fs.readFileString(journal)).toBe(saved);

      advertised = original;
      yield* fs.writeFileString(
        journal,
        yield* encode({ remoteFolder: pending.remoteFolder, names: pending.names }),
      );
      const legacy = yield* run.pipe(Effect.flip);
      expect(legacy.message).toContain("folder identity is missing or changed");
      expect(deletions, "legacy shared journals must not guess an identity").toBe(1);

      yield* fs.writeFileString(journal, saved);
      yield* run;
      expect(deletions).toBe(2);
      expect(resolutions).toBe(4);
      expect(Array.fromIterable(remaining)).toEqual(
        expect.arrayContaining([latest, `${latest}.sha256`]),
      );
      expect(HashSet.size(remaining)).toBe(2);
      expect(yield* fs.exists(journal)).toBe(false);
    }).pipe(Effect.provide(infrastructure)),
);
