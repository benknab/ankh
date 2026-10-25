import { Context, Effect, Layer, Redacted, Schema } from "effect";
import type { Archive } from "#domain/archive.ts";
import { type AbsolutePath, backupError, type BackupError } from "#domain/model.ts";
import { Commands } from "#process/commands.ts";
import { Storage } from "#storage/storage.ts";

const verify = Effect.fn("ArchiveClient.verify")(function* (archive: Archive) {
  const { fs } = yield* Storage;
  const commands = yield* Commands;
  const checksum = yield* fs.readFileString(archive.checksum);
  yield* Schema.decodeEffect(
    Schema.String.check(
      Schema.isPattern(
        new RegExp(`^[a-f0-9]{64}  ${archive.name.replaceAll(/[.]/gu, "\\.")}\n?$`, "u"),
      ),
    ),
  )(checksum);
  yield* commands.run("sha256sum", ["--check", archive.checksum], { cwd: archive.directory });
  yield* commands.run("zstd", ["--quiet", "--test", archive.file]);
});

const create = Effect.fn("ArchiveClient.create")(function* (stage: AbsolutePath, archive: Archive) {
  const { fs, path } = yield* Storage;
  const commands = yield* Commands;
  // GNU tar streams to zstd without an uncompressed copy on disk.
  yield* commands.run("tar", [
    "--use-compress-program=zstd",
    "--create",
    "--file",
    archive.file,
    "--directory",
    path.dirname(stage),
    path.basename(stage),
  ]);
  yield* fs.chmod(archive.file, 0o600);
  const checksum = yield* commands.run("sha256sum", [archive.name], { cwd: archive.directory });
  yield* fs.writeFileString(archive.checksum, Redacted.value(checksum.stdout), { mode: 0o600 });
  yield* verify(archive);
});

export class ArchiveClient extends Context.Service<
  ArchiveClient,
  {
    readonly create: (stage: AbsolutePath, archive: Archive) => Effect.Effect<void, BackupError>;
    readonly verify: (archive: Archive) => Effect.Effect<void, BackupError>;
  }
>()("ankh/clients/archive/ArchiveClient") {
  public static readonly layer = Layer.effect(
    ArchiveClient,
    Effect.gen(function* () {
      const context = (yield* Effect.context<Storage | Commands>()).pipe(
        Context.pick(Storage, Commands),
      );
      return ArchiveClient.of({
        create: (stage, archive) =>
          create(stage, archive).pipe(
            Effect.provide(context),
            Effect.mapError(backupError("Archive creation")),
          ),
        verify: (archive) =>
          verify(archive).pipe(
            Effect.provide(context),
            Effect.mapError(backupError("Archive verification")),
          ),
      });
    }),
  );
}
