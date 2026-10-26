import { expect, it } from "@effect/vitest";
import { Array, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { ProtonDrive } from "#/clients/proton/client.ts";
import { archiveName } from "#/domain/archive.ts";
import { absolutePath, BackupError, backupError, Job, Proton } from "#/domain/model.ts";
import { retainProton } from "#/destinations/proton-retention.ts";
import { Outbox } from "#/outbox/outbox.ts";
import { Commands } from "#/process/commands.ts";
import { Storage } from "#/storage/storage.ts";
import { output } from "#/testing/commands.ts";
import { fixture } from "#/testing/fixtures.ts";
import { outboxInfrastructure } from "#/testing/infrastructure.ts";

it.live(
  "shared-folder backups retry denied uploads, restore, and retain only their own pairs",
  () =>
    Effect.gen(function* () {
      const storage = yield* Storage;
      const { fs, path } = storage;
      const commands = yield* Commands;
      const outbox = yield* Outbox;
      const root = yield* fs.makeTempDirectoryScoped();
      const stage = absolutePath(path.join(root, "test-job"));
      const remote = path.join(root, "shared");
      yield* fs.makeDirectory(stage);
      yield* fs.makeDirectory(remote);
      yield* fs.writeFileString(path.join(remote, "owner-file.txt"), "outside job folder");
      yield* commands.run("sqlite3", [
        path.join(stage, "test.db"),
        "CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('verified');",
      ]);
      const destination = yield* Schema.decodeEffect(Proton)({
        type: "proton-drive",
        remoteFolder: "/shared-with-me/Ankh Backups/test-job",
        outbox: path.join(root, "outbox"),
      });
      const job = yield* Schema.decodeUnknownEffect(Job)({
        ...fixture,
        retention: { daily: 1, weekly: 0, monthly: 0, yearly: 0 },
      });
      let denyUpload = true;
      let denied = 0;
      const local = (file: string): string => {
        expect(
          file.startsWith("/shared-with-me/Ankh Backups/") ||
            file === "/shared-with-me/Ankh Backups",
        ).toBe(true);
        return path.join(remote, file.slice("/shared-with-me/Ankh Backups".length));
      };
      const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
      const simulated = Commands.of({
        run: Effect.fn("Test.sharedDrive")(
          function* (binary, arguments_) {
            expect(binary).toBe("flock");
            expect(arguments_.slice(7, 9)).toEqual(["proton-drive", "filesystem"]);
            const args = Array.map(arguments_.slice(9), (arg) =>
              Redacted.isRedacted(arg) ? Redacted.value(arg) : arg,
            );
            const last = Option.getOrThrow(Array.last(args));
            switch (Option.getOrThrow(Array.head(args))) {
              case "list": {
                if (last === "/shared-with-me") {
                  return output(
                    yield* encode([
                      { name: { ok: true, value: "unrelated.txt" }, type: "file" },
                      { name: { ok: true, value: "Ankh Backups" }, type: "folder" },
                    ]),
                  );
                }
                const entries = yield* Effect.forEach(
                  yield* fs.readDirectory(local(last)),
                  (value) =>
                    fs.stat(path.join(local(last), value)).pipe(
                      Effect.map((stat) => ({
                        name: { ok: true, value },
                        type: stat.type === "Directory" ? "folder" : "file",
                      })),
                    ),
                );
                // Match the pinned CLI: --type is ignored throughout shared-with-me.
                return output(yield* encode(entries));
              }
              case "create-folder": {
                expect(args).toEqual(["create-folder", "/shared-with-me/Ankh Backups", "test-job"]);
                yield* fs.makeDirectory(local(destination.remoteFolder));
                return output("");
              }
              case "upload": {
                expect(last).toBe(destination.remoteFolder);
                expect(args.slice(1, 4)).toEqual([
                  "--file-conflict-strategy",
                  "create-new-revision",
                  "--skip-thumbnails",
                ]);
                if (denyUpload) {
                  denied += 1;
                  return yield* BackupError.make({ message: "injected Editor permission failure" });
                }
                for (const file of args.slice(4, -1)) {
                  yield* fs.copyFile(file, path.join(local(last), path.basename(file)));
                }
                return output("");
              }
              case "trash": {
                expect(args[1]).toBe("--json");
                for (const file of args.slice(2)) {
                  expect(file.startsWith(`${destination.remoteFolder}/test-job-2000`)).toBe(true);
                  yield* fs.remove(local(file));
                }
                return output("[]");
              }
              default:
                return yield* Effect.die("unexpected Proton command");
            }
          },
          Effect.mapError(backupError("Simulated shared Drive")),
        ),
      });
      const proton = ProtonDrive.layer.pipe(
        Layer.provide(
          Layer.merge(Layer.succeed(Commands, simulated), Layer.succeed(Storage, storage)),
        ),
      );
      yield* outbox.enqueue(job, destination, stage);
      yield* fs.remove(stage, { recursive: true });
      yield* Effect.gen(function* () {
        const drive = yield* ProtonDrive;
        yield* drive.initialize(destination);
        yield* fs.makeDirectory(path.join(local(destination.remoteFolder), "nested"));
        const drain = outbox.drain(job, destination, (archive) =>
          drive.upload(destination, archive),
        );
        const failure = yield* drain.pipe(Effect.flip);
        expect(failure.message).toContain("outbox deliveries failed");
        expect(denied).toBe(1);
        expect(yield* fs.readDirectory(destination.outbox)).toHaveLength(1);
        denyUpload = false;
        yield* drain;
        expect(yield* fs.readDirectory(destination.outbox)).toHaveLength(0);

        const uploaded = yield* drive.list(destination);
        expect(Array.fromIterable(uploaded)).toHaveLength(2);
        const archive = Option.getOrThrow(
          Array.findFirst(Array.fromIterable(uploaded), (name) => name.endsWith(".tar.zst")),
        );
        const directory = local(destination.remoteFolder);
        yield* commands.run("sha256sum", ["--check", `${archive}.sha256`], { cwd: directory });
        const restore = path.join(root, "restore");
        yield* fs.makeDirectory(restore);
        yield* commands.run("tar", [
          "--use-compress-program=zstd",
          "--extract",
          "--file",
          path.join(directory, archive),
          "--directory",
          restore,
        ]);
        const restored = yield* commands.run("sqlite3", [
          path.join(restore, "test-job/test.db"),
          "SELECT value FROM records;",
        ]);
        expect(Redacted.value(restored.stdout).trim()).toBe("verified");

        const old = archiveName(job.name, DateTime.makeUnsafe("2000-01-01T00:00:00Z"));
        for (const file of [old, `${old}.sha256`, "unrelated.txt"]) {
          yield* fs.writeFileString(path.join(directory, file), "preserve unrelated data");
        }
        yield* retainProton(job, destination);
        const remaining = yield* fs.readDirectory(directory);
        expect(remaining).toHaveLength(4);
        expect(remaining).toEqual(
          expect.arrayContaining([archive, `${archive}.sha256`, "unrelated.txt", "nested"]),
        );
        expect(yield* fs.readFileString(path.join(remote, "owner-file.txt"))).toBe(
          "outside job folder",
        );
      }).pipe(Effect.provide(proton));
    }).pipe(Effect.provide(outboxInfrastructure)),
);
